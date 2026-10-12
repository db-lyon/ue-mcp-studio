/**
 * Asset names in the chat, resolved to object paths and opened in the editor:
 *
 *   POST /assets/resolve   { tokens, sessionId? } -> { results: { token: AssetResolution } }
 *   POST /assets/open      { path } -> { path, alreadyOpen }
 *
 * Resolution reads the package files on disk through project.list_content_assets,
 * which the daemon answers without the editor. A session's own paths (what it
 * touched and what its calls named) come first. Lookups are cached per project
 * and run a few at a time; a token that cannot be answered now comes back as
 * retry and stays plain text until the UI asks again.
 */
import type { ActionResult, DaemonExtensionApi } from "ue-mcp/daemon";
import {
  MAX_RESOLVE_TOKENS,
  classifyAssetToken,
  objectPathOf,
  type AssetOpenResponse,
  type AssetResolution,
  type AssetToken,
  type BusyState,
  type TranscriptEntry,
} from "@ue-mcp-studio/shared";
import { namedTargets } from "./tools.js";

type Host = Pick<DaemonExtensionApi, "callAction">;

/** Most list_content_assets calls in flight at once, across every request. */
export const MAX_LOOKUPS = 2;
/** Most lookups one resolve request starts; the rest come back as retry. */
export const LOOKUPS_PER_REQUEST = 12;
/** A found asset is trusted this long; a missing one is asked again sooner. */
export const FOUND_TTL_MS = 10 * 60_000;
export const MISSING_TTL_MS = 60_000;
/** An editor call older than this means the editor is busy: a click is refused, not queued. */
export const BUSY_AFTER_MS = 2000;

interface Entry {
  key: string;
  paths: string[];
  at: number;
}

/** The asset paths a session already knows: what it touched and what its editor calls named. */
export function knownPaths(session: { touched: Array<{ kind: string; path: string }>; transcript: TranscriptEntry[] } | null | undefined): string[] {
  if (!session) return [];
  const out = new Set<string>();
  for (const t of session.touched) if (t.kind === "asset") out.add(t.path);
  for (const e of session.transcript) {
    if (e.kind !== "tool" || e.call.name !== "ue_mcp") continue;
    const args = (e.call.input as { args?: unknown } | null)?.args;
    if (!args || typeof args !== "object" || Array.isArray(args)) continue;
    for (const t of namedTargets(args as Record<string, unknown>)) if (t.kind === "asset") out.add(t.path);
  }
  return [...out];
}

const packageOf = (p: string): string => p.replace(/[.:].*$/, "");
const leafOf = (p: string): string => packageOf(p).slice(packageOf(p).lastIndexOf("/") + 1);

function parse(r: ActionResult): Record<string, unknown> | null {
  try {
    const v = JSON.parse(r.content.map((c) => c.text ?? "").join("\n"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

class Gate {
  private running = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async run<T>(f: () => Promise<T>): Promise<T> {
    if (this.running >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.running++;
    try {
      return await f();
    } finally {
      this.running--;
      this.queue.shift()?.();
    }
  }
}

export class AssetResolver {
  private readonly cache = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<string[] | null>>();
  private readonly gate = new Gate(MAX_LOOKUPS);

  constructor(private readonly host: Host, private readonly now: () => number = Date.now) {}

  /** Drop the cached misses: something may have created them. */
  forgetMissing(): void {
    for (const [k, e] of this.cache) if (e.paths.length === 0) this.cache.delete(k);
  }

  /** Drop what is cached for a path that turned out not to open. */
  forgetPath(path: string): void {
    const pkg = packageOf(path).toLowerCase();
    for (const [k, e] of this.cache) if (e.paths.some((p) => packageOf(p).toLowerCase() === pkg)) this.cache.delete(k);
  }

  private cached(key: string): string[] | undefined {
    const e = this.cache.get(key);
    if (!e) return undefined;
    if (this.now() - e.at > (e.paths.length ? FOUND_TTL_MS : MISSING_TTL_MS)) {
      this.cache.delete(key);
      return undefined;
    }
    return e.paths;
  }

  /** One listing, shared by every token that needs it; null when it could not be read now. */
  private lookup(key: string, args: Record<string, unknown>, pick: (assets: Array<{ assetPath: string; name: string }>) => string[]): Promise<string[] | null> {
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.gate
      .run(() => this.host.callAction("project", "list_content_assets", args))
      .then((r) => {
        const json = parse(r);
        // A folder that does not exist on disk holds no such asset; any other error is not an answer.
        if (r.isError) return /does not exist/.test(r.content.map((c) => c.text ?? "").join("")) ? [] : null;
        const assets = Array.isArray(json?.assets) ? (json.assets as Array<{ assetPath: string; name: string }>) : null;
        return assets ? pick(assets) : null;
      })
      .catch(() => null)
      .then((paths) => {
        if (paths) this.cache.set(key, { key, paths, at: this.now() });
        this.inflight.delete(key);
        return paths;
      });
    this.inflight.set(key, p);
    return p;
  }

  private byPath(t: Extract<AssetToken, { kind: "path" }>): Promise<string[] | null> | string[] {
    const dir = t.packagePath.slice(0, t.packagePath.lastIndexOf("/"));
    const key = `dir:${dir.toLowerCase()}`;
    const want = t.packagePath.toLowerCase();
    const pick = (paths: string[]) => (paths.some((p) => p.toLowerCase() === want) ? [t.path.includes(".") ? t.path : objectPathOf(t.packagePath)] : []);
    // A folder's listing answers every path in it, so one call covers a result full of paths.
    const hit = this.cached(key);
    if (hit) return pick(hit);
    return this.lookup(key, { contentPath: dir, recursive: false, maxResults: 5000 }, (a) => a.map((x) => x.assetPath)).then((paths) => (paths ? pick(paths) : null));
  }

  private byName(name: string): Promise<string[] | null> | string[] {
    const key = `name:${name.toLowerCase()}`;
    const hit = this.cached(key);
    if (hit) return hit;
    return this.lookup(key, { contentPath: "/Game", namePattern: name, maxResults: 500 }, (a) =>
      a.filter((x) => x.name.toLowerCase() === name.toLowerCase()).map((x) => objectPathOf(x.assetPath)).sort());
  }

  async resolve(tokens: string[], known: string[] = []): Promise<Record<string, AssetResolution>> {
    const out: Record<string, AssetResolution> = {};
    const work: Array<Promise<void>> = [];
    let started = 0;
    for (const token of [...new Set(tokens)].slice(0, MAX_RESOLVE_TOKENS)) {
      const t = classifyAssetToken(token);
      if (!t) {
        out[token] = { status: "unresolved" };
        continue;
      }
      if (t.kind === "name") {
        const mine = [...new Set(known.filter((p) => leafOf(p).toLowerCase() === t.name.toLowerCase()).map((p) => (p.includes(".") ? p : objectPathOf(p))))];
        if (mine.length) {
          out[token] = { status: "resolved", paths: mine };
          continue;
        }
      }
      const key = t.kind === "name" ? `name:${t.name.toLowerCase()}` : `dir:${t.packagePath.slice(0, t.packagePath.lastIndexOf("/")).toLowerCase()}`;
      const needsCall = this.cached(key) === undefined && !this.inflight.has(key);
      if (needsCall && started >= LOOKUPS_PER_REQUEST) {
        out[token] = { status: "retry" };
        continue;
      }
      if (needsCall) started++;
      const answer = t.kind === "name" ? this.byName(t.name) : this.byPath(t);
      const settle = (paths: string[] | null) => {
        out[token] = paths === null ? { status: "retry" } : paths.length ? { status: "resolved", paths } : { status: "unresolved" };
      };
      if (Array.isArray(answer)) settle(answer);
      else work.push(answer.then(settle));
    }
    await Promise.all(work);
    return out;
  }
}

export type OpenOutcome = { status: 200; body: AssetOpenResponse } | { status: 400 | 404 | 409 | 503 | 504; body: { error: string } };

/** Whether an editor call has been running long enough that a click would wait behind it. */
export function editorBusy(state: BusyState): boolean {
  return state.calls.some((c) => state.now - c.startedAt >= BUSY_AFTER_MS);
}

/** Open one asset in the editor, refusing rather than queueing when the editor is down or busy. */
export async function openAsset(
  o: {
    host: Host;
    connected: () => boolean;
    busy: () => BusyState;
    track: <T>(f: () => Promise<T>) => Promise<T>;
    resolver?: AssetResolver;
  },
  path: unknown,
): Promise<OpenOutcome> {
  if (typeof path !== "string") return { status: 400, body: { error: "body must be { path: string }" } };
  const t = classifyAssetToken(path);
  if (!t || t.kind !== "path") return { status: 400, body: { error: "path must be an asset's object path" } };
  if (!o.connected()) return { status: 503, body: { error: "Editor not running" } };
  if (editorBusy(o.busy())) return { status: 409, body: { error: "Editor busy" } };
  const assetPath = t.path.includes(".") ? t.path.replace(/:.*$/, "") : objectPathOf(t.packagePath);
  let r: ActionResult;
  try {
    r = await o.track(() => o.host.callAction("editor", "open_asset", { assetPath }));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return /timed? ?out/i.test(message) ? { status: 504, body: { error: "Editor busy" } } : { status: 503, body: { error: "Editor not reachable" } };
  }
  const text = r.content.map((c) => c.text ?? "").join("\n");
  const json = parse(r);
  if (r.isError || json?.success === false) {
    if (/Failed to load asset|not found|does not exist/i.test(text)) {
      o.resolver?.forgetPath(assetPath);
      return { status: 404, body: { error: "Asset not found" } };
    }
    if (/timed? ?out|busy/i.test(text)) return { status: 504, body: { error: "Editor busy" } };
    return { status: 409, body: { error: "Could not open the asset" } };
  }
  return { status: 200, body: { path: assetPath, alreadyOpen: json?.alreadyOpen === true } };
}

/**
 * Asset names in the chat, resolved to object paths and opened in the editor:
 *
 *   POST /assets/resolve   { refs: [{ token, at? }], sessionId? } -> { results: AssetResolution[] }
 *   POST /assets/open      { path } -> { path, alreadyOpen }
 *   POST /assets/missed    { name, candidates } -> 204, logs a chooser that was shown
 *
 * A path is checked on disk. A name is traced through the session's own calls
 * (main agent and subagents): the most recent call before the message that
 * names a path ending in it wins. Only a name the session never referenced up
 * to there is looked up in the project, through project.list_content_assets,
 * which the daemon answers without the editor. Lookups are cached per project
 * and run a few at a time; a token that cannot be answered now comes back as
 * retry and stays plain text until the UI asks again.
 */
import type { ActionResult, DaemonExtensionApi } from "ue-mcp/daemon";
import {
  MAX_RESOLVE_TOKENS,
  OBJECT_PATH_IN_TEXT,
  classifyAssetToken,
  objectPathOf,
  type AssetOpenResponse,
  type AssetRef,
  type AssetResolution,
  type AssetToken,
  type BusyState,
  type ToolCallRecord,
  type TranscriptEntry,
} from "@ue-mcp-studio/shared";

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

/** Keys whose path is what a call made: a duplicate's copy outranks its source. */
const MADE_KEYS = new Set(["destinationPath", "destPath", "newPath", "new_path", "targetPath", "outputPath"]);

/**
 * The object paths one call names that end in `name`: what it made when it
 * made one, otherwise every path in its input and result. Several means the
 * call itself does not say which.
 */
export function callRefs(call: ToolCallRecord, name: string): string[] {
  if (call.outcome === "declined") return [];
  const want = name.toLowerCase();
  const ranked = [new Map<string, string>(), new Map<string, string>()];
  const scan = (text: string, rank: number) => {
    for (const m of text.matchAll(new RegExp(OBJECT_PATH_IN_TEXT.source, "g"))) {
      const t = classifyAssetToken(m[0]);
      if (t?.kind !== "path" || t.name.toLowerCase() !== want) continue;
      const key = t.packagePath.toLowerCase();
      if (!ranked[rank].has(key)) ranked[rank].set(key, t.path.includes(".") ? t.path.replace(/:.*$/, "") : objectPathOf(t.packagePath));
    }
  };
  const visit = (v: unknown, rank: number, depth = 0): void => {
    if (depth > 12) return;
    if (typeof v === "string") scan(v, rank);
    else if (Array.isArray(v)) for (const x of v) visit(x, rank, depth + 1);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) visit(x, MADE_KEYS.has(k) ? 0 : rank, depth + 1);
  };
  visit(call.input, 1);
  if (call.result) {
    let json: unknown;
    try {
      json = JSON.parse(call.result);
    } catch {
      json = undefined;
    }
    if (json && typeof json === "object") visit(json, 1);
    else scan(call.result, 1);
  }
  return [...(ranked[0].size ? ranked[0] : ranked[1]).values()];
}

/**
 * found: the paths the most recent call naming it gave (one is exact).
 * open: no call named it yet, and the message's turn is still running.
 * none: the session never referenced it up to that message.
 */
export type Trace = { status: "found"; paths: string[] } | { status: "open" } | { status: "none" };

/**
 * Trace a name through a session's calls, subagents' included: the most
 * recent call before the message at `at`, then the rest of that turn. With no
 * `at`, the whole transcript.
 */
export function traceName(transcript: TranscriptEntry[], name: string, at?: number, running = false): Trace {
  const end = at === undefined ? transcript.length : Math.min(Math.max(at, 0), transcript.length);
  for (let j = end - 1; j >= 0; j--) {
    const e = transcript[j];
    if (e.kind !== "tool") continue;
    const paths = callRefs(e.call, name);
    if (paths.length) return { status: "found", paths };
  }
  if (at === undefined) return { status: "none" };
  let j = end + 1;
  for (; j < transcript.length; j++) {
    const e = transcript[j];
    if (e.kind === "user" && !e.parent) break;
    if (e.kind !== "tool") continue;
    const paths = callRefs(e.call, name);
    if (paths.length) return { status: "found", paths };
  }
  return j >= transcript.length && running ? { status: "open" } : { status: "none" };
}

/** The log line for a chooser the UI showed, or null for a report that is not one. */
export function missLine(body: unknown): string | null {
  const b = (body ?? {}) as { name?: unknown; candidates?: unknown };
  if (typeof b.name !== "string" || classifyAssetToken(b.name)?.kind !== "name") return null;
  if (typeof b.candidates !== "number" || !Number.isInteger(b.candidates) || b.candidates < 2 || b.candidates > 500) return null;
  return `asset chooser shown for ${b.name}, ${b.candidates} candidates, no link or trace`;
}

const packageOf = (p: string): string => p.replace(/[.:].*$/, "");

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

  /**
   * Resolve refs in order: a path on disk; a name by the session's trace, then
   * by the project only when the session never referenced it. Several project
   * matches come back as they are, for the chooser.
   */
  async resolve(refs: AssetRef[], trace: (name: string, at?: number) => Trace = () => ({ status: "none" })): Promise<AssetResolution[]> {
    const out: AssetResolution[] = [];
    const work: Array<Promise<void>> = [];
    let started = 0;
    refs.slice(0, MAX_RESOLVE_TOKENS).forEach((ref, i) => {
      const t = classifyAssetToken(ref.token);
      if (!t) {
        out[i] = { status: "unresolved" };
        return;
      }
      if (t.kind === "name") {
        const tr = trace(t.name, ref.at);
        if (tr.status === "found") {
          out[i] = { status: "resolved", paths: [...tr.paths].sort() };
          return;
        }
        if (tr.status === "open") {
          out[i] = { status: "retry" };
          return;
        }
      }
      const key = t.kind === "name" ? `name:${t.name.toLowerCase()}` : `dir:${t.packagePath.slice(0, t.packagePath.lastIndexOf("/")).toLowerCase()}`;
      const needsCall = this.cached(key) === undefined && !this.inflight.has(key);
      if (needsCall && started >= LOOKUPS_PER_REQUEST) {
        out[i] = { status: "retry" };
        return;
      }
      if (needsCall) started++;
      const answer = t.kind === "name" ? this.byName(t.name) : this.byPath(t);
      const settle = (paths: string[] | null) => {
        out[i] = paths === null ? { status: "retry" } : paths.length ? { status: "resolved", paths } : { status: "unresolved" };
      };
      if (Array.isArray(answer)) settle(answer);
      else work.push(answer.then(settle));
    });
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

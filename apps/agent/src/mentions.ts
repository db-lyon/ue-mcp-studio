/**
 * Name lookups for @-mentions in the composer:
 *
 *   POST /mentions/search   { query, kinds? } -> MentionSearchResponse
 *
 * Assets come from the editor's asset registry (asset.search over the
 * project's content roots), or from the package files on disk while no editor
 * answers (project.list_content_assets). Actors come from the open level
 * (level.get_outliner) and need an editor. Files are the project's Source and
 * Config folders (project.list_files). Every lookup is a ue-mcp action.
 *
 * The UI asks on every pause in typing and drops answers it no longer wants.
 * Here, one editor lookup runs at a time and only the newest waits behind it,
 * so a burst of keystrokes never queues work on the game thread; answers are
 * kept a few seconds, and an editor that is busy with the agent's own calls
 * is not asked at all.
 */
import * as path from "node:path";
import type { ActionResult, DaemonExtensionApi } from "ue-mcp/daemon";
import {
  MAX_MENTION_QUERY,
  MENTION_KINDS,
  MENTION_ROWS,
  fileType,
  rankMentions,
  type MentionKind,
  type MentionMatch,
  type MentionSearchResponse,
  type MentionSource,
} from "@ue-mcp-studio/shared";

type Host = Pick<DaemonExtensionApi, "callAction" | "projectDir">;

/** How long an answer is reused for the same query. */
export const MENTION_TTL_MS = 5000;
/** An editor lookup slower than this is given up on: assets fall back to disk. */
export const EDITOR_LOOKUP_MS = 2500;
/** Rows asked of each source, ranked here afterwards. */
export const SOURCE_ROWS = 100;
/** The folders searched for files, relative to the project folder. */
export const FILE_FOLDERS = ["Source", "Config"];

export interface MentionSearchOptions {
  host: Host;
  /** An editor is attached. */
  connected: () => boolean;
  /** The editor is held by a call long enough that a lookup would wait behind it. */
  busy: () => boolean;
  now?: () => number;
  editorTimeoutMs?: number;
}

/** A lookup that a newer one replaced before it could start. */
export const SUPERSEDED = Symbol("superseded");

/** One call at a time; of the calls waiting, only the newest runs. */
export class LatestLane {
  private running = false;
  private waiting: { run: () => void; drop: () => void } | null = null;

  run<T>(f: () => Promise<T>): Promise<T | typeof SUPERSEDED> {
    return new Promise((resolve, reject) => {
      const start = () => {
        this.running = true;
        f().then(resolve, reject).finally(() => {
          this.running = false;
          const next = this.waiting;
          this.waiting = null;
          next?.run();
        });
      };
      if (!this.running) return start();
      this.waiting?.drop();
      this.waiting = { run: start, drop: () => resolve(SUPERSEDED) };
    });
  }
}

function parse(r: ActionResult): Record<string, unknown> | null {
  try {
    const v = JSON.parse(r.content.map((c) => c.text ?? "").join("\n"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const rows = (json: Record<string, unknown> | null, key: string): Array<Record<string, unknown>> =>
  Array.isArray(json?.[key]) ? (json![key] as unknown[]).filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : [];

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** A package path's object path: /Game/A/B is /Game/A/B.B. */
const objectPath = (pkg: string, name: string): string => (pkg.includes(".") ? pkg : `${pkg}.${name || pkg.slice(pkg.lastIndexOf("/") + 1)}`);

/** asset.search rows: { path (package), name, className }. */
export function editorAssets(json: Record<string, unknown> | null): MentionMatch[] {
  return rows(json, "results").flatMap((r) => {
    const name = str(r.name);
    const pkg = str(r.path);
    if (!name || !pkg) return [];
    const target = objectPath(pkg, name);
    return [{ kind: "asset" as const, name, type: str(r.className) || str(r.class) || "Asset", path: target, target }];
  });
}

/** project.list_content_assets rows: { assetPath (package), name, kind }. */
export function diskAssets(json: Record<string, unknown> | null): MentionMatch[] {
  return rows(json, "assets").flatMap((r) => {
    const name = str(r.name);
    const pkg = str(r.assetPath);
    if (!name || !pkg) return [];
    const target = objectPath(pkg, name);
    return [{ kind: "asset" as const, name, type: r.kind === "map" ? "Level" : "Asset", path: target, target }];
  });
}

/** level.get_outliner rows: { label, name, class, path }. */
export function outlinerActors(json: Record<string, unknown> | null): MentionMatch[] {
  return rows(json, "actors").flatMap((r) => {
    const objPath = str(r.path);
    const name = str(r.label) || str(r.name);
    if (!objPath || !name) return [];
    return [{ kind: "actor" as const, name, type: str(r.class) || "Actor", path: objPath, target: `actor:${objPath}` }];
  });
}

/** project.list_files rows: { path (absolute), name }, named from the project folder. */
export function projectFiles(json: Record<string, unknown> | null, projectDir: string): MentionMatch[] {
  return rows(json, "files").flatMap((r) => {
    const abs = str(r.path);
    const name = str(r.name) || path.basename(abs);
    if (!abs) return [];
    const rel = path.relative(projectDir, abs).replace(/\\/g, "/");
    if (!rel || rel.startsWith("..")) return [];
    return [{ kind: "file" as const, name, type: fileType(name), path: rel, target: `file:${rel}` }];
  });
}

interface Found {
  matches: MentionMatch[];
  source: MentionSource;
}

export class MentionSearch {
  private readonly lane = new LatestLane();
  private readonly cache = new Map<string, { at: number; answer: MentionSearchResponse }>();
  private readonly now: () => number;

  constructor(private readonly o: MentionSearchOptions) {
    this.now = o.now ?? Date.now;
  }

  /** Forget cached answers: something may have been created, renamed or deleted. */
  forget(): void {
    this.cache.clear();
  }

  private async call(category: string, action: string, args: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const r = await this.o.host.callAction(category, action, args);
    return r.isError ? null : parse(r);
  }

  /** One editor call, given up on after a while: null when it did not answer. */
  private timed(category: string, action: string, args: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const ms = this.o.editorTimeoutMs ?? EDITOR_LOOKUP_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    });
    return Promise.race([this.call(category, action, args).catch(() => null), late]).finally(() => clearTimeout(timer));
  }

  /**
   * A search's editor lookups as one turn of the lane: the assets and the
   * actors together. SUPERSEDED when a newer search took its place in the lane.
   */
  private editorLookups(query: string, assets: boolean, actors: boolean) {
    return this.lane.run(async () => {
      const [a, b] = await Promise.all([
        assets ? this.timed("asset", "search", { query, limit: SOURCE_ROWS }) : null,
        actors ? this.timed("level", "get_outliner", { nameFilter: query, limit: SOURCE_ROWS }) : null,
      ]);
      return { assets: a, actors: b };
    });
  }

  private async diskAssets(query: string): Promise<Found> {
    const json = await this.call("project", "list_content_assets", { contentPath: "/Game", namePattern: query, maxResults: SOURCE_ROWS }).catch(() => null);
    return { matches: diskAssets(json), source: json ? "disk" : "unavailable" };
  }

  private async files(query: string): Promise<Found> {
    const lists = await Promise.all(FILE_FOLDERS.map((dir) =>
      this.call("project", "list_files", { directory: dir, recursive: true, namePattern: query, maxResults: SOURCE_ROWS }).catch(() => null)));
    return { matches: lists.flatMap((json) => projectFiles(json, this.o.host.projectDir)), source: "disk" };
  }

  /** Matches for a query, ranked, at most MENTION_ROWS. An empty query matches nothing. */
  async search(rawQuery: string, kinds: readonly MentionKind[] = MENTION_KINDS): Promise<MentionSearchResponse | typeof SUPERSEDED> {
    const query = rawQuery.trim().slice(0, MAX_MENTION_QUERY);
    const want = MENTION_KINDS.filter((k) => kinds.includes(k));
    if (!query) return { query, results: [], sources: {} };
    // An editor held by a long call is not asked: assets come from disk, actors are unavailable.
    const editorUp = this.o.connected() && !this.o.busy();
    const key = `${editorUp ? "editor" : "disk"}|${want.join(",")}|${query.toLowerCase()}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < MENTION_TTL_MS) return hit.answer;
    const askAssets = want.includes("asset");
    const askActors = want.includes("actor");
    const [editor, files] = await Promise.all([
      editorUp && (askAssets || askActors) ? this.editorLookups(query, askAssets, askActors) : null,
      want.includes("file") ? this.files(query) : null,
    ]);
    if (editor === SUPERSEDED) return SUPERSEDED;
    const assets: Found | null = !askAssets ? null
      : editor?.assets ? { matches: editorAssets(editor.assets), source: "editor" }
      : await this.diskAssets(query);
    const actors: Found | null = !askActors ? null
      : editor?.actors ? { matches: outlinerActors(editor.actors), source: "editor" }
      : { matches: [], source: "unavailable" };
    const sources: Partial<Record<MentionKind, MentionSource>> = {};
    const all: MentionMatch[] = [];
    for (const [kind, found] of [["asset", assets], ["actor", actors], ["file", files]] as const) {
      if (!found) continue;
      sources[kind] = found.source;
      all.push(...found.matches);
    }
    const answer: MentionSearchResponse = { query, results: rankMentions(query, all, MENTION_ROWS), sources };
    // An answer an attached editor could have filled better is not kept: it may answer the next time.
    if (!(this.o.connected() && Object.values(sources).includes("unavailable"))) this.cache.set(key, { at: this.now(), answer });
    return answer;
  }
}

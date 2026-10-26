/**
 * The project's playtests, for the Playtests page. Under /v1/ext/studio:
 *
 *   GET    /qa/playtests                 every playtest script with its newest run: { playtests, listed }
 *   POST   /qa/playtests/card            { script }: the card Start playtest and Assign act on, made in a new session when none has one
 *   GET    /qa/playtests/script?script=  Edit: the script's steps as saved
 *   PUT    /qa/playtests/script          Edit saved: { script, steps, map? }, with pie(script_update)
 *   DELETE /qa/playtests/script?script=  Delete: pie(script_delete)
 *
 * Three sources make the list. The scripts are pie(script_list), which needs
 * the editor. The runs are every run Studio holds, in every session and none,
 * and every run ue-mcp has a record of, which also covers runs started outside
 * Studio before this daemon saw them. Those come from pie(script_runs) when the
 * daemon and the editor's bridge have it (ue-mcp 1.4.11-beta.5 and later);
 * without it, or without an editor, each results.json under
 * Saved/MCPObservations is read here instead. Once that ue-mcp is released,
 * apps/agent pins it, and the files stay only as the fallback with no editor.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ActionResult, DaemonExtensionApi } from "ue-mcp/daemon";
import {
  playtestOrder,
  qaActive,
  qaDraftFromScript,
  qaIsDraft,
  qaRunFromAnswer,
  qaScriptKey,
  type PlaytestEntry,
  type PlaytestIndexAnswer,
  type QaRun,
} from "@ue-mcp-studio/shared";
import type { QaBroker } from "./qa.js";
import type { SessionStore } from "./sessions.js";

export interface PlaytestIndexHost {
  callAction(category: string, action: string, args?: Record<string, unknown>): Promise<ActionResult>;
  editors(): Array<{ connected: boolean }>;
  projectDir: string;
  events?: { publish(type: string, data?: Record<string, unknown>): unknown };
  /** The daemon's actions (feature "actions.effects"): says whether pie(script_runs) exists before it is called. */
  actions?: { effects(categories?: string[]): Array<{ category: string; action: string }> };
}

/** How long the editor's script list is reused before it is asked again. */
const LIST_TTL_MS = 15_000;
/** The most results files read, newest first. */
const MAX_RESULTS = 300;
/** The most never-run scripts whose steps are read for the page. */
const MAX_READS = 60;
/** How long a bridge without pie(script_runs) is left alone before it is asked again, as after an update. */
const NO_RUNS_ACTION_MS = 5 * 60_000;

const text = (r: ActionResult): string => r.content.map((c) => c.text ?? "").join("\n");
function answerBody(r: ActionResult): Record<string, unknown> | null {
  if (r.isError) return null;
  try {
    const v = JSON.parse(text(r)) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    return (v as Record<string, unknown>).success === false ? null : (v as Record<string, unknown>);
  } catch {
    return null;
  }
}

export class PlaytestIndex {
  private list: { at: number; scripts: Array<{ path: string; name: string }> } | null = null;
  private readonly results = new Map<string, { mtime: number; run: QaRun | null }>();
  private readonly reads = new Map<string, { at: number; draft: QaRun | null }>();
  /** When the bridge last answered that it has no pie(script_runs). */
  private noRunsAction = -Infinity;
  private readonly now: () => number;

  constructor(private readonly o: { host: PlaytestIndexHost; broker: Pick<QaBroker, "all" | "drafted" | "readScriptAt" | "saveScriptAt" | "deleteScriptAt">; store: SessionStore; now?: () => number }) {
    this.now = o.now ?? Date.now;
  }

  /** The editor's script list, or null without an editor or when it fails. */
  private async scripts(fresh: boolean): Promise<Array<{ path: string; name: string }> | null> {
    if (!fresh && this.list && this.now() - this.list.at < LIST_TTL_MS) return this.list.scripts;
    if (!this.o.host.editors().some((e) => e.connected)) return null;
    const r = await this.o.host.callAction("pie", "script_list", { directory: "/" }).catch(() => null);
    const b = r ? answerBody(r) : null;
    if (!b || !Array.isArray(b.scripts)) return null;
    const scripts = (b.scripts as Array<Record<string, unknown>>)
      .filter((s) => typeof s?.path === "string")
      .map((s) => ({ path: qaScriptKey(s.path as string), name: typeof s.name === "string" ? s.name : qaScriptKey(s.path as string).split("/").pop()! }));
    this.list = { at: this.now(), scripts };
    return scripts;
  }

  /**
   * The runs ue-mcp lists with pie(script_runs), newest first, or null when
   * there is no editor, or the daemon or the bridge has no such action.
   */
  private async listedRuns(): Promise<QaRun[] | null> {
    if (this.now() - this.noRunsAction < NO_RUNS_ACTION_MS) return null;
    if (!this.o.host.editors().some((e) => e.connected)) return null;
    let known: boolean | null = null;
    try {
      known = this.o.host.actions ? this.o.host.actions.effects(["pie"]).some((a) => a.action === "script_runs") : null;
    } catch {
      known = null;
    }
    if (known === false) {
      this.noRunsAction = this.now();
      return null;
    }
    const r = await this.o.host.callAction("pie", "script_runs", { limit: MAX_RESULTS }).catch(() => null);
    const b = r ? answerBody(r) : null;
    if (!b || !Array.isArray(b.runs)) {
      // An editor built before the action answers that it does not know it.
      if (r && /unknown (action|method)|not a valid action|no handler/i.test(text(r))) this.noRunsAction = this.now();
      return null;
    }
    const at = new Date(this.now()).toISOString();
    return (b.runs as unknown[]).flatMap((row) => {
      const o = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
      const seenAt = typeof o.started_at === "string" && o.started_at ? o.started_at : typeof o.ended_at === "string" && o.ended_at ? o.ended_at : at;
      const run = qaRunFromAnswer(o, { seenAt });
      return run ? [run] : [];
    });
  }

  /** The runs results.json files record, newest first, each read again only when its file changed. */
  private disk(): QaRun[] {
    const root = path.join(this.o.host.projectDir, "Saved", "MCPObservations");
    let dirs: Array<{ file: string; mtime: number }>;
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => path.join(root, d.name, "results.json"))
        .flatMap((file) => {
          try {
            return [{ file, mtime: fs.statSync(file).mtimeMs }];
          } catch {
            return [];
          }
        });
    } catch {
      return [];
    }
    dirs.sort((a, b) => b.mtime - a.mtime);
    const runs: QaRun[] = [];
    for (const { file, mtime } of dirs.slice(0, MAX_RESULTS)) {
      let hit = this.results.get(file);
      if (!hit || hit.mtime !== mtime) {
        let run: QaRun | null = null;
        try {
          const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
          const at = typeof raw.started_at === "string" ? raw.started_at : new Date(mtime).toISOString();
          run = qaRunFromAnswer(raw, { seenAt: at });
        } catch {
          // Being written: the next read takes it.
        }
        hit = { mtime, run };
        this.results.set(file, hit);
      }
      if (hit.run) runs.push(hit.run);
    }
    return runs;
  }

  /** A never-run script's steps as saved, read once a minute at most. */
  private async draftOf(script: string): Promise<QaRun | null> {
    const had = this.reads.get(script);
    if (had && this.now() - had.at < 60_000) return had.draft;
    const r = await this.o.host.callAction("pie", "script_read", { path: script }).catch(() => null);
    const b = r ? answerBody(r) : null;
    const draft = b ? qaDraftFromScript(b, { seenAt: new Date(this.now()).toISOString() }) : null;
    this.reads.set(script, { at: this.now(), draft });
    return draft;
  }

  private session(id: string | null | undefined): { id: string; title: string } | null {
    const s = id ? this.o.store.get(id) : undefined;
    return s ? { id: s.id, title: s.title } : null;
  }

  /** Every playtest script, each with its newest run, the card to act on, and the session they are in. */
  async index(opts: { fresh?: boolean } = {}): Promise<PlaytestIndexAnswer> {
    const listed = await this.scripts(!!opts.fresh);
    const studio = this.o.broker.all().filter((r) => r.script !== "inline");
    const known = new Set(studio.map((r) => r.runId));
    const recorded = (await this.listedRuns()) ?? this.disk();
    const runs = [...studio, ...recorded.filter((r) => r.script !== "inline" && !known.has(r.runId))];

    const byScript = new Map<string, QaRun[]>();
    for (const r of runs) {
      const key = qaScriptKey(r.script);
      byScript.set(key, [...(byScript.get(key) ?? []), r]);
    }
    const names = new Map<string, string>((listed ?? []).map((s) => [s.path, s.name]));
    const keys = new Set([...names.keys(), ...byScript.keys()]);

    const newest = (a: QaRun, b: QaRun) => (a.seenAt < b.seenAt ? 1 : a.seenAt > b.seenAt ? -1 : 0);
    const entries: PlaytestEntry[] = [];
    let reads = 0;
    for (const script of keys) {
      const all = (byScript.get(script) ?? []).filter((r) => !(qaIsDraft(r) && r.deleted)).sort(newest);
      const onList = names.has(script);
      // A script the editor no longer lists left only its runs; a deleted draft alone is nothing.
      if (all.length === 0 && !onList) continue;
      const ran = all.filter((r) => !qaIsDraft(r));
      // A live run is the newest that matters, wherever it started.
      const last = ran.find(qaActive) ?? ran[0] ?? null;
      const card = all.find((r) => r.sessionId && this.o.store.get(r.sessionId) && !r.deleted) ?? null;
      const draft = !last && !card && onList && reads++ < MAX_READS ? await this.draftOf(script) : null;
      if (!last && !card && !draft && !onList) continue;
      entries.push({
        script,
        name: names.get(script) ?? last?.scriptName ?? card?.scriptName ?? script.split("/").pop() ?? script,
        last,
        card,
        draft,
        session: last ? this.session(last.sessionId) : this.session(card?.sessionId),
        ...(listed && !onList ? { deleted: true } : {}),
      });
    }
    entries.sort(playtestOrder);
    return { playtests: entries, listed: listed !== null };
  }

  /**
   * The card a page action works on: the newest run or draft of the script that
   * has a session. A script no session has gets a draft card in a new session,
   * which is where its runs, verdicts and subagents then live.
   */
  async card(req: unknown): Promise<{ run: QaRun } | { error: string; status: number }> {
    const asked = (req as { script?: unknown } | undefined)?.script;
    if (typeof asked !== "string" || !asked.startsWith("/")) return { error: "body must be { script: <asset path> }", status: 400 };
    const script = qaScriptKey(asked);
    const runs = this.o.broker.all().filter((r) => qaScriptKey(r.script) === script).sort((a, b) => (a.seenAt < b.seenAt ? 1 : -1));
    const had = runs.find((r) => r.sessionId && this.o.store.get(r.sessionId) && !r.deleted);
    if (had) return { run: had };
    if (!this.o.host.editors().some((e) => e.connected)) return { error: "the editor is not connected, so the script cannot be read", status: 409 };
    const r = await this.o.host.callAction("pie", "script_read", { path: script }).catch((e: Error) => ({ isError: true, content: [{ type: "text", text: e.message }] }) as ActionResult);
    const read = answerBody(r);
    if (!read) return { error: `the script could not be read: ${text(r) || "no answer"}`, status: 409 };
    // A deleted draft still names the session that drafted it: the card goes back there.
    const old = runs.find((x) => x.sessionId && this.o.store.get(x.sessionId));
    const session = old?.sessionId ? this.o.store.get(old.sessionId)! : this.o.store.create(`Playtest ${typeof read.name === "string" ? read.name : script.split("/").pop()}`);
    if (!old) this.o.host.events?.publish("session.changed", { sessionId: session.id, status: session.status, waitingCause: session.waitingCause });
    const run = await this.o.broker.drafted(session.id, read);
    return run ? { run } : { error: "the script's card could not be made", status: 409 };
  }

  /** Edit's steps, read fresh from the editor. */
  async readScript(asked: unknown): Promise<{ run: QaRun } | { error: string; status: number }> {
    const script = scriptOf(asked);
    if (!script) return { error: "script must be an asset path", status: 400 };
    if (!this.o.host.editors().some((e) => e.connected)) return { error: "the editor is not connected, so the script cannot be read", status: 409 };
    return this.o.broker.readScriptAt(script);
  }

  /** Edit saved on any script: the next list reads it again. */
  async saveScript(req: unknown): Promise<{ script: string } | { error: string; status: number }> {
    const b = (req ?? {}) as { script?: unknown; steps?: unknown; map?: unknown };
    const script = scriptOf(b.script);
    if (!script) return { error: "body must be { script: <asset path>, steps: [...] }", status: 400 };
    if (!this.o.host.editors().some((e) => e.connected)) return { error: "the editor is not connected, so the script cannot be saved", status: 409 };
    const r = await this.o.broker.saveScriptAt(script, b.steps, b.map);
    this.reads.delete(script);
    return r;
  }

  /** Delete on any script: the next list asks the editor for its scripts again. */
  async deleteScript(asked: unknown): Promise<{ script: string } | { error: string; status: number }> {
    const script = scriptOf(asked);
    if (!script) return { error: "script must be an asset path", status: 400 };
    if (!this.o.host.editors().some((e) => e.connected)) return { error: "the editor is not connected, so the script cannot be deleted", status: 409 };
    const r = await this.o.broker.deleteScriptAt(script);
    this.reads.delete(script);
    this.list = null;
    return r;
  }
}

/** A script path a page route was given: an asset path, without its object name. */
function scriptOf(v: unknown): string | null {
  return typeof v === "string" && v.startsWith("/") ? qaScriptKey(v) : null;
}

export function registerPlaytestIndex(api: DaemonExtensionApi, index: PlaytestIndex): void {
  api.route("GET", "/qa/playtests", async (req) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    return { body: await index.index({ fresh: q.fresh === "1" }) };
  });
  api.route("POST", "/qa/playtests/card", async (req) => {
    const r = await index.card(req.body);
    return "error" in r ? { status: r.status, body: { error: r.error } } : { body: r };
  });
  api.route("GET", "/qa/playtests/script", async (req) => {
    const r = await index.readScript(((req.query ?? {}) as Record<string, unknown>).script);
    return "error" in r ? { status: r.status, body: { error: r.error } } : { body: r };
  });
  api.route("PUT", "/qa/playtests/script", async (req) => {
    const r = await index.saveScript(req.body);
    return "error" in r ? { status: r.status, body: { error: r.error } } : { body: r };
  });
  api.route("DELETE", "/qa/playtests/script", async (req) => {
    const r = await index.deleteScript(((req.query ?? {}) as Record<string, unknown>).script);
    return "error" in r ? { status: r.status, body: { error: r.error } } : { body: r };
  });
}

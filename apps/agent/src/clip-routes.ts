/**
 * Playtest clips for the Playtest Hub's timeline: ue-mcp's pie clip_*
 * actions behind Studio's routes, under /v1/ext/studio:
 *
 *   GET  /clips?directory=            pie(clip_list): every clip with its newest run
 *   POST /clips                       { name, clip? | text? }: pie(clip_create), refused when the name is taken
 *   GET  /clips/clip?path=            pie(clip_read): the clip with stable ids, and clip_validate's warnings
 *   PUT  /clips/clip                  { path, clip | text }: pie(clip_update); undo and redo send a rollback here
 *   POST /clips/validate              { path? | clip? | text? }: pie(clip_validate), which saves nothing
 *   POST /clips/edit                  { path, ops }: pie(clip_edit), all or none, with the rollback for undo
 *   POST /clips/run                   { path, region? }: pie(clip_run), starting PIE
 *   POST /clips/record                { path, region? | from_check?, armed? }: pie(clip_record)
 *   POST /clips/record/stop           pie(clip_record_stop)
 *   POST /clips/stop                  { run_id?, reason? }: pie(clip_stop)
 *   GET  /clips/status?run_id=        pie(clip_status)
 *   POST /clips/verdict               { check, verdict, note? }: pie(clip_verdict) as the person's verdict
 *   GET  /clips/runs?path=&limit=     pie(clip_runs); runs is null when ue-mcp has no clip_runs
 *
 * A refusal answers 409 with ue-mcp's reason and its findings, each with
 * candidates where it has them, so the timeline can offer them as fixes.
 */
import type { ActionResult, DaemonExtensionApi } from "ue-mcp/daemon";
import type { ClipFinding } from "@ue-mcp-studio/shared";
import { failureOf } from "./action-answer.js";

export interface ClipsHost {
  callAction(category: string, action: string, args?: Record<string, unknown>): Promise<ActionResult>;
  editors(): Array<{ connected: boolean }>;
}

type Answer = { status?: number; body: unknown };

const NO_EDITOR = "the editor is not connected";
const VERDICTS = new Set(["pass", "fail", "skip"]);
/** What ue-mcp says when it has no such action: an older ue-mcp without clip_runs. */
const UNKNOWN_ACTION = /unknown action|unknown method/i;

/** The JSON of a call's answer, refusals included, or null when it is not JSON. */
function rawOf(r: ActionResult): Record<string, unknown> | null {
  try {
    const v = JSON.parse(r.content.map((c) => c.text ?? "").join("\n")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const findings = (v: unknown): ClipFinding[] => (Array.isArray(v) ? (v as unknown[]).filter((f): f is ClipFinding => !!f && typeof f === "object" && typeof (f as ClipFinding).message === "string") : []);
const asPath = (v: unknown): string | null => (typeof v === "string" && v.startsWith("/") ? v : null);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export class Clips {
  constructor(private readonly o: { host: ClipsHost }) {}

  private connected(): boolean {
    return this.o.host.editors().some((e) => e.connected);
  }

  /** Call a pie action; a refusal becomes 409 with the reason and findings, a missing editor 409 too. */
  private async call(action: string, args: Record<string, unknown>, what: string): Promise<{ ok: Record<string, unknown> } | { refused: Answer }> {
    let r: ActionResult;
    try {
      r = await this.o.host.callAction("pie", action, args);
    } catch (e) {
      return { refused: { status: 409, body: { error: e instanceof Error ? e.message : `${what} failed` } } };
    }
    const a = rawOf(r);
    if (r.isError || !a || a.success === false) {
      return {
        refused: {
          status: 409,
          body: {
            error: (a && typeof a.error === "string" ? a.error : null) ?? failureOf(r) ?? `${what} failed`,
            errors: findings(a?.errors),
            warnings: findings(a?.warnings),
          },
        },
      };
    }
    return { ok: a };
  }

  private gate(): Answer | null {
    return this.connected() ? null : { status: 409, body: { error: NO_EDITOR } };
  }

  async list(directory: unknown): Promise<Answer> {
    const g = this.gate();
    if (g) return g;
    const r = await this.call("clip_list", str(directory) ? { directory: str(directory) } : {}, "listing clips");
    if ("refused" in r) return r.refused;
    return { body: { clips: Array.isArray(r.ok.clips) ? r.ok.clips : [] } };
  }

  async create(body: unknown): Promise<Answer> {
    const b = (body ?? {}) as Record<string, unknown>;
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (!/^[A-Za-z0-9_]+$/.test(name)) return { status: 400, body: { error: "name must be letters, digits and underscores" } };
    const g = this.gate();
    if (g) return g;
    const source = typeof b.text === "string" ? { text: b.text } : { clip: b.clip && typeof b.clip === "object" ? b.clip : { rate: 60 } };
    const r = await this.call("clip_create", { name, ...source, onConflict: "error" }, "creating the clip");
    if ("refused" in r) return r.refused;
    const path = asPath(r.ok.path) ?? asPath(r.ok.object_path);
    if (!path) return { status: 409, body: { error: "ue-mcp did not say where it saved the clip" } };
    return { body: { path, warnings: findings(r.ok.warnings) } };
  }

  /** The clip as ue-mcp holds it, with the warnings a save would give. */
  async read(asked: unknown): Promise<Answer> {
    const path = asPath(asked);
    if (!path) return { status: 400, body: { error: "path must be an asset path" } };
    const g = this.gate();
    if (g) return g;
    const r = await this.call("clip_read", { path }, "reading the clip");
    if ("refused" in r) return r.refused;
    // Warnings are a convenience: a clip that reads but does not validate still opens.
    const v = await this.call("clip_validate", { path }, "checking the clip");
    const warnings = "ok" in v ? findings(v.ok.errors) : [];
    return { body: { path, clip: r.ok.clip ?? {}, text: typeof r.ok.text === "string" ? r.ok.text : undefined, warnings } };
  }

  async update(body: unknown): Promise<Answer> {
    const b = (body ?? {}) as Record<string, unknown>;
    const path = asPath(b.path);
    const source = typeof b.text === "string" ? { text: b.text } : b.clip && typeof b.clip === "object" ? { clip: b.clip } : null;
    if (!path || !source) return { status: 400, body: { error: "body must be { path, clip } or { path, text }" } };
    const g = this.gate();
    if (g) return g;
    const r = await this.call("clip_update", { path, ...source }, "saving the clip");
    if ("refused" in r) return r.refused;
    return { body: { path, clip: r.ok.clip ?? source.clip ?? {}, text: typeof r.ok.text === "string" ? r.ok.text : undefined, warnings: findings(r.ok.warnings), rollback: rollbackOf(r.ok) } };
  }

  async validate(body: unknown): Promise<Answer> {
    const b = (body ?? {}) as Record<string, unknown>;
    const args = asPath(b.path) ? { path: b.path } : typeof b.text === "string" ? { text: b.text } : b.clip && typeof b.clip === "object" ? { clip: b.clip } : null;
    if (!args) return { status: 400, body: { error: "body must name a path, a clip or a text" } };
    const g = this.gate();
    if (g) return g;
    const r = await this.call("clip_validate", args, "checking the clip");
    if ("refused" in r) return r.refused;
    return { body: { valid: r.ok.valid === true, saveable: r.ok.saveable !== false, errors: findings(r.ok.errors) } };
  }

  async edit(body: unknown): Promise<Answer> {
    const b = (body ?? {}) as Record<string, unknown>;
    const path = asPath(b.path);
    if (!path || !Array.isArray(b.ops) || b.ops.length === 0) return { status: 400, body: { error: "body must be { path, ops: [...] } with at least one op" } };
    const g = this.gate();
    if (g) return g;
    const r = await this.call("clip_edit", { path, ops: b.ops }, "the edit");
    if ("refused" in r) return r.refused;
    return {
      body: {
        path,
        changed: Array.isArray(r.ok.changed) ? r.ok.changed.filter((c): c is string => typeof c === "string") : [],
        clip: r.ok.clip ?? {},
        text: typeof r.ok.text === "string" ? r.ok.text : undefined,
        warnings: findings(r.ok.warnings),
        rollback: rollbackOf(r.ok),
      },
    };
  }

  async run(body: unknown): Promise<Answer> {
    const b = (body ?? {}) as Record<string, unknown>;
    const path = asPath(b.path);
    if (!path) return { status: 400, body: { error: "path must be an asset path" } };
    const g = this.gate();
    if (g) return g;
    const r = await this.call("clip_run", { path, start_pie: true, ...(str(b.region) ? { region: str(b.region) } : {}) }, "starting the run");
    if ("refused" in r) return r.refused;
    return { body: r.ok };
  }

  async record(body: unknown): Promise<Answer> {
    const b = (body ?? {}) as Record<string, unknown>;
    const path = asPath(b.path);
    if (!path) return { status: 400, body: { error: "path must be an asset path" } };
    if (str(b.region) && str(b.from_check)) return { status: 400, body: { error: "punch in at a region or at a check, not both" } };
    const armed = Array.isArray(b.armed) ? b.armed.filter((a): a is string => typeof a === "string" && a.startsWith("/")) : null;
    const g = this.gate();
    if (g) return g;
    const r = await this.call("clip_record", {
      path,
      ...(str(b.region) ? { region: str(b.region) } : {}),
      ...(str(b.from_check) ? { from_check: str(b.from_check) } : {}),
      ...(armed && armed.length ? { armed } : {}),
    }, "starting the recording");
    if ("refused" in r) return r.refused;
    return { body: r.ok };
  }

  async recordStop(): Promise<Answer> {
    const g = this.gate();
    if (g) return g;
    const r = await this.call("clip_record_stop", {}, "stopping the recording");
    return "refused" in r ? r.refused : { body: r.ok };
  }

  async stop(body: unknown): Promise<Answer> {
    const b = (body ?? {}) as Record<string, unknown>;
    const g = this.gate();
    if (g) return g;
    const r = await this.call("clip_stop", { ...(str(b.run_id) ? { run_id: str(b.run_id) } : {}), reason: str(b.reason) ?? "Studio stopped" }, "stopping the run");
    return "refused" in r ? r.refused : { body: r.ok };
  }

  /** A run's results. A finished run is read from its results file, so this works with the editor closed. */
  async status(runId: unknown): Promise<Answer> {
    const r = await this.call("clip_status", str(runId) ? { run_id: str(runId) } : {}, "reading the run");
    return "refused" in r ? r.refused : { body: r.ok };
  }

  async verdict(body: unknown): Promise<Answer> {
    const b = (body ?? {}) as Record<string, unknown>;
    const check = str(b.check);
    const verdict = str(b.verdict);
    if (!check || !verdict || !VERDICTS.has(verdict)) return { status: 400, body: { error: "body must be { check, verdict: pass | fail | skip, note? }" } };
    const g = this.gate();
    if (g) return g;
    const r = await this.call("clip_verdict", { check, verdict, source: "human", ...(str(b.note) ? { note: str(b.note) } : {}) }, "the verdict");
    return "refused" in r ? r.refused : { body: r.ok };
  }

  /** Run history, newest first. An older ue-mcp has none: runs is null, and the timeline says so. */
  async runs(query: Record<string, unknown>): Promise<Answer> {
    const limit = Number(query.limit);
    const args = {
      ...(asPath(query.path) ? { path: query.path } : {}),
      ...(Number.isInteger(limit) && limit > 0 ? { limit: Math.min(limit, 200) } : {}),
    };
    let r: ActionResult;
    try {
      r = await this.o.host.callAction("pie", "clip_runs", args);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return UNKNOWN_ACTION.test(msg) ? { body: { runs: null } } : { status: 409, body: { error: msg } };
    }
    const why = failureOf(r);
    if (why) return UNKNOWN_ACTION.test(why) ? { body: { runs: null } } : { status: 409, body: { error: why } };
    const a = rawOf(r) ?? {};
    return { body: { runs: Array.isArray(a.runs) ? a.runs : [], ...(typeof a.total === "number" ? { total: a.total } : {}) } };
  }
}

/** clip_edit's and clip_update's rollback, { method: pie_clip_update, payload: { path, clip } }, as clip_update's params. */
function rollbackOf(a: Record<string, unknown>): { path: string; clip: unknown } | null {
  const rb = a.rollback as { payload?: { path?: unknown; clip?: unknown } } | undefined;
  const p = rb?.payload;
  return p && typeof p.path === "string" && p.clip && typeof p.clip === "object" ? { path: p.path, clip: p.clip } : null;
}

export function registerClips(api: DaemonExtensionApi, clips: Clips): void {
  const send = (a: Answer) => (a.status ? { status: a.status, body: a.body } : { body: a.body });
  const q = (req: { query?: unknown }) => (req.query ?? {}) as Record<string, unknown>;
  api.route("GET", "/clips", async (req) => send(await clips.list(q(req).directory)));
  api.route("POST", "/clips", async (req) => send(await clips.create(req.body)));
  api.route("GET", "/clips/clip", async (req) => send(await clips.read(q(req).path)));
  api.route("PUT", "/clips/clip", async (req) => send(await clips.update(req.body)));
  api.route("POST", "/clips/validate", async (req) => send(await clips.validate(req.body)));
  api.route("POST", "/clips/edit", async (req) => send(await clips.edit(req.body)));
  api.route("POST", "/clips/run", async (req) => send(await clips.run(req.body)));
  api.route("POST", "/clips/record", async (req) => send(await clips.record(req.body)));
  api.route("POST", "/clips/record/stop", async () => send(await clips.recordStop()));
  api.route("POST", "/clips/stop", async (req) => send(await clips.stop(req.body)));
  api.route("GET", "/clips/status", async (req) => send(await clips.status(q(req).run_id)));
  api.route("POST", "/clips/verdict", async (req) => send(await clips.verdict(req.body)));
  api.route("GET", "/clips/runs", async (req) => send(await clips.runs(q(req))));
}

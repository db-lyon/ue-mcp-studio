/**
 * The Playtest Hub's playtest editor. Under /v1/ext/studio:
 *
 *   GET  /qa/drafting/catalog          what a step can name: pie(script_values), the project's Input Actions and levels, and the level open in the editor
 *   GET  /qa/drafting/script?script=   a saved script as pie(script_read) answers it, with the player Studio keeps for each step
 *   POST /qa/drafting/validate         { steps, map?, manual_only? }: pie(script_validate), which saves nothing
 *   POST /qa/drafting/create           { name, steps, map?, manual_only? }: pie(script_create), refused when the name is taken
 *
 * An edit to a saved script goes through PUT /qa/playtests/script. Each step
 * may carry a player, which Studio keeps (ue-mcp's steps have none) and takes
 * out before the call, as everywhere else.
 */
import type { ActionResult, DaemonExtensionApi } from "ue-mcp/daemon";
import { qaScriptKey } from "@ue-mcp-studio/shared";
import { answerOf, failureOf } from "./action-answer.js";
import { splitPlayers } from "./qa.js";

export interface DraftingHost {
  callAction(category: string, action: string, args?: Record<string, unknown>): Promise<ActionResult>;
  editors(): Array<{ connected: boolean }>;
}

export interface DraftingPlayers {
  players(script: string): Record<number, string>;
  setPlayers(script: string, players: Record<number, string>): void;
}

type Answer = { status?: number; body: unknown };

const NO_EDITOR = "the editor is not connected";
/** How many Input Actions and levels the catalog lists at most. */
const LIST_LIMIT = 500;

/** The raw JSON of a call's answer, refusals included, or null when it is not JSON. */
function rawOf(r: ActionResult): Record<string, unknown> | null {
  try {
    const v = JSON.parse(r.content.map((c) => c.text ?? "").join("\n")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const settle = (p: Promise<ActionResult>): Promise<ActionResult | null> => p.catch(() => null);

/** Asset package paths from an asset(list) answer. */
function assetRows(r: ActionResult | null): Array<{ path: string; name: string }> {
  const b = r ? answerOf(r) : null;
  const rows = b && Array.isArray(b.assets) ? (b.assets as Array<Record<string, unknown>>) : [];
  return rows.flatMap((a) => (typeof a?.path === "string" ? [{ path: a.path, name: typeof a.name === "string" ? a.name : a.path.split("/").pop()! }] : []));
}

export class Drafting {
  constructor(private readonly o: { host: DraftingHost; players?: DraftingPlayers; created?: () => void }) {}

  private connected(): boolean {
    return this.o.host.editors().some((e) => e.connected);
  }

  /** Everything a step can name, read in one go; a part that cannot be read is empty and named in `gaps`. */
  async catalog(): Promise<Answer> {
    if (!this.connected()) return { status: 409, body: { error: NO_EDITOR } };
    const call = (category: string, action: string, args: Record<string, unknown>) => settle(this.o.host.callAction(category, action, args));
    const [values, inputs, levels, current] = await Promise.all([
      call("pie", "script_values", { limit: 1000 }),
      call("asset", "list", { directory: "/Game", classPaths: ["/Script/EnhancedInput.InputAction"], limit: LIST_LIMIT }),
      call("asset", "list", { directory: "/Game", classPaths: ["/Script/Engine.World"], limit: LIST_LIMIT }),
      call("level", "get_current", {}),
    ]);
    const gaps: string[] = [];
    const v = values ? answerOf(values) : null;
    if (!v) gaps.push(`values: ${values ? failureOf(values) ?? "no answer" : "no answer"}`);
    if (!inputs || !answerOf(inputs)) gaps.push("inputActions");
    if (!levels || !answerOf(levels)) gaps.push("levels");
    const c = current ? answerOf(current) : null;
    const currentLevel = c && typeof c.mapPackagePath === "string" ? c.mapPackagePath : null;
    return {
      body: {
        values: v,
        inputActions: assetRows(inputs).map((a) => a.path),
        levels: assetRows(levels),
        currentLevel,
        gaps,
      },
    };
  }

  /** A saved script as written, every field of every step kept, with Studio's players. */
  async script(asked: unknown): Promise<Answer> {
    const script = typeof asked === "string" && asked.startsWith("/") ? qaScriptKey(asked) : null;
    if (!script) return { status: 400, body: { error: "script must be an asset path" } };
    if (!this.connected()) return { status: 409, body: { error: NO_EDITOR } };
    const r = await settle(this.o.host.callAction("pie", "script_read", { path: script }));
    const b = r ? answerOf(r) : null;
    if (!b) return { status: 409, body: { error: r ? failureOf(r) ?? "the script could not be read" : "the script could not be read" } };
    return { body: { script: b, players: this.o.players?.players(script) ?? {} } };
  }

  /** The checks pie(script_create) runs, without saving. */
  async validate(body: unknown): Promise<Answer> {
    const b = (body ?? {}) as Record<string, unknown>;
    const split = splitPlayers(b.steps);
    if (!split || split.steps.length === 0) return { status: 400, body: { error: "body must be { steps: [...] } with at least one step" } };
    if (!this.connected()) return { status: 409, body: { error: NO_EDITOR } };
    const r = await settle(this.o.host.callAction("pie", "script_validate", {
      steps: split.steps,
      ...(typeof b.map === "string" && b.map ? { map: b.map } : {}),
      ...(b.manual_only === true ? { manual_only: true } : {}),
    }));
    const a = r ? rawOf(r) : null;
    if (!r || !a || r.isError || a.success === false) return { status: 409, body: { error: r ? failureOf(r) ?? "the steps could not be checked" : "the steps could not be checked" } };
    return { body: { valid: a.valid === true, errors: Array.isArray(a.errors) ? a.errors : [], ...(typeof a.summary === "string" ? { summary: a.summary } : {}) } };
  }

  /** A new script asset. A name already taken is refused, never overwritten. */
  async create(body: unknown): Promise<Answer> {
    const b = (body ?? {}) as Record<string, unknown>;
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (!/^[A-Za-z0-9_]+$/.test(name)) return { status: 400, body: { error: "name must be letters, digits and underscores" } };
    const split = splitPlayers(b.steps);
    if (!split || split.steps.length === 0) return { status: 400, body: { error: "body must be { name, steps: [...] } with at least one step" } };
    if (!this.connected()) return { status: 409, body: { error: `${NO_EDITOR}, so the playtest cannot be saved` } };
    const r = await settle(this.o.host.callAction("pie", "script_create", {
      name,
      steps: split.steps,
      ...(typeof b.map === "string" && b.map ? { map: b.map } : {}),
      ...(b.manual_only === true ? { manual_only: true } : {}),
      onConflict: "error",
    }));
    const a = r ? rawOf(r) : null;
    if (!r || !a || r.isError || a.success === false || typeof a.path !== "string") {
      return {
        status: 409,
        body: {
          error: (a && typeof a.error === "string" ? a.error : null) ?? (r ? failureOf(r) : null) ?? "the playtest was not saved",
          errors: a && Array.isArray(a.errors) ? a.errors : [],
          warnings: a && Array.isArray(a.warnings) ? a.warnings : [],
        },
      };
    }
    const path = qaScriptKey(a.path);
    if (Object.keys(split.players).length) this.o.players?.setPlayers(path, split.players);
    this.o.created?.();
    return { body: { path, warnings: Array.isArray(a.warnings) ? a.warnings : [] } };
  }
}

export function registerDrafting(api: DaemonExtensionApi, drafting: Drafting): void {
  const send = (a: Answer) => (a.status ? { status: a.status, body: a.body } : { body: a.body });
  api.route("GET", "/qa/drafting/catalog", async () => send(await drafting.catalog()));
  api.route("GET", "/qa/drafting/script", async (req) => send(await drafting.script(((req.query ?? {}) as Record<string, unknown>).script)));
  api.route("POST", "/qa/drafting/validate", async (req) => send(await drafting.validate(req.body)));
  api.route("POST", "/qa/drafting/create", async (req) => send(await drafting.create(req.body)));
}

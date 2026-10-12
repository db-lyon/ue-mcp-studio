/**
 * What the model can call, and how each call runs.
 *
 * ue-mcp's whole surface goes through one tool in its micro gateway shape:
 * search and describe run ue-mcp's own project(search_tools) and
 * project(describe_action), and call runs the named action, all in process
 * through the daemon's dispatch (api.callAction). editor_restart has the
 * daemon stop, rebuild if asked, and start the editor, announcing why first.
 * The machine tools (shell, files, search, web) live in local-tools.ts.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { ActionResult, EditorStatus } from "ue-mcp/daemon";
import type { TouchedItem } from "@ue-mcp-studio/shared";
import { isLocalTool, localToolDefinitions, runLocal, validateLocal } from "./local-tools.js";

/** The part of the daemon's extension API the agent uses, so tests can stand in for it. */
export interface AgentHost {
  projectDir: string;
  dataDir: string;
  callAction(category: string, action: string, args?: Record<string, unknown>): Promise<ActionResult>;
  editors(): EditorStatus[];
  editorOperation(op: "start" | "stop" | "restart" | "rebuild"): Promise<Record<string, unknown>>;
  events: {
    publish(type: string, data?: Record<string, unknown>): unknown;
    subscribe(listener: (e: { type: string; data: Record<string, unknown> }) => void): () => void;
  };
  setBusy(busy: () => boolean): void;
  log: { info(message: string): void; warn(message: string, detail?: unknown): void };
}

/** The editor tools: what the main agent and every subagent can call. */
export const EDITOR_TOOLS: Anthropic.Beta.BetaToolUnion[] = [
  {
    name: "ue_mcp",
    description:
      "Unreal Editor actions through ue-mcp. action=search finds actions by intent (query); "
      + "action=describe gives one action's parameters (category + method) or a category's actions (category alone); "
      + "action=call runs one action (category, method, args). Describe before the first call of an action. "
      + "A result may report created, existed or updated: read it rather than assuming.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["search", "describe", "call"] },
        query: { type: "string", description: "search: keywords or intent" },
        category: { type: "string", description: "describe/call: the category, e.g. blueprint" },
        method: { type: "string", description: "describe/call: the action name, e.g. create" },
        args: { type: "object", description: "call: the action's parameters" },
      },
      required: ["action"],
    },
    eager_input_streaming: true,
  },
  {
    name: "editor_restart",
    description:
      "Restart the Unreal Editor, or stop it, rebuild the project's C++ and start it again (rebuild). "
      + "Use after a C++ change, a plugin enable, or when the editor must reload. Unsaved work is lost: save first. "
      + "The turn continues when the editor is back.",
    input_schema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["restart", "rebuild"] },
        reason: { type: "string" },
      },
      required: ["operation", "reason"],
    },
    eager_input_streaming: true,
  },
];

/** Every tool a subagent has: the editor's, and the machine's (shell, files, search, web). */
export const WORK_TOOLS: Anthropic.Beta.BetaToolUnion[] = [...EDITOR_TOOLS, ...localToolDefinitions()];

/** The subagent tool. A subagent gets the work tools only, so it cannot start subagents itself. */
export const AGENT_TOOL: Anthropic.Beta.BetaToolUnion = {
  name: "agent",
  description:
    "Hand a self-contained task to a subagent. It has the same tools: ue_mcp and editor_restart for the editor, "
    + "and the shell, file, search and web tools for the project's files, git and the internet. It reports back what it did. It sees only the prompt you write, so include every path, name and constraint it needs. "
    + "Call agent several times in one message to run independent tasks at the same time; never give two subagents the same assets.",
  input_schema: {
    type: "object",
    properties: {
      description: { type: "string", description: "A short (3-5 word) name for the task, shown to the user" },
      prompt: { type: "string", description: "The complete task for the subagent" },
    },
    required: ["description", "prompt"],
  },
};

export const TOOLS: Anthropic.Beta.BetaToolUnion[] = [...WORK_TOOLS, AGENT_TOOL];

export type CallOutcome = "done" | "error" | "unknown";

export interface ToolExecution {
  text: string;
  isError: boolean;
  outcome: CallOutcome;
  touched: TouchedItem[];
  /** Paths a save action reports saved; "*" for everything. */
  saved: string[];
}

/** Check a streamed tool input before running it: eager streaming hands over input unvalidated. */
export function validateInput(name: string, input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "input must be an object";
  const i = input as Record<string, unknown>;
  if (isLocalTool(name)) return validateLocal(name, i);
  if (name === "editor_restart") {
    if (i.operation !== "restart" && i.operation !== "rebuild") return "operation must be restart or rebuild";
    return null;
  }
  if (name !== "ue_mcp") return `unknown tool ${name}`;
  if (i.action === "search") return typeof i.query === "string" && i.query.trim() ? null : "search needs query";
  if (i.action === "describe") return typeof i.category === "string" ? null : "describe needs category";
  if (i.action === "call") {
    if (typeof i.category !== "string" || typeof i.method !== "string") return "call needs category and method";
    if (i.args !== undefined && (typeof i.args !== "object" || i.args === null || Array.isArray(i.args))) return "args must be an object";
    return null;
  }
  return "action must be search, describe or call";
}

function resultText(r: ActionResult): string {
  return r.content.map((c) => c.text ?? "").join("\n");
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const ASSET_KEYS = ["assetPath", "objectPath", "blueprintPath", "materialPath", "packagePath", "path"];
const ACTOR_KEYS = ["actorLabel", "actorPath", "actorName"];

/** The asset and actor paths a call's arguments name. */
export function namedTargets(args: Record<string, unknown>): TouchedItem[] {
  const out: TouchedItem[] = [];
  for (const k of ASSET_KEYS) {
    const v = args[k];
    if (typeof v === "string" && v.startsWith("/")) out.push({ kind: "asset", path: v, saved: false });
  }
  for (const v of Array.isArray(args.assetPaths) ? args.assetPaths : []) {
    if (typeof v === "string" && v.startsWith("/")) out.push({ kind: "asset", path: v, saved: false });
  }
  for (const k of ACTOR_KEYS) {
    const v = args[k];
    if (typeof v === "string" && v) out.push({ kind: "actor", path: v, saved: false });
  }
  return out;
}

/** Did a result report changing something? Handlers say so with created/updated/changed/deleted. */
function reportsChange(json: Record<string, unknown> | null): boolean {
  if (!json) return false;
  return json.created === true || json.updated === true || json.changed === true || json.deleted === true
    || (typeof json.deleted === "number" && json.deleted > 0);
}

function isSaveAction(method: string): boolean {
  return /(^|_)save(_|$)/.test(method) || method === "save";
}

/** A /Game path's package file in this project, or null for a mount this cannot map. */
export function packageFile(projectDir: string, objectPath: string): string | null {
  const m = /^\/Game\/(.+?)(\.[^/]*)?$/.exec(objectPath);
  if (!m) return null;
  const base = path.join(projectDir, "Content", ...m[1].split("/"));
  for (const ext of [".uasset", ".umap"]) if (fs.existsSync(base + ext)) return base + ext;
  return base + ".uasset";
}

export function editorConnected(host: AgentHost): boolean {
  return host.editors().some((e) => e.connected);
}

/** Run one tool call. An error while the editor went away is reported as an unknown outcome, never as a failure. */
export async function executeTool(host: AgentHost, name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolExecution> {
  const invalid = validateInput(name, input);
  if (invalid) return { text: `Invalid input: ${invalid}`, isError: true, outcome: "error", touched: [], saved: [] };

  if (isLocalTool(name)) {
    const r = await runLocal(host.projectDir, name, input, signal);
    return { text: r.text, isError: r.isError, outcome: r.isError ? "error" : "done", touched: [], saved: [] };
  }

  if (name === "editor_restart") {
    const op = input.operation as "restart" | "rebuild";
    const result = await host.editorOperation(op);
    const steps = (result.steps as Array<{ step: string; ok: boolean; result?: string }> | undefined) ?? [];
    const failed = steps.find((s) => !s.ok);
    return {
      text: failed ? `${op} failed at ${failed.step}: ${failed.result ?? ""}`.trim() : `${op} finished: ${steps.map((s) => s.step).join(", ")}`,
      isError: !!failed,
      outcome: failed ? "error" : "done",
      touched: [],
      saved: [],
    };
  }

  const action = input.action as string;
  if (action === "search") {
    const r = await host.callAction("project", "search_tools", { query: input.query, limit: 15 });
    return { text: resultText(r), isError: r.isError, outcome: r.isError ? "error" : "done", touched: [], saved: [] };
  }
  if (action === "describe") {
    const args = typeof input.method === "string" && input.method
      ? { name: `${input.category}.${input.method}` }
      : { name: String(input.category), category: input.category };
    const r = await host.callAction("project", "describe_action", args);
    return { text: resultText(r), isError: r.isError, outcome: r.isError ? "error" : "done", touched: [], saved: [] };
  }

  const category = input.category as string;
  const method = input.method as string;
  const args = (input.args as Record<string, unknown> | undefined) ?? {};
  let r: ActionResult;
  try {
    r = await host.callAction(category, method, args);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (!editorConnected(host)) return { text: message, isError: true, outcome: "unknown", touched: namedTargets(args), saved: [] };
    return { text: message, isError: true, outcome: "error", touched: [], saved: [] };
  }
  const text = resultText(r);
  if (r.isError && !editorConnected(host)) {
    return { text, isError: true, outcome: "unknown", touched: namedTargets(args), saved: [] };
  }
  const json = parseJson(text);
  const touched = !r.isError && reportsChange(json) ? namedTargets(args) : [];
  const savedHere = json?.saved === true;
  for (const t of touched) t.saved = savedHere;
  let saved: string[] = [];
  if (!r.isError && isSaveAction(method)) {
    const named = namedTargets(args).map((t) => t.path);
    saved = named.length > 0 ? named : ["*"];
  }
  return { text, isError: r.isError, outcome: r.isError ? "error" : "done", touched, saved };
}

/** What a reattach can establish about a call whose outcome is unknown, without running it again. */
export function verifyUnknown(host: AgentHost, input: Record<string, unknown>, cause: string): string {
  const args = (input.args as Record<string, unknown> | undefined) ?? {};
  const lines = [
    `Outcome unknown: the editor went away (${cause}) while ${input.category}.${input.method} ran, so it may or may not have taken effect.`,
  ];
  for (const t of namedTargets(args)) {
    if (t.kind !== "asset") continue;
    const file = packageFile(host.projectDir, t.path);
    lines.push(file ? `On disk now: ${t.path} ${fs.existsSync(file) ? "exists" : "does not exist"}.` : `${t.path} is outside /Game; check it with a read.`);
  }
  lines.push("Read the current state back before deciding whether to run it again.");
  return lines.join("\n");
}

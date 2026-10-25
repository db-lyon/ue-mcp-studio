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
import { CHANGING_TOOLS, isLocalTool, localToolDefinitions, runLocal, validateLocal, type LocalToolName } from "./local-tools.js";
import { firstFailedStep, type OperationStep } from "./operation-result.js";
import { IMAGE_EXTENSIONS, MAX_IMAGE_FILE_BYTES, prepareImage, sniffImage, type ToolImage } from "./images.js";
import { compactDescribe, compactSearch } from "./discovery.js";
import { compactJson, keepForModel, saveResult } from "./model-text.js";

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

/** The ue_mcp tool's description, the same on every route. */
export const UE_MCP_DESCRIPTION =
  "Unreal Editor actions through ue-mcp. action=search finds actions by intent (query); "
  + "action=describe gives one action's parameters (category + method) or a category's actions (category alone); "
  + "action=call runs one action (category, method, args). Describe before the first call of an action. "
  + "A result may report created, existed or updated: read it rather than assuming. "
  + "A call can keep only the fields it needs with select, or drop large ones with omit: dotted paths that reach through arrays (components.name).";

/** What select and omit say about themselves, on every route. */
export const SELECT_DESCRIPTION = "call: keep only these dotted paths of the result, e.g. [\"actors.label\", \"actors.class\"]";
export const OMIT_DESCRIPTION = "call: drop these dotted paths from the result";

/** The editor tools: what the main agent and every subagent can call. */
export const EDITOR_TOOLS: Anthropic.Beta.BetaToolUnion[] = [
  {
    name: "ue_mcp",
    description: UE_MCP_DESCRIPTION,
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["search", "describe", "call"] },
        query: { type: "string", description: "search: keywords or intent" },
        category: { type: "string", description: "describe/call: the category, e.g. blueprint" },
        method: { type: "string", description: "describe/call: the action name, e.g. create" },
        args: { type: "object", description: "call: the action's parameters" },
        select: { type: "array", items: { type: "string" }, description: SELECT_DESCRIPTION },
        omit: { type: "array", items: { type: "string" }, description: OMIT_DESCRIPTION },
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
  /** The result as the transcript shows it. */
  text: string;
  /** The result as the model is given it, when that differs from text: the same answer in fewer tokens. */
  modelText?: string;
  isError: boolean;
  outcome: CallOutcome;
  touched: TouchedItem[];
  /** Paths a save action reports saved; "*" for everything. */
  saved: string[];
  /** The call changed something: an editor call whose answer reports a change, a command, a file write or edit. */
  changed?: boolean;
  /** Images the model sees with the result: an image file read, a screenshot an editor call wrote. */
  images?: ToolImage[];
}

/** What the model is given for a call: its own text when there is one, else what the transcript shows. */
export const forModel = (e: Pick<ToolExecution, "text" | "modelText">): string => e.modelText ?? e.text;

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

/** A call's select and omit, when the model gave them as lists of dotted paths. */
function fieldSelection(input: Record<string, unknown>): Record<string, string[]> {
  const paths = (v: unknown): string[] | null => (Array.isArray(v) && v.length > 0 && v.every((p) => typeof p === "string") ? (v as string[]) : null);
  const select = paths(input.select);
  const omit = paths(input.omit);
  return { ...(select ? { select } : {}), ...(omit ? { omit } : {}) };
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
    const changed = !r.isError && CHANGING_TOOLS.includes(name as LocalToolName);
    return { text: r.text, isError: r.isError, outcome: r.isError ? "error" : "done", touched: [], saved: [], ...(changed ? { changed } : {}), ...(r.images?.length ? { images: r.images } : {}) };
  }

  if (name === "editor_restart") {
    const op = input.operation as "restart" | "rebuild";
    const result = await host.editorOperation(op);
    const steps = (result.steps as OperationStep[] | undefined) ?? [];
    // Read off the payload too: a daemon up to ue-mcp 1.4.3 marks a step ok whose handler returned success: false.
    const failed = firstFailedStep(steps);
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
    const text = r.isError ? resultText(r) : compactSearch(resultText(r));
    return { text, isError: r.isError, outcome: r.isError ? "error" : "done", touched: [], saved: [] };
  }
  if (action === "describe") {
    const args = typeof input.method === "string" && input.method
      ? { name: `${input.category}.${input.method}` }
      : { name: String(input.category), category: input.category };
    const r = await host.callAction("project", "describe_action", args);
    const text = r.isError ? resultText(r) : compactDescribe(resultText(r));
    return { text, isError: r.isError, outcome: r.isError ? "error" : "done", touched: [], saved: [] };
  }

  const category = input.category as string;
  const method = input.method as string;
  // select and omit ride beside the action's own parameters: ue-mcp's dispatch takes them off before the action runs.
  const args = { ...((input.args as Record<string, unknown> | undefined) ?? {}), ...fieldSelection(input) };
  // Unknown only when the editor went away during the call. One already gone never ran it, so its error is the answer.
  const wasConnected = editorConnected(host);
  const startedAt = Date.now();
  let r: ActionResult;
  try {
    r = await host.callAction(category, method, args);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (wasConnected && !editorConnected(host)) return { text: message, isError: true, outcome: "unknown", touched: namedTargets(args), saved: [] };
    return { text: message, isError: true, outcome: "error", touched: [], saved: [] };
  }
  const text = resultText(r);
  if (r.isError && wasConnected && !editorConnected(host)) {
    return { text, isError: true, outcome: "unknown", touched: namedTargets(args), saved: [] };
  }
  const json = parseJson(text);
  const changed = !r.isError && reportsChange(json);
  const touched = changed ? namedTargets(args) : [];
  const savedHere = json?.saved === true;
  for (const t of touched) t.saved = savedHere;
  let saved: string[] = [];
  if (!r.isError && isSaveAction(method)) {
    const named = namedTargets(args).map((t) => t.path);
    saved = named.length > 0 ? named : ["*"];
  }
  const images = r.isError ? [] : await resultImages(host.projectDir, r, startedAt);
  const modelText = keepForModel(compactJson(text), () => saveResult(host.dataDir, `${category}.${method}`, text));
  return {
    text, isError: r.isError, outcome: r.isError ? "error" : "done", touched, saved,
    ...(modelText !== text ? { modelText } : {}), ...(changed ? { changed } : {}), ...(images.length ? { images } : {}),
  };
}

/**
 * The file an image path in an editor result names. Unreal reports some
 * paths relative to its own binaries folder (../../../../Users/.../Saved/x.png),
 * so a relative path is tried against the project, then from the project's
 * own folder name or its Saved folder on.
 */
export function imageOnDisk(projectDir: string, p: string): string | null {
  return imagePaths(projectDir, p).find(isFile) ?? null;
}

/** Where an image path from an editor result may be, most likely first. */
function imagePaths(projectDir: string, p: string): string[] {
  const candidates = [path.resolve(projectDir, p)];
  if (!path.isAbsolute(p)) {
    const parts = p.split(/[\\/]/);
    const lower = parts.map((x) => x.toLowerCase());
    const at = lower.lastIndexOf(path.basename(projectDir).toLowerCase());
    if (at >= 0) candidates.push(path.join(projectDir, ...parts.slice(at + 1)));
    const saved = lower.lastIndexOf("saved");
    if (saved >= 0) candidates.push(path.join(projectDir, ...parts.slice(saved)));
  }
  return candidates;
}

const isFile = (f: string): boolean => {
  try {
    return fs.statSync(f).isFile();
  } catch {
    return false;
  }
};

/** The most images one editor call hands the model. */
export const RESULT_IMAGES_MAX = 4;
/** How long a result's image may take to land on disk: the editor's renderer writes a viewport capture after the call returns. */
export const RESULT_IMAGE_WAIT_MS = 5000;

/**
 * The images an editor call produced, for the model to see: image content in
 * the result, and image files the result names that the call wrote (changed
 * since it started), such as a screenshot or a render. A file the call says
 * it wrote that is not there yet, or that it overwrote and that still has its
 * old time, is waited for briefly, since the renderer writes some captures
 * after the call returns. An image the result only mentions, written earlier,
 * is left for read_file.
 */
export async function resultImages(projectDir: string, r: ActionResult, since: number, waitMs = RESULT_IMAGE_WAIT_MS): Promise<ToolImage[]> {
  const out: ToolImage[] = [];
  for (const c of r.content as Array<{ type: string; data?: unknown; mimeType?: unknown }>) {
    if (out.length >= RESULT_IMAGES_MAX) break;
    if (c.type !== "image" || typeof c.data !== "string") continue;
    const buf = Buffer.from(c.data, "base64");
    const type = sniffImage(buf);
    if (!type) continue;
    try {
      out.push(await prepareImage(buf, type));
    } catch {
      // Not an image this can decode: the text still says what the call did.
    }
  }
  // Each image path the result names, with where it may be, and whether to wait for it.
  const named: Array<{ paths: string[]; wait: boolean }> = [];
  const seen = new Set<string>();
  const visit = (v: unknown, depth: number, overwrote: boolean): void => {
    if (named.length >= RESULT_IMAGES_MAX * 4 || depth > 5) return;
    if (typeof v === "string") {
      if (!IMAGE_EXTENSIONS[path.extname(v).toLowerCase()] || v.length > 1024) return;
      const paths = imagePaths(projectDir, v);
      const key = (paths.find(isFile) ?? paths[0]).toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      named.push({ paths, wait: overwrote || !paths.some(isFile) });
      return;
    }
    if (Array.isArray(v)) for (const x of v.slice(0, 50)) visit(x, depth + 1, overwrote);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      for (const x of Object.values(o).slice(0, 100)) visit(x, depth + 1, overwrote || o.overwrote === true);
    }
  };
  for (const c of r.content) if (c.type === "text" && c.text) visit(parseJson(c.text), 0, false);

  /** The file, once the call has written it and it has stopped growing. */
  const sizes = new Map<string, number>();
  const ready = (paths: string[]): string | null => {
    for (const f of paths) {
      let st: fs.Stats;
      try {
        st = fs.statSync(f);
      } catch {
        continue;
      }
      // Written by this call: file times can trail the clock by a moment.
      if (!st.isFile() || st.size === 0 || st.size > MAX_IMAGE_FILE_BYTES || st.mtimeMs < since - 2000) continue;
      const before = sizes.get(f);
      sizes.set(f, st.size);
      if (before === st.size) return f;
    }
    return null;
  };
  const deadline = Date.now() + waitMs;
  let pending = named;
  // The first look only notes sizes; a file is taken once its size holds between two looks.
  for (let round = 0; pending.length > 0 && out.length < RESULT_IMAGES_MAX; round++) {
    const next: typeof named = [];
    for (const n of pending) {
      const file = round === 0 ? (ready(n.paths), null) : ready(n.paths);
      if (!file) {
        next.push(n);
        continue;
      }
      const buf = fs.readFileSync(file);
      const type = sniffImage(buf);
      if (!type) continue;
      try {
        out.push(await prepareImage(buf, type, file));
      } catch {
        // As above.
      }
      if (out.length >= RESULT_IMAGES_MAX) break;
    }
    // Past the first look, only what the call is still writing is worth waiting for.
    pending = round === 0 ? next : next.filter((n) => n.wait);
    if (pending.length === 0 || Date.now() >= deadline) break;
    await new Promise((res) => setTimeout(res, round === 0 ? 50 : 200));
  }
  return out;
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

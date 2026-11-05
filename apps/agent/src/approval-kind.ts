/**
 * Which approval row a tool call falls under, if any: shell commands, file
 * changes, editor restarts, or ue-mcp actions that delete or overwrite. The
 * last reads ue-mcp's own action metadata (the daemon's actions.effects); a
 * daemon without it cannot say, and those calls do not ask.
 */
import type { ApprovalKind } from "@ue-mcp-studio/shared";
import type { ApprovalPreview } from "./local-tools.js";

/** ue-mcp's answer for one action: does it delete or overwrite? null when it cannot say. */
export interface ActionEffects {
  destructive(category: string, method: string): boolean | null;
  /** Whether the action only reads. null when it cannot say. */
  readOnly(category: string, method: string): boolean | null;
}

export const NO_EFFECTS: ActionEffects = { destructive: () => null, readOnly: () => null };

/** The editor actions that stop or restart the editor, reached through ue_mcp rather than editor_restart. */
const EDITOR_LIFECYCLE = new Set(["stop_editor", "restart_editor", "start_editor", "rebuild_editor", "rebuild"]);

/**
 * ue-mcp actions that run code on the computer: Python in the editor, console
 * commands (`py` runs Python too) and Epic's toolset scripts. They ask as
 * shell commands, never "inside the project", so the PIN lock's
 * sensitive-actions switch also guards them for a paired device.
 */
const RUNS_CODE = new Set(["execute_python", "execute_command", "epic_execute_tool_script"]);

/** Whether a ue_mcp call runs code on the computer. */
export const runsCode = (input: Record<string, unknown>): boolean => input.action === "call" && typeof input.method === "string" && RUNS_CODE.has(input.method);

/** The key a session's "Allow for this session" keeps for a kind. "edit" is what sessions stored before the rows existed. */
export const SESSION_KEY: Record<ApprovalKind, string> = { shell: "shell", files: "edit", editorRestart: "restart", destructive: "destructive" };

export function approvalKind(name: string, input: Record<string, unknown>, effects: ActionEffects): ApprovalKind | null {
  if (name === "shell") return "shell";
  if (name === "write_file" || name === "edit_file") return "files";
  if (name === "editor_restart") return "editorRestart";
  if (name === "ue_mcp" && input.action === "call" && typeof input.category === "string" && typeof input.method === "string") {
    if (input.category === "editor" && EDITOR_LIFECYCLE.has(input.method)) return "editorRestart";
    if (runsCode(input)) return "shell";
    if (effects.destructive(input.category, input.method)) return "destructive";
  }
  return null;
}

/**
 * The approval row a flow step's task falls under, by the same rules as the
 * agent's own ue_mcp calls. A task that is not category.method (a project
 * task, a nested flow) could run anything, so it asks as a shell command.
 */
export function flowStepKind(task: string, effects: ActionEffects): ApprovalKind | null {
  const m = /^([A-Za-z_][\w-]*)\.([A-Za-z_][\w-]*)$/.exec(task);
  if (!m) return "shell";
  return approvalKind("ue_mcp", flowStepCall(task), effects);
}

/** A flow step's task as the ue_mcp call the approval shows. */
export function flowStepCall(task: string): Record<string, unknown> {
  const dot = task.indexOf(".");
  return dot > 0 ? { action: "call", category: task.slice(0, dot), method: task.slice(dot + 1), args: {} } : { action: "call", category: "flow", method: task, args: {} };
}

/** What the user is shown for an editor restart or a destructive ue-mcp action. Shell and file previews are local-tools' approvalFor. */
export function editorPreview(name: string, input: Record<string, unknown>): ApprovalPreview | null {
  if (name === "editor_restart") {
    const op = input.operation === "rebuild" ? "rebuild" : "restart";
    return { tool: "editor_restart", operation: op, ...(typeof input.reason === "string" ? { reason: input.reason } : {}) };
  }
  if (name === "ue_mcp" && typeof input.category === "string" && typeof input.method === "string") {
    const args = (input.args && typeof input.args === "object" ? input.args : {}) as Record<string, unknown>;
    if (input.category === "editor" && EDITOR_LIFECYCLE.has(input.method)) {
      const op = input.method.startsWith("stop") ? "stop" : input.method.startsWith("start") ? "start" : input.method.includes("rebuild") ? "rebuild" : "restart";
      return { tool: "editor_restart", operation: op };
    }
    return { tool: "ue_mcp", call: { category: input.category, method: input.method, args } };
  }
  return null;
}

/**
 * Effects read from the daemon's actions.effects, refreshed when plugins
 * change. Every answer is null while effects() is failing.
 */
export class DaemonActionEffects implements ActionEffects {
  private map: Map<string, { destructive: boolean; read: boolean }> | null = null;

  constructor(private readonly source: () => Array<{ category: string; action: string; effect: string; destructive?: boolean }>) {}

  refresh(): void {
    try {
      this.map = new Map(this.source().map((e) => [`${e.category}.${e.action}`, { destructive: !!e.destructive, read: e.effect === "read" }]));
    } catch {
      this.map = null;
    }
  }

  private get(category: string, method: string) {
    if (!this.map) this.refresh();
    return this.map?.get(`${category}.${method}`) ?? null;
  }

  destructive(category: string, method: string): boolean | null {
    return this.get(category, method)?.destructive ?? (this.map ? false : null);
  }

  readOnly(category: string, method: string): boolean | null {
    const e = this.get(category, method);
    return e ? e.read : null;
  }
}

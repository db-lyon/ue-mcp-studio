/**
 * The editor's state as a client shows it, with no UI: a restart, rebuild,
 * start or stop the daemon runs, a ue-mcp call that keeps the editor busy, or
 * the editor not running; and the words each is said in, in full and as the
 * narrow top bar's chip.
 */
import type { BusyCall, BusyState, EditorOperation, EditorOperationFailure } from "@ue-mcp-studio/shared";

/** A call shorter than this is the editor working normally, not busy. */
export const BUSY_AFTER_MS = 1000;

export type EditorOp = EditorOperation["op"];
export const EDITOR_OPS: readonly EditorOp[] = ["start", "stop", "restart", "rebuild"];

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const two = (n: number) => String(n).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}` : `${Math.floor(s / 60)}:${two(s % 60)}`;
}

export const callLabel = (c: Pick<BusyCall, "category" | "action">): string => `${c.category}(${c.action})`;

export const OPERATION: Record<EditorOp, string> = {
  rebuild: "Rebuilding the project",
  restart: "Restarting the editor",
  start: "Starting the editor",
  stop: "Stopping the editor",
};
const STEP: Record<string, string> = {
  "editor.stop_editor": "closing the editor",
  "project.build": "building the C++",
  "editor.start_editor": "starting the editor",
  "editor.restart_editor": "restarting the editor",
  connect: "waiting for the editor to connect",
};

/** "Rebuilding the project: building the C++ (step 2 of 3)". */
export function operationLine(o: Pick<EditorOperation, "op" | "step">): { title: string; step: string } {
  const steps = o.op === "rebuild" ? ["editor.stop_editor", "project.build", "editor.start_editor"] : [];
  const n = steps.indexOf(o.step);
  return { title: OPERATION[o.op], step: `${STEP[o.step] ?? o.step}${n >= 0 ? ` (step ${n + 1} of ${steps.length})` : ""}` };
}

const FAILED: Record<EditorOp, string> = {
  rebuild: "The rebuild did not bring the editor back",
  restart: "The restart did not bring the editor back",
  start: "The editor did not start",
  stop: "The editor did not stop",
};

/** "The rebuild did not bring the editor back (building the C++)". */
export function failureLine(f: Pick<EditorOperationFailure, "op" | "step">): string {
  return `${FAILED[f.op]} (${STEP[f.step] ?? f.step})`;
}

/** Whether a step of POST /v1/editor/:op failed, as the daemon marked it. */
export function stepFailed(s: { ok: boolean; result?: string }): boolean {
  return !s.ok;
}

/** The steps POST /v1/editor/:op answered with. */
export function editorSteps(r: Record<string, unknown> | null | undefined): Array<{ step: string; ok: boolean; result?: string }> {
  const steps = r?.steps;
  return Array.isArray(steps) ? (steps as Array<{ step: string; ok: boolean; result?: string }>) : [];
}

/** "start: ok, connect: failed": what an editor operation did, as Diagnostics says it. */
export const stepsLine = (r: Record<string, unknown>): string => editorSteps(r).map((s) => `${s.step}: ${s.ok ? "ok" : "failed"}`).join(", ");

/** The busy state as a client keeps it: the daemon's, with the offset from this clock to the daemon's. */
export interface BusyView {
  calls: BusyCall[];
  operation: EditorOperation | null;
  failure: EditorOperationFailure | null;
  offset: number;
}

export const NO_BUSY: BusyView = { calls: [], operation: null, failure: null, offset: 0 };

export const busyView = (s: BusyState, now = Date.now()): BusyView => ({ calls: s.calls ?? [], operation: s.operation ?? null, failure: s.failure ?? null, offset: s.now - now });

/** One editor as GET /v1/health lists it. */
export interface HealthEditor {
  name: string;
  connected: boolean;
  port?: number;
  pid?: number | null;
  lastDisconnect?: { cause: string; at: string } | null;
}

/** The editors in a health answer, whatever its shape. */
export function healthEditors(health: unknown): HealthEditor[] {
  const list = (health as { editors?: unknown } | null | undefined)?.editors;
  return Array.isArray(list) ? list.filter((e): e is HealthEditor => !!e && typeof e === "object" && typeof (e as HealthEditor).name === "string") : [];
}

/** Why an editor's connection dropped, in words. */
export const DISCONNECT_CAUSE: Record<string, string> = {
  closed: "closed normally",
  crashed: "crashed",
  restarting: "restarting",
  rebuild: "rebuilding",
  unknown: "connection dropped",
};

/**
 * What the editor banner shows, or null for nothing: an operation, a busy
 * call, or the editor not running. `now` is the daemon's clock.
 */
export type EditorBannerState =
  | { kind: "operation"; title: string; step: string; elapsed: string; chip: string }
  | { kind: "busy"; stopped: boolean; stoppable: boolean; call: string; more: number; client: string | null; elapsed: string; chip: string }
  | { kind: "off"; failure: EditorOperationFailure | null; title: string };

export function editorBanner(busy: BusyView, o: { now: number; streaming: boolean; healthKnown: boolean; connected: boolean }): EditorBannerState | null {
  // A restart or rebuild the daemon runs: the editor is meant to be down, so no Start.
  if (busy.operation) {
    const line = operationLine(busy.operation);
    const elapsed = formatElapsed(o.now - busy.operation.startedAt);
    return { kind: "operation", title: line.title, step: line.step, elapsed, chip: `${OPERATION[busy.operation.op].split(" ")[0]} ${elapsed}` };
  }
  const oldest = busy.calls[0];
  if (oldest && o.now - oldest.startedAt >= BUSY_AFTER_MS) {
    const ours = busy.calls.filter((c) => c.source === "studio");
    const stoppable = ours.some((c) => !c.stopped);
    const stopped = ours.length > 0 && !stoppable;
    const elapsed = formatElapsed(o.now - oldest.startedAt);
    return {
      kind: "busy",
      stopped,
      stoppable,
      call: callLabel(oldest),
      more: busy.calls.length - 1,
      client: oldest.source === "client" && oldest.client ? oldest.client : null,
      elapsed,
      chip: `${stopped ? "Stopping" : "Editor busy"} ${elapsed}`,
    };
  }
  if (o.streaming && o.healthKnown && !o.connected) {
    return { kind: "off", failure: busy.failure, title: busy.failure ? `${failureLine(busy.failure)}.` : "Editor not running" };
  }
  return null;
}

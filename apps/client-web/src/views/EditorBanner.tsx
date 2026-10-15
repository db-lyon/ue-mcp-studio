/**
 * The editor's state above every view: stopping, building or starting for
 * a restart or rebuild, step by step with a timer; busy with a ue-mcp call
 * (its game thread blocked), with a timer and a Stop for the turns waiting
 * on it; or not running, with a Start. The busy state comes from the daemon, which
 * knows the calls in flight without asking the editor, so it shows while the
 * editor cannot answer.
 */
import { useEffect, useState } from "react";
import type { BusyCall, BusyState, EditorOperation, EditorOperationFailure } from "@ue-mcp-studio/shared";
import { api } from "../api";
import type { DaemonState } from "../state";

/** A call shorter than this is the editor working normally, not busy. */
export const BUSY_AFTER_MS = 1000;

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const two = (n: number) => String(n).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}` : `${Math.floor(s / 60)}:${two(s % 60)}`;
}

export const callLabel = (c: Pick<BusyCall, "category" | "action">): string => `${c.category}(${c.action})`;

const OPERATION: Record<EditorOperation["op"], string> = {
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

const FAILED: Record<EditorOperation["op"], string> = {
  rebuild: "The rebuild did not bring the editor back",
  restart: "The restart did not bring the editor back",
  start: "The editor did not start",
  stop: "The editor did not stop",
};

/** "The rebuild did not bring the editor back (building the C++)". */
export function failureLine(f: Pick<EditorOperationFailure, "op" | "step">): string {
  return `${FAILED[f.op]} (${STEP[f.step] ?? f.step})`;
}

/** Whether a step of POST /v1/editor/:op failed, also when an older daemon marked it ok over a success: false payload. */
export function stepFailed(s: { ok: boolean; result?: string }): boolean {
  return !s.ok || /^\s*\{\s*"success":\s*false/.test(s.result ?? "");
}

/** The daemon's busy state, kept current from its events, with the clock offset to its own. */
function useBusy(daemon: DaemonState): { calls: BusyCall[]; operation: EditorOperation | null; failure: EditorOperationFailure | null; now: () => number } {
  const [state, setState] = useState<{ calls: BusyCall[]; operation: EditorOperation | null; failure: EditorOperationFailure | null; offset: number }>({ calls: [], operation: null, failure: null, offset: 0 });
  const [, tick] = useState(0);
  const take = (s: BusyState) => setState({ calls: s.calls, operation: s.operation ?? null, failure: s.failure ?? null, offset: s.now - Date.now() });

  useEffect(() => {
    if (!daemon.streaming) return;
    api.busy().then(take, () => {});
  }, [daemon.streaming]);

  const last = [...daemon.events].reverse().find((e) => e.type === "studio.busy.changed");
  useEffect(() => {
    if (last) take(last.data as unknown as BusyState);
  }, [last?.id]);

  const running = state.calls.length > 0 || !!state.operation;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [running]);

  return { calls: state.calls, operation: state.operation, failure: state.failure, now: () => Date.now() + state.offset };
}

export function EditorBanner({ daemon }: { daemon: DaemonState }) {
  const { calls, operation, failure, now } = useBusy(daemon);
  const [stopping, setStopping] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A restart or rebuild the daemon runs: the editor is meant to be down, so no Start.
  if (operation) {
    const line = operationLine(operation);
    return (
      <div className="banner warn editor-banner" role="status">
        <span className="spinner small" aria-hidden />
        <span className="editor-banner-text">
          <strong>{line.title}:</strong> {line.step}
          <span className="mono elapsed">{formatElapsed(now() - operation.startedAt)}</span>
        </span>
      </div>
    );
  }

  const oldest = calls[0];
  if (oldest && now() - oldest.startedAt >= BUSY_AFTER_MS) {
    const ours = calls.filter((c) => c.source === "studio");
    const stoppable = ours.some((c) => !c.stopped);
    const stopped = ours.length > 0 && !stoppable;
    const more = calls.length - 1;
    const stop = () => {
      setStopping(true);
      api.stopBusy().then(() => setError(null), (e: Error) => setError(e.message)).finally(() => setStopping(false));
    };
    return (
      <div className="banner warn editor-banner" role="status">
        <span className="editor-banner-text">
          <strong>{stopped ? "Stopped." : "Editor busy:"}</strong>{" "}
          {stopped ? `The editor is finishing ${callLabel(oldest)}.` : callLabel(oldest)}
          {more > 0 && <span className="dim"> and {more} more</span>}
          {oldest.source === "client" && oldest.client && <span className="dim"> from {oldest.client}</span>}
          <span className="mono elapsed">{formatElapsed(now() - oldest.startedAt)}</span>
        </span>
        {stoppable && <button disabled={stopping} onClick={stop}>{stopping ? "Stopping" : "Stop"}</button>}
        {error && <span className="dim">{error}</span>}
      </div>
    );
  }

  const editor = daemon.health?.editors[0];
  if (daemon.streaming && daemon.health && !editor?.connected) {
    const start = () => {
      setStarting(true);
      setError(null);
      api.editor("start").then(
        (r) => {
          const failed = ((r.steps as Array<{ ok: boolean; result?: string }> | undefined) ?? []).find(stepFailed);
          if (failed) setError(failed.result ?? "The editor did not start.");
        },
        (e: Error) => setError(e.message),
      ).finally(() => setStarting(false));
    };
    return (
      <div className="banner warn editor-banner" role="status">
        <span className="editor-banner-text">
          <strong>{failure ? `${failureLine(failure)}.` : "Editor not running"}</strong>
          {failure && !error && <span className="dim"> {failure.reason}</span>}
          {error && <span className="dim"> {error}</span>}
        </span>
        <button className="primary" disabled={starting} onClick={start}>{starting ? "Starting" : "Start"}</button>
      </div>
    );
  }
  return null;
}

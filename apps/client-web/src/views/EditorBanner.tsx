/**
 * The editor's state above every view: stopping, building or starting for
 * a restart or rebuild, step by step with a timer; busy with a ue-mcp call
 * (its game thread blocked), with a timer and a Stop for the turns waiting
 * on it; or not running, with a Start. The busy state comes from the daemon, which
 * knows the calls in flight without asking the editor, so it shows while the
 * editor cannot answer.
 *
 * `compact` (the top bar at narrow widths) shows the same state as a chip,
 * a dot and a word or two, whose press opens the full banner under it.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { BusyCall, BusyState, EditorOperation, EditorOperationFailure } from "@ue-mcp-studio/shared";
import { editorBanner, editorSteps, stepFailed } from "@ue-mcp-studio/client-core";
import { api } from "../api";
import type { DaemonState } from "../state";

export { BUSY_AFTER_MS, callLabel, failureLine, formatElapsed, operationLine, stepFailed } from "@ue-mcp-studio/client-core";

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

export function EditorBanner({ daemon, compact = false }: { daemon: DaemonState; compact?: boolean }) {
  const { calls, operation, failure, now } = useBusy(daemon);
  const [stopping, setStopping] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open]);

  /** The banner, or in compact form a chip that opens it. */
  const frame = (chip: string, tone: "warn" | "busy", banner: ReactNode) => {
    if (!compact) return banner;
    return (
      <span ref={box} className="editor-chip-wrap">
        <button className={`chip editor-chip ${tone}`} aria-expanded={open} onClick={() => setOpen(!open)}>{chip}</button>
        {open && <div className="editor-pop">{banner}</div>}
      </span>
    );
  };

  const editor = daemon.health?.editors[0];
  const state = editorBanner({ calls, operation, failure, offset: 0 }, { now: now(), streaming: daemon.streaming, healthKnown: !!daemon.health, connected: !!editor?.connected });
  if (!state) return null;
  if (state.kind === "operation") {
    return frame(state.chip, "busy",
      <div className="banner warn editor-banner" role="status">
        <span className="spinner small" aria-hidden />
        <span className="editor-banner-text">
          <strong>{state.title}:</strong> {state.step}
          <span className="mono elapsed">{state.elapsed}</span>
        </span>
      </div>,
    );
  }
  if (state.kind === "busy") {
    const stop = () => {
      setStopping(true);
      api.stopBusy().then(() => setError(null), (e: Error) => setError(e.message)).finally(() => setStopping(false));
    };
    return frame(state.chip, "busy",
      <div className="banner warn editor-banner" role="status">
        <span className="editor-banner-text">
          <strong>{state.stopped ? "Stopped." : "Editor busy:"}</strong>{" "}
          {state.stopped ? `The editor is finishing ${state.call}.` : state.call}
          {state.more > 0 && <span className="dim"> and {state.more} more</span>}
          {state.client && <span className="dim"> from {state.client}</span>}
          <span className="mono elapsed">{state.elapsed}</span>
        </span>
        {state.stoppable && <button disabled={stopping} onClick={stop}>{stopping ? "Stopping" : "Stop"}</button>}
        {error && <span className="dim">{error}</span>}
      </div>,
    );
  }
  const start = () => {
    setStarting(true);
    setError(null);
    api.editor("start").then(
      (r) => {
        const failed = editorSteps(r).find(stepFailed);
        if (failed) setError(failed.result ?? "The editor did not start.");
      },
      (e: Error) => setError(e.message),
    ).finally(() => setStarting(false));
  };
  return frame(starting ? "Starting" : state.chip, "warn",
    <div className="banner warn editor-banner" role="status">
      <span className="editor-banner-text">
        <strong>{state.title}</strong>
        {state.failure && !error && <span className="dim"> {state.failure.reason}</span>}
        {error && <span className="dim"> {error}</span>}
      </span>
      <button className="primary" disabled={starting} onClick={start}>{starting ? "Starting" : "Start"}</button>
    </div>,
  );
}

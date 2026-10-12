/**
 * The editor's state above every view: busy with a ue-mcp call (its game
 * thread blocked), with a timer and a Stop for the turns waiting on it, or
 * not running, with a Start. The busy state comes from the daemon, which
 * knows the calls in flight without asking the editor, so it shows while the
 * editor cannot answer.
 */
import { useEffect, useState } from "react";
import type { BusyCall, BusyState } from "@ue-mcp-studio/shared";
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

/** The daemon's busy state, kept current from its events, with the clock offset to its own. */
function useBusy(daemon: DaemonState): { calls: BusyCall[]; now: () => number } {
  const [state, setState] = useState<{ calls: BusyCall[]; offset: number }>({ calls: [], offset: 0 });
  const [, tick] = useState(0);
  const take = (s: BusyState) => setState({ calls: s.calls, offset: s.now - Date.now() });

  useEffect(() => {
    if (!daemon.streaming) return;
    api.busy().then(take, () => {});
  }, [daemon.streaming]);

  const last = [...daemon.events].reverse().find((e) => e.type === "studio.busy.changed");
  useEffect(() => {
    if (last) take(last.data as unknown as BusyState);
  }, [last?.id]);

  const running = state.calls.length > 0;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [running]);

  return { calls: state.calls, now: () => Date.now() + state.offset };
}

export function EditorBanner({ daemon }: { daemon: DaemonState }) {
  const { calls, now } = useBusy(daemon);
  const [stopping, setStopping] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
          const failed = ((r.steps as Array<{ ok: boolean; result?: string }> | undefined) ?? []).find((s) => !s.ok);
          if (failed) setError(failed.result ?? "The editor did not start.");
        },
        (e: Error) => setError(e.message),
      ).finally(() => setStarting(false));
    };
    return (
      <div className="banner warn editor-banner" role="status">
        <span className="editor-banner-text"><strong>Editor not running</strong>{error && <span className="dim"> {error}</span>}</span>
        <button className="primary" disabled={starting} onClick={start}>{starting ? "Starting" : "Start"}</button>
      </div>
    );
  }
  return null;
}

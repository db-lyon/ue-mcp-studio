import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { DaemonEvent } from "ue-mcp/daemon";
import { readUpdates, type StudioUpdates, type UeMcpUpdate } from "./Updates";
import { STEP_NAME, STEP_NOTE, execute, loadRun, planRun, restartNow, saveRun, settle, waitingSteps, type UpdateRun } from "./update-run";
import { ConnectionOverlay, useConnection } from "./ConnectionOverlay";

let current: UpdateRun | null = null;
const listeners = new Set<() => void>();
const setRun = (run: UpdateRun | null): void => {
  current = run;
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** The update running now, if any. */
export const useRun = (): UpdateRun | null => useSyncExternalStore(subscribe, () => current);

/** Start an Update of every part that has something newer. */
export function startUpdate(u: { studio: StudioUpdates | null; ueMcp: UeMcpUpdate | null }): void {
  const run = planRun(u);
  if (run) void execute(run, setRun);
}

/** How long a restart may take before the panel says what to do if it never reloads. */
const SLOW_MS = 90_000;

/**
 * The whole-panel states: an update in progress, picked up again after the
 * panel reloads or the editor restarts, and the connection to ue-mcp. The
 * update screen covers a restart it caused; past that the connection shows.
 */
export function UpdateRunner({ streaming, events }: { streaming: boolean; events: DaemonEvent[] }) {
  const run = useRun();
  const resumed = useRef(false);
  const [slow, setSlow] = useState(false);

  // A run the page before this one started: settle the step it was on, then go on.
  useEffect(() => {
    if (!streaming || resumed.current) return;
    resumed.current = true;
    void loadRun().then(async (saved) => {
      if (!saved) return;
      setRun(saved);
      const next = settle(saved, await readUpdates());
      setRun(next);
      if (next.error) void saveRun(null);
      else void execute(next, setRun);
    });
  }, [streaming]);

  // The plugin step reports each stage as it goes.
  const last = events[events.length - 1];
  useEffect(() => {
    if (current && last?.type === "studio.update.progress" && typeof last.data.message === "string") setRun({ ...current, detail: last.data.message });
    // A step the agent kept for a turn to finish: it says when it starts and how it ends.
    if (last?.type === "studio.update.run") setRun((last.data.run as UpdateRun | null) ?? null);
  }, [last?.id]);

  const connection = useConnection(streaming, events, !!run);
  const escalated = ["lost", "starting", "needsYou"].includes(connection.conn.phase);
  const overlay = <ConnectionOverlay c={connection} />;

  const waitingOnRestart = !!run?.steps.some((s) => s.state === "active" && (s.key === "studio" || s.key === "restart"));
  useEffect(() => {
    setSlow(false);
    if (!waitingOnRestart) return;
    const t = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(t);
  }, [waitingOnRestart]);

  // A finished update says what is installed, then gets out of the way.
  useEffect(() => {
    if (run?.summary === undefined) return;
    const t = setTimeout(() => setRun(null), 5000);
    return () => clearTimeout(t);
  }, [run?.summary]);

  if (run && waitingSteps(run).length > 0) return <><UpdateWaiting run={run} />{overlay}</>;
  if (run && !escalated) return createPortal(<UpdateScreen run={run} slow={slow} onClose={() => setRun(null)} />, document.body);
  return overlay;
}

/** An update kept until the turn in progress finishes, with a way to install it now. */
export function UpdateWaiting({ run }: { run: UpdateRun }) {
  const [sure, setSure] = useState(false);
  const steps = waitingSteps(run);
  const restarts = steps.some((k) => k === "studio" || k === "restart");
  return (
    <div className="banner warn update-waiting" role="status">
      <span className="editor-banner-text">
        <strong>Update ready,</strong> {restarts ? "restarts" : "the editor restarts for it"} when the current turn finishes.
        {sure && <span className="dim"> Restarting now stops the turn in progress.</span>}
      </span>
      {sure && <button className="ghost" onClick={() => setSure(false)}>Cancel</button>}
      <button className={sure ? "primary" : ""} onClick={() => (sure ? void restartNow(run, setRun) : setSure(true))}>{sure ? "Restart and stop the turn" : "Restart now"}</button>
    </div>
  );
}

export function UpdateScreen({ run, slow, onClose }: { run: UpdateRun; slow: boolean; onClose: () => void }) {
  const finished = run.summary !== undefined;
  const failed = !!run.error;
  const title = failed ? "Update stopped" : finished ? "Updated" : "Updating";
  return (
    <div className="overlay" role="dialog" aria-label={title}>
      <div className="overlay-card">
        <div className="overlay-head">
          {!finished && !failed && <span className="spinner" aria-hidden />}
          {title}
        </div>
        <ol className="update-steps">
          {run.steps.map((s) => (
            <li key={s.key} className={`update-step ${s.state}`}>
              <span className="update-mark" aria-hidden>{s.state === "done" ? "✓" : s.state === "failed" ? "✕" : s.state === "active" ? "" : "○"}</span>
              {s.state === "active" && <span className="spinner small" aria-hidden />}
              <span className="update-name">{STEP_NAME[s.key]}{s.key === "ueMcp" && run.target ? ` ${run.target}` : ""}</span>
              {s.state === "active" && (
                <span className="update-note dim small">{run.detail ?? STEP_NOTE[s.key] ?? ""}</span>
              )}
            </li>
          ))}
        </ol>
        {slow && !failed && <p className="dim small">Taking longer than it should. If Studio does not reload, close its tab and open it again.</p>}
        {failed && <div className="banner bad small">{run.error}</div>}
        {finished && run.summary && <p className="muted small">{run.summary}</p>}
        {(finished || failed) && (
          <div className="row">
            <span className="spacer" />
            <button className={failed ? "" : "primary"} onClick={onClose}>{failed ? "Close" : "Done"}</button>
          </div>
        )}
      </div>
    </div>
  );
}

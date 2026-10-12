import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { DaemonEvent } from "ue-mcp/daemon";
import { readUpdates, type StudioUpdates, type UeMcpUpdate } from "./Updates";
import { STEP_NAME, STEP_NOTE, execute, loadRun, planRun, saveRun, settle, type UpdateRun } from "./update-run";

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

/** How long the stream may be down before the panel says it is reconnecting. */
const QUIET_MS = 1500;
/** How long a restart may take before the panel says what to do if it never reloads. */
const SLOW_MS = 90_000;

/**
 * The whole-panel states: an update in progress, picked up again after the
 * panel reloads or the editor restarts, and ue-mcp being away.
 */
export function UpdateRunner({ streaming, events }: { streaming: boolean; events: DaemonEvent[] }) {
  const run = useRun();
  const resumed = useRef(false);
  const [away, setAway] = useState(false);
  const [slow, setSlow] = useState(false);

  // A run the page before this one started: settle the step it was on, then go on.
  useEffect(() => {
    if (!streaming || resumed.current) return;
    resumed.current = true;
    const saved = loadRun();
    if (!saved) return;
    setRun(saved);
    void readUpdates().then((u) => {
      const next = settle(saved, u);
      setRun(next);
      if (next.error) saveRun(null);
      else void execute(next, setRun);
    });
  }, [streaming]);

  // The plugin step reports each stage as it goes.
  const last = events[events.length - 1];
  useEffect(() => {
    if (current && last?.type === "update.progress" && typeof last.data.message === "string") setRun({ ...current, detail: last.data.message });
  }, [last?.id]);

  useEffect(() => {
    if (streaming) {
      setAway(false);
      return;
    }
    const t = setTimeout(() => setAway(true), QUIET_MS);
    return () => clearTimeout(t);
  }, [streaming]);

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

  if (run) return createPortal(<UpdateScreen run={run} slow={slow} onClose={() => setRun(null)} />, document.body);
  if (away) {
    return createPortal(
      <div className="overlay" role="status">
        <div className="overlay-card">
          <div className="overlay-head"><span className="spinner" aria-hidden />Reconnecting to ue-mcp</div>
          <p className="muted small">Studio comes back on its own when ue-mcp answers again.</p>
        </div>
      </div>,
      document.body,
    );
  }
  return null;
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

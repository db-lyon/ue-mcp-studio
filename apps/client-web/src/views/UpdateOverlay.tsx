import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { DaemonEvent } from "ue-mcp/daemon";
import { readUpdates, type StudioUpdates, type UeMcpUpdate } from "./Updates";
import { STEP_NAME, STEP_NOTE, afterRunning, askBeforeUpdate, execute, loadRun, planRun, restartNow, saveRun, settle, waitingSteps, type UpdateRun } from "./update-run";
import { ConnectionOverlay, useConnection } from "./ConnectionOverlay";
import { EditorConsent } from "./EditorConsent";
import { onRemotePage } from "../connection";
import { native } from "../native";
import { api } from "../api";
import { HOLD_EXPIRED, PENDING_COPY, STUDIO_REQUESTER, UPDATE_RETRY_ON_COMPUTER, holdOf, waitingWho, type UpdateHold } from "@ue-mcp-studio/client-core";

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

/**
 * Start an Update of every part that has something newer. When a step would
 * close the editor while other sessions use it, the person is asked first,
 * before anything is downloaded.
 */
export async function startUpdate(u: { studio: StudioUpdates | null; ueMcp: UeMcpUpdate | null }, ask = askBeforeUpdate): Promise<void> {
  const run = planRun(u);
  if (!run) return;
  const request = await ask(run);
  if (!request) return execute(run, setRun);
  const held = { ...run, consent: request };
  setRun(held);
  await saveRun(held);
}

/** Update anyway on a held run: the request is approved as the person's, and the run goes on with the override. */
export async function approveHeld(run: UpdateRun, approve = (id: string) => api.approveDisruption(id, STUDIO_REQUESTER)): Promise<void> {
  if (!run.consent) return;
  try {
    await approve(run.consent.id);
  } catch (e) {
    // Already decided elsewhere: the update.consent event says how, and the run follows it.
    if (current?.consent?.id !== run.consent.id) return;
    setRun({ ...run, consent: undefined, error: (e as Error).message || "The request was not approved." });
    await saveRun(null);
    return;
  }
  await resumeHeld(run.consent.id);
}

/** The held run goes on once its request is approved, from here or from another client. */
async function resumeHeld(id: string): Promise<void> {
  const run = current;
  if (!run?.consent || run.consent.id !== id) return;
  await execute({ ...run, consent: undefined, force: true }, setRun);
}

/** Cancel on a held run: the request is denied, so the sessions stop waiting on it, and the run ends. */
export function cancelHeld(run: UpdateRun, deny = (id: string) => api.denyDisruption(id, STUDIO_REQUESTER)): void {
  if (run.consent) void deny(run.consent.id).catch(() => undefined);
  setRun(null);
  void saveRun(null);
}

/** How a held request was decided, from the update.consent event: the held run goes on, ends, or stops with why. */
export function onHoldDecided(decided: unknown, resume = resumeHeld): void {
  const run = current;
  if (!run?.consent) return;
  if (decided === "approve") void resume(run.consent.id);
  else if (decided === "deny") {
    setRun(null);
    void saveRun(null);
  } else if (decided === "expired") {
    setRun({ ...run, consent: undefined, error: HOLD_EXPIRED });
    void saveRun(null);
  }
}

/** For tests: the run as the overlay holds it. */
export const setRunForTests = setRun;

/**
 * Retry a stopped update: read what is newer now and run an Update of it,
 * which skips what already landed. Nothing newer left closes the screen.
 */
export async function retryUpdate(failed: UpdateRun, read = readUpdates, ask = askBeforeUpdate): Promise<void> {
  setRun({ ...failed, error: undefined, detail: undefined, steps: failed.steps.map((s) => (s.state === "failed" ? { ...s, state: "pending" as const } : s)) });
  try {
    const run = planRun(await read());
    setRun(run);
    if (!run) return;
    const request = await ask(run);
    if (request) {
      const held = { ...run, consent: request };
      setRun(held);
      await saveRun(held);
      return;
    }
    await execute(run, setRun);
  } catch (e) {
    setRun({ ...failed, error: (e as Error).message || failed.error });
  }
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
    // Only Studio on the computer carries an update on; a paired browser follows it through studio.update.run events.
    if (onRemotePage()) return;
    void loadRun().then(async (saved) => {
      if (!saved) return;
      if (saved.consent) {
        // A held run is picked up only while its request is still held; otherwise Update asks again.
        const still = await readHold();
        if (still?.request.id === saved.consent.id) setRun({ ...saved, consent: still.request });
        else void saveRun(null);
        return;
      }
      setRun(saved);
      const next = settle(saved, await afterRunning());
      setRun(next);
      if (next.error) void saveRun(null);
      else void execute(next, setRun);
    });
  }, [streaming]);

  // An Update the consent gate holds, kept by the agent so every client shows the same ask.
  const [hold, setHold] = useState<UpdateHold | null>(null);
  useEffect(() => {
    if (streaming) void readHold().then(setHold);
  }, [streaming]);

  // The plugin step reports each stage as it goes.
  const last = events[events.length - 1];
  useEffect(() => {
    if (current && last?.type === "studio.update.progress" && typeof last.data.message === "string") setRun({ ...current, detail: last.data.message });
    // A step the agent kept for a turn to finish: it says when it starts and how it ends.
    if (last?.type === "studio.update.run") setRun((last.data.run as UpdateRun | null) ?? null);
    if (last?.type === "studio.update.consent") {
      const next = holdOf(last.data);
      setHold(next);
      // The sessions' answers change while the person decides.
      if (next && current?.consent?.id === next.request.id) setRun({ ...current, consent: next.request });
      if (last.data.decided) onHoldDecided(last.data.decided);
    }
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

  // Hide keeps the update running; a new run, or a stop that needs a decision, shows the screen again.
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    if (!run || run.error) setHidden(false);
  }, [run === null, !!run?.error]);

  // Held on a request this page is not running: a waiting step the agent runs, or the computer's panel seen from elsewhere.
  if (hold && run?.consent?.id !== hold.request.id) return <><UpdateHeld hold={hold} />{overlay}</>;
  if (run && waitingSteps(run).length > 0) return <><UpdateWaiting run={run} />{overlay}</>;
  if (run && !escalated && hidden && !run.error && run.summary === undefined) return <><UpdateHidden run={run} onShow={() => setHidden(false)} onReload={() => window.location.reload()} />{overlay}</>;
  if (run && !escalated) return createPortal(<UpdateScreen run={run} slow={slow} onClose={() => setRun(null)} onRetry={onRemotePage() ? undefined : () => retryUpdate(run)} onHide={() => setHidden(true)} onReload={() => window.location.reload()} />, document.body);
  return overlay;
}

/** The hold the agent keeps; null when none is held, and on any error. */
async function readHold(): Promise<UpdateHold | null> {
  const res = await fetch("/v1/ext/studio/updates/consent", { credentials: "same-origin" }).catch(() => null);
  return res?.ok ? holdOf(await res.json().catch(() => null)) : null;
}

/**
 * An Update held on a request this page does not run: who holds the editor
 * and why, with Update anyway and Cancel. Whoever runs the held step goes on
 * from the answer.
 */
export function UpdateHeld({ hold, approve = (id: string) => api.approveDisruption(id, STUDIO_REQUESTER), deny = (id: string) => api.denyDisruption(id, STUDIO_REQUESTER) }: { hold: UpdateHold; approve?: (id: string) => Promise<unknown>; deny?: (id: string) => Promise<unknown> }) {
  const [error, setError] = useState<string | null>(null);
  const answer = (act: (id: string) => Promise<unknown>) => () => {
    setError(null);
    void act(hold.request.id).catch((e: Error) => setError(e.message || PENDING_COPY.notSent));
  };
  return (
    <div className="update-held">
      <EditorConsent ask={{ op: "update", request: hold.request }} onApprove={answer(approve)} onCancel={answer(deny)} />
      {error && <div className="banner bad small" role="alert">{error}</div>}
    </div>
  );
}

/** The update still runs; this is all that is left of its screen while it is hidden. */
export function UpdateHidden({ run, onShow, onReload }: { run: UpdateRun; onShow: () => void; onReload: () => void }) {
  const active = run.steps.find((s) => s.state === "active");
  return (
    <div className="banner warn update-waiting" role="status">
      <span className="editor-banner-text">
        <strong>Updating.</strong> {active ? `${STEP_NAME[active.key]}${run.detail ? `: ${run.detail}` : ""}` : "Still running."} It keeps going in the background.
      </span>
      <button className="ghost" onClick={onReload}>Reload now</button>
      <button className="primary" onClick={onShow}>Show</button>
    </div>
  );
}

/** An update kept until the turn in progress finishes, with a way to install it now. */
export function UpdateWaiting({ run }: { run: UpdateRun }) {
  const [sure, setSure] = useState(false);
  const steps = waitingSteps(run);
  const who = waitingWho(steps);
  return (
    <div className="banner warn update-waiting" role="status">
      <span className="editor-banner-text">
        <strong>Update ready.</strong> {who} once no turn is in progress.
        {sure && <span className="dim"> Restarting now stops every turn in progress.</span>}
      </span>
      {sure && <button className="ghost" onClick={() => setSure(false)}>Cancel</button>}
      <button className={sure ? "primary" : ""} onClick={() => (sure ? void restartNow(run, setRun) : setSure(true))}>{sure ? "Restart and stop turns" : "Restart now"}</button>
    </div>
  );
}

/**
 * `onRetry`: Studio on the computer runs the update again from what is still
 * newer; a paired browser has none and says the update runs on the computer.
 */
export function UpdateScreen({ run, slow, onClose, onRetry, openLog = native().openlog, onHide, onReload, onApprove, onCancel }: { run: UpdateRun; slow: boolean; onClose: () => void; onRetry?: () => void; openLog?: () => Promise<boolean>; onHide?: () => void; onReload?: () => void; onApprove?: (run: UpdateRun) => Promise<void>; onCancel?: (run: UpdateRun) => void }) {
  const finished = run.summary !== undefined;
  const failed = !!run.error;
  const held = !failed && !!run.consent;
  const title = failed ? "Update stopped" : finished ? "Updated" : held ? "Update paused" : "Updating";
  return (
    <div className="overlay" role="dialog" aria-label={title}>
      <div className="overlay-card">
        <div className="overlay-head">
          {!finished && !failed && !held && <span className="spinner" aria-hidden />}
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
        {slow && !failed && <p className="dim small">Taking longer than it should. If Studio does not reload, close Studio and open it again.</p>}
        {failed && <div className="banner bad small update-error">{run.error}</div>}
        {finished && run.summary && <p className="muted small">{run.summary}</p>}
        {failed && !onRetry && <p className="dim small">{UPDATE_RETRY_ON_COMPUTER}</p>}
        {held && run.consent && <EditorConsent ask={{ op: "update", request: run.consent }} onApprove={() => void (onApprove ?? approveHeld)(run)} onCancel={() => (onCancel ?? cancelHeld)(run)} />}
        {!finished && !failed && !held && (onHide || onReload) && (
          <div className="row">
            <span className="spacer" />
            {onReload && <button className="ghost" onClick={onReload}>Reload now</button>}
            {onHide && <button onClick={onHide}>Hide</button>}
          </div>
        )}
        {(finished || failed) && (
          <div className="row">
            {failed && onRetry && openLog && <button className="ghost" onClick={() => void openLog()}>Open log</button>}
            <span className="spacer" />
            {failed && onRetry && <button className="primary" onClick={onRetry}>Retry</button>}
            <button className={failed ? "" : "primary"} onClick={onClose}>{failed ? "Close" : "Done"}</button>
          </div>
        )}
      </div>
    </div>
  );
}

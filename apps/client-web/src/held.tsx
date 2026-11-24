/**
 * Runs holding at a manual step for the person's verdict (ue-mcp's
 * VerdictHold, which the agent runs): the list, read once and then from studio.qa.held, and
 * the app's bar that says on every tab which step waits, with its countdown
 * and actions. The playtest card reads the same list (held-context.ts).
 * Beside it, the Playtest Hub's lease bar: while the hub holds the editor,
 * every tab says so and offers Release the editor.
 */
import { useEffect, useState } from "react";
import type { EditorLease, QaHeld, QaVerdict } from "@ue-mcp-studio/shared";
import { HELD_COPY, LEASE_COPY, QA_VERDICTS, heldForBar, heldLeft, heldOfEvent, leaseOfEvent } from "@ue-mcp-studio/client-core";
import { api } from "./api";
import type { DaemonState } from "./state";
import { FailNote } from "./chat/Qa";
import { LiveButton } from "./chat/PieLive";
import type { HeldValue } from "./held-context";

/** The list as the agent has it: read when the stream comes up, then replaced by each studio.qa.held. */
export function useHeld(daemon: Pick<DaemonState, "events" | "streaming">): HeldValue {
  const [held, setHeld] = useState<QaHeld[]>([]);
  useEffect(() => {
    if (!daemon.streaming) return;
    // An older agent has no route: nothing is held then.
    api.qaHeld().then((r) => setHeld(Array.isArray(r?.held) ? r.held : []), () => setHeld([]));
  }, [daemon.streaming]);
  const last = [...daemon.events].reverse().find((e) => heldOfEvent(e) !== null);
  useEffect(() => {
    const next = last ? heldOfEvent(last) : null;
    if (next) setHeld(next);
  }, [last?.id]);
  const resume = async (runId: string) => {
    const r = await api.qaResume(runId);
    setHeld((list) => list.map((h) => (h.runId === runId ? r.held : h)));
  };
  return { held, resume };
}

/** The hub's lease as the agent has it: read when the stream comes up, then replaced by each hub.lease. */
export function useLease(daemon: Pick<DaemonState, "events" | "streaming">): EditorLease | null {
  const [lease, setLease] = useState<EditorLease | null>(null);
  useEffect(() => {
    if (!daemon.streaming) return;
    // An agent without the hub has no route: nothing is leased then.
    api.hubLease().then((r) => setLease(r?.lease ?? null), () => setLease(null));
  }, [daemon.streaming]);
  const last = [...daemon.events].reverse().find((e) => leaseOfEvent(e) !== null);
  useEffect(() => {
    const next = last ? leaseOfEvent(last) : null;
    if (next) setLease(next.lease);
  }, [last?.id]);
  return lease;
}

/** The bar while the Playtest Hub holds the editor: what it runs, and Release the editor. */
export function LeaseBar({ lease }: { lease: EditorLease | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!lease) return null;
  const release = () => {
    setBusy(true);
    setError(null);
    api.hubRelease().catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  return (
    <div className="banner lease-bar" role="region" aria-label={LEASE_COPY.holding}>
      <span className="held-text">
        <strong>{LEASE_COPY.holding}</strong>
        <span className="held-instruction">{lease.purpose}</span>
      </span>
      <span className="spacer" />
      <button className="small-button danger-button" disabled={busy} title={LEASE_COPY.releaseHelp} onClick={release}>{LEASE_COPY.release}</button>
      {error && <span className="held-error small" role="alert">{error}</span>}
    </div>
  );
}

/** Seconds tick while something counts down. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/**
 * The bar under the header while a run waits for the person's verdict: what
 * waits, the time left, Resume and watch while PIE is paused, the verdict,
 * Stop now, and the way to the card. A paired browser also gets Live.
 */
export function HeldBar({ value, onOpenCard }: { value: HeldValue; onOpenCard: (h: QaHeld) => void }) {
  const h = heldForBar(value.held);
  const now = useNow(!!h);
  const [failing, setFailing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setFailing(false);
    setError(null);
  }, [h?.runId, h?.step]);
  if (!h) return null;
  const act = (f: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    f().catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  const decide = (verdict: QaVerdict, note?: string) => act(() => api.qaVerdict(h.runId, h.step, verdict, note));
  return (
    <div className="banner warn held-bar" role="region" aria-label={HELD_COPY.waiting(h)}>
      <div className="held-line">
        <span className="held-text">
          <strong>{HELD_COPY.waiting(h)}</strong>
          <span className="held-instruction">{h.instruction}</span>
        </span>
        <span className="held-left mono" role="timer" aria-live="off">{HELD_COPY.endsIn(heldLeft(h.dueAt, now))}</span>
      </div>
      {failing ? (
        <FailNote step={h.step} initial="" onCancel={() => setFailing(false)} onSubmit={(note) => { setFailing(false); decide("fail", note); }} />
      ) : (
        <div className="held-actions">
          {h.paused && <button className="small-button" disabled={busy} title={HELD_COPY.resumeHelp} onClick={() => act(() => value.resume(h.runId))}>{HELD_COPY.resume}</button>}
          <span className="qa-verdict">
            {QA_VERDICTS.map((v) => (
              <button key={v.verdict} className={`small-button verdict-${v.verdict}`} disabled={busy} onClick={() => (v.verdict === "fail" ? setFailing(true) : decide(v.verdict))}>{v.label}</button>
            ))}
          </span>
          <span className="spacer" />
          <LiveButton check={h.scriptName} />
          {h.sessionId && <button className="ghost small-button" onClick={() => onOpenCard(h)}>{HELD_COPY.openCard}</button>}
          <button className="small-button danger-button" disabled={busy} title={HELD_COPY.stopNowHelp} onClick={() => act(() => api.qaStop(h.runId))}>{HELD_COPY.stopNow}</button>
        </div>
      )}
      {error && <span className="held-error small" role="alert">{error}</span>}
    </div>
  );
}

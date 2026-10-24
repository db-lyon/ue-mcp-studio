/**
 * A PIE test script run as a checklist card: each step's instruction, whether
 * the observer or a person judges it, its live status, and Pass, Fail and Skip
 * on the manual steps. The card starts from the run Studio saved and applies
 * the script.* events on the daemon's stream itself; after the stream drops it
 * reads the run again from its last seq. A verdict form ue-mcp raised for the
 * run is answered from the same buttons.
 */
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { DaemonEvent } from "ue-mcp/daemon";
import {
  qaApplyStreamEvent,
  qaEnded,
  qaMergeAnswer,
  qaSummaryOf,
  qaVerdictForm,
  type PendingForm,
  type QaRun,
  type QaStep,
  type QaVerdict,
} from "@ue-mcp-studio/shared";
import { api } from "../api";
import { native } from "../native";

/** What a card needs from the page: the daemon's stream, and the session's waiting forms. */
export interface QaLive {
  events: DaemonEvent[];
  streaming: boolean;
  forms: PendingForm[];
}
export const QaContext = createContext<QaLive | null>(null);

/** The newer of two views of a run: the higher seq, and the server's on a tie. */
export function newerRun(server: QaRun, local: QaRun): QaRun {
  if (server.runId !== local.runId) return server;
  return server.lastSeq >= local.lastSeq ? server : local;
}

/**
 * The run as it is now: the saved view, with every script.* event and every
 * studio.qa.changed for it applied as they arrive. When the stream comes back
 * after a drop, or reports a gap, the run is read again: from its last seq
 * after a drop, from the start after a gap.
 */
export function useLiveRun(run: QaRun, live: Pick<QaLive, "events" | "streaming"> | null): [QaRun, (f: (r: QaRun) => QaRun) => void] {
  const [cur, setCur] = useState(run);
  const seen = useRef(0);
  const latest = useRef(cur);
  latest.current = cur;
  useEffect(() => setCur((c) => newerRun(run, c)), [run]);

  const resync = (since?: number) => {
    void api.qaStatus(run.runId, since).then((r) => setCur((c) => qaMergeAnswer(r.run ? newerRun(r.run, c) : c, r.answer)), () => {});
  };

  const events = live?.events;
  useEffect(() => {
    if (!events) return;
    const fresh = events.filter((e) => e.id > seen.current);
    if (fresh.length === 0) return;
    seen.current = fresh[fresh.length - 1].id;
    const gap = fresh.some((e) => e.type === "gap");
    setCur((c) => {
      let next = c;
      for (const e of fresh) {
        if (e.type.startsWith("script.")) next = qaApplyStreamEvent(next, e.type, e.data);
        else if (e.type === "studio.qa.changed" && (e.data.run as QaRun | undefined)?.runId === c.runId) next = newerRun(e.data.run as QaRun, next);
      }
      return next;
    });
    if (gap && !qaEnded(latest.current.state)) resync();
  }, [events]);

  const streaming = live?.streaming;
  const was = useRef(streaming);
  useEffect(() => {
    const back = was.current === false && streaming === true;
    was.current = streaming;
    if (back && !qaEnded(latest.current.state)) resync(latest.current.lastSeq);
  }, [streaming]);

  return [cur, setCur];
}

const LABEL: Record<QaStep["status"], string> = {
  pending: "Pending",
  running: "Running",
  passed: "Passed",
  failed: "Failed",
  awaiting_verdict: "Awaiting verdict",
  skipped: "Skipped",
};

/** "Auto pass", "Auto fail", or the status as it reads for a manual step. */
export function statusLabel(s: QaStep): string {
  if (s.judge === "auto" && s.status === "passed") return "Auto pass";
  if (s.judge === "auto" && s.status === "failed") return "Auto fail";
  return LABEL[s.status];
}

const shown = (v: unknown): string => (v === null || v === undefined ? "never read" : String(v));

/** What the observer saw, for the hover on an auto step. */
export function evidenceText(s: QaStep): string {
  const e = s.evidence;
  const lines: string[] = [];
  if (s.expect) lines.push(`Expected ${s.expect.value} ${s.expect.op}${s.expect.target !== undefined ? ` ${s.expect.target}` : ""}${s.withinMs ? ` within ${s.withinMs} ms` : ""}`);
  if (e?.value !== undefined || e?.at_start !== undefined || e?.at_end !== undefined) {
    lines.push(`${e?.value ?? s.expect?.value ?? "Value"}: ${shown(e?.at_start)} at the start, ${shown(e?.at_end)} at the end${e?.samples !== undefined ? `, ${e.samples} samples` : ""}`);
  }
  if (e?.observed === false) lines.push("The observer never read the value.");
  if (e?.reason) lines.push(e.reason);
  if (s.regression) lines.push(`Passed in the source run, ${s.status} in this replay.`);
  return lines.join("\n");
}

const tone = (s: QaStep): string =>
  s.status === "passed" ? "ok" : s.status === "failed" ? "bad" : s.status === "awaiting_verdict" ? "warn" : s.status === "running" ? "run" : "";

const VERDICTS: Array<{ verdict: QaVerdict; label: string }> = [
  { verdict: "pass", label: "Pass" },
  { verdict: "fail", label: "Fail" },
  { verdict: "skip", label: "Skip" },
];

/** A run's card, wherever it is drawn: the transcript, a run started elsewhere, or a verdict form with no run on screen. */
export function QaCard({ run: saved, form: own, onDismiss }: { run: QaRun; form?: PendingForm; onDismiss?: () => void }) {
  const live = useContext(QaContext);
  const [run, setRun] = useLiveRun(saved, live);
  const [notes, setNotes] = useState<Record<number, string>>({});
  /** Verdicts picked for a form that asks about several steps, sent once each has one. */
  const [picked, setPicked] = useState<Record<number, QaVerdict>>({});
  const [sending, setSending] = useState<Record<number, QaVerdict>>({});
  const [error, setError] = useState<string | null>(null);

  const pool = own ? [own, ...(live?.forms ?? [])] : live?.forms ?? [];
  const form = pool.map((f) => ({ f, q: qaVerdictForm(f) })).find((x) => x.q && (x.f === own || x.q.runId === run.runId)) ?? null;
  const asked = new Set(form?.q?.steps ?? []);
  const waiting = run.steps.filter((s) => s.status === "awaiting_verdict");

  // Asked while the user is elsewhere: flash the window, as an editor dialog does.
  const wants = waiting.length > 0;
  useEffect(() => {
    if (wants && !document.hasFocus()) void native().drawattention?.(`A test step is waiting for your verdict: ${run.scriptName}`).catch(() => false);
  }, [wants, run.runId]);
  // A step that settled is no longer being sent.
  useEffect(() => {
    setSending((cur) => Object.fromEntries(Object.entries(cur).filter(([i]) => run.steps.find((s) => s.index === Number(i))?.status === "awaiting_verdict")));
  }, [run]);

  const answerForm = (choices: Record<number, QaVerdict>) => {
    if (!form) return;
    const content: Record<string, string> = {};
    for (const [i, v] of Object.entries(choices)) {
      content[`step_${i}`] = v;
      const note = notes[Number(i)]?.trim();
      if (note) content[`step_${i}_note`] = note;
    }
    setSending((cur) => ({ ...cur, ...choices }));
    setPicked({});
    setError(null);
    api.answerForm(form.f.id, { action: "accept", content }).catch((e: Error) => {
      setSending({});
      setError(e.message);
    });
  };

  const decide = (step: QaStep, verdict: QaVerdict) => {
    if (form && asked.has(step.index)) {
      const choices = { ...picked, [step.index]: verdict };
      if ([...asked].every((i) => choices[i] || run.steps.find((s) => s.index === i)?.status !== "awaiting_verdict")) answerForm(choices);
      else setPicked(choices);
      return;
    }
    setSending((cur) => ({ ...cur, [step.index]: verdict }));
    setError(null);
    const note = notes[step.index]?.trim();
    api.qaVerdict(run.runId, step.index, verdict, note || undefined).then((r) => setRun((c) => newerRun(r.run, c)), (e: Error) => {
      setSending((cur) => {
        const { [step.index]: _gone, ...rest } = cur;
        return rest;
      });
      setError(e.message);
    });
  };

  const ended = qaEnded(run.state);
  const sum = run.summary ?? qaSummaryOf(run.steps);
  const settled = sum.total - sum.pending;
  const partial = Object.keys(picked).length > 0;

  return (
    <div className={`qa-card card state-${run.state}`} role="group" aria-label={`Test script ${run.scriptName}`}>
      <div className="qa-head">
        <span className="eyebrow">{run.replayOf ? "Test script replay" : "Test script"}</span>
        <strong className="qa-title">{run.scriptName}</strong>
        {run.subagent && <span className="dim small">run by {run.subagent}</span>}
        <span className="spacer" />
        <span className={`pill ${ended ? (sum.failed ? "bad" : "ok") : waiting.length ? "warn" : ""}`} role="status">
          {ended ? (run.state === "stopped" ? "Stopped" : "Finished") : waiting.length ? "Waiting for you" : run.state === "armed" ? "Starting" : `Running, ${settled} of ${sum.total}`}
        </span>
        {onDismiss && ended && <button className="ghost small-button" aria-label="Dismiss this run" onClick={onDismiss}>Dismiss</button>}
      </div>
      <ol className="qa-steps">
        {run.steps.map((s) => {
          const evidence = s.judge === "auto" ? evidenceText(s) : "";
          const verdictable = s.judge === "manual" && s.status === "awaiting_verdict";
          const busy = sending[s.index];
          return (
            <li key={s.index} className={`qa-step ${tone(s)}`} data-status={s.status}>
              <div className="qa-step-row">
                <span className="qa-num mono dim">{s.index + 1}</span>
                <span className="qa-instruction">{s.instruction}</span>
                <span className={`qa-judge mono small ${s.judge}`}>{s.judge}</span>
                <span className={`qa-status small ${tone(s)}`} title={evidence || undefined} tabIndex={evidence ? 0 : undefined} aria-label={evidence ? `${statusLabel(s)}. ${evidence.replace(/\n/g, ". ")}` : undefined}>
                  {statusLabel(s)}
                </span>
              </div>
              {s.expect && <div className="qa-expect mono dim small">{s.expect.value} {s.expect.op}{s.expect.target !== undefined ? ` ${s.expect.target}` : ""}{s.withinMs ? `, within ${s.withinMs} ms` : ""}</div>}
              {s.status === "failed" && s.judge === "auto" && evidence && <div className="qa-evidence small" role="note">{evidence.split("\n").slice(1).join(" ") || evidence}</div>}
              {s.note && !verdictable && <div className="qa-note small">{s.note}</div>}
              {verdictable && (
                <div className="qa-verdict">
                  <input
                    className="qa-note-input"
                    aria-label={`Note for step ${s.index + 1}`}
                    placeholder="Note (optional): what you saw"
                    value={notes[s.index] ?? ""}
                    disabled={!!busy}
                    onChange={(e) => setNotes({ ...notes, [s.index]: e.target.value })}
                  />
                  {VERDICTS.map((v) => (
                    <button
                      key={v.verdict}
                      className={`small-button verdict-${v.verdict} ${picked[s.index] === v.verdict || busy === v.verdict ? "picked" : ""}`}
                      aria-pressed={picked[s.index] === v.verdict}
                      aria-label={`${v.label} step ${s.index + 1}`}
                      disabled={!!busy}
                      onClick={() => decide(s, v.verdict)}
                    >
                      {v.label}
                    </button>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {partial && form && (
        <div className="row">
          <span className="dim small">Pick the rest, or send these now; the others then wait on this card.</span>
          <span className="spacer" />
          <button className="primary small-button" onClick={() => answerForm(picked)}>Send verdicts</button>
        </div>
      )}
      {error && <div className="banner bad small">{error}</div>}
      {ended && (
        <div className="qa-summary small" role="status">
          <span>
            {run.state === "stopped" ? "Stopped" : "Finished"}: {sum.passed} passed, {sum.failed} failed, {sum.skipped} skipped
            {sum.pending ? `, ${sum.pending} not settled` : ""}{sum.regressions ? `, ${sum.regressions} regressed` : ""}.
          </span>
          {run.resultsPath && (
            <a href={api.qaResultsUrl(run.runId)} target="_blank" rel="noreferrer" title={run.resultsPath}>results.json</a>
          )}
        </div>
      )}
    </div>
  );
}

/** A verdict form whose run has no card on screen: the steps it asks about, as a card of their own. */
export function qaRunFromForm(form: PendingForm): QaRun | null {
  const q = qaVerdictForm(form);
  if (!q) return null;
  const steps: QaStep[] = q.steps.map((index) => {
    const f = form.fields[`step_${index}`] as { description?: string; title?: string } | undefined;
    return { index, instruction: f?.description ?? f?.title ?? `Step ${index + 1}`, judge: "manual", status: "awaiting_verdict" };
  });
  const script = /^Test script (\S+)/.exec(form.message)?.[1] ?? "inline";
  return {
    runId: q.runId ?? form.id,
    script,
    scriptName: script.split("/").pop() || script,
    state: "awaiting_verdict",
    steps,
    awaiting: q.steps,
    lastSeq: 0,
    summary: qaSummaryOf(steps),
    resultsPath: null,
    sessionId: form.sessionId,
    toolUseId: null,
    seenAt: form.at,
  };
}

/** The runs started outside Studio's sessions, kept current from studio.qa.changed. */
export function useOutsideRuns(events: DaemonEvent[], streaming: boolean): { runs: QaRun[]; dismiss: (runId: string) => void } {
  const [runs, setRuns] = useState<QaRun[]>([]);
  const last = [...events].reverse().find((e) => e.type === "studio.qa.changed" && !(e.data.run as QaRun | undefined)?.sessionId);
  useEffect(() => {
    if (!streaming) return;
    // An older Studio agent has no route; nothing shows then.
    api.qaRuns().then((r) => setRuns(Array.isArray(r?.runs) ? r.runs : []), () => setRuns([]));
  }, [streaming, last?.id]);
  const dismiss = (runId: string) => {
    setRuns((cur) => cur.filter((r) => r.runId !== runId));
    void api.qaDismiss(runId).catch(() => {});
  };
  return { runs, dismiss };
}

/** Runs another client started, shown in whichever session is open. */
export function OutsideRuns({ runs, onDismiss }: { runs: QaRun[]; onDismiss: (runId: string) => void }) {
  if (runs.length === 0) return null;
  return (
    <div className="approvals qa-outside" role="region" aria-label="Test script runs">
      {runs.map((r) => <QaCard key={r.runId} run={r} onDismiss={() => onDismiss(r.runId)} />)}
    </div>
  );
}

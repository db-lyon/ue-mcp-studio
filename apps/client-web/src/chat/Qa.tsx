/**
 * A playtest: a PIE test script run as a card of named steps, each with whether
 * the observer or a person judges it, its live status, and Pass, Fail and Skip
 * on the manual steps. The card starts from the run Studio saved and applies
 * the script.* events on the daemon's stream itself; after the stream drops it
 * reads the run again from its last seq. A verdict form ue-mcp raised for the
 * run is answered from the same buttons. Assign to subagent hands the playtest
 * to a subagent that drives PIE and judges the manual steps it may judge; its
 * verdicts carry an Agent badge and its evidence, and one click overrides each.
 *
 * Collapsed, the card is its title, its state, its primary action, a path of
 * one bar per step and a line of what happened. The primary action is Start
 * Playtest on a draft or a manual run, and the waiting step's Pass, Fail and
 * Skip while one waits. A bar opens the full card on its step; the title or
 * the line opens it at the top.
 */
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { DaemonEvent } from "ue-mcp/daemon";
import {
  qaAgentMayJudge,
  qaAgentVerdict,
  qaApplyStreamEvent,
  qaAssignable,
  qaEnded,
  qaIsDraft,
  qaMergeAnswer,
  qaSummaryOf,
  qaVerdictForm,
  type PendingForm,
  type QaRun,
  type QaStep,
  type QaVerdict,
} from "@ue-mcp-studio/shared";
import { api } from "../api";
import { DEFAULT_RUN, DraftEditor, RunPanel, playersNeeded, type RunOptions } from "./PlaytestDraft";
import { LoopPanel, loopPill } from "./PlaytestLoop";
import { native } from "../native";

/** What a card needs from the page: the daemon's stream, and the session's waiting forms. */
export interface QaLive {
  events: DaemonEvent[];
  streaming: boolean;
  forms: PendingForm[];
  /** The session on screen, where a subagent for a run started elsewhere runs. */
  sessionId?: string | null;
  /** Open a subagent's thread, by its agent call id. */
  onThread?: (callId: string) => void;
}
export const QaContext = createContext<QaLive | null>(null);

/** The newer of two views of a run: the higher seq, and the server's on a tie. */
export function newerRun(server: QaRun, local: QaRun): QaRun {
  if (server.runId !== local.runId) return server;
  if (server.lastSeq >= local.lastSeq) return server;
  // The steps from the newer events, the subagent as the agent last saved it.
  return server.assignment ? { ...local, assignment: server.assignment } : local;
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
        // A draft's run took its card: the card goes live.
        else if (e.type === "studio.qa.changed" && e.data.replaces === c.runId && e.data.run) next = e.data.run as QaRun;
      }
      return next;
    });
    if (gap && !qaEnded(latest.current.state) && !qaIsDraft(latest.current)) resync();
  }, [events]);

  const streaming = live?.streaming;
  const was = useRef(streaming);
  useEffect(() => {
    const back = was.current === false && streaming === true;
    was.current = streaming;
    if (back && !qaEnded(latest.current.state) && !qaIsDraft(latest.current)) resync(latest.current.lastSeq);
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

/** What the agent saw for a verdict it gave, for the hover and the expanded view. */
export function agentEvidenceText(s: QaStep): string {
  const note = s.evidence?.note ?? s.note;
  const lines: string[] = [];
  if (note) lines.push(note);
  for (const c of s.evidence?.captures ?? []) lines.push(c);
  return lines.join("\n") || "The agent gave no evidence.";
}

/** The verdict a settled step holds. */
const verdictOf = (s: QaStep): QaVerdict | null => (s.status === "passed" ? "pass" : s.status === "failed" ? "fail" : s.status === "skipped" ? "skip" : null);

const tone = (s: QaStep): string =>
  s.status === "passed" ? "ok" : s.status === "failed" ? "bad" : s.status === "awaiting_verdict" ? "warn" : s.status === "running" ? "run" : "";

/** One line for the collapsed card: how many steps, and where they stand. */
export function pathSummary(run: QaRun, sum: ReturnType<typeof qaSummaryOf>): string {
  const steps = `${run.steps.length} step${run.steps.length === 1 ? "" : "s"}`;
  if (qaIsDraft(run)) {
    const manual = run.steps.filter((s) => s.judge === "manual").length;
    return manual ? `${steps}, ${manual} judged by a person` : `${steps}, all checked by the observer`;
  }
  const waiting = run.steps.filter((s) => s.status === "awaiting_verdict").length;
  const parts = [
    sum.passed && `${sum.passed} passed`,
    sum.failed && `${sum.failed} failed`,
    sum.skipped && `${sum.skipped} skipped`,
    waiting && `${waiting} waiting for you`,
  ].filter(Boolean);
  return parts.length ? `${steps}: ${parts.join(", ")}` : steps;
}

/** What a step's bar says to a screen reader: its number, who judges it, and its status. */
export const stepBarLabel = (s: QaStep): string => `Step ${s.index + 1}, ${s.judge}, ${LABEL[s.status]}`;

/**
 * The collapsed card's path: a bar per step, coloured as the step's border is
 * in the full card. A manual step's bar carries a notch, so the two kinds read
 * apart without colour. With `onStep`, each bar is a button that opens the card on its step.
 */
export function StepPath({ steps, onStep }: { steps: QaStep[]; onStep?: (index: number) => void }) {
  return (
    <ol className="qa-path" aria-label="Steps">
      {steps.map((s) => {
        const cls = `qa-path-step ${tone(s)} ${s.judge} ${s.status === "skipped" ? "skipped" : ""}`;
        const title = `${s.index + 1}. ${s.instruction} (${s.judge}): ${statusLabel(s)}`;
        return (
          <li key={s.index} className={cls} data-status={s.status}>
            {onStep
              ? <button type="button" className="qa-path-hit" title={title} aria-label={stepBarLabel(s)} onClick={() => onStep(s.index)} />
              : <span className="qa-path-hit" role="img" title={title} aria-label={stepBarLabel(s)} />}
          </li>
        );
      })}
    </ol>
  );
}

const VERDICTS: Array<{ verdict: QaVerdict; label: string }> = [
  { verdict: "pass", label: "Pass" },
  { verdict: "fail", label: "Fail" },
  { verdict: "skip", label: "Skip" },
];

/** What a card drawn outside a session (the Playtests page) does instead of the session's own calls. */
export interface QaCardActions {
  /** Start Playtest, offered on an ended run too: it runs the script again. */
  start?: (o: RunOptions) => Promise<{ run: QaRun }>;
  /** Assign to subagent, for a run whose card is in no session yet. */
  assign?: () => Promise<{ run: QaRun }>;
}

/**
 * A run's card, wherever it is drawn: the transcript, the session's strip of
 * live playtests, the Playtests page, a run started elsewhere, or a verdict
 * form with no run on screen. `meta` follows the line under the path and
 * `extra` adds buttons to the head, for the page. `dense` puts the path in the
 * head row, for the strip.
 */
export function QaCard({ run: saved, form: own, onDismiss, onHide, actions: outside, meta, extra, dense = false }: {
  run: QaRun;
  form?: PendingForm;
  onDismiss?: () => void;
  /** Takes a loop that needs the user off the strip, for this viewer. */
  onHide?: () => void;
  actions?: QaCardActions;
  meta?: ReactNode;
  extra?: ReactNode;
  dense?: boolean;
}) {
  const live = useContext(QaContext);
  const [run, setRun] = useLiveRun(saved, live);
  const [notes, setNotes] = useState<Record<number, string>>({});
  /** Verdicts picked for a form that asks about several steps, sent once each has one. */
  const [picked, setPicked] = useState<Record<number, QaVerdict>>({});
  const [sending, setSending] = useState<Record<number, QaVerdict>>({});
  /** Overrides of the agent's verdicts on their way. */
  const [overriding, setOverriding] = useState<Record<number, QaVerdict>>({});
  const [assigning, setAssigning] = useState(false);
  /** A draft's open panel: Start Playtest's options, Edit, or Delete waiting for its second click. */
  const [panel, setPanel] = useState<"run" | "edit" | "delete" | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const pool = own ? [own, ...(live?.forms ?? [])] : live?.forms ?? [];
  const form = pool.map((f) => ({ f, q: qaVerdictForm(f) })).find((x) => x.q && (x.f === own || x.q.runId === run.runId)) ?? null;
  const asked = new Set(form?.q?.steps ?? []);
  const waiting = run.steps.filter((s) => s.status === "awaiting_verdict");

  // Asked while the user is elsewhere: flash the window, as an editor dialog does.
  const wants = waiting.length > 0;
  useEffect(() => {
    if (wants && !document.hasFocus()) void native().drawattention?.(`A playtest step is waiting for your verdict: ${run.scriptName}`).catch(() => false);
  }, [wants, run.runId]);
  /** The step a bar or Fail opened the card on: scrolled to, focused and marked once it is drawn. */
  const [target, setTarget] = useState<number | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const openAt = (index: number | null) => {
    setOpen(true);
    setTarget(index);
  };
  useEffect(() => {
    if (!open || target === null) return;
    const li = body.current?.querySelector<HTMLElement>(`.qa-step[data-index="${target}"]`);
    if (li) {
      li.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
      // The fail box takes focus itself; otherwise the step does.
      if (!li.querySelector("textarea")) li.focus({ preventScroll: true });
      li.classList.add("flash");
      const t = setTimeout(() => li.classList.remove("flash"), 1600);
      setTarget(null);
      return () => clearTimeout(t);
    }
    setTarget(null);
  }, [open, target]);
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

  /** A step's open "What went wrong?" box: Fail, an override to Fail, or editing a failed step's note. */
  const [failing, setFailing] = useState<{ index: number; via: "verdict" | "override" | "edit" } | null>(null);
  const closeFail = () => setFailing(null);

  const decide = (step: QaStep, verdict: QaVerdict, note?: string) => {
    if (note !== undefined) setNotes((cur) => ({ ...cur, [step.index]: note }));
    if (form && asked.has(step.index)) {
      if (note !== undefined) notes[step.index] = note;
      const choices = { ...picked, [step.index]: verdict };
      if ([...asked].every((i) => choices[i] || run.steps.find((s) => s.index === i)?.status !== "awaiting_verdict")) answerForm(choices);
      else setPicked(choices);
      return;
    }
    setSending((cur) => ({ ...cur, [step.index]: verdict }));
    setError(null);
    // A verdict on a draft answers with the manual run that took its card.
    api.qaVerdict(run.runId, step.index, verdict, note?.trim() || undefined).then((r) => setRun((c) => (r.run.runId === c.runId ? newerRun(r.run, c) : r.run)), (e: Error) => {
      setSending((cur) => {
        const { [step.index]: _gone, ...rest } = cur;
        return rest;
      });
      setError(e.message);
    });
  };

  /** One click replaces the agent's verdict with the user's. */
  const override = (step: QaStep, verdict: QaVerdict, note?: string) => {
    setOverriding((cur) => ({ ...cur, [step.index]: verdict }));
    setError(null);
    const clear = () => setOverriding((cur) => {
      const { [step.index]: _gone, ...rest } = cur;
      return rest;
    });
    api.qaVerdict(run.runId, step.index, verdict, note?.trim() || undefined).then((r) => {
      clear();
      setRun((c) => newerRun(r.run, c));
    }, (e: Error) => {
      clear();
      setError(e.message);
    });
  };

  const assignment = run.assignment;
  const assigned = assignment?.state === "running";
  const assignSession = run.sessionId ?? live?.sessionId ?? null;
  const toggleAssign = () => {
    setAssigning(true);
    setError(null);
    (assigned ? api.qaCancelAssign(run.runId) : outside?.assign && !run.sessionId ? outside.assign() : api.qaAssign(run.runId, run.sessionId ? null : assignSession))
      .then((r) => setRun((c) => (r.run.runId === c.runId ? newerRun(r.run, c) : r.run)), (e: Error) => setError(e.message))
      .finally(() => setAssigning(false));
  };

  /** A draft's Start Playtest, Edit and Delete: each answers with the card's next state. */
  const act = (call: () => Promise<{ run: QaRun }>) => {
    setWorking(true);
    setError(null);
    call().then((r) => {
      setPanel(null);
      setRun((c) => (r.run.runId === c.runId ? newerRun(r.run, c) : r.run));
    }, (e: Error) => setError(e.message)).finally(() => setWorking(false));
  };
  const start = (o: RunOptions) => act(() => (outside?.start ? outside.start(o) : api.qaRun(run.runId, o)));
  /** Start Playtest's one click: the players the steps name, PIE started, the run recorded. */
  const quickStart = () => {
    const players = playersNeeded(run);
    start({ ...DEFAULT_RUN, players, listen: players > 1 });
  };

  const draft = qaIsDraft(run);
  const ended = qaEnded(run.state);
  /** Edit, Delete and a draft's early verdicts change the script through the session that has its card. */
  const owned = !!run.sessionId;
  /**
   * Start Playtest on the card: a draft's, or the manual run a verdict on the
   * draft started, which a full run replaces. Outside a session, an ended run's
   * too, which runs the script again.
   */
  const runnable = (draft || (!!run.manual && !ended) || (!!outside?.start && ended)) && !run.deleted && !assigned && (owned || !!outside?.start);
  const canAssign = (!!assignSession || !!outside?.assign) && qaAssignable(run) && !run.deleted && assignment?.loop?.state !== "passed";
  const sum = run.summary ?? qaSummaryOf(run.steps);
  const settled = sum.total - sum.pending;
  const partial = Object.keys(picked).length > 0;
  const byAgentCount = run.steps.filter(qaAgentVerdict).length;
  const needsYouLoop = assignment?.loop?.state === "needs_you" ? assignment.loop : null;
  /** The step the collapsed card asks about: the first waiting one not yet picked or sent. */
  const ask = waiting.find((s) => s.judge === "manual" && !picked[s.index] && !sending[s.index]) ?? null;
  // A draft says so in its eyebrow; a pill names only what is not plain from it.
  const pill = draft
    ? (run.deleted ? { tone: "", text: "Deleted" } : null)
    : ended
      ? (run.state === "stopped" ? { tone: "", text: "Stopped" } : { tone: sum.failed ? "bad" : "ok", text: sum.failed ? `${sum.failed} failed` : "Passed" })
      : waiting.length
        ? { tone: "warn", text: "Waiting for you" }
        : { tone: "run", text: run.state === "armed" ? "Starting" : `Running, ${settled} of ${sum.total}` };

  const startButtons = runnable && (
    <span className="qa-start" role="group" aria-label="Start Playtest">
      <button className="primary small-button" disabled={working} onClick={quickStart}>{working ? "Starting" : ended ? "Run again" : "Start Playtest"}</button>
      <button
        className="small-button qa-start-options"
        disabled={working}
        aria-label="Start Playtest options"
        aria-expanded={open && panel === "run"}
        title="Players, listen server, PIE and recording"
        onClick={() => {
          setPanel(open && panel === "run" ? null : "run");
          setOpen(true);
        }}
      >
        <OptionsGlyph />
      </button>
    </span>
  );

  return (
    <div className={`qa-card card state-${run.state} ${needsYouLoop ? "needs-you" : ""} ${open ? "open" : "collapsed"} ${dense ? "dense" : ""}`} role="group" aria-label={`Playtest ${run.scriptName}`} data-run-id={run.runId}>
      <div className="qa-head">
        <button className="qa-toggle" aria-expanded={open} aria-controls={`qa-body-${run.runId}`} onClick={() => setOpen(!open)}>
          <span className="qa-chevron" aria-hidden="true">{open ? "▾" : "▸"}</span>
          <span className="eyebrow">{draft ? "Playtest draft" : run.replayOf ? "Playtest replay" : "Playtest"}</span>
          <strong className="qa-title">{run.scriptName}</strong>
        </button>
        {run.subagent && <span className="dim small qa-by">run by {run.subagent}</span>}
        {dense && !open && run.steps.length > 0
          ? <span className="qa-head-path" title={pathSummary(run, sum)}><StepPath steps={run.steps} onStep={(i) => openAt(i)} /></span>
          : <span className="spacer" />}
        {pill && <span className={`pill ${pill.tone}`} role="status">{pill.text}</span>}
        {assignment?.loop && (() => {
          const p = loopPill(assignment.loop);
          return <span className={`pill ${p.tone}`} role="status" aria-label={`Loop: ${p.text}`}>{p.text}</span>;
        })()}
        {startButtons}
        {assigned ? (
          (open || outside) && <button className="small-button" disabled={assigning} onClick={toggleAssign} aria-label={assignment?.loop ? "Cancel the loop" : "Cancel the subagent"}>Cancel</button>
        ) : canAssign && (open || outside) && (
          <button className="small-button" disabled={assigning} onClick={toggleAssign} title="A subagent runs the playtest, fixes what fails and runs it again until every step passes, or stops and asks for you">Assign to subagent</button>
        )}
        {open && draft && owned && !run.deleted && !assigned && (
          <>
            <button className="small-button" disabled={working} aria-expanded={panel === "edit"} onClick={() => setPanel(panel === "edit" ? null : "edit")}>Edit</button>
            {panel === "delete" ? (
              <button className="danger-button small-button" disabled={working} onClick={() => act(() => api.qaDeleteScript(run.runId))}>Delete the script</button>
            ) : (
              <button className="ghost small-button" disabled={working} onClick={() => setPanel("delete")}>Delete</button>
            )}
          </>
        )}
        {extra}
        {onDismiss && ended && <button className="ghost small-button" aria-label="Dismiss this run" onClick={onDismiss}>Dismiss</button>}
        {onHide && <button className="ghost small-button qa-hide" aria-label={`Hide ${run.scriptName} from the strip`} title="Hide from the strip; the card stays in the conversation" onClick={onHide}>{"×"}</button>}
      </div>
      {!open && (!dense || ask || needsYouLoop || error) && (
        <div className="qa-compact">
          {!dense && run.steps.length > 0 && <StepPath steps={run.steps} onStep={(i) => openAt(i)} />}
          {!dense && (
            <div className="qa-compact-line small">
              <button className="qa-compact-open" aria-label={`Open playtest ${run.scriptName}`} onClick={() => openAt(null)}>
                <span className="dim qa-compact-summary">{run.steps.length ? pathSummary(run, sum) : "No steps read yet"}</span>
              </button>
              {meta && <span className="qa-meta dim">{meta}</span>}
            </div>
          )}
          {ask && (
            <div className="qa-answer" role="group" aria-label={`Step ${ask.index + 1} waits for your verdict`}>
              <span className="qa-answer-step">
                <span className="qa-num mono">{ask.index + 1}</span>
                <span className="qa-answer-text">{ask.instruction}</span>
              </span>
              <span className="qa-verdict">
                {VERDICTS.map((v) => (
                  <button
                    key={v.verdict}
                    className={`small-button verdict-${v.verdict}`}
                    aria-label={`${v.label} step ${ask.index + 1}`}
                    onClick={() => {
                      if (v.verdict !== "fail") return decide(ask, v.verdict);
                      setFailing({ index: ask.index, via: "verdict" });
                      openAt(ask.index);
                    }}
                  >
                    {v.label}
                  </button>
                ))}
                {waiting.length > 1 && <button className="ghost small-button" onClick={() => openAt(ask.index)}>{waiting.length - 1} more</button>}
              </span>
            </div>
          )}
          {!ask && needsYouLoop && (
            <div className="qa-answer needs" role="group" aria-label="The loop needs you">
              <span className="qa-answer-text">{needsYouLoop.blocker?.reason ?? "The loop stopped and needs you."}</span>
              <button className="small-button" onClick={() => openAt(null)}>Review</button>
            </div>
          )}
          {error && <div className="banner bad small">{error}</div>}
        </div>
      )}
      {open && meta && <div className="qa-meta small dim">{meta}</div>}
      {open && <div className="qa-body" id={`qa-body-${run.runId}`} ref={body}>
      {draft && <div className="dim small mono qa-script-path">{run.script}</div>}
      {panel === "run" && runnable && <RunPanel run={run} busy={working} onStart={start} onCancel={() => setPanel(null)} />}
      {panel === "delete" && <div className="small dim">Deleting removes the script asset. <button className="ghost small-button" onClick={() => setPanel(null)}>Keep it</button></div>}
      {assignment?.loop && (
        <LoopPanel
          loop={assignment.loop}
          busy={working}
          onRevert={(n) => act(() => api.qaRevertLoop(run.runId, n))}
          onThread={live?.onThread}
        />
      )}
      {assignment && !assignment.loop && (
        <div className="qa-assignment small" role="status">
          <span className={assigned ? "qa-assignment-live" : "dim"}>
            {assigned ? "A subagent is running this playtest." : assignment.state === "done" ? "A subagent ran this playtest." : assignment.state === "stopped" ? "The subagent was stopped." : "The subagent failed."}
          </span>
          {live?.onThread && <button className="ghost small-button" onClick={() => live.onThread!(assignment.callId)}>Open its thread</button>}
        </div>
      )}
      {panel === "edit" && draft ? (
        <DraftEditor run={run} busy={working} onSave={(steps) => act(() => api.qaSaveScript(run.runId, steps))} onCancel={() => setPanel(null)} />
      ) : (
      <ol className="qa-steps">
        {run.steps.map((s) => {
          const evidence = s.judge === "auto" ? evidenceText(s) : "";
          // A draft's manual steps take a verdict before Start Playtest: the first one starts the manual run.
          const verdictable = s.judge === "manual" && (s.status === "awaiting_verdict" || (draft && owned && !run.deleted && !assigned));
          const unchecked = s.judge === "auto" && (draft || (!!run.manual && s.status === "pending"));
          const failBox = failing?.index === s.index ? failing : null;
          const busy = sending[s.index];
          const byAgent = qaAgentVerdict(s);
          const why = byAgent ? agentEvidenceText(s) : "";
          return (
            <li key={s.index} className={`qa-step ${tone(s)} ${s.judge}`} data-status={s.status} data-index={s.index} tabIndex={-1}>
              <div className="qa-step-row">
                <span className="qa-num mono dim">{s.index + 1}</span>
                <span className="qa-instruction">{s.instruction}</span>
                {s.player && <span className="qa-player mono small" title="The player this step is for">{s.player}</span>}
                <span className={`qa-judge mono small ${s.judge}`}>{s.judge}</span>
                {s.judge === "manual" && !qaAgentMayJudge(s) && <span className="qa-judge mono small" title="Only a person gives this step's verdict">yours</span>}
                {byAgent && <span className="qa-badge agent small" title={why} tabIndex={0} aria-label={`Judged by the agent. ${why.replace(/\n/g, ". ")}`}>Agent</span>}
                {unchecked ? <span className="qa-status small dim">Not checked: click Start Playtest</span>
                  : !draft && <span className={`qa-status small ${tone(s)}`} title={evidence || undefined} tabIndex={evidence ? 0 : undefined} aria-label={evidence ? `${statusLabel(s)}. ${evidence.replace(/\n/g, ". ")}` : undefined}>
                  {statusLabel(s)}
                </span>}
              </div>
              {s.expect && <div className="qa-expect mono dim small">{s.expect.value} {s.expect.op}{s.expect.target !== undefined ? ` ${s.expect.target}` : ""}{s.withinMs ? `, within ${s.withinMs} ms` : ""}</div>}
              {s.status === "failed" && s.judge === "auto" && evidence && <div className="qa-evidence small" role="note">{evidence.split("\n").slice(1).join(" ") || evidence}</div>}
              {s.note && !verdictable && !byAgent && !failBox && (
                <div className="qa-note small">
                  {s.note}
                  {s.status === "failed" && s.judge === "manual" && (
                    <button className="ghost small-button qa-note-edit" aria-label={`Edit the note on step ${s.index + 1}`} onClick={() => setFailing({ index: s.index, via: "edit" })}>Edit</button>
                  )}
                </div>
              )}
              {byAgent && (
                <details className="qa-agent-evidence small">
                  <summary>What the agent saw</summary>
                  {(s.evidence?.note ?? s.note) && <p>{s.evidence?.note ?? s.note}</p>}
                  {(s.evidence?.captures ?? []).length > 0 && (
                    <ul className="mono">{s.evidence!.captures!.map((c) => <li key={c}>{c}</li>)}</ul>
                  )}
                </details>
              )}
              {byAgent && (
                <div className="qa-override small">
                  <span className="dim">Override:</span>
                  {VERDICTS.filter((v) => v.verdict !== verdictOf(s)).map((v) => (
                    <button
                      key={v.verdict}
                      className={`small-button verdict-${v.verdict} ${overriding[s.index] === v.verdict ? "picked" : ""}`}
                      aria-label={`Override step ${s.index + 1} with ${v.label}`}
                      disabled={!!overriding[s.index]}
                      onClick={() => (v.verdict === "fail" ? setFailing({ index: s.index, via: "override" }) : override(s, v.verdict))}
                    >
                      {v.label}
                    </button>
                  ))}
                </div>
              )}
              {verdictable && !failBox && (
                <div className="qa-verdict">
                  {VERDICTS.map((v) => (
                    <button
                      key={v.verdict}
                      className={`small-button verdict-${v.verdict} ${picked[s.index] === v.verdict || busy === v.verdict ? "picked" : ""}`}
                      aria-pressed={picked[s.index] === v.verdict}
                      aria-label={`${v.label} step ${s.index + 1}`}
                      disabled={!!busy}
                      onClick={() => (v.verdict === "fail" ? setFailing({ index: s.index, via: "verdict" }) : decide(s, v.verdict))}
                    >
                      {v.label}
                    </button>
                  ))}
                </div>
              )}
              {failBox && (
                <FailNote
                  step={s.index}
                  initial={failBox.via === "edit" ? s.note ?? "" : notes[s.index] ?? ""}
                  onCancel={closeFail}
                  onSubmit={(note) => {
                    closeFail();
                    if (failBox.via === "override") override(s, "fail", note);
                    else decide(s, "fail", note);
                  }}
                />
              )}
            </li>
          );
        })}
      </ol>
      )}
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
            {byAgentCount > 0 && ` The agent judged ${byAgentCount === 1 ? "1 step" : `${byAgentCount} steps`}.`}
          </span>
          {run.resultsPath && (
            <a href={api.qaResultsUrl(run.runId)} target="_blank" rel="noreferrer" title={run.resultsPath}>results.json</a>
          )}
        </div>
      )}
      </div>}
    </div>
  );
}

/**
 * Fail's note, under the step: focused, required, Escape cancels without
 * recording anything, Submit sends the fail with the note.
 */
export function FailNote({ step, initial, onSubmit, onCancel }: { step: number; initial: string; onSubmit: (note: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(initial);
  const ready = text.trim().length > 0;
  return (
    <form
      className="qa-fail-note"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) onSubmit(text.trim());
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <label className="small" htmlFor={`qa-fail-${step}`}>What went wrong?</label>
      <textarea id={`qa-fail-${step}`} autoFocus rows={2} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="row">
        <button type="submit" className="small-button verdict-fail" disabled={!ready}>Submit</button>
        <button type="button" className="ghost small-button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
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
    <div className="approvals qa-outside" role="region" aria-label="Playtests">
      {runs.map((r) => <QaCard key={r.runId} run={r} onDismiss={() => onDismiss(r.runId)} />)}
    </div>
  );
}

/** Start Playtest's options: three sliders. */
function OptionsGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
      <circle cx="5.5" cy="4" r="1.6" fill="var(--panel-2)" />
      <circle cx="10.5" cy="8" r="1.6" fill="var(--panel-2)" />
      <circle cx="7" cy="12" r="1.6" fill="var(--panel-2)" />
    </svg>
  );
}

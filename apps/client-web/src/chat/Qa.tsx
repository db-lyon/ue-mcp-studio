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
import { Fragment, createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
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
  type QaScriptStep,
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
  pending: "To come",
  running: "Running",
  passed: "Passed",
  failed: "Failed",
  awaiting_verdict: "Needs you",
  skipped: "Skipped",
};

/** A step's status in words, as the legend names it: a step a run that ended never reached is Not run. */
export function statusLabel(s: QaStep, ended = false): string {
  return ended && s.status === "pending" ? "Not run" : LABEL[s.status];
}

/** Who judges a step, in the words the legend and the draft's summary use. */
export const judgeLabel = (s: Pick<QaStep, "judge">): string => (s.judge === "auto" ? "Observer" : "Person");

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

/** A running run's pill: the step it is on, or how far it got when none is running. */
export function runningText(run: QaRun, settled: number, total: number): string {
  const on = run.steps.find((s) => s.status === "running");
  return on ? `Step ${on.index + 1} of ${total}: ${stepDoing(on).toLowerCase()}` : `Running, ${settled} of ${total} done`;
}

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
    waiting && `${waiting} need${waiting === 1 ? "s" : ""} you`,
    qaEnded(run.state) && sum.pending - waiting > 0 && `${sum.pending - waiting} not run`,
  ].filter(Boolean);
  return parts.length ? `${steps}: ${parts.join(", ")}` : steps;
}

/** What a step's bar says to a screen reader: its number, who judges it, and its status. */
export const stepBarLabel = (s: QaStep, ended = false): string => `Step ${s.index + 1}, ${judgeLabel(s).toLowerCase()}, ${statusLabel(s, ended)}`;

/** The legend's mark for a step: the class its bar carries. */
export function markOf(s: QaStep, ended: boolean): PathMark {
  if (ended && s.status === "pending") return "unrun";
  if (s.status === "skipped") return "skipped";
  return (tone(s) || "pending") as PathMark;
}

/**
 * The collapsed card's path: a bar per step, coloured as the step's border is
 * in the full card. A step a person judges carries a dot inside its bar, so
 * the two kinds read apart without colour. With `onStep`, each bar is a button
 * that opens the card on its step, and the bar with keyboard focus names its
 * step under the path.
 */
export function StepPath({ steps, onStep, ended = false }: { steps: QaStep[]; onStep?: (index: number) => void; ended?: boolean }) {
  const [focused, setFocused] = useState<number | null>(null);
  const on = focused === null ? null : steps.find((s) => s.index === focused) ?? null;
  return (
    <div className="qa-path-wrap">
      <ol className="qa-path" aria-label="Steps">
        {steps.map((s) => {
          const mark = markOf(s, ended);
          const cls = `qa-path-step ${tone(s)} ${s.judge} ${mark === "skipped" || mark === "unrun" ? mark : ""}`;
          const title = `${s.index + 1}. ${s.instruction} (${judgeLabel(s)}): ${statusLabel(s, ended)}`;
          return (
            <li key={s.index} className={cls} data-status={s.status}>
              {onStep
                ? <button type="button" className="qa-path-hit" title={title} aria-label={stepBarLabel(s, ended)} onClick={() => onStep(s.index)} onFocus={(e) => setFocused(e.currentTarget.matches(":focus-visible") ? s.index : null)} onBlur={() => setFocused(null)} />
                : <span className="qa-path-hit" role="img" title={title} aria-label={stepBarLabel(s, ended)} />}
            </li>
          );
        })}
      </ol>
      {on && (
        <div className="qa-path-caption small" aria-hidden="true">
          <span className="qa-num mono">{on.index + 1}</span>
          <span className="qa-path-caption-text">{on.instruction}</span>
          <span className="qa-path-caption-state">{on.judge === "auto" ? "Checked by the observer" : "Judged by a person"}: {statusLabel(on, ended)}</span>
        </div>
      )}
    </div>
  );
}

/** The words for a run that is starting, wherever it is named: the pill, the strip's line and the pointer to it. */
export const STARTING = "Starting";

/** What the strip's line says a step in progress is: the observer checks it, or the person plays it. */
export const stepDoing = (s: QaStep): string => (s.judge === "auto" ? "Observer checking" : "Play this step");

/**
 * What a card on the strip is doing when it asks nothing: the step it is on,
 * or how it ended. It holds the place the waiting step's Pass, Fail and Skip
 * take, at the same height, so a card does not jump as its run moves on.
 */
function NowLine({ run, pill, actions }: { run: QaRun; pill: string | null; actions: ReactNode }) {
  const on = run.steps.find((s) => s.status === "running");
  const sum = run.summary ?? qaSummaryOf(run.steps);
  const loop = run.assignment?.loop;
  const ended = qaEnded(run.state);
  const text = ended
    ? `${run.state === "stopped" ? "Stopped" : "Finished"}: ${sum.passed} passed, ${sum.failed} failed${sum.skipped ? `, ${sum.skipped} skipped` : ""}`
    : on ? on.instruction
    : run.state === "armed" ? "PIE is starting"
    : loop?.state === "running" ? `A subagent is on attempt ${Math.max(1, loop.attempts.length)}`
    : pill ?? "Running";
  const status = ended ? "Just ended" : on ? stepDoing(on) : run.state === "armed" ? STARTING : "Running";
  const why = on ? (on.judge === "auto" ? "The observer is reading this step's value in PIE" : "Play this step in PIE; you judge it when it ends") : undefined;
  return (
    <div className="qa-now">
      <span className="qa-answer-step" role="status" aria-label={`${status}: ${text}`}>
        {on && <span className="qa-num mono">{on.index + 1}</span>}
        <span className="qa-answer-text" title={text}>{text}</span>
      </span>
      <span className="qa-now-row">
        <span className="qa-now-status" title={why}>{status}</span>
        {actions}
      </span>
    </div>
  );
}

/** The rows an open card's body scrolls by: its steps, a loop's attempts, and every other block in it. */
function bodyRows(el: HTMLElement): HTMLElement[] {
  const rows: HTMLElement[] = [];
  const walk = (parent: Element) => {
    for (const c of Array.from(parent.children) as HTMLElement[]) {
      if (c.matches(".qa-steps, .qa-loop, .qa-attempts, .qa-needs-you, .qa-needs-you > ul")) walk(c);
      else rows.push(c);
    }
  };
  walk(el);
  return rows;
}

/** Where a row sits in its scrolling body, in the body's own coordinates. */
function rowBox(el: HTMLElement, row: HTMLElement): { top: number; bottom: number } {
  const t = row.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
  return { top: t, bottom: t + row.offsetHeight };
}

/** The height of the cue rows over and under a scrolling body, with their gaps. */
const CUES_PX = 2 * (22 + 4);

/**
 * An open card's body on the strip: sized so the strip takes at most half of
 * the panel it shares with the conversation, and cut at the end of a whole row
 * so no step or attempt is half in view. Run when the card opens, scrolls to a
 * step, or the panel or its content changes size; not on every scroll.
 */
export function fitBody(el: HTMLElement): void {
  const strip = el.closest<HTMLElement>(".playtest-strip");
  const stage = strip?.parentElement;
  if (!strip || !stage || !stage.clientHeight) return;
  const current = el.clientHeight;
  const other = strip.scrollHeight - current - Array.from(el.parentElement?.querySelectorAll<HTMLElement>(".qa-scroll-cues") ?? []).reduce((n, c) => n + c.offsetHeight + 4, 0);
  // A few pixels spare for the gaps the cue rows bring with them.
  const avail = Math.floor(stage.clientHeight / 2) - other - 12;
  if (el.scrollHeight <= avail) {
    el.style.height = "";
    return;
  }
  const cap = Math.max(60, avail - CUES_PX);
  // From the first row that starts in view: as many whole rows as fit, and that row at the top.
  const boxes = bodyRows(el).map((r) => rowBox(el, r));
  const start = boxes.find((b) => b.top >= el.scrollTop - 1)?.top ?? el.scrollTop;
  let fit = 0;
  for (const b of boxes) if (b.top >= start - 1 && b.bottom - start <= cap) fit = Math.max(fit, b.bottom - start);
  el.style.height = `${Math.round(fit > 0 ? fit : cap)}px`;
  el.scrollTop = start;
}

/**
 * An open card's body on the strip scrolls inside it: whether rows are out of
 * view above and below. `overflow` is whether it scrolls at all, so the rows
 * that say so keep their place while it does.
 */
function useScrollCues(body: RefObject<HTMLDivElement>, on: boolean): { overflow: boolean; moreAbove: boolean; moreBelow: boolean; by: (dir: 1 | -1) => void } {
  const [hidden, setHidden] = useState({ overflow: false, moreAbove: false, moreBelow: false });
  useLayoutEffect(() => {
    const el = body.current;
    if (!on || !el) return;
    const measure = () => {
      const top = el.scrollTop;
      const bottom = top + el.clientHeight;
      let moreAbove = false;
      let moreBelow = false;
      for (const r of bodyRows(el)) {
        const b = rowBox(el, r);
        if (b.top < top - 2) moreAbove = true;
        if (b.bottom > bottom + 2) moreBelow = true;
      }
      const overflow = el.scrollHeight > el.clientHeight + 2;
      setHidden((cur) => (cur.overflow === overflow && cur.moreAbove === moreAbove && cur.moreBelow === moreBelow ? cur : { overflow, moreAbove, moreBelow }));
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      ro?.disconnect();
    };
  });
  // A page down that lands on a row's top: the body snaps to rows.
  const by = (dir: 1 | -1) => body.current?.scrollBy?.({ top: dir * Math.max(40, body.current.clientHeight * 0.8), behavior: "smooth" });
  return { ...hidden, by };
}

/** One of the rows over and under a scrolling body: whether more is that way, which scrolls to it. */
function ScrollCue({ dir, more, onClick }: { dir: "above" | "below"; more: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`qa-scroll-cue ${dir}`} disabled={!more} aria-hidden={!more} tabIndex={more ? undefined : -1} onClick={onClick}>
      {more ? `${dir === "above" ? "▴" : "▾"} More ${dir}` : " "}
    </button>
  );
}

export type PathMark = "ok" | "bad" | "warn" | "run" | "pending" | "skipped" | "unrun";
/** Every mark a path can carry, in the legend's order, with what it means. */
const MARKS: Array<[PathMark, string]> = [
  ["ok", "Passed"],
  ["bad", "Failed"],
  ["warn", "Needs you"],
  ["run", "Running"],
  ["pending", "To come"],
  ["skipped", "Skipped: passed over, not judged"],
  ["unrun", "Not run: the run ended first"],
];

/** The marks a set of runs' paths carry, and whether any step is a person's to judge. */
export function marksOf(runs: QaRun[]): { marks: Set<PathMark>; person: boolean } {
  const marks = new Set<PathMark>();
  let person = false;
  for (const r of runs) {
    const ended = qaEnded(r.state);
    for (const s of r.steps) {
      marks.add(markOf(s, ended));
      if (s.judge === "manual") person = true;
    }
  }
  return { marks, person };
}

/** What the step path's marks mean: only the ones on screen. */
export function PathLegend({ runs }: { runs: QaRun[] }) {
  const { marks, person } = marksOf(runs);
  if (marks.size === 0) return null;
  return (
    <div className="qa-legend small" role="group" aria-label="What the step marks mean">
      {MARKS.filter(([m]) => marks.has(m)).map(([m, label]) => (
        <span key={m} className="qa-legend-item"><span className={`qa-legend-mark ${m}`} aria-hidden="true" />{label}</span>
      ))}
      {person && <span className="qa-legend-item"><span className="qa-legend-mark pending person" aria-hidden="true" />Judged by a person</span>}
    </div>
  );
}

const VERDICTS: Array<{ verdict: QaVerdict; label: string }> = [
  { verdict: "pass", label: "Pass" },
  { verdict: "fail", label: "Fail" },
  { verdict: "skip", label: "Skip" },
];

/** What a card drawn outside a session (the Playtests page) does instead of the session's own calls. */
export interface QaCardActions {
  /** Start playtest, offered on an ended run too: it runs the script again. */
  start?: (o: RunOptions) => Promise<{ run: QaRun }>;
  /** Assign to subagent, for a run whose card is in no session yet. */
  assign?: () => Promise<{ run: QaRun }>;
  /** Edit and Delete for any saved script: its steps as saved, then pie(script_update) or pie(script_delete). */
  script?: { read: () => Promise<QaRun>; save: (steps: QaScriptStep[]) => Promise<void>; remove: () => Promise<void> };
}

/** A pill's words while the editor is away: what the run last did, not what it is doing. */
const offlinePill = (text: string): string =>
  text === "Needs you" ? "Was waiting" : text === STARTING ? "Was starting" : /^Running/.test(text) || /^Step \d/.test(text) || /^Attempt/.test(text) ? "Was running" : text;

/**
 * A run's card, wherever it is drawn: the transcript, the session's strip of
 * live playtests, the Playtests page, a run started elsewhere, or a verdict
 * form with no run on screen. Its head is the title and its state; its own
 * buttons are always at the end of the row under its path: the box that asks
 * for a verdict or says why a loop stopped, the strip's line of what it is
 * doing, or the summary line. Opening it adds the steps under that, so the
 * head, path and row never move. `meta` follows the summary and `extra` adds
 * buttons, for the page. `dense` is the strip's card.
 */
export function QaCard({ run: saved, form: own, onDismiss, onHide, actions: outside, meta, extra, dense = false, slotted = false, offline }: {
  run: QaRun;
  form?: PendingForm;
  onDismiss?: () => void;
  /** Takes a loop that needs the user off the strip, for this viewer. */
  onHide?: () => void;
  actions?: QaCardActions;
  meta?: ReactNode;
  extra?: ReactNode;
  dense?: boolean;
  /** A row of the Playtests page, which draws the legend once over all its rows. */
  slotted?: boolean;
  /** Why the card cannot act now, such as the editor being away: its actions are drawn disabled with this as their hover. */
  offline?: string;
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
  /** A draft's open panel: Start playtest's options, Edit, or Delete waiting for its second click. */
  const [panel, setPanel] = useState<"run" | "edit" | "delete" | null>(null);
  /** The script as saved, read for Edit on a card drawn outside a session. */
  const [editing, setEditing] = useState<QaRun | null>(null);
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
    if (wants && !document.hasFocus()) void native().drawattention?.(`A playtest needs you: ${run.scriptName}`).catch(() => false);
  }, [wants, run.runId]);
  /** The step a bar or Fail opened the card on: scrolled to, focused and flashed once it is drawn. */
  const [target, setTarget] = useState<number | null>(null);
  /** The step the card was last opened on, marked for as long as it is open. */
  const [marked, setMarked] = useState<number | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const cues = useScrollCues(body, dense && open);
  /** Open the card on a step, or at its top (-1), and bring it into view. */
  const openAt = (index: number | null) => {
    setOpen(true);
    setTarget(index ?? -1);
    setMarked(index);
  };
  useLayoutEffect(() => {
    if (!open || target === null) return;
    setTarget(null);
    const el = body.current;
    if (target < 0) {
      if (dense && el) {
        el.scrollTop = 0;
        fitBody(el);
      }
      card.current?.scrollIntoView?.({ block: dense ? "nearest" : "start", behavior: dense ? "auto" : "smooth" });
      return;
    }
    const li = el?.querySelector<HTMLElement>(`.qa-step[data-index="${target}"]`);
    if (!li || !el) return;
    if (dense) {
      // Twice: a shorter body can scroll further, so the step lands at the top.
      for (let i = 0; i < 2; i++) {
        el.scrollTop = rowBox(el, li).top;
        fitBody(el);
      }
      card.current?.scrollIntoView?.({ block: "nearest" });
    } else li.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    if (!li.querySelector("textarea")) li.focus({ preventScroll: true });
    li.classList.add("flash");
    setTimeout(() => li.classList.remove("flash"), 1600);
  }, [open, target]);
  // The body is fitted again when the panel or what it holds changes size; scrolling leaves it be.
  const contentKey = `${run.steps.map((s) => s.status).join()}:${run.assignment?.loop?.attempts.length ?? 0}:${panel}`;
  useLayoutEffect(() => {
    const el = body.current;
    if (!dense || !open || !el) return;
    fitBody(el);
    const stage = el.closest(".playtest-strip")?.parentElement;
    const ro = typeof ResizeObserver === "function" && stage ? new ResizeObserver(() => fitBody(el)) : null;
    if (stage) ro?.observe(stage);
    return () => ro?.disconnect();
  }, [dense, open, contentKey]);
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

  /** A step's open "What went wrong?" box: Fail in the box that asks, Fail on the step, an override to Fail, or editing a failed step's note. */
  const [failing, setFailing] = useState<{ index: number; via: "box" | "verdict" | "override" | "edit" } | null>(null);
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

  /** End loop on a loop that is waiting for the user: it is closed, and no longer needs them. */
  const closeLoop = () => {
    setAssigning(true);
    setError(null);
    api.qaCancelAssign(run.runId)
      .then((r) => setRun((c) => (r.run.runId === c.runId ? newerRun(r.run, c) : r.run)), (e: Error) => setError(e.message))
      .finally(() => setAssigning(false));
  };

  /** A draft's Start playtest, Edit and Delete: each answers with the card's next state, or the page reads its list again. */
  const act = (call: () => Promise<{ run: QaRun } | void>) => {
    setWorking(true);
    setError(null);
    call().then((r) => {
      setPanel(null);
      if (r) setRun((c) => (r.run.runId === c.runId ? newerRun(r.run, c) : r.run));
    }, (e: Error) => setError(e.message)).finally(() => setWorking(false));
  };
  const start = (o: RunOptions) => act(() => (outside?.start ? outside.start(o) : api.qaRun(run.runId, o)));
  /** Start playtest's one click: the players the steps name, PIE started, the run recorded. */
  const quickStart = () => {
    const players = playersNeeded(run);
    start({ ...DEFAULT_RUN, players, listen: players > 1 });
  };

  const draft = qaIsDraft(run);
  const ended = qaEnded(run.state);
  /** Edit, Delete and a draft's early verdicts change the script through the session that has its card. */
  const owned = !!run.sessionId;
  /**
   * Start playtest on the card: a draft's, or the manual run a verdict on the
   * draft started, which a full run replaces; on an ended run, Run again. Not
   * while a loop that waits for the user waits on its Review.
   */
  const needsYouLoop = assignment?.loop?.state === "needs_you" ? assignment.loop : null;
  const runnable = (draft || (!!run.manual && !ended) || ended) && !run.deleted && !assigned && !needsYouLoop && (outside ? !!outside.start : owned);
  const stoppable = !draft && !ended && !assigned && !run.manual && owned;
  const stop = () => act(() => api.qaStop(run.runId));
  // A loop that waits for the user offers Review collapsed; assigning again is in the open card.
  const canAssign = (outside ? !!outside.assign : !!assignSession) && qaAssignable(run) && !run.deleted && assignment?.loop?.state !== "passed" && (!needsYouLoop || open);
  const sum = run.summary ?? qaSummaryOf(run.steps);
  const settled = sum.total - sum.pending;
  const partial = Object.keys(picked).length > 0;
  const byAgentCount = run.steps.filter(qaAgentVerdict).length;
  /** The step the box under the path asks about: the first waiting one not yet picked or sent. */
  const ask = waiting.find((s) => s.judge === "manual" && !picked[s.index] && !sending[s.index]) ?? null;
  const manualSteps = run.steps.filter((s) => s.judge === "manual").length;
  // A draft says so in its eyebrow; a pill names only what is not plain from it.
  const livePill = draft
    ? (run.deleted ? { tone: "", text: "Deleted" } : null)
    : ended
      ? (run.state === "stopped" ? { tone: "", text: "Stopped" } : { tone: sum.failed ? "bad" : "ok", text: sum.failed ? `${sum.failed} failed` : "Passed" })
      : waiting.length
        ? { tone: "warn", text: "Needs you" }
        : { tone: "run", text: run.state === "armed" ? STARTING : runningText(run, settled, sum.total) };
  const pill = livePill && offline ? { tone: "", text: offlinePill(livePill.text) } : livePill;
  // On the strip the line under the path says what a live run is doing, so its head carries no running pill.
  const headPill = dense && pill?.tone === "run" ? null : pill;
  const loopP = assignment?.loop ? loopPill(assignment.loop) : null;
  const loopShown = loopP && offline ? { tone: "", text: offlinePill(loopP.text) } : loopP;

  const optionsOpen = open && panel === "run";
  const startButtons = runnable && (
    <span className="qa-start" role="group" aria-label="Start playtest">
      <button className="primary small-button" disabled={working || !!offline} title={offline} onClick={quickStart}>{working ? STARTING : ended ? "Run again" : "Start playtest"}</button>
      <button
        className="small-button qa-start-options"
        disabled={working || !!offline}
        aria-label="Start playtest options"
        aria-expanded={optionsOpen}
        title={offline ?? "Players, listen server, PIE and recording"}
        onClick={() => {
          setPanel(optionsOpen ? null : "run");
          setOpen(true);
        }}
      >
        <OptionsGlyph />
        <span>Options</span>
      </button>
    </span>
  );
  const stopButton = stoppable && <button className="small-button qa-stop" disabled={working || !!offline} title={offline ?? "End the run now; steps not settled stay to come"} onClick={stop} aria-label={`Stop playtest ${run.scriptName}`}>Stop</button>;
  const cancelAssigned = assigned && <button className="small-button" disabled={assigning || !!offline} title={offline} onClick={toggleAssign} aria-label={assignment?.loop ? "End the loop" : "Cancel the subagent"}>{assignment?.loop ? "End loop" : "Cancel subagent"}</button>;
  const assignButton = canAssign && !assigned && <button className="small-button" disabled={assigning || !!offline} onClick={toggleAssign} title={offline ?? "A subagent runs the playtest, fixes what fails and runs it again until every step passes, or stops and asks for you"}>{needsYouLoop ? "Assign again" : "Assign to subagent"}</button>;
  const endLoop = needsYouLoop && <button className="small-button" disabled={assigning || !!offline} title={offline ?? "End the loop: it stops waiting for you, and its attempts stay to review and revert"} onClick={closeLoop}>End loop</button>;
  /** Edit and Delete: on a session's own draft, or on any saved script where the card is drawn with `script` actions. */
  const scripted = outside?.script;
  const editable = (scripted ? true : draft && owned) && !run.deleted && !assigned;
  const blocked = scripted ? offline : undefined;
  const toggleEdit = () => {
    if (panel === "edit" || !scripted) return setPanel(panel === "edit" ? null : "edit");
    setWorking(true);
    setError(null);
    scripted.read().then((r) => {
      setEditing(r);
      setPanel("edit");
    }, (e: Error) => setError(e.message)).finally(() => setWorking(false));
  };
  const draftButtons = open && editable && (
    <>
      <button className="small-button qa-script-edit" disabled={working || !!blocked} title={blocked} aria-expanded={panel === "edit"} onClick={toggleEdit}>Edit</button>
      {panel === "delete" ? (
        <button className="danger-button small-button" disabled={working || !!blocked} title={blocked} onClick={() => act(() => (scripted ? scripted.remove() : api.qaDeleteScript(run.runId)))}>Delete the script</button>
      ) : (
        <button className="ghost small-button qa-script-delete" disabled={working || !!blocked} title={blocked} onClick={() => setPanel("delete")}>Delete</button>
      )}
    </>
  );
  const editRun = panel === "edit" ? (scripted ? editing : draft ? run : null) : null;
  const dismiss = onDismiss && ended && <button className="ghost small-button" aria-label="Dismiss this run" onClick={onDismiss}>Dismiss</button>;
  /** The card's own buttons, in one order everywhere. */
  const ownActions = [startButtons, stopButton, cancelAssigned, assignButton, endLoop, draftButtons, extra, dismiss].filter(Boolean);
  const actions = ownActions.length > 0 ? <span className="qa-box-actions">{ownActions.map((a, i) => <Fragment key={i}>{a}</Fragment>)}</span> : null;

  /** The box that asks: collapsed, or on the strip. An open card elsewhere asks on the step's own row instead, so it is not shown twice. */
  const askBox = ask && (!open || dense) ? ask : null;
  const failInBox = !!askBox && failing?.via === "box" && failing.index === askBox.index;
  const summaryText = run.steps.length ? pathSummary(run, sum) : "No steps read yet";

  return (
    <div className={`qa-card card state-${run.state} ${needsYouLoop ? "needs-you" : ""} ${open ? "open" : "collapsed"} ${dense ? "dense" : ""} ${slotted ? "slotted" : ""} ${offline ? "offline" : ""}`} role="group" aria-label={`Playtest ${run.scriptName}`} data-run-id={run.runId} ref={card}>
      <div className="qa-head">
        <button className="qa-toggle" aria-expanded={open} aria-controls={`qa-body-${run.runId}`} onClick={() => (open ? setOpen(false) : openAt(null))}>
          <Chevron open={open} />
          <span className={`eyebrow ${draft || run.replayOf ? "qa-kind" : "qa-kind plain"}`}>{draft ? "Playtest draft" : run.replayOf ? "Playtest replay" : "Playtest"}</span>
          <strong className="qa-title">{run.scriptName}</strong>
        </button>
        {run.subagent && <span className="dim small qa-by">run by {run.subagent}</span>}
        <span className="spacer" />
        <span className="qa-states">
          {headPill && <span className={`pill ${headPill.tone}`} role="status" title={offline ? `Last known: ${offline}` : undefined}>{headPill.text}</span>}
          {loopShown && <span className={`pill ${loopShown.tone}`} role="status" aria-label={`Loop: ${loopShown.text}`} title="A subagent loop runs this playtest">{loopShown.text}</span>}
        </span>
      </div>
      <div className="qa-compact">
        {run.steps.length > 0 && <StepPath steps={run.steps} onStep={(i) => openAt(i)} ended={ended} />}
        {!dense && (
          <div className="qa-compact-line small">
            <button className="qa-compact-open" aria-label={`Open playtest ${run.scriptName}`} onClick={() => (open ? card.current?.scrollIntoView?.({ block: "start", behavior: "smooth" }) : openAt(null))}>
              <span className="dim qa-compact-summary">{offline && (pill || assignment?.loop) && <span className="qa-last-known" title={offline}>Last known: </span>}{summaryText}</span>
            </button>
            {meta && <span className="qa-meta dim">{meta}</span>}
            {!askBox && !needsYouLoop && actions}
          </div>
        )}
        {/* In the transcript the legend sits under the summary, open or not; the page draws one over all its rows. */}
        {!dense && !slotted && run.steps.length > 0 && panel !== "edit" && <PathLegend runs={[run]} />}
        {askBox && (
          <div className={`qa-answer ${failInBox ? "failing" : ""}`} role="group" aria-label={`Step ${askBox.index + 1} needs you`}>
            <span className="qa-answer-step">
              <span className="qa-num mono">{askBox.index + 1}</span>
              <span className="qa-answer-text"><span className="qa-answer-lead">Check in PIE: </span>{askBox.instruction}</span>
            </span>
            {failInBox ? (
              <FailNote
                step={askBox.index}
                initial={notes[askBox.index] ?? ""}
                onCancel={closeFail}
                onSubmit={(note) => {
                  closeFail();
                  decide(askBox, "fail", note);
                }}
              />
            ) : (
              <span className="qa-verdict">
                {VERDICTS.map((v) => (
                  <button
                    key={v.verdict}
                    className={`small-button verdict-${v.verdict}`}
                    aria-label={`${v.label} step ${askBox.index + 1}`}
                    disabled={!!offline}
                    title={offline ?? (v.verdict === "fail" ? "Fail it, with a note on what went wrong" : undefined)}
                    onClick={() => (v.verdict === "fail" ? setFailing({ index: askBox.index, via: "box" }) : decide(askBox, v.verdict))}
                  >
                    {v.label}
                  </button>
                ))}
                {waiting.length > 1 && <button className="small-button" onClick={() => openAt(askBox.index)} aria-label={waiting.length === 2 ? "1 more step needs you" : `${waiting.length - 1} more steps need you`}>+{waiting.length - 1} more</button>}
                {actions}
              </span>
            )}
          </div>
        )}
        {!askBox && needsYouLoop && (
          <div className="qa-answer needs" role="group" aria-label="The loop needs you">
            <span className="qa-answer-text">{needsYouLoop.blocker?.reason ?? "The loop is waiting for you."}</span>
            <span className="qa-verdict">
              {!open && <button className="small-button" disabled={!!offline} title={offline} onClick={() => openAt(null)}>Review</button>}
              {actions}
              {onHide && <button className="small-button" aria-label={`Hide ${run.scriptName} from the strip`} title="Takes it off this strip for you; the card stays in the conversation and on the Playtests page" onClick={onHide}>Hide from strip</button>}
            </span>
          </div>
        )}
        {dense && !ask && !needsYouLoop && <NowLine run={run} pill={pill?.text ?? null} actions={actions} />}
        {error && <div className="banner bad small">{error}</div>}
      </div>
      {open && <div className="qa-body-wrap">
      {dense && cues.moreAbove && <div className="qa-scroll-cues"><ScrollCue dir="above" more onClick={() => cues.by(-1)} /></div>}
      <div className="qa-body" id={`qa-body-${run.runId}`} ref={body}>
      {draft && <div className="dim small mono qa-script-path">{run.script}</div>}
      {panel === "run" && runnable && <RunPanel run={run} busy={working} onStart={start} onCancel={() => setPanel(null)} />}
      {panel === "delete" && <div className="small dim">Deleting removes the script asset. <button className="ghost small-button" onClick={() => setPanel(null)}>Keep it</button></div>}
      {assignment?.loop && (
        <LoopPanel
          loop={assignment.loop}
          busy={working}
          onRevert={(n) => act(() => api.qaRevertLoop(run.runId, n))}
          onThread={live?.onThread}
          showReason={!!askBox}
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
      {dense && panel !== "edit" && run.steps.length > 0 && <PathLegend runs={[run]} />}
      {editRun ? (
        <DraftEditor run={editRun} busy={working} onSave={(steps) => act(() => (scripted ? scripted.save(steps) : api.qaSaveScript(run.runId, steps)))} onCancel={() => setPanel(null)} />
      ) : (
      <ol className="qa-steps">
        {run.steps.map((s) => {
          const evidence = s.judge === "auto" ? evidenceText(s) : "";
          // A draft's manual steps take a verdict before Start playtest: the first one starts the manual run.
          const verdictable = s.judge === "manual" && (s.status === "awaiting_verdict" || (draft && owned && !run.deleted && !assigned));
          const unchecked = s.judge === "auto" && (draft || (!!run.manual && s.status === "pending"));
          const failBox = failing?.index === s.index && failing.via !== "box" ? failing : null;
          const busy = sending[s.index];
          const byAgent = qaAgentVerdict(s);
          const why = byAgent ? agentEvidenceText(s) : "";
          return (
            <li key={s.index} className={`qa-step ${tone(s)} ${s.judge} ${marked === s.index ? "target" : ""}`} data-status={s.status} data-index={s.index} tabIndex={-1}>
              <div className="qa-step-row">
                <span className="qa-num mono dim">{s.index + 1}</span>
                <span className="qa-instruction">{s.instruction}</span>
                <span className="qa-step-tags">
                  {s.player && <span className="qa-player small" title="The player this step is for">{s.player}</span>}
                  <span className={`qa-judge small ${s.judge}`} title={s.judge === "auto" ? "The observer checks this step from a value in PIE" : "A person judges this step"}>{judgeLabel(s)}</span>
                  {s.judge === "manual" && !qaAgentMayJudge(s) && <span className="qa-judge small" title="Only a person gives this step's verdict, never the subagent">Person only</span>}
                  {byAgent && <span className="qa-badge agent small" title={why} tabIndex={0} aria-label={`Judged by the agent. ${why.replace(/\n/g, ". ")}`}>Agent</span>}
                  {unchecked ? <span className="qa-status small dim">Checked when the playtest runs</span>
                    : !draft && <span className={`qa-status small ${tone(s)}`} title={evidence || undefined} tabIndex={evidence ? 0 : undefined} aria-label={evidence ? `${statusLabel(s, ended)}. ${evidence.replace(/\n/g, ". ")}` : undefined}>
                    {statusLabel(s, ended)}
                  </span>}
                </span>
              </div>
              {s.expect && <div className="qa-expect mono dim small">{s.expect.value} {s.expect.op}{s.expect.target !== undefined ? ` ${s.expect.target}` : ""}{s.withinMs ? `, within ${s.withinMs} ms` : ""}</div>}
              {s.status === "failed" && s.judge === "auto" && evidence && <div className="qa-evidence small" role="note">{evidence.split("\n").slice(1).join(" ") || evidence}</div>}
              {s.note && !verdictable && !byAgent && !failBox && (
                <div className="qa-note small">
                  <span className="qa-note-text">{s.note}</span>
                  {s.status === "failed" && s.judge === "manual" && (
                    <button className="small-button qa-note-edit" aria-label={`Edit the note on step ${s.index + 1}`} onClick={() => setFailing({ index: s.index, via: "edit" })}>Edit note</button>
                  )}
                </div>
              )}
              {byAgent && (
                <details className="qa-agent-evidence small">
                  <summary>What the agent saw</summary>
                  {(s.evidence?.note ?? s.note) && <p>{s.evidence?.note ?? s.note}</p>}
                  {(s.evidence?.captures ?? []).length > 0 && (
                    <div className="qa-captures">
                      {s.evidence!.captures!.map((c, n) => (
                        <a key={c} href={api.qaCaptureUrl(run.runId, s.index, n)} target="_blank" rel="noreferrer" title={c}>
                          <img src={api.qaCaptureUrl(run.runId, s.index, n)} alt={c.split(/[\/]/).pop()} loading="lazy" />
                        </a>
                      ))}
                    </div>
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
              {verdictable && !failBox && askBox?.index !== s.index && (
                <div className="qa-verdict">
                  {VERDICTS.map((v) => (
                    <button
                      key={v.verdict}
                      className={`small-button verdict-${v.verdict} ${picked[s.index] === v.verdict || busy === v.verdict ? "picked" : ""}`}
                      aria-pressed={picked[s.index] === v.verdict}
                      aria-label={`${v.label} step ${s.index + 1}`}
                      disabled={!!busy || !!offline}
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
      {ended && (
        <div className="qa-summary small" role="status">
          <span>
            {run.state === "stopped" ? "Stopped" : "Finished"}: {sum.passed} passed, {sum.failed} failed, {sum.skipped} skipped
            {sum.pending ? `, ${sum.pending} not run` : ""}{sum.regressions ? `, ${sum.regressions} regressed` : ""}.
            {byAgentCount > 0 && ` The agent judged ${byAgentCount === 1 ? "1 step" : `${byAgentCount} steps`}.`}
          </span>
          {run.resultsPath && (
            <a href={api.qaResultsUrl(run.runId)} target="_blank" rel="noreferrer" title={run.resultsPath}>results.json</a>
          )}
        </div>
      )}
      </div>
      {dense && cues.moreBelow && <div className="qa-scroll-cues"><ScrollCue dir="below" more onClick={() => cues.by(1)} /></div>}
      </div>}
    </div>
  );
}

/** The disclosure mark on a card's title: a chevron that turns as the card opens. */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={`qa-chevron ${open ? "open" : ""}`} width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4.5 2.5 8 6l-3.5 3.5" />
    </svg>
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

/** Start playtest's options: three sliders. */
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

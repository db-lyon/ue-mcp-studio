/**
 * A playtest card as a client shows it, with no UI: the words for each step
 * and run state, the marks on its step path, which of its controls apply, the
 * draft editor's rows, the assigned loop's lines, and the Playtests page's
 * filters. The web client's card and the mobile app's both draw from here.
 */
import {
  REVIEW_GROUPS,
  qaAssignable,
  qaEnded,
  qaIsDraft,
  qaSummaryOf,
  qaVerdictForm,
  reviewGroupOf,
  type CheckpointChange,
  type PendingForm,
  type PlaytestEntry,
  type PlaytestFilter,
  type QaExpect,
  type QaLoop,
  type QaLoopChange,
  type QaRun,
  type QaScriptStep,
  type QaStep,
  type QaVerdict,
} from "@ue-mcp-studio/shared";
import { newerRun } from "./chat-view.js";

/** A run answered for a card: the same run made newer, or the run that took the card's place. */
export const takeRun = (next: QaRun, cur: QaRun): QaRun => (next.runId === cur.runId ? newerRun(next, cur) : next);

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

/** The expectation line under an auto step: "Door.Angle gt 80, within 2000 ms". */
export const expectLine = (s: Pick<QaStep, "expect" | "withinMs">): string =>
  s.expect ? `${s.expect.value} ${s.expect.op}${s.expect.target !== undefined ? ` ${s.expect.target}` : ""}${s.withinMs ? `, within ${s.withinMs} ms` : ""}` : "";

/** The verdict a settled step holds. */
export const verdictOf = (s: QaStep): QaVerdict | null => (s.status === "passed" ? "pass" : s.status === "failed" ? "fail" : s.status === "skipped" ? "skip" : null);

/** A step's tone: the colour of its border, its status and its bar. */
export type StepTone = "ok" | "bad" | "warn" | "run" | "";
export const stepTone = (s: QaStep): StepTone =>
  s.status === "passed" ? "ok" : s.status === "failed" ? "bad" : s.status === "awaiting_verdict" ? "warn" : s.status === "running" ? "run" : "";

/** The words for a run that is starting, wherever it is named: the pill, the strip's line and the pointer to it. */
export const STARTING = "Starting";

/** What the strip's line says a step in progress is: the observer checks it, or the person plays it. */
export const stepDoing = (s: QaStep): string => (s.judge === "auto" ? "Observer checking" : "Play this step");

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

export type PathMark = "ok" | "bad" | "warn" | "run" | "pending" | "skipped" | "unrun";

/** The legend's mark for a step: the class its bar carries. */
export function markOf(s: QaStep, ended: boolean): PathMark {
  if (ended && s.status === "pending") return "unrun";
  if (s.status === "skipped") return "skipped";
  return (stepTone(s) || "pending") as PathMark;
}

/** Every mark a path can carry, in the legend's order, with what it means. */
export const PATH_MARKS: Array<[PathMark, string]> = [
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

export const QA_VERDICTS: Array<{ verdict: QaVerdict; label: string }> = [
  { verdict: "pass", label: "Pass" },
  { verdict: "fail", label: "Fail" },
  { verdict: "skip", label: "Skip" },
];

/** A pill's words while the editor is away: what the run last did, not what it is doing. */
export const offlinePill = (text: string): string =>
  text === "Needs you" ? "Was waiting" : text === STARTING ? "Was starting" : /^Running/.test(text) || /^Step \d/.test(text) || /^Attempt/.test(text) ? "Was running" : text;

export interface QaPill {
  tone: "" | "ok" | "bad" | "warn" | "run";
  text: string;
}

/** The pill in a card's head: a draft's only when deleted, an ended run's outcome, or what a live run is doing. */
export function runPill(run: QaRun): QaPill | null {
  const sum = run.summary ?? qaSummaryOf(run.steps);
  const waiting = run.steps.some((s) => s.status === "awaiting_verdict");
  if (qaIsDraft(run)) return run.deleted ? { tone: "", text: "Deleted" } : null;
  if (qaEnded(run.state)) {
    if (run.state === "stopped") return { tone: "", text: "Stopped" };
    if (sum.failed) return { tone: "bad", text: `${sum.failed} failed` };
    // An ended run with steps never judged did not pass.
    if (sum.pending) return { tone: "warn", text: "Incomplete" };
    return { tone: "ok", text: "Passed" };
  }
  if (waiting) return { tone: "warn", text: "Needs you" };
  return { tone: "run", text: run.state === "armed" ? STARTING : runningText(run, sum.total - sum.pending, sum.total) };
}

/** The line under the card's head saying where the loop is. */
const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

export function loopHeadline(loop: QaLoop): string {
  const n = loop.attempts.length;
  if (loop.state === "running") return n <= 1 ? "Attempt 1 is running: the subagent runs the playtest to see what fails." : `Attempt ${n} is running: the subagent fixes what failed and runs the playtest again.`;
  if (loop.state === "passed") return `Passed after ${plural(n, "attempt")}.`;
  if (loop.state === "stopped") return `The loop was stopped after ${plural(n, "attempt")}. Each attempt's changes can still be reverted.`;
  if (loop.state === "failed") return `The loop stopped on an error: ${loop.error ?? "unknown"}`;
  return `The loop is paused after ${plural(n, "attempt")}, waiting for you. Assign again to let it go on, or End loop.`;
}

/** The pill a loop puts beside the run's own status. */
export function loopPill(loop: QaLoop): { text: string; tone: QaPill["tone"] } {
  if (loop.state === "running") return { text: `Attempt ${Math.max(1, loop.attempts.length)}`, tone: "" };
  if (loop.state === "passed") return { text: "Passed", tone: "ok" };
  if (loop.state === "needs_you") return { text: "Needs you", tone: "warn" };
  if (loop.state === "failed") return { text: "Loop failed", tone: "bad" };
  return { text: "Loop stopped", tone: "" };
}

/** A loop change's review group, from its extension. */
export function loopChangeGroup(c: QaLoopChange) {
  const kind: CheckpointChange["kind"] = /\.(uasset|umap)$/i.test(c.path) ? "package" : /\.ini$/i.test(c.path) ? "config" : /\.(cpp|h|hpp|cs|inl)$/i.test(c.path) ? "source" : "other";
  return reviewGroupOf({ path: c.path, kind });
}

/** An attempt's changes in review groups, the empty groups left out. */
export function loopChangeGroups(changes: QaLoopChange[]): Array<{ group: string; label: string; items: QaLoopChange[] }> {
  return REVIEW_GROUPS.map(({ group, label }) => ({ group, label, items: changes.filter((c) => loopChangeGroup(c) === group) })).filter((g) => g.items.length > 0);
}

export { plural as qaPlural };

/** Start playtest's options. */
export interface RunOptions {
  startPie: boolean;
  players: number;
  listen: boolean;
  record: boolean;
}

export const DEFAULT_RUN: RunOptions = { startPie: true, players: 1, listen: false, record: true };

/** How many players a run needs: one more than the highest client a step names. */
export function playersNeeded(run: QaRun): number {
  let n = 1;
  for (const s of run.steps) {
    const m = /^client\s*(\d+)?$/i.exec(s.player ?? "");
    if (m) n = Math.max(n, Number(m[1] ?? 1) + 1);
  }
  return n;
}

/** Start playtest's one click: the players the steps name, PIE started, the run recorded. */
export function quickRunOptions(run: QaRun): RunOptions {
  const players = playersNeeded(run);
  return { ...DEFAULT_RUN, players, listen: players > 1 };
}

/** The draft editor's expectation ops and players, in the order its pickers list them. */
export const EDIT_OPS = ["decreasing", "increasing", "eq", "gt", "lt", "visible", "exists"] as const;
export const EDIT_PLAYERS = ["", "host", "client 1", "client 2", "client 3"];

function targetOf(op: string, raw: string): number | boolean | undefined {
  if (op === "decreasing" || op === "increasing") return undefined;
  if (op === "visible" || op === "exists") return raw === "false" ? false : undefined;
  const n = Number(raw);
  return raw.trim() && Number.isFinite(n) ? n : undefined;
}

/** A step as the draft editor holds it. */
export interface EditRow {
  instruction: string;
  judge: "auto" | "manual";
  player: string;
  value: string;
  op: string;
  target: string;
  withinMs: string;
  personOnly: boolean;
}

export const EMPTY_ROW: EditRow = { instruction: "", judge: "manual", player: "", value: "", op: "eq", target: "", withinMs: "", personOnly: false };

export function rowOf(s: QaScriptStep): EditRow {
  return {
    instruction: s.instruction,
    judge: s.judge,
    player: s.player ?? "",
    value: s.expect?.value ?? "",
    op: s.expect?.op ?? "eq",
    target: s.expect?.target === undefined ? "" : String(s.expect.target),
    withinMs: s.expect?.within_ms ? String(s.expect.within_ms) : "",
    personOnly: s.agent_judgeable === false,
  };
}

/** The editor's rows as script steps. An auto step without a value has no expectation and passes when it starts. */
export function stepsOf(rows: EditRow[]): QaScriptStep[] {
  return rows.map((r) => {
    const expect: QaExpect | undefined = r.judge === "auto" && r.value.trim()
      ? { value: r.value.trim(), op: r.op, ...(targetOf(r.op, r.target) !== undefined ? { target: targetOf(r.op, r.target) } : {}), ...(Number(r.withinMs) > 0 ? { within_ms: Number(r.withinMs) } : {}) }
      : undefined;
    return {
      instruction: r.instruction.trim(),
      judge: r.judge,
      ...(expect ? { expect } : {}),
      ...(r.judge === "manual" && r.personOnly ? { agent_judgeable: false } : {}),
      ...(r.player ? { player: r.player } : {}),
    };
  });
}

/** Whether the editor's rows can be saved: at least one step, each with an instruction. */
export const rowsValid = (rows: EditRow[]): boolean => rows.length > 0 && rows.every((r) => r.instruction.trim());

/** One arrange or act entry of a step, in words. */
export interface SetupEntry {
  verb: string;
  /** The actor, class or asset the entry names. */
  target: string | null;
  /** What it does to the target: a set's property and value, a call's function. */
  detail?: string;
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const brief = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));

/** The keys an act entry names its target by, in the order they are read. */
const TARGET_KEYS = ["action", "at", "target", "class", "actor", "asset", "map"];

function arrangeEntry(e: Record<string, unknown>): SetupEntry {
  const kind = str(e.kind) ?? "arrange";
  if (kind === "spawn") return { verb: "spawn", target: str(e.class) };
  if (kind === "set") return { verb: "set", target: str(e.target), ...(str(e.path) ? { detail: `${e.path} = ${brief(e.value)}` } : {}) };
  if (kind === "call") return { verb: "call", target: str(e.target), ...(str(e.func) ? { detail: str(e.func)! } : {}) };
  return { verb: kind, target: str(e.target) ?? str(e.class) };
}

function actEntry(e: Record<string, unknown>): SetupEntry {
  const [verb, body] = Object.entries(e)[0] ?? ["act", null];
  const b = obj(body);
  const key = b ? TARGET_KEYS.find((k) => str(b[k])) : undefined;
  const target = key ? str(b![key]) : str(body);
  return { verb: key === "at" ? `${verb} at` : verb, target };
}

/**
 * A step's arrange and act entries in words, in the order they run. The
 * entries are ue-mcp's script step format: arrange is {kind: spawn|set|call,
 * class|target, ...}, each act entry one verb, {press: {action}} or {place: {at}}.
 */
export function stepSetup(s: Pick<QaStep, "arrange" | "act">): { arrange: SetupEntry[]; act: SetupEntry[] } {
  const list = (v: unknown) => (Array.isArray(v) ? v : v ? [v] : []).map(obj).filter((x): x is Record<string, unknown> => !!x);
  return { arrange: list(s.arrange).map(arrangeEntry), act: list(s.act).map(actEntry) };
}

/** A setup target as the asset it names: a class's _C is the Blueprint's. */
export const setupAsset = (target: string): string => target.replace(/\.([A-Za-z0-9_]+)_C$/, ".$1").replace(/_C$/, "");

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

/** What a card may offer, from the run and where it is drawn. */
export interface CardControls {
  draft: boolean;
  ended: boolean;
  /** Edit, Delete and a draft's early verdicts change the script through the session that has its card. */
  owned: boolean;
  assigned: boolean;
  needsYouLoop: QaLoop | null;
  /** Start playtest (Run again on an ended run). */
  runnable: boolean;
  stoppable: boolean;
  canAssign: boolean;
  /**
   * Why Assign to subagent cannot be pressed yet, where it would otherwise be
   * offered: every step needs a person, so a subagent has nothing to run until
   * one fails. The card shows Assign greyed out with this, instead of no button.
   */
  assignWaits: string | null;
  /** Edit and Delete. */
  editable: boolean;
}

/**
 * The rules for a card's buttons. `outside` names the actions a card drawn
 * outside a session (the Playtests page) brings; `assignSession` is where a
 * subagent would run; `open` is whether the card is open.
 */
export function cardControls(run: QaRun, o: { outside?: { start?: boolean; assign?: boolean; script?: boolean }; assignSession: string | null; open: boolean }): CardControls {
  const draft = qaIsDraft(run);
  const ended = qaEnded(run.state);
  const owned = !!run.sessionId;
  const assignment = run.assignment;
  const assigned = assignment?.state === "running";
  const needsYouLoop = assignment?.loop?.state === "needs_you" ? assignment.loop : null;
  const runnable = (draft || (!!run.manual && !ended) || ended) && !run.deleted && !assigned && !needsYouLoop && (o.outside ? !!o.outside.start : owned);
  const stoppable = !draft && !ended && !assigned && !run.manual && owned;
  // A loop that waits for the user offers Review collapsed; assigning again is in the open card.
  const canAssign = (o.outside ? !!o.outside.assign : !!o.assignSession) && qaAssignable(run) && !run.deleted && assignment?.loop?.state !== "passed" && (!needsYouLoop || o.open);
  // A saved script is editable wherever its card is drawn, in a session's chat as on the Playtests page.
  const scripted = o.outside ? !!o.outside.script : !draft && !!run.script;
  const editable = (scripted ? true : draft && owned) && !run.deleted && !assigned;
  const placed = (o.outside ? !!o.outside.assign : !!o.assignSession) && !run.deleted && !assigned && !needsYouLoop && assignment?.loop?.state !== "passed";
  const assignWaits = placed && !qaAssignable(run) ? ASSIGN_WAITS : null;
  return { draft, ended, owned, assigned, needsYouLoop, runnable, stoppable, canAssign, assignWaits, editable };
}

export const ASSIGN_WAITS = "Every step needs a person to judge, so a subagent has nothing to run yet. Fail a step and it can fix the project and run the playtest again.";

/** The Playtests page's filters, in the order its chips show them, each with what an empty list says. */
export const PLAYTEST_FILTERS: Array<{ id: PlaytestFilter; label: string; empty: string }> = [
  { id: "active", label: "Active", empty: "No playtest is running." },
  { id: "needs-you", label: "Needs you", empty: "Nothing needs you. A playtest step that needs your verdict, or a loop that stops for you, shows here." },
  { id: "failing", label: "Failing", empty: "No playtest's last run failed." },
  { id: "all", label: "All", empty: "No playtests in this project yet. Ask the agent for one in a session, or type /playtest in the message box." },
];

/** Events after which the Playtests page reads its list again, once they have stopped for a moment. */
export const PLAYTEST_RELOAD_ON = new Set(["studio.qa.changed", "studio.session.changed", "studio.transcript.added"]);
export const PLAYTEST_RELOAD_MS = 800;

/** A stored filter, if it is one. */
export const playtestFilterOf = (v: unknown): PlaytestFilter | null => (v === "active" || v === "needs-you" || v === "failing" || v === "all" ? v : null);

/** Until the user picks one: Active when something runs, then Needs you, otherwise All. */
export function defaultPlaytestFilter(counts: Record<PlaytestFilter, number>): PlaytestFilter {
  return counts.active > 0 ? "active" : counts["needs-you"] > 0 ? "needs-you" : "all";
}

/** "just now", "5 minutes ago", "3 hours ago", "yesterday", "4 days ago", or the date. */
export function ranAgo(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const m = Math.round((now - t) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "yesterday";
  if (d < 14) return `${d} days ago`;
  return new Date(t).toLocaleDateString();
}

/** When a page row's run ran, in words: "Ran 5 minutes ago", "Never run, drafted". */
export function playtestWhen(e: PlaytestEntry, now = Date.now()): string {
  return e.last ? `${qaEnded(e.last.state) ? "Ran" : "Started"} ${ranAgo(e.last.seenAt, now)}` : e.card ? "Never run, drafted" : "Never run";
}

/** The run a page row's session link opens: the newest run when it is in that session, else the card. */
export function playtestTarget(e: PlaytestEntry): QaRun | null {
  return e.session && e.last?.sessionId === e.session.id ? e.last : e.card;
}

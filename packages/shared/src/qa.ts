/**
 * A PIE test script run as Studio's checklist card shows it. Built from
 * ue-mcp's pie(script_run) and pie(script_status) answers (snake_case) and
 * kept current from the script.* events on the daemon's stream (camelCase),
 * as plans/qa-checklist-contract.md in ue-mcp defines them. Every function
 * here returns a new run and never changes the one it is given.
 */

export type QaStepStatus = "pending" | "running" | "passed" | "failed" | "awaiting_verdict" | "skipped";
export type QaRunState = "armed" | "running" | "awaiting_verdict" | "finished" | "stopped" | "idle";
export type QaVerdict = "pass" | "fail" | "skip";
export type QaVerdictSource = "auto" | "action" | "elicitation" | "source_run";

export interface QaExpect {
  value: string;
  op: string;
  target?: number | boolean;
  within_ms?: number;
}

/** What the observer saw for an auto step, as the editor wrote it. */
export interface QaEvidence {
  value?: string;
  at_start?: number | null;
  at_end?: number | null;
  samples?: number;
  observed?: boolean;
  verdict_frame?: number;
  verdict_at_ms?: number;
  reason?: string;
}

export interface QaStep {
  index: number;
  instruction: string;
  judge: "auto" | "manual";
  expect?: QaExpect;
  status: QaStepStatus;
  withinMs?: number;
  startedAtMs?: number;
  endedAtMs?: number;
  evidence?: QaEvidence;
  note?: string;
  verdictSource?: QaVerdictSource;
  /** Replay runs: the step's status in the source run, and whether it passed there and failed here. */
  sourceStatus?: QaStepStatus;
  regression?: boolean;
}

export interface QaSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  /** Every step not settled, awaiting ones included. */
  pending: number;
  awaiting: number;
  regressions?: number;
}

export interface QaRun {
  runId: string;
  /** The script's asset path, or "inline". */
  script: string;
  scriptName: string;
  state: QaRunState;
  steps: QaStep[];
  /** Manual steps waiting for a verdict, by index. */
  awaiting: number[];
  /** The highest event seq applied: the next status read asks for the events after it. */
  lastSeq: number;
  summary: QaSummary;
  resultsPath: string | null;
  replayOf?: string;
  /** The session whose call started it; null for a run started elsewhere. */
  sessionId: string | null;
  /** The tool call that started it. */
  toolUseId: string | null;
  /** The subagent that started it, by its task name. */
  subagent?: string;
  /** When Studio first saw it, ISO 8601. */
  seenAt: string;
}

/** The answer actions a manual step takes. */
export const QA_VERDICTS: readonly QaVerdict[] = ["pass", "fail", "skip"];

export const qaEnded = (state: QaRunState): boolean => state === "finished" || state === "stopped";
export const qaSettled = (status: QaStepStatus): boolean => status === "passed" || status === "failed" || status === "skipped";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const int = (v: unknown): number | undefined => (Number.isInteger(v) ? (v as number) : undefined);

const STEP_STATUSES: readonly QaStepStatus[] = ["pending", "running", "passed", "failed", "awaiting_verdict", "skipped"];
const RUN_STATES: readonly QaRunState[] = ["armed", "running", "awaiting_verdict", "finished", "stopped", "idle"];
const SOURCES: readonly QaVerdictSource[] = ["auto", "action", "elicitation", "source_run"];
const stepStatus = (v: unknown): QaStepStatus | undefined => (STEP_STATUSES.includes(v as QaStepStatus) ? (v as QaStepStatus) : undefined);
const runState = (v: unknown): QaRunState | undefined => (RUN_STATES.includes(v as QaRunState) ? (v as QaRunState) : undefined);
const source = (v: unknown): QaVerdictSource | undefined => (SOURCES.includes(v as QaVerdictSource) ? (v as QaVerdictSource) : undefined);

/** Drop the keys left undefined, so a patch never clears a field it does not carry. */
function defined<T extends Obj>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** A step from an answer or results.json (snake_case). */
function stepPatchSnake(s: Obj): Partial<QaStep> {
  return defined({
    index: int(s.index),
    instruction: str(s.instruction),
    judge: s.judge === "manual" ? "manual" as const : s.judge === "auto" ? "auto" as const : undefined,
    expect: (obj(s.expect) ?? undefined) as QaExpect | undefined,
    status: stepStatus(s.status),
    withinMs: num(s.within_ms),
    startedAtMs: num(s.started_at_ms),
    endedAtMs: num(s.ended_at_ms),
    evidence: (obj(s.evidence) ?? undefined) as QaEvidence | undefined,
    note: str(s.note),
    verdictSource: source(s.verdict_source),
    sourceStatus: stepStatus(s.source_status),
    regression: typeof s.regression === "boolean" ? s.regression : undefined,
  });
}

/** A step object from a script.* stream event (camelCase, expect and evidence as the editor wrote them). */
function stepPatchCamel(s: Obj): Partial<QaStep> {
  return defined({
    index: int(s.index),
    instruction: str(s.instruction),
    judge: s.judge === "manual" ? "manual" as const : s.judge === "auto" ? "auto" as const : undefined,
    expect: (obj(s.expect) ?? undefined) as QaExpect | undefined,
    status: stepStatus(s.status),
    withinMs: num(s.withinMs),
    startedAtMs: num(s.startedAtMs),
    endedAtMs: num(s.endedAtMs),
    evidence: (obj(s.evidence) ?? undefined) as QaEvidence | undefined,
    note: str(s.note),
    verdictSource: source(s.verdictSource),
    sourceStatus: stepStatus(s.sourceStatus),
    regression: typeof s.regression === "boolean" ? s.regression : undefined,
  });
}

export function qaSummaryOf(steps: QaStep[]): QaSummary {
  const n = (st: QaStepStatus) => steps.filter((s) => s.status === st).length;
  const regressions = steps.filter((s) => s.regression).length;
  return {
    total: steps.length,
    passed: n("passed"),
    failed: n("failed"),
    skipped: n("skipped"),
    pending: steps.filter((s) => !qaSettled(s.status)).length,
    awaiting: n("awaiting_verdict"),
    ...(regressions ? { regressions } : {}),
  };
}

/** The indices an awaiting list names: numbers, or { index } objects. */
function indices(v: unknown): number[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.map((x) => (typeof x === "number" ? x : int(obj(x)?.index))).filter((x): x is number => Number.isInteger(x));
}

/**
 * Set one step's fields, adding the step when it is new. A settled step never
 * goes back to pending or running: an event older than what Studio already
 * read cannot undo it. Only a verdict replaces a settled status.
 */
function patchStep(steps: QaStep[], patch: Partial<QaStep>, verdict = false): QaStep[] {
  if (patch.index === undefined) return steps;
  const i = steps.findIndex((s) => s.index === patch.index);
  if (i < 0) {
    const added: QaStep = { instruction: "", judge: "auto", status: "pending", ...patch, index: patch.index };
    return [...steps, added].sort((a, b) => a.index - b.index);
  }
  const was = steps[i];
  const p = !verdict && qaSettled(was.status) && patch.status && !qaSettled(patch.status) ? { ...patch, status: was.status } : patch;
  const next = steps.slice();
  next[i] = { ...was, ...p };
  return next;
}

/** Recount, and keep the awaiting list to steps that still wait. */
function settle(run: QaRun): QaRun {
  const waiting = new Set(run.steps.filter((s) => s.status === "awaiting_verdict").map((s) => s.index));
  const awaiting = run.awaiting.filter((i) => waiting.has(i));
  for (const i of waiting) if (!awaiting.includes(i)) awaiting.push(i);
  awaiting.sort((a, b) => a - b);
  let state = run.state;
  if (state === "awaiting_verdict" && awaiting.length === 0) state = "running";
  return { ...run, awaiting, state, summary: qaSummaryOf(run.steps) };
}

/** A run from a pie(script_run), script_replay, script_status or script_results answer. Null when it names no run. */
export function qaRunFromAnswer(answer: unknown, where: { sessionId?: string | null; toolUseId?: string | null; subagent?: string; seenAt?: string } = {}): QaRun | null {
  const a = obj(answer);
  const runId = str(a?.run_id);
  if (!a || !runId) return null;
  const steps = (Array.isArray(a.steps) ? a.steps : [])
    .map((s) => obj(s))
    .filter((s): s is Obj => s !== null)
    .map((s) => ({ instruction: "", judge: "auto" as const, status: "pending" as const, ...stepPatchSnake(s) }))
    .filter((s): s is QaStep => s.index !== undefined)
    .sort((x, y) => x.index - y.index);
  const events = Array.isArray(a.events) ? a.events.map((e) => int(obj(e)?.seq) ?? 0) : [];
  const replayOf = str(a.replay_of);
  const run: QaRun = {
    runId,
    script: str(a.script) ?? "inline",
    scriptName: str(a.script_name) ?? str(a.script) ?? runId,
    state: runState(a.state) ?? "armed",
    steps,
    awaiting: indices(a.awaiting) ?? [],
    lastSeq: Math.max(int(a.last_seq) ?? 0, ...events, 0),
    summary: qaSummaryOf(steps),
    resultsPath: str(a.results_path) ?? null,
    ...(replayOf ? { replayOf } : {}),
    sessionId: where.sessionId ?? null,
    toolUseId: where.toolUseId ?? null,
    ...(where.subagent ? { subagent: where.subagent } : {}),
    seenAt: where.seenAt ?? new Date().toISOString(),
  };
  return settle(run);
}

/**
 * A later status answer for the same run: its events after the run's lastSeq
 * applied in order, then its own snapshot of the steps, which is current as of
 * its last_seq. An answer for no run, or another one, changes nothing.
 */
export function qaMergeAnswer(run: QaRun, answer: unknown): QaRun {
  const a = obj(answer);
  if (!a || str(a.run_id) !== run.runId) return run;
  let next = run;
  for (const e of Array.isArray(a.events) ? a.events : []) next = qaApplyEditorEvent(next, e);
  const fresh = qaRunFromAnswer(a);
  if (!fresh || fresh.steps.length === 0) return next;
  return settle({
    ...next,
    state: fresh.state,
    steps: fresh.steps,
    awaiting: fresh.awaiting,
    lastSeq: Math.max(next.lastSeq, fresh.lastSeq),
    resultsPath: fresh.resultsPath ?? next.resultsPath,
    ...(fresh.replayOf ? { replayOf: fresh.replayOf } : {}),
  });
}

/** What one event says, whichever shape it came in. */
interface Change {
  type: string;
  seq: number;
  step?: Partial<QaStep>;
  awaiting?: number[];
  awaitingSteps?: Array<{ index: number; instruction?: string }>;
  blocking?: boolean;
  state?: QaRunState;
  resultsPath?: string;
}

function apply(run: QaRun, c: Change): QaRun {
  // Each event once: a new daemon replays a run from its first event.
  if (c.seq > 0 && c.seq <= run.lastSeq) return run;
  let next: QaRun = { ...run, lastSeq: Math.max(run.lastSeq, c.seq) };
  if (c.resultsPath) next.resultsPath = c.resultsPath;
  switch (c.type) {
    case "run_started":
      if (next.state === "idle") next.state = "armed";
      break;
    case "step_started":
    case "step_passed":
    case "step_failed":
    case "verdict":
      if (c.step) next.steps = patchStep(next.steps, c.step, c.type === "verdict");
      if (c.type === "step_started" && (next.state === "armed" || next.state === "idle")) next.state = "running";
      break;
    case "verdict_requested":
    case "awaiting_verdict": {
      const asked: Array<{ index: number; instruction?: string }> = c.awaitingSteps ?? (c.awaiting ?? []).map((index) => ({ index }));
      for (const s of asked) {
        const had = next.steps.find((x) => x.index === s.index);
        if (had && qaSettled(had.status)) continue;
        next.steps = patchStep(next.steps, { index: s.index, judge: "manual", status: "awaiting_verdict", ...(s.instruction ? { instruction: s.instruction } : {}) });
      }
      next.awaiting = [...new Set([...next.awaiting, ...asked.map((s) => s.index)])];
      if (c.blocking !== false && !qaEnded(next.state)) next.state = "awaiting_verdict";
      break;
    }
    case "run_finished":
      next.state = c.state ?? "finished";
      break;
    default:
      // A script.* type this version does not know: only its seq counts.
      return next;
  }
  return settle(next);
}

/** An event from an answer's `events` list (snake_case data). */
export function qaApplyEditorEvent(run: QaRun, event: unknown): QaRun {
  const e = obj(event);
  if (!e || (str(e.run_id) && e.run_id !== run.runId)) return run;
  const type = str(e.type) ?? "";
  const d = obj(e.data) ?? {};
  const index = int(e.step);
  const step = index !== undefined && index >= 0 ? { ...stepPatchSnake(d), index } : undefined;
  if (step && type !== "step_started" && !step.evidence && typeof d.reason === "string") step.evidence = { reason: d.reason };
  return apply(run, {
    type,
    seq: int(e.seq) ?? 0,
    step,
    awaiting: indices(d.awaiting),
    awaitingSteps: Array.isArray(d.steps) ? awaitedSteps(d.steps) : undefined,
    blocking: typeof d.blocking === "boolean" ? d.blocking : undefined,
    state: runState(d.state),
    resultsPath: str(d.results_path),
  });
}

/** The { index, instruction } list an awaiting event carries. */
function awaitedSteps(v: unknown[]): Array<{ index: number; instruction?: string }> {
  return v.map((x) => obj(x)).filter((x): x is Obj => x !== null && int(x.index) !== undefined).map((x) => ({ index: x.index as number, instruction: str(x.instruction) }));
}

/** An event from the daemon's stream: `type` is script.<name>, `data` its payload. Another run's event changes nothing. */
export function qaApplyStreamEvent(run: QaRun, type: string, data: unknown): QaRun {
  const d = obj(data);
  if (!d || !type.startsWith("script.") || d.runId !== run.runId) return run;
  const name = type.slice("script.".length);
  const s = obj(d.step);
  return apply(run, {
    type: name,
    seq: int(d.seq) ?? 0,
    step: s ? stepPatchCamel(s) : undefined,
    awaitingSteps: Array.isArray(d.awaiting) ? awaitedSteps(d.awaiting) : undefined,
    state: runState(d.state),
    resultsPath: str(d.resultsPath),
  });
}

/**
 * What a pie(verdict) answer says about the run. A verdict on an ended run is
 * not on the stream once the server stops following it, so the card takes it
 * from here.
 */
export function qaApplyVerdictAnswer(run: QaRun, answer: unknown): QaRun {
  const a = obj(answer);
  const index = int(a?.step);
  if (!a || str(a.run_id) !== run.runId || index === undefined) return run;
  const steps = patchStep(run.steps, defined({ index, status: stepStatus(a.status), note: str(a.note), verdictSource: source(a.verdict_source) }), true);
  return settle({ ...run, steps, state: runState(a.state) ?? run.state, awaiting: indices(a.awaiting) ?? run.awaiting });
}

/**
 * The verdict form ue-mcp raises for manual steps: every field is step_<i>
 * (pass, fail or skip) or step_<i>_note. The run comes from the message,
 * which names it as "(run <id>)". Null for any other form.
 */
export function qaVerdictForm(form: { message: string; fields: Record<string, unknown> }): { runId: string | null; steps: number[] } | null {
  const steps: number[] = [];
  const keys = Object.keys(form.fields);
  if (keys.length === 0) return null;
  for (const k of keys) {
    const m = /^step_(\d+)(_note)?$/.exec(k);
    if (!m) return null;
    if (m[2]) continue;
    const f = obj(form.fields[k]);
    const values = Array.isArray(f?.enum) ? (f!.enum as unknown[]) : [];
    if (values.length !== QA_VERDICTS.length || !QA_VERDICTS.every((v) => values.includes(v))) return null;
    steps.push(Number(m[1]));
  }
  if (steps.length === 0) return null;
  const runId = /\(run ([A-Za-z0-9_-]+)\)/.exec(form.message)?.[1] ?? null;
  return { runId, steps: steps.sort((a, b) => a - b) };
}

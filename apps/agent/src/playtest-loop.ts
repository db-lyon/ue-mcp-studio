/**
 * Assign to subagent: make the playtest pass. Each attempt is a subagent that
 * runs the playtest (from the second attempt on, after it has read why steps
 * failed and changed the project), bracketed by ue-mcp checkpoints so every
 * attempt can be reverted. The loop ends when every step passes, or at a hard
 * blocker, which the card shows as "Needs you" and Studio announces:
 *
 * - a manual step only a person may judge has no verdict yet;
 * - no progress: the steps that failed fail the same way again;
 * - the agent reports a step that contradicts the design or another step, a
 *   change needed outside the project, or something only a person can do;
 * - a call refused by a guard or by Playtest runs, or a write outside the project;
 * - the editor crashed twice in a row, or a build failed twice in a row;
 * - it has made MAX_ATTEMPTS attempts.
 *
 * Steps whose script carries act (db-lyon/ue-mcp#1507) are driven by the
 * engine during the run; the brief tells the subagent not to drive them. Steps
 * without act are driven by the subagent, so the loop works either way.
 */
import * as path from "node:path";
import {
  qaAgentMayJudge,
  qaEnded,
  qaSettled,
  type CheckpointChange,
  type QaBlocker,
  type QaLoop,
  type QaLoopAttempt,
  type QaRun,
  type QaStep,
  type RestoreOutcome,
  type TimelineMark,
  type TranscriptEntry,
  PLAYTEST_RUNS_REFUSAL,
} from "@ue-mcp-studio/shared";
import { playtestBrief, playtestDescription } from "./playtest-brief.js";

// ── Judging an attempt ──────────────────────────────────────────────

/** A step that did not pass, with the line the next brief and the card show. */
export interface FailingStep {
  index: number;
  /** What makes two failures "the same way". */
  signature: string;
  /** Such as "Step 2 (Open the door) failed." with its evidence. */
  line: string;
}

const round = (v: unknown): string => (typeof v === "number" && Number.isFinite(v) ? String(Math.round(v * 100) / 100) : "");

/** What the observer or the judge saw for a step, in one line. */
export function stepEvidence(s: QaStep): string {
  const parts: string[] = [];
  const act = s.actResult;
  if (act?.status === "failed") {
    const broken = (act.actions ?? []).filter((a) => !a.ok).map((a) => `${a.action}${a.error ? `: ${a.error}` : ""}`);
    parts.push(`The engine's act failed${act.reason ? `: ${act.reason}` : ""}${broken.length ? ` (${broken.join("; ")})` : ""}.`);
  }
  if (s.expect) parts.push(`Expected ${s.expect.value} ${s.expect.op}${s.expect.target !== undefined ? ` ${s.expect.target}` : ""}${s.withinMs ? ` within ${s.withinMs} ms` : ""}.`);
  const e = s.evidence;
  if (e?.at_start !== undefined || e?.at_end !== undefined) parts.push(`${e?.value ?? s.expect?.value ?? "The value"} was ${e?.at_start ?? "never read"} at the start and ${e?.at_end ?? "never read"} at the end.`);
  if (e?.observed === false) parts.push("The observer never read the value.");
  if (e?.reason) parts.push(e.reason.endsWith(".") ? e.reason : `${e.reason}.`);
  const note = e?.note ?? s.note;
  if (note) parts.push(`Note: ${note}`);
  if (e?.captures?.length) parts.push(`Captures: ${e.captures.join(", ")}`);
  return parts.join(" ");
}

/** A person-only step: a manual step an agent may never judge. */
const personOnly = (s: QaStep): boolean => s.judge === "manual" && !qaAgentMayJudge(s);

/** The steps of a run that did not pass and that the loop can work on. Null run: the attempt started none. */
export function failingSteps(run: QaRun | null): FailingStep[] {
  if (!run) return [{ index: -1, signature: "run:none", line: "The attempt did not run the playtest." }];
  const ended = qaEnded(run.state);
  const out: FailingStep[] = [];
  for (const s of run.steps) {
    const head = `Step ${s.index + 1} (${s.instruction})`;
    if (s.status === "failed") {
      const e = s.evidence;
      const signature = s.judge === "auto" ? `${s.index}:failed:${e?.reason ?? ""}:${e?.observed === false ? "unobserved" : ""}:${round(e?.at_end)}` : `${s.index}:failed:manual`;
      out.push({ index: s.index, signature, line: `${head} failed. ${stepEvidence(s)}`.trim() });
    } else if (s.status === "skipped") {
      out.push({ index: s.index, signature: `${s.index}:skipped`, line: `${head} was skipped: it could not be reached. ${stepEvidence(s)}`.trim() });
    } else if (!qaSettled(s.status) && !personOnly(s) && (ended || s.judge === "manual" || s.status === "pending")) {
      out.push({ index: s.index, signature: `${s.index}:unsettled`, line: `${head} never got a verdict.` });
    }
  }
  return out;
}

/** The person-only steps still waiting for a verdict. */
export const waitingForPerson = (run: QaRun | null): QaStep[] => (run ? run.steps.filter((s) => personOnly(s) && !qaSettled(s.status)) : []);

/** The blocker a subagent reported: a last line "BLOCKED: <kind>: <reason>". */
export function reportedBlocker(report: string): QaBlocker | null {
  const lines = report.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines.reverse()) {
    const m = /^\**BLOCKED\**:\s*(contradiction|outside[_ ]project|needs[_ ]person)\s*:\s*(.+)$/i.exec(line);
    if (!m) continue;
    const kind = m[1].toLowerCase().replace(" ", "_") as "contradiction" | "outside_project" | "needs_person";
    const why = m[2].trim();
    const reason = kind === "contradiction" ? `A step cannot be satisfied: ${why}`
      : kind === "outside_project" ? `The fix needs a change outside the project: ${why}`
      : `Only a person can do this: ${why}`;
    return { kind, reason, evidence: [why] };
  }
  return null;
}

export interface AttemptFacts {
  /** The run this attempt started, read again at its end; null when it started none. */
  run: QaRun | null;
  /** The subagent's final report. */
  report: string;
  /** Calls a guard or Playtest runs refused, described. */
  refusals: string[];
  /** Paths outside the project the attempt wrote, or tried to. */
  outside: string[];
  /** The failing signatures of the attempt before, when there was one. */
  previous: string[] | null;
  /** Whether the attempt changed the project. */
  changed: boolean;
}

export type Decision =
  | { kind: "passed" }
  | { kind: "again"; failing: FailingStep[] }
  | { kind: "blocked"; blocker: QaBlocker; failing: FailingStep[] };

/** What happens after an attempt: done, another attempt, or a blocker for the user. */
export function decide(f: AttemptFacts): Decision {
  const failing = failingSteps(f.run);
  const person = waitingForPerson(f.run);
  if (f.run && failing.length === 0 && person.length === 0) return { kind: "passed" };
  const told = reportedBlocker(f.report);
  if (told) return { kind: "blocked", blocker: told, failing };
  if (f.outside.length) return { kind: "blocked", failing, blocker: { kind: "outside_project", reason: `The fix needs a change outside the project: ${f.outside[0]}`, evidence: f.outside } };
  if (f.refusals.length) return { kind: "blocked", failing, blocker: { kind: "refused", reason: `A call was refused: ${f.refusals[0]}`, evidence: f.refusals } };
  if (failing.length === 0) {
    const s = person[0];
    return { kind: "blocked", failing, blocker: { kind: "verdict", step: s.index, reason: `Every other step passed. Step ${s.index + 1} needs your verdict: ${s.instruction}`, evidence: person.map((p) => `Step ${p.index + 1} (${p.instruction}) is yours to judge.`) } };
  }
  if (f.previous?.length) {
    const now = new Set(failing.map((x) => x.signature));
    if (f.previous.every((sig) => now.has(sig))) {
      const same = failing.filter((x) => f.previous!.includes(x.signature));
      const first = same[0];
      const which = first.index < 0 ? "The playtest did not run" : `Step ${first.index + 1} fails the same way`;
      return {
        kind: "blocked",
        failing,
        blocker: {
          kind: "no_progress",
          ...(first.index >= 0 ? { step: first.index } : {}),
          reason: `No progress: ${which} on two attempts in a row${f.changed ? " after a change" : ", and the last attempt changed nothing"}.`,
          evidence: same.map((x) => x.line),
        },
      };
    }
  }
  return { kind: "again", failing };
}

// ── What the subagent is told ───────────────────────────────────────

/** The most attempts one loop makes before it stops for the user. */
export const MAX_ATTEMPTS = 8;

const BLOCKED_LINES = [
  "If you reach something you cannot fix, stop and end your report with exactly one line:",
  "  BLOCKED: contradiction: <the step, and the design or other step it contradicts>",
  "  BLOCKED: outside_project: <the change needed outside the project>",
  "  BLOCKED: needs_person: <what only a person can do>",
];

/** The first attempt: run the playtest as it is, so the loop sees what fails. */
export function firstBrief(run: QaRun): string {
  return [
    playtestBrief(run),
    "",
    `This is attempt 1 of a loop that makes the playtest pass. Studio runs attempts until every step passes or it stops for the user, at most ${MAX_ATTEMPTS} attempts.`,
    "In this attempt, only run the playtest and report: do not change the project yet. A later attempt fixes what fails.",
    ...BLOCKED_LINES,
  ].join("\n");
}

/** A later attempt: why steps failed, what to change, then run it again. */
export function fixBrief(run: QaRun, n: number, failing: FailingStep[]): string {
  return [
    `The user assigned you the playtest "${run.scriptName}" to make it pass. This is attempt ${n} of a loop: Studio runs attempts until every step passes or it stops for the user, at most ${MAX_ATTEMPTS} attempts.`,
    `The last attempt's run ${run.runId} did not pass:`,
    ...failing.map((f) => `- ${f.line}`),
    "",
    "Fix it:",
    `- Find why each of those steps failed from its evidence. pie.script_results (run_id ${run.runId}) has every step's observed values and captures; read the session's errors and the editor log for the run too.`,
    "- Change what the step points at in the project so it passes: Blueprint, C++, config, input mapping or assets. Save every change.",
    "- Do not edit the playtest script to make a step pass, and do not judge a step the user judges. If a step itself is wrong because it contradicts the design or another step, report it as a blocker instead.",
    "- If you changed C++, rebuild with editor_restart (operation rebuild) before running again.",
    "- Then run the playtest again, as below, and report each step's outcome and what you changed.",
    ...BLOCKED_LINES,
    "",
    playtestBrief(run),
  ].join("\n");
}

// ── Reading what an attempt did ─────────────────────────────────────

/** The tool calls an agent call made, its nested subagents' included. */
export function callsUnder(transcript: TranscriptEntry[], callId: string): Array<Extract<TranscriptEntry, { kind: "tool" }>> {
  const ids = new Set([callId]);
  const out: Array<Extract<TranscriptEntry, { kind: "tool" }>> = [];
  for (const t of transcript) {
    if (t.kind !== "tool" || !t.parent || !ids.has(t.parent)) continue;
    out.push(t);
    if (t.call.name === "agent") ids.add(t.call.id);
  }
  return out;
}

function parsed(result: unknown): Record<string, unknown> | null {
  if (typeof result !== "string" || !result.trimStart().startsWith("{")) return null;
  try {
    const v = JSON.parse(result) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const callName = (t: Extract<TranscriptEntry, { kind: "tool" }>): string => {
  const i = t.call.input as { category?: unknown; method?: unknown };
  return t.call.name === "ue_mcp" && typeof i.category === "string" ? `${i.category}.${String(i.method ?? "")}` : t.call.name;
};

/** Calls a guard or Playtest runs refused, and calls the user declined. */
export function refusalsIn(calls: Array<Extract<TranscriptEntry, { kind: "tool" }>>): string[] {
  const out: string[] = [];
  for (const t of calls) {
    const r = parsed(t.call.result);
    const text = typeof t.call.result === "string" ? t.call.result : "";
    if (t.call.outcome === "declined") out.push(`You declined ${callName(t)}.`);
    else if (r?.blocked === true || (typeof r?.refusedMethod === "string" && r.dialogBlocking !== true)) {
      const why = typeof r?.reason === "string" ? r.reason : typeof r?.error === "string" ? r.error : typeof r?.message === "string" ? r.message : "refused by a guard";
      out.push(`${callName(t)}: ${why}`);
    } else if (text.includes(PLAYTEST_RUNS_REFUSAL)) out.push(`${callName(t)}: ${PLAYTEST_RUNS_REFUSAL}`);
  }
  return out;
}

/** Files the attempt wrote, or tried to, outside the project folder. */
export function outsideWrites(calls: Array<Extract<TranscriptEntry, { kind: "tool" }>>, projectDir: string): string[] {
  const root = path.resolve(projectDir).toLowerCase();
  const out: string[] = [];
  for (const t of calls) {
    if (t.call.name !== "write_file" && t.call.name !== "edit_file") continue;
    const p = (t.call.input as { path?: unknown }).path;
    if (typeof p !== "string") continue;
    const abs = path.resolve(projectDir, p);
    if (!(abs.toLowerCase() + path.sep).startsWith(root + path.sep)) out.push(abs);
  }
  return out;
}

/** Whether a call was a build that failed: a rebuild, a project build or a Live Coding compile. */
export function failedBuilds(calls: Array<Extract<TranscriptEntry, { kind: "tool" }>>): number {
  return calls.filter((t) => {
    const i = t.call.input as { operation?: unknown; method?: unknown };
    const build = (t.call.name === "editor_restart" && i.operation === "rebuild") || (t.call.name === "ue_mcp" && typeof i.method === "string" && /build|compile/i.test(i.method));
    return build && t.call.outcome === "error";
  }).length;
}

// ── The loop ────────────────────────────────────────────────────────

/** What the loop needs from the broker that holds the card. */
export interface LoopCard {
  /** The run that holds the loop now: the card, which each attempt's run takes over. */
  holder(loopId: string): QaRun | undefined;
  /** Read a run again, from ue-mcp. */
  refresh(runId: string): Promise<QaRun | null>;
  /** Save the loop on whichever run holds it. */
  save(loopId: string, loop: QaLoop, state: "running" | "done" | "failed" | "stopped", callId?: string): void;
  transcript(sessionId: string): TranscriptEntry[];
}

/** The checkpoints the loop takes and restores: the review broker. */
export interface LoopCheckpoints {
  checkpoint(label: string): Promise<{ id: string }>;
  changes(from: string, to?: string): Promise<CheckpointChange[]>;
  restore(checkpoint: string, paths?: string[], force?: boolean): Promise<RestoreOutcome & { before: string; after: string }>;
  mark(sessionId: string, m: TimelineMark): void;
}

export interface LoopAgents {
  assign(sessionId: string, description: string, prompt: string): { callId: string; done: Promise<{ isError: boolean; stopped?: boolean; text?: string }> };
  stop(sessionId: string, callId: string): boolean;
}

export interface LoopEvents {
  subscribe(listener: (e: { type: string; data: Record<string, unknown> }) => void): () => void;
}

export interface LoopOptions {
  card: LoopCard;
  checkpoints: LoopCheckpoints;
  agents: LoopAgents;
  events: LoopEvents;
  projectDir: string;
  /** A hard blocker: the card shows Needs you; this tells the user elsewhere. */
  notify: (sessionId: string, loop: QaLoop, run: QaRun) => void;
  now?: () => number;
  log?: { warn(message: string, detail?: unknown): void };
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** One loop, from its first checkpoint to passed, Needs you or stopped. */
export class PlaytestLoop {
  readonly loop: QaLoop;
  private cancelled = false;
  private current: { sessionId: string; callId: string } | null = null;
  /** A blocker found while an attempt ran, which stopped it. */
  private live: QaBlocker | null = null;
  private crashes = 0;
  private builds = 0;
  private readonly now: () => number;
  done: Promise<void> = Promise.resolve();

  constructor(private readonly o: LoopOptions, private readonly sessionId: string, baseline: string, id: string) {
    this.now = o.now ?? Date.now;
    this.loop = { id, state: "running", attempts: [], baseline, startedAt: iso(this.now()) };
  }

  private save(state: "running" | "done" | "failed" | "stopped"): void {
    this.o.card.save(this.loop.id, this.loop, state, this.current?.callId);
  }

  /** Stop the loop at once: the running attempt is stopped, its changes checkpointed so they stay restorable. */
  cancel(): void {
    this.cancelled = true;
    if (this.current) this.o.agents.stop(this.current.sessionId, this.current.callId);
  }

  /** Stop the attempt running for a blocker found while it ran. */
  private trip(b: QaBlocker): void {
    if (this.live || this.cancelled) return;
    this.live = b;
    if (this.current) this.o.agents.stop(this.current.sessionId, this.current.callId);
  }

  start(): Promise<void> {
    this.done = this.run().catch((e) => {
      this.loop.state = "failed";
      this.loop.error = e instanceof Error ? e.message : String(e);
      this.loop.endedAt = iso(this.now());
      this.current = null;
      this.save("failed");
    });
    return this.done;
  }

  private async run(): Promise<void> {
    let previous: string[] | null = null;
    let failing: FailingStep[] = [];
    const seenBuildFailures = new Set<unknown>();
    const unsubscribe = this.o.events.subscribe((e) => {
      if (!this.current) return;
      if (e.type === "editor.disconnected" && e.data.cause === "crashed") {
        this.crashes++;
        this.attemptCrashed = true;
        if (this.crashes >= 2) this.trip({ kind: "crashes", reason: "The editor crashed twice in a row.", evidence: [`Attempt ${this.loop.attempts.length}: the editor crashed again.`] });
      } else if (e.type === "studio.busy.changed") {
        const f = e.data.failure as { op?: unknown; reason?: unknown; at?: unknown } | undefined;
        if (f?.op !== "rebuild" || seenBuildFailures.has(f.at)) return;
        seenBuildFailures.add(f.at);
        this.buildFailed(typeof f.reason === "string" ? f.reason : "the rebuild failed");
      }
    });
    try {
      for (let n = 1; ; n++) {
        if (n > MAX_ATTEMPTS) return this.block({ kind: "attempts", reason: `The playtest still fails after ${MAX_ATTEMPTS} attempts.`, evidence: failing.map((f) => f.line) }, failing);
        if (this.cancelled) return this.stop();
        const run = this.o.card.holder(this.loop.id);
        if (!run) throw new Error("the playtest's card is gone");
        const before = n === 1 ? this.loop.baseline : this.loop.attempts[n - 2].after ?? this.loop.baseline;
        const prompt = n === 1 ? firstBrief(run) : fixBrief(run, n, failing);
        const startRun = run.runId;
        this.attemptCrashed = false;
        this.attemptBuildFailed = false;
        const { callId, done } = this.o.agents.assign(this.sessionId, `${playtestDescription(run)}, attempt ${n}`, prompt);
        const attempt: QaLoopAttempt = { n, callId, before, changes: [], failing: [], startedAt: iso(this.now()) };
        this.loop.attempts.push(attempt);
        this.current = { sessionId: this.sessionId, callId };
        this.save("running");
        const r = await done;
        attempt.endedAt = iso(this.now());
        this.current = null;
        // Every attempt, a stopped one too, ends in a checkpoint, so its changes can be reverted.
        const after = await this.o.checkpoints.checkpoint(`Playtest ${run.scriptName}: attempt ${n}`);
        attempt.after = after.id;
        attempt.changes = (await this.o.checkpoints.changes(before, after.id)).map((c) => ({ path: c.path, status: c.status }));
        this.o.checkpoints.mark(this.sessionId, { checkpoint: after.id, label: `Playtest ${run.scriptName}, attempt ${n}`, at: attempt.endedAt, kind: "attempt" });
        const calls = callsUnder(this.o.card.transcript(this.sessionId), callId);
        if (failedBuilds(calls) > 0) this.buildFailed("a build call failed");
        if (!this.attemptCrashed) this.crashes = 0;
        if (!this.attemptBuildFailed) this.builds = 0;
        if (this.cancelled) return this.stop();
        if (this.live) return this.block(this.live, failing);
        const holder = this.o.card.holder(this.loop.id);
        const ran = holder && holder.runId !== startRun ? (await this.o.card.refresh(holder.runId)) ?? holder : null;
        if (ran) attempt.runId = ran.runId;
        const decision = decide({
          run: ran,
          report: r.text ?? "",
          refusals: refusalsIn(calls),
          outside: outsideWrites(calls, this.o.projectDir),
          previous,
          changed: attempt.changes.length > 0,
        });
        attempt.failing = decision.kind === "passed" ? [] : decision.failing.map((f) => f.line);
        if (decision.kind === "passed") return this.finish();
        if (decision.kind === "blocked") return this.block(decision.blocker, decision.failing);
        failing = decision.failing;
        previous = failing.map((f) => f.signature);
        this.save("running");
      }
    } finally {
      unsubscribe();
    }
  }

  private attemptCrashed = false;
  private attemptBuildFailed = false;

  private buildFailed(why: string): void {
    if (!this.attemptBuildFailed) this.builds++;
    this.attemptBuildFailed = true;
    if (this.builds >= 2) this.trip({ kind: "builds", reason: "A build failed twice in a row.", evidence: [why] });
  }

  private finish(): void {
    this.loop.state = "passed";
    this.loop.endedAt = iso(this.now());
    this.save("done");
  }

  private stop(): void {
    this.loop.state = "stopped";
    this.loop.endedAt = iso(this.now());
    this.save("stopped");
  }

  private block(blocker: QaBlocker, failing: FailingStep[]): void {
    this.loop.state = "needs_you";
    this.loop.blocker = blocker.evidence.length || !failing.length ? blocker : { ...blocker, evidence: failing.map((f) => f.line) };
    this.loop.endedAt = iso(this.now());
    this.save("done");
    const run = this.o.card.holder(this.loop.id);
    if (run) this.o.notify(this.sessionId, this.loop, run);
  }
}

/** The text a Needs you notification carries. */
export function attentionText(run: QaRun, loop: QaLoop): string {
  return `Playtest ${run.scriptName} needs you: ${loop.blocker?.reason ?? "the loop stopped"}`;
}

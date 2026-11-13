/**
 * The session state the daemon works out from the whole transcript and sends
 * with every detail and sync answer, so a client holding only a page of the
 * transcript and a client holding all of it show the same thing: the
 * subagents (their state, current step and thread size), the working line's
 * facts, whether the conversation is being compacted, and the live playtests.
 * The daemon computes it; clients only format it (client-core).
 */
import type { ContextUsage } from "./context.js";
import type { QaRun } from "./qa.js";
import { qaActive, qaNeedsYou } from "./playtests.js";
import type { ToolCallRecord, TranscriptEntry, TurnStatus } from "./index.js";

/** What a subagent is doing now. */
export type AgentState = "queued" | "working" | "approval" | "waiting" | "done" | "failed" | "unknown" | "stopped";

/** One subagent of the session, as every client shows it. */
export interface SessionAgent {
  /** Its agent call's id: the key of its thread, tokens and context. */
  id: string;
  /** The agent call that started it: its task (input), outcome, report and times. */
  call: ToolCallRecord;
  state: AgentState;
  /** The step it runs now, or the one waiting for the user's approval (state approval). */
  step?: ToolCallRecord;
  /** When it last did something: its start, or its newest step's start or end. */
  lastStepAt: string;
  /** The tool calls in its thread. */
  steps: number;
  /** The entries in its thread, for reading it a page at a time (GET .../agents/:id). */
  entries: number;
  /** Input and output tokens it spent. */
  tokens?: number;
  /** Its current context, by its latest request. */
  context?: ContextUsage;
  /** The user has opened its thread. */
  seen: boolean;
  /** The user dismissed it from the thread list (finished ones only). */
  dismissed: boolean;
}

/** The working line's facts: when the running turn started and the main agent's running call. */
export interface WorkingFacts {
  /** The main thread's newest user message: when the turn started. */
  since: string | null;
  /** The main agent's call running now, if its newest line is one. */
  step: Pick<ToolCallRecord, "name" | "input"> | null;
}

/** Everything derived from the whole transcript that a client must not work out from a page of it. */
export interface SessionDerived {
  subagents: SessionAgent[];
  working: WorkingFacts;
  /** The main conversation is being compacted now. */
  compacting: boolean;
  /** The session's playtests that are live or need the user, wherever their card is in the transcript. */
  liveRuns: QaRun[];
}

export interface DeriveContext {
  status: TurnStatus;
  /** Tool call ids waiting for the user's approval. */
  asked: ReadonlySet<string>;
  seen?: readonly string[];
  dismissed?: readonly string[];
  tokens?: Record<string, number>;
  context?: Record<string, ContextUsage>;
}

const timeOf = (t: TranscriptEntry): number =>
  t.kind === "dialog" ? t.dialog.openedAt : t.kind === "qa" ? Date.parse(t.run.seenAt) : t.kind === "review" ? Date.parse(t.review.at) : Date.parse(t.kind === "tool" ? t.call.endedAt ?? t.call.startedAt : t.at);

/**
 * A subagent's state from its call and its own entries: finished by its
 * outcome; queued past the limit of subagents at once; waiting on the user
 * while one of its calls waits for approval (#149); waiting while the session
 * waits for the editor; else working, on its running step if it has one.
 */
function agentOf(call: ToolCallRecord, steps: TranscriptEntry[], ctx: DeriveContext): SessionAgent {
  const calls = steps.flatMap((t) => (t.kind === "tool" ? [t.call] : []));
  const last = Math.max(Date.parse(call.startedAt), ...steps.map(timeOf).filter(Number.isFinite));
  const base = {
    id: call.id,
    call,
    lastStepAt: Number.isFinite(last) ? new Date(last).toISOString() : call.startedAt,
    steps: calls.length,
    entries: steps.length,
    ...(ctx.tokens?.[call.id] !== undefined ? { tokens: ctx.tokens[call.id] } : {}),
    ...(ctx.context?.[call.id] ? { context: ctx.context[call.id] } : {}),
    seen: !!ctx.seen?.includes(call.id),
    dismissed: !!ctx.dismissed?.includes(call.id),
  };
  const finished: Partial<Record<ToolCallRecord["outcome"], AgentState>> = { done: "done", error: "failed", unknown: "unknown", stopped: "stopped", declined: "stopped" };
  const ended = finished[call.outcome];
  if (ended) return { ...base, state: ended };
  if (call.queued) return { ...base, state: "queued" };
  const held = calls.find((c) => c.outcome === "pending" && ctx.asked.has(c.id));
  if (held) return { ...base, state: "approval", step: held };
  if (ctx.status === "waiting") return { ...base, state: "waiting" };
  const running = [...calls].reverse().find((c) => c.outcome === "pending");
  return running ? { ...base, state: "working", step: running } : { ...base, state: "working" };
}

/** Every subagent of the session, in the order they started. */
export function sessionAgents(transcript: readonly TranscriptEntry[], ctx: DeriveContext): SessionAgent[] {
  const byParent = new Map<string, TranscriptEntry[]>();
  for (const t of transcript) if (t.parent) (byParent.get(t.parent) ?? byParent.set(t.parent, []).get(t.parent)!).push(t);
  return transcript.flatMap((t) => (t.kind === "tool" && t.call.name === "agent" ? [agentOf(t.call, byParent.get(t.call.id) ?? [], ctx)] : []));
}

/** The working line's facts, from the main thread's entries. */
export function workingFacts(transcript: readonly TranscriptEntry[]): WorkingFacts {
  let since: string | null = null;
  let step: WorkingFacts["step"] = null;
  let newest = true;
  for (let i = transcript.length - 1; i >= 0; i--) {
    const e = transcript[i];
    if (e.parent) continue;
    if (newest) {
      if (e.kind === "tool" && e.call.outcome === "pending") step = { name: e.call.name, input: e.call.input };
      newest = false;
    }
    if (e.kind === "user") {
      since = e.at;
      break;
    }
  }
  return { since, step };
}

/** The derived state of a session, from its whole transcript. */
export function deriveSession(transcript: readonly TranscriptEntry[], ctx: DeriveContext): SessionDerived {
  return {
    subagents: sessionAgents(transcript, ctx),
    working: workingFacts(transcript),
    compacting: transcript.some((t) => t.kind === "compaction" && !t.parent && t.state === "running"),
    liveRuns: transcript.flatMap((t) => (t.kind === "qa" && (qaActive(t.run) || qaNeedsYou(t.run)) ? [t.run] : [])),
  };
}

/**
 * GET /sessions/:id/agents/:callId[?tail=<n>[&before=<i>]]: one subagent's own
 * entries, whatever part of the main transcript a client holds. `from` is the
 * index of the first in the subagent's thread and `total` its length; without
 * `tail` the thread is whole.
 */
export interface AgentThreadPage {
  entries: TranscriptEntry[];
  from: number;
  total: number;
}

/** A page of a subagent's thread: the `tail` entries ending before `before` (the end when absent). */
export function agentThreadPage(transcript: readonly TranscriptEntry[], callId: string, page: { tail?: number; before?: number } = {}): AgentThreadPage {
  const own = transcript.filter((t) => t.parent === callId);
  const end = Math.min(own.length, Math.max(0, page.before ?? own.length));
  const from = page.tail !== undefined && page.tail > 0 ? Math.max(0, end - page.tail) : 0;
  return { entries: own.slice(from, end), from, total: own.length };
}

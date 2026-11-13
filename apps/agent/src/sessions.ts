/**
 * Conversations on disk, one JSON file per session under the extension's data
 * dir (per project, outside Saved/, which users delete). Every state change is
 * written before it is announced, so a daemon restart resumes exactly where
 * the last write left off.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { COMPACTED_PREFIX, deriveSession, type ContextUsage, type SessionSpend } from "@ue-mcp-studio/shared";
import type { TurnFacts, ApprovalRequest, QueuedMessage, SessionDetail, SessionSummary, TimelineMark, TouchedItem, TranscriptEntry, TurnStatus } from "@ue-mcp-studio/shared";
import type { MessageParam } from "./providers.js";
import { modelName } from "./models.js";
import type { ToolImage } from "./images.js";
import { conversationText, estimateMessagesTokens, isCompactedSummary } from "./compaction.js";

/** An agent's context as kept on disk: `messages` is how many of its messages the measurement covers; `sdk`, measured by the Claude sign-in's runtime. */
export type StoredContext = ContextUsage & { messages?: number; sdk?: boolean };

/** A tool call the model asked for that has not been answered yet. */
export interface PendingTool {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** running survives a crash or restart only as unknown: whether it took effect is not known. */
  state: "queued" | "running" | "unknown" | "done";
  result?: string;
  /** The result as the model is given it, when that differs from result. */
  modelResult?: string;
  isError?: boolean;
  /** Images that go to the model with the result. */
  images?: ToolImage[];
}

export interface StoredSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: TurnStatus;
  waitingCause: string | null;
  error: string | null;
  draft: string;
  /** The subagent threads the user has opened, so a finished one is marked new only until then. */
  seen?: string[];
  /** Finished subagents the user dismissed from the thread list. */
  dismissed?: string[];
  /** Messages written while a turn ran, sent in order as each turn ends. */
  queue?: QueuedMessage[];
  /**
   * The main agent takes the user's message now: its subagents are working
   * and it waits only on them, or its reply ended while they work on, on any route.
   */
  mainFree?: boolean;
  /**
   * A Claude sign-in reply running in a host process: the last host event
   * applied and the reply's own bookkeeping, so the next daemon replays from there.
   */
  hostTurn?: { seq: number; lastId: string | null; background: string[] };
  /**
   * Each subagent still running, by agent call id, as a restart needs it: in
   * the background (its call answered already), started by the user, the last
   * host event applied when its conversation runs in a turn host, and its
   * conversation so far when it runs on Studio's loop, which a restart resumes.
   */
  agentRuns?: Record<string, { background: boolean; assigned: boolean; seq?: number; messages?: MessageParam[]; told?: string[] }>;
  /** The conversation as the model sees it. */
  messages: MessageParam[];
  /** The conversation as the UI shows it. */
  transcript: TranscriptEntry[];
  touched: TouchedItem[];
  pending: PendingTool[] | null;
  /** System notes waiting to be given to the model with the next tool results or user message. */
  notes: string[];
  /** The editor crashed since the last reconcile. */
  crashed: boolean;
  /** Hidden from the session list until restored. */
  archived?: boolean;
  /** The Agent SDK session a Claude subscription turn continues. */
  sdkSession?: string | null;
  /** Earlier Agent SDK sessions of this conversation, removed with it. */
  sdkPast?: string[];
  /** Turns ran on another model since the SDK session last saw the conversation. */
  offClaude?: boolean;
  /** The user edited a message and the conversation was cut back to it; the next Claude session starts quietly. */
  rewound?: boolean;
  /** The model and the way it was reached for the last turn. */
  model?: string;
  route?: string | null;
  /** Calls waiting for the user to allow them. Only the running daemon can answer one. */
  approvals?: ApprovalRequest[];
  /** Kinds of call the user allowed for the rest of the session: shell, edit. */
  allowed?: string[];
  /** What the latest turn did, from its tool calls. */
  turn?: TurnFacts;
  /** Input and output tokens each agent spent: "main", or a subagent's agent call id. */
  tokens?: Record<string, number>;
  /** Each agent's context by its latest request: "main", or a subagent's agent call id. */
  context?: Record<string, StoredContext>;
  /** What every request of the session spent together. */
  totals?: SessionSpend;
  /** Per-turn review: this session's switch, null or absent for the Settings default. */
  review?: boolean | null;
  /** The checkpoint taken before the turn in progress, while review is on. */
  reviewing?: { before: string; turn: number } | null;
  /** The session's checkpoints, oldest first. */
  timeline?: TimelineMark[];
}

/** Whether a call saved a playtest: pie(script_create), or a run of the playtest flow. */
function playtestCall(t: TranscriptEntry): boolean {
  if (t.kind === "playtest") return true;
  if (t.kind !== "tool" || t.call.name !== "ue_mcp") return false;
  const i = (t.call.input ?? {}) as { action?: unknown; category?: unknown; method?: unknown; args?: { flowName?: unknown } };
  if (i.action !== "call") return false;
  return (i.category === "pie" && i.method === "script_create") || (i.category === "flow" && i.method === "run" && i.args?.flowName === "playtest");
}

/** A turn's facts, with whether any call in it, a subagent's included, saved a playtest. */
export function turnFacts(transcript: TranscriptEntry[], turn: TurnFacts): TurnFacts {
  return { ...turn, playtest: turn.playtest || transcript.slice(turn.start).some(playtestCall) };
}

function agentCounts(s: StoredSession): { total: number; running: number } {
  let total = 0;
  let running = 0;
  for (const t of s.transcript) {
    if (t.kind !== "tool" || t.call.name !== "agent") continue;
    total++;
    if (t.call.outcome === "pending" && !t.call.queued) running++;
  }
  return { total, running };
}

/** A user message that answers tool calls, as opposed to one the user sent. */
const isToolResults = (m: MessageParam): boolean =>
  Array.isArray(m.content) && m.content.some((b) => (b as { type?: string }).type === "tool_result");

/** A session's title until its first message names it. */
export const DEFAULT_SESSION_TITLE = "New session";

export class SessionStore {
  private readonly dir: string;
  private readonly cache = new Map<string, StoredSession>();

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "sessions");
    fs.mkdirSync(this.dir, { recursive: true });
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const s = JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf-8")) as StoredSession;
        // A blank session written by an earlier version: nothing to keep.
        if (SessionStore.isBlank(s)) fs.rmSync(path.join(this.dir, f), { force: true });
        else this.cache.set(s.id, s);
      } catch {
        // A half-written file from a crash mid-write: the rename never happened, so the previous version is the .json.
      }
    }
  }

  create(title = DEFAULT_SESSION_TITLE): StoredSession {
    const now = new Date().toISOString();
    const s: StoredSession = {
      id: crypto.randomUUID(),
      title,
      createdAt: now,
      updatedAt: now,
      status: "idle",
      waitingCause: null,
      error: null,
      draft: "",
      messages: [],
      transcript: [],
      touched: [],
      pending: null,
      notes: [],
      crashed: false,
    };
    this.save(s);
    return s;
  }

  /** A session for New: the blank one there is, so pressing New again makes no second one (#140). */
  blank(): StoredSession {
    return this.all().find(SessionStore.isBlank) ?? this.create();
  }

  /** Nothing written in it yet: no message, draft, queue, note or name of its own. */
  static isBlank(s: StoredSession): boolean {
    return s.title === DEFAULT_SESSION_TITLE && s.transcript.length === 0 && s.messages.length === 0 && !s.draft.trim()
      && !s.queue?.length && !s.notes.length && !s.touched.length;
  }

  get(id: string): StoredSession | undefined {
    return this.cache.get(id);
  }

  all(): StoredSession[] {
    return [...this.cache.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /**
   * Write through a rename, so a reader or a restart never sees half a session.
   * A blank one stays in memory only, so sessions opened and left do not pile up.
   */
  save(s: StoredSession, opts: { touch?: boolean } = {}): void {
    // touch: false is bookkeeping, such as the crash flag, which must not move the session up the list (#144).
    if (opts.touch !== false) s.updatedAt = new Date().toISOString();
    this.cache.set(s.id, s);
    const file = path.join(this.dir, `${s.id}.json`);
    if (SessionStore.isBlank(s)) {
      fs.rmSync(file, { force: true });
      return;
    }
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, file);
  }

  /**
   * Take finished subagents off the thread list. Only agent calls that have
   * ended can go: a running one keeps its row and its stop button. Returns the
   * ids it dismissed now.
   */
  static dismiss(s: StoredSession, ids: readonly string[]): string[] {
    const finished = new Set(s.transcript.flatMap((t) => (t.kind === "tool" && t.call.name === "agent" && t.call.outcome !== "pending" ? [t.call.id] : [])));
    const had = new Set(s.dismissed ?? []);
    const added = [...new Set(ids)].filter((id) => finished.has(id) && !had.has(id));
    if (added.length) s.dismissed = [...had, ...added];
    return added;
  }

  /**
   * Cut the conversation back to just before one of the user's messages, by
   * its transcript index: that message and everything after it go, in the
   * transcript and in what the model is sent. The Claude sign-in's own
   * session is let go, so the next turn there starts fresh from what is kept.
   * Returns the removed message, or null when the index is not a user message.
   */
  static truncateAt(s: StoredSession, index: number): Extract<TranscriptEntry, { kind: "user" }> | null {
    const entry = s.transcript[index];
    if (!entry || entry.kind !== "user" || entry.parent) return null;
    // A compaction rewrote what the model is sent: messages from before it live on only in its summary.
    const rewrote = (t: TranscriptEntry) => t.kind === "compaction" && !t.parent && t.state === "done" && t.method !== "runtime";
    let since = -1;
    for (let i = 0; i < index; i++) if (rewrote(s.transcript[i])) since = i;
    const compactedAfter = s.transcript.slice(index + 1).some(rewrote);
    if (compactedAfter) {
      // The edited message is inside a summary: the model starts again from the transcript up to it.
      const text = conversationText(transcriptMessages(s.transcript.slice(0, index)), 200_000);
      s.messages = text ? [
        { role: "user", content: [{ type: "text", text: `${COMPACTED_PREFIX} when the user edited an earlier message. The conversation up to that message:

${text}` }] } as MessageParam,
        { role: "assistant", content: [{ type: "text", text: "I have the conversation so far." }] } as MessageParam,
      ] : [];
    } else {
      // The k-th message the user sent since the last compaction is the k-th user message that is neither tool results nor its summary.
      const k = s.transcript.slice(since + 1, index).filter((t) => t.kind === "user" && !t.parent).length;
      let seen = 0;
      let cut = s.messages.length;
      for (let i = 0; i < s.messages.length; i++) {
        const m = s.messages[i];
        if (m.role !== "user" || isToolResults(m) || isCompactedSummary(m)) continue;
        if (seen++ === k) {
          cut = i;
          break;
        }
      }
      s.messages = s.messages.slice(0, cut);
    }
    s.transcript = s.transcript.slice(0, index);
    // What was measured covered the messages that are gone.
    if (s.context) s.context = {};
    s.pending = null;
    s.approvals = [];
    s.error = null;
    const kept = new Set(s.transcript.flatMap((t) => (t.kind === "tool" ? [t.call.id] : [])));
    if (s.seen) s.seen = s.seen.filter((id) => kept.has(id));
    if (s.dismissed) s.dismissed = s.dismissed.filter((id) => kept.has(id));
    if (s.sdkSession) s.sdkPast = [...(s.sdkPast ?? []), s.sdkSession];
    s.sdkSession = null;
    s.offClaude = false;
    s.rewound = true;
    return entry;
  }

  delete(id: string): boolean {
    const had = this.cache.delete(id);
    const file = path.join(this.dir, `${id}.json`);
    if (!fs.existsSync(file)) return had;
    fs.rmSync(file);
    return true;
  }

  static summary(s: StoredSession): SessionSummary {
    return {
      id: s.id, title: s.title, status: s.status, createdAt: s.createdAt, updatedAt: s.updatedAt, waitingCause: s.waitingCause, archived: !!s.archived,
      agents: agentCounts(s), awaiting: s.approvals?.length ?? 0,
      ...(s.model ? { model: modelName(s.model) } : {}), ...(s.route ? { route: s.route } : {}),
    };
  }

  static detail(s: StoredSession): SessionDetail {
    // What a client must not work out from the page of the transcript it holds: from the whole one, here.
    const derived = deriveSession(s.transcript, { status: s.status, asked: new Set((s.approvals ?? []).map((a) => a.toolUseId)), seen: s.seen, dismissed: s.dismissed, tokens: s.tokens, context: publicContext(s) });
    return { ...SessionStore.summary(s), ...derived, transcript: s.transcript, touched: s.touched, draft: s.draft, seen: s.seen ?? [], dismissed: s.dismissed ?? [], queue: s.queue ?? [], ...(s.mainFree && (s.status === "running" || s.status === "waiting") ? { mainFree: true } : {}), error: s.error, approvals: s.approvals ?? [], ...(s.turn ? { turn: turnFacts(s.transcript, s.turn) } : {}), review: s.review ?? null, timeline: s.timeline ?? [], tokens: s.tokens ?? {}, context: publicContext(s), ...(s.totals ? { totals: s.totals } : {}) };
  }
}

/** Estimates of conversations no request has measured, by session, while their length stays the same. */
const estimates = new Map<string, { length: number; tokens: number }>();

/**
 * The contexts as the client reads them, without the bookkeeping. A session
 * from before Studio measured context gets an estimate from its messages,
 * marked as one, until its next request measures it.
 */
function publicContext(s: StoredSession): Record<string, ContextUsage> {
  const out: Record<string, ContextUsage> = {};
  for (const [k, v] of Object.entries(s.context ?? {})) {
    const { messages: _m, sdk: _s, ...rest } = v;
    out[k] = rest;
  }
  if (!out.main && s.messages.length > 0) {
    let e = estimates.get(s.id);
    if (!e || e.length !== s.messages.length) estimates.set(s.id, (e = { length: s.messages.length, tokens: estimateMessagesTokens(s.messages) }));
    out.main = { input: e.tokens, cached: 0, output: 0, model: s.model ?? "", at: s.updatedAt, estimated: true };
  }
  return out;
}

/** The main thread's transcript as messages, for a conversation rebuilt from what the user sees. */
function transcriptMessages(transcript: readonly TranscriptEntry[]): MessageParam[] {
  const out: MessageParam[] = [];
  for (const t of transcript) {
    if (t.parent) continue;
    if (t.kind === "user") out.push({ role: "user", content: [{ type: "text", text: t.text }] } as MessageParam);
    else if (t.kind === "assistant") out.push({ role: "assistant", content: [{ type: "text", text: t.text }] } as MessageParam);
    else if (t.kind === "compaction" && t.summary) out.push({ role: "user", content: [{ type: "text", text: `Summary of the conversation before this point: ${t.summary}` }] } as MessageParam);
    else if (t.kind === "tool") out.push({ role: "assistant", content: [{ type: "tool_use", id: t.call.id, name: t.call.name, input: t.call.input }] } as MessageParam, { role: "user", content: [{ type: "tool_result", tool_use_id: t.call.id, content: t.call.result ?? "" }] } as MessageParam);
  }
  return out;
}

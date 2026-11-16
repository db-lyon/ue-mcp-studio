/**
 * The durable runtime as the daemon runs it: a session whose route has the
 * setting on runs its main agent and its subagents in the durable harness,
 * and everything the clients see is what every other route writes. The
 * harness's committed entries become the same transcript entries, its partial
 * answers the same turn.delta events, its tool calls run through the same
 * editor wait, approval gate and executor (AgentRunner's), and its subagents
 * are the same agent runs with the same slots, messages and stops. The
 * session API, SessionDetail and paging do not change.
 *
 * A session runs on one runtime at a time. It moves to this one when its
 * route's setting is on and it starts a reply: its conversation so far is
 * written into the harness first (seed), and from then on the harness holds
 * the only copy of it (#463 L1). The transcript is a projection of the
 * harness's entries through the `applied` cursor, which sync replays. It
 * moves back when the setting is off, with its conversation rebuilt from the
 * harness's entries (history), or from the transcript.
 */
import * as crypto from "node:crypto";
import type { TranscriptEntry } from "@ue-mcp-studio/shared";
import type { AgentHost, ToolExecution } from "../tools.js";
import { transcriptMessages, type PendingTool, type SessionStore, type StoredSession } from "../sessions.js";
import type { MessageParam } from "../providers.js";
import type { TokenUsage } from "../usage.js";
import { isContextOverflow } from "../compaction.js";
import { HarnessClient, type HarnessClientOptions } from "./client.js";
import type { AgentSpec, AgentStart, EntryEvent, HarnessMessage, HarnessRequest, LedgerUsage, LocalGate, LocalOutcome, UserContent } from "./protocol.js";

/** How long a reply waits for a run it just stopped to report its end, before it starts anyway. */
const STOP_END_WAIT_MS = 3000;

/**
 * Why a reply ended without an answer, and the way on from there: a run never
 * ends at a dead end. A full conversation is compacted and continued; any
 * other failure is retried by sending the next message, which picks the
 * conversation up where it stopped.
 */
export function replyFailure(reason: string, detail?: string): string {
  const what = `The reply ended without an answer (${reason})${detail ? `: ${detail}` : ""}.`;
  if (isContextOverflow(new Error(`${reason} ${detail ?? ""}`)) || /context|too long|window/i.test(`${reason} ${detail ?? ""}`)) {
    return `${what} The conversation is too long for the model. Use Compact now (or send /compact), then send your message again to go on from the summary; or start a new session and paste what it needs.`;
  }
  return `${what} Nothing is lost: send a message (or "continue") to retry, and the reply goes on from where it stopped. Stop ends a run that keeps going.`;
}

/** What the runtime needs of AgentRunner: the paths every route goes through. */
export interface DurableHooks {
  host: AgentHost;
  store: SessionStore;
  addEntry(s: StoredSession, e: TranscriptEntry): void;
  recordOutcome(s: StoredSession, p: PendingTool, outcome: "done" | "error" | "unknown" | "stopped" | "declined"): void;
  setStatus(s: StoredSession, status: StoredSession["status"], cause: string | null): void;
  /** One of Studio's tools, as AgentRunner runs every route's: editor wait, gate, call, outcome. `onStart` runs once it is past the gate. */
  runTool(s: StoredSession, controller: AbortController, callId: string, name: string, input: Record<string, unknown>, onStart: () => Promise<boolean>, parent: string | null): Promise<ToolExecution>;
  lostCall(s: StoredSession, callId: string, name: string, input: Record<string, unknown>): Promise<ToolExecution>;
  /** #463 L3: a local call the harness runs: may it run (the approval gate and the input check)? */
  gateLocal(s: StoredSession, callId: string, name: string, input: Record<string, unknown>, parent: string | null, signal: AbortSignal): Promise<LocalGate>;
  /** It ended in the harness: recorded as every route records a call, and what the model is given back. */
  finishLocal(s: StoredSession, callId: string, name: string, input: Record<string, unknown>, parent: string | null, result: LocalOutcome): ToolExecution;
  /** What it is printing meanwhile. */
  localOutput(s: StoredSession, callId: string, text: string): void;
  replyToUser(s: StoredSession, callId: string, input: Record<string, unknown>): ToolExecution;
  skill(name: unknown): { text: string; isError: boolean };
  /** Count a request's spend for the main agent (null) or a subagent. */
  spent(s: StoredSession, agent: string | null, u: TokenUsage, model: string, tokens?: boolean): void;
  /** Count tokens and cost from a spend ledger, without a request: the entries count those. */
  spentLedger(s: StoredSession, agent: string | null, u: TokenUsage, model: string): void;
  canon(name: string, input: Record<string, unknown>): { name: string; input: Record<string, unknown> };
  replyEnded(s: StoredSession, error: string | null): void;
  replying: Set<string>;
  active: Map<string, AbortController>;
  refreshFree(s: StoredSession): void;
  /** An agent call's subagent: registered as an agent run, given its slot, and what it runs with. */
  agentStart(s: StoredSession, callId: string, input: Record<string, unknown>, signal: AbortSignal, say: (text: string) => Promise<boolean>, stop: () => void): Promise<AgentStart>;
  /** An agent call's subagent ended: its run is let go, its call answered, its unread messages accounted for. */
  agentEnded(s: StoredSession, callId: string, r: { text: string; isError: boolean; stopped: boolean }, background: boolean): void;
  /** The agent runs of a session that are still going (in the background ones too). */
  runningAgents(s: StoredSession): string[];
  deliver(s: StoredSession, callId: string, n: number, to: "read" | "main"): void;
  mainSpec(): AgentSpec;
  credential(route: string): Promise<string | null>;
}

/** What a session keeps of its durable conversation. `key` names its conversation in the harness; an edit starts a new one. */
export interface DurableState {
  key: string;
  /** The last entry applied, per harness conversation. */
  applied: Record<string, string>;
  /** Subagent conversations by agent call. */
  children: Record<string, string>;
  /** The conversation before the move was written into it. */
  seeded: boolean;
  /** The spend ledger totals last counted, per harness conversation and provider/model. */
  usage?: Record<string, Record<string, LedgerUsage>>;
  /** The conversation lives in the harness only: Studio keeps no copy in s.messages, and rebuilds one when the session leaves. Absent: an earlier Studio's session, which still has its copy. */
  only?: boolean;
}

const keyOf = (s: StoredSession): string => s.durable!.key;

/** Studio's content blocks (the Messages format) as pi-ai's user content. */
export function userContent(content: unknown[]): UserContent {
  const out: Exclude<UserContent, string> = [];
  for (const b of content as Array<Record<string, unknown>>) {
    if (b.type === "text" && typeof b.text === "string") out.push({ type: "text", text: b.text });
    else if (b.type === "image") {
      const src = b.source as { type?: string; data?: string; media_type?: string } | undefined;
      if (src?.type === "base64" && src.data) out.push({ type: "image", data: src.data, mimeType: src.media_type ?? "image/png" });
    } else if (b.type === "document") out.push({ type: "text", text: `[A document was attached: ${String((b as { title?: unknown }).title ?? "untitled")}]` });
  }
  return out.length ? out : "";
}

/** The conversation so far as text messages, for a session that moves onto this runtime. */
export function seedMessages(messages: MessageParam[]): Array<{ role: "user" | "assistant"; text: string }> {
  const out: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const m of messages) {
    const parts = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as Array<{ type: string; text?: string; name?: string; input?: unknown; content?: unknown }>);
    const lines: string[] = [];
    for (const p of parts) {
      if (p.type === "text" && p.text?.trim()) lines.push(p.text.trim());
      else if (p.type === "tool_use" && p.name) lines.push(`(called ${p.name} ${JSON.stringify(p.input ?? {}).slice(0, 300)})`);
      else if (p.type === "tool_result") {
        const c = typeof p.content === "string" ? p.content : Array.isArray(p.content) ? (p.content as Array<{ text?: string }>).map((x) => x.text ?? "").join("") : "";
        if (c.trim()) lines.push(`(tool result: ${c.trim().slice(0, 600)})`);
      }
    }
    if (!lines.length) continue;
    const role = m.role === "assistant" ? "assistant" : "user";
    const last = out[out.length - 1];
    if (last?.role === role) last.text += `\n\n${lines.join("\n")}`;
    else out.push({ role, text: lines.join("\n") });
  }
  // A conversation starts with the user.
  while (out[0]?.role === "assistant") out.shift();
  return out;
}

/** A background note in an agent call's result: its subagent goes on, and reports later. */
const isBackgroundNote = (text: string): boolean => /^The subagent ".*" keeps working in the background/s.test(text);

export class DurableTurns {
  readonly client: HarnessClient;
  /** Each session's own stop for its tool calls, beside its reply's: the calls of a subagent the main agent left run on it. */
  private readonly controllers = new Map<string, AbortController>();
  /** Tool runs in this daemon by request, with how to stop each when the harness withdraws it. */
  private readonly running = new Map<string, { sessionId: string; controller: AbortController; executing: boolean }>();
  /** The text of each session's current answer already sent as deltas. */
  private readonly sent = new Map<string, string>();
  /** The main agent's thinking already published as turn.thinking, per session. */
  private readonly thought = new Map<string, string>();
  /** Sessions being stopped by the user: their run's end is not a reply ending. */
  private readonly stopping = new Set<string>();
  /** A reply waiting for a stopped run's end before it starts, by session. */
  private readonly stopEnded = new Map<string, () => void>();
  /** The stop sent to the harness per session, answered once its runs have stopped and their ends were sent. */
  private readonly aborting = new Map<string, Promise<unknown>>();
  private disposed = false;

  constructor(private readonly h: DurableHooks, opts: Omit<HarnessClientOptions, "onMessage" | "onConnection" | "log">) {
    this.client = new HarnessClient({
      ...opts,
      log: h.host.log,
      onMessage: (m) => this.received(m),
      onConnection: (up) => {
        if (up) void this.resync();
      },
    });
  }

  available(): boolean {
    return this.client.available();
  }

  /** The session runs on this runtime now: its conversation lives in the harness. */
  owns(s: StoredSession): boolean {
    return !!s.durable;
  }

  private session(key: string): StoredSession | null {
    const s = this.h.store.get(key.split("~")[0]);
    return s && s.durable?.key === key ? s : null;
  }

  private controller(s: StoredSession): AbortController {
    let c = this.controllers.get(s.id);
    if (!c || c.signal.aborted) this.controllers.set(s.id, (c = new AbortController()));
    return c;
  }

  /**
   * The main agent replies to `content` on this runtime: a new run, or, when
   * one is running (the main agent waits only on subagents), steered into it.
   */
  async reply(s: StoredSession, content: unknown[]): Promise<void> {
    if (this.stopping.has(s.id)) {
      // A run just stopped (Send now, an edit): its end can still be on its way, and must not be taken for this reply's end.
      // A harness that settles its stops sends that end before it answers the stop, so once the stop is answered
      // nothing more is coming; with an older one, wait for the end a little while.
      const settled = this.client.harness?.features.includes("abortSettles") ? this.aborting.get(s.id) : undefined;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, STOP_END_WAIT_MS);
        const done = () => {
          clearTimeout(t);
          resolve();
        };
        this.stopEnded.set(s.id, done);
        void settled?.then(done, done);
      });
      this.aborting.delete(s.id);
      this.stopEnded.delete(s.id);
      this.stopping.delete(s.id);
    }
    const controller = new AbortController();
    this.h.active.set(s.id, controller);
    this.h.replying.add(s.id);
    this.controller(s);
    try {
      // The conversation so far, without the message this reply answers.
      await this.move(s, s.messages.slice(0, -1));
      await this.client.call("submit", { sessionId: keyOf(s), requestId: crypto.randomUUID(), content: userContent(content), agent: this.h.mainSpec(), whenBusy: "steer" });
    } catch (e) {
      if (this.h.active.get(s.id) === controller) this.h.active.delete(s.id);
      this.h.replyEnded(s, `The durable runtime could not start the reply: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * The session moves onto this runtime: its conversation so far (`earlier`)
   * is written into the harness once. From then on the harness holds the only
   * copy: s.messages is emptied, the message being sent included, since it goes
   * to the harness next.
   */
  private async move(s: StoredSession, earlier: MessageParam[]): Promise<void> {
    s.durable ??= { key: `${s.id}~${crypto.randomUUID()}`, applied: {}, children: {}, seeded: false };
    this.h.store.save(s);
    if (!s.durable.seeded) {
      const messages = seedMessages(earlier);
      if (messages.length) await this.client.call("seed", { sessionId: keyOf(s), messages });
      s.durable.seeded = true;
    }
    s.messages = [];
    s.durable.only = true;
    this.h.store.save(s);
  }

  /**
   * A subagent the user assigned from the chat runs in the harness, beside
   * the main agent's runs, and reports to Studio when it ends (agentEnd).
   * False, with nothing sent, when the running harness is older than the
   * message: the subagent then runs on Studio's loop.
   */
  async assign(s: StoredSession, callId: string, start: Extract<AgentStart, { ok: true }>): Promise<boolean> {
    await this.client.ensure();
    if ((this.client.harness?.protocol ?? 1) < 2) return false;
    await this.move(s, s.messages);
    this.controller(s);
    await this.client.call("assign", { sessionId: keyOf(s), callId, start });
    return true;
  }

  /** The user's message to a main agent that waits only on its subagents: they go on in the background, and it reads the message next. */
  async tell(s: StoredSession, content: unknown[]): Promise<boolean> {
    if (!s.durable) return false;
    try {
      if (this.h.replying.has(s.id)) await this.client.call("background", { sessionId: keyOf(s) });
      else {
        this.h.replying.add(s.id);
        this.h.active.set(s.id, new AbortController());
      }
      await this.client.call("submit", { sessionId: keyOf(s), requestId: crypto.randomUUID(), content: userContent(content), agent: this.h.mainSpec(), whenBusy: "steer" });
      return true;
    } catch (e) {
      this.h.host.log.warn(`session ${s.id}: the durable runtime did not take the message`, e);
      return false;
    }
  }

  /** The main agent's foreground subagents go on in the background. */
  background(s: StoredSession): void {
    if (s.durable) void this.client.call("background", { sessionId: keyOf(s) }).catch((e) => this.h.host.log.warn(`session ${s.id}: background failed`, e));
  }

  /** Stop the main agent's run; with `children`, every subagent too. Calls waiting on the daemon are answered as stopped. */
  stop(s: StoredSession, children: boolean): void {
    if (!s.durable) return;
    this.stopping.add(s.id);
    if (children) this.controllers.get(s.id)?.abort();
    const call = this.client.call("abort", { sessionId: keyOf(s), children }).catch((e) => this.h.host.log.warn(`session ${s.id}: stopping in the durable runtime failed`, e));
    this.aborting.set(s.id, call);
  }

  stopChild(s: StoredSession, callId: string): void {
    if (s.durable) void this.client.call("stopChild", { sessionId: keyOf(s), callId }).catch((e) => this.h.host.log.warn(`session ${s.id}: stopping subagent ${callId} failed`, e));
  }

  async compact(s: StoredSession, instructions: string): Promise<void> {
    if (s.durable) await this.client.call("compact", { sessionId: keyOf(s), instructions });
  }

  /**
   * The session leaves this runtime (a reply on another one), or its
   * conversation was cut back (an edited message that could not fork): its
   * next reply here starts a new durable conversation. Studio keeps no copy of
   * a conversation the harness held alone, so one is rebuilt first, in front
   * of what s.messages holds now (the message being sent): from the harness's
   * entries (`from` "harness": tool calls, results and summaries included), or
   * from the transcript when the harness cannot answer or the conversation was
   * cut back ("transcript").
   */
  async release(s: StoredSession, from: "harness" | "transcript"): Promise<void> {
    if (!s.durable) return;
    if (s.durable.only) {
      let earlier: MessageParam[] | null = null;
      if (from === "harness") {
        try {
          await this.client.ensure();
          if (this.client.harness?.features.includes("history")) earlier = (await this.client.call("history", { sessionId: keyOf(s) }, 10_000)) as MessageParam[] | null;
        } catch (e) {
          this.h.host.log.warn(`session ${s.id}: its conversation could not be read from the durable harness, so it is rebuilt from the transcript`, e);
        }
      }
      if (!earlier) {
        // The message being sent is in the transcript already, as its last message from the user: it stays in s.messages only.
        let upTo = s.transcript.length;
        if (s.messages.length) for (let i = s.transcript.length - 1; i >= 0; i--) if (s.transcript[i].kind === "user" && !s.transcript[i].parent) { upTo = i; break; }
        earlier = transcriptMessages(s.transcript.slice(0, upTo));
      }
      s.messages = [...earlier, ...s.messages];
    }
    delete s.durable;
    this.h.store.save(s);
  }

  /**
   * An edited message (`to` is `from`, cut back) or a fork (`to` is the copy):
   * `to`'s next reply goes on in a fork of `from`'s durable conversation taken
   * just before the edited message, so the model keeps every tool call, result
   * and image before it. `text` is the message as first sent and `fromEnd` how
   * many later messages of the main agent have the same text. False when that
   * cannot be done (no durable conversation, a message it never got, a harness
   * from an older Studio): the caller releases `to`, and its next reply starts
   * from Studio's own copy as before.
   */
  async forkTo(from: StoredSession, to: StoredSession, text: string, fromEnd: number): Promise<boolean> {
    if (!from.durable) return false;
    const key = `${to.id}~${crypto.randomUUID()}`;
    let r: { conv: string; at: string } | null = null;
    try {
      await this.client.ensure();
      r =(await this.client.call("fork", { from: keyOf(from), to: key, text, fromEnd }, 5000)) as { conv: string; at: string } | null;
    } catch (e) {
      this.h.host.log.warn(`session ${from.id}: forking its durable conversation failed, so the next reply starts from Studio's copy`, e);
    }
    if (!r?.conv) return false;
    // An edit in place keeps its harness-only conversation; a fork's copy has the copy of the transcript rebuilt into its s.messages.
    to.durable = { key, applied: { [r.conv]: r.at }, children: {}, seeded: true, ...(to === from && from.durable.only ? { only: true } : {}) };
    // A run stopped by the edit ended in the old conversation; the new one has nothing running to wait for.
    if (this.stopping.delete(to.id)) this.stopEnded.get(to.id)?.();
    this.h.store.save(to);
    return true;
  }

  /** How the user's message reaches a running subagent's conversation. */
  sayTo(s: StoredSession, callId: string): (text: string) => Promise<boolean> {
    return async (text) => {
      if (!s.durable) return false;
      return !!(await this.client.call("tell", { sessionId: keyOf(s), callId, text, requestId: crypto.randomUUID() }).catch(() => false));
    };
  }

  /** After a daemon restart: connect, and take what happened meanwhile. */
  reattach(s: StoredSession): void {
    if (!s.durable) return;
    if (s.status === "running" || s.status === "waiting") {
      this.h.replying.add(s.id);
      this.h.active.set(s.id, new AbortController());
    }
    void this.client.ensure().catch((e) => {
      this.h.host.log.warn(`session ${s.id}: the durable harness is not reachable`, e);
    });
  }

  /** Whether a daemon restart now would cut a tool call off: one running in this daemon for the session. */
  pinned(sessionId: string): boolean {
    for (const r of this.running.values()) if (r.sessionId === sessionId && r.executing) return true;
    return false;
  }

  dispose(): void {
    this.disposed = true;
    this.client.close();
  }

  /** Catch up every session on this runtime that has work open, after a (re)connection. */
  private async resync(): Promise<void> {
    for (const s of this.h.store.all()) {
      if (!s.durable) continue;
      const open = s.status === "running" || s.status === "waiting" || this.h.runningAgents(s).length > 0;
      if (!open) continue;
      try {
        await this.client.call("sync", { sessionId: keyOf(s), after: s.durable.applied });
      } catch (e) {
        this.h.host.log.warn(`session ${s.id}: catching up from the durable harness failed`, e);
      }
    }
  }

  private received(m: HarnessMessage): void {
    if (this.disposed) return;
    switch (m.t) {
      case "entry":
        return this.entry(m);
      case "delta": {
        const s = this.session(m.sessionId);
        if (!s || m.parent) return;
        const before = this.sent.get(s.id) ?? "";
        const add = m.text.startsWith(before) ? m.text.slice(before.length) : m.text;
        this.sent.set(s.id, m.text);
        if (add) this.h.host.events.publish("turn.delta", { sessionId: s.id, text: add });
        if (m.thinking) {
          // The thinking so far, as what was added; `reset` when a new answer's thinking starts over.
          const had = this.thought.get(s.id) ?? "";
          const more = m.thinking.startsWith(had) ? m.thinking.slice(had.length) : m.thinking;
          this.thought.set(s.id, m.thinking);
          if (more) this.h.host.events.publish("turn.thinking", { sessionId: s.id, text: more, ...(m.thinking.startsWith(had) ? {} : { reset: true }) });
        }
        return;
      }
      case "run":
        return this.run(m);
      case "usage":
        return this.ledger(m);
      case "child": {
        const s = this.session(m.sessionId);
        if (!s?.durable || s.durable.children[m.callId] === m.conv) return;
        s.durable.children[m.callId] = m.conv;
        this.h.store.save(s);
        return;
      }
      case "agentEnd": {
        const s = this.session(m.sessionId);
        if (s) this.h.agentEnded(s, m.callId, { text: m.text, isError: m.isError, stopped: m.stopped }, true);
        return;
      }
      case "told": {
        const s = this.session(m.sessionId);
        if (s) this.h.deliver(s, m.callId, 1, m.delivery);
        return;
      }
      case "req":
        return void this.request(m.reqId, m.req);
      case "output": {
        const s = this.session(m.sessionId);
        if (s) this.h.localOutput(s, m.callId, m.text);
        return;
      }
      case "cancel":
        this.running.get(m.reqId)?.controller.abort();
        return;
      default:
        return;
    }
  }

  /** The harness sends its spend ledgers: entries then count requests and the context, the ledger counts tokens and cost. */
  private ledgerMode(): boolean {
    return this.client.harness?.features.includes("usage") ?? false;
  }

  /**
   * A conversation's spend ledger: count what grew since the totals last seen,
   * which includes what has no entry, such as compaction summaries. The first
   * totals seen of a conversation are its baseline: a new one's are empty, and
   * one from before this (or a fork's inherited spend) was counted already.
   */
  private ledger(m: Extract<HarnessMessage, { t: "usage" }>): void {
    const s = this.session(m.sessionId);
    // Counted from the ledger only while this harness said it sends one; otherwise the entries count it all.
    if (!s?.durable || !this.ledgerMode()) return;
    const seen = (s.durable.usage ??= {});
    const prev = seen[m.conv];
    seen[m.conv] = m.models;
    if (prev) {
      for (const [key, u] of Object.entries(m.models)) {
        const p = prev[key];
        const grew = {
          input: Math.max(0, u.input - (p?.input ?? 0)),
          output: Math.max(0, u.output - (p?.output ?? 0)),
          cacheRead: Math.max(0, u.cacheRead - (p?.cacheRead ?? 0)),
          cacheWrite: Math.max(0, u.cacheWrite - (p?.cacheWrite ?? 0)),
          ...(u.reasoning !== undefined ? { reasoning: Math.max(0, u.reasoning - (p?.reasoning ?? 0)) } : {}),
        };
        if (grew.input || grew.output || grew.cacheRead || grew.cacheWrite) this.h.spentLedger(s, m.parent, grew, key.slice(key.indexOf("/") + 1));
      }
    }
    this.h.store.save(s);
  }

  /** One committed entry, applied once. */
  private entry(e: EntryEvent): void {
    const s = this.session(e.sessionId);
    if (!s?.durable) return;
    const last = s.durable.applied[e.conv];
    if (last && !later(e.id, last)) return;
    const parent = e.parent;
    const at = new Date().toISOString();
    if (e.role === "assistant") {
      if (e.usage && (e.usage.input || e.usage.output)) this.h.spent(s, parent, e.usage, e.model || "", !this.ledgerMode());
      if (e.text) {
        this.h.addEntry(s, { kind: "assistant", text: e.text, at, ...(parent ? { parent } : {}) });
        if (!parent) {
          // An earlier Studio's session keeps its copy until its next reply here empties it.
          if (!s.durable.only) mirrorAssistant(s.messages, e.text);
          this.sent.delete(s.id);
          this.thought.delete(s.id);
        }
      }
      for (const c of e.toolCalls ?? []) {
        if (c.name === "reply") continue;
        if (s.transcript.some((t) => t.kind === "tool" && t.call.id === c.id)) continue;
        const k = this.h.canon(c.name, c.args);
        this.h.addEntry(s, { kind: "tool", call: { id: c.id, name: k.name, input: k.input, outcome: "pending", startedAt: at }, ...(parent ? { parent } : {}) });
      }
    } else if (e.role === "toolResult" && e.callId) {
      const entry = s.transcript.find((t) => t.kind === "tool" && t.call.id === e.callId);
      if (entry?.kind === "tool" && entry.call.outcome === "pending") {
        const text = e.text ?? "";
        if (entry.call.name === "agent" && !parent) {
          // A subagent that went on in the background keeps its call open until it reports.
          if (!isBackgroundNote(text)) this.h.agentEnded(s, e.callId, { text, isError: !!e.isError, stopped: /^The user stopped this subagent/.test(text) || text === "Stopped by the user." }, false);
        } else {
          this.h.recordOutcome(s, { id: e.callId, name: entry.call.name, input: {}, state: "done", result: text, isError: !!e.isError }, e.isError ? (/interrupt/i.test(text) ? "unknown" : "error") : "done");
        }
      }
    } else if (e.role === "compaction" && !parent) {
      this.h.addEntry(s, { kind: "compaction", at, trigger: "auto", state: "done", before: 0, method: "summary", ...(e.summary ? { summary: e.summary } : {}) } as TranscriptEntry);
    }
    s.durable.applied[e.conv] = e.id;
    this.h.store.save(s);
  }

  /** A conversation's run started or ended. The main agent's end is its reply's end, as on every route. */
  private run(m: Extract<HarnessMessage, { t: "run" }>): void {
    const s = this.session(m.sessionId);
    if (!s || m.parent) return;
    if (m.running) {
      if (!this.h.replying.has(s.id)) {
        this.h.replying.add(s.id);
        if (!this.h.active.has(s.id)) this.h.active.set(s.id, new AbortController());
        this.h.refreshFree(s);
      }
      if (s.status !== "running" && s.status !== "waiting") this.h.setStatus(s, "running", null);
      return;
    }
    const wasReplying = this.h.replying.has(s.id);
    this.h.active.delete(s.id);
    this.sent.delete(s.id);
    this.thought.delete(s.id);
    if (this.stopping.delete(s.id)) {
      this.h.replying.delete(s.id);
      this.stopEnded.get(s.id)?.();
      return;
    }
    if (!wasReplying && s.status !== "running" && s.status !== "waiting") return;
    const f = m.failure;
    const error = f && f.reason !== "aborted" ? replyFailure(f.reason, f.detail) : null;
    this.h.replyEnded(s, error);
  }

  /** Work the harness asks of this daemon. */
  private async request(reqId: string, req: HarnessRequest): Promise<void> {
    try {
      if (req.kind === "credential") {
        this.client.answer(reqId, await this.h.credential(req.route));
        return;
      }
      const s = this.session(req.sessionId);
      if (!s) {
        this.client.answer(reqId, req.kind === "tool" || req.kind === "finished" ? { text: req.kind === "finished" ? req.result.text : "This session is gone.", isError: true, outcome: "error", touched: [], saved: [] }
          : req.kind === "gate" ? { allow: false, text: "This session is gone." }
          : { ok: false, text: "This session is gone." });
        return;
      }
      if (req.kind === "gate") {
        this.client.answer(reqId, await this.h.gateLocal(s, req.callId, req.name, req.input, req.parent, this.controller(s).signal));
        return;
      }
      if (req.kind === "finished") {
        this.client.answer(reqId, this.h.finishLocal(s, req.callId, req.name, req.input, req.parent, req.result));
        return;
      }
      if (req.kind === "agent") {
        const own = new AbortController();
        this.running.set(reqId, { sessionId: s.id, controller: own, executing: false });
        const key = keyOf(s);
        const start = await this.h.agentStart(s, req.callId, req.input, own.signal,
          async (text) => !!(await this.client.call("tell", { sessionId: key, callId: req.callId, text, requestId: crypto.randomUUID() }).catch(() => false)),
          () => this.stopChild(s, req.callId));
        this.running.delete(reqId);
        if (!own.signal.aborted) this.client.answer(reqId, start);
        return;
      }
      const name = req.name;
      if (name === "reply" && req.parent) {
        this.client.answer(reqId, this.h.replyToUser(s, req.parent, req.input));
        return;
      }
      if (name === "skill") {
        const r = this.h.skill(req.input.name);
        this.h.recordOutcome(s, { id: req.callId, name, input: req.input, state: "done", result: r.text, isError: r.isError }, r.isError ? "error" : "done");
        this.client.answer(reqId, { text: r.text, isError: r.isError, outcome: r.isError ? "error" : "done", touched: [], saved: [] });
        return;
      }
      const k = this.h.canon(name, req.input);
      if (req.started) {
        // An earlier daemon was told to run it and never answered: its outcome is unknown, and it never runs blindly again.
        this.client.answer(reqId, await this.h.lostCall(s, req.callId, k.name, k.input));
        return;
      }
      const session = this.controller(s);
      const own = new AbortController();
      const off = () => own.abort();
      session.signal.addEventListener("abort", off, { once: true });
      const slot = { sessionId: s.id, controller: own, executing: false };
      this.running.set(reqId, slot);
      try {
        const exec = await this.h.runTool(s, own, req.callId, name, req.input, async () => {
          const go = await this.client.started(reqId);
          if (go) slot.executing = true;
          return go;
        }, req.parent);
        if (!this.disposed) this.client.answer(reqId, exec);
      } finally {
        session.signal.removeEventListener("abort", off);
        this.running.delete(reqId);
      }
    } catch (e) {
      this.h.host.log.warn(`a durable request ${req.kind} failed`, e);
      if (!this.disposed && req.kind === "tool") this.client.answer(reqId, { text: `Studio could not run it: ${e instanceof Error ? e.message : String(e)}`, isError: true, outcome: "error", touched: [], saved: [] });
    }
  }
}

/** Entry ids are ordered: numeric ones by value, others by length then text. */
function later(a: string, b: string): boolean {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return BigInt(a) > BigInt(b);
  return a.length !== b.length ? a.length > b.length : a > b;
}

/** Keep Studio's own copy of the conversation as text, so the session can go back to another runtime. */
function mirrorAssistant(messages: MessageParam[], text: string): void {
  const last = messages[messages.length - 1];
  if (last?.role === "assistant" && Array.isArray(last.content)) (last.content as unknown[]).push({ type: "text", text });
  else messages.push({ role: "assistant", content: [{ type: "text", text }] } as MessageParam);
}

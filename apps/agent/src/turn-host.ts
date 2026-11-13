/**
 * A turn host: one Claude sign-in turn, run in a process of its own that
 * outlives the daemon which started it.
 *
 * The host owns the Agent SDK's query() and the runtime it starts. Every turn
 * event goes to the journal with a sequence number and to the daemon when one
 * is connected; a daemon that connects later replays from the last event it
 * applied. Calls into Studio's tools wait for a daemon to run them, so a call
 * made mid-restart is answered by the next daemon. Steering (a message mid-turn,
 * interrupt, stopping one subagent, moving work to the background, Stop) comes
 * from the daemon as ops.
 *
 * The host runs the Studio version it was started with until its turn ends,
 * then exits. See turn-host-protocol.ts for the wire.
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as crypto from "node:crypto";
import type { LiveTurn, SubscriptionTurn } from "./subscription.js";
import type { ToolExecution } from "./tools.js";
import { canonFor } from "./canon.js";
import {
  TURN_HOST_PROTOCOL,
  journalFile,
  logFile,
  onLines,
  readJournal,
  recordFile,
  removeHostFiles,
  sendLine,
  writeJsonAtomic,
  type HostOp,
  type JournalEvent,
  type TurnEvent,
  type TurnHostLaunch,
  type TurnHostRecord,
  type TurnState,
} from "./turn-host-protocol.js";

/** How long a call into Studio's tools waits for a daemon to come back before it fails. */
export const DAEMON_WAIT_MS = 60 * 60_000;
/** How long the host waits, after its turn ended, for the daemon to say it applied the end. */
const END_ACK_MS = 15_000;
/** How often the live state is looked at, for what changes without a callback (background tasks). */
const STATE_POLL_MS = 500;

export interface TurnHostOptions {
  launch: TurnHostLaunch;
  /** Runs the turn: runSubscriptionTurn in the host process. */
  run: (t: SubscriptionTurn) => Promise<string | null>;
  daemonWaitMs?: number;
  endAckMs?: number;
}

interface PendingCall {
  msg: { t: "req"; id: string; callId: string; name: string; input: Record<string, unknown>; started: boolean };
  resolve: (e: ToolExecution) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export class TurnHost {
  private readonly abort = new AbortController();
  private aborted = false;
  private server: net.Server | null = null;
  private daemon: net.Socket | null = null;
  private seq = 0;
  private acked = 0;
  private journal: number | null = null;
  private live: LiveTurn | null = null;
  private readonly stoppers = new Map<string, () => Promise<void>>();
  private readonly cancels = new Map<string, () => void>();
  private readonly pending = new Map<string, PendingCall>();
  private lastState = "";
  private poll: ReturnType<typeof setInterval> | null = null;
  private ended = false;
  private endWaiter: (() => void) | null = null;
  private readonly sockets = new Set<net.Socket>();
  private readonly startedAt = new Date().toISOString();
  /** Resolves once the turn ended and the host let go of everything. */
  readonly done: Promise<void>;
  private finish!: () => void;

  constructor(private readonly o: TurnHostOptions) {
    this.done = new Promise((r) => (this.finish = r));
  }

  private get l(): TurnHostLaunch {
    return this.o.launch;
  }

  /** Something went wrong that nobody is connected to hear: kept beside the journal. */
  log(text: string): void {
    try {
      fs.appendFileSync(logFile(this.l.dataDir, this.l.host), `${new Date().toISOString()} ${text}\n`);
    } catch {
      // Nowhere to write it.
    }
  }

  /** Listen, write the record, and run the turn. Resolves once the host is listening. */
  async start(): Promise<void> {
    this.journal = fs.openSync(journalFile(this.l.dataDir, this.l.host), "a");
    this.server = net.createServer((sock) => this.accept(sock));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.l.socket, () => {
        this.server!.off("error", reject);
        resolve();
      });
    });
    this.server.on("error", (e) => this.log(`socket: ${e.message}`));
    this.writeRecord(false);
    this.poll = setInterval(() => this.pushState(), STATE_POLL_MS);
    void this.runTurn();
  }

  private writeRecord(ended: boolean): void {
    const r: TurnHostRecord = { protocol: TURN_HOST_PROTOCOL, version: this.l.version, host: this.l.host, pid: process.pid, session: this.l.session, socket: this.l.socket, token: this.l.token, startedAt: this.startedAt, ...(ended ? { ended: true } : {}) };
    try {
      writeJsonAtomic(recordFile(this.l.dataDir, this.l.host), r);
    } catch (e) {
      this.log(`could not write the record: ${(e as Error).message}`);
    }
  }

  private async runTurn(): Promise<void> {
    const spec = this.l.spec;
    let error: string | null;
    try {
      error = await this.o.run({
        ...spec,
        native: spec.native as SubscriptionTurn["native"],
        editor: spec.editor ? { tools: spec.editor.tools, canon: canonFor(spec.editor.tools) } : undefined,
        signal: this.abort.signal,
        onSession: (id) => this.emit({ t: "session", id }),
        onDelta: (text) => sendLine(this.daemon, { t: "delta", text }),
        onAssistant: (mid, content, parent) => this.emit({ t: "assistant", mid, content, parent }),
        onToolResults: (content, parent) => this.emit({ t: "toolResults", content, parent }),
        onStopper: (callId, stop) => {
          if (stop) this.stoppers.set(callId, stop);
          else this.stoppers.delete(callId);
          this.pushState();
        },
        onTask: (toolUseId, status, detail) => this.emit({ t: "task", toolUseId, status, detail }),
        onQueued: (id, cancel) => {
          if (cancel) this.cancels.set(id, cancel);
          else this.cancels.delete(id);
          this.emit({ t: "queued", id, on: !!cancel });
        },
        onLive: (live) => {
          this.live = live;
          this.pushState();
        },
        onInputClosed: (why) => this.emit({ t: "inputClosed", why }),
        onFree: (free) => this.emit({ t: "free", free }),
        runTool: (callId, name, input) => this.call(callId, name, input),
        onTokens: (n, parent) => this.emit({ t: "tokens", n, parent }),
        onUsage: (u) => this.emit({ t: "usage", u }),
        onCompaction: (e) => this.emit({ t: "compaction", e }),
        onContextWindow: (w) => this.emit({ t: "contextWindow", w }),
        // The turn takes the user's messages to its subagents (op tellSubagent) and says when one read them.
        ...(spec.subagents.mode !== "off" ? { onInboxTaken: (callId: string | null) => this.emit({ t: "inboxTaken", callId }) } : {}),
      });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      this.log(`the turn threw: ${error}`);
    }
    await this.end(this.aborted ? null : error);
  }

  /** Journal an event and send it to the daemon, the live state first so the daemon reads it with the event. */
  private emit(e: TurnEvent): void {
    this.pushState();
    const ev = { seq: ++this.seq, ...e } as JournalEvent;
    if (this.journal !== null) {
      try {
        fs.writeSync(this.journal, `${JSON.stringify(ev)}\n`);
      } catch (err) {
        this.log(`the journal write failed: ${(err as Error).message}`);
      }
    }
    sendLine(this.daemon, ev);
  }

  private state(): TurnState {
    const l = this.live;
    return { t: "state", live: !!l, open: l?.open() ?? false, free: l?.free() ?? false, background: l?.background() ?? 0, stoppers: [...this.stoppers.keys()] };
  }

  private pushState(force = false): void {
    const s = this.state();
    const key = JSON.stringify(s);
    if (!force && key === this.lastState) return;
    this.lastState = key;
    sendLine(this.daemon, s);
  }

  /** A call into Studio's tools: it waits for a daemon, and fails only when none comes back in time. */
  private call(callId: string, name: string, input: Record<string, unknown>): Promise<ToolExecution> {
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      const p: PendingCall = { msg: { t: "req", id, callId, name, input, started: false }, resolve, timer: null };
      this.pending.set(id, p);
      if (!sendLine(this.daemon, p.msg)) this.waitForDaemon(p);
    });
  }

  private waitForDaemon(p: PendingCall): void {
    if (p.timer) return;
    const ms = this.o.daemonWaitMs ?? DAEMON_WAIT_MS;
    p.timer = setTimeout(() => {
      if (!this.pending.delete(p.msg.id)) return;
      p.resolve({ text: `Studio's daemon did not come back within ${Math.round(ms / 60_000)} minutes, so this call did not run.`, isError: true, outcome: "error", touched: [], saved: [] });
    }, ms);
    p.timer.unref?.();
  }

  private accept(sock: net.Socket): void {
    let hello = false;
    this.sockets.add(sock);
    sock.on("error", () => {});
    sock.on("close", () => this.sockets.delete(sock));
    onLines(sock, (msg) => {
      if (!hello) {
        if (msg.t !== "hello" || msg.token !== this.l.token) {
          sendLine(sock, { t: "refused", why: "not this host's token" });
          sock.end();
          return;
        }
        hello = true;
        this.attach(sock, typeof msg.from === "number" ? msg.from : 0);
        return;
      }
      if (sock !== this.daemon) return;
      void this.handle(sock, msg);
    });
    sock.on("close", () => {
      if (this.daemon !== sock) return;
      this.daemon = null;
      this.log(`the daemon disconnected at event ${this.seq}`);
      for (const p of this.pending.values()) this.waitForDaemon(p);
      this.endWaiter?.();
    });
  }

  /** A daemon said hello: it gets what it missed, the state, and every call still waiting, then everything live. */
  private attach(sock: net.Socket, from: number): void {
    const prior = this.daemon;
    this.daemon = sock;
    this.log(`a daemon attached from event ${from} of ${this.seq}, ${this.pending.size} call(s) waiting`);
    // The newer daemon wins: an older connection is from a daemon that is going away.
    if (prior && prior !== sock) prior.destroy();
    sendLine(sock, { t: "hello", protocol: TURN_HOST_PROTOCOL, version: this.l.version, pid: process.pid, session: this.l.session, host: this.l.host, last: this.seq });
    for (const ev of readJournal(journalFile(this.l.dataDir, this.l.host), from)) sendLine(sock, ev);
    this.pushState(true);
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.timer = null;
      sendLine(sock, p.msg);
    }
  }

  private async handle(sock: net.Socket, msg: Record<string, unknown>): Promise<void> {
    if (msg.t === "res") {
      const p = this.pending.get(String(msg.id));
      if (!p) return;
      this.pending.delete(p.msg.id);
      if (p.timer) clearTimeout(p.timer);
      p.resolve(msg.exec as ToolExecution);
    } else if (msg.t === "started") {
      const p = this.pending.get(String(msg.id));
      if (p) p.msg.started = true;
    } else if (msg.t === "ack") {
      if (typeof msg.seq === "number" && msg.seq > this.acked) this.acked = msg.seq;
      if (this.ended && this.acked >= this.seq) this.endWaiter?.();
    } else if (msg.t === "op") {
      let value: unknown = null;
      try {
        value = await this.op(msg.op as HostOp, (msg.args ?? {}) as Record<string, unknown>);
      } catch (e) {
        this.log(`op ${String(msg.op)} failed: ${(e as Error).message}`);
      }
      this.pushState();
      sendLine(sock, { t: "ret", id: msg.id, value });
    }
  }

  private async op(op: HostOp, args: Record<string, unknown>): Promise<unknown> {
    const live = this.live;
    switch (op) {
      case "say":
        return live ? live.say(args.blocks as unknown[]) : false;
      case "keep":
        return live ? live.keep() : false;
      case "interrupt":
        if (live) await live.interrupt();
        return true;
      case "stopTask": {
        const stop = this.stoppers.get(String(args.callId));
        if (stop) await stop();
        return !!stop;
      }
      case "tellSubagent":
        return live?.tell && typeof args.text === "string" ? live.tell(typeof args.callId === "string" ? args.callId : null, args.text) : false;
      case "cancelQueued": {
        const cancel = this.cancels.get(String(args.id));
        cancel?.();
        return !!cancel;
      }
      case "abort":
        // Stop: the daemon has ended the turn already; nothing of this host is to be reattached.
        this.aborted = true;
        this.abort.abort();
        return true;
      default:
        return null;
    }
  }

  /** The turn ended: say so, wait for the daemon to apply it, and let go. */
  private async end(error: string | null): Promise<void> {
    this.emit({ t: "end", error });
    this.ended = true;
    this.writeRecord(true);
    if (this.poll) clearInterval(this.poll);
    if (this.daemon && !this.aborted) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.o.endAckMs ?? END_ACK_MS);
        this.endWaiter = () => {
          clearTimeout(timer);
          resolve();
        };
        if (this.acked >= this.seq) this.endWaiter();
      });
    }
    // Calls still waiting can no longer be answered into this turn.
    for (const p of this.pending.values()) if (p.timer) clearTimeout(p.timer);
    this.pending.clear();
    if (this.journal !== null) fs.closeSync(this.journal);
    this.journal = null;
    // Applied, or stopped: nothing is left to reattach. Otherwise the next daemon applies the journal.
    if (this.aborted || this.acked >= this.seq) removeHostFiles(this.l.dataDir, this.l.host);
    this.daemon = null;
    const closed = new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    for (const s of this.sockets) s.end();
    const late = setTimeout(() => {
      for (const s of this.sockets) s.destroy();
    }, 500);
    await closed;
    clearTimeout(late);
    this.finish();
  }
}

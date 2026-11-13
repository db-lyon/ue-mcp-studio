/**
 * The daemon's side of turn hosts (turn-host.ts): start a Claude sign-in
 * conversation step (a main agent's reply, or one subagent) in a host process
 * of its own, and attach to one an earlier daemon started.
 *
 * A hosted turn looks to the runner like runSubscriptionTurn: the same
 * callbacks, and a promise of the turn's error. The host's events are applied
 * through those callbacks in order, each once, by sequence number; its calls
 * into Studio's tools run through runTool; the LiveTurn the runner steers is a
 * proxy whose state mirrors the host's.
 *
 * When this daemon goes down it detaches and the turn goes on in its host. The
 * next daemon reattaches: it replays what it missed from the journal, takes
 * the calls still waiting, and carries on.
 */
import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import type { LiveTurn, SubscriptionTurn } from "./subscription.js";
import type { ToolExecution } from "./tools.js";
import {
  STUDIO_SUBAGENTS_PROTOCOL,
  TELL_SUBAGENT_PROTOCOL,
  TURN_HOST_PROTOCOL,
  journalFile,
  launchFile,
  listRecords,
  onLines,
  pidAlive,
  readJournal,
  readRecord,
  recordFile,
  removeHostFiles,
  sendLine,
  socketPathFor,
  writeJsonAtomic,
  type HostOp,
  type JournalEvent,
  type TurnHostLaunch,
  type TurnHostRecord,
  type TurnSpec,
  type TurnState,
} from "./turn-host-protocol.js";

/** What a hosted turn resolves with when this daemon let go of it and the turn goes on without it. */
export const DETACHED = Symbol("detached");
export type HostedResult = string | null | typeof DETACHED;

type SpecKeys = "projectDir" | "model" | "effort" | "system" | "agentTool" | "allowed" | "maxTurns" | "native" | "prompt" | "resume" | "editor";

/**
 * What a turn host from before STUDIO_SUBAGENTS_PROTOCOL reports about the
 * runtime's own subagents it runs. Only the runner's compatibility path for
 * such a host gives these; remove them with that protocol constant.
 */
export interface LegacyHostCallbacks {
  onStopper?: (callId: string, stop: (() => Promise<void>) | null) => void;
  onTask?: (toolUseId: string, status: "started" | "completed" | "failed" | "stopped", detail: { background?: boolean; summary?: string }) => void;
  onQueued?: (toolUseId: string, cancel: (() => void) | null) => void;
  onFree?: (free: boolean) => void;
  onInboxTaken?: (callId: string | null) => void;
}

/** The runner's side of a turn: SubscriptionTurn's callbacks, and what only a hosted turn needs. */
export type HostedCallbacks = Omit<SubscriptionTurn, SpecKeys> & LegacyHostCallbacks & {
  /** A call an earlier daemon was running when it went down: its outcome is unknown, and it is not run again. */
  lostTool: (callId: string, name: string, input: Record<string, unknown>) => Promise<ToolExecution>;
  /** The sequence number of the event about to be applied, kept with the session so a reattach replays from there. */
  onSeq?: (seq: number) => void;
};

export interface HostedRun {
  host: string;
  /** The turn's error when it ends, or DETACHED once this daemon let go of it. */
  done: Promise<HostedResult>;
  /** Let go of the turn without stopping it: this daemon is going down. */
  detach(): void;
}

export interface TurnHostsOptions {
  dataDir: string;
  projectDir: string;
  /** This Studio's version, which a host it starts keeps until its turn ends. */
  version: string;
  /** The bundled host entry, dist/turn-host.js; null where there is none (development), so turns run in the daemon. */
  script: string | null;
  log: { info(msg: string): void; warn(msg: string, e?: unknown): void };
  /** Starts a host from its launch file. The default runs the script in a detached Node process. Tests run one in-process. */
  launch?: (launchFile: string) => { exited: () => boolean; kill: () => void };
  /** How long a host gets to start listening. */
  readyMs?: number;
  /** How long a dropped connection to a live host is retried before the host counts as gone. */
  reconnectMs?: number;
  /** How long a daemon that starts keeps trying to reach a live host before it gives up on the turn. */
  attachMs?: number;
}

const HELLO_MS = 10_000;
const OP_MS = 30_000;

/** A detached Node process running the host script: it outlives this daemon, and has no window or pipes tied to it. */
function launchDetached(script: string, cwd: string): (file: string) => { exited: () => boolean; kill: () => void } {
  return (file) => {
    let gone = false;
    const child = spawn(process.execPath, [script, file], { detached: true, stdio: "ignore", windowsHide: true, cwd, env: process.env });
    child.on("exit", () => void (gone = true));
    child.on("error", () => void (gone = true));
    child.unref();
    return {
      exited: () => gone,
      kill: () => {
        if (!gone) child.kill();
      },
    };
  };
}

export class TurnHosts {
  constructor(private readonly o: TurnHostsOptions) {}

  /** Whether turns can run in hosts here. */
  available(): boolean {
    return !!this.o.launch || (!!this.o.script && fs.existsSync(this.o.script));
  }

  /** The newest host record of a session, if any. */
  recordFor(session: string): TurnHostRecord | null {
    const mine = listRecords(this.o.dataDir).filter((r) => r.session === session).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return mine[0] ?? null;
  }

  /** Start a host for a turn and attach to it. Throws when the host cannot be started or reached. */
  async start(session: string, spec: TurnSpec, cb: HostedCallbacks): Promise<HostedRun> {
    const host = crypto.randomUUID();
    const launch: TurnHostLaunch = {
      host,
      session,
      token: crypto.randomBytes(24).toString("hex"),
      socket: socketPathFor(host),
      dataDir: this.o.dataDir,
      version: this.o.version,
      // Functions (the editor surface's canon) do not go over: the host rebuilds them from the tools.
      spec: JSON.parse(JSON.stringify(spec)) as TurnSpec,
    };
    const file = launchFile(this.o.dataDir, host);
    writeJsonAtomic(file, launch);
    const launcher = this.o.launch ?? launchDetached(this.o.script!, this.o.projectDir);
    let proc: { exited: () => boolean; kill: () => void };
    try {
      proc = launcher(file);
    } catch (e) {
      removeHostFiles(this.o.dataDir, host);
      throw e;
    }
    const until = Date.now() + (this.o.readyMs ?? 20_000);
    let record: TurnHostRecord | null = null;
    while (!(record = readRecord(recordFile(this.o.dataDir, host)))) {
      if (proc.exited() || Date.now() > until) {
        proc.kill();
        removeHostFiles(this.o.dataDir, host);
        throw new Error(proc.exited() ? "the turn host exited before it was ready" : "the turn host did not start in time");
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    const link = new HostLink(this.o, record, cb, 0);
    try {
      await link.connect();
    } catch (e) {
      proc.kill();
      removeHostFiles(this.o.dataDir, host);
      throw e;
    }
    return link.run();
  }

  /**
   * Attach to the host an earlier daemon started, replaying from `from`. A host
   * that is gone has its journal applied from the file: the turn ends with its
   * own end, or as cut off when the journal has none.
   */
  async attach(record: TurnHostRecord, cb: HostedCallbacks, from: number): Promise<HostedRun> {
    const link = new HostLink(this.o, record, cb, from);
    // A busy machine can refuse a connection for a moment: a host that is alive is tried again before it counts as gone.
    const until = Date.now() + (this.o.attachMs ?? 30_000);
    let last: unknown = null;
    for (let tries = 0; ; tries++) {
      const r = readRecord(recordFile(this.o.dataDir, record.host)) ?? record;
      if (r.ended || !pidAlive(r.pid)) {
        this.o.log.info(`the turn host of session ${record.session} ${r.ended ? "has ended" : "is no longer running"}: its journal is applied`);
        break;
      }
      try {
        await link.connect();
        if (tries > 0) this.o.log.info(`reached the turn host of session ${record.session} after ${tries + 1} tries`);
        return link.run();
      } catch (e) {
        last = e;
      }
      if (Date.now() > until) {
        this.o.log.warn(`could not reach the turn host of session ${record.session}, which is still running`, last);
        break;
      }
      await new Promise((res) => setTimeout(res, 250));
    }
    link.fromJournal();
    return link.run();
  }
}

/** One connection to one host. */
class HostLink {
  private sock: net.Socket | null = null;
  private applied: number;
  private state: TurnState = { t: "state", live: false, open: false, free: false, background: 0, stoppers: [] };
  private liveShown = false;
  /** The protocol the host said in its hello: what it can be asked. */
  private protocol = 1;
  private readonly stoppersShown = new Set<string>();
  private readonly ops = new Map<string, (v: unknown) => void>();
  private readonly inflight = new Set<string>();
  private settled = false;
  private detached = false;
  private resolveDone!: (r: HostedResult) => void;
  private readonly done: Promise<HostedResult>;

  constructor(private readonly o: TurnHostsOptions, private readonly record: TurnHostRecord, private readonly cb: HostedCallbacks, from: number) {
    this.applied = from;
    this.done = new Promise((r) => (this.resolveDone = r));
  }

  run(): HostedRun {
    // Stop: the host ends the turn, and the runner, which has ended it already, is answered at once, as in the daemon.
    const onAbort = () => {
      void this.op("abort");
      fs.rmSync(recordFile(this.o.dataDir, this.record.host), { force: true });
      this.settle(null);
      setTimeout(() => this.close(), 3000).unref?.();
    };
    if (this.cb.signal.aborted) onAbort();
    else this.cb.signal.addEventListener("abort", onAbort, { once: true });
    return {
      host: this.record.host,
      done: this.done,
      detach: () => {
        this.cb.signal.removeEventListener("abort", onAbort);
        this.detached = true;
        this.close();
        this.settle(DETACHED);
      },
    };
  }

  private settle(r: HostedResult): void {
    if (this.settled) return;
    this.settled = true;
    if (r !== DETACHED) this.hideLive();
    this.resolveDone(r);
  }

  private close(): void {
    const s = this.sock;
    this.sock = null;
    s?.destroy();
  }

  /** Connect and say hello. Rejects when the host is not there, or is not the host the record names. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.connect(this.record.socket);
      let answered = false;
      const timer = setTimeout(() => done(false, "the turn host did not answer"), HELLO_MS);
      const done = (ok: boolean, why?: string) => {
        if (answered) return;
        answered = true;
        clearTimeout(timer);
        if (ok) {
          // Current from here: the replay that follows the hello is read on this socket.
          this.sock = sock;
          resolve();
        } else {
          sock.destroy();
          reject(new Error(why ?? "the turn host refused the connection"));
        }
      };
      sock.on("error", (e) => done(false, e.message));
      sock.on("connect", () => {
        sendLine(sock, { t: "hello", protocol: TURN_HOST_PROTOCOL, token: this.record.token, from: this.applied });
      });
      onLines(sock, (msg) => {
        if (msg.t === "hello") {
          // The pid and the record could belong to another process by now: the host proves itself by its session and id.
          const ours = msg.session === this.record.session && msg.host === this.record.host;
          if (ours) this.protocol = typeof msg.protocol === "number" ? msg.protocol : 1;
          done(ours, ours ? undefined : "the socket is not this session's turn host");
        } else if (msg.t === "refused") done(false, String(msg.why ?? "refused"));
        else this.handle(sock, msg);
      });
      sock.on("close", () => {
        done(false, "the turn host closed the connection");
        if (this.sock === sock) this.lost();
      });
    });
  }

  private handle(sock: net.Socket, msg: Record<string, unknown>): void {
    if (sock !== this.sock) return;
    if (msg.t === "state") {
      this.state = msg as unknown as TurnState;
      this.reconcile();
    } else if (msg.t === "delta") {
      this.cb.onDelta(String(msg.text ?? ""));
    } else if (msg.t === "req") {
      this.request(msg as unknown as { id: string; callId: string; name: string; input: Record<string, unknown>; started: boolean });
    } else if (msg.t === "ret") {
      this.ops.get(String(msg.id))?.(msg.value);
    } else if (typeof msg.seq === "number") {
      this.apply(msg as unknown as JournalEvent);
    }
  }

  /** The live turn and its stoppable subagents, as the host's state says. */
  private reconcile(): void {
    if (this.settled) return;
    if (this.state.live && !this.liveShown) {
      this.liveShown = true;
      this.cb.onLive?.(this.proxy());
    } else if (!this.state.live && this.liveShown) {
      this.liveShown = false;
      this.cb.onLive?.(null);
    }
    // A legacy host's own subagents, which can be stopped one by one; a current host lists none.
    const now = new Set(this.state.stoppers ?? []);
    for (const id of now) {
      if (this.stoppersShown.has(id)) continue;
      this.stoppersShown.add(id);
      this.cb.onStopper?.(id, async () => void (await this.op("stopTask", { callId: id })));
    }
    for (const id of [...this.stoppersShown]) {
      if (now.has(id)) continue;
      this.stoppersShown.delete(id);
      this.cb.onStopper?.(id, null);
    }
  }

  private hideLive(): void {
    for (const id of this.stoppersShown) this.cb.onStopper?.(id, null);
    this.stoppersShown.clear();
    if (this.liveShown) this.cb.onLive?.(null);
    this.liveShown = false;
  }

  private proxy(): LiveTurn {
    const base: LiveTurn = {
      open: () => this.state.open,
      say: async (blocks) => (await this.op("say", { blocks })) === true,
      interrupt: async () => void (await this.op("interrupt")),
    };
    if (this.protocol >= STUDIO_SUBAGENTS_PROTOCOL) return base;
    // Compatibility: a host from before protocol 3 runs the runtime's own subagents, steered through these.
    return {
      ...base,
      background: () => this.state.background,
      free: () => this.state.free,
      keep: async () => (await this.op("keep")) === true,
      // A host from before protocol 2 cannot take a message for a subagent.
      ...(this.protocol >= TELL_SUBAGENT_PROTOCOL ? { tell: async (callId: string | null, text: string) => (await this.op("tellSubagent", { callId, text })) === true } : {}),
    };
  }

  /** Ask the host's turn for something; null when the host cannot be reached. */
  private op(op: HostOp, args?: Record<string, unknown>): Promise<unknown> {
    const id = crypto.randomUUID();
    if (!sendLine(this.sock, { t: "op", id, op, ...(args ? { args } : {}) })) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish(null), OP_MS);
      const finish = (v: unknown) => {
        clearTimeout(timer);
        this.ops.delete(id);
        resolve(v);
      };
      this.ops.set(id, finish);
    });
  }

  /** A call the host's turn made into Studio's tools: run here, answered over the socket that is current then. */
  private request(r: { id: string; callId: string; name: string; input: Record<string, unknown>; started: boolean }): void {
    // A call this daemon is running already, sent again after a dropped connection.
    if (this.inflight.has(r.id) || this.settled) return;
    this.inflight.add(r.id);
    const run = r.started
      ? this.cb.lostTool(r.callId, r.name, r.input)
      : this.cb.runTool(r.callId, r.name, r.input, () => void sendLine(this.sock, { t: "started", id: r.id }));
    void run.then(
      (exec) => sendLine(this.sock, { t: "res", id: r.id, exec }),
      (e: unknown) => sendLine(this.sock, { t: "res", id: r.id, exec: { text: e instanceof Error ? e.message : String(e), isError: true, outcome: "error", touched: [], saved: [] } }),
    ).finally(() => this.inflight.delete(r.id));
  }

  /** Apply one journaled event, once. */
  private apply(ev: JournalEvent): void {
    if (ev.seq <= this.applied || this.settled) return;
    this.applied = ev.seq;
    this.cb.onSeq?.(ev.seq);
    const cb = this.cb;
    switch (ev.t) {
      case "session": return cb.onSession(ev.id);
      case "assistant": return cb.onAssistant(ev.mid, ev.content, ev.parent);
      case "toolResults": return cb.onToolResults(ev.content, ev.parent);
      // task, queued, free and inboxTaken: a legacy host's own subagents.
      case "task": return cb.onTask?.(ev.toolUseId, ev.status, ev.detail);
      case "queued": return cb.onQueued?.(ev.id, ev.on && this.sock ? () => void this.op("cancelQueued", { id: ev.id }) : null);
      case "free": return cb.onFree?.(ev.free);
      case "tokens": return cb.onTokens?.(ev.n, ev.parent);
      case "usage": return cb.onUsage?.(ev.u);
      case "compaction": return cb.onCompaction?.(ev.e);
      case "contextWindow": return cb.onContextWindow?.(ev.w);
      case "inputClosed": return cb.onInputClosed?.(ev.why);
      case "inboxTaken": return cb.onInboxTaken?.(ev.callId);
      case "end": {
        sendLine(this.sock, { t: "ack", seq: ev.seq });
        removeHostFiles(this.o.dataDir, this.record.host);
        this.settle(ev.error);
        setTimeout(() => this.close(), 200).unref?.();
        return;
      }
      default:
        // An event a newer host knows and this daemon does not.
        return;
    }
  }

  /** The connection dropped without this daemon letting go: reconnect to a live host, or read what a gone one left. */
  private lost(): void {
    this.sock = null;
    if (this.settled || this.detached) return;
    void (async () => {
      const until = Date.now() + (this.o.reconnectMs ?? 5000);
      while (Date.now() < until && !this.settled) {
        const r = readRecord(recordFile(this.o.dataDir, this.record.host));
        if (!r || r.ended || !pidAlive(r.pid)) break;
        try {
          await this.connect();
          return;
        } catch {
          await new Promise((res) => setTimeout(res, 250));
        }
      }
      if (!this.settled) this.fromJournal();
    })();
  }

  /**
   * The host is gone, or cannot be reached: apply what its journal holds, then
   * end the turn with its end, or as cut off. The files of a host that is still
   * running are left, so a later daemon can still reach it.
   */
  fromJournal(): void {
    this.hideLive();
    for (const ev of readJournal(journalFile(this.o.dataDir, this.record.host), this.applied)) this.apply(ev);
    if (this.settled) return;
    const r = readRecord(recordFile(this.o.dataDir, this.record.host));
    const running = !!r && !r.ended && pidAlive(r.pid);
    if (!running) removeHostFiles(this.o.dataDir, this.record.host);
    this.settle(running
      ? "Studio could not reach the process the turn runs in. Send a message to continue."
      : "The process the turn ran in ended before the turn did. Send a message to continue.");
  }
}

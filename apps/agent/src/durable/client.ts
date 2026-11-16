/**
 * The daemon's side of the durable harness: find the project's harness, or
 * start one, and talk to it. The daemon never stops it: a daemon that goes
 * down only disconnects, and the harness hands what waited for it to the next.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import { spawn } from "node:child_process";
import {
  DURABLE_PROTOCOL,
  durableDir,
  harnessSocket,
  launchFile,
  recordFile,
  type ClientMessage,
  type HarnessLaunch,
  type HarnessMessage,
  type HarnessRecord,
} from "./protocol.js";
import { onLines, pidAlive, sendLine, writeJsonAtomic } from "../turn-host-protocol.js";

export interface HarnessClientOptions {
  dataDir: string;
  projectDir: string;
  version: string;
  /** The bundled harness entry, dist/durable-harness.js; null in development, where only `start` runs one. */
  script: string | null;
  /** This Studio's extension bundle, dist/durable-extension.js, installed into an older harness. */
  extensionFile: string | null;
  /** Where the Claude runtime is, for a harness that starts. */
  claudeCommand?: () => Promise<string | null>;
  /** Starts a harness from its launch; tests run one in-process. The default runs the script in a detached Node process. */
  start?: (launch: HarnessLaunch) => Promise<void> | void;
  log: { info(m: string): void; warn(m: string, e?: unknown): void };
  /** Every message the harness sends that is not an answer. */
  onMessage: (msg: HarnessMessage) => void;
  /** The connection came up (true) or went (false). */
  onConnection?: (up: boolean) => void;
}

const HELLO_MS = 10_000;
const START_MS = 20_000;
const CALL_MS = 60_000;

type Call = { [K in ClientMessage["t"]]: Extract<ClientMessage, { t: K }> extends { id: string } ? K : never }[ClientMessage["t"]];
type CallArgs<K extends Call> = Omit<Extract<ClientMessage, { t: K }>, "t" | "id">;

export class HarnessClient {
  private sock: net.Socket | null = null;
  private connecting: Promise<net.Socket> | null = null;
  private seq = 0;
  private readonly calls = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly goes = new Map<string, () => void>();
  private closed = false;
  /** The harness's own Studio version and the extension it runs, from its hello. */
  harness: { version: string; extension: string; pid: number; protocol: number; features: string[] } | null = null;

  constructor(private readonly o: HarnessClientOptions) {}

  /** Whether a harness can run here. */
  available(): boolean {
    return !!this.o.start || (!!this.o.script && fs.existsSync(this.o.script));
  }

  connected(): boolean {
    return !!this.sock && !this.sock.destroyed;
  }

  /** Connected to the project's harness, starting one when none answers. */
  ensure(): Promise<net.Socket> {
    if (this.sock && !this.sock.destroyed) return Promise.resolve(this.sock);
    this.connecting ??= this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private readRecord(): HarnessRecord | null {
    try {
      const r = JSON.parse(fs.readFileSync(recordFile(this.o.dataDir), "utf-8")) as HarnessRecord;
      return typeof r.pid === "number" && typeof r.socket === "string" && typeof r.token === "string" ? r : null;
    } catch {
      return null;
    }
  }

  private async connect(): Promise<net.Socket> {
    if (this.closed) throw new Error("the daemon is going down");
    const existing = this.readRecord();
    if (existing && pidAlive(existing.pid)) {
      try {
        return await this.attach(existing);
      } catch (e) {
        this.o.log.warn(`the durable harness ${existing.pid} did not answer`, e);
      }
    }
    return this.attach(await this.launch());
  }

  private async launch(): Promise<HarnessRecord> {
    if (!this.available()) throw new Error("This Studio build has no durable harness to run.");
    fs.mkdirSync(durableDir(this.o.dataDir), { recursive: true });
    const launch: HarnessLaunch = {
      dataDir: this.o.dataDir,
      projectDir: this.o.projectDir,
      token: crypto.randomBytes(24).toString("hex"),
      socket: harnessSocket(this.o.dataDir),
      version: this.o.version,
      claudeCommand: (await this.o.claudeCommand?.().catch(() => null)) ?? null,
    };
    const before = this.readRecord();
    if (this.o.start) await this.o.start(launch);
    else {
      writeJsonAtomic(launchFile(this.o.dataDir), launch);
      const child = spawn(process.execPath, [this.o.script!, launchFile(this.o.dataDir)], { detached: true, stdio: "ignore", windowsHide: true, cwd: this.o.projectDir, env: process.env });
      child.unref();
      this.o.log.info(`started the durable harness ${child.pid}`);
    }
    const end = Date.now() + START_MS;
    while (Date.now() < end) {
      const r = this.readRecord();
      if (r && r.token === launch.token && r.startedAt !== before?.startedAt) return r;
      await new Promise((r2) => setTimeout(r2, 100));
    }
    throw new Error("The durable harness did not start.");
  }

  private attach(r: HarnessRecord): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const sock = net.connect(r.socket);
      let done = false;
      const fail = (e: unknown) => {
        if (done) return;
        done = true;
        sock.destroy();
        reject(e);
      };
      const timer = setTimeout(() => fail(new Error("no hello")), HELLO_MS);
      sock.once("error", fail);
      sock.once("connect", () => {
        const ext = this.o.extensionFile && fs.existsSync(this.o.extensionFile) ? { version: this.o.version, file: this.o.extensionFile } : undefined;
        sendLine(sock, { t: "hello", protocol: DURABLE_PROTOCOL, token: r.token, version: this.o.version, role: "daemon", ...(ext ? { extension: ext } : {}) } satisfies ClientMessage);
      });
      onLines(sock, (raw) => {
        const msg = raw as unknown as HarnessMessage;
        if (!done) {
          if (msg.t === "refused") return fail(new Error(`refused: ${msg.why}`));
          if (msg.t !== "hello") return;
          done = true;
          clearTimeout(timer);
          sock.off("error", fail);
          this.harness = { version: msg.version, extension: msg.extension, pid: msg.pid, protocol: msg.protocol, features: msg.features ?? [] };
          this.sock = sock;
          sock.on("error", () => undefined);
          sock.on("close", () => this.dropped(sock));
          this.o.log.info(`connected to the durable harness ${msg.pid} (Studio ${msg.version})`);
          this.o.onConnection?.(true);
          resolve(sock);
          return;
        }
        this.received(msg);
      }, (e) => this.o.log.warn("a durable harness message failed", e));
    });
  }

  private dropped(sock: net.Socket): void {
    if (this.sock !== sock) return;
    this.sock = null;
    for (const [id, c] of this.calls) {
      clearTimeout(c.timer);
      c.reject(new Error("the durable harness disconnected"));
      this.calls.delete(id);
    }
    // A run waiting to be told to go never runs: the harness asks the next connection again.
    this.goes.clear();
    if (!this.closed) this.o.log.warn("the durable harness disconnected");
    this.o.onConnection?.(false);
  }

  private received(msg: HarnessMessage): void {
    if (msg.t === "ret") {
      const c = this.calls.get(msg.id);
      if (!c) return;
      this.calls.delete(msg.id);
      clearTimeout(c.timer);
      if (msg.ok) c.resolve(msg.value);
      else c.reject(new Error(msg.error ?? "failed"));
      return;
    }
    if (msg.t === "go") {
      this.goes.get(msg.reqId)?.();
      this.goes.delete(msg.reqId);
      return;
    }
    this.o.onMessage(msg);
  }

  /** One request to the harness, answered by its ret. */
  async call<K extends Call>(t: K, args: CallArgs<K>, timeoutMs = CALL_MS): Promise<unknown> {
    const sock = await this.ensure();
    const id = `c${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(new Error(`the durable harness did not answer ${t}`));
      }, timeoutMs);
      this.calls.set(id, { resolve, reject, timer });
      if (!sendLine(sock, { t, id, ...args } as unknown as ClientMessage)) {
        clearTimeout(timer);
        this.calls.delete(id);
        reject(new Error("the durable harness is not connected"));
      }
    });
  }

  /** A tool run got past its gate: wait until the harness recorded that, then run it. False when the harness went first. */
  started(reqId: string): Promise<boolean> {
    return new Promise((resolve) => {
      if (!sendLine(this.sock, { t: "started", reqId } satisfies ClientMessage)) return resolve(false);
      const sock = this.sock;
      this.goes.set(reqId, () => resolve(true));
      sock?.once("close", () => resolve(false));
    });
  }

  answer(reqId: string, value: unknown): void {
    sendLine(this.sock, { t: "res", reqId, value } satisfies ClientMessage);
  }

  /** The daemon is going down: disconnect, and leave the harness running. */
  close(): void {
    this.closed = true;
    this.sock?.end();
    this.sock = null;
  }
}

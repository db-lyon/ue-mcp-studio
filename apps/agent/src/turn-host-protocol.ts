/**
 * The wire between Studio's daemon and a turn host: the process a Claude
 * sign-in turn runs in, so the turn outlives a daemon restart (a Studio
 * update, a ue-mcp restart). The host listens on a local socket (a named pipe
 * on Windows) and talks JSON lines; the daemon connects to it.
 *
 * Versioned and additive: each side says its protocol in hello, ignores a
 * message type it does not know, and a newer daemon uses only what the host's
 * protocol has, so it can attach to a host an older Studio started.
 *
 * Files, per host, in the data folder's turn-hosts/: `<host>.json` (the
 * record: pid, socket, token, session), `<host>.jsonl` (the journal: every
 * turn event with its sequence number) and `<host>.log` (what went wrong).
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as net from "node:net";
import type { Effort } from "@ue-mcp-studio/shared";
import type { ToolExecution } from "./tools.js";
import type { TokenUsage } from "./usage.js";
import type { ContentBlock } from "./providers.js";

/** Bumped when a message is added or a meaning changes. Never reuse or change the meaning of an existing one. */
export const TURN_HOST_PROTOCOL = 3;
/** The first protocol whose host takes the user's messages to a running subagent (op tellSubagent, event inboxTaken). Legacy hosts only. */
export const TELL_SUBAGENT_PROTOCOL = 2;
/**
 * The first protocol whose host runs one conversation and no subagents of the
 * runtime's own: Studio starts and steers subagents, each in a host of its
 * own. A host below this (Studio 0.1.35-beta.25 and older) runs the runtime's
 * subagents, and the daemon keeps the compatibility path for it (task, queued,
 * free and inboxTaken events, stoppers, keep and tellSubagent) until no such
 * host can still be running. Remove that path with this constant.
 */
export const STUDIO_SUBAGENTS_PROTOCOL = 3;
export const HOSTS_DIR = "turn-hosts";

/** What a host writes once it listens. A daemon trusts it only after the host answers hello with the same token. */
export interface TurnHostRecord {
  protocol: number;
  /** The Studio version the host runs, which it keeps until its turn ends. */
  version: string;
  host: string;
  pid: number;
  session: string;
  socket: string;
  token: string;
  startedAt: string;
  /** The turn ended: the journal holds its end. */
  ended?: boolean;
}

/** The conversation as the host runs it: everything in SubscriptionTurn that is data. */
export interface TurnSpec {
  projectDir: string;
  model: string;
  effort: Effort;
  system: string;
  /** Studio's agent tool, for a main agent that may start subagents. */
  agentTool?: { description: string; inputSchema: Record<string, unknown> };
  /** Studio's tools by name, when a helper's file narrows them. */
  allowed?: string[];
  maxTurns?: number;
  native?: { settingSources: Array<"user" | "project" | "local">; skills: boolean };
  prompt: unknown[];
  resume: string | null;
  /** The projected editor tools, with their categories so the host reads their calls back as ue_mcp calls. */
  editor?: { tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown>; category?: string | null }> };
}

/** What the daemon hands a host it starts, in a file the host reads once and deletes. */
export interface TurnHostLaunch {
  host: string;
  session: string;
  token: string;
  socket: string;
  dataDir: string;
  version: string;
  spec: TurnSpec;
}

/**
 * Turn events, kept in the journal with their sequence number and replayed to
 * a daemon that reattaches. task, queued, free and inboxTaken come only from a
 * host below STUDIO_SUBAGENTS_PROTOCOL.
 */
export type TurnEvent =
  | { t: "session"; id: string }
  | { t: "assistant"; mid: string; content: ContentBlock[]; parent: string | null }
  | { t: "toolResults"; content: unknown[]; parent: string | null }
  | { t: "task"; toolUseId: string; status: "started" | "completed" | "failed" | "stopped"; detail: { background?: boolean; summary?: string } }
  | { t: "queued"; id: string; on: boolean }
  | { t: "free"; free: boolean }
  | { t: "tokens"; n: number; parent: string | null }
  | { t: "usage"; u: { usage: TokenUsage; growth: TokenUsage; first: boolean; model: string; parent: string | null } }
  | { t: "compaction"; e: { started?: boolean; trigger?: "auto" | "manual"; before?: number; after?: number; summary?: string; failed?: string } }
  | { t: "contextWindow"; w: { window: number; compactAt?: number } }
  | { t: "inputClosed"; why: string }
  /** A subagent read the user's messages to it (callId null: the turn's own main agent). Protocol 2. */
  | { t: "inboxTaken"; callId: string | null }
  | { t: "end"; error: string | null };

export type JournalEvent = TurnEvent & { seq: number };

/** The live state of the turn, sent whenever it changes and on every hello. Not journaled. */
export interface TurnState {
  t: "state";
  /** The turn is running in the SDK and steerable. */
  live: boolean;
  open: boolean;
  free: boolean;
  background: number;
  /** Agent calls whose subagent can be stopped on its own. */
  stoppers: string[];
}

/** Host to daemon, besides journaled events and the state. */
export type HostMessage =
  | { t: "hello"; protocol: number; version: string; pid: number; session: string; host: string; last: number }
  | { t: "refused"; why: string }
  | TurnState
  | { t: "delta"; text: string }
  /** A call into Studio's tools, waiting for the daemon to run it. `started`: an earlier daemon began running it. */
  | { t: "req"; id: string; callId: string; name: string; input: Record<string, unknown>; started: boolean }
  | { t: "ret"; id: string; value: unknown }
  | JournalEvent;

/** What the daemon asks of the host's turn. */
export type HostOp = "say" | "keep" | "interrupt" | "stopTask" | "cancelQueued" | "abort" | "tellSubagent";

/** Daemon to host. */
export type DaemonMessage =
  | { t: "hello"; protocol: number; token: string; from: number }
  | { t: "res"; id: string; exec: ToolExecution }
  | { t: "started"; id: string }
  | { t: "op"; id: string; op: HostOp; args?: Record<string, unknown> }
  | { t: "ack"; seq: number };

export const hostsDir = (dataDir: string): string => path.join(dataDir, HOSTS_DIR);
export const recordFile = (dataDir: string, host: string): string => path.join(hostsDir(dataDir), `${host}.json`);
export const journalFile = (dataDir: string, host: string): string => path.join(hostsDir(dataDir), `${host}.jsonl`);
export const launchFile = (dataDir: string, host: string): string => path.join(hostsDir(dataDir), `${host}.launch.json`);
export const logFile = (dataDir: string, host: string): string => path.join(hostsDir(dataDir), `${host}.log`);

/** A socket name of the host's own: a named pipe on Windows, a short path in the temp folder elsewhere. */
export function socketPathFor(host: string): string {
  if (process.platform === "win32") return `\\\\.\\pipe\\ue-mcp-studio-turn-${host}`;
  // Unix socket paths are limited to about 100 bytes.
  return path.join(os.tmpdir(), `umst-${crypto.createHash("sha256").update(host).digest("hex").slice(0, 16)}.sock`);
}

export function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

export function readRecord(file: string): TurnHostRecord | null {
  try {
    const r = JSON.parse(fs.readFileSync(file, "utf-8")) as TurnHostRecord;
    return typeof r.pid === "number" && typeof r.socket === "string" && typeof r.token === "string" && typeof r.session === "string" ? r : null;
  } catch {
    return null;
  }
}

/** Every host record in the data folder. */
export function listRecords(dataDir: string): TurnHostRecord[] {
  let names: string[];
  try {
    names = fs.readdirSync(hostsDir(dataDir));
  } catch {
    return [];
  }
  return names.filter((n) => /^[0-9a-f-]{36}\.json$/.test(n)).flatMap((n) => {
    const r = readRecord(path.join(hostsDir(dataDir), n));
    return r ? [r] : [];
  });
}

/** Remove a host's files: once its end is applied, or once it was stopped. */
export function removeHostFiles(dataDir: string, host: string): void {
  for (const f of [recordFile(dataDir, host), journalFile(dataDir, host), launchFile(dataDir, host)]) fs.rmSync(f, { force: true });
}

const SEQ = /^\{"seq":(\d+),/;

/** The journal's events after `after`, in order. A torn last line (the host died mid-write) is skipped. */
export function readJournal(file: string, after: number): JournalEvent[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return [];
  }
  const out: JournalEvent[] = [];
  for (const line of text.split("\n")) {
    const m = SEQ.exec(line);
    if (!m || Number(m[1]) <= after) continue;
    try {
      out.push(JSON.parse(line) as JournalEvent);
    } catch {
      // Half a line: the host was cut off while writing it.
    }
  }
  return out;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Send one message as a JSON line. False when the socket cannot take it. */
export function sendLine(socket: net.Socket | null, msg: unknown): boolean {
  if (!socket || socket.destroyed || !socket.writable) return false;
  try {
    socket.write(`${JSON.stringify(msg)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** Read JSON lines off a socket. A line that is not JSON is dropped. */
export function onLines(socket: net.Socket, handle: (msg: Record<string, unknown>) => void): void {
  let buf = "";
  socket.setEncoding("utf-8");
  socket.on("data", (chunk: string) => {
    buf += chunk;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg && typeof msg === "object") handle(msg as Record<string, unknown>);
    }
  });
}

/**
 * The wire between Studio's daemon and the durable harness: one long-lived
 * process per project that owns the project's Pi Durable storage and runs
 * every conversation on the durable runtime. The daemon is one of its
 * clients, so a daemon restart or a Studio update cuts nothing off: the
 * harness keeps running, holds what waits for the daemon (tool calls,
 * approvals, subagent slots) and hands it to the next daemon that connects.
 *
 * JSON lines over a local socket (a named pipe on Windows). Versioned and
 * additive like the turn host's wire: each side says its protocol in hello and
 * ignores a message type it does not know.
 *
 * Files, in the data folder's durable/: `harness.sqlite` (Pi Durable's
 * storage), `harness.json` (the record: pid, socket, token, version),
 * `harness.launch.json` (read once at start), `harness.log`.
 *
 * Nothing here imports Pi Durable: that stays in pi.ts.
 */
import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import type { Effort } from "@ue-mcp-studio/shared";
import type { ToolExecution } from "../tools.js";
import type { ToolImage } from "../images.js";

/** Bumped when a message is added or a meaning changes. */
export const DURABLE_PROTOCOL = 2;
export const DURABLE_DIR = "durable";

export const durableDir = (dataDir: string): string => path.join(dataDir, DURABLE_DIR);
export const storageFile = (dataDir: string): string => path.join(durableDir(dataDir), "harness.sqlite");
export const recordFile = (dataDir: string): string => path.join(durableDir(dataDir), "harness.json");
export const launchFile = (dataDir: string): string => path.join(durableDir(dataDir), "harness.launch.json");
export const logFile = (dataDir: string): string => path.join(durableDir(dataDir), "harness.log");
/** The harness's traces (Pi Durable and pi-ai spans and metrics), kept seven days. */
export const telemetryFile = (dataDir: string): string => path.join(durableDir(dataDir), "telemetry.sqlite");

/** The harness's socket: one per project data folder. */
export function harnessSocket(dataDir: string): string {
  const h = crypto.createHash("sha256").update(path.resolve(dataDir).toLowerCase()).digest("hex").slice(0, 16);
  if (process.platform === "win32") return `\\\\.\\pipe\\ue-mcp-studio-durable-${h}`;
  return path.join(os.tmpdir(), `umsd-${h}.sock`);
}

/** What a harness writes once it listens. A client trusts it only after hello with the same token. */
export interface HarnessRecord {
  protocol: number;
  /** The Studio version whose harness code runs; the Studio extension it runs may be newer (registry.install). */
  version: string;
  pid: number;
  socket: string;
  token: string;
  startedAt: string;
}

/** What the daemon hands a harness it starts. */
export interface HarnessLaunch {
  dataDir: string;
  projectDir: string;
  token: string;
  socket: string;
  version: string;
  /** Where the Claude runtime is, for the Claude sign-in's model provider. */
  claudeCommand?: string | null;
}

/** How a conversation reaches its model: data the harness turns into a pi-ai provider. */
export interface RouteSpec {
  /** Studio's route key, which its credential is asked for by: studio, key:anthropic, key:openai, key:google, chatgpt, endpoint:<id>, claude. */
  route: string;
  /** The pi-ai provider id the harness registers it under. */
  provider: string;
  api: "anthropic-messages" | "openai-responses" | "openai-completions" | "google-generative-ai" | "claude-code";
  model: string;
  baseUrl?: string;
  /** Extra request headers (the gateway's client header). */
  headers?: Record<string, string>;
  /** Sent as the gateway's session header, filled with the conversation's provider session id. */
  sessionHeader?: string;
  maxTokens?: number;
  contextWindow?: number;
  /** How the credential the daemon hands out is sent: as the API key, or as a bearer authorization header. */
  auth: "apiKey" | "bearer" | "none";
  /** The provider runs web search on its own side, paid by the user's key or subscription. Without it Studio offers its own web_search tool. */
  search?: boolean;
}

/** A tool as the daemon defines it, in the Messages format. */
export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** What one conversation runs with. */
export interface AgentSpec {
  route: RouteSpec;
  system: string;
  tools: ToolDef[];
  effort: Effort;
  maxTurns?: number;
  /** The provider's own web search goes with this conversation's requests (its route has one, and the agent may search). */
  search?: boolean;
}

/** Content of a user input, in pi-ai's form. */
export type UserContent = string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;

/** One committed transcript entry, as the daemon needs it. `parent`: the agent call whose subagent wrote it, null for the main agent. */
export interface EntryEvent {
  t: "entry";
  sessionId: string;
  conv: string;
  parent: string | null;
  id: string;
  kind: string;
  role: "user" | "assistant" | "toolResult" | "compaction" | "other";
  text?: string;
  toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  /** A tool result: its call, its text and whether it failed. */
  callId?: string;
  toolName?: string;
  isError?: boolean;
  /** An assistant message's spend. */
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number };
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  /** A compaction's summary. */
  summary?: string;
}

/** A requested piece of work the daemon does for the harness. */
export type HarnessRequest =
  /** Run one of Studio's tools: the editor wait, the approval gate and the call, exactly as the daemon runs every route's. `started`: a daemon was told to go, so the outcome of that run is unknown. */
  | { kind: "tool"; sessionId: string; conv: string; parent: string | null; callId: string; name: string; input: Record<string, unknown>; started: boolean }
  /** A subagent asks for its slot and what it runs with. Answered once it may start. */
  | { kind: "agent"; sessionId: string; callId: string; input: Record<string, unknown> }
  /** A fresh credential for a route. */
  | { kind: "credential"; route: string }
  /** #463 L3: may this local tool call run? The daemon's approval gate and input check. Answers LocalGate. */
  | { kind: "gate"; sessionId: string; parent: string | null; callId: string; name: string; input: Record<string, unknown> }
  /** #463 L3: a local tool call the harness ran ended: the daemon records it as every route does. Answers the ToolExecution the model is given. */
  | { kind: "finished"; sessionId: string; parent: string | null; callId: string; name: string; input: Record<string, unknown>; result: LocalOutcome };

/** The daemon's answer to a local call's gate: it may run, or it is blocked with the text the model gets. */
export type LocalGate = { allow: true } | { allow: false; text: string };

/** What a local tool call the harness ran came to. `unknown`: it may have run when the harness stopped, so its outcome is not known. */
export interface LocalOutcome {
  text: string;
  isError: boolean;
  outcome: "done" | "error" | "unknown";
  changed?: boolean;
  images?: ToolImage[];
}

export type AgentStart =
  /** `resume`: the agent call of a subagent that stopped or failed, whose kept conversation this one goes on in. A harness without it starts a new conversation. */
  | { ok: true; spec: AgentSpec; prompt: UserContent; description: string; resume?: string }
  | { ok: false; text: string; stopped?: boolean };

/** The harness's live work, for diagnostics: what is running, waiting, asleep or blocked, and what it reported lately. */
export interface DurableInspection {
  version: string;
  pid: number;
  extension: string;
  scheduling: string;
  tasks: Array<{
    id: string;
    kind: string;
    conversation: string;
    /** The Studio session and agent call (null: its main agent) the conversation belongs to, when known. */
    sessionId?: string;
    parent?: string | null;
    owner?: string;
    background: boolean;
    abortRequested: boolean;
    /** running, pending, waiting, sleeping, completing or blocked. */
    state: string;
    /** Why it cannot run (blocked), the tasks it waits on (waiting), or when it wakes (sleeping, epoch ms). */
    blocked?: string;
    on?: string[];
    until?: number;
  }>;
  submissions: Array<{ id: string; conversation: string; sessionId?: string; type: string; status: string }>;
  /** The newest reports first, at most 50. */
  reports: Array<{ at: string; kind: string; reason?: string; task?: string; message: string }>;
}

/** A message of a conversation in the Messages format Studio's other runtimes keep (text, image, tool_use and tool_result blocks). */
export interface HistoryMessage {
  role: "user" | "assistant";
  content: Array<Record<string, unknown>>;
}

/** Which traces to list: the newest first. */
export interface TraceFilter {
  /** The name of a trace's first span, such as pi.ai.request. */
  name?: string;
  /** Only traces with a failed span. */
  errors?: boolean;
  /** Only traces with a span for this Studio session's conversations. */
  sessionId?: string;
  /** Traces that started at or after this time (epoch ms). */
  since?: number;
  /** At most this many, 1 to 100 (20 when absent). */
  limit?: number;
  /** The `cursor` of the page before, with the same filter. */
  cursor?: string;
}

/** A trace in a list: its first span, how long it ran, and its tokens and cost when it made model requests. */
export interface TraceSummary {
  traceId: string;
  name: string;
  /** Epoch ms. */
  startedAt: number;
  durationMs: number;
  spans: number;
  errors: number;
  /** The first failed span's error. */
  error?: string;
  conversation?: string;
  sessionId?: string;
  parent?: string | null;
  model?: string;
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  cost?: number;
}

export interface TracePage {
  traces: TraceSummary[];
  /** More traces past these: pass it back to read the next page. */
  cursor?: string;
  /** Why no traces are kept, when they are not (the store could not be opened). */
  note?: string;
}

/** One trace with every span, and the spans as an indented tree. */
export interface TraceDetail {
  summary: TraceSummary;
  spans: Array<{ id: string; parentId?: string; name: string; startedAt: number; durationMs: number; status: "ok" | "error"; error?: string; attributes: Record<string, unknown>; events: Array<{ name: string; atMs: number; attributes: Record<string, unknown> }> }>;
  rendered: string;
}

/** One ledger bucket's totals, in pi-ai's usage counters. */
export interface LedgerUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
}

/** Client to harness. Requests carry an id answered by ret. */
export type ClientMessage =
  | { t: "hello"; protocol: number; token: string; version: string; role: "daemon" | "observer"; extension?: { version: string; file: string } }
  /** Run the session's main conversation on `content`: a new run, a steer into the running one, or a follow-up. */
  | { t: "submit"; id: string; sessionId: string; requestId: string; content: UserContent; agent: AgentSpec; whenBusy: "steer" | "followUp" }
  /** A migrated session's earlier conversation, written before its first run. */
  | { t: "seed"; id: string; sessionId: string; messages: Array<{ role: "user" | "assistant"; text: string }> }
  | { t: "abort"; id: string; sessionId: string; children: boolean }
  | { t: "stopChild"; id: string; sessionId: string; callId: string }
  /** The main agent's foreground agent calls stop waiting: their subagents go on in the background. */
  | { t: "background"; id: string; sessionId: string }
  /** The user's message to a running subagent. */
  | { t: "tell"; id: string; sessionId: string; callId: string; text: string; requestId: string }
  /** Send every entry after these, per conversation, then the live state. */
  | { t: "sync"; id: string; sessionId: string; after: Record<string, string> }
  | { t: "compact"; id: string; sessionId: string; instructions: string }
  /** Protocol 2: a subagent the user assigned from the chat, run beside the main agent's runs under its own call id. */
  | { t: "assign"; id: string; sessionId: string; callId: string; start: Extract<AgentStart, { ok: true }> }
  /** What the harness is doing: its live tasks, queued submissions and recent reports. Reads only. An older harness never answers it. */
  | { t: "inspect"; id: string }
  /** The harness's traces, newest first (answers a TracePage), or one trace with its spans (a TraceDetail or null). Reads only. An older harness never answers it. */
  | { t: "traces"; id: string; filter?: TraceFilter; traceId?: string }
  /** The main agent's conversation as the model sees it, for a session leaving this runtime: HistoryMessage[], or null. Reads only. An older harness never answers it. */
  | { t: "history"; id: string; sessionId: string }
  /** An edited message or a fork: conversation `to` goes on from just before the message in `from`. Answers { conv, at } or null. An older harness never answers it. */
  | { t: "fork"; id: string; from: string; to: string; text: string; fromEnd: number }
  | { t: "res"; reqId: string; value: unknown }
  /** A daemon-side tool run got past its gate and is about to run. The harness records it before answering go. */
  | { t: "started"; reqId: string };

/** Harness to client. */
export type HarnessMessage =
  /** `features`: what this harness sends beyond its protocol, such as "usage" (its spend ledgers). Absent on an older harness. */
  | { t: "hello"; protocol: number; version: string; pid: number; extension: string; features?: string[] }
  /**
   * A conversation's spend ledger (Pi Durable's pi.usage): totals per provider/model, counting what has no
   * transcript entry too, such as compaction summaries. Sent whenever it changes and on sync; the daemon counts
   * what grew since the totals it last saw.
   */
  | { t: "usage"; sessionId: string; parent: string | null; conv: string; models: Record<string, LedgerUsage> }
  | { t: "refused"; why: string }
  | { t: "ret"; id: string; ok: boolean; value?: unknown; error?: string }
  | EntryEvent
  /** The text the current generation has written so far. */
  | { t: "delta"; sessionId: string; parent: string | null; text: string; thinking?: string }
  /** A conversation's run started, or ended (with why it ended without an answer). */
  | { t: "run"; sessionId: string; parent: string | null; running: boolean; failure?: { reason: string; detail?: string } }
  /** A subagent conversation was made for an agent call. */
  | { t: "child"; sessionId: string; callId: string; conv: string }
  /** A subagent's agent call ended: in the foreground its result is the tool result entry; in the background this carries its report. */
  | { t: "agentEnd"; sessionId: string; callId: string; text: string; isError: boolean; stopped: boolean; background: boolean; assigned?: boolean }
  /** What became of a message to a subagent: it read it, or it ended first and the message went to the main agent. */
  | { t: "told"; sessionId: string; callId: string; requestId: string; delivery: "read" | "main" }
  | { t: "req"; reqId: string; req: HarnessRequest }
  /** The harness recorded that a tool run started: the daemon runs it now. */
  | { t: "go"; reqId: string }
  /** #463 L3: what a local tool call running in the harness printed, as it prints it. */
  | { t: "output"; sessionId: string; callId: string; text: string }
  /** The harness withdrew a request (its call was aborted): the daemon stops waiting on its side. */
  | { t: "cancel"; reqId: string };

export type ToolAnswer = ToolExecution;

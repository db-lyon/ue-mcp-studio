/**
 * The agent loop, and how a turn survives the editor going away.
 *
 * A turn is model call, tool calls, model call, until the model stops asking
 * for tools. It pauses at the tool-call boundary when the editor is down, and
 * resumes on its own when the editor is back. A call that was running when
 * the editor died has an unknown outcome: it is never run again blindly. On
 * reattach the runner reports what it can establish from disk and tells the
 * model to read the state back. After a crash, every change the session made
 * and never saved is listed as lost before the model continues.
 *
 * A command or a file change waits for the user to allow it (gate), unless the
 * setting is off or the user allowed that kind for the session. The request
 * goes out on the event stream and the answer comes back through answerApproval.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_USAGE, type ApprovalDecision, type ApprovalKind, type Approvals, type ApprovalRequest, type Effort, type PlaytestRunsMode, type TranscriptEntry, type UsageSettings } from "@ue-mcp-studio/shared";
import { AUTO_COMPACT_FRACTION, EMPTY_TOTALS, contextTokens, contextWindowOf, estimateTokens, requestCost, type CompactionRecord } from "@ue-mcp-studio/shared";
import type { ContentBlock, ModelProvider, ModelTurn, MessageParam, WebSearchRecord } from "./providers.js";
import { promptTokens, usageTokens, type TokenUsage } from "./usage.js";
import { DEFAULT_SESSION_TITLE, SessionStore, type PendingTool, type StoredContext, type StoredSession } from "./sessions.js";
import { compactedMessages, conversationText, estimateMessagesTokens, isCompactedSummary, isContextOverflow, summaryInstruction, summaryRequest } from "./compaction.js";
import type { QueuedMessage } from "@ue-mcp-studio/shared";
import type { CardEntry, CardPost } from "@ue-mcp-studio/extension-api";
import type { BusyTracker } from "./busy.js";
import type { DialogBroker } from "./dialogs.js";
import type { QaBroker } from "./qa.js";
import { TOOLS, WORK_TOOLS, editorConnected, executeTool, forModel, packageFile, validateInput, verifyUnknown, type AgentHost, type ToolExecution } from "./tools.js";
import type Anthropic from "@anthropic-ai/sdk";
import { approvalFor, localToolDefinitions, shell } from "./local-tools.js";
import { callInsideProject } from "./project-scope.js";
import { MICRO_LINE, microSurface, withSurface, type EditorSurface } from "./context-surface.js";

/** Set by the release bundle: false leaves the Agent SDK out of it. Unset in development and tests. */
declare const __CLAUDE_SIGN_IN__: boolean | undefined;
import { modelName } from "./models.js";
import { AttachmentStore, contentFor } from "./attachments.js";
import { keptName, toolResultContent } from "./images.js";
import { USER_SENT, USER_STOP, interruptedResult, interruptionLine, interruptionNote, type Interruption } from "./interruptions.js";
import { actionCommandText, flowCommandText, flowValue, parseActionArgs, parseFlowArgs, parseSlashCommand, splitActionName, type ActionRunRequest, type Attachment, type FlowRunRequest, type PlaytestRequest } from "@ue-mcp-studio/shared";
import { applyStepEvent, type FlowCaller } from "./flow-run.js";
import { QUEUED_STOP, SubagentSlots } from "./subagent-slots.js";
import { SUBAGENT_MESSAGES_LINE, SubagentInbox, aboutNote, heardNote, toSubagent, unreadNote } from "./subagent-inbox.js";
import type { LiveTurn } from "./subscription.js";
import { DETACHED, type HostedCallbacks, type HostedResult, type HostedRun, type TurnHosts } from "./hosted-turn.js";
import { STUDIO_SUBAGENTS_PROTOCOL, type TurnHostRecord, type TurnSpec } from "./turn-host-protocol.js";
import { playtestParams, playtestTurnParams, type PlaytestFlow } from "./playtest-flow.js";
import { NOTHING, conditionalFor, pathsOf, type Composed } from "./instructions.js";
import { NO_EFFECTS, SESSION_KEY, approvalKind, editorPreview, flowStepCall, flowStepKind, type ActionEffects } from "./approval-kind.js";
import { AGENT_TOOL } from "./tools.js";
import { SKILL_TOOL, agentTool, skillResult, skillsSection, type NativeHelper, type NativeRun } from "./native-runtime.js";

/** The most of a /action's answer the agent's note carries; the transcript keeps all of it. */
export const ACTION_NOTE_CHARS = 4000;
/** The id a /action's call is recorded under, so a daemon restart can tell it from a turn's. */
export const ACTION_CALL_PREFIX = "action-";
/** The id of an approval a flow step asks before the flow runs. */
export const FLOW_STEP_PREFIX = "flow-step-";
/** Studio's name as a ue-mcp daemon extension: its routes are /v1/ext/studio. */
export const STUDIO_EXTENSION = "studio";

/**
 * Testing gameplay with the user: a playtest, which is a test script the agent
 * creates and Studio shows as a Playtest card in the chat, never a list or a
 * table of steps written out in a reply. Who starts its run follows the
 * project's Playtest runs setting.
 */
export const QA = [
  "When the user wants gameplay tested or checked in Play In Editor (a playtest, a QA pass, a test plan, a checklist, steps to try), do not write the steps out as a list in your reply, and not as a table either. "
    + "Deliver it as a playtest: create a ue-mcp test script with pie.script_create (pie.script_update changes one), and Studio shows it as a Playtest card in the chat. Even when the user asks only for a draft or a plan, the draft is the created script.",
  "Every playtest is a created script and its card; there is no other way to deliver one. A reply that lists steps marked PASS or FAIL, or steps for the user to try, as prose or a table, is a failed playtest. "
    + "Never mark a step passed or failed from your own reading of the editor: the script run's observer, the user on the card, or a subagent the user assigned decides it.",
  "Make a step auto with an expect when a value the observer reads can decide it (a property, a distance, visibility), and manual when only a person can judge it (how it looks or feels). Describe pie.script_create first for the step format. "
    + "In a step's instruction, write each asset it names as a markdown link to its object path, as in a reply, so the Playtest card links it. "
    + "In a multiplayer playtest give each step a player, \"host\" or \"client 1\", \"client 2\" and so on: Studio keeps it, shows it on the card and takes it out before ue-mcp sees the step.",
  "The user answers manual steps with the Pass, Fail and Skip buttons on the Playtest card. Never call pie.verdict for a manual step yourself unless the user told you that step's outcome in a message, "
    + "or the user assigned you the playtest from its card: then follow that brief, which says how to drive PIE and which steps you judge. "
    + "If a run's answer says steps are awaiting a verdict, tell the user to answer them on the Playtest card and end your turn.",
];

/** What the agent is told about starting runs, by the Playtest runs setting. */
export function playtestRunsLine(mode: PlaytestRunsMode): string {
  return mode === "automatic"
    ? "Starting playtests is set to Automatic in Settings > Approvals & review: you may start a playtest yourself with pie.script_run (wait: true, start_pie: true when PIE is not running) when the user wants it run, then report the summary and the results_path. Its card goes live."
    : "Starting playtests is set to Manual in Settings > Approvals & review: only the user starts a playtest, with Start playtest or Assign to subagent on its card. Never call pie.script_run or pie.script_replay; Studio refuses them. Create or update the script, tell the user it is on the card, and end your turn. If the user wants you to run playtests yourself, tell them to set Starting playtests to Automatic.";
}

/** The SDK's options for the surface: ue-mcp's projected tools in place of ue_mcp, on Lean and Full. */
const sdkEditor = (s: EditorSurface) =>
  s.strategy === "micro" ? {} : { editor: { tools: s.projected.map(({ name, description, inputSchema, category }) => ({ name, description, inputSchema, category })), canon: s.canon } };

const WORK = [
  MICRO_LINE,
  "Prefer a dedicated action to editor.execute_python. Save what you change when the task is done, unless the user says otherwise.",
  "Results report what happened (created, existed, updated, saved): read them instead of assuming.",
  "When you name an Unreal asset in a reply, write it as a markdown link to its full object path, for example [SG_PlaceAssembly](/Game/Environment/PCG/Library/SG_PlaceAssembly.SG_PlaceAssembly).",
  "You also have the user's machine: shell for git, builds and scripts; read_file, glob and grep for source, docs and config; write_file and edit_file to change text files; web_fetch to read a URL or call a web API; and web_search when it is offered.",
  "Use those for files, version control and the web, never for what ue_mcp does in the editor. .uasset and .umap files are binary and the editor owns them: change them through ue_mcp, not the file tools.",
  "Stop or restart this project's editor with editor_restart or ue_mcp editor.stop_editor. Never kill an editor process from the shell, by PID or by name: other projects' editors run on the same machine.",
  "Read a file before you edit it. Commands and file changes may wait for the user to allow them; when the user declines one, do not try it again in another form: take another way or ask.",
  ...QA,
];

/** How the user's @-mentions reach the agent (mentionToken in the shared package). */
export const MENTION_LINE = "The user's messages can mention things as [@Name](target \"Type\"). The target is an asset's object path, actor:<object path> for an actor in the open level, or file:<path from the project folder>. Use the target as it is; it needs no search.";

/** That a reply can show the project's images; the chat loads them through /files/image. */
export const IMAGES_LINE = "To show the user an image from the project (a playtest capture, a screenshot), put it in your reply as markdown, ![what it shows](its path from the project folder): the chat displays it. png, jpg, gif, webp and bmp, up to 25 MB.";

/** Where the machine tools work, for the prompts. */
const where = (projectDir: string): string =>
  `The project folder is ${projectDir}: commands run there and relative paths start there. The shell is ${shell().name}.`;

/** What the main agent is told about subagents, by the Subagents setting; nothing when they are off. */
export function subagentLine(usage: Pick<UsageSettings, "subagents" | "subagentsPerTurn">): string | null {
  const n = usage.subagentsPerTurn;
  const most = n === -1
    ? "There is no limit on how many run at once."
    : `${n} subagent${n === 1 ? " runs" : "s run"} at once; any more wait and start as running ones finish, each still returning its own report.`;
  if (usage.subagents === "off") return null;
  if (usage.subagents === "asked") return `Start a subagent with the agent tool only when the user asks for one; otherwise do the work yourself. ${most}`;
  return "For work that splits into independent parts, start a subagent per part with the agent tool, several in one message so they run at the same time. "
    + `Give each one different assets and files, then check what they report. ${most}`;
}

const system = (projectDir: string, runs: PlaytestRunsMode, usage: UsageSettings = DEFAULT_USAGE, instructions: Composed = NOTHING): string => [
  "You work inside Unreal Editor for the user, through ue-mcp, and on the project's files on their machine.",
  ...WORK,
  MENTION_LINE,
  IMAGES_LINE,
  playtestRunsLine(runs),
  where(projectDir),
  subagentLine(usage),
  "When the editor restarts or crashes during your work, a note tells you why and what was lost. Do not repeat a call whose outcome is unknown without reading the state first.",
  instructions.text,
].filter((l): l is string => !!l).join("\n");

/** What a subagent is told: the same way of working, and to end with a report for the agent that started it. */
export const SUBAGENT_SYSTEM = [
  "You are a subagent working inside Unreal Editor through ue-mcp, and on the project's files, on one task another agent gave you.",
  ...WORK,
  "Stay within the task. Other subagents may be working on other assets and files at the same time.",
  "Finish with a short report: what you created or changed (asset paths and files), what you saved, and anything that failed.",
].join("\n");

const subagentSystem = (projectDir: string, runs: PlaytestRunsMode, instructions: Composed = NOTHING): string =>
  [SUBAGENT_SYSTEM, playtestRunsLine(runs), where(projectDir), SUBAGENT_MESSAGES_LINE, instructions.text]
    .filter((l): l is string => !!l).join("\n");

/** What a subagent's run settles with. */
type AgentResult = { text: string; isError: boolean; stopped?: boolean };
/** What its agent call is answered with: its result, or that it goes on in the background. */
type AgentAnswer = AgentResult & { background?: true };

/** What the main agent's agent call says when its subagent goes on in the background. */
export const backgroundNote = (description: string): string =>
  `The subagent "${description}" keeps working in the background: the user wrote to you, or stopped only your reply, while it worked. `
  + "Its report comes to you in a later message when it ends. Do not redo its task meanwhile.";

/** What the main agent is told when a subagent that went on in the background ends. */
export const backgroundReport = (description: string, callId: string, r: AgentResult): string =>
  `The subagent "${description}" (agent call ${callId}), which kept working in the background, has ended. `
  + `${r.stopped ? "The user stopped it before it finished." : r.isError ? "It failed." : "It finished."} Its report:\n${r.text}`;

/**
 * One subagent the session runs, on any route: started by the main agent's
 * agent call, or by the user from the chat (assigned). Its conversation runs
 * on the route's engine (Studio's loop, or a Claude sign-in session of its
 * own), and every path that steers it (stop, background, limits, messages,
 * its report) goes through here.
 */
interface AgentRun {
  sessionId: string;
  callId: string;
  description: string;
  /** Started by the user from the chat, beside the session's turns; its report becomes a note. */
  assigned: boolean;
  /** Its agent call was answered already, so its report reaches the main agent as a message. */
  background: boolean;
  /** Settles with its result. */
  done: Promise<AgentResult & { detached?: true }>;
  /** What the agent call waiting on it is answered with: its result, or the background note. */
  call: Promise<AgentAnswer>;
  answer: (a: AgentAnswer) => void;
  /** Undoes what ties it to the main agent's reply (following its Stop), when it goes to the background. */
  detach: Array<() => void>;
  /** Streams the user's message into its conversation (a Claude sign-in session); null where it reads its inbox (Studio's loop) or has not started. */
  say: ((text: string) => Promise<boolean>) | null;
  /** The turn host its conversation runs in, when it runs in one. */
  hosted: HostedRun | null;
  /** What the user wrote to it from its thread, which its result names so the main agent knows where an instruction came from. */
  told: string[];
}

/** Turn host session key of a subagent's conversation. */
const agentHostKey = (sessionId: string, callId: string): string => `${sessionId}#${callId}`;

/** What the model is told when the user declines a call. */
const declinedText = (name: string): string =>
  `The user declined this ${name === "shell" ? "command" : "file change"}, so it did not run. Do not try it again in another form: take a different approach, or ask the user what they want.`;

/** A gate's answer: run the call (null), or why it must not. */
type GateResult = null | { declined: string } | { stopped: true };

/** What the model is told when the user edits an earlier message and the conversation after it is gone. */
export const REWOUND_NOTE = "The user edited an earlier message, so the conversation was cut back to it and continues from the edited message below. "
  + "Nothing done after it in the earlier version was undone: assets, levels and files it changed stay changed. Read their current state before relying on it.";

/** How many model calls one subagent may make before it is stopped. */
const SUBAGENT_STEPS = 200;

/** How long editor_restart waits for the editor to connect again after the daemon reports it started. */
export const EDITOR_BACK_MS = 10 * 60_000;

/**
 * How long an editor call waits for a disconnected editor when no restart or
 * rebuild is running to bring it back. Past this the call goes ahead and gets
 * the daemon's own answer, instead of the turn waiting on nothing (#1384).
 */
export const IDLE_EDITOR_WAIT_MS = 60_000;

/** Why the daemon went down, written by whatever restarts it on purpose and read by the next daemon. */
export const RESTART_CAUSE_FILE = "restart-cause.json";
const RESTART_CAUSE_TTL_MS = 10 * 60_000;

export interface RunnerOptions {
  host: AgentHost;
  store: SessionStore;
  provider: () => ModelProvider;
  model: () => string;
  /** How long the model reasons; high when not given. */
  effort?: () => Effort;
  /** Subagents and project instructions; the defaults when not given. */
  usage?: () => UsageSettings;
  /** The model subagents run on; the main model when not given. */
  subagentModel?: () => string;
  /**
   * The model is reached through the Claude sign-in's runtime (subscription.ts)
   * rather than a provider's API: each conversation step, the main agent's
   * reply or one subagent, runs there. Orchestration is Studio's either way.
   */
  subscription?: () => boolean;
  /** How the model is reached for this turn: a sign-in or a key, by name. */
  route?: () => string | null;
  /** Ask the user before a command runs or a file changes; on when not given. Approvals, when given, decide instead. */
  askBeforeChanges?: () => boolean;
  /** What each kind of action does first: ask or go ahead. */
  approvals?: () => Approvals;
  /** ue-mcp's effects per action, for the destructive-actions row. */
  effects?: ActionEffects;
  /** How ue-mcp's tools are put to the agent this turn: Micro unless given. */
  surfaces?: { current(): EditorSurface };
  /** The main agent's vendor's own files: instructions, subagents and skills. Null while "Read the project's own files" is off. */
  native?: () => NativeRun | null;
  /** Tracks each turn's editor calls, for the window's busy state. */
  busy?: BusyTracker;
  /** Puts the editor dialogs a session's calls meet in the chat. */
  dialogs?: DialogBroker;
  /** Puts the PIE test script runs a session's calls start in the chat, as Playtest cards. */
  qa?: QaBroker;
  /** The project's Playtest runs setting, for the prompts; manual when not given. */
  playtestRuns?: () => PlaytestRunsMode;
  /** Runs ue-mcp's playtest flow for /playtest, Make playtest and Retry. */
  playtestFlow?: PlaytestFlow;
  /** Per-turn review: a checkpoint before each turn and after it. */
  review?: { turnStarted(s: StoredSession): Promise<void>; turnEnded(s: StoredSession): Promise<void> };
  /** Runs any of the project's flows for /flow. */
  flows?: FlowCaller;
  /**
   * Whether the daemon asks Studio before each flow step as it runs (ue-mcp
   * feature "flows.stepApproval", answered by approveFlowStep). Without it a
   * flow's steps ask from its plan before it starts.
   */
  flowStepApproval?: () => boolean;
  /** A model's context window as the vendor's model list gave it, when it did. */
  contextWindow?: (model: string) => number | undefined;
  /**
   * Runs Claude sign-in conversation steps (the main agent's replies and each
   * subagent) in host processes that outlive this daemon, so an update or a
   * daemon restart does not end them. Without it, or when a host cannot start,
   * a step runs in the daemon.
   */
  turnHosts?: TurnHosts;
}

/** Where a Claude sign-in reply's own bookkeeping stands; kept with the session while it runs in a host. */
interface TurnTrack {
  /** The last host event applied. */
  seq: number;
  /** The main agent's message the next block of the same id merges into. */
  lastId: string | null;
  /** Compatibility (a host before protocol 3): the runtime's own agent calls running in the background. */
  background: string[];
}

/** A conversation compaction can rewrite: the main agent's, or one subagent's. */
interface Conversation {
  /** null for the main agent, else the subagent's agent call id. */
  agent: string | null;
  /** Rewritten in place. */
  messages: MessageParam[];
  model: string;
  /** What the system prompt and the tools take, before any message. */
  overhead: number;
  /** Ask the model for the summary. */
  summarize: (messages: MessageParam[], signal: AbortSignal) => Promise<{ text: string; usage?: TokenUsage }>;
}

type CompactionEntry = Extract<TranscriptEntry, { kind: "compaction" }>;

const textOf = (content: ContentBlock[]): string =>
  content.filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text").map((b) => b.text).join("");

const now = (): string => new Date().toISOString();

/** editor(list_dirty_packages)'s package names, from its content and maps lists; null for an answer that is not one. */
export function parseDirty(text: string): string[] | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || (v as { success?: unknown }).success === false) return null;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.content) && !Array.isArray(o.maps)) return null;
  const names = new Set<string>();
  for (const list of [o.content, o.maps]) {
    for (const e of Array.isArray(list) ? list : []) {
      const name = typeof e === "string" ? e : e && typeof e === "object" ? (e as { package?: unknown }).package : null;
      if (typeof name === "string" && name) names.add(name);
    }
  }
  return [...names].sort();
}

/** A promise's value, or null as soon as the signal aborts. The work goes on; its result is dropped. */
export function unlessAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then((v) => {
      signal.removeEventListener("abort", onAbort);
      resolve(v);
    }, (e) => {
      signal.removeEventListener("abort", onAbort);
      reject(e);
    });
  });
}

/** The conversation so far as text, for a Claude session that starts in the middle of it. Keeps the most recent part when long. */
/**
 * A call ue-mcp answered without doing it: a result whose JSON says success is
 * false, or that the call was blocked or refused. ue-mcp returns these as
 * ordinary results, so the call would otherwise read as done.
 */
export function refused(result: unknown): boolean {
  if (typeof result !== "string" || !result.trimStart().startsWith("{")) return false;
  try {
    const r = JSON.parse(result) as Record<string, unknown>;
    return r.success === false || r.blocked === true || r.dialogBlocking === true || typeof r.refusedMethod === "string";
  } catch {
    return false;
  }
}

export function carryOver(messages: MessageParam[], max = 60_000): string {
  const lines: string[] = [];
  for (const m of messages) {
    const parts = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as Array<{ type: string; text?: string; name?: string; input?: unknown }>);
    for (const p of parts) {
      if (p.type === "text" && p.text?.trim() && !p.text.startsWith("[Studio]")) lines.push(`${m.role === "user" ? "User" : "Assistant"}: ${p.text.trim()}`);
      else if (p.type === "tool_use" && p.name) lines.push(`Assistant called ${p.name} ${JSON.stringify(p.input ?? {}).slice(0, 300)}`);
    }
  }
  let text = lines.join("\n\n");
  if (text.length > max) text = `(earlier part left out)\n\n${text.slice(text.length - max)}`;
  return `[Studio] This session continues a conversation that ran on other models. Here it is so far:\n\n${text}\n\n[Studio] End of the earlier conversation. The user's new message follows.`;
}

/** An agent call's description, as its thread is titled. */
const describeCall = (input: unknown): string => {
  const d = (input as { description?: unknown } | null)?.description;
  return typeof d === "string" && d.trim() ? d.trim() : "Subagent";
};

/** Add text to a conversation as the user's: into its last user message (after tool results), or as a new one after the model's. */
export function addUserText(messages: MessageParam[], text: string): void {
  addUserContent(messages, [{ type: "text", text }]);
}

/** Add content blocks to a conversation as the user's, the same way as addUserText. */
export function addUserContent(messages: MessageParam[], content: unknown[]): void {
  const last = messages[messages.length - 1];
  if (last?.role !== "user") {
    messages.push({ role: "user", content } as MessageParam);
    return;
  }
  const blocks = typeof last.content === "string" ? [{ type: "text", text: last.content }] : [...(last.content as unknown[])];
  last.content = [...blocks, ...content] as MessageParam["content"];
}

/** Card extension names and types: the same rule the client's slot registry applies. */
const CARD_NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** A card is a summary for the panel; anything bigger belongs behind the extension's own route. */
const MAX_CARD_BYTES = 64 * 1024;

export class AgentRunner {
  /** The main agent's running reply, by session: what its Stop aborts. */
  private readonly active = new Map<string, AbortController>();
  /** Sessions whose main agent is replying now (as opposed to idle while its subagents work). */
  private readonly replying = new Set<string>();
  /** The main agent's reply on the Claude sign-in while it runs, by session: what a message mid-reply is streamed into. */
  private readonly live = new Map<string, LiveTurn>();
  /** Replies running in a host process, by session: a daemon restart leaves them running. */
  private readonly hosted = new Map<string, HostedRun>();
  /** Every subagent running or waiting to start, by its agent call id, on every route. */
  private readonly runs = new Map<string, AgentRun>();
  /** How many subagents run at once, by session: one queue for every agent call of the session. */
  private readonly slots = new Map<string, SubagentSlots>();
  /** What waits for the main agent's next step while its turn runs (the user's messages, background reports), by session. */
  private readonly mainInbox = new Map<string, unknown[][]>();
  /** Each running subagent's stop, by its agent call id, so one can be stopped without the turn. */
  private readonly subagents = new Map<string, () => void>();
  /** What the user sent running subagents on Studio's loop, until each reads it before its next model call. */
  private readonly inbox = new SubagentInbox();
  /** Agent calls marked waiting to start before their transcript entry arrived. */
  private readonly queuedEarly = new Set<string>();
  /** Compatibility: replies in a turn host from before protocol 3, which runs the runtime's own subagents, by session. */
  private readonly legacy = new Map<string, LiveTurn>();
  /** The daemon is going down: subagents left running are the next daemon's. */
  private disposed = false;
  /** Calls waiting for the user, by approval id, with how to answer each. */
  private readonly waitingApprovals = new Map<string, { sessionId: string; parent: string | null; answer: (d: ApprovalDecision | "stopped") => void }>();
  /** Why the editor last went away, for waiting turns and unknown outcomes. */
  private lastCause = "the editor is not connected";
  /** The editor's dirty packages as it last listed them, read after each change or save. */
  private dirty: string[] = [];
  /** The packages that were dirty when the editor last crashed: lost with it. */
  private lostPackages: string[] = [];
  /** A dirty-package read in flight, and whether another change came in meanwhile. */
  private dirtyRead: { again: boolean } | null = null;
  private readonly unsubscribe: () => void;
  /** Where the images a tool showed the model are kept for the panel. */
  private readonly files: AttachmentStore;

  constructor(private readonly o: RunnerOptions) {
    this.files = new AttachmentStore(o.host.dataDir);
    o.host.setBusy(() => this.runs.size > 0 || o.store.all().some((s) => s.status === "running" || s.status === "waiting"));
    this.unsubscribe = o.host.events.subscribe((e) => {
      if (e.type === "editor.disconnected") {
        const cause = String(e.data.cause ?? "unknown");
        this.lastCause = cause === "crashed" ? "the editor crashed"
          : cause === "closed" ? "the editor was closed"
          : cause === "restarting" ? "the editor is restarting"
          : cause === "rebuild" ? "the project is rebuilding"
          : "the editor connection dropped";
        // What was unsaved when it went: the last dirty-package list the editor gave.
        this.lostPackages = cause === "crashed" ? [...this.dirty] : [];
        for (const s of o.store.all()) {
          const turn = this.busy(s);
          // The turn's transcript keeps the disconnect and its cause after the waiting line is gone (#144).
          if (turn) this.addEntry(s, { kind: "note", text: `The editor disconnected during this turn: ${this.lastCause}.`, at: now() });
          if (cause === "crashed" && (turn || s.touched.length > 0)) {
            s.crashed = true;
            // A session with no turn running keeps its place in the list.
            o.store.save(s, { touch: turn });
          }
        }
      } else if (e.type === "editor.connected") {
        // With the editor back, what the crash lost is listed at once, not on the session's next message.
        for (const s of o.store.all()) if (s.crashed && this.busy(s)) this.reconcileCrash(s);
        this.resumeAll();
      } else if (e.type === "studio.busy.changed" && e.data.failure && !e.data.operation) {
        // The restart or rebuild ended without the editor: nothing will bring it back, so stop waiting for it.
        this.resumeAll();
      }
    });
  }

  /** The host a session's tool calls run on: its editor calls are tracked when there is a busy tracker. */
  /** assigned: a subagent the user started from a card, whose runs are the user's. */
  private hostFor(sessionId: string, assigned = false): AgentHost {
    const host = this.o.dialogs ? this.o.dialogs.wrap(this.o.host, sessionId) : this.o.host;
    const tracked = this.o.busy ? this.o.busy.wrap(host, sessionId) : host;
    return this.o.qa ? this.o.qa.wrap(tracked, sessionId, { assigned }) : tracked;
  }

  /** The Playtest runs setting the prompts state. */
  private runsMode(): PlaytestRunsMode {
    return this.o.playtestRuns?.() ?? "manual";
  }

  private usage(): UsageSettings {
    return this.o.usage?.() ?? DEFAULT_USAGE;
  }

  /** Conditional instruction files each conversation has been given, by session id or helper call id. */
  private readonly instructionsSent = new Map<string, Set<string>>();

  private composed(): Composed {
    return this.native()?.composed ?? NOTHING;
  }

  private native(): NativeRun | null {
    return this.o.native?.() ?? null;
  }

  /** The main agent's tools: the work tools, the agent tool unless workers are off, and the skill tool when there are skills. */
  /** The editor surface for this turn: Studio's ue_mcp on Micro, ue-mcp's projected tools on Lean and Full. */
  private surface(): EditorSurface {
    return this.o.surfaces?.current() ?? microSurface();
  }

  /** The editor tools of the surface, then the machine's. */
  private workTools(surface = this.surface()): Anthropic.Beta.BetaToolUnion[] {
    return surface.strategy === "micro" ? [...WORK_TOOLS] : [...surface.tools, ...localToolDefinitions()];
  }

  /** Run one call: a projected tool that is not a category through the daemon's context.call, everything else through Studio's executor. */
  private execute(host: AgentHost, name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<ToolExecution> {
    const pass = this.surface().passthrough(name);
    if (!pass) return executeTool(host, name, input, signal);
    return pass(input).then(
      (r) => {
        const text = r.content.map((c) => c.text ?? "").filter(Boolean).join("\n") || (r.isError ? "The call failed." : "Done.");
        return { text, isError: r.isError, outcome: r.isError ? "error" : "done", touched: [], saved: [] } as ToolExecution;
      },
      (e: unknown) => ({ text: e instanceof Error ? e.message : String(e), isError: true, outcome: "error", touched: [], saved: [] }) as ToolExecution,
    );
  }

  private mainTools(surface = this.surface()) {
    const n = this.native();
    const tools = this.workTools(surface);
    const agent = this.agentDefinition();
    if (agent) tools.push(agent);
    if (n?.skills.length) tools.push(SKILL_TOOL);
    return tools;
  }

  /**
   * Studio's agent tool as every route's main agent gets it, with the
   * project's helpers listed; null while subagents are off, when neither
   * Studio's worker nor the project's helpers run.
   */
  private agentDefinition(): Anthropic.Beta.BetaToolUnion | null {
    if (this.usage().subagents === "off") return null;
    return agentTool(AGENT_TOOL, (this.native()?.helpers ?? []).map((h) => ({ name: h.name, description: h.description })));
  }

  /** What Studio adds to the SDK's prompt from the project's files: nothing when the SDK reads them itself. */
  private sdkComposed(): Composed {
    const n = this.native();
    return n?.sdkLoads ? NOTHING : this.composed();
  }

  /** The SDK options that load the project's own Claude Code instructions and skills; none while they are off. */
  private sdkNative(): { native?: { settingSources: Array<"user" | "project" | "local">; skills: boolean } } {
    const n = this.native();
    if (!n?.sdkLoads) return {};
    return { native: { settingSources: ["user", "project", "local"], skills: n.skills.length > 0 } };
  }

  /** The skills line of a prompt, when the project has skills. */
  private skillLines(): string | null {
    const n = this.native();
    return n ? skillsSection(n.skills) : null;
  }

  /**
   * A call's result with the instruction files that apply to what it touched:
   * a subfolder's AGENTS.md once the agent works there, a rule whose globs
   * match a file it read or changed. Each once per conversation.
   */
  private withInstructions(conversation: string, name: string, input: Record<string, unknown>, exec: ToolExecution, sdk = false): ToolExecution {
    // On the Claude sign-in the SDK loads a subfolder's files itself when the agent works there.
    const c = sdk ? this.sdkComposed() : this.composed();
    if (c.conditional.length === 0) return exec;
    let sent = this.instructionsSent.get(conversation);
    if (!sent) this.instructionsSent.set(conversation, (sent = new Set()));
    const extra = conditionalFor(c, pathsOf(this.o.host.projectDir, name, input), sent);
    if (!extra) return exec;
    return { ...exec, text: `${exec.text}\n\n${extra}`, ...(exec.modelText !== undefined ? { modelText: `${exec.modelText}\n\n${extra}` } : {}) };
  }

  private subagentModel(): string {
    return this.o.subagentModel?.() ?? this.o.model();
  }

  private subagentEffort(): Effort {
    return this.usage().subagentEffort ?? this.o.effort?.() ?? "high";
  }

  /** Add tokens an agent spent to the session's per-agent totals: "main", or the subagent's agent call id. */
  private count(s: StoredSession, tokens: number, agent: string | null): void {
    if (tokens <= 0) return;
    const t = (s.tokens ??= {});
    const key = agent ?? "main";
    t[key] = (t[key] ?? 0) + tokens;
  }

  /** A model's context window: the vendor's listed one when the catalog has it, else what Studio knows of the model. */
  private windowFor(model: string): number {
    return contextWindowOf(model, this.o.contextWindow?.(model)).tokens;
  }

  /** Add a request's tokens to the session's totals. `request`: count it as a request (the SDK reports one several times). */
  private spend(s: StoredSession, u: TokenUsage | undefined, model: string, request = true): void {
    if (!u) return;
    const t = (s.totals ??= { ...EMPTY_TOTALS });
    t.input += u.input;
    t.output += u.output;
    t.cacheRead += u.cacheRead ?? 0;
    t.cacheWrite += u.cacheWrite ?? 0;
    t.reasoning += u.reasoning ?? 0;
    if (request) t.requests += 1;
    const cost = requestCost(model, u);
    if (cost !== null) t.costUsd = (t.costUsd ?? 0) + cost;
  }

  /** An agent's context, as its latest request measured it: its whole prompt and its answer. */
  private measure(s: StoredSession, agent: string | null, u: TokenUsage | undefined, model: string, extra: Partial<StoredContext> = {}): void {
    if (!u) return;
    const key = agent ?? "main";
    const prev = s.context?.[key];
    // The runtime's window for this model holds until it reports another.
    const kept = prev?.window && prev.model === model && extra.sdk ? { window: prev.window, ...(prev.compactAt ? { compactAt: prev.compactAt } : {}) } : {};
    (s.context ??= {})[key] = { input: promptTokens(u), cached: u.cacheRead ?? 0, output: u.output, model, at: now(), ...kept, ...extra };
    this.changed(s, agent);
  }

  /**
   * How much of the window a conversation would take if sent now: the last
   * measurement and an estimate of what was added since; an estimate of all
   * of it when no request on this route has measured it.
   */
  private currentContext(s: StoredSession, c: Conversation): number {
    const m = s.context?.[c.agent ?? "main"];
    if (m && !m.sdk && m.messages !== undefined && m.messages <= c.messages.length) return contextTokens(m) + estimateMessagesTokens(c.messages.slice(m.messages));
    return c.overhead + estimateMessagesTokens(c.messages);
  }

  /** The main agent's conversation, with what its requests send besides the messages. */
  private mainConversation(s: StoredSession, surf = this.surface()) {
    const model = this.o.model();
    const sys: Array<{ type: "text"; text: string }> = [{ type: "text", text: [withSurface(system(this.o.host.projectDir, this.runsMode(), this.usage(), this.composed()), surf), this.skillLines()].filter(Boolean).join("\n") }];
    const tools = this.mainTools(surf);
    const effort = this.o.effort?.();
    const conv: Conversation & { system: typeof sys; tools: typeof tools; effort: typeof effort } = {
      agent: null,
      messages: s.messages,
      model,
      overhead: estimateTokens(sys[0].text + JSON.stringify(tools)),
      system: sys,
      tools,
      effort,
      summarize: async (messages, signal) => {
        const t = await this.o.provider().run({ sessionId: s.id, model, effort, system: sys, tools, messages }, () => {}, signal);
        return { text: textOf(t.content), usage: t.usage };
      },
    };
    return conv;
  }

  /** Compact a conversation that has reached the share of its window Studio compacts at. */
  private async autoCompact(s: StoredSession, c: Conversation, signal: AbortSignal): Promise<void> {
    const used = this.currentContext(s, c);
    if (used < this.windowFor(c.model) * AUTO_COMPACT_FRACTION) return;
    // Nothing since the last compaction: a summary of a summary frees nothing.
    if (c.messages.length <= 2 && isCompactedSummary(c.messages[0])) return;
    await this.compactConversation(s, c, "auto", used, signal);
  }

  /**
   * Replace a conversation with the model's summary of it, and mark where in
   * the transcript. When the summary cannot be had, the oldest part goes and
   * the most recent part is kept as text. Returns false when it was stopped.
   */
  private async compactConversation(s: StoredSession, c: Conversation, trigger: CompactionRecord["trigger"], before: number, signal: AbortSignal, instructions?: string): Promise<boolean> {
    const started = Date.now();
    const entry: CompactionEntry = { kind: "compaction", at: now(), trigger, state: "running", before, model: modelName(c.model), ...(instructions ? { instructions } : {}), ...(c.agent ? { parent: c.agent } : {}) };
    this.addEntry(s, entry);
    const window = this.windowFor(c.model);
    let summary = "";
    let error: string | undefined;
    try {
      // Past the window even the request for a summary would be refused: its most recent part goes as text instead.
      const req = before < window * 0.95
        ? summaryRequest(c.messages, instructions)
        : summaryRequest([{ role: "user", content: [{ type: "text", text: `[Studio] The conversation so far, as text:\n\n${conversationText(c.messages, Math.floor(window * 0.6 * 4))}` }] } as MessageParam], instructions);
      const r = await c.summarize(req, signal);
      summary = r.text.trim();
      if (r.usage) {
        this.count(s, usageTokens(r.usage), c.agent);
        this.spend(s, r.usage, c.model);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    if (signal.aborted) {
      Object.assign(entry, { state: "failed", error: "Stopped before the summary was written. Nothing was compacted.", ms: Date.now() - started });
      this.changed(s, c.agent);
      return false;
    }
    let method: "summary" | "truncated" = "summary";
    if (!summary) {
      method = "truncated";
      summary = `The summary could not be written, so the earliest part of the conversation was left out. Its most recent part, as text:\n\n${conversationText(c.messages, Math.floor(window * 0.25 * 4))}`;
    }
    const next = compactedMessages(c.messages, summary, before);
    c.messages.splice(0, c.messages.length, ...next);
    const after = c.overhead + estimateMessagesTokens(next);
    Object.assign(entry, { state: "done", after, summary, method, ms: Date.now() - started, ...(method === "truncated" && error ? { error } : {}) });
    (s.context ??= {})[c.agent ?? "main"] = { input: after, cached: 0, output: 0, model: c.model, at: now(), estimated: true, messages: next.length };
    this.changed(s, c.agent);
    return true;
  }

  /** Save the session and tell the client an entry or a context changed in place. */
  private changed(s: StoredSession, agent: string | null): void {
    this.o.store.save(s);
    this.o.host.events.publish("context.changed", { sessionId: s.id, agent: agent ?? "main" });
  }

  /** What /compact asked the Claude sign-in's runtime to keep, by session, until its compaction lands. */
  private readonly pendingCompact = new Map<string, string>();

  /**
   * Compact now and /compact: summarise the conversation so far, the
   * transcript untouched. On the Claude sign-in its runtime compacts its own
   * session; elsewhere Studio does. Refused while a turn runs.
   */
  async compact(sessionId: string, instructions = ""): Promise<void> {
    const s = this.require(sessionId);
    if (this.busy(s)) throw new Error("a turn is in progress; compact when it ends");
    if (s.messages.length === 0) throw new Error("there is nothing to compact yet");
    const onClaude = !!this.o.subscription?.();
    const asked = instructions.trim();
    s.error = null;
    // On the Claude sign-in with its session up to date, its runtime compacts it, as Claude Code's /compact does.
    if (onClaude && s.sdkSession && !s.offClaude) {
      this.pendingCompact.set(s.id, asked);
      this.setStatus(s, "running", null);
      return this.runSubscription(s.id, [{ type: "text", text: asked ? `/compact ${asked}` : "/compact" }]);
    }
    const controller = new AbortController();
    this.active.set(s.id, controller);
    this.setStatus(s, "running", null);
    try {
      const c: Conversation = onClaude ? this.claudeConversation(s) : this.mainConversation(s);
      await this.compactConversation(s, c, "manual", this.currentContext(s, c), controller.signal, asked || undefined);
      if (controller.signal.aborted) return;
      // The Claude session has not seen the summary: the next turn there starts from it.
      if (s.sdkSession) s.offClaude = true;
      this.setStatus(s, "idle", null);
    } catch (e) {
      if (controller.signal.aborted) return;
      s.error = e instanceof Error ? e.message : String(e);
      this.setStatus(s, "error", null);
    } finally {
      if (this.active.get(s.id) === controller) this.active.delete(s.id);
    }
  }

  /** The conversation on the Claude sign-in when its runtime has no session to compact: summarised by one answer on the sign-in. */
  private claudeConversation(s: StoredSession): Conversation {
    const model = this.o.model();
    return {
      agent: null,
      messages: s.messages,
      model,
      overhead: 0,
      summarize: async (messages, signal) => {
        const sdk = typeof __CLAUDE_SIGN_IN__ === "undefined" || __CLAUDE_SIGN_IN__ ? await import("./subscription.js") : null;
        if (!sdk) throw new Error("This Studio build does not include the Claude sign-in.");
        const r = await sdk.runSubscriptionCompletion({
          projectDir: this.o.host.projectDir,
          model,
          effort: "medium",
          system: "You summarise a conversation between a user and an agent that works in an Unreal Engine project.",
          prompt: `${conversationText(messages, 400_000)}\n\n${summaryInstruction(this.pendingCompact.get(s.id))}`,
          signal,
        });
        if ("error" in r) throw new Error(r.error);
        return { text: r.text };
      },
    };
  }

  /** A summary the Claude sign-in's runtime reported before its compaction marker arrived, by session. */
  private readonly runtimeSummary = new Map<string, string>();

  /**
   * The Claude sign-in's runtime compacting the main conversation: a marker
   * goes up when it starts, and says how far it got when it ends. Its summary
   * comes by a hook, before or after the end.
   */
  private runtimeCompacted(s: StoredSession, model: string, e: { started?: boolean; trigger?: "auto" | "manual"; before?: number; after?: number; summary?: string; failed?: string }): void {
    const runtime = (t: TranscriptEntry): t is CompactionEntry => t.kind === "compaction" && !t.parent && t.method === "runtime";
    const open = [...s.transcript].reverse().find((t): t is CompactionEntry => runtime(t) && t.state === "running");
    const asked = this.pendingCompact.get(s.id);
    const fresh = (): CompactionEntry => {
      const x: CompactionEntry = { kind: "compaction", at: now(), trigger: e.trigger ?? (this.pendingCompact.has(s.id) ? "manual" : "auto"), state: "running", before: e.before ?? (s.context?.main ? contextTokens(s.context.main) : 0), method: "runtime", model: modelName(model), ...(asked ? { instructions: asked } : {}) };
      this.addEntry(s, x);
      return x;
    };
    if (e.started) {
      if (!open) fresh();
      return;
    }
    if (e.summary !== undefined) {
      const target = open ?? [...s.transcript].reverse().find((t): t is CompactionEntry => runtime(t) && t.state === "done" && !t.summary);
      if (!target) {
        this.runtimeSummary.set(s.id, e.summary);
        return;
      }
      target.summary = e.summary;
      this.changed(s, null);
      return;
    }
    const entry = open ?? fresh();
    if (e.trigger) entry.trigger = e.trigger;
    if (e.before) entry.before = e.before;
    if (e.failed) Object.assign(entry, { state: "failed", error: e.failed });
    else {
      const summary = this.runtimeSummary.get(s.id);
      Object.assign(entry, { state: "done", ms: Date.now() - Date.parse(entry.at), ...(e.after !== undefined ? { after: e.after } : {}), ...(summary !== undefined && !entry.summary ? { summary } : {}) });
      const main = s.context?.main;
      if (main && e.after !== undefined) s.context!.main = { ...main, input: e.after, cached: 0, output: 0, at: now() };
    }
    this.runtimeSummary.delete(s.id);
    this.pendingCompact.delete(s.id);
    this.changed(s, null);
  }

  /**
   * The daemon is going down. A turn running in a host goes on there, and the
   * next daemon reattaches to it. Every other turn on the SDK route ends here,
   * saying so. An API turn resumes in the next daemon.
   */
  dispose(): void {
    // What this daemon's subagents do from here is the next daemon's to apply: nothing of theirs is saved here.
    this.disposed = true;
    this.unsubscribe();
    for (const [id, run] of [...this.hosted]) {
      run.detach();
      this.active.delete(id);
      this.o.host.log.info(`session ${id}: the turn goes on in its host process ${run.host}`);
    }
    this.hosted.clear();
    // A subagent in a host goes on there too, and the next daemon reattaches to it.
    const kept = new Set<string>();
    for (const run of this.runs.values()) {
      if (!run.hosted) continue;
      run.hosted.detach();
      kept.add(run.callId);
      this.o.host.log.info(`session ${run.sessionId}: subagent ${run.callId} goes on in its host process ${run.hosted.host}`);
    }
    const cause: Interruption = { by: "studio", why: this.restartCause(false) ?? "Studio's daemon shut down" };
    for (const [id, c] of [...this.active]) {
      if (this.o.subscription?.()) this.interrupt(id, cause, kept);
      else c.abort(cause);
    }
  }

  /** Why a deliberate daemon restart happened, when it left a recent note. `consume` deletes the note. */
  private restartCause(consume: boolean): string | null {
    const file = `${this.o.host.dataDir}/${RESTART_CAUSE_FILE}`;
    try {
      const r = JSON.parse(fs.readFileSync(file, "utf-8")) as { cause?: unknown; at?: unknown };
      if (consume) fs.rmSync(file, { force: true });
      return typeof r.cause === "string" && typeof r.at === "number" && Date.now() - r.at < RESTART_CAUSE_TTL_MS ? r.cause : null;
    } catch {
      return null;
    }
  }

  /** After a daemon restart: anything that was mid-turn continues, and a call that was mid-flight becomes unknown. */
  recover(): void {
    const why = this.restartCause(true) ?? "Studio's daemon restarted";
    for (const s of this.o.store.all()) {
      // Subagents first: one whose conversation runs in a host is taken over; one that ran in the previous daemon ends here.
      const kept = this.recoverAgents(s, why);
      // A turn running in its own process outlived the previous daemon: this one takes it over.
      if (this.reattach(s)) continue;
      // Only subagents outlived it: the main agent is free beside them, and their reports wake it.
      if (kept.size > 0 && !s.pending?.some((p) => p.state !== "done")) {
        if (s.status === "running" || s.status === "waiting") {
          const asked = new Set((s.approvals ?? []).filter((a) => !a.parent).map((a) => a.toolUseId));
          this.endTurn(s, { by: "studio", why }, asked, kept);
        }
        continue;
      }
      // A /playtest's flow answered the previous daemon, if anyone: its card says it was cut off, and Retry runs it again.
      const flow = this.runningPlaytest(s);
      if (flow) {
        Object.assign(flow, { state: "failed", errors: [`It was cut off: ${why}.`] });
        s.status = "idle";
        s.waitingCause = null;
        this.o.store.save(s);
        continue;
      }
      // A /flow's run answered the previous daemon: its card says it was cut off.
      const run = [...s.transcript].reverse().find((t) => t.kind === "flow");
      if (run?.kind === "flow" && run.state === "running") {
        Object.assign(run, { state: "failed", errors: [`It was cut off: ${why}. The flow may have gone on in the editor.`] });
        for (const step of run.steps) if (step.state === "running") step.state = "failed";
        s.status = "idle";
        s.waitingCause = null;
        this.o.store.save(s);
        continue;
      }
      // A /action answered the previous daemon, if anyone: there is no turn to resume, so its call ends here.
      const action = [...s.transcript].reverse().find((t) => t.kind === "tool" && t.call.id.startsWith(ACTION_CALL_PREFIX));
      if (action?.kind === "tool" && action.call.outcome === "pending") {
        const ran = !(s.approvals ?? []).some((a) => a.toolUseId === action.call.id);
        const cut = ran ? `It was cut off: ${why}. The action may have gone on in the editor.` : `It was cut off before it was approved: ${why}. It did not run.`;
        this.recordOutcome(s, { id: action.call.id, name: action.call.name, input: {}, state: "done", result: cut, isError: true }, ran ? "unknown" : "stopped");
        Object.assign(s, { approvals: [], status: "idle", waitingCause: null });
        this.o.store.save(s);
        continue;
      }
      const asked = new Set((s.approvals ?? []).map((a) => a.toolUseId));
      // An approval only the previous daemon could answer; its call asks again when the turn resumes.
      if (s.approvals?.length) {
        s.approvals = [];
        this.o.store.save(s);
      }
      if (s.status !== "running" && s.status !== "waiting") continue;
      if (this.o.subscription?.()) {
        // The runtime cannot pick up a reply a restart cut off: end it, saying what was cut off and by what.
        this.endTurn(s, { by: "studio", why }, asked, kept);
        continue;
      }
      for (const p of s.pending ?? []) if (p.state === "running") p.state = "unknown";
      s.status = "waiting";
      s.waitingCause = s.waitingCause ?? why.replace(/^Studio's daemon/, "the daemon");
      this.o.store.save(s);
    }
    this.resumeAll();
  }

  resumeAll(): void {
    for (const s of this.o.store.all()) {
      if (s.status === "waiting" && !this.active.has(s.id)) void this.runTurn(s.id);
    }
  }

  /**
   * Add the user's message and run the turn. Resolves when the turn ends, pauses or fails.
   * `about`: the agent call of a finished subagent whose thread the user wrote it in.
   */
  async send(sessionId: string, text: string, attachments: Array<Attachment & { path: string }> = [], about?: string): Promise<void> {
    // A /playtest message runs the playtest flow, not a turn.
    const command = attachments.length ? null : parseSlashCommand(text);
    if (command?.name === "playtest") return this.playtest(sessionId, { text: command.args }, text);
    // /compact summarises the conversation so far; nothing is sent as a message.
    if (command?.name === "compact") return this.compact(sessionId, command.args);
    // A /flow message (queued, or from a client without the form) runs with the pairs it names.
    if (command?.name === "flow") {
      const { name, values } = parseFlowArgs(command.args);
      const params = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, flowValue(v, null)]));
      return this.flow(sessionId, { name, params, text: text.trim() });
    }
    // A /action message (queued, or from a client without the form) runs with the pairs it names.
    if (command?.name === "action") {
      const { name, values } = parseActionArgs(command.args);
      const parts = splitActionName(name);
      if (!parts) throw new Error("name the action as category.method: /action level.place_actor");
      const args = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, flowValue(v, null)]));
      return this.action(sessionId, { ...parts, args, text: text.trim() });
    }
    const s = this.require(sessionId);
    if (this.active.has(s.id) || s.status === "running" || s.status === "waiting") {
      // Only subagents are working, or the main agent waits only on them: it takes the message now.
      if (this.mainFree(s.id) && (await this.tell(s, text, attachments, about))) return;
      throw new Error("a turn is already in progress; stop it or wait for it to finish");
    }
    s.archived = false;
    if (s.messages.length === 0 && s.title === DEFAULT_SESSION_TITLE) s.title = text.trim().split("\n")[0].slice(0, 60) || attachments[0]?.name || s.title;
    if (s.crashed) this.reconcileCrash(s);
    const content: unknown[] = [];
    for (const note of [...s.notes.splice(0), ...this.aboutNotes(s, about)]) content.push({ type: "text", text: `[Studio] ${note}` });
    for (const a of attachments) content.push(...(await contentFor(a)));
    if (text.trim()) content.push({ type: "text", text });
    s.transcript.push({
      kind: "user",
      text,
      at: now(),
      ...(attachments.length ? { attachments: attachments.map(({ id, name, type, size }) => ({ id, name, type, size })) } : {}),
    });
    s.turn = { start: s.transcript.length - 1, mutations: 0, targets: [], playtest: false };
    s.draft = "";
    s.error = null;
    this.setStatus(s, "running", null);
    // The checkpoint before the turn lands before the model can change anything.
    await this.o.review?.turnStarted(s).catch((e) => this.o.host.log.warn("the review checkpoint before the turn failed", e));
    await this.reply(s, content);
  }

  /**
   * The main agent replies to `content` (the user's message, or what waited
   * for it meanwhile) on the session's route: Studio's loop over a provider's
   * API, or the Claude sign-in's runtime, which keeps a session of its own.
   */
  private async reply(s: StoredSession, content: unknown[]): Promise<void> {
    s.messages.push({ role: "user", content } as MessageParam);
    this.replying.add(s.id);
    this.refreshFree(s);
    const onClaude = !!this.o.subscription?.();
    const rewound = !!s.rewound;
    s.rewound = false;
    s.model = this.o.model();
    s.route = this.o.route?.() ?? null;
    if (onClaude) {
      // The runtime's session has not seen the turns that ran on other routes: a new one starts, carrying the whole conversation.
      const earlier = s.messages.slice(0, -1);
      if (earlier.length > 0 && (!s.sdkSession || s.offClaude)) {
        if (s.sdkSession) s.sdkPast = [...(s.sdkPast ?? []), s.sdkSession];
        s.sdkSession = null;
        s.offClaude = false;
        // After an edit the model only changed sessions, not the user: nothing to tell them.
        if (!rewound) this.addEntry(s, { kind: "note", text: `On ${modelName(s.model)} via your Claude sign-in from here, with the whole conversation so far.`, at: now() });
        return this.runSubscription(s.id, [{ type: "text", text: carryOver(earlier) }, ...content]);
      }
      return this.runSubscription(s.id, content);
    }
    // The runtime's session misses this turn: a later turn on the Claude sign-in carries the whole session again.
    if (s.sdkSession) s.offClaude = true;
    await this.runTurn(s.id);
  }

  /** The card of a /playtest whose flow is still running, if there is one. */
  private runningPlaytest(s: StoredSession): Extract<TranscriptEntry, { kind: "playtest" }> | null {
    for (let i = s.transcript.length - 1; i >= 0; i--) {
      const t = s.transcript[i];
      if (t.kind === "playtest") return t.state === "created" || t.state === "failed" ? null : t;
    }
    return null;
  }

  /**
   * A /playtest, from a message or a button (Make playtest, Retry): ue-mcp's
   * playtest flow, given what to test and the recent conversation. Its card
   * shows the flow's stage; then the Draft card follows, or the card says no
   * playtest was made, with the flow's errors and Retry. The agent gets a note
   * either way, with its next turn.
   */
  async playtest(sessionId: string, request: PlaytestRequest, text?: string): Promise<void> {
    const s = this.require(sessionId);
    if (this.busy(s)) throw new Error("a turn is already in progress; stop it or wait for it to finish");
    const source = request.source === undefined ? null : s.transcript[request.source];
    if (request.source !== undefined && (source?.kind !== "assistant" || source.parent)) throw new Error(`entry ${request.source} is not one of the agent's messages`);
    const shown = text ?? (request.text.trim() ? `/playtest ${request.text.trim()}` : "/playtest");
    // The Make playtest pill names the latest turn: its changes are the target, the turn the context.
    const turn = request.turn === undefined ? null : s.turn?.start === request.turn ? s.turn : undefined;
    if (turn === undefined) throw new Error(`entry ${request.turn} does not begin the latest turn`);
    const params = turn
      ? playtestTurnParams(s.transcript.slice(turn.start), turn.targets)
      : playtestParams(request.text, source?.kind === "assistant" ? source.text : null, s.transcript);
    s.archived = false;
    if (s.messages.length === 0 && s.title === DEFAULT_SESSION_TITLE) s.title = shown.slice(0, 60);
    s.transcript.push({ kind: "user", text: shown, at: now(), ...(request.source !== undefined ? { source: request.source } : {}) });
    s.turn = { start: s.transcript.length - 1, mutations: 0, targets: [], playtest: true };
    const card: Extract<TranscriptEntry, { kind: "playtest" }> = { kind: "playtest", state: "gathering", request, attempt: 1, at: now() };
    s.draft = "";
    s.error = null;
    this.addEntry(s, card);
    const controller = new AbortController();
    this.active.set(s.id, controller);
    this.setStatus(s, "running", null);
    const changed = () => {
      this.o.store.save(s);
      this.o.host.events.publish("playtest.changed", { sessionId: s.id, state: card.state, attempt: card.attempt });
    };
    try {
      const flow = this.o.playtestFlow;
      const outcome = flow
        ? await flow.run(params, (stage, attempt) => {
          if (controller.signal.aborted) return;
          card.state = stage;
          card.attempt = attempt;
          changed();
        }, controller.signal)
        : { made: false as const, errors: ["This Studio has no playtest flow to run."] };
      if (controller.signal.aborted) {
        card.state = "failed";
        card.errors = ["Stopped."];
        return changed();
      }
      if (outcome.made) {
        card.state = "created";
        changed();
        await this.o.qa?.drafted(s.id, outcome.script);
        const name = typeof outcome.script.name === "string" ? outcome.script.name : String(outcome.script.path);
        s.notes.push(`The user ran ${shown}: the playtest flow saved the test script "${name}" (${String(outcome.script.path)}), shown as a draft Playtest card in the chat.`);
      } else {
        card.state = "failed";
        card.errors = outcome.errors;
        changed();
        s.notes.push(`The user ran ${shown}: the playtest flow made no playtest. ${outcome.errors.join(" ")}`);
      }
      this.setStatus(s, "idle", null);
    } finally {
      if (this.active.get(s.id) === controller) this.active.delete(s.id);
    }
  }

  /**
   * A /flow: one of the project's flows, run with the params the user gave.
   * Its card lists the steps as the flow's events report them, then the run's
   * summary, or its errors. The agent gets a note either way, with its next turn.
   */
  async flow(sessionId: string, request: FlowRunRequest): Promise<void> {
    const s = this.require(sessionId);
    if (this.busy(s)) throw new Error("a turn is already in progress; stop it or wait for it to finish");
    const name = request.name.trim();
    if (!name) throw new Error("name the flow to run: /flow <name>");
    const shown = request.text?.trim() || flowCommandText(name, request.params);
    s.archived = false;
    if (s.messages.length === 0 && s.title === DEFAULT_SESSION_TITLE) s.title = shown.slice(0, 60);
    s.transcript.push({ kind: "user", text: shown, at: now() });
    s.turn = { start: s.transcript.length - 1, mutations: 0, targets: [], playtest: false };
    const card: Extract<TranscriptEntry, { kind: "flow" }> = { kind: "flow", name, params: request.params, state: "running", steps: [], at: now() };
    s.draft = "";
    s.error = null;
    this.addEntry(s, card);
    const controller = new AbortController();
    this.active.set(s.id, controller);
    this.setStatus(s, "running", null);
    const changed = () => {
      this.o.store.save(s);
      this.o.host.events.publish("flowrun.changed", { sessionId: s.id, name, state: card.state });
    };
    const live = !!this.o.flows && (this.o.flowStepApproval?.() ?? false);
    const token = live ? crypto.randomUUID() : null;
    if (token) this.flowRuns.set(token, { sessionId: s.id, signal: controller.signal });
    try {
      if (this.o.flows && !live) {
        const held = await this.gateFlowSteps(s, name, controller.signal);
        if (held) {
          card.state = held === "stopped" ? "stopped" : "failed";
          card.errors = [held === "stopped" ? "Stopped before the flow started." : held];
          changed();
          // A Stop already set the session's status.
          if (held === "stopped") return;
          s.notes.push(`The user ran ${shown}, then declined a step at the approval, so the flow did not run.`);
          this.setStatus(s, "idle", null);
          return;
        }
      }
      const outcome = this.o.flows
        ? await this.o.flows.run(name, request.params, (e) => {
          if (!controller.signal.aborted && applyStepEvent(card.steps, e)) changed();
        }, controller.signal, token ? { approver: STUDIO_EXTENSION, token } : undefined)
        : { success: false, errors: ["This Studio has no way to run flows."], steps: [] };
      if (controller.signal.aborted) {
        card.state = "stopped";
        card.errors = ["Stopped waiting for it. The flow may still be running in the editor."];
        for (const step of card.steps) if (step.state === "running") step.state = "failed";
        return changed();
      }
      if (!card.steps.length) card.steps = outcome.steps;
      for (const step of card.steps) if (step.state === "running") step.state = outcome.success ? "done" : "failed";
      card.state = outcome.success ? "succeeded" : "failed";
      if (outcome.summary) card.summary = outcome.summary;
      if (outcome.errors.length) card.errors = outcome.errors;
      if (outcome.duration !== undefined) card.duration = outcome.duration;
      changed();
      s.notes.push(outcome.success
        ? `The user ran ${shown}: the flow succeeded.${outcome.summary ? `\n${outcome.summary}` : ""}`
        : `The user ran ${shown}: the flow failed. ${[...outcome.errors, outcome.summary ?? ""].filter(Boolean).join(" ")}`);
      this.setStatus(s, "idle", null);
    } finally {
      if (token) this.flowRuns.delete(token);
      if (this.active.get(s.id) === controller) this.active.delete(s.id);
    }
  }

  /**
   * Before a flow runs, each of its steps whose task falls under an approval
   * row asks the way the agent's own call would (Settings > Approvals & review,
   * Allow for this session): Python, console commands, editor restarts,
   * destructive actions, and any task that is not a ue-mcp action. One answer
   * per distinct task. Returns why the flow must not run, "stopped", or null.
   */
  /** The flows running with step approval, by the token the daemon hands back with each step. */
  private readonly flowRuns = new Map<string, { sessionId: string; signal: AbortSignal }>();

  /**
   * One step of a flow this Studio started, asked by the daemon as it runs
   * (ue-mcp feature "flows.stepApproval"): the same approval rows as the
   * agent's own ue_mcp call, shown with the step's resolved options. A token
   * this Studio did not hand out is denied.
   */
  async approveFlowStep(req: { token: string; task: string; options: Record<string, unknown> }): Promise<{ allow: true } | { allow: false; reason: string }> {
    const run = this.flowRuns.get(req.token);
    const s = run ? this.o.store.get(run.sessionId) : undefined;
    if (!run || !s) return { allow: false, reason: `Step ${req.task} is not part of a flow this Studio started, so it did not run.` };
    const kind = flowStepKind(req.task, this.o.effects ?? NO_EFFECTS);
    if (!kind) return { allow: true };
    const input = { ...flowStepCall(req.task), args: { ...req.options } };
    const gate = await this.gate(s, `${FLOW_STEP_PREFIX}${crypto.randomUUID()}`, "ue_mcp", input, run.signal, kind);
    if (!gate) return { allow: true };
    if ("stopped" in gate) return { allow: false, reason: `Stopped before the step ${req.task} ran.` };
    return { allow: false, reason: `Declined at the approval for the step ${req.task}, so it did not run.` };
  }

  private async gateFlowSteps(s: StoredSession, name: string, signal: AbortSignal): Promise<string | "stopped" | null> {
    const tasks = await this.o.flows!.plan(name, signal);
    if (signal.aborted) return "stopped";
    // Without a plan nothing says what the steps run: ask once, as a shell command, for the whole flow.
    const asked = tasks ?? [name];
    const effects = this.o.effects ?? NO_EFFECTS;
    for (const task of [...new Set(asked)]) {
      const kind = tasks ? flowStepKind(task, effects) : "shell";
      if (!kind) continue;
      const input = tasks ? flowStepCall(task) : { action: "call", category: "flow", method: "run", args: { flowName: name } };
      const gate = await this.gate(s, `${FLOW_STEP_PREFIX}${crypto.randomUUID()}`, "ue_mcp", input, signal, kind);
      if (gate && "stopped" in gate) return "stopped";
      if (gate) return `Declined at the approval for ${tasks ? `the step ${task}` : "the flow"}, so the flow did not run.`;
    }
    return null;
  }

  /**
   * A /action: one ue-mcp action the user runs without the model. It goes in
   * the transcript as the ue_mcp call it is, through the same approval rules
   * as the agent's calls (Settings > Approvals & review, and Allow for this
   * session), and the review checkpoints a turn gets. A playtest it starts is
   * the user's own, as from the card. The agent gets a note with its next turn.
   */
  async action(sessionId: string, request: ActionRunRequest): Promise<void> {
    const s = this.require(sessionId);
    if (this.busy(s)) throw new Error("a turn is already in progress; stop it or wait for it to finish");
    const { category, method } = request;
    if (!splitActionName(`${category}.${method}`)) throw new Error("name the action as category.method: /action level.place_actor");
    const shown = request.text?.trim() || actionCommandText(category, method, request.args);
    s.archived = false;
    if (s.messages.length === 0 && s.title === DEFAULT_SESSION_TITLE) s.title = shown.slice(0, 60);
    s.transcript.push({ kind: "user", text: shown, at: now() });
    s.turn = { start: s.transcript.length - 1, mutations: 0, targets: [], playtest: false };
    s.draft = "";
    s.error = null;
    const controller = new AbortController();
    this.active.set(s.id, controller);
    this.setStatus(s, "running", null);
    const id = `${ACTION_CALL_PREFIX}${crypto.randomUUID()}`;
    const name = "ue_mcp";
    const input: Record<string, unknown> = { action: "call", category, method, args: request.args };
    try {
      await this.o.review?.turnStarted(s).catch((e) => this.o.host.log.warn("the review checkpoint before the action failed", e));
      this.addEntry(s, { kind: "tool", call: { id, name, input, outcome: "pending", startedAt: now() } });
      const signal = controller.signal;
      const gate = await this.gate(s, id, name, input, signal);
      // A Stop answered the call and ended the run already.
      if (gate && "stopped" in gate) return;
      if (gate) {
        this.recordOutcome(s, { id, name, input, state: "done", result: "The user declined to run it.", isError: true }, "declined");
        s.notes.push(`The user typed ${shown}, then declined it at the approval, so it did not run.`);
        this.setStatus(s, "idle", null);
        return;
      }
      const exec = await executeTool(this.hostFor(s.id, true), name, input, signal);
      if (signal.aborted) {
        this.mergeExec(s, exec, exec.outcome !== "unknown");
        return;
      }
      this.mergeExec(s, exec, exec.outcome !== "unknown");
      this.markSaved(s, exec.saved);
      this.recordOutcome(s, { id, name, input, state: "done", result: exec.text, isError: exec.isError, ...(exec.images ? { images: exec.images } : {}) }, exec.outcome);
      const said = (exec.modelText ?? exec.text).trim();
      const result = said.length > ACTION_NOTE_CHARS ? `${said.slice(0, ACTION_NOTE_CHARS)}
[cut at ${ACTION_NOTE_CHARS} characters]` : said;
      s.notes.push(`The user ran ${shown} themselves (${category}.${method}, not through you). ${exec.isError ? "It failed" : "It answered"}:
${result}`);
      this.setStatus(s, "idle", null);
    } finally {
      if (this.active.get(s.id) === controller) this.active.delete(s.id);
    }
  }

  /** The Agent SDK module, or null in a build without the Claude sign-in (a dynamic import the bundler drops, and the SDK with it). */
  private async claudeSdk(): Promise<typeof import("./subscription.js") | null> {
    return typeof __CLAUDE_SIGN_IN__ === "undefined" || __CLAUDE_SIGN_IN__ ? await import("./subscription.js") : null;
  }

  /**
   * Run one conversation step on the Claude sign-in: in a host process, where
   * it outlives this daemon, or in the daemon where none can start. `key`
   * names its host (the session, or the session and a subagent's call).
   */
  private async claudeStep(key: string, spec: TurnSpec, cb: HostedCallbacks, onHosted: (run: HostedRun) => void): Promise<HostedResult> {
    const sdk = await this.claudeSdk();
    if (!sdk) return "This Studio build does not include the Claude sign-in.";
    const hosts = this.o.turnHosts;
    if (hosts?.available() && !cb.signal.aborted) {
      try {
        const run = await hosts.start(key, spec, cb);
        onHosted(run);
        this.o.host.log.info(`${key}: runs in host process ${run.host}`);
        return await run.done;
      } catch (e) {
        this.o.host.log.warn(`${key}: no turn host could start, so it runs in the daemon and updates wait for it`, e);
      }
    }
    if (cb.signal.aborted) return null;
    return sdk.runSubscriptionTurn({ ...spec, ...cb } as Parameters<typeof sdk.runSubscriptionTurn>[0]);
  }

  /** The main agent's reply on the Claude sign-in: its runtime runs the step, and every tool call (the agent tool too) comes back to Studio. */
  private async runSubscription(id: string, prompt: unknown[]): Promise<void> {
    const controller = new AbortController();
    this.active.set(id, controller);
    this.replying.add(id);
    const s = this.require(id);
    const track: TurnTrack = { seq: 0, lastId: null, background: [] };
    let result: HostedResult = null;
    let hosted: HostedRun | null = null;
    try {
      const usage = this.usage();
      const surface = this.surface();
      const agent = this.agentDefinition() as Anthropic.Beta.BetaTool | null;
      const spec: TurnSpec = {
        projectDir: this.o.host.projectDir,
        model: this.o.model(),
        effort: this.o.effort?.() ?? "high",
        // The SDK reads the project's own files itself: Studio adds none of their text.
        system: withSurface(system(this.o.host.projectDir, this.runsMode(), usage, this.sdkComposed()), surface),
        ...(agent ? { agentTool: { description: agent.description ?? "", inputSchema: agent.input_schema as Record<string, unknown> } } : {}),
        ...this.sdkNative(),
        ...sdkEditor(surface),
        prompt,
        resume: s.sdkSession ?? null,
      };
      const cb = this.turnCallbacks(s, controller, track);
      result = await this.claudeStep(s.id, spec, cb, (run) => {
        hosted = run;
        this.hosted.set(s.id, run);
        s.hostTurn = track;
        this.o.store.save(s);
      });
    } catch (e) {
      result = e instanceof Error ? e.message : String(e);
    } finally {
      this.releaseSubscription(s, controller, result, hosted);
    }
  }

  /**
   * Take over a turn a host process ran through the previous daemon's restart:
   * what it did meanwhile is applied from its journal, calls still waiting are
   * run here (one that had started is reported with an unknown outcome), and
   * the turn carries on. False when the session has no host.
   */
  private reattach(s: StoredSession): boolean {
    const hosts = this.o.turnHosts;
    const record = hosts?.recordFor(s.id);
    if (!hosts || !record) return false;
    // An approval only the previous daemon could show: its call is sent again by the host, and asks again here.
    if (s.approvals?.length) s.approvals = [];
    const controller = new AbortController();
    this.active.set(s.id, controller);
    this.replying.add(s.id);
    const track: TurnTrack = { seq: s.hostTurn?.seq ?? 0, lastId: s.hostTurn?.lastId ?? null, background: [...(s.hostTurn?.background ?? [])] };
    s.hostTurn = track;
    this.o.store.save(s);
    // Compatibility: a host from before protocol 3 runs the runtime's own subagents, and reports them as it always did.
    const legacy = (record.protocol ?? 1) < STUDIO_SUBAGENTS_PROTOCOL;
    const cb = legacy ? this.legacyTurnCallbacks(s, controller, track) : this.turnCallbacks(s, controller, track);
    let result: HostedResult = null;
    let hosted: HostedRun | null = null;
    void (async () => {
      try {
        const run = await hosts.attach(record, cb, track.seq);
        hosted = run;
        this.hosted.set(s.id, run);
        this.o.host.log.info(`session ${s.id}: reattached to the turn in host process ${run.host} (Studio ${record.version}${legacy ? ", with the runtime's own subagents" : ""})`);
        result = await run.done;
      } catch (e) {
        result = e instanceof Error ? e.message : String(e);
      } finally {
        this.releaseSubscription(s, controller, result, hosted);
      }
    })().catch((e) => this.o.host.log.warn(`session ${s.id}: reattaching to its turn host failed`, e));
    return true;
  }

  /**
   * A reply on the Claude sign-in ended, or this daemon let go of a hosted one
   * (DETACHED: it goes on in its host, and the next daemon takes it over from
   * what is saved). Calls it left unanswered end; then the turn goes on as on
   * every route (replyEnded). Nothing more when it was stopped.
   */
  private releaseSubscription(s: StoredSession, controller: AbortController, result: HostedResult, hosted: HostedRun | null): void {
    const id = s.id;
    if (this.active.get(id) === controller) this.active.delete(id);
    if (hosted && this.hosted.get(id) === hosted) this.hosted.delete(id);
    this.legacy.delete(id);
    if (result === DETACHED) return;
    if (s.hostTurn) {
      delete s.hostTurn;
      this.o.store.save(s);
    }
    if (controller.signal.aborted) return;
    // A call the reply ended without answering never finishes now; a subagent still working goes on.
    this.endCalls(s, () => "The turn ended before this call returned a result.", "error", undefined, this.liveRunCalls(s.id));
    this.replyEnded(s, result);
  }

  /** A call an earlier daemon was running when it went down: never run again, its outcome unknown. */
  private async lostCall(s: StoredSession, toolId: string, name: string, input: Record<string, unknown>): Promise<ToolExecution> {
    const text = "Studio's daemon restarted while this call was running, so whether it took effect is unknown. Read the current state back before repeating it.";
    this.recordOutcome(s, { id: toolId, name, input, state: "done", result: text, isError: true }, "unknown");
    return { text, isError: true, outcome: "unknown", touched: [], saved: [] };
  }

  /**
   * How the main agent's reply on the Claude sign-in reports to this session,
   * in the daemon or from a host. Every tool call comes back through runTool,
   * Studio's agent tool among them, and records its own outcome.
   */
  private turnCallbacks(s: StoredSession, controller: AbortController, track: TurnTrack): HostedCallbacks {
    let mine: LiveTurn | null = null;
    return {
      signal: controller.signal,
      onTokens: (n) => this.count(s, n, null),
      onUsage: ({ usage: u, growth, first, model }) => {
        this.spend(s, growth, model, first);
        this.measure(s, null, u, model, { sdk: true });
      },
      onCompaction: (e) => this.runtimeCompacted(s, this.o.model(), e),
      onContextWindow: ({ window, compactAt }) => {
        const main = s.context?.main;
        if (!main) return;
        s.context!.main = { ...main, window, ...(compactAt ? { compactAt } : {}) };
        this.changed(s, null);
      },
      onSession: (sid) => {
        s.sdkSession = sid;
        this.o.store.save(s);
      },
      onDelta: (text) => this.o.host.events.publish("turn.delta", { sessionId: s.id, text }),
      onAssistant: (mid, blocks) => {
        const last = s.messages[s.messages.length - 1];
        if (mid === track.lastId && last?.role === "assistant" && Array.isArray(last.content)) (last.content as ContentBlock[]).push(...blocks);
        else s.messages.push({ role: "assistant", content: blocks } as MessageParam);
        track.lastId = mid;
        for (const b of blocks) {
          if (b.type === "text" && b.text) this.addEntry(s, { kind: "assistant", text: b.text, at: now() });
          if (b.type === "tool_use") this.addEntry(s, { kind: "tool", call: { id: b.id, name: b.name, input: b.input, outcome: "pending", startedAt: now() } });
        }
        this.o.store.save(s);
      },
      onToolResults: (content) => {
        s.messages.push({ role: "user", content } as MessageParam);
        track.lastId = null;
        // Studio's tools record their outcome as they run; the runtime's own (web search, skills) only here.
        // An agent call whose subagent went on in the background stays open until that subagent ends.
        for (const b of content as Array<{ type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }>) {
          if (b.type !== "tool_result" || !b.tool_use_id || this.runs.has(b.tool_use_id)) continue;
          const entry = s.transcript.find((t) => t.kind === "tool" && t.call.id === b.tool_use_id);
          if (entry?.kind !== "tool" || entry.call.outcome !== "pending") continue;
          const text = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((c: { text?: string }) => c.text ?? "").join("") : "";
          this.recordOutcome(s, { id: b.tool_use_id, name: entry.call.name, input: {}, state: "done", result: text, isError: !!b.is_error }, b.is_error ? "error" : "done");
        }
        this.o.store.save(s);
      },
      runTool: (toolId, name, input, onStart) => this.subscriptionTool(s, controller, toolId, name, input, false, onStart),
      // An agent call sent again after a restart waits on the subagent this daemon took over; any other is lost.
      lostTool: (toolId, name, input) => (name === "agent" && this.runs.has(toolId) ? this.subscriptionTool(s, controller, toolId, name, input) : this.lostCall(s, toolId, name, input)),
      // Kept before the event is applied, so the save it makes holds both.
      onSeq: (seq) => void (track.seq = seq),
      onLive: (live) => {
        if (live) {
          mine = live;
          this.live.set(s.id, live);
          // What waited for the main agent while its reply started goes in now.
          this.flushMainInbox(s);
        } else if (this.live.get(s.id) === mine) this.live.delete(s.id);
      },
      onInputClosed: (why) => this.o.host.log.info(`session ${s.id}: the reply takes no more messages: ${why}`),
    };
  }

  /**
   * Compatibility: how a reply in a turn host from before protocol 3 reports.
   * Such a host runs the runtime's own subagents, so their lifecycle comes as
   * task events, a background subagent's call is answered with a placeholder,
   * and the main agent can be idle beside them (free). Kept only so a turn an
   * older Studio started keeps working through this daemon until it ends;
   * remove with STUDIO_SUBAGENTS_PROTOCOL.
   */
  private legacyTurnCallbacks(s: StoredSession, controller: AbortController, track: TurnTrack): HostedCallbacks {
    return {
        signal: controller.signal,
        onTokens: (n, parent) => this.count(s, n, parent),
        onUsage: ({ usage: u, growth, first, model, parent }) => {
          this.spend(s, growth, model, first);
          this.measure(s, parent, u, model, { sdk: true });
        },
        onCompaction: (e) => this.runtimeCompacted(s, this.o.model(), e),
        onContextWindow: ({ window, compactAt }) => {
          const main = s.context?.main;
          if (!main) return;
          s.context!.main = { ...main, window, ...(compactAt ? { compactAt } : {}) };
          this.changed(s, null);
        },
        onSession: (sid) => {
          s.sdkSession = sid;
          this.o.store.save(s);
        },
        onDelta: (text) => this.o.host.events.publish("turn.delta", { sessionId: s.id, text }),
        onAssistant: (mid, blocks, parent) => {
          // A subagent's messages are its own conversation: only the main agent's mirror into the session's.
          if (!parent) {
            const last = s.messages[s.messages.length - 1];
            if (mid === track.lastId && last?.role === "assistant" && Array.isArray(last.content)) (last.content as ContentBlock[]).push(...blocks);
            else s.messages.push({ role: "assistant", content: blocks } as MessageParam);
            track.lastId = mid;
          }
          const tag = parent ? { parent } : {};
          for (const b of blocks) {
            if (b.type === "text" && b.text) this.addEntry(s, { kind: "assistant", text: b.text, at: now(), ...tag });
            if (b.type === "tool_use") {
              this.addEntry(s, { kind: "tool", call: { id: b.id, name: b.name, input: b.input, outcome: "pending", startedAt: now() }, ...tag });
            }
          }
          this.o.store.save(s);
        },
        onToolResults: (content, parent) => {
          if (!parent) {
            s.messages.push({ role: "user", content } as MessageParam);
            track.lastId = null;
          }
          // Studio's own tools record their outcome as they run; an agent call's result arrives only here.
          for (const b of content as Array<{ type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }>) {
            if (b.type !== "tool_result" || !b.tool_use_id) continue;
            const entry = s.transcript.find((t) => t.kind === "tool" && t.call.id === b.tool_use_id);
            if (entry?.kind !== "tool" || entry.call.outcome !== "pending" || track.background.includes(b.tool_use_id)) continue;
            const text = typeof b.content === "string" ? b.content
              : Array.isArray(b.content) ? b.content.map((c: { text?: string }) => c.text ?? "").join("") : "";
            // A subagent moved to the background answers its call with a placeholder; its real result is its task report.
            if (this.subagents.has(b.tool_use_id) && /in the background/i.test(text)) {
              track.background.push(b.tool_use_id);
              continue;
            }
            this.recordOutcome(s, { id: b.tool_use_id, name: entry.call.name, input: {}, state: "done", result: text, isError: !!b.is_error }, b.is_error ? "error" : "done");
          }
          this.o.store.save(s);
        },
        onTask: (toolUseId, status, detail) => {
          if (status === "started") {
            if (detail.background && !track.background.includes(toolUseId)) track.background.push(toolUseId);
            return;
          }
          // A subagent that ended cannot be waiting on the user any more.
          this.dropApprovals(s.id, toolUseId);
          const entry = s.transcript.find((t) => t.kind === "tool" && t.call.id === toolUseId);
          if (entry?.kind !== "tool" || entry.call.outcome !== "pending") return;
          const failed = status !== "completed";
          const result = detail.summary || (status === "stopped" ? "Stopped by the user." : "");
          this.recordOutcome(s, { id: toolUseId, name: entry.call.name, input: {}, state: "done", result, isError: failed }, status === "stopped" ? "stopped" : failed ? "error" : "done");
        },
        onStopper: (callId, stop) => {
          if (stop) this.subagents.set(callId, () => void stop());
          else this.subagents.delete(callId);
        },
        onQueued: (callId, cancel) => this.markQueued(s, callId, cancel && (() => {
          cancel();
          this.recordOutcome(s, { id: callId, name: "agent", input: {}, state: "done", result: QUEUED_STOP, isError: true }, "stopped");
        })),
        runTool: (toolId, name, input, onStart) => this.subscriptionTool(s, controller, toolId, name, input, false, onStart),
        lostTool: (toolId, name, input) => this.lostCall(s, toolId, name, input),
        // Kept before the event is applied, so the save it makes holds both.
        onSeq: (seq) => void (track.seq = seq),
        onLive: (live) => {
          if (live) this.legacy.set(s.id, live);
          else this.legacy.delete(s.id);
        },
        onInputClosed: (why) => this.o.host.log.info(`session ${s.id}: the turn takes no more messages: ${why}`),
        onFree: (free) => {
          s.mainFree = free;
          this.o.store.save(s);
          this.o.host.events.publish("session.changed", { sessionId: s.id, status: s.status, waitingCause: s.waitingCause });
          // What the user queued while the main agent worked goes to it now, beside the running subagents.
          if (free && s.queue?.length) setTimeout(() => this.tellQueued(s.id), 0);
        },
    };
  }

  /**
   * One call into Studio's tools from a conversation on the Claude sign-in:
   * the main agent's reply or a subagent's. An agent call starts the subagent
   * the same way Studio's loop does (agentCall). `onStart`: it got past its
   * approval, or its subagent got its slot, and runs now. `detached`: a
   * subagent the user assigned, whose calls are the user's own.
   */
  private async subscriptionTool(s: StoredSession, controller: AbortController, toolId: string, name: string, input: Record<string, unknown>, detached = false, onStart?: () => void): Promise<ToolExecution> {
    // The turn ended while the binary was still asking: nothing runs after a stop.
    if (controller.signal.aborted) return { text: interruptedResult({ name, input }, this.causeOf(controller), false), isError: true, outcome: "error", touched: [], saved: [] };
    if (name === "agent") {
      const r = await this.agentCall(s, toolId, input, controller.signal, onStart);
      // A Stop answered the call already; one that went on in the background stays open until its subagent ends.
      if (!controller.signal.aborted && !r.background) this.recordOutcome(s, { id: toolId, name, input, state: "done", result: r.text, isError: r.isError }, r.stopped ? "stopped" : r.isError ? "error" : "done");
      return { text: r.text, isError: r.isError, outcome: r.isError ? "error" : "done", touched: [], saved: [] };
    }
    // A subagent's call also ends when the user stops that subagent.
    const owner = s.transcript.find((t) => t.kind === "tool" && t.call.id === toolId)?.parent;
    const sub = owner ? this.subagentAbort(owner).signal : null;
    const signal = sub ? AbortSignal.any([controller.signal, sub]) : controller.signal;
    const stoppedHere = (): ToolExecution => ({ text: interruptedResult({ name, input }, USER_STOP, true), isError: true, outcome: "error", touched: [], saved: [] });
    // A subagent working while the main agent is not replying waits for the editor without making the session wait.
    const quiet = detached || (!!owner && !this.replying.has(s.id));
    if (sub?.aborted) return stoppedHere();
    if (name === "ue_mcp" && input.action === "call") await this.waitForEditor(s, signal, Infinity, quiet);
    if (sub?.aborted) return stoppedHere();
    const gate = await this.gate(s, toolId, name, input, signal);
    if (sub?.aborted) return stoppedHere();
    if (gate) {
      const text = "stopped" in gate ? "Stopped by the user." : gate.declined;
      this.recordOutcome(s, { id: toolId, name, input, state: "done", result: text, isError: true }, "stopped" in gate ? "stopped" : "declined");
      return { text, isError: true, outcome: "error", touched: [], saved: [] };
    }
    onStart?.();
    const running = this.execute(this.hostFor(s.id, detached), name, input, signal);
    // What a call does after its subagent was stopped is still tracked for the crash report.
    if (sub) void running.then((e) => sub.aborted && this.mergeExec(s, e, e.outcome !== "unknown"), () => {});
    const done = sub ? await unlessAborted(running, sub) : await running;
    if (!done) return stoppedHere();
    let exec = done;
    this.mergeExec(s, exec, exec.outcome !== "unknown");
    // Stopped while the editor worked: the stop already answered this call.
    if (controller.signal.aborted) return exec;
    if (name === "editor_restart" && !exec.isError) exec = await this.editorBack(s, exec, controller.signal);
    if (controller.signal.aborted) return exec;
    this.markSaved(s, exec.saved);
    if (!exec.isError) exec = this.withInstructions(owner ?? s.id, name, input, exec, true);
    const p: PendingTool = { id: toolId, name, input, state: "done", result: exec.text, isError: exec.isError, ...(exec.images ? { images: exec.images } : {}) };
    this.recordOutcome(s, p, exec.outcome);
    // A subagent the user assigned runs beside the session's turns, not as one.
    if (!quiet && s.status !== "running") this.setStatus(s, "running", null);
    return exec;
  }

  /** What a turn's controller was aborted for. */
  private causeOf(c: AbortController): Interruption {
    const r = c.signal.reason as Interruption | undefined;
    return r && (r.by === "user" || r.by === "studio") ? r : USER_STOP;
  }

  /**
   * After editor_restart reports the editor started: the turn goes on once the
   * editor has connected again, so the model's next call finds it. The result
   * says which happened.
   */
  private async editorBack(s: StoredSession, exec: ToolExecution, signal: AbortSignal): Promise<ToolExecution> {
    const back = await this.waitForEditor(s, signal, EDITOR_BACK_MS);
    if (signal.aborted) return exec;
    return {
      ...exec,
      text: back
        ? `${exec.text}\nThe editor is running and connected.`
        : `${exec.text}\nThe editor has not connected within ${EDITOR_BACK_MS / 60_000} minutes of starting. Check it with ue_mcp project.get_status before going on.`,
    };
  }

  /**
   * Why the editor is not here right now. A restart or rebuild that has ended
   * no longer is the reason, whatever the last disconnect said.
   */
  private causeNow(): string {
    const busy = this.o.busy?.state();
    if (busy?.operation) {
      const op = busy.operation.op;
      return op === "rebuild" ? "the project is rebuilding" : op === "stop" ? "the editor is stopping" : op === "start" ? "the editor is starting" : "the editor is restarting";
    }
    if (busy?.failure) return `the ${busy.failure.op} did not bring the editor back: ${busy.failure.reason}`;
    if (this.o.busy && (this.lastCause === "the project is rebuilding" || this.lastCause === "the editor is restarting")) return "the editor is not running";
    return this.lastCause;
  }

  /** Whether a restart or rebuild is under way that will bring the editor back. */
  private operating(): boolean {
    return this.o.busy ? !!this.o.busy.state().operation : true;
  }

  /**
   * Hold a tool call until the editor is back, showing the session as waiting
   * meanwhile. While a restart or rebuild runs it waits up to `limitMs`; with
   * none running, only IDLE_EDITOR_WAIT_MS. False when it gave up first.
   */
  private async waitForEditor(s: StoredSession, signal: AbortSignal, limitMs = Infinity, quiet = false): Promise<boolean> {
    if (editorConnected(this.o.host)) return true;
    const start = Date.now();
    const end = start + limitMs;
    let cause = this.causeNow();
    // quiet: a subagent the user assigned waits without making the session's own state waiting.
    if (!quiet) this.setStatus(s, "waiting", cause);
    while (!editorConnected(this.o.host) && !signal.aborted && Date.now() < end && (this.operating() || Date.now() - start < IDLE_EDITOR_WAIT_MS)) {
      await new Promise((r) => setTimeout(r, 1000));
      const now = this.causeNow();
      if (!quiet && now !== cause && !signal.aborted && !editorConnected(this.o.host)) this.setStatus(s, "waiting", (cause = now));
    }
    if (!signal.aborted && !quiet) this.setStatus(s, "running", null);
    return editorConnected(this.o.host);
  }

  /**
   * A Stop now ends only the main agent's reply: subagents are working and it
   * is still replying, so they go on in the background. Once its reply is
   * over, a Stop ends them too. The same on every route.
   */
  stopKeepsSubagents(sessionId: string): boolean {
    const old = this.legacy.get(sessionId);
    const s = this.o.store.get(sessionId);
    if (old && s) return ((old.background?.() ?? 0) > 0 || this.legacySubagents(s) > 0) && !old.free?.();
    return this.replying.has(sessionId) && this.runsOf(sessionId).length > 0;
  }

  /** Put a message first in the queue, for the next turn, with the files it carries. */
  private queueFirst(s: StoredSession, text: string, attachments: Array<Attachment & { path: string }>, about?: string): void {
    const q: QueuedMessage = { id: crypto.randomUUID(), text, attachments: attachments.map(({ id, name, type, size }) => ({ id, name, type, size })), at: now(), ...(about ? { about } : {}) };
    s.queue = [q, ...(s.queue ?? [])];
    this.o.store.save(s);
    this.o.host.events.publish("session.changed", { sessionId: s.id, status: s.status, waitingCause: s.waitingCause });
  }

  /** The user's Stop. Unanswered tool calls are answered as stopped so the conversation stays valid. */
  stop(sessionId: string): void {
    // With subagents working, Stop ends only the main agent's reply; a second Stop, with it idle, ends them too.
    const old = this.legacy.get(sessionId);
    if (old && this.stopKeepsSubagents(sessionId)) {
      void this.legacyStopMain(sessionId, old).catch((e) => this.o.host.log.warn(`stopping the main agent in session ${sessionId} failed`, e));
      return;
    }
    if (!old && this.stopKeepsSubagents(sessionId)) {
      this.stopReply(this.require(sessionId), USER_STOP);
      return;
    }
    this.interrupt(sessionId, USER_STOP);
  }

  /** Stop the turn and every subagent in it. */
  stopAll(sessionId: string): void {
    this.interrupt(sessionId, USER_STOP);
  }

  /** Subagents are running, and a Stop or a sent message leaves them running. */
  keepsSubagents(sessionId: string): boolean {
    const old = this.legacy.get(sessionId);
    const s = this.o.store.get(sessionId);
    if (old && s) return (old.background?.() ?? 0) > 0 || this.legacySubagents(s) > 0;
    return this.runsOf(sessionId).length > 0;
  }

  /** The main agent takes a message now: it waits only on its subagents, or its reply ended while they work on. */
  mainFree(sessionId: string): boolean {
    const old = this.legacy.get(sessionId);
    if (old) return !!old.free?.();
    const s = this.o.store.get(sessionId);
    return !!s && this.mainFreeNow(s);
  }

  /**
   * Whether the main agent takes a message now, on any route: the turn runs,
   * subagents are working, and the main agent is not replying (its reply
   * ended while they work on), or is replying but waits only on its agent
   * calls (no call of its own runs; one it has not started does not count).
   */
  private mainFreeNow(s: StoredSession): boolean {
    if (!this.busy(s)) return false;
    const runs = this.runsOf(s.id);
    if (!runs.length) return false;
    if (!this.replying.has(s.id)) return true;
    if (!runs.some((r) => !r.background)) return false;
    const notStarted = new Set((s.pending ?? []).filter((p) => p.state === "queued").map((p) => p.id));
    return !s.transcript.some((t) => t.kind === "tool" && !t.parent && t.call.outcome === "pending" && t.call.name !== "agent" && !notStarted.has(t.call.id));
  }

  /** Keep the session's mainFree as mainFreeNow says, and tell the clients when it changes. A free main agent takes what is queued. */
  private refreshFree(s: StoredSession): void {
    if (this.legacy.has(s.id)) return;
    const free = this.mainFreeNow(s);
    if (!!s.mainFree === free) return;
    s.mainFree = free;
    this.o.store.save(s);
    this.o.host.events.publish("session.changed", { sessionId: s.id, status: s.status, waitingCause: s.waitingCause });
    if (free && s.queue?.length) setTimeout(() => this.tellQueued(s.id), 0);
  }

  /** The subagents of a session that are running or waiting to start; the ones the user assigned only when asked. */
  private runsOf(sessionId: string, assigned = false): AgentRun[] {
    return [...this.runs.values()].filter((r) => r.sessionId === sessionId && (assigned || !r.assigned));
  }

  /** The agent call ids of a session's running subagents: calls a reply's end or a restart leaves open. */
  private liveRunCalls(sessionId: string): Set<string> {
    return new Set(this.runsOf(sessionId, true).map((r) => r.callId));
  }

  /**
   * End only the main agent's reply, on any route: its subagents go on in the
   * background (their calls answered so its conversation stays whole), its
   * own calls end as stopped, and it is free beside them. `cause` says why.
   */
  private stopReply(s: StoredSession, cause: Interruption): void {
    this.toBackground(s);
    const asked = new Set((s.approvals ?? []).filter((a) => !a.parent).map((a) => a.toolUseId));
    const c = this.active.get(s.id);
    this.active.delete(s.id);
    this.replying.delete(s.id);
    c?.abort(cause);
    this.endTurn(s, cause, asked, this.liveRunCalls(s.id));
    this.o.host.log.info(`session ${s.id}: stopped the main agent's reply; ${this.runsOf(s.id).length} subagent(s) go on`);
  }

  /**
   * The main agent's running agent calls stop waiting: each subagent goes on
   * in the background, its call answered with backgroundNote, and its report
   * reaches the main agent as a message when it ends. Returns how many went.
   */
  private toBackground(s: StoredSession): number {
    let n = 0;
    for (const run of this.runsOf(s.id)) {
      if (run.background) continue;
      this.oneToBackground(s, run, backgroundNote(run.description));
      n++;
    }
    if (n) this.refreshFree(s);
    return n;
  }

  /** One subagent goes on in the background, its agent call answered with `note`. */
  private oneToBackground(s: StoredSession, run: AgentRun, note: string): void {
    run.background = true;
    for (const d of run.detach.splice(0)) d();
    // On Studio's loop the call is answered in the same step, so a Stop that follows finds it answered.
    const p = s.pending?.find((x) => x.id === run.callId);
    if (p && p.state !== "done") Object.assign(p, { state: "done", result: note, isError: false });
    this.keepRun(s, run);
    run.answer({ text: note, isError: false, background: true });
  }

  /**
   * Hand the main agent something while its turn runs: a background
   * subagent's report, or the user's message once its subagents went on in
   * the background. A replying main agent reads it at its next step (Studio's
   * loop before its next model call, the Claude sign-in streamed into its
   * reply); a free one starts a new reply with it. Outside a turn, text waits
   * as a note for the next one.
   */
  private tellMain(s: StoredSession, content: unknown[]): void {
    if (!this.busy(s)) {
      for (const b of content as Array<{ type?: string; text?: string }>) if (b.type === "text" && b.text) s.notes.push(b.text.replace(/^\[Studio\] /, ""));
      this.o.store.save(s);
      return;
    }
    let box = this.mainInbox.get(s.id);
    if (!box) this.mainInbox.set(s.id, (box = []));
    box.push(content);
    if (this.replying.has(s.id)) this.flushMainInbox(s);
    else this.startReply(s);
  }

  /** On the Claude sign-in, stream what waits for the main agent into its running reply. Studio's loop takes it before its next model call. */
  private flushMainInbox(s: StoredSession): void {
    const live = this.live.get(s.id);
    const box = this.mainInbox.get(s.id);
    if (!live || !box?.length) return;
    const next = box.shift()!;
    void Promise.resolve(live.say(next)).catch(() => false).then((said) => {
      if (said) {
        s.messages.push({ role: "user", content: next } as MessageParam);
        this.o.store.save(s);
        this.flushMainInbox(s);
        return;
      }
      // The reply takes no more input: it goes first again, and the next reply starts with it.
      box.unshift(next);
    });
  }

  /** What waits for the main agent, taken once. */
  private takeMainInbox(s: StoredSession): unknown[] {
    const box = this.mainInbox.get(s.id) ?? [];
    this.mainInbox.delete(s.id);
    return box.flat();
  }

  /** A free main agent replies to what waits for it, on the session's route. */
  private startReply(s: StoredSession): void {
    const content = this.takeMainInbox(s);
    if (!content.length) return;
    if (s.status !== "running") this.setStatus(s, "running", null);
    void this.reply(s, content).catch((e) => this.o.host.log.warn(`a reply in session ${s.id} failed`, e));
  }

  /**
   * The main agent's reply ended on its own, on any route. What waited for it
   * meanwhile starts the next reply; with subagents still working it is free
   * beside them, and their reports wake it; otherwise the turn is over.
   * `error`: why the reply failed.
   */
  private replyEnded(s: StoredSession, error: string | null): void {
    this.replying.delete(s.id);
    if (error) {
      s.error = error;
      this.setStatus(s, "error", null);
      return;
    }
    if (this.mainInbox.get(s.id)?.length) {
      this.startReply(s);
      return;
    }
    if (this.runsOf(s.id).length > 0) {
      if (s.status !== "running") this.setStatus(s, "running", null);
      this.refreshFree(s);
      return;
    }
    this.setStatus(s, "idle", null);
  }

  /** Compatibility: Stop on a legacy host's turn interrupts the main agent's reply only. Its own open calls end as stopped; the subagents' calls go on. */
  private async legacyStopMain(sessionId: string, live: LiveTurn): Promise<void> {
    // Foreground subagents and commands would end with the reply: they move to the background first.
    const kept = await (live.keep?.() ?? Promise.resolve(false));
    if (kept) this.o.host.log.info(`session ${sessionId}: moved foreground tasks to the background before stopping the main agent's reply`);
    await live.interrupt();
    const s = this.require(sessionId);
    for (const t of s.transcript) {
      if (t.kind !== "tool" || t.parent || t.call.outcome !== "pending" || t.call.queued || this.subagents.has(t.call.id)) continue;
      this.recordOutcome(s, { id: t.call.id, name: t.call.name, input: (t.call.input ?? {}) as Record<string, unknown>, state: "done", result: "Stopped by the user.", isError: true }, "stopped");
    }
    this.o.store.save(s);
  }

  /** Compatibility: the agent calls a legacy host's runtime runs as its own subagents, still working. */
  private legacySubagents(s: StoredSession): number {
    return s.transcript.filter((t) => t.kind === "tool" && !t.parent && t.call.outcome === "pending" && this.subagents.has(t.call.id)).length;
  }

  /**
   * Hand the user's message to the main agent while its subagents work, inside
   * the same turn, on any route: when it waits only on them they go on in the
   * background and it reads the message at its next step; when its reply had
   * ended, a new reply starts with it. False when the main agent cannot take
   * one now.
   */
  private async tell(s: StoredSession, text: string, attachments: Array<Attachment & { path: string }>, about?: string): Promise<boolean> {
    const old = this.legacy.get(s.id);
    if (!old && !this.mainFreeNow(s)) return false;
    const content: unknown[] = [];
    for (const note of [...s.notes, ...this.aboutNotes(s, about)]) content.push({ type: "text", text: `[Studio] ${note}` });
    for (const a of attachments) content.push(...(await contentFor(a)));
    if (text.trim()) content.push({ type: "text", text });
    if (old) {
      // Compatibility: a legacy host's main agent takes it straight into its turn.
      if (!(await old.say(content))) return false;
      s.messages.push({ role: "user", content } as MessageParam);
    } else {
      if (!this.mainFreeNow(s)) return false;
      if (this.replying.has(s.id)) this.toBackground(s);
      let box = this.mainInbox.get(s.id);
      if (!box) this.mainInbox.set(s.id, (box = []));
      box.push(content);
    }
    s.notes.splice(0);
    s.transcript.push({
      kind: "user",
      text,
      at: now(),
      ...(attachments.length ? { attachments: attachments.map(({ id, name, type, size }) => ({ id, name, type, size })) } : {}),
    });
    s.draft = "";
    this.o.store.save(s);
    this.o.host.events.publish("session.changed", { sessionId: s.id, status: s.status, waitingCause: s.waitingCause });
    if (!old) {
      if (this.replying.has(s.id)) this.flushMainInbox(s);
      else this.startReply(s);
    }
    return true;
  }

  /** The first queued message, to a main agent that is free while subagents run. */
  private tellQueued(sessionId: string): void {
    const s = this.o.store.get(sessionId);
    if (!s || !s.queue?.length || !this.mainFree(s.id)) return;
    const [next, ...rest] = s.queue;
    s.queue = rest;
    this.o.store.save(s);
    void this.tell(s, next.text, this.queuedFiles(s, next), next.about).then((told) => {
      if (told) return;
      // The turn ended meanwhile: the message goes back to the front, and the next turn sends it.
      s.queue = [next, ...(s.queue ?? [])];
      this.o.store.save(s);
      if (!this.busy(s)) void this.sendQueued(s.id);
    }, (e) => this.o.host.log.warn(`a queued message in session ${sessionId} failed`, e));
  }

  private queuedFiles(s: StoredSession, q: QueuedMessage): Array<Attachment & { path: string }> {
    return q.attachments.flatMap((a) => {
      const f = this.files.get(s.id, a.id);
      return f ? [f] : [];
    });
  }

  /** The sessions with a turn running or waiting. */
  activeSessions(): string[] {
    return this.o.store.all().filter((s) => s.status === "running" || s.status === "waiting").map((s) => s.id);
  }

  /**
   * The sessions whose work a daemon restart would end: a reply not running in
   * a host process, or a subagent not running in one (one still waiting to
   * start counts). A free main agent beside hosted subagents does not pin.
   */
  pinnedSessions(): string[] {
    const ids = new Set<string>();
    for (const id of this.activeSessions()) {
      const runs = this.runsOf(id, true);
      if (this.replying.has(id) ? !this.hosted.has(id) : runs.length === 0) ids.add(id);
    }
    for (const r of this.runs.values()) if (!r.hosted) ids.add(r.sessionId);
    return [...ids];
  }

  /**
   * End a turn now: the user stopped it, or Studio has to (its daemon is about
   * to restart). Every call it leaves unanswered says who ended it and what
   * goes on regardless, and the model hears the same with the next message.
   * Its subagents stop too, except `keep` (subagents that go on in a host).
   */
  interrupt(sessionId: string, cause: Interruption, keep: Set<string> = new Set()): void {
    const s = this.require(sessionId);
    const asked = new Set((s.approvals ?? []).map((a) => a.toolUseId));
    this.active.get(s.id)?.abort(cause);
    this.active.delete(s.id);
    this.replying.delete(s.id);
    this.mainInbox.delete(s.id);
    this.slots.get(s.id)?.cancelAll();
    // Its subagents, running or in the background, stop with it; the calls they leave are answered below.
    for (const run of this.runsOf(s.id)) {
      if (keep.has(run.callId)) continue;
      this.subagents.get(run.callId)?.();
      this.subagentAbort(run.callId).abort(cause);
    }
    this.endTurn(s, cause, asked, keep);
  }

  /**
   * Answer what a turn left open, leave the model a note, and set the
   * session's state. `asked`: calls waiting for approval, which never ran.
   * `keep`: subagents that go on (their agent call and their own calls stay
   * open); with any, the main agent is free beside them instead of the turn
   * ending.
   */
  private endTurn(s: StoredSession, cause: Interruption, asked: Set<string>, keep: Set<string> = new Set()): void {
    const running: Array<{ name: string; input: Record<string, unknown> }> = [];
    const outcome = cause.by === "user" ? "stopped" : "unknown";
    if (s.pending) {
      for (const p of s.pending) {
        if (p.state === "done") continue;
        const ran = p.state === "running" || p.state === "unknown";
        if (ran) running.push(p);
        p.state = "done";
        p.result = interruptedResult(p, cause, ran);
        p.isError = true;
        this.recordOutcome(s, p, outcome);
      }
      this.flushPending(s);
    }
    this.endCalls(s, (call) => {
      const ran = !asked.has(call.id);
      if (ran && !call.parent) running.push(call);
      return interruptedResult(call, cause, ran);
    }, outcome, undefined, keep);
    if (running.length > 0 || cause.by === "studio") {
      s.notes.push(interruptionNote(running, cause));
      const line = interruptionLine(cause);
      if (line) this.addEntry(s, { kind: "note", text: line, at: now() });
    }
    // Subagents go on: the main agent is free beside them, and their reports wake it.
    if (this.runsOf(s.id).some((r) => keep.has(r.callId)) || [...keep].some((id) => s.agentRuns?.[id] && !s.agentRuns[id].assigned)) {
      if (s.status !== "running") this.setStatus(s, "running", null);
      this.refreshFree(s);
      return;
    }
    if (cause.by === "user") {
      this.setStatus(s, "stopped", null);
    } else {
      s.error = `The turn ended because ${cause.why}. Send a message to continue.`;
      this.setStatus(s, "error", null);
    }
  }

  /**
   * Every call the transcript still shows running, answered with the text
   * `result` gives it: only a subagent's when `parent` is given, and never
   * those of the subagents in `keep` (their agent call and their own calls).
   */
  private endCalls(
    s: StoredSession,
    result: (call: { id: string; name: string; input: Record<string, unknown>; parent?: string }) => string,
    outcome: "stopped" | "unknown" | "error",
    parent?: string,
    keep?: Set<string>,
  ): void {
    for (const t of s.transcript) {
      if (t.kind !== "tool" || t.call.outcome !== "pending") continue;
      if (parent !== undefined && t.parent !== parent) continue;
      if (keep && (keep.has(t.call.id) || (t.parent && keep.has(t.parent)))) continue;
      const call = { id: t.call.id, name: t.call.name, input: (t.call.input ?? {}) as Record<string, unknown>, ...(t.parent ? { parent: t.parent } : {}) };
      this.recordOutcome(s, { id: call.id, name: call.name, input: call.input, state: "done", result: result(call), isError: true }, outcome);
    }
  }

  /**
   * Start a subagent the user asked for from the chat, such as a playtest
   * assigned from its card. It is the same subagent the agent tool starts, on
   * the same route, with its thread under an agent call in the transcript, but
   * it runs beside the session's turns rather than inside one: the session can
   * be idle or busy. stopSubagent stops it. Its report is kept for the agent's
   * next turn as a note. Resolves with the call id; `done` with its result.
   */
  assignSubagent(sessionId: string, description: string, prompt: string): { callId: string; done: Promise<{ text: string; isError: boolean; stopped?: boolean }> } {
    const s = this.require(sessionId);
    const callId = `studio_${crypto.randomUUID().replace(/-/g, "")}`;
    const input = { description, prompt };
    this.addEntry(s, { kind: "tool", call: { id: callId, name: "agent", input, outcome: "pending", startedAt: now() } });
    const run = this.newRun(s, callId, input, true);
    run.done = this.runSubagent(s, { id: callId, name: "agent", input, state: "running" }, null, run);
    this.settleRun(s, run);
    const done = run.call.then((r) => this.assignedEnded(s, callId, input, r));
    return { callId, done };
  }

  /** A subagent the user assigned ended: its calls are answered, and its report waits for the agent's next turn. */
  private assignedEnded(s: StoredSession, callId: string, input: Record<string, unknown>, r: AgentResult): AgentResult {
    const description = describeCall(input);
    // Calls the subagent left running are answered, as a stop answers a turn's.
    this.endCalls(s, () => "The subagent ended before this call returned a result.", "error", callId);
    this.recordOutcome(s, { id: callId, name: "agent", input, state: "done", result: r.text, isError: r.isError }, r.stopped ? "stopped" : r.isError ? "error" : "done");
    s.notes.push(`The user had a subagent run "${description}" outside your turns. ${r.stopped ? "The user stopped it." : r.isError ? "It failed." : "It finished."} Its report:\n${r.text}`);
    this.o.store.save(s);
    return r;
  }

  /** A new subagent run, registered so every path can find it; its `done` is set by the caller. */
  private newRun(s: StoredSession, callId: string, input: Record<string, unknown>, assigned: boolean): AgentRun {
    let answer!: (a: AgentAnswer) => void;
    const call = new Promise<AgentAnswer>((resolve) => (answer = resolve));
    let answered = false;
    const run: AgentRun = {
      sessionId: s.id,
      callId,
      description: describeCall(input),
      assigned,
      background: false,
      done: Promise.resolve({ text: "", isError: true }),
      call,
      answer: (a) => {
        if (answered) return;
        answered = true;
        answer(a);
      },
      detach: [],
      say: null,
      hosted: null,
      told: [],
    };
    this.runs.set(callId, run);
    this.keepRun(s, run);
    return run;
  }

  /** Save what a restart needs of a running subagent (agentRuns): `seq` its host's last event, `messages` its conversation on Studio's loop. */
  private keepRun(s: StoredSession, run: AgentRun, seq?: number, messages?: MessageParam[]): void {
    if (this.disposed) return;
    const was = s.agentRuns?.[run.callId];
    const at = seq ?? was?.seq;
    const conv = messages ?? was?.messages;
    (s.agentRuns ??= {})[run.callId] = { background: run.background, assigned: run.assigned, ...(at !== undefined ? { seq: at } : {}), ...(conv ? { messages: conv } : {}), ...(run.told.length ? { told: [...run.told] } : {}) };
    this.o.store.save(s);
  }

  /**
   * When a subagent ends, on any route: what the user sent it that it never
   * read goes with its report, and the report answers its agent call, or
   * reaches the main agent as a message when the call was answered already
   * (it went on in the background).
   */
  private settleRun(s: StoredSession, run: AgentRun): void {
    void run.done.catch((e: unknown) => ({ text: `The subagent failed: ${e instanceof Error ? e.message : String(e)}`, isError: true })).then((r: AgentResult & { detached?: true }) => {
      // This daemon let go of it: it goes on in its host, or resumes from its saved conversation, in the next daemon.
      if (r.detached || this.disposed) return;
      this.runs.delete(run.callId);
      this.subagents.delete(run.callId);
      this.subagentStops.delete(run.callId);
      this.dropApprovals(s.id, run.callId);
      if (s.agentRuns?.[run.callId]) {
        delete s.agentRuns[run.callId];
        this.o.store.save(s);
      }
      const unread = this.inbox.drain(run.callId);
      let result: AgentResult = { text: r.text, isError: r.isError, ...(r.stopped ? { stopped: true } : {}) };
      // What it read from the user goes with its result: the main agent never saw it, and would otherwise distrust a report that acts on it.
      const read = run.told.filter((t) => !unread.includes(t));
      if (read.length) result = { ...result, text: `${result.text}\n\n[Studio] ${heardNote(read)}` };
      if (unread.length) {
        this.addEntry(s, { kind: "note", text: `"${run.description}" ended before it read your message, so it went to the main agent.`, at: now() });
        result = { ...result, text: `${result.text}\n\n[Studio] ${unreadNote(run.description, unread)}` };
      }
      if (run.background && !run.assigned) this.reportToMain(s, run, result);
      else run.answer(result);
      this.refreshFree(s);
      // The last subagent of a free main agent ended without a report to give it (stopped): the turn is over.
      if (!run.assigned && this.busy(s) && !this.replying.has(s.id) && !this.active.has(s.id) && this.runsOf(s.id).length === 0 && !this.mainInbox.get(s.id)?.length && !this.legacy.has(s.id)) this.setStatus(s, "idle", null);
    });
  }

  /** A subagent that went on in the background ended: its call shows its report, and the main agent is told. */
  private reportToMain(s: StoredSession, run: AgentRun, r: AgentResult): void {
    const entry = s.transcript.find((t) => t.kind === "tool" && t.call.id === run.callId);
    // A Stop answered it already.
    if (entry?.kind !== "tool" || entry.call.outcome !== "pending") return;
    this.recordOutcome(s, { id: run.callId, name: "agent", input: (entry.call.input ?? {}) as Record<string, unknown>, state: "done", result: r.text, isError: r.isError }, r.stopped ? "stopped" : r.isError ? "error" : "done");
    const note = backgroundReport(run.description, run.callId, r);
    // One the user stopped wakes nobody: the main agent hears of it with the next message.
    if (r.stopped) {
      s.notes.push(note);
      this.o.store.save(s);
      return;
    }
    this.tellMain(s, [{ type: "text", text: `[Studio] ${note}` }]);
  }

  /**
   * One of the main agent's agent calls, on any route: its subagent waits for
   * a slot (Settings > Agents, subagents at once, one queue per session),
   * runs as its own conversation on the route's engine, and answers the call
   * with its report. When the user writes to the main agent meanwhile, or
   * stops only its reply, the subagent goes on in the background (toBackground).
   * A call for a subagent this daemon already runs (sent again after a
   * restart) waits on that one. `onStart`: it got its slot and starts now.
   */
  private agentCall(s: StoredSession, id: string, input: Record<string, unknown>, turnSignal: AbortSignal, onStart?: () => void): Promise<AgentAnswer> {
    const existing = this.runs.get(id);
    if (existing) {
      // Taken over after a restart: its call waits on it again, unless it went on in the background.
      if (existing.background) return Promise.resolve({ text: backgroundNote(existing.description), isError: false, background: true });
      return existing.call;
    }
    if (s.turn) s.turn.agents = (s.turn.agents ?? 0) + 1;
    const run = this.newRun(s, id, input, false);
    const slots = this.slotsFor(s.id);
    // Stop cancels it while it waits; once in the background, only stopping it, or everything, does.
    const cancel = () => slots.cancel(id);
    turnSignal.addEventListener("abort", cancel, { once: true });
    run.detach.push(() => turnSignal.removeEventListener("abort", cancel));
    run.done = (async (): Promise<AgentResult> => {
      const started = await slots.acquire(id, () => this.markQueued(s, id, () => slots.cancel(id)));
      turnSignal.removeEventListener("abort", cancel);
      if (!started) return { text: QUEUED_STOP, isError: true, stopped: true };
      this.markQueued(s, id, null);
      onStart?.();
      try {
        return await this.runSubagent(s, { id, name: "agent", input, state: "running" }, run.background ? null : turnSignal, run);
      } finally {
        slots.release(id);
      }
    })();
    this.settleRun(s, run);
    // A helper whose file says it runs in the background answers its call at once, on every route.
    const helper = typeof input.helper === "string" ? this.native()?.helpers.find((h) => h.name === input.helper) : undefined;
    if (helper?.background) this.oneToBackground(s, run, `The ${helper.name} helper runs in the background, as its file says. Its report comes to you in a later message when it ends.`);
    this.refreshFree(s);
    return run.call;
  }

  /** The session's queue of subagents, with the limit as it is set when the queue is empty. */
  private slotsFor(sessionId: string): SubagentSlots {
    let sl = this.slots.get(sessionId);
    if (!sl || (sl.counts.running === 0 && sl.counts.waiting === 0)) this.slots.set(sessionId, (sl = new SubagentSlots(this.usage().subagentsPerTurn)));
    return sl;
  }

  /**
   * After a restart: each subagent the previous daemon ran. One whose
   * conversation runs in a turn host is taken over and goes on; one that ran
   * in the previous daemon is cut off, and when it was in the background the
   * main agent is told. A foreground one a reattaching reply waits on is left
   * to that reply's call. Returns the agent calls that go on.
   */
  private recoverAgents(s: StoredSession, why: string): Set<string> {
    const kept = new Set<string>();
    const runs = s.agentRuns ?? {};
    const mainHost = !!this.o.turnHosts?.recordFor(s.id);
    for (const t of s.transcript) {
      if (t.kind !== "tool" || t.call.name !== "agent" || t.parent || t.call.outcome !== "pending") continue;
      const id = t.call.id;
      const saved = runs[id];
      const awaited = !!s.pending?.some((p) => p.id === id && p.state !== "done");
      // A subagent on Studio's loop resumes from its saved conversation: in the background, or under the agent call its main agent's step waits on.
      if (saved?.messages) {
        this.resumeAgent(s, t.call.input as Record<string, unknown>, id, { ...saved, background: saved.background || (!saved.assigned && !awaited) });
        kept.add(id);
        continue;
      }
      // Studio's loop answers its own pending calls, and cuts off a subagent it lost there.
      if (awaited) continue;
      const record = this.o.turnHosts?.recordFor(agentHostKey(s.id, id)) ?? null;
      // A foreground one whose reply did not outlive the daemon has nobody waiting on its call: it reports as from the background.
      if (saved && record && this.reattachAgent(s, t.call.input as Record<string, unknown>, id, { ...saved, background: saved.background || (!saved.assigned && !mainHost) }, record)) {
        kept.add(id);
        continue;
      }
      // A reply that comes back asks for it again: started anew, or with an unknown outcome.
      if (saved && !saved.background && !saved.assigned && mainHost) continue;
      // Compatibility: a legacy host's own subagent, which that host still reports.
      if (!saved && !id.startsWith("studio_") && mainHost) continue;
      const cut = `The subagent was cut off (${why}) before it reported.`;
      this.endCalls(s, () => cut, "unknown", id);
      this.recordOutcome(s, { id, name: "agent", input: {}, state: "done", result: cut, isError: true }, "unknown");
      if (saved?.background) s.notes.push(`The subagent "${describeCall(t.call.input)}" (agent call ${id}), which kept working in the background, ${cut.slice(4)} Read back the state of what it was working on before redoing any of it.`);
    }
    if (s.agentRuns) {
      for (const id of Object.keys(s.agentRuns)) if (!kept.has(id)) delete s.agentRuns[id];
      this.o.store.save(s);
    }
    return kept;
  }

  /** Resume a subagent of Studio's loop from the conversation the previous daemon saved. */
  private resumeAgent(s: StoredSession, input: Record<string, unknown>, id: string, saved: { background: boolean; assigned: boolean; messages?: MessageParam[]; told?: string[] }): void {
    const run = this.newRun(s, id, input, saved.assigned);
    run.background = saved.background;
    run.told = [...(saved.told ?? [])];
    // What the user wrote to it that its saved conversation does not hold yet waits for its next step again.
    const had = JSON.stringify(saved.messages ?? []);
    for (const t of run.told) if (!had.includes(JSON.stringify(t).slice(1, -1))) this.inbox.push(id, t);
    this.keepRun(s, run, undefined, saved.messages);
    // It takes a slot again, so the limit holds across the restart.
    void this.slotsFor(s.id).acquire(id);
    run.done = this.runSubagent(s, { id, name: "agent", input, state: "running" }, null, run, { messages: saved.messages! }).finally(() => this.slots.get(s.id)?.release(id));
    this.settleRun(s, run);
    if (saved.assigned) void run.call.then((r) => this.assignedEnded(s, id, input, r));
    this.o.host.log.info(`session ${s.id}: resumed subagent ${id} from its saved conversation${saved.background ? " (in the background)" : ""}`);
  }

  /** Take over a subagent whose conversation outlived the previous daemon in a turn host. */
  private reattachAgent(s: StoredSession, input: Record<string, unknown>, id: string, saved: { background: boolean; assigned: boolean; seq?: number; told?: string[] }, record: TurnHostRecord): boolean {
    if (!this.o.turnHosts) return false;
    const run = this.newRun(s, id, input, saved.assigned);
    run.background = saved.background;
    run.told = [...(saved.told ?? [])];
    this.keepRun(s, run, saved.seq ?? 0);
    run.done = this.runSubagent(s, { id, name: "agent", input, state: "running" }, null, run, { record, from: saved.seq ?? 0 });
    this.settleRun(s, run);
    if (saved.assigned) void run.call.then((r) => this.assignedEnded(s, id, input, r));
    this.o.host.log.info(`session ${s.id}: took over subagent ${id} in its host process ${record.host}${saved.background ? " (in the background)" : ""}`);
    return true;
  }

  /**
   * Stop one subagent and let the turn go on: the main agent is told the user
   * stopped it. Returns false when no subagent of that id is running.
   */
  stopSubagent(sessionId: string, callId: string): boolean {
    const s = this.require(sessionId);
    const stop = this.subagents.get(callId);
    if (!stop) return false;
    stop();
    // Its calls in flight are let go now, as Stop lets a turn's go: each says it was stopped, whatever it returns later.
    this.subagentAbort(callId).abort(USER_STOP);
    this.endSubagentCalls(s, callId);
    return true;
  }

  /** Each subagent's own stop signal, by its agent call id, for the calls it makes. */
  private readonly subagentStops = new Map<string, AbortController>();
  private subagentAbort(callId: string): AbortController {
    let c = this.subagentStops.get(callId);
    if (!c) this.subagentStops.set(callId, (c = new AbortController()));
    return c;
  }

  /** Answer every call a stopped subagent still has running, the way Stop answers a turn's. */
  private endSubagentCalls(s: StoredSession, callId: string): void {
    this.endCalls(s, (call) => interruptedResult(call, USER_STOP, true), "stopped", callId);
  }

  /**
   * Hold a command or a file change until the user answers. Returns null to
   * run it, or why it must not run: declined, or the turn was stopped.
   */
  private async gate(s: StoredSession, toolUseId: string, name: string, input: Record<string, unknown>, signal: AbortSignal, kindOf?: ApprovalKind | null): Promise<GateResult> {
    const kind = kindOf !== undefined ? kindOf : approvalKind(name, input, this.o.effects ?? NO_EFFECTS);
    if (!kind) return null;
    // A bad input fails in the executor without changing anything.
    if (validateInput(name, input)) return null;
    const rule = this.o.approvals?.()[kind];
    const asks = rule
      ? rule === "ask" || (rule === "project" && !callInsideProject(this.o.host.projectDir, name, input))
      : (kind === "shell" || kind === "files") && (this.o.askBeforeChanges?.() ?? true);
    if (!asks) return null;
    if (s.allowed?.includes(SESSION_KEY[kind])) return null;
    // Code a ue-mcp action runs asks as a shell command, shown as the call it is.
    const preview = (kind === "shell" || kind === "files" ? approvalFor(this.o.host.projectDir, name, input) : null) ?? editorPreview(name, input);
    if (!preview) return null;
    if (signal.aborted) return { stopped: true };

    const entry = s.transcript.find((t) => t.kind === "tool" && t.call.id === toolUseId);
    const parent = entry?.parent ?? null;
    const agent = parent ? s.transcript.find((t) => t.kind === "tool" && t.call.id === parent) : undefined;
    const subagent = agent?.kind === "tool" ? (agent.call.input as { description?: unknown }).description : undefined;
    const req: ApprovalRequest = { id: crypto.randomUUID(), toolUseId, parent, ...(typeof subagent === "string" ? { subagent } : {}), ...preview, at: now() };
    const decision = await this.waitForAnswer(s, req, name, signal);
    if (decision === "session") s.allowed = [...new Set([...(s.allowed ?? []), SESSION_KEY[kind]])];
    this.o.store.save(s);
    if (decision === "stopped") return { stopped: true };
    if (decision === "deny") return { declined: declinedText(name) };
    return null;
  }

  /** Hold a request until the user answers it or the turn stops. */
  private async waitForAnswer(s: StoredSession, req: ApprovalRequest, name: string, signal: AbortSignal): Promise<ApprovalDecision | "stopped"> {
    const parent = req.parent;
    const decision = await new Promise<ApprovalDecision | "stopped">((resolve) => {
      const onAbort = () => resolve("stopped");
      signal.addEventListener("abort", onAbort, { once: true });
      this.waitingApprovals.set(req.id, {
        sessionId: s.id,
        parent,
        answer: (d) => {
          signal.removeEventListener("abort", onAbort);
          resolve(d);
        },
      });
      s.approvals = [...(s.approvals ?? []), req];
      this.o.store.save(s);
      this.o.host.events.publish("approval.requested", { sessionId: s.id, approvalId: req.id, tool: name });
      this.o.host.events.publish("session.changed", { sessionId: s.id, status: s.status, waitingCause: s.waitingCause });
    });

    this.waitingApprovals.delete(req.id);
    s.approvals = (s.approvals ?? []).filter((a) => a.id !== req.id);
    this.o.store.save(s);
    this.o.host.events.publish("approval.resolved", { sessionId: s.id, approvalId: req.id, decision });
    this.o.host.events.publish("session.changed", { sessionId: s.id, status: s.status, waitingCause: s.waitingCause });
    return decision;
  }

  /** The user's answer to a waiting call. False when no such approval is waiting in that session. */
  answerApproval(sessionId: string, approvalId: string, decision: ApprovalDecision): boolean {
    const w = this.waitingApprovals.get(approvalId);
    if (!w || w.sessionId !== sessionId) return false;
    w.answer(decision);
    return true;
  }

  /** Answer as stopped every approval a subagent left waiting. */
  private dropApprovals(sessionId: string, parent: string): void {
    for (const w of [...this.waitingApprovals.values()]) if (w.sessionId === sessionId && w.parent === parent) w.answer("stopped");
  }

  /** A provider's own web searches, as finished calls in the transcript. */
  private recordSearches(s: StoredSession, searches: WebSearchRecord[] | undefined, parent?: string): void {
    for (const w of searches ?? []) {
      const result = w.error ? `The search failed: ${w.error}` : w.results.map((r) => `${r.title}\n${r.url}`).join("\n\n") || "No results.";
      const at = now();
      this.addEntry(s, { kind: "tool", call: { id: w.id, name: "web_search", input: { query: w.query }, outcome: w.error ? "error" : "done", result, startedAt: at, endedAt: at }, ...(parent ? { parent } : {}) });
    }
  }

  private require(id: string): StoredSession {
    const s = this.o.store.get(id);
    if (!s) throw new Error(`no session ${id}`);
    return s;
  }

  private setStatus(s: StoredSession, status: StoredSession["status"], waitingCause: string | null): void {
    const was = s.status;
    s.status = status;
    s.waitingCause = waitingCause;
    this.o.store.save(s);
    this.o.host.events.publish("session.changed", { sessionId: s.id, status, waitingCause });
    // A turn that finished sends the next queued message. One that stopped or failed leaves the queue for the user.
    if (status === "idle" && s.queue?.length) setTimeout(() => void this.sendQueued(s.id), 0);
    // A turn that ended, however it ended, gets its checkpoint after and its review.
    const ended = status !== "running" && status !== "waiting" && (was === "running" || was === "waiting");
    if (ended && s.reviewing) void this.o.review?.turnEnded(s).catch((e) => this.o.host.log.warn("the review checkpoint after the turn failed", e));
  }

  /** Queue a message behind the running turn. With no turn running it is sent at once. */
  enqueue(sessionId: string, text: string, attachments: Attachment[], about?: string): QueuedMessage {
    const s = this.require(sessionId);
    const q: QueuedMessage = { id: crypto.randomUUID(), text, attachments, at: now(), ...(about ? { about } : {}) };
    s.queue = [...(s.queue ?? []), q];
    this.o.store.save(s);
    this.o.host.events.publish("session.changed", { sessionId: s.id, status: s.status, waitingCause: s.waitingCause });
    if (!this.busy(s)) void this.sendQueued(s.id);
    else if (this.mainFree(s.id)) this.tellQueued(s.id);
    return q;
  }

  /** Change a queued message's text, or remove it. False when it has been sent already. */
  editQueued(sessionId: string, id: string, text: string | null): boolean {
    const s = this.require(sessionId);
    const q = s.queue?.find((x) => x.id === id);
    if (!q) return false;
    if (text === null) s.queue = s.queue!.filter((x) => x.id !== id);
    else q.text = text;
    this.o.store.save(s);
    this.o.host.events.publish("session.changed", { sessionId: s.id, status: s.status, waitingCause: s.waitingCause });
    return true;
  }

  /** Send the first queued message, when no turn is running. */
  async sendQueued(sessionId: string): Promise<void> {
    // Callers fire and forget this, from a timer too, so it never rejects: a rejection nobody handles ends the daemon.
    try {
      const s = this.o.store.get(sessionId);
      if (!s || this.busy(s) || !s.queue?.length) return;
      const [next, ...rest] = s.queue;
      s.queue = rest;
      this.o.store.save(s);
      const files = next.attachments.flatMap((a) => {
        const f = this.files.get(s.id, a.id);
        return f ? [f] : [];
      });
      await this.send(s.id, next.text, files, next.about);
    } catch (e) {
      this.o.host.log.warn(`a queued message in session ${sessionId} failed`, e);
    }
  }

  /**
   * Send one queued message now with its files: a running turn stops, as Stop does, and the rest
   * of the queue keeps its order. Taken from the queue in one step, so it goes once. False when it is not queued.
   */
  sendQueuedNow(sessionId: string, id: string): boolean {
    const s = this.require(sessionId);
    const q = s.queue?.find((x) => x.id === id);
    if (!q) return false;
    s.queue = s.queue!.filter((x) => x.id !== id);
    this.o.store.save(s);
    this.o.host.events.publish("session.changed", { sessionId: s.id, status: s.status, waitingCause: s.waitingCause });
    // Background subagents keep working: sendNow stops only the main agent's reply then.
    this.sendNow(s.id, q.text, this.queuedFiles(s, q), q.about).catch((e) => this.o.host.log.warn(`a queued message in session ${sessionId} failed`, e));
    return true;
  }

  /** Stop the running turn, as Stop does, and send this message now, ahead of the queue. */
  async sendNow(sessionId: string, text: string, attachments: Array<Attachment & { path: string }> = [], about?: string): Promise<void> {
    const s = this.require(sessionId);
    const old = this.legacy.get(s.id);
    if (old && ((old.background?.() ?? 0) > 0 || this.legacySubagents(s) > 0)) {
      // Compatibility, a legacy host's turn: foreground subagents move to the background first, then only the main agent's reply stops.
      const free = !!old.free?.();
      if (!free) await this.legacyStopMain(s.id, old);
      if (await this.tell(s, text, attachments, about)) return;
      this.queueFirst(s, text, attachments, about);
      return;
    }
    const subagents = this.runsOf(s.id).length;
    if (subagents > 0 && this.busy(s)) {
      // A message never ends a subagent, on any route. They go on in the background; when the main agent is
      // working on something of its own, only its reply stops; and it takes this message next.
      const free = this.mainFreeNow(s);
      if (!free) this.stopReply(s, USER_SENT);
      if (await this.tell(s, text, attachments, about)) {
        this.o.host.log.info(`session ${s.id}: message handed to the main agent beside ${subagents} subagent(s)${free ? "" : ", after stopping its reply"}`);
        return;
      }
      this.queueFirst(s, text, attachments, about);
      this.o.host.log.warn(`session ${s.id}: the main agent could not take a message beside running subagents, so it was queued instead of ending them`);
      return;
    }
    if (this.busy(s)) this.interrupt(sessionId, USER_SENT);
    await this.send(sessionId, text, attachments, about);
  }

  /**
   * The user's message to a running subagent, written in its thread, on any
   * route. It shows in that thread now and goes into the subagent's own
   * conversation as a user message, read at its next step: Studio's loop adds
   * it before the subagent's next model call; a subagent on the Claude
   * sign-in has it streamed into its own session. Nothing is stopped, the
   * main agent never sees it, and other subagents go on. False when that
   * subagent is not running (it finished, was stopped, or there is none).
   */
  async messageSubagent(sessionId: string, callId: string, text: string): Promise<boolean> {
    const s = this.require(sessionId);
    if (!text.trim() || !this.canMessage(s, callId)) return false;
    const run = this.runs.get(callId)!;
    if (run.say) {
      if (!(await run.say(text))) return false;
    } else this.inbox.push(callId, text);
    run.told.push(text);
    // Kept with the run, so its result still names it after a restart.
    this.keepRun(s, run);
    this.addEntry(s, { kind: "user", text, at: now(), parent: callId });
    this.o.host.log.info(`session ${s.id}: a message for subagent ${callId}, read at its next step`);
    return true;
  }

  /** The subagent of this agent call is running, or waiting to start, and so can still read a message. */
  canMessage(s: StoredSession, callId: string): boolean {
    const entry = s.transcript.find((t) => t.kind === "tool" && t.call.id === callId);
    if (entry?.kind !== "tool" || entry.call.name !== "agent" || entry.call.outcome !== "pending") return false;
    // A legacy host's own subagents cannot take one: the message goes to the main agent, saying whose thread it was.
    return this.runs.has(callId);
  }

  /** What the main agent is told with a message written in a finished subagent's thread. */
  private aboutNotes(s: StoredSession, about: string | undefined): string[] {
    if (!about) return [];
    const entry = s.transcript.find((t) => t.kind === "tool" && t.call.id === about);
    return [aboutNote(describeCall(entry?.kind === "tool" ? entry.call.input : null))];
  }

  /**
   * Replace one of the user's messages: the conversation is cut back to just
   * before it, for the model as well as the panel, and the new text is sent
   * as a new turn with the files the message carried. A running turn is
   * stopped first. What the agent changed in the project stays changed.
   */
  async editMessage(sessionId: string, index: number, text: string): Promise<boolean> {
    const s = this.require(sessionId);
    const entry = s.transcript[index];
    if (!entry || entry.kind !== "user" || entry.parent) return false;
    const notes = s.notes.length;
    // The edit removes the turns the subagents belong to: everything stops.
    if (this.busy(s)) this.stopAll(sessionId);
    // What the stop would tell the model is about turns the edit removes.
    s.notes = s.notes.slice(0, notes);
    const files = (entry.attachments ?? []).flatMap((a) => {
      const f = this.files.get(s.id, a.id);
      return f ? [f] : [];
    });
    const later = index < s.transcript.length - 1;
    SessionStore.truncateAt(s, index);
    if (later) s.notes.push(REWOUND_NOTE);
    s.status = "idle";
    s.waitingCause = null;
    this.o.store.save(s);
    this.o.host.events.publish("session.changed", { sessionId: s.id, status: s.status, waitingCause: null });
    await this.send(s.id, text, files);
    return true;
  }

  /**
   * Edit one of the user's messages into a new session: a copy of this one up
   * to just before the message, which then continues from the new text. The
   * original is left as it was, running or not. Returns the new session's id.
   */
  async forkAt(sessionId: string, index: number, text: string): Promise<string | null> {
    const s = this.require(sessionId);
    const entry = s.transcript[index];
    if (!entry || entry.kind !== "user" || entry.parent) return null;
    const fork = this.o.store.create(`${s.title} (fork)`);
    const copy = structuredClone(s);
    Object.assign(copy, { id: fork.id, title: fork.title, createdAt: fork.createdAt, updatedAt: fork.updatedAt, status: "idle", waitingCause: null, notes: [], draft: "", crashed: false, mainFree: false });
    // The original's running subagents and reply stay the original's.
    delete copy.agentRuns;
    delete copy.hostTurn;
    SessionStore.truncateAt(copy, index);
    // The original's Claude conversations stay the original's: deleting the fork must not take them with it.
    copy.sdkPast = [];
    copy.archived = false;
    if (index < s.transcript.length - 1) copy.notes.push(REWOUND_NOTE);
    this.files.copy(s.id, copy.id);
    this.o.store.save(copy);
    this.o.host.events.publish("session.changed", { sessionId: copy.id, status: copy.status, waitingCause: null });
    const files = (entry.attachments ?? []).flatMap((a) => {
      const f = this.files.get(copy.id, a.id);
      return f ? [f] : [];
    });
    // The fork answers with its id at once; its first turn runs on.
    this.send(copy.id, text, files).catch((e) => this.o.host.log.warn(`the fork of session ${s.id} failed`, e));
    return copy.id;
  }

  private busy(s: StoredSession): boolean {
    return this.active.has(s.id) || s.status === "running" || s.status === "waiting";
  }

  /**
   * Cards extensions post into a session: kept in the transcript and drawn by the client's
   * chat.card slot, never in what a model is sent. Main thread only; data must be JSON.
   */
  readonly cards = {
    post: (sessionId: string, card: CardPost & { ext: string }): CardEntry => {
      const s = this.o.store.get(sessionId);
      if (!s) throw new Error(`no session ${sessionId}`);
      if (!CARD_NAME.test(card.ext)) throw new Error(`invalid extension name "${card.ext}"`);
      if (!CARD_NAME.test(card.type)) throw new Error(`invalid card type "${card.type}"`);
      let json: string | undefined;
      try {
        json = JSON.stringify(card.data);
      } catch {
        json = undefined;
      }
      if (json === undefined) throw new Error("card data must be JSON");
      if (json.length > MAX_CARD_BYTES) throw new Error(`card data is over ${MAX_CARD_BYTES} bytes`);
      const entry: CardEntry = { kind: "card", ext: card.ext, type: card.type, data: JSON.parse(json), at: now() };
      this.addEntry(s, entry);
      return entry;
    },
  };

  private addEntry(s: StoredSession, entry: TranscriptEntry): void {
    if (entry.kind === "tool" && this.queuedEarly.delete(entry.call.id)) entry.call.queued = true;
    s.transcript.push(entry);
    this.o.store.save(s);
    this.o.host.events.publish("transcript.added", { sessionId: s.id, entry: entry as unknown as Record<string, unknown> });
    // A call of the main agent's own while its subagents work: it is working, not waiting on them.
    if (entry.kind === "tool" && !entry.parent && this.runs.size > 0) this.refreshFree(s);
  }

  private async runTurn(id: string): Promise<void> {
    if (this.active.has(id)) return;
    const controller = new AbortController();
    this.active.set(id, controller);
    const s = this.require(id);
    if (this.o.subscription?.()) {
      // The runtime cannot pick up a reply a restart cut off; its session continues from the next message.
      this.active.delete(id);
      s.error = "The turn was interrupted. Send the next message to continue.";
      this.setStatus(s, "error", null);
      return;
    }
    this.replying.add(id);
    let overflowed = false;
    try {
      for (;;) {
        if (controller.signal.aborted) return;

        if (s.pending) {
          const paused = await this.answerPending(s, controller.signal);
          if (paused || controller.signal.aborted) return;
        }

        if (s.status !== "running") this.setStatus(s, "running", null);
        // What came for the main agent meanwhile (the user's message, a background subagent's report) joins before its next model call.
        const told = this.takeMainInbox(s);
        if (told.length) addUserContent(s.messages, told);
        // One surface for the whole request: its tools, its prompt line and how its calls read back.
        const surf = this.surface();
        const conv = this.mainConversation(s, surf);
        // Near the window, the conversation is summarised before the request goes.
        await this.autoCompact(s, conv, controller.signal);
        if (controller.signal.aborted) return;
        let turn: ModelTurn;
        try {
          turn = await this.o.provider().run(
            { sessionId: s.id, model: conv.model, effort: conv.effort, system: conv.system, tools: conv.tools, messages: s.messages },
            (text) => this.o.host.events.publish("turn.delta", { sessionId: s.id, text }),
            controller.signal,
          );
        } catch (e) {
          // Refused as too long, as on a model with a smaller window than the last: compact, then send once more.
          if (controller.signal.aborted || overflowed || !isContextOverflow(e)) throw e;
          overflowed = true;
          await this.compactConversation(s, conv, "overflow", Math.max(this.currentContext(s, conv), this.windowFor(conv.model)), controller.signal);
          continue;
        }
        if (controller.signal.aborted) return;
        this.count(s, usageTokens(turn.usage), null);
        this.spend(s, turn.usage, conv.model);
        if (controller.signal.aborted) return;

        s.messages.push({ role: "assistant", content: turn.content } as MessageParam);
        this.measure(s, null, turn.usage, conv.model, { messages: s.messages.length });
        this.recordSearches(s, turn.searches);
        const text = turn.content.filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text").map((b) => b.text).join("");
        if (text) this.addEntry(s, { kind: "assistant", text, at: now() });

        if (turn.stopReason === "refusal") {
          this.replyEnded(s, `The model declined: ${turn.refusal ?? "no reason given"}`);
          return;
        }
        // A long server-side step (a web search) paused the turn: send it back to go on.
        if (turn.stopReason === "pause_turn") continue;
        const uses = turn.content.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");
        if (turn.stopReason !== "tool_use" || uses.length === 0) {
          // Something came for it while it wrote this: it replies again rather than end.
          if (this.mainInbox.get(s.id)?.length) continue;
          this.replyEnded(s, null);
          return;
        }
        // A projected category call is kept as the ue_mcp call it is; the model's own block stays in the conversation.
        s.pending = uses.map((u) => {
          const c = surf.canon(u.name, (u.input ?? {}) as Record<string, unknown>);
          return { id: u.id, name: c.name, input: c.input, state: "queued" as const };
        });
        for (const p of s.pending) {
          this.addEntry(s, { kind: "tool", call: { id: p.id, name: p.name, input: p.input, outcome: "pending", startedAt: now() } });
        }
      }
    } catch (e) {
      if (controller.signal.aborted) return;
      this.replyEnded(s, e instanceof Error ? e.message : String(e));
    } finally {
      if (this.active.get(id) === controller) this.active.delete(id);
    }
  }

  /**
   * Answer every pending tool call, in order. Returns true when the turn
   * paused for the editor and must wait for it to come back.
   */
  private async answerPending(s: StoredSession, signal: AbortSignal): Promise<boolean> {
    const pending = s.pending!;
    // Subagents run at the same time, before the calls the main agent makes itself, the same way on every route (agentCall).
    const queued = pending.filter((p) => p.name === "agent" && p.state === "queued");
    if (queued.length > 0) {
      await Promise.all(queued.map(async (p) => {
        const r = await this.agentCall(s, p.id, p.input, signal, () => {
          p.state = "running";
          this.o.store.save(s);
        });
        // A Stop of everything answered the call already.
        if (signal.aborted && !r.background) return;
        p.state = "done";
        p.result = r.text;
        p.isError = r.isError;
        // One that went on in the background stays open until it ends, and then reports to the main agent.
        if (r.background) this.o.store.save(s);
        else this.recordOutcome(s, p, r.stopped ? "stopped" : r.isError ? "error" : "done");
      }));
      if (signal.aborted) return true;
    }
    for (const p of pending) {
      if (signal.aborted) return true;
      if (p.state === "done") continue;

      // A subagent resumed after a restart: its call waits on it again.
      if (p.name === "agent" && this.runs.has(p.id)) {
        const r = await this.agentCall(s, p.id, p.input, signal);
        if (signal.aborted && !r.background) return true;
        Object.assign(p, { state: "done", result: r.text, isError: r.isError });
        if (r.background) this.o.store.save(s);
        else this.recordOutcome(s, p, r.stopped ? "stopped" : r.isError ? "error" : "done");
        continue;
      }
      if (p.state === "unknown" && p.name === "agent") {
        p.state = "done";
        p.result = `The subagent was cut off (${s.waitingCause ?? this.lastCause}) before it reported. Read back the state of what it was working on before redoing any of it.`;
        p.isError = true;
        this.recordOutcome(s, p, "unknown");
        continue;
      }

      if (p.state === "unknown") {
        if (!editorConnected(this.o.host)) return this.pause(s);
        p.state = "done";
        p.result = verifyUnknown(this.o.host, p.input, s.waitingCause ?? this.lastCause);
        p.isError = true;
        this.recordOutcome(s, p, "unknown");
        continue;
      }

      const needsEditor = p.name === "ue_mcp" && p.input.action === "call";
      // Paused only while a restart or rebuild will bring the editor back; otherwise the call gets the daemon's own answer.
      if (needsEditor && !editorConnected(this.o.host) && this.operating()) return this.pause(s);

      // Waiting for the user leaves the call queued, so a daemon restart asks again rather than guessing.
      const gate = await this.gate(s, p.id, p.name, p.input, signal);
      if (gate && "stopped" in gate) return true;
      if (gate) {
        p.state = "done";
        p.result = gate.declined;
        p.isError = true;
        this.recordOutcome(s, p, "declined");
        continue;
      }

      if (p.name === "skill") {
        const r = skillResult(this.native()?.skills ?? [], p.input.name);
        p.state = "done";
        p.result = r.text;
        p.isError = r.isError;
        this.recordOutcome(s, p, r.isError ? "error" : "done");
        continue;
      }
      p.state = "running";
      this.o.store.save(s);
      const exec = await this.execute(this.hostFor(s.id), p.name, p.input, signal);
      if (signal.aborted) {
        // Stopped while the editor worked: the stop already answered this call.
        this.mergeExec(s, exec, exec.outcome !== "unknown");
        this.o.store.save(s);
        return true;
      }
      if (exec.outcome === "unknown") {
        p.state = "unknown";
        this.mergeExec(s, exec, false);
        this.o.store.save(s);
        return this.pause(s);
      }
      p.state = "done";
      const shown = exec.isError ? exec : this.withInstructions(s.id, p.name, p.input, exec);
      p.result = shown.text;
      if (shown.modelText !== undefined) p.modelResult = shown.modelText;
      p.isError = exec.isError;
      if (exec.images) p.images = exec.images;
      this.mergeExec(s, exec, true);
      this.markSaved(s, exec.saved);
      this.recordOutcome(s, p, exec.outcome);
      if (p.name === "editor_restart" && !exec.isError && !editorConnected(this.o.host) && this.operating()) {
        // The restart returned; wait for the editor to reattach before the model continues.
        // Bounded: the busy tracker ends the wait for it to attach, and that resumes this turn.
        this.flushPending(s);
        return this.pause(s);
      }
    }
    this.flushPending(s);
    return false;
  }

  /**
   * One subagent, on any route: its own conversation with the work tools only
   * (no agent tool), on the subagent model or its helper's. Its steps go into
   * the session's transcript under the agent call, and its final report is
   * its result. Studio's loop runs it over a provider's API; on the Claude
   * sign-in it is a session of its own in that runtime, in a turn host where
   * one can start. `follow`: the main agent's reply, whose Stop it follows
   * until it goes to the background. `attach`: a host it already runs in,
   * taken over after a restart.
   */
  private async runSubagent(s: StoredSession, call: PendingTool, follow: AbortSignal | null, run: AgentRun, attach?: { record: TurnHostRecord; from: number } | { messages: MessageParam[] }): Promise<AgentResult & { detached?: true }> {
    const prompt = call.input.prompt;
    if (typeof prompt !== "string" || !prompt.trim()) return { text: "Invalid input: agent needs prompt", isError: true };
    const n = this.native();
    let helper: NativeHelper | null = null;
    if (typeof call.input.helper === "string") {
      helper = n?.helpers.find((h) => h.name === call.input.helper) ?? null;
      if (!helper) return { text: `No helper named ${call.input.helper}. The project's helpers are: ${(n?.helpers ?? []).map((h) => h.name).join(", ") || "none"}.`, isError: true };
    }
    const own = new AbortController();
    let byTurn = false;
    if (follow) {
      const f = () => {
        byTurn = true;
        own.abort();
      };
      if (follow.aborted) f();
      else {
        follow.addEventListener("abort", f);
        run.detach.push(() => follow.removeEventListener("abort", f));
      }
    }
    this.subagents.set(call.id, () => own.abort());
    this.subagentAbort(call.id).signal.addEventListener("abort", () => own.abort(), { once: true });
    const stopped = (): AgentResult => (byTurn
      ? { text: "Stopped by the user.", isError: true }
      : { text: "The user stopped this subagent before it finished. Do not redo its task unless the user asks.", isError: true, stopped: true });
    // On the Claude sign-in the subagent is a session of that runtime, as is a helper whose model only the sign-in runs.
    // One resumed from its saved conversation goes on where it ran, on Studio's loop.
    const resume = attach && "messages" in attach ? attach.messages : undefined;
    const host = attach && "record" in attach ? attach : undefined;
    const onClaude = !resume && (helper?.run ? helper.run.route === "claude" : !!this.o.subscription?.());
    try {
      return onClaude
        ? await this.claudeSubagent(s, call, prompt, helper, own, run, stopped, host)
        : await this.loopSubagent(s, call, prompt, helper, own.signal, run, stopped, resume);
    } catch (e) {
      if (own.signal.aborted) return stopped();
      return { text: `The subagent failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
    } finally {
      for (const d of run.detach.splice(0)) d();
    }
  }

  /** A subagent as a session of its own on the Claude sign-in's runtime, every tool call coming back to Studio. */
  private async claudeSubagent(s: StoredSession, call: PendingTool, prompt: string, helper: NativeHelper | null, own: AbortController, run: AgentRun, stopped: () => AgentResult, attach?: { record: TurnHostRecord; from: number }): Promise<AgentResult & { detached?: true }> {
    const surface = this.surface();
    const projectDir = this.o.host.projectDir;
    // Its runs are the user's when the user assigned it: the brief says to start one.
    const base = withSurface(subagentSystem(projectDir, run.assigned ? "automatic" : this.runsMode(), this.sdkComposed()), surface);
    // What the user wrote to it before its session started goes with its task.
    const told = this.inbox.drain(call.id);
    const spec: TurnSpec = {
      projectDir,
      model: helper?.run?.model ?? this.subagentModel(),
      effort: (helper?.effort as Effort | null) ?? this.subagentEffort(),
      system: [base, helper ? `You are the project's ${helper.name} helper. Its own instructions follow.\n\n${helper.prompt}` : null].filter(Boolean).join("\n\n"),
      ...(helper?.allowed ? { allowed: [...helper.allowed] } : {}),
      ...(helper?.maxTurns ? { maxTurns: helper.maxTurns } : {}),
      ...this.sdkNative(),
      ...sdkEditor(surface),
      prompt: [{ type: "text", text: prompt }, ...(told.length ? [{ type: "text", text: toSubagent(told) }] : [])],
      resume: null,
    };
    let report = "";
    const cb: HostedCallbacks = {
      signal: own.signal,
      onTokens: (n) => this.count(s, n, call.id),
      onUsage: ({ usage: u, growth, first, model }) => {
        this.spend(s, growth, model, first);
        this.measure(s, call.id, u, model, { sdk: true });
      },
      onSession: () => {},
      onDelta: () => {},
      onAssistant: (_mid, blocks) => {
        for (const b of blocks) {
          if (b.type === "text" && b.text) {
            report = b.text;
            this.addEntry(s, { kind: "assistant", text: b.text, at: now(), parent: call.id });
          }
          if (b.type === "tool_use" && !s.transcript.some((t) => t.kind === "tool" && t.call.id === b.id)) {
            this.addEntry(s, { kind: "tool", call: { id: b.id, name: b.name, input: b.input, outcome: "pending", startedAt: now() }, parent: call.id });
          }
        }
      },
      // Studio's tools record their outcome as they run; the runtime's own (web search) only here.
      onToolResults: (content) => {
        for (const b of content as Array<{ type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }>) {
          if (b.type !== "tool_result" || !b.tool_use_id) continue;
          const entry = s.transcript.find((t) => t.kind === "tool" && t.call.id === b.tool_use_id);
          if (entry?.kind !== "tool" || entry.call.outcome !== "pending") continue;
          const text = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((c: { text?: string }) => c.text ?? "").join("") : "";
          this.recordOutcome(s, { id: b.tool_use_id, name: entry.call.name, input: {}, state: "done", result: text, isError: !!b.is_error }, b.is_error ? "error" : "done");
        }
      },
      runTool: (toolId, name, input, onStart) => this.subscriptionTool(s, own, toolId, name, input, run.assigned, onStart),
      lostTool: (toolId, name, input) => this.lostCall(s, toolId, name, input),
      onSeq: (seq) => this.keepRun(s, run, seq),
      onLive: (live) => {
        if (!live) {
          run.say = null;
          return;
        }
        // The user's message to it is streamed into its own session's input.
        run.say = async (text) => Promise.resolve(live.say([{ type: "text", text: toSubagent([text]) }])).catch(() => false);
        const later = this.inbox.drain(call.id);
        if (later.length) void live.say([{ type: "text", text: toSubagent(later) }]);
      },
      onInputClosed: () => {},
    };
    let result: HostedResult;
    if (attach && this.o.turnHosts) {
      const hosted = await this.o.turnHosts.attach(attach.record, cb, attach.from);
      run.hosted = hosted;
      result = await hosted.done;
    } else {
      result = await this.claudeStep(agentHostKey(s.id, call.id), spec, cb, (hosted) => void (run.hosted = hosted));
    }
    run.say = null;
    if (result === DETACHED) return { text: "", isError: true, detached: true };
    if (own.signal.aborted) return stopped();
    if (result) return { text: `The subagent failed: ${result}`, isError: true };
    return { text: report || "The subagent finished without a report.", isError: false };
  }

  /** A subagent on Studio's own loop: model call, tool calls, model call, over the route's provider (or its helper's). */
  private async loopSubagent(s: StoredSession, call: PendingTool, prompt: string, helper: NativeHelper | null, signal: AbortSignal, run: AgentRun, stopped: () => AgentResult, resume?: MessageParam[]): Promise<AgentResult> {
    const detached = run.assigned;
    const n = this.native();
    const surf = this.surface();
    const projected = new Set(surf.projected.map((p) => p.name));
    // A helper whose file allows ue_mcp gets every projected editor tool in its place.
    const allows = (name: string) => helper!.allowed!.has(name as never) || (projected.has(name) && helper!.allowed!.has("ue_mcp" as never));
    const tools = helper?.allowed ? this.workTools(surf).filter((t) => allows((t as { name: string }).name)) : this.workTools(surf);
    if (n?.skills.length) tools.push(SKILL_TOOL);
    const steps = helper?.maxTurns ?? SUBAGENT_STEPS;
    const base = withSurface(subagentSystem(this.o.host.projectDir, detached ? "automatic" : this.runsMode(), this.composed()), surf);
    const systemText = [base, helper ? `You are the project's ${helper.name} helper. Its own instructions follow.\n\n${helper.prompt}` : null, this.skillLines()].filter(Boolean).join("\n\n");
    const provider = helper?.run ? helper.run.provider : this.o.provider;
    const model = helper?.run?.model ?? this.subagentModel();
    const effort = (helper?.effort as Effort | null) ?? this.subagentEffort();
    const parent = call.id;
    // Its conversation is saved after each step, so a daemon restart resumes it where it was (recoverAgents).
    const messages: MessageParam[] = resume ? structuredClone(resume) : [{ role: "user", content: prompt }];
    const save = () => this.keepRun(s, run, undefined, messages);
    let report = "";
    if (resume) {
      // Calls it was making when the daemon went down: never run again, their outcome unknown.
      const last = messages[messages.length - 1];
      const open = last?.role === "assistant" && Array.isArray(last.content) ? (last.content as ContentBlock[]).filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use") : [];
      if (open.length) {
        const lost = "Studio's daemon restarted while this call was running, so whether it took effect is unknown. Read the current state back before repeating it.";
        for (const u of open) this.recordOutcome(s, { id: u.id, name: u.name, input: {}, state: "done", result: lost, isError: true }, "unknown");
        messages.push({ role: "user", content: open.map((u) => ({ type: "tool_result", tool_use_id: u.id, content: lost, is_error: true })) } as MessageParam);
      }
      for (const t of [...messages].reverse()) {
        if (t.role !== "assistant") continue;
        report = textOf(t.content as ContentBlock[]) || report;
        break;
      }
    }
    save();
    {
      const sys = [{ type: "text" as const, text: systemText }];
      const conv: Conversation = {
        agent: parent,
        messages,
        model,
        overhead: estimateTokens(systemText + JSON.stringify(tools)),
        summarize: async (m, sig) => {
          const t = await provider().run({ sessionId: s.id, model, effort, system: sys, tools, messages: m }, () => {}, sig);
          return { text: textOf(t.content), usage: t.usage };
        },
      };
      let overflowed = false;
      for (let step = 0; step < steps; step++) {
        if (signal.aborted) return stopped();
        // A subagent's own conversation compacts the same way as the main one.
        await this.autoCompact(s, conv, signal);
        if (signal.aborted) return stopped();
        // What the user sent it from its thread joins its conversation before its next model call.
        const told = this.inbox.drain(parent);
        if (told.length) addUserText(messages, toSubagent(told));
        let turn: ModelTurn;
        try {
          turn = await provider().run({ sessionId: s.id, model, effort, system: sys, tools, messages }, () => {}, signal);
        } catch (e) {
          if (signal.aborted || overflowed || !isContextOverflow(e)) throw e;
          overflowed = true;
          await this.compactConversation(s, conv, "overflow", Math.max(this.currentContext(s, conv), this.windowFor(model)), signal);
          continue;
        }
        messages.push({ role: "assistant", content: turn.content } as MessageParam);
        save();
        this.count(s, usageTokens(turn.usage), parent);
        this.spend(s, turn.usage, model);
        this.measure(s, parent, turn.usage, model, { messages: messages.length });
        this.recordSearches(s, turn.searches, parent);
        const text = turn.content.filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text").map((b) => b.text).join("");
        if (text) {
          report = text;
          this.addEntry(s, { kind: "assistant", text, at: now(), parent });
        }
        if (turn.stopReason === "refusal") return { text: `The subagent's model declined: ${turn.refusal ?? "no reason given"}`, isError: true };
        if (turn.stopReason === "pause_turn") continue;
        const uses = turn.content.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");
        if (turn.stopReason !== "tool_use" || uses.length === 0) {
          // A message the user sent while it wrote its report: it carries on to act on it rather than end.
          if (this.inbox.has(parent)) continue;
          return { text: report || "The subagent finished without a report.", isError: false };
        }
        const results: Array<{ type: "tool_result"; tool_use_id: string; content: ReturnType<typeof toolResultContent>; is_error?: boolean }> = [];
        for (const raw of uses) {
          const c = surf.canon(raw.name, (raw.input ?? {}) as Record<string, unknown>);
          const u = { ...raw, name: c.name };
          const input = c.input;
          this.addEntry(s, { kind: "tool", call: { id: u.id, name: u.name, input, outcome: "pending", startedAt: now() }, parent });
          if (u.name === "skill") {
            const r = skillResult(n?.skills ?? [], input.name);
            this.recordOutcome(s, { id: u.id, name: u.name, input, state: "done", result: r.text, isError: r.isError }, r.isError ? "error" : "done");
            results.push({ type: "tool_result", tool_use_id: u.id, content: r.text, is_error: r.isError || undefined });
            continue;
          }
          // A tool the helper's file does not allow is refused, never run.
          if (helper?.allowed && !helper.allowed.has(u.name as never)) {
            const text = `The ${helper.name} helper's file does not allow ${u.name}.`;
            this.recordOutcome(s, { id: u.id, name: u.name, input, state: "done", result: text, isError: true }, "error");
            results.push({ type: "tool_result", tool_use_id: u.id, content: text, is_error: true });
            continue;
          }
          // One working while the main agent is not replying waits for the editor without making the session wait.
          if (u.name === "ue_mcp" && input.action === "call") await this.waitForEditor(s, signal, Infinity, detached || !this.replying.has(s.id));
          if (signal.aborted) return stopped();
          const gate = await this.gate(s, u.id, u.name, input, signal);
          if (gate && "stopped" in gate) return stopped();
          if (gate) {
            this.recordOutcome(s, { id: u.id, name: u.name, input, state: "done", result: gate.declined, isError: true }, "declined");
            results.push({ type: "tool_result", tool_use_id: u.id, content: gate.declined, is_error: true });
            continue;
          }
          const running = this.execute(this.hostFor(s.id, detached), u.name, input, signal);
          // A stop lets the call go at once; what it does after is still tracked for the crash report.
          void running.then((e) => signal.aborted && this.mergeExec(s, e, e.outcome !== "unknown"), () => {});
          const exec = await unlessAborted(running, signal);
          if (!exec || signal.aborted) return stopped();
          this.mergeExec(s, exec, exec.outcome !== "unknown");
          this.markSaved(s, exec.saved);
          const shown = exec.isError ? exec : this.withInstructions(parent, u.name, input, exec);
          this.recordOutcome(s, { id: u.id, name: u.name, input, state: "done", result: shown.text, isError: exec.isError, ...(exec.images ? { images: exec.images } : {}) }, exec.outcome);
          results.push({ type: "tool_result", tool_use_id: u.id, content: toolResultContent(forModel(shown), exec.images), is_error: exec.isError || undefined });
        }
        messages.push({ role: "user", content: results } as MessageParam);
        save();
      }
      return { text: `The subagent stopped after ${steps} steps without finishing. Its last report: ${report || "none"}`, isError: true };
    }
  }

  private pause(s: StoredSession): boolean {
    this.setStatus(s, "waiting", this.causeNow());
    return true;
  }

  /**
   * Mark an agent call as waiting to start, with how the user stops it while
   * it waits, or clear the mark (null) once it starts.
   */
  private markQueued(s: StoredSession, callId: string, cancel: (() => void) | null): void {
    const entry = [...s.transcript].reverse().find((t) => t.kind === "tool" && t.call.id === callId);
    if (cancel) this.subagents.set(callId, cancel);
    // The SDK can hold a call before Studio has read the message that holds its block: the entry takes the mark when it arrives.
    if (entry?.kind !== "tool") {
      if (cancel) this.queuedEarly.add(callId);
      else if (this.queuedEarly.delete(callId)) this.subagents.delete(callId);
      return;
    }
    if (!cancel && entry.call.queued) this.subagents.delete(callId);
    if (!!entry.call.queued === !!cancel) return;
    if (cancel) entry.call.queued = true;
    else delete entry.call.queued;
    this.o.store.save(s);
    this.o.host.events.publish("tool.queued", { sessionId: s.id, toolUseId: callId, queued: !!cancel });
  }

  private recordOutcome(s: StoredSession, p: PendingTool, outcome: "done" | "error" | "unknown" | "stopped" | "declined"): void {
    const entry = [...s.transcript].reverse().find((t) => t.kind === "tool" && t.call.id === p.id);
    if (entry && entry.kind === "tool") {
      entry.call.outcome = outcome === "done" && (p.isError || refused(p.result)) ? "error" : outcome;
      delete entry.call.queued;
      entry.call.result = p.result;
      entry.call.endedAt = now();
      if (p.images?.length) entry.call.images = this.keepImages(s.id, p.images);
    }
    this.o.store.save(s);
    this.o.host.events.publish("tool.finished", { sessionId: s.id, toolUseId: p.id, outcome: entry && entry.kind === "tool" ? entry.call.outcome : outcome });
    if (entry?.kind === "tool" && !entry.parent && this.runs.size > 0) this.refreshFree(s);
  }

  /** The images a call showed the model, kept as the session's files so the panel can show them. */
  private keepImages(sessionId: string, images: NonNullable<PendingTool["images"]>): Attachment[] {
    const kept: Attachment[] = [];
    for (const img of images) {
      try {
        const { path: _path, ...a } = this.files.keep(sessionId, keptName(img), img.mediaType, Buffer.from(img.data, "base64"));
        kept.push(a);
      } catch (e) {
        this.o.host.log.warn("could not keep a tool's image for the panel", e);
      }
    }
    return kept;
  }

  /** Give the model every answered call in one message, with any notes the reattach produced. */
  private flushPending(s: StoredSession): void {
    if (!s.pending || s.pending.some((p) => p.state !== "done")) return;
    if (s.crashed) this.reconcileCrash(s);
    const content: Array<
      | { type: "tool_result"; tool_use_id: string; content: ReturnType<typeof toolResultContent>; is_error?: boolean }
      | { type: "text"; text: string }
    > = s.pending.map((p) => ({ type: "tool_result", tool_use_id: p.id, content: toolResultContent(p.modelResult ?? p.result ?? "", p.images), is_error: p.isError || undefined }));
    for (const note of s.notes.splice(0)) content.push({ type: "text", text: `[Studio] ${note}` });
    s.messages.push({ role: "user", content } as MessageParam);
    s.pending = null;
    this.o.store.save(s);
  }

  /** A call's changes: what the session touched, and the turn's count of changing calls with the targets they named. */
  private mergeExec(s: StoredSession, exec: ToolExecution, known: boolean): void {
    this.mergeTouched(s, exec.touched, known);
    if (exec.changed || exec.saved.length > 0) this.readDirty();
    if (!exec.changed || !s.turn) return;
    s.turn.mutations++;
    for (const t of exec.touched) {
      if (!s.turn.targets.some((x) => x.kind === t.kind && x.path === t.path)) s.turn.targets.push({ ...t });
    }
  }

  private mergeTouched(s: StoredSession, items: { kind: "asset" | "actor"; path: string; saved: boolean }[], known: boolean): void {
    for (const t of items) {
      const existing = s.touched.find((x) => x.kind === t.kind && x.path === t.path);
      if (existing) existing.saved = known ? t.saved : existing.saved;
      else s.touched.push({ ...t, saved: known ? t.saved : false });
    }
  }

  private markSaved(s: StoredSession, paths: string[]): void {
    if (paths.length === 0) return;
    for (const t of s.touched) {
      if (paths.includes("*") || paths.includes(t.path)) t.saved = true;
    }
  }

  /**
   * Ask the editor what is unsaved, in the background, so a crash can name it.
   * Reads coalesce: changes while one is in flight cause one more read after it.
   */
  private readDirty(): void {
    if (this.dirtyRead) {
      this.dirtyRead.again = true;
      return;
    }
    const read = { again: false };
    this.dirtyRead = read;
    void Promise.resolve()
      .then(() => this.o.host.callAction("editor", "list_dirty_packages", {}))
      .then((r) => {
        const body = r.isError ? null : parseDirty(r.content.map((c) => c.text ?? "").join(""));
        if (body) this.dirty = body;
      })
      .catch(() => undefined)
      .finally(() => {
        this.dirtyRead = null;
        if (read.again) this.readDirty();
      });
  }

  /** After a crash: list what the session changed and never saved, the packages unsaved in the editor, and saved assets that are not on disk. */
  private reconcileCrash(s: StoredSession): void {
    s.crashed = false;
    const lost: string[] = this.lostPackages.map((p) => `package ${p} (unsaved in the editor)`);
    for (const t of s.touched) {
      if (!t.saved) {
        lost.push(`${t.kind} ${t.path} (not saved)`);
        continue;
      }
      if (t.kind === "asset") {
        const file = packageFile(this.o.host.projectDir, t.path);
        if (file && !fs.existsSync(file)) lost.push(`asset ${t.path} (saved, but not on disk)`);
      }
    }
    s.touched = s.touched.filter((t) => t.saved);
    const note = lost.length === 0
      ? "The editor crashed. Every change this session made had been saved."
      : `The editor crashed. These changes are gone and must be redone if still wanted:\n- ${lost.join("\n- ")}`;
    s.notes.push(note);
    this.addEntry(s, { kind: "note", text: note, at: now() });
  }
}

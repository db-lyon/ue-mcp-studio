/**
 * Run a turn on the user's Claude subscription through the Claude Agent SDK.
 * The SDK's own runtime binary runs it on the user's Claude Code login and
 * home (claude-auth.ts). The SDK owns the model loop; Studio's tools
 * are an in-process MCP server whose handlers run the same executor as the API path.
 */
import * as fs from "node:fs";
import { createSdkMcpServer, query, tool, type HookCallback, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Effort, SubagentMode } from "@ue-mcp-studio/shared";
import { z } from "zod";
import type { ContentBlock } from "./providers.js";
import { OMIT_DESCRIPTION, SELECT_DESCRIPTION, UE_MCP_DESCRIPTION, forModel, type ToolExecution } from "./tools.js";
import { messagesUsage, usageGrowth, usageTokens, type TokenUsage } from "./usage.js";
import { ensureRuntime } from "./runtime.js";
import { claudeEnv, claudeHome, claudeLogin, refreshClaudeLogin } from "./claude-auth.js";
import { LOCAL_TOOL_NAMES, localToolDefinitions } from "./local-tools.js";
import { QUEUED_STOP, SubagentSlots } from "./subagent-slots.js";

const SERVER = "studio";
const PREFIX = `mcp__${SERVER}__`;
export const STUDIO_TOOLS = ["ue_mcp", "editor_restart", ...LOCAL_TOOL_NAMES].map((n) => `${PREFIX}${n}`);

/** A tool list with ue_mcp stood in for by the projected editor tools, when the turn has them. */
export function withEditor(list: string[], editor: string[] | undefined): string[] {
  if (!editor?.length) return list;
  return list.flatMap((n) => (n === `${PREFIX}ue_mcp` ? editor.map((e) => `${PREFIX}${e}`) : [n]));
}

/**
 * A projected tool's JSON Schema as the zod shape the SDK's tool registry
 * takes: each property typed as far as its schema says, the rest unknown.
 */
export function zodShape(schema: Record<string, unknown>): Record<string, z.ZodType> {
  const props = (schema.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const of = (p: Record<string, unknown>): z.ZodType => {
    if (Array.isArray(p.enum) && p.enum.length && p.enum.every((v) => typeof v === "string")) return z.enum(p.enum as [string, ...string[]]);
    if (p.type === "string") return z.string();
    if (p.type === "number" || p.type === "integer") return z.number();
    if (p.type === "boolean") return z.boolean();
    if (p.type === "array") return z.array(z.unknown());
    if (p.type === "object") return z.record(z.string(), z.unknown());
    return z.unknown();
  };
  return Object.fromEntries(Object.entries(props).map(([k, p]) => {
    let t = of(p);
    if (typeof p.description === "string") t = t.describe(p.description);
    return [k, required.has(k) ? t : t.optional()];
  }));
}
/** The SDK's subagent tool, and the subagent Studio defines for it. */
const AGENT = "Agent";
const WORKER = "editor-worker";
/** The SDK's web search, which runs on Anthropic's side: the one built-in tool besides Agent. */
const SEARCH = "WebSearch";
/** The SDK's skill tool, which an explicit tool list must name for the project's skills to load. */
const SKILL = "Skill";

/** Claude Code's built-in names a skill or subagent may use, each run by Studio's own tool through the SDK's toolAliases. */
export const BUILTIN_TO_STUDIO: Record<string, string> = { Bash: "shell", Read: "read_file", Write: "write_file", Edit: "edit_file", Glob: "glob", Grep: "grep", WebFetch: "web_fetch" };

/** Tool names as Studio's transcript writes them: its own tools unprefixed, aliased built-ins as the tool that runs them, the SDK's subagent tool as agent. */
export const studioName = (name: string): string =>
  name.startsWith(PREFIX) ? name.slice(PREFIX.length)
    : name === AGENT || name === "Task" ? "agent"
    : name === SEARCH ? "web_search"
    : BUILTIN_TO_STUDIO[name] ?? name;

/** A built-in's arguments in the shape Studio's tool takes: file_path as path, -i as ignore_case. */
export function studioArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out = { ...args };
  if (out.path === undefined && typeof out.file_path === "string") out.path = out.file_path;
  delete out.file_path;
  if (out.ignore_case === undefined && typeof out["-i"] === "boolean") out.ignore_case = out["-i"];
  delete out["-i"];
  return out;
}

/** Studio's machine tools in the SDK's form: the same names and descriptions as the API path, checked by zod. */
function localSdkTools(handler: (name: string) => (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; isError: boolean }>) {
  const desc = Object.fromEntries(localToolDefinitions().map((t) => [(t as { name: string }).name, (t as { description?: string }).description ?? ""]));
  return [
    tool("shell", desc.shell, { command: z.string(), timeout: z.number().optional(), description: z.string().optional() }, handler("shell")),
    // file_path and -i: the built-in names a skill or subagent may use reach these through toolAliases with their own argument names.
    tool("read_file", desc.read_file, { path: z.string().optional(), file_path: z.string().optional(), offset: z.number().optional(), limit: z.number().optional() }, handler("read_file")),
    tool("write_file", desc.write_file, { path: z.string().optional(), file_path: z.string().optional(), content: z.string() }, handler("write_file")),
    tool("edit_file", desc.edit_file, { path: z.string().optional(), file_path: z.string().optional(), old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional() }, handler("edit_file")),
    tool("glob", desc.glob, { pattern: z.string(), path: z.string().optional() }, handler("glob")),
    tool("grep", desc.grep, { pattern: z.string(), path: z.string().optional(), glob: z.string().optional(), ignore_case: z.boolean().optional(), "-i": z.boolean().optional() }, handler("grep")),
    tool("web_fetch", desc.web_fetch, { url: z.string(), max_length: z.number().optional() }, handler("web_fetch")),
  ];
}

/** The runtime, fetched on first use; an error message when it cannot be had. */
const runtime = (): Promise<{ exe: string } | { error: string }> =>
  ensureRuntime().then((exe) => ({ exe }), (e: Error) => ({ error: e.message }));

export interface SubscriptionTurn {
  projectDir: string;
  model: string;
  /** The SDK lowers a level the model does not have to its nearest one. */
  effort: Effort;
  system: string;
  /** What each subagent the model starts is told. */
  subagentSystem: string;
  /** Whether the model may start subagents, how many run at once, and what they run on. */
  subagents: { mode: SubagentMode; perTurn: number; model: string; effort: Effort };
  /**
   * The project's own Claude Code files: the setting sources the SDK reads
   * them from, the project's and the user's subagents (passed programmatically
   * so their tools map onto Studio's), and whether there are skills. Absent:
   * the SDK reads no files, as while "Read the project's own files" is off.
   */
  native?: { settingSources: Array<"user" | "project" | "local">; agents: Record<string, NativeAgentDefinition>; skills: boolean };
  /** The user's message as content blocks: text, and any images or documents attached. */
  prompt: unknown[];
  /** The SDK session to continue, from this Studio session's last turn. */
  resume: string | null;
  signal: AbortSignal;
  onSession: (id: string) => void;
  onDelta: (text: string) => void;
  /**
   * One assistant message, merged by message id when the SDK splits it per
   * block. `parent` is the agent call a subagent's message belongs to.
   */
  onAssistant: (messageId: string, content: ContentBlock[], parent: string | null) => void;
  onToolResults: (content: unknown[], parent: string | null) => void;
  /** A subagent's lifecycle, by the agent call that started it. A background one reports here, not in its tool result. */
  /** A subagent that can be stopped on its own, by its agent call id; null once it has finished. */
  onStopper: (callId: string, stop: (() => Promise<void>) | null) => void;
  onTask: (toolUseId: string, status: "started" | "completed" | "failed" | "stopped", detail: { background?: boolean; summary?: string }) => void;
  /**
   * A subagent past the concurrency limit is waiting to start, with how the
   * user stops it while it waits; null once it starts.
   */
  onQueued?: (toolUseId: string, cancel: (() => void) | null) => void;
  /**
   * The main agent and its background subagents, while the turn runs:
   * `background` is how many background subagents are still working,
   * `say` hands the main agent the user's next message now (false once the
   * turn's input has closed), and `interrupt` stops only the main agent's
   * current reply, leaving the background subagents running. Null once the
   * turn has ended.
   */
  onLive?: (live: LiveTurn | null) => void;
  /** The turn's input closed while it still runs, and why: a message after this can only queue. */
  onInputClosed?: (why: string) => void;
  /** The main agent finished its reply while background subagents still run (true), or is working again (false). */
  onFree?: (free: boolean) => void;
  /**
   * Run one tool call the model asked for, by its tool_use id. `onStart` is
   * told when the call gets past its approval and starts running, which a turn
   * host keeps so a daemon restart never runs it twice.
   */
  runTool: (id: string, name: string, input: Record<string, unknown>, onStart?: () => void) => Promise<ToolExecution>;
  /** Tokens the turn spent since the last report, as each model message arrives; `parent` is the agent call of a subagent's message. */
  onTokens?: (tokens: number, parent: string | null) => void;
  /**
   * A model message's usage as the runtime reports it, again as it grows:
   * `usage` is the message's whole request, `growth` what is new since the
   * last report, `first` whether this is the request's first report.
   */
  onUsage?: (u: { usage: TokenUsage; growth: TokenUsage; first: boolean; model: string; parent: string | null }) => void;
  /**
   * The runtime compacting the main conversation: started, ended (with the
   * context before and after) or failed, and the summary it wrote.
   */
  onCompaction?: (e: { started?: boolean; trigger?: "auto" | "manual"; before?: number; after?: number; summary?: string; failed?: string }) => void;
  /** The main conversation's window as the runtime measures it, and where it compacts. */
  onContextWindow?: (w: { window: number; compactAt?: number }) => void;
  /**
   * ue-mcp's projected tools in place of ue_mcp, on Lean and Full, with how a
   * call to one reads as the ue_mcp call it is. Absent on Micro.
   */
  editor?: {
    tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown>; category?: string | null }>;
    canon: (name: string, input: Record<string, unknown>) => { name: string; input: Record<string, unknown> };
  };
}

/** A project subagent as the SDK takes it, its tools already in Studio's names. */
export interface NativeAgentDefinition {
  description: string;
  prompt: string;
  tools?: string[];
  model?: string;
  effort?: Effort;
  maxTurns?: number;
  skills?: string[];
  background?: boolean;
}

/**
 * How the SDK route queues subagents: the slots the turn shares, and what the
 * runner is told while one waits.
 */
export interface AgentQueue {
  slots: SubagentSlots;
  onQueued?: (toolUseId: string, cancel: (() => void) | null) => void;
}

/** A day, in seconds: a queued agent call waits as long as the running ones take. */
const QUEUE_HOOK_TIMEOUT = 24 * 60 * 60;

/**
 * The SDK options for subagents: none at all when they are off, the subagent
 * tool disallowed, else the subagent Studio defines, on its own model and
 * effort, with hooks that hold an agent call past the concurrency limit until
 * a running one finishes (never, with no limit).
 */
export function subagentOptions(s: SubscriptionTurn["subagents"], subagentSystem: string, native?: SubscriptionTurn["native"], editor?: string[], queue: AgentQueue = { slots: new SubagentSlots(s.perTurn) }) {
  const studio = withEditor(STUDIO_TOOLS, editor);
  const projectAgents = Object.fromEntries(Object.entries(native ? native.agents : {}).map(([n, a]) => [n, a.tools ? { ...a, tools: withEditor(a.tools, editor) } : a]));
  const skill = native?.skills ? [SKILL] : [];
  // Off, the SDK's subagent tool is withheld under both its names, so the project's .claude/agents files cannot run either.
  if (s.mode === "off") return { tools: [SEARCH, ...skill], allowedTools: [...studio, SEARCH, ...skill], disallowedTools: [AGENT, "Task"] };
  const { slots } = queue;
  const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: reason } });
  // Before an agent call starts: it waits here while the limit is reached, and starts when a slot frees.
  const hold: HookCallback = async (input, toolUseId, { signal }) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const id = input.tool_use_id ?? toolUseId ?? "";
    let stoppedHere = false;
    const onAbort = () => slots.cancel(id);
    signal.addEventListener("abort", onAbort, { once: true });
    const started = await slots.acquire(id, () => queue.onQueued?.(id, () => {
      stoppedHere = true;
      slots.cancel(id);
    }));
    signal.removeEventListener("abort", onAbort);
    if (started) {
      queue.onQueued?.(id, null);
      return {};
    }
    return deny(stoppedHere ? QUEUED_STOP : "Stopped by the user.");
  };
  // A foreground agent call returns when its subagent ends; a background one's slot frees on its task notification.
  const free: HookCallback = async (input, toolUseId) => {
    if (input.hook_event_name === "PostToolUse") {
      const r = input.tool_response as { status?: string } | null;
      if (r?.status !== "async_launched") slots.release(input.tool_use_id ?? toolUseId ?? "");
    } else if (input.hook_event_name === "PostToolUseFailure") slots.release(input.tool_use_id ?? toolUseId ?? "");
    return {};
  };
  return {
    // Built-ins: the subagent tool, and web search, which runs on Anthropic's side and touches nothing here.
    // Everything else goes through Studio's tools, so one approval model and one transcript cover every route.
    tools: [AGENT, SEARCH, ...skill],
    agents: {
      [WORKER]: {
        description: "Works on one self-contained task in the Unreal Editor through ue-mcp, or on the project's files, and reports what it changed.",
        prompt: subagentSystem,
        model: s.model,
        effort: s.effort,
        tools: [...studio, SEARCH],
      },
      // The project's own subagents, as their files say, each call still through Studio's tools.
      ...Object.fromEntries(Object.entries(projectAgents).map(([name, a]) => [name, { ...a, prompt: `${subagentSystem}\n\n${a.prompt}` }])),
    },
    allowedTools: [...studio, AGENT, SEARCH, ...skill],
    hooks: {
      PreToolUse: [{ matcher: AGENT, hooks: [hold], timeout: QUEUE_HOOK_TIMEOUT }],
      PostToolUse: [{ matcher: AGENT, hooks: [free] }],
      PostToolUseFailure: [{ matcher: AGENT, hooks: [free] }],
    },
  };
}

/** A running Claude sign-in turn, as the runner steers it while subagents work. */
export interface LiveTurn {
  /** Background tasks still working. */
  background: () => number;
  /** The main agent ended its reply and has not started another. */
  free: () => boolean;
  /** The turn still takes messages. */
  open: () => boolean;
  /** Hand the main agent a message now; false once the input has closed. A turn in a host answers asynchronously. */
  say: (blocks: unknown[]) => boolean | Promise<boolean>;
  /** Move every foreground subagent and command to the background, so they outlive an interrupt. */
  keep: () => Promise<boolean>;
  /** Stop only the main agent's current reply. */
  interrupt: () => Promise<void>;
}

const userMessage = (blocks: unknown[], session: string): SDKUserMessage =>
  ({ type: "user", message: { role: "user", content: blocks }, parent_tool_use_id: null, session_id: session }) as unknown as SDKUserMessage;

/**
 * The turn's input, streamed: its first message, then each message the user
 * sends while only background subagents run. The binary keeps working while
 * it is open; closing it lets the binary finish what it has and exit.
 */
export function inputChannel(first: SDKUserMessage) {
  const pending: SDKUserMessage[] = [first];
  let wake: (() => void) | null = null;
  let closed = false;
  return {
    get closed() { return closed; },
    push(m: SDKUserMessage): boolean {
      if (closed) return false;
      pending.push(m);
      wake?.();
      return true;
    },
    close(): void {
      closed = true;
      wake?.();
    },
    messages: (async function* () {
      for (;;) {
        while (pending.length) yield pending.shift()!;
        if (closed) return;
        await new Promise<void>((r) => { wake = r; });
        wake = null;
      }
    })(),
  };
}

/**
 * How long the main agent may sit idle after the last background task ends before the input closes.
 * The binary answers a task's report with a main reply, which cancels this; it is only a backstop.
 */
const LAST_TASK_GRACE_MS = 120_000;

/** JSON with object keys sorted, so the same input matches whatever order its keys came in. */
const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

/**
 * Which tool_use block a call into Studio's tools answers. The binary sends
 * the block before it makes the call, but the call can reach the in-process
 * server before this side has read the message, more so with subagents
 * running at once, so a call waits briefly for its block. It matches by name
 * and input; by name alone only after that wait, and never another tool's
 * block, so a result cannot land on the wrong call.
 */
export class CallMatcher {
  private readonly waiting: Array<{ id: string; name: string; key: string }> = [];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly waitMs = 3000) {}

  add(id: string, name: string, input: unknown): void {
    this.waiting.push({ id, name, key: canonical(input ?? {}) });
    for (const l of [...this.listeners]) l();
  }

  async take(name: string, args: unknown): Promise<string> {
    const key = canonical(args ?? {});
    const exact = () => this.waiting.findIndex((w) => w.name === name && w.key === key);
    let i = exact();
    if (i < 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, this.waitMs);
        const check = () => {
          if (exact() >= 0) done();
        };
        function done() {
          clearTimeout(timer);
          listeners.delete(check);
          resolve();
        }
        const listeners = this.listeners;
        listeners.add(check);
      });
      i = exact();
      if (i < 0) i = this.waiting.findIndex((w) => w.name === name);
    }
    return i >= 0 ? this.waiting.splice(i, 1)[0].id : `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }
}

/** Why the Claude runtime ended a turn, from its result subtype. */
export function endedText(subtype: string): string {
  if (subtype === "error_max_turns") return "The turn ended: it reached its step limit.";
  if (subtype === "error_during_execution") return "The turn ended: the Claude runtime hit an error.";
  if (subtype === "error_max_budget_usd") return "The turn ended: it reached its spending limit.";
  return `The turn ended: ${subtype}`;
}

/** How long a stopped turn's binary gets to end the turn itself before it is closed. */
const STOP_GRACE_MS = 1500;

/** Run one turn to the end. Resolves with an error message when the turn failed. */
export async function runSubscriptionTurn(t: SubscriptionTurn): Promise<string | null> {
  if (!(claudeLogin() ?? (await refreshClaudeLogin()))) return "Sign in to Claude Code first: run `claude /login` in a terminal.";
  const rt = await runtime();
  if ("error" in rt) return rt.error;
  const exe = rt.exe;
  fs.mkdirSync(claudeHome(), { recursive: true });

  // The SDK does not hand the tool_use id to a handler: match the call to the block the model sent.
  const calls = new CallMatcher();
  const handler = (registered: string) => async (raw: Record<string, unknown>) => {
    // A projected category call is matched and run as the ue_mcp call it is.
    const { name, input: args } = t.editor ? t.editor.canon(registered, raw) : { name: registered, input: raw };
    const exec = await t.runTool(await calls.take(name, args), name, studioArgs(args));
    // Images go as MCP image content, which the SDK hands the model as images.
    const images = (exec.images ?? []).map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mediaType }));
    return { content: [{ type: "text" as const, text: forModel(exec) }, ...images], isError: exec.isError };
  };

  const server = createSdkMcpServer({
    name: SERVER,
    alwaysLoad: true,
    tools: [
      ...(t.editor ? t.editor.tools.map((p) => tool(p.name, p.description, zodShape(p.inputSchema), handler(p.name))) : []),
      ...(t.editor ? [] : [tool(
        "ue_mcp",
        UE_MCP_DESCRIPTION,
        {
          action: z.enum(["search", "describe", "call"]),
          query: z.string().optional(),
          category: z.string().optional(),
          method: z.string().optional(),
          args: z.record(z.string(), z.unknown()).optional(),
          select: z.array(z.string()).optional().describe(SELECT_DESCRIPTION),
          omit: z.array(z.string()).optional().describe(OMIT_DESCRIPTION),
        },
        handler("ue_mcp"),
      )]),
      tool(
        "editor_restart",
        "Restart the Unreal Editor, or stop it, rebuild the project's C++ and start it again (rebuild). Unsaved work is lost: save first.",
        { operation: z.enum(["restart", "rebuild"]), reason: z.string() },
        handler("editor_restart"),
      ),
      ...localSdkTools(handler),
    ],
  });

  const abort = new AbortController();
  const day = String(24 * 60 * 60 * 1000);
  // A command or a file change can wait on the user for as long as they take: no MCP call timeout cuts it off.
  // Background subagents run past the main turn's result. The SDK closes the binary's input, and with it
  // Studio's tools, once its background ceiling (10 minutes by default) has passed since that result, so a
  // subagent still working then gets "interrupted before a result was received" on every call (#1384). The
  // turn ends when the binary reports it idle or on Stop; the ceiling is only a backstop.
  const env = claudeEnv({ MCP_TOOL_TIMEOUT: day, CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: day });

  // The turn's subagents share these slots; Stop cancels the ones still waiting.
  const slots = new SubagentSlots(t.subagents.perTurn);
  if (t.signal.aborted) slots.cancelAll();
  else t.signal.addEventListener("abort", () => slots.cancelAll(), { once: true });

  const sub = subagentOptions(t.subagents, t.subagentSystem, t.native, t.editor?.tools.map((p) => p.name), { slots, onQueued: t.onQueued });
  // The summary a compaction of the main conversation wrote, which only this hook hands over.
  const compacted: HookCallback = async (input) => {
    if (input.hook_event_name === "PostCompact" && !input.agent_id) t.onCompaction?.({ summary: input.compact_summary });
    return {};
  };
  const hooks = { ...("hooks" in sub ? sub.hooks : {}), PostCompact: [{ hooks: [compacted] }] };

  const input = inputChannel(userMessage(t.prompt, t.resume ?? ""));
  let sessionId = t.resume ?? "";
  // Background subagents still working, by agent call id, from the task_* edges.
  const background = new Set<string>();
  // The binary's own list of live background tasks (background_tasks_changed), by task id: the level, which a missed edge cannot wedge.
  const level = new Set<string>();
  const toolOfTask = new Map<string, string>();
  const bg = () => Math.max(background.size, level.size);
  // The main agent ended its reply and has not started another.
  let free = false;
  // A Stop that interrupted only the main agent: the result it ends with is not the turn's error.
  let interrupted = false;
  let grace: ReturnType<typeof setTimeout> | null = null;
  const setFree = (v: boolean) => {
    // The main agent working again: the idle fallback no longer applies.
    if (!v && grace) { clearTimeout(grace); grace = null; }
    if (free === v) return;
    free = v;
    t.onFree?.(v);
  };
  const close = (why: string) => {
    if (input.closed) return;
    input.close();
    t.onInputClosed?.(why);
  };
  const closeIfDone = () => {
    if (grace) { clearTimeout(grace); grace = null; }
    if (free && bg() === 0) close("the main agent stayed idle after its last background task ended");
  };
  t.signal.addEventListener("abort", () => input.close(), { once: true });

  try {
    const q = query({
      prompt: input.messages,
      options: {
        model: t.model,
        effort: t.effort,
        systemPrompt: t.system,
        ...sub,
        hooks,
        mcpServers: { [SERVER]: server },
        // Only Studio's server: a project's .mcp.json (often its own ue-mcp) would show tools no call may use.
        strictMcpConfig: true,
        // The project's own files load as Claude Code loads them; none while "Read the project's own files" is off.
        settingSources: t.native?.settingSources ?? [],
        ...(t.native ? { toolAliases: Object.fromEntries(Object.entries(BUILTIN_TO_STUDIO).map(([b, s]) => [b, `${PREFIX}${s}`])) } : {}),
        includePartialMessages: true,
        resume: t.resume ?? undefined,
        cwd: t.projectDir,
        pathToClaudeCodeExecutable: exe,
        abortController: abort,
        env,
      },
    });
    // Stop ends the turn here and now. Aborting alone closes the binary's input but leaves it
    // running for seconds on Windows, still calling tools it can no longer reach and still
    // talking: interrupt it first so it ends the turn, and relay nothing it says after.
    const stopped = new Promise<null>((resolve) => {
      const onStop = () => {
        resolve(null);
        void Promise.race([q.interrupt().catch(() => undefined), new Promise((r) => setTimeout(r, STOP_GRACE_MS))]).finally(() => abort.abort());
      };
      if (t.signal.aborted) onStop();
      else t.signal.addEventListener("abort", onStop, { once: true });
    });
    t.onLive?.({
      background: bg,
      free: () => free,
      open: () => !input.closed,
      say: (blocks) => {
        if (!input.push(userMessage(blocks, sessionId))) return false;
        setFree(false);
        return true;
      },
      // Ctrl+B: a foreground subagent or command the main agent is waiting on moves to the background and keeps running.
      keep: async () => {
        if (typeof q.backgroundTasks !== "function") return false;
        return q.backgroundTasks().catch(() => false);
      },
      interrupt: async () => {
        if (free) return;
        interrupted = true;
        await q.interrupt().catch(() => undefined);
      },
    });
    const messages = (q as AsyncIterable<SDKMessage>)[Symbol.asyncIterator]();
    let error: string | null = null;
    // The SDK repeats a message per content block with its usage so far: count each message's growth once.
    const spent = new Map<string, number>();
    const reported = new Map<string, TokenUsage>();
    // The window the runtime measures against, asked once per turn after its first answer.
    let askedWindow = false;
    const askWindow = () => {
      if (askedWindow || !t.onContextWindow) return;
      askedWindow = true;
      const timeout = new Promise<null>((r) => setTimeout(() => r(null), 5000));
      // A runtime without the control request answers nothing here, and the turn goes on.
      if (typeof q.getContextUsage !== "function") return;
      void Promise.race([q.getContextUsage({ detail: "summary" }).catch(() => null), timeout]).then((u) => {
        if (!u || !(u.maxTokens > 0) || t.signal.aborted) return;
        const buffer = u.categories.filter((c) => c.kind === "buffer").reduce((n, c) => n + c.tokens, 0);
        t.onContextWindow?.({ window: u.maxTokens, ...(buffer > 0 && buffer < u.maxTokens ? { compactAt: u.maxTokens - buffer } : {}) });
      }, () => {});
    };
    for (;;) {
      const next = await Promise.race([messages.next(), stopped]);
      if (!next || next.done || t.signal.aborted) break;
      const m = next.value;
      // The main agent speaking again, after a background subagent's report or the user's message.
      if (free && (m.type === "assistant" || m.type === "stream_event") && !m.parent_tool_use_id) setFree(false);
      if (m.type === "system" && "subtype" in m && m.subtype === "init") {
        sessionId = m.session_id;
        t.onSession(m.session_id);
      }
      else if (m.type === "system" && "subtype" in m && m.subtype === "status") {
        if (m.status === "compacting") t.onCompaction?.({ started: true });
        else if (m.compact_result === "failed") t.onCompaction?.({ failed: m.compact_error || "The conversation could not be compacted." });
      } else if (m.type === "system" && "subtype" in m && m.subtype === "compact_boundary") {
        t.onCompaction?.({ trigger: m.compact_metadata.trigger, before: m.compact_metadata.pre_tokens, ...(m.compact_metadata.post_tokens !== undefined ? { after: m.compact_metadata.post_tokens } : {}) });
      }
      else if (m.type === "system" && "subtype" in m && m.subtype === "task_started") {
        if (m.tool_use_id) {
          const taskId = m.task_id;
          toolOfTask.set(taskId, m.tool_use_id);
          t.onStopper(m.tool_use_id, () => q.stopTask(taskId));
          if (m.is_backgrounded) background.add(m.tool_use_id);
          t.onTask(m.tool_use_id, "started", { background: m.is_backgrounded });
        }
      } else if (m.type === "system" && "subtype" in m && m.subtype === "task_updated") {
        // A foreground task moved to the background (Ctrl+B, or the binary's own choice).
        const tool = toolOfTask.get(m.task_id);
        if (tool && m.patch.is_backgrounded) {
          background.add(tool);
          t.onTask(tool, "started", { background: true });
        }
      } else if (m.type === "system" && "subtype" in m && m.subtype === "background_tasks_changed") {
        level.clear();
        for (const task of m.tasks) if (!task.ambient) level.add(task.task_id);
        if (free && bg() === 0 && !grace) grace = setTimeout(closeIfDone, LAST_TASK_GRACE_MS);
      } else if (m.type === "system" && "subtype" in m && m.subtype === "task_notification") {
        if (m.tool_use_id) {
          t.onStopper(m.tool_use_id, null);
          slots.release(m.tool_use_id);
          background.delete(m.tool_use_id);
          t.onTask(m.tool_use_id, m.status, { summary: m.summary });
          // The binary answers the last report with a main reply; if it stays idle a long while, the turn ends.
          if (free && bg() === 0 && !grace) grace = setTimeout(closeIfDone, LAST_TASK_GRACE_MS);
        }
      }
      else if (m.type === "stream_event") {
        const e = m.event;
        if (!m.parent_tool_use_id && e.type === "content_block_delta" && e.delta.type === "text_delta") t.onDelta(e.delta.text);
      } else if (m.type === "assistant") {
        if (m.error) error = `Claude: ${m.error}`;
        const u = messagesUsage((m.message as { usage?: unknown }).usage);
        if (t.onTokens) {
          const tokens = usageTokens(u);
          const before = spent.get(m.message.id) ?? 0;
          if (tokens > before) {
            spent.set(m.message.id, tokens);
            t.onTokens(tokens - before, m.parent_tool_use_id);
          }
        }
        if (u && t.onUsage) {
          const before = reported.get(m.message.id);
          reported.set(m.message.id, u);
          const model = (m.message as { model?: string }).model || (m.parent_tool_use_id ? t.subagents.model : t.model);
          t.onUsage({ usage: u, growth: usageGrowth(u, before), first: !before, model, parent: m.parent_tool_use_id });
        }
        if (!m.parent_tool_use_id) askWindow();
        const content = (m.message.content as ContentBlock[]).map((b) => {
          if (b.type !== "tool_use") return b;
          const name = studioName(b.name);
          const c = t.editor ? t.editor.canon(name, (b.input ?? {}) as Record<string, unknown>) : { name, input: b.input };
          return { ...b, name: c.name, input: c.input } as ContentBlock;
        });
        for (const b of content) if (b.type === "tool_use") calls.add(b.id, b.name, b.input);
        t.onAssistant(m.message.id, content, m.parent_tool_use_id);
      } else if (m.type === "user" && Array.isArray(m.message.content)) {
        t.onToolResults(m.message.content as unknown[], m.parent_tool_use_id);
      } else if (m.type === "result") {
        sessionId = m.session_id;
        t.onSession(m.session_id);
        if (interrupted) interrupted = false;
        else if (m.subtype !== "success") error = error ?? endedText(m.subtype);
        else if (m.is_error) error = error ?? m.result;
        // The main agent's reply ended. With background subagents still working, it takes the user's next message now.
        if (bg() === 0) {
          free = true;
          close("the main agent finished with no background task running");
        } else setFree(true);
      }
    }
    return t.signal.aborted ? null : error;
  } catch (e) {
    return t.signal.aborted ? null : e instanceof Error ? e.message : String(e);
  } finally {
    if (grace) clearTimeout(grace);
    input.close();
    t.onLive?.(null);
  }
}

export interface SubscriptionCompletion {
  projectDir: string;
  model: string;
  effort: Effort;
  system: string;
  prompt: string;
  signal: AbortSignal;
}

/**
 * One text answer on the user's Claude sign-in, for a flow's agent step: no
 * tools at all, built-in or Studio's, one turn, and no session kept. The
 * answer is the turn's result text.
 */
export async function runSubscriptionCompletion(c: SubscriptionCompletion): Promise<{ text: string } | { error: string }> {
  if (!(claudeLogin() ?? (await refreshClaudeLogin()))) return { error: "Sign in to Claude Code first: run `claude /login` in a terminal." };
  const rt = await runtime();
  if ("error" in rt) return rt;
  fs.mkdirSync(claudeHome(), { recursive: true });
  const abort = new AbortController();
  const onStop = () => abort.abort();
  if (c.signal.aborted) onStop();
  else c.signal.addEventListener("abort", onStop, { once: true });
  try {
    const q = query({
      prompt: c.prompt,
      options: {
        model: c.model,
        effort: c.effort,
        systemPrompt: c.system,
        tools: [],
        allowedTools: [],
        settingSources: [],
        maxTurns: 1,
        persistSession: false,
        cwd: c.projectDir,
        pathToClaudeCodeExecutable: rt.exe,
        abortController: abort,
        env: claudeEnv({}),
      },
    });
    let text = "";
    let error: string | null = null;
    for await (const m of q as AsyncIterable<SDKMessage>) {
      if (m.type === "assistant") {
        if (m.error) error = `Claude: ${m.error}`;
        for (const b of m.message.content as ContentBlock[]) if (b.type === "text") text += b.text;
      } else if (m.type === "result") {
        if (m.subtype === "success" && !m.is_error) text = m.result || text;
        else error = error ?? (m.subtype === "success" ? m.result : endedText(m.subtype));
      }
    }
    if (c.signal.aborted) return { error: "stopped" };
    return error ? { error } : { text };
  } catch (e) {
    return { error: c.signal.aborted ? "stopped" : e instanceof Error ? e.message : String(e) };
  } finally {
    c.signal.removeEventListener("abort", onStop);
  }
}

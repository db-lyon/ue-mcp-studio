/**
 * Run one conversation step on the user's Claude subscription through the
 * Claude Agent SDK: the main agent's reply, or one subagent Studio started.
 * The SDK's runtime binary runs it on the user's Claude Code login and home
 * (claude-auth.ts), the one route whose model is reached through a runtime
 * rather than a request. Orchestration stays Studio's, as on every route: the
 * runtime's own subagent tool and background tasks are switched off, and the
 * main agent gets Studio's agent tool, whose calls Studio runs (runner.ts).
 * Every tool is an in-process MCP server whose handlers run the same executor
 * as the other routes.
 */
import * as fs from "node:fs";
import { createSdkMcpServer, query, tool, type HookCallback, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Effort } from "@ue-mcp-studio/shared";
import { z } from "zod";
import type { ContentBlock } from "./providers.js";
import { OMIT_DESCRIPTION, SELECT_DESCRIPTION, UE_MCP_DESCRIPTION, forModel, type ToolExecution } from "./tools.js";
import { messagesUsage, usageGrowth, usageTokens, type TokenUsage } from "./usage.js";
import { ensureRuntime } from "./runtime.js";
import { claudeEnv, claudeHome, claudeLogin, refreshClaudeLogin } from "./claude-auth.js";
import { LOCAL_TOOL_NAMES, localToolDefinitions } from "./local-tools.js";
import { REPLY_DESCRIPTION, REPLY_TOOL_NAME, messagesIn } from "./subagent-inbox.js";

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
/** The runtime's own subagent tool, under both its names: off on this route, where Studio runs subagents itself. */
const RUNTIME_AGENT = ["Agent", "Task"];
/** The SDK's web search, which runs on the vendor's side and touches nothing here: the one built-in tool kept. */
const SEARCH = "WebSearch";
/** The SDK's skill tool, which an explicit tool list must name for the project's skills to load. */
const SKILL = "Skill";
/** Studio's subagent tool, by its Studio name. */
export const AGENT_TOOL_NAME = "agent";

/** Claude Code's built-in names a skill may use, each run by Studio's own tool through the SDK's toolAliases. */
export const BUILTIN_TO_STUDIO: Record<string, string> = { Bash: "shell", Read: "read_file", Write: "write_file", Edit: "edit_file", Glob: "glob", Grep: "grep", WebFetch: "web_fetch" };

/** Tool names as Studio's transcript writes them: its own tools unprefixed, aliased built-ins as the tool that runs them. */
export const studioName = (name: string): string =>
  name.startsWith(PREFIX) ? name.slice(PREFIX.length)
    : name === SEARCH ? "web_search"
    : BUILTIN_TO_STUDIO[name] ?? name;

/**
 * The SDK's tool options for one conversation: Studio's tools (narrowed to
 * `allowed`, a project helper's list, in Studio's names), Studio's agent tool
 * when the conversation may start subagents, web search and skills. The
 * runtime's own subagent tool is always disallowed, under both names, so
 * neither it nor a project's .claude/agents file starts a subagent Studio does
 * not run.
 */
export function toolOptions(o: { agent: boolean; reply?: boolean; allowed?: string[]; editor?: string[]; skills: boolean }) {
  const may = (name: string) => !o.allowed || o.allowed.includes(name);
  const studio = withEditor(STUDIO_TOOLS, may("ue_mcp") ? o.editor : undefined).filter((n) => {
    const base = n.slice(PREFIX.length);
    // A projected editor tool comes with ue_mcp.
    return o.editor?.includes(base) ? may("ue_mcp") : may(base);
  });
  const search = may("web_search") ? [SEARCH] : [];
  const skill = o.skills ? [SKILL] : [];
  const agent = o.agent ? [`${PREFIX}${AGENT_TOOL_NAME}`] : [];
  // A helper's file never takes away the subagent's answer to the user.
  const reply = o.reply ? [`${PREFIX}${REPLY_TOOL_NAME}`] : [];
  return { tools: [...search, ...skill], allowedTools: [...studio, ...agent, ...reply, ...search, ...skill], disallowedTools: [...RUNTIME_AGENT] };
}

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
  /**
   * Studio's agent tool, the definition every route's main agent gets (with
   * the project's helpers listed); its calls go to runTool like any other.
   * Absent: this conversation starts no subagents (they are off, or it is one).
   */
  agentTool?: { description: string; inputSchema: Record<string, unknown> };
  /**
   * A subagent's conversation: it has Studio's reply tool, whose calls go to
   * runTool, and onHeard is told when it takes in the user's messages.
   */
  reply?: boolean;
  /** The conversation took in n of the user's messages streamed into it (a subagent's, with reply). */
  onHeard?: (n: number) => void;
  /** Studio's tools this conversation may use, by Studio's names; every one when absent. A project helper's file narrows them. */
  allowed?: string[];
  /** The most model calls this conversation makes before the runtime ends it, as a helper's file can say. */
  maxTurns?: number;
  /**
   * The project's own Claude Code files: the setting sources the SDK reads
   * instructions and skills from, and whether there are skills. Absent: the
   * SDK reads no files, as while "Read the project's own files" is off. The
   * project's subagent files are Studio's helpers, listed in agentTool.
   */
  native?: { settingSources: Array<"user" | "project" | "local">; skills: boolean };
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
  /**
   * The conversation while it runs: `say` hands it the user's next message
   * now, streamed into its input (false once the input has closed), and
   * `interrupt` stops its current reply. Null once it has ended.
   */
  onLive?: (live: LiveTurn | null) => void;
  /** The conversation's input closed while it still runs, and why: a message after this starts the next step. */
  onInputClosed?: (why: string) => void;
  /**
   * Run one tool call the model asked for, by its tool_use id. `onStart` is
   * told when the call gets past its approval and starts running, which a turn
   * host keeps so a daemon restart never runs it twice.
   */
  runTool: (id: string, name: string, input: Record<string, unknown>, onStart?: () => void) => Promise<ToolExecution>;
  /** Tokens the turn spent since the last report, as each model message arrives; `parent` is null on this route, where every conversation is one agent's. */
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

/** A running conversation on this route, as the runner steers it. */
export interface LiveTurn {
  /** It still takes messages. */
  open: () => boolean;
  /** Hand it a message now, streamed into its input; false once the input has closed. A conversation in a host answers asynchronously. */
  say: (blocks: unknown[]) => boolean | Promise<boolean>;
  /** Stop its current reply. */
  interrupt: () => Promise<void>;
  /**
   * Compatibility, for a turn host from before protocol 3 only: such a host
   * runs the runtime's own subagents, and these steer them (background tasks
   * still working, the main agent idle beside them, moving foreground work to
   * the background, a message held for one subagent). A conversation this
   * version starts has none of them. Remove with LEGACY_HOST_PROTOCOL.
   */
  background?: () => number;
  free?: () => boolean;
  keep?: () => Promise<boolean>;
  tell?: (callId: string | null, text: string) => boolean | Promise<boolean>;
}

const userMessage = (blocks: unknown[], session: string): SDKUserMessage =>
  ({ type: "user", message: { role: "user", content: blocks }, parent_tool_use_id: null, session_id: session }) as unknown as SDKUserMessage;

/**
 * The conversation's input, streamed: its first message, then each message
 * handed to it while it runs (the user's, or a background subagent's report).
 * The binary keeps working while it is open; closing it lets the binary finish
 * what it has and exit.
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
      // Studio's agent tool. Marked read-only so the runtime runs several calls of one message at once,
      // as it does its own subagents; what a subagent does goes through Studio's tools and approvals.
      ...(t.agentTool ? [tool(AGENT_TOOL_NAME, t.agentTool.description, zodShape(t.agentTool.inputSchema), handler(AGENT_TOOL_NAME), { annotations: { readOnlyHint: true } })] : []),
      ...(t.reply ? [tool(REPLY_TOOL_NAME, REPLY_DESCRIPTION, { text: z.string() }, handler(REPLY_TOOL_NAME), { annotations: { readOnlyHint: true } })] : []),
    ],
  });

  const abort = new AbortController();
  const day = String(24 * 60 * 60 * 1000);
  // A command or a file change can wait on the user, and an agent call on its subagent, for as long as they take:
  // no MCP call timeout cuts either off.
  const env = claudeEnv({ MCP_TOOL_TIMEOUT: day });

  const tools = toolOptions({ agent: !!t.agentTool, reply: t.reply, allowed: t.allowed, editor: t.editor?.tools.map((p) => p.name), skills: !!t.native?.skills });
  // The summary a compaction of the conversation wrote, which only this hook hands over.
  const compacted: HookCallback = async (input) => {
    if (input.hook_event_name === "PostCompact" && !input.agent_id) t.onCompaction?.({ summary: input.compact_summary });
    return {};
  };
  // A message streamed in mid-step is taken in at the conversation's next step, which the runtime's stream does not
  // show: this hook runs then, for each prompt it takes in, so Studio knows the subagent has read the user's message.
  const heard: HookCallback = async (input) => {
    if (input.hook_event_name === "UserPromptSubmit") {
      const n = messagesIn(String(input.prompt ?? ""));
      if (n > 0) t.onHeard?.(n);
    }
    return {};
  };
  const hooks = { PostCompact: [{ hooks: [compacted] }], ...(t.onHeard ? { UserPromptSubmit: [{ hooks: [heard] }] } : {}) };

  const input = inputChannel(userMessage(t.prompt, t.resume ?? ""));
  let sessionId = t.resume ?? "";
  // A Stop that interrupted only the current reply: the result it ends with is not the conversation's error.
  let interrupted = false;
  const close = (why: string) => {
    if (input.closed) return;
    input.close();
    t.onInputClosed?.(why);
  };
  t.signal.addEventListener("abort", () => input.close(), { once: true });

  try {
    const q = query({
      prompt: input.messages,
      options: {
        model: t.model,
        effort: t.effort,
        systemPrompt: t.system,
        ...tools,
        ...(t.maxTurns ? { maxTurns: t.maxTurns } : {}),
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
      open: () => !input.closed,
      // Streamed into the conversation's input: the runtime reads it at its next step, or after the reply it is writing.
      say: (blocks) => !t.signal.aborted && input.push(userMessage(blocks, sessionId)),
      interrupt: async () => {
        if (input.closed) return;
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
          const model = (m.message as { model?: string }).model || t.model;
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
        // The reply ended: the runtime finishes what it was handed already and exits. Whatever comes next
        // (the user's message, a background subagent's report) starts the next step, which resumes this session.
        close("the reply ended");
      }
    }
    return t.signal.aborted ? null : error;
  } catch (e) {
    return t.signal.aborted ? null : e instanceof Error ? e.message : String(e);
  } finally {
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

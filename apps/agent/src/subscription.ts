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
import { messagesUsage, usageTokens } from "./usage.js";
import { ensureRuntime } from "./runtime.js";
import { claudeEnv, claudeHome, claudeLogin, refreshClaudeLogin } from "./claude-auth.js";
import { LOCAL_TOOL_NAMES, localToolDefinitions } from "./local-tools.js";
import { subagentLimitText } from "./subagent-limit.js";

const SERVER = "studio";
const PREFIX = `mcp__${SERVER}__`;
export const STUDIO_TOOLS = ["ue_mcp", "editor_restart", ...LOCAL_TOOL_NAMES].map((n) => `${PREFIX}${n}`);
/** The SDK's subagent tool, and the subagent Studio defines for it. */
const AGENT = "Agent";
const WORKER = "editor-worker";
/** The SDK's web search, which runs on Anthropic's side: the one built-in tool besides Agent. */
const SEARCH = "WebSearch";

/** Tool names as Studio's transcript writes them: its own tools unprefixed, the SDK's subagent tool as agent. */
export const studioName = (name: string): string =>
  name.startsWith(PREFIX) ? name.slice(PREFIX.length)
    : name === AGENT || name === "Task" ? "agent"
    : name === SEARCH ? "web_search"
    : name;

/** Studio's machine tools in the SDK's form: the same names and descriptions as the API path, checked by zod. */
function localSdkTools(handler: (name: string) => (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; isError: boolean }>) {
  const desc = Object.fromEntries(localToolDefinitions().map((t) => [(t as { name: string }).name, (t as { description?: string }).description ?? ""]));
  return [
    tool("shell", desc.shell, { command: z.string(), timeout: z.number().optional(), description: z.string().optional() }, handler("shell")),
    tool("read_file", desc.read_file, { path: z.string(), offset: z.number().optional(), limit: z.number().optional() }, handler("read_file")),
    tool("write_file", desc.write_file, { path: z.string(), content: z.string() }, handler("write_file")),
    tool("edit_file", desc.edit_file, { path: z.string(), old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional() }, handler("edit_file")),
    tool("glob", desc.glob, { pattern: z.string(), path: z.string().optional() }, handler("glob")),
    tool("grep", desc.grep, { pattern: z.string(), path: z.string().optional(), glob: z.string().optional(), ignore_case: z.boolean().optional() }, handler("grep")),
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
  /** Whether the model may start subagents, how many this turn, and what they run on. */
  subagents: { mode: SubagentMode; perTurn: number; model: string; effort: Effort };
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
  /** Run one tool call the model asked for, by its tool_use id. */
  runTool: (id: string, name: string, input: Record<string, unknown>) => Promise<ToolExecution>;
  /** Tokens the turn spent since the last report, as each model message arrives; `parent` is the agent call of a subagent's message. */
  onTokens?: (tokens: number, parent: string | null) => void;
}

/**
 * The SDK options for subagents: none at all when they are off, else the
 * subagent Studio defines, on its own model and effort, with a hook that
 * refuses the agent calls past the turn's allowance.
 */
export function subagentOptions(s: SubscriptionTurn["subagents"], subagentSystem: string) {
  if (s.mode === "off") return { tools: [SEARCH], allowedTools: [...STUDIO_TOOLS, SEARCH] };
  let started = 0;
  const limit: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    if (++started <= s.perTurn) return {};
    return { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: subagentLimitText(s.perTurn) } };
  };
  return {
    // Built-ins: the subagent tool, and web search, which runs on Anthropic's side and touches nothing here.
    // Everything else goes through Studio's tools, so one approval model and one transcript cover every route.
    tools: [AGENT, SEARCH],
    agents: {
      [WORKER]: {
        description: "Works on one self-contained task in the Unreal Editor through ue-mcp, or on the project's files, and reports what it changed.",
        prompt: subagentSystem,
        model: s.model,
        effort: s.effort,
        tools: [...STUDIO_TOOLS, SEARCH],
      },
    },
    allowedTools: [...STUDIO_TOOLS, AGENT, SEARCH],
    hooks: { PreToolUse: [{ matcher: AGENT, hooks: [limit] }] },
  };
}

/** Text alone goes as a string; with an image or a document, as one user message of blocks. */
function promptOf(blocks: unknown[], resume: string | null): string | AsyncIterable<SDKUserMessage> {
  const all = blocks as Array<{ type: string; text?: string }>;
  if (all.every((b) => b.type === "text")) return all.map((b) => b.text).join("\n\n");
  return (async function* () {
    yield { type: "user", message: { role: "user", content: blocks }, parent_tool_use_id: null, session_id: resume ?? "" } as unknown as SDKUserMessage;
  })();
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
  const handler = (name: string) => async (args: Record<string, unknown>) => {
    const exec = await t.runTool(await calls.take(name, args), name, args);
    // Images go as MCP image content, which the SDK hands the model as images.
    const images = (exec.images ?? []).map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mediaType }));
    return { content: [{ type: "text" as const, text: forModel(exec) }, ...images], isError: exec.isError };
  };

  const server = createSdkMcpServer({
    name: SERVER,
    alwaysLoad: true,
    tools: [
      tool(
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
      ),
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

  try {
    const q = query({
      prompt: promptOf(t.prompt, t.resume),
      options: {
        model: t.model,
        effort: t.effort,
        systemPrompt: t.system,
        ...subagentOptions(t.subagents, t.subagentSystem),
        mcpServers: { [SERVER]: server },
        settingSources: [],
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
    const messages = (q as AsyncIterable<SDKMessage>)[Symbol.asyncIterator]();
    let error: string | null = null;
    // The SDK repeats a message per content block with its usage so far: count each message's growth once.
    const spent = new Map<string, number>();
    for (;;) {
      const next = await Promise.race([messages.next(), stopped]);
      if (!next || next.done || t.signal.aborted) break;
      const m = next.value;
      if (m.type === "system" && "subtype" in m && m.subtype === "init") t.onSession(m.session_id);
      else if (m.type === "system" && "subtype" in m && m.subtype === "task_started") {
        if (m.tool_use_id) {
          const taskId = m.task_id;
          t.onStopper(m.tool_use_id, () => q.stopTask(taskId));
          t.onTask(m.tool_use_id, "started", { background: m.is_backgrounded });
        }
      } else if (m.type === "system" && "subtype" in m && m.subtype === "task_notification") {
        if (m.tool_use_id) {
          t.onStopper(m.tool_use_id, null);
          t.onTask(m.tool_use_id, m.status, { summary: m.summary });
        }
      }
      else if (m.type === "stream_event") {
        const e = m.event;
        if (!m.parent_tool_use_id && e.type === "content_block_delta" && e.delta.type === "text_delta") t.onDelta(e.delta.text);
      } else if (m.type === "assistant") {
        if (m.error) error = `Claude: ${m.error}`;
        if (t.onTokens) {
          const tokens = usageTokens(messagesUsage((m.message as { usage?: unknown }).usage));
          const before = spent.get(m.message.id) ?? 0;
          if (tokens > before) {
            spent.set(m.message.id, tokens);
            t.onTokens(tokens - before, m.parent_tool_use_id);
          }
        }
        const content = (m.message.content as ContentBlock[]).map((b) => (b.type === "tool_use" ? ({ ...b, name: studioName(b.name) } as ContentBlock) : b));
        for (const b of content) if (b.type === "tool_use") calls.add(b.id, b.name, b.input);
        t.onAssistant(m.message.id, content, m.parent_tool_use_id);
      } else if (m.type === "user" && Array.isArray(m.message.content)) {
        t.onToolResults(m.message.content as unknown[], m.parent_tool_use_id);
      } else if (m.type === "result") {
        t.onSession(m.session_id);
        if (m.subtype !== "success") error = error ?? `The turn ended: ${m.subtype}`;
        else if (m.is_error) error = error ?? m.result;
      }
    }
    return t.signal.aborted ? null : error;
  } catch (e) {
    return t.signal.aborted ? null : e instanceof Error ? e.message : String(e);
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
        else error = error ?? (m.subtype === "success" ? m.result : `The turn ended: ${m.subtype}`);
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

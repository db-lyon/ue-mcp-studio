/**
 * Experimental: run a turn on the user's Claude subscription through the
 * Claude Agent SDK. The SDK's own Claude Code binary runs it, with a login and
 * session store kept in Studio's folder, apart from any Claude Code the user
 * has installed. The SDK owns the model loop; Studio's tools are an in-process
 * MCP server whose handlers run the same executor as the API path.
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createSdkMcpServer, query, tool, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Effort, StudioSignIn } from "@ue-mcp-studio/shared";
import { z } from "zod";
import type { ContentBlock } from "./providers.js";
import type { ToolExecution } from "./tools.js";
import { ensureRuntime, installedRuntime } from "./runtime.js";
import { LOCAL_TOOL_NAMES, localToolDefinitions } from "./local-tools.js";

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

/** Studio's own Claude home: its sign-in and its sessions' conversations, shared by every project and apart from Claude Code. */
export const claudeHome = (): string => process.env.STUDIO_CLAUDE_HOME || path.join(os.homedir(), ".ue-mcp", "studio", "claude");
/** Claude Code's home, where the 0.1.2 betas kept Studio's conversations. */
export const sharedClaudeHome = (): string => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");

/** Studio's Claude login, when there is one: present means signed in. Tokens are never read here. */
export function claudeLogin(): { subscription: string } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(claudeHome(), ".credentials.json"), "utf-8"));
    const o = raw?.claudeAiOauth;
    return o?.accessToken ? { subscription: String(o.subscriptionType ?? "claude") } : null;
  } catch {
    return null;
  }
}

/** The environment the binary runs in: Studio's Claude folder, and no API key to prefer over the login. */
function claudeEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_CONFIG_DIR: claudeHome(), CLAUDE_AGENT_SDK_CLIENT_APP: "ue-mcp-studio-experimental", ...extra };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  return env;
}

/** The runtime, fetched on first use; an error message when it cannot be had. */
const runtime = (): Promise<{ exe: string } | { error: string }> =>
  ensureRuntime().then((exe) => ({ exe }), (e: Error) => ({ error: e.message }));

/**
 * Sign in to Claude with the SDK's binary: it prints the page to approve on,
 * the page shows a code, and the code goes back on the binary's input.
 */
export class ClaudeSignInFlow {
  private state: StudioSignIn = { state: "idle" };
  private child: ChildProcess | null = null;
  private output = "";

  constructor(private readonly onDone: () => void) {}

  view(): StudioSignIn {
    if (this.state.state !== "pending") {
      const login = claudeLogin();
      if (login) return { state: "done", login: `Claude ${login.subscription}` };
    }
    return this.state;
  }

  async start(): Promise<StudioSignIn> {
    this.cancel();
    const rt = await runtime();
    if ("error" in rt) return (this.state = { state: "error", error: rt.error });
    const exe = rt.exe;
    fs.mkdirSync(claudeHome(), { recursive: true });
    const child = spawn(exe, ["auth", "login", "--claudeai"], { env: claudeEnv({ BROWSER: "none" }), cwd: claudeHome(), windowsHide: true });
    this.child = child;
    this.output = "";
    const url = await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 20_000);
      const read = (b: Buffer) => {
        this.output += b.toString();
        const m = this.output.match(/https:\/\/\S+oauth\/authorize\S+/);
        if (m) {
          clearTimeout(timer);
          resolve(m[0]);
        }
      };
      child.stdout?.on("data", read);
      child.stderr?.on("data", read);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve(null);
      });
    });
    if (!url || child !== this.child) {
      this.stop();
      return (this.state = { state: "error", error: `Claude did not start the sign-in. ${this.tail()}` });
    }
    child.once("exit", (code) => {
      if (child !== this.child) return;
      this.child = null;
      const login = claudeLogin();
      if (code === 0 && login) {
        this.state = { state: "done", login: `Claude ${login.subscription}` };
        this.onDone();
      } else {
        this.state = { state: "error", error: `The sign-in did not complete. ${this.tail()}` };
      }
    });
    this.state = { state: "pending", url, needsCode: true, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() };
    return this.state;
  }

  /** The code the approval page showed. */
  submit(code: string): StudioSignIn {
    if (!this.child?.stdin || this.state.state !== "pending") return (this.state = { state: "error", error: "No sign-in is waiting for a code. Start again." });
    this.child.stdin.write(`${code.trim()}\n`);
    return this.state;
  }

  cancel(): void {
    this.stop();
    this.state = { state: "idle" };
  }

  /** Forget Studio's Claude login. */
  async signOut(): Promise<void> {
    this.cancel();
    const exe = installedRuntime();
    if (exe) await new Promise((r) => spawn(exe, ["auth", "logout"], { env: claudeEnv(), cwd: claudeHome(), windowsHide: true }).once("exit", r).once("error", r));
    fs.rmSync(path.join(claudeHome(), ".credentials.json"), { force: true });
  }

  private stop(): void {
    const c = this.child;
    this.child = null;
    c?.kill();
  }

  private tail(): string {
    return this.output.replace(/https:\/\/\S+/g, "").replace(/\s+/g, " ").trim().slice(-200);
  }
}

export interface SubscriptionTurn {
  projectDir: string;
  model: string;
  /** The SDK lowers a level the model does not have to its nearest one. */
  effort: Effort;
  system: string;
  /** What each subagent the model starts is told. */
  subagentSystem: string;
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
}

/** Text alone goes as a string; with an image or a document, as one user message of blocks. */
function promptOf(blocks: unknown[], resume: string | null): string | AsyncIterable<SDKUserMessage> {
  const all = blocks as Array<{ type: string; text?: string }>;
  if (all.every((b) => b.type === "text")) return all.map((b) => b.text).join("\n\n");
  return (async function* () {
    yield { type: "user", message: { role: "user", content: blocks }, parent_tool_use_id: null, session_id: resume ?? "" } as unknown as SDKUserMessage;
  })();
}

/** How long a stopped turn's binary gets to end the turn itself before it is closed. */
const STOP_GRACE_MS = 1500;

/** Run one turn to the end. Resolves with an error message when the turn failed. */
export async function runSubscriptionTurn(t: SubscriptionTurn): Promise<string | null> {
  if (!claudeLogin()) return "Sign in to your Claude subscription: open the model picker.";
  const rt = await runtime();
  if ("error" in rt) return rt.error;
  const exe = rt.exe;
  fs.mkdirSync(claudeHome(), { recursive: true });

  // The SDK does not hand the tool_use id to a handler: match the call to the block the model just sent.
  const waiting: Array<{ id: string; name: string; input: unknown }> = [];
  const take = (name: string, args: unknown) => {
    const key = JSON.stringify(args);
    const i = waiting.findIndex((w) => w.name === name && JSON.stringify(w.input) === key);
    const hit = waiting.splice(i >= 0 ? i : waiting.findIndex((w) => w.name === name), 1)[0];
    return hit?.id ?? `call_${Date.now()}`;
  };
  const handler = (name: string) => async (args: Record<string, unknown>) => {
    const exec = await t.runTool(take(name, args), name, args);
    // Images go as MCP image content, which the SDK hands the model as images.
    const images = (exec.images ?? []).map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mediaType }));
    return { content: [{ type: "text" as const, text: exec.text }, ...images], isError: exec.isError };
  };

  const server = createSdkMcpServer({
    name: SERVER,
    alwaysLoad: true,
    tools: [
      tool(
        "ue_mcp",
        "Unreal Editor actions through ue-mcp. action=search finds actions by intent (query); action=describe gives one action's parameters (category + method) or a category's actions (category alone); action=call runs one action (category, method, args). Describe before the first call of an action.",
        {
          action: z.enum(["search", "describe", "call"]),
          query: z.string().optional(),
          category: z.string().optional(),
          method: z.string().optional(),
          args: z.record(z.string(), z.unknown()).optional(),
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
        // Built-ins: the subagent tool, and web search, which runs on Anthropic's side and touches nothing here.
        // Everything else goes through Studio's tools, so one approval model and one transcript cover every route.
        tools: [AGENT, SEARCH],
        agents: {
          [WORKER]: {
            description: "Works on one self-contained task in the Unreal Editor through ue-mcp, or on the project's files, and reports what it changed.",
            prompt: t.subagentSystem,
            effort: t.effort,
            tools: [...STUDIO_TOOLS, SEARCH],
          },
        },
        mcpServers: { [SERVER]: server },
        allowedTools: [...STUDIO_TOOLS, AGENT, SEARCH],
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
        const content = (m.message.content as ContentBlock[]).map((b) => (b.type === "tool_use" ? ({ ...b, name: studioName(b.name) } as ContentBlock) : b));
        for (const b of content) if (b.type === "tool_use") waiting.push({ id: b.id, name: b.name, input: b.input });
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

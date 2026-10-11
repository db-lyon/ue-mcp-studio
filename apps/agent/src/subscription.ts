/**
 * Experimental: run a turn on the user's Claude subscription through the
 * Claude Agent SDK. The SDK's own Claude Code binary runs it, with a login and
 * session store kept in Studio's folder, apart from any Claude Code the user
 * has installed. The SDK owns the model loop; Studio's tools are an in-process
 * MCP server whose handlers run the same executor as the API path.
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { createSdkMcpServer, query, tool, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { StudioSignIn } from "@ue-mcp-studio/shared";
import { z } from "zod";
import type { ContentBlock } from "./providers.js";
import type { ToolExecution } from "./tools.js";

const SERVER = "studio";
const PREFIX = `mcp__${SERVER}__`;

/** Studio's Claude login and SDK sessions, shared by every project. */
export const claudeHome = (): string => process.env.STUDIO_CLAUDE_HOME || path.join(os.homedir(), ".ue-mcp", "studio", "claude");

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

/** The SDK's own Claude Code binary, from its platform package. */
export function claudeExecutable(): string | null {
  try {
    const pkg = createRequire(import.meta.url).resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`);
    const exe = path.join(path.dirname(pkg), process.platform === "win32" ? "claude.exe" : "claude");
    return fs.existsSync(exe) ? exe : null;
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

const MISSING = "The Claude runtime is missing from this Studio install.";

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
    const exe = claudeExecutable();
    if (!exe) return (this.state = { state: "error", error: MISSING });
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
    const exe = claudeExecutable();
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
  system: string;
  prompt: string;
  /** The SDK session to continue, from this Studio session's last turn. */
  resume: string | null;
  signal: AbortSignal;
  onSession: (id: string) => void;
  onDelta: (text: string) => void;
  /** One assistant message, merged by message id when the SDK splits it per block. */
  onAssistant: (messageId: string, content: ContentBlock[]) => void;
  onToolResults: (content: unknown[]) => void;
  /** Run one tool call the model asked for, by its tool_use id. */
  runTool: (id: string, name: string, input: Record<string, unknown>) => Promise<ToolExecution>;
}

/** Run one turn to the end. Resolves with an error message when the turn failed. */
export async function runSubscriptionTurn(t: SubscriptionTurn): Promise<string | null> {
  const exe = claudeExecutable();
  if (!exe) return MISSING;
  if (!claudeLogin()) return "Sign in to your Claude subscription: open the model picker.";
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
    return { content: [{ type: "text" as const, text: exec.text }], isError: exec.isError };
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
    ],
  });

  const abort = new AbortController();
  const onAbort = () => abort.abort();
  t.signal.addEventListener("abort", onAbort);
  const env = claudeEnv();

  try {
    const q = query({
      prompt: t.prompt,
      options: {
        model: t.model,
        systemPrompt: t.system,
        tools: [],
        mcpServers: { [SERVER]: server },
        allowedTools: [`${PREFIX}ue_mcp`, `${PREFIX}editor_restart`],
        settingSources: [],
        includePartialMessages: true,
        resume: t.resume ?? undefined,
        cwd: t.projectDir,
        pathToClaudeCodeExecutable: exe,
        abortController: abort,
        env,
      },
    });
    let error: string | null = null;
    for await (const m of q as AsyncIterable<SDKMessage>) {
      if (m.type === "system" && "subtype" in m && m.subtype === "init") t.onSession(m.session_id);
      else if (m.type === "stream_event") {
        const e = m.event;
        if (e.type === "content_block_delta" && e.delta.type === "text_delta") t.onDelta(e.delta.text);
      } else if (m.type === "assistant") {
        if (m.error) error = `Claude: ${m.error}`;
        const content = (m.message.content as ContentBlock[]).map((b) =>
          b.type === "tool_use" && b.name.startsWith(PREFIX) ? ({ ...b, name: b.name.slice(PREFIX.length) } as ContentBlock) : b,
        );
        for (const b of content) if (b.type === "tool_use") waiting.push({ id: b.id, name: b.name, input: b.input });
        t.onAssistant(m.message.id, content);
      } else if (m.type === "user" && Array.isArray(m.message.content)) {
        t.onToolResults(m.message.content as unknown[]);
      } else if (m.type === "result") {
        t.onSession(m.session_id);
        if (m.subtype !== "success") error = error ?? `The turn ended: ${m.subtype}`;
        else if (m.is_error) error = error ?? m.result;
      }
    }
    return t.signal.aborted ? null : error;
  } catch (e) {
    return t.signal.aborted ? null : e instanceof Error ? e.message : String(e);
  } finally {
    t.signal.removeEventListener("abort", onAbort);
  }
}

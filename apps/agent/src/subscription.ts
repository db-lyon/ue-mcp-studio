/**
 * Experimental: run a turn on the user's Claude subscription through the
 * Claude Agent SDK, which drives the user's installed Claude Code with its own
 * login. The SDK owns the model loop; Studio's tools are an in-process MCP
 * server whose handlers run the same executor as the API path.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createSdkMcpServer, query, tool, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { ContentBlock } from "./providers.js";
import type { ToolExecution } from "./tools.js";

const SERVER = "studio";
const PREFIX = `mcp__${SERVER}__`;

/** The Claude Code login, when there is one: present means signed in. Tokens are never read here. */
export function claudeLogin(): { subscription: string } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude", ".credentials.json"), "utf-8"));
    const o = raw?.claudeAiOauth;
    return o?.accessToken ? { subscription: String(o.subscriptionType ?? "claude") } : null;
  } catch {
    return null;
  }
}

/** The installed Claude Code, from STUDIO_CLAUDE_PATH or PATH. */
export function claudeExecutable(): string | null {
  if (process.env.STUDIO_CLAUDE_PATH) return process.env.STUDIO_CLAUDE_PATH;
  const names = process.platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"];
  const dirs = [...(process.env.PATH ?? "").split(path.delimiter), path.join(os.homedir(), ".local", "bin")];
  for (const d of dirs) for (const n of names) if (d && fs.existsSync(path.join(d, n))) return path.join(d, n);
  return null;
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
  if (!exe) return "Claude Code is not installed: install it and run claude, then /login.";

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
  // Without an API key in the environment, Claude Code uses its own login.
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "ue-mcp-studio-experimental" };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;

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

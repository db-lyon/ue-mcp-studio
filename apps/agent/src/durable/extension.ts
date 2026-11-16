/**
 * Studio's tools on the durable runtime, as one Pi Durable extension.
 *
 * Every tool the daemon defines (ue-mcp, the editor restart, shell, files,
 * web, skills, a subagent's reply) runs where it runs on every other route: in
 * the daemon, through its editor wait, its approval gate and its executor. The
 * harness asks the daemon for each call and waits for whichever daemon is
 * connected, so a daemon restart mid-wait costs nothing: the next one asks for
 * the approval again or waits for the editor again.
 *
 * Each call is replay-safe at the harness's level and never runs twice: once
 * a daemon says it is past the gate, that is recorded (memo "started") before
 * the daemon is told to go. A call whose run was told to go and never
 * answered has an unknown outcome, and the daemon reports it as one.
 *
 * The agent tool starts the subagent: the daemon gives it its slot and what it
 * runs with, and the harness runs its conversation (pi.ts runSubagent).
 *
 * This module is loaded again from a newer Studio's bundle when that Studio's
 * daemon connects, and installed over the running one (registry.install):
 * calls already running finish on the code they started with.
 */
import type { Kit } from "./pi.js";
import type { AgentStart, ToolDef } from "./protocol.js";
import type { ToolExecution } from "../tools.js";

/** This extension's version: a newer Studio's daemon installs its own over it. */
export const EXTENSION_NAME = "studio";

/** Studio's tool outputs are bounded by their own executors; the harness keeps all of what they return. */
const OUTPUT_LIMITS = { maxBytes: 2_000_000, maxLines: 100_000, retain: "head" as const };

const text = (t: string) => [{ type: "text" as const, text: t }];

export function createStudioExtension(kit: Kit, defs: ToolDef[]) {
  const tools = defs.map((d) => {
    if (d.name === "agent") {
      return kit.defineTool({
        name: d.name,
        description: d.description,
        parameters: d.input_schema as never,
        // A rerun after a crash finds the same subagent conversation and the same prompt submission.
        replay: "safe",
        outputLimits: OUTPUT_LIMITS,
        execute: async (args: Record<string, unknown>, api: { conversationId: unknown; callId: string }, context: { abortSignal?: AbortSignal }) => {
          const where = kit.whereIs(String(api.conversationId));
          if (!where || where.parent) return { output: text("A subagent cannot start subagents of its own."), isError: true };
          const start = (await kit.request({ kind: "agent", sessionId: where.sessionId, callId: api.callId, input: args }, undefined, context.abortSignal)) as AgentStart;
          if (!start.ok) return { output: text(start.text), isError: true };
          const r = await kit.runSubagent(where.sessionId, api.callId, start, context.abortSignal);
          return { output: text(r.text), isError: r.isError };
        },
      } as never);
    }
    return kit.defineTool({
      name: d.name,
      description: d.description,
      parameters: d.input_schema as never,
      replay: "safe",
      outputLimits: OUTPUT_LIMITS,
      execute: async (args: Record<string, unknown>, api: { conversationId: unknown; callId: string; memo(name: string, ...a: unknown[]): Promise<unknown> }, context: { abortSignal?: AbortSignal }) => {
        const where = kit.whereIs(String(api.conversationId));
        if (!where) return { output: text("This conversation belongs to no Studio session."), isError: true };
        const started = (await api.memo("started", context)) === true;
        const exec = (await kit.request(
          { kind: "tool", sessionId: where.sessionId, conv: String(api.conversationId), parent: where.parent, callId: api.callId, name: d.name, input: args, started },
          async () => {
            await api.memo("started", true, context);
          },
          context.abortSignal,
        )) as ToolExecution;
        const output: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = text(exec.modelText ?? exec.text);
        for (const img of exec.images ?? []) output.push({ type: "image", data: img.data, mimeType: img.mediaType });
        return { output, isError: exec.isError, details: { outcome: exec.outcome } };
      },
    } as never);
  });
  // A harness before 0.1.35-beta.35 has no hooks to hand out: it runs the tools alone.
  const hooks = kit.hook && kit.GenerationTask && kit.searches ? [searchHook(kit)] : [];
  return kit.defineExtension({ name: EXTENSION_NAME, tools, hooks } as never);
}

/** The Messages API's own web search, which runs on Anthropic's side. */
const ANTHROPIC_SEARCH = { type: "web_search_20250305", name: "web_search", max_uses: 8 };

/**
 * The provider's own web search in one request body, in that API's format;
 * undefined for an API with none. Exported for the tests.
 */
export function withProviderSearch(api: string, payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  const add = (tools: unknown, tool: Record<string, unknown>, same: (t: Record<string, unknown>) => boolean): unknown[] => {
    const list = Array.isArray(tools) ? (tools as Array<Record<string, unknown>>) : [];
    return list.some(same) ? list : [...list, tool];
  };
  // The Claude sign-in's request body is the extra body Claude Code sends, in the Messages format (pi-claude-code's API is claude-code-stream-json).
  switch (api.startsWith("claude-code") ? "claude-code" : api) {
    case "anthropic-messages":
    case "claude-code":
      return { ...p, tools: add(p.tools, ANTHROPIC_SEARCH, (t) => String(t.type ?? "").startsWith("web_search")) };
    case "openai-responses":
      return { ...p, tools: add(p.tools, { type: "web_search" }, (t) => t.type === "web_search") };
    case "google-generative-ai": {
      const config = (p.config && typeof p.config === "object" ? p.config : {}) as Record<string, unknown>;
      return { ...p, config: { ...config, tools: add(config.tools, { googleSearch: {} }, (t) => "googleSearch" in t) } };
    }
    default:
      return undefined;
  }
}

/** A request refused because of the search tool, which some keys, accounts and models do not have. */
export const isSearchRefusal = (text: string | undefined): boolean =>
  !!text && /web.?search|google.?search|googleSearch|search tool|tool use with function calling is unsupported/i.test(text);

/**
 * The provider's own web search on every route that has one, paid by the
 * user's key or subscription: added to each request of a conversation whose
 * spec allows it. A provider that refuses it has it taken off for the rest of
 * this harness's life, and the refused request is sent again without it.
 */
/** Conversations whose search was logged: the extension is rebuilt at every configure. */
const told = new Set<string>();

function searchHook(kit: Kit) {
  return kit.hook!(kit.GenerationTask!, {
    beforeProviderRequest: (request: { model: { api: string; provider: string }; payload: unknown }, api: { conversationId: unknown }) => {
      const conv = String(api.conversationId);
      if (!kit.searches!(conv) || kit.searchRefused?.(request.model.provider)) return undefined;
      const payload = withProviderSearch(request.model.api, request.payload);
      if (payload !== undefined && !told.has(conv)) {
        told.add(conv);
        kit.log?.(`conversation ${conv}: ${request.model.provider}'s own web search goes with its requests`);
      }
      return payload === undefined ? undefined : { payload };
    },
    afterResponse: (message: { stopReason: string; errorMessage?: string; provider: string }, api: { conversationId: unknown }) => {
      if (message.stopReason !== "error" || !kit.searches!(String(api.conversationId)) || kit.searchRefused?.(message.provider)) return;
      if (!isSearchRefusal(message.errorMessage)) return;
      kit.refuseSearch?.(message.provider);
      // Worded so the harness's retry policy sends it again, now without the search.
      message.errorMessage = `${message.errorMessage} (Studio turned this provider's web search off; you can retry your request.)`;
    },
  } as never);
}

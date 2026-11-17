/**
 * Studio's tools on the durable runtime, as one Pi Durable extension.
 *
 * Studio's local tools (shell, files, search, web fetch) run here in the
 * harness on Studio's own executors, with the daemon's approval gate as a
 * beforeTool hook (#463 L3), so a daemon that dies mid-command no longer
 * leaves its outcome unknown. Every other tool (ue-mcp, the editor restart,
 * skills, a subagent's reply), and every tool on a harness without tool
 * hooks, runs in the daemon, through its editor wait, its approval gate and
 * its executor. The
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
import type { AgentStart, LocalGate, LocalOutcome, ToolDef } from "./protocol.js";
import type { ToolExecution } from "../tools.js";
import { CHANGING_TOOLS, isLocalTool, runLocal, type LocalToolName } from "../local-tools.js";

/** This extension's version: a newer Studio's daemon installs its own over it. */
export const EXTENSION_NAME = "studio";

/** Studio's tool outputs are bounded by their own executors; the harness keeps all of what they return. */
const OUTPUT_LIMITS = { maxBytes: 2_000_000, maxLines: 100_000, retain: "head" as const };

const text = (t: string) => [{ type: "text" as const, text: t }];

/** What a subagent that asks for a subagent is told: not here, and how to get one. */
export const SUBAGENT_CANNOT_NEST = "A subagent cannot start subagents of its own. Do what you can yourself, then end your report with a line \"NEEDS SUBAGENT: <description>: <the complete prompt>\" for each one you need; the agent that started you will run them.";

export function createStudioExtension(kit: Kit, defs: ToolDef[]) {
  // #463 L3: local tools run here when the harness offers its tool task (for the approval hook) and the project folder.
  const local = !!(kit.hook && kit.ToolTask && kit.projectDir);
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
          if (!where || where.parent) return { output: text(SUBAGENT_CANNOT_NEST), isError: true };
          const start = (await kit.request({ kind: "agent", sessionId: where.sessionId, callId: api.callId, input: args }, undefined, context.abortSignal)) as AgentStart;
          if (!start.ok) return { output: text(start.text), isError: true };
          const r = await kit.runSubagent(where.sessionId, api.callId, start, context.abortSignal);
          return { output: text(r.text), isError: r.isError };
        },
      } as never);
    }
    if (local && isLocalTool(d.name)) return localTool(kit, d, d.name);
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
  const hooks = [...(kit.hook && kit.GenerationTask && kit.searches ? [searchHook(kit)] : []), ...(local ? [approvalHook(kit)] : [])];
  return kit.defineExtension({ name: EXTENSION_NAME, tools, hooks } as never);
}

/** Local tools that only read: one cut off by a harness stop runs again. The others change things, and are reported unknown instead. */
const READ_ONLY = new Set<string>(["read_file", "glob", "grep", "web_fetch"]);

type HookApi = { conversationId: unknown; memo(name: string, ...a: unknown[]): Promise<unknown> };

/**
 * The daemon's approval gate as a beforeTool hook on Pi Durable's tool task,
 * for the local tools only: the same card, the same "allow for this session"
 * and project-folder rule, and the input check. The answer is memoized, so a
 * harness restart never asks twice; a denial or a stop blocks the call with
 * the daemon's own words.
 */
function approvalHook(kit: Kit) {
  return kit.hook!(kit.ToolTask!, {
    beforeTool: async (call: { id: string; name: string; arguments: Record<string, unknown> }, api: HookApi, context: { abortSignal?: AbortSignal }) => {
      if (!isLocalTool(call.name)) return undefined;
      const where = kit.whereIs(String(api.conversationId));
      if (!where) return { block: "This conversation belongs to no Studio session." };
      let gate = (await api.memo("studio.gate", context)) as LocalGate | undefined;
      if (!gate) {
        const asked = (await kit.request({ kind: "gate", sessionId: where.sessionId, parent: where.parent, callId: call.id, name: call.name, input: call.arguments ?? {} }, undefined, context.abortSignal)) as LocalGate;
        gate = (await api.memo("studio.gate", asked, context)) as LocalGate;
      }
      return gate.allow ? undefined : { block: gate.text };
    },
  } as never);
}

/**
 * A local tool run here, in the harness, on Studio's own executor: a daemon
 * that dies mid-run no longer makes its outcome unknown. The result is
 * memoized before the daemon is told, and the daemon records it as every
 * route does (finished). A run the harness itself was cut off in runs again
 * when it only reads, and is reported unknown when it changes things.
 */
function localTool(kit: Kit, d: ToolDef, name: LocalToolName) {
  return kit.defineTool({
    name: d.name,
    description: d.description,
    parameters: d.input_schema as never,
    replay: "safe",
    outputLimits: OUTPUT_LIMITS,
    execute: async (args: Record<string, unknown>, api: HookApi & { callId: string }, context: { abortSignal?: AbortSignal }) => {
      const where = kit.whereIs(String(api.conversationId));
      if (!where) return { output: text("This conversation belongs to no Studio session."), isError: true };
      let result = (await api.memo("studio.result", context)) as LocalOutcome | undefined;
      if (!result) {
        if ((await api.memo("studio.running", context)) === true && !READ_ONLY.has(name)) {
          result = { text: "Studio's background runtime stopped while this call was running, so whether it took effect is unknown. Check before running it again.", isError: true, outcome: "unknown" };
        } else {
          await api.memo("studio.running", true, context);
          const r = await runLocal(kit.projectDir!, name, args, context.abortSignal, (t) => kit.output?.(where.sessionId, api.callId, t));
          result = { text: r.text, isError: r.isError, outcome: r.isError ? "error" : "done", ...(!r.isError && CHANGING_TOOLS.includes(name) ? { changed: true } : {}), ...(r.images?.length ? { images: r.images } : {}) };
        }
        result = (await api.memo("studio.result", result, context)) as LocalOutcome;
      }
      const exec = (await kit.request({ kind: "finished", sessionId: where.sessionId, parent: where.parent, callId: api.callId, name, input: args, result }, undefined, context.abortSignal)) as ToolExecution;
      const output: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = text(exec.modelText ?? exec.text);
      for (const img of exec.images ?? []) output.push({ type: "image", data: img.data, mimeType: img.mediaType });
      return { output, isError: exec.isError, details: { outcome: exec.outcome } };
    },
  } as never);
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

/**
 * The model a flow's agent step runs on: the one the user picked in Studio,
 * on the route Studio runs it on (the Claude sign-in, the UE-MCP account, a
 * ChatGPT sign-in or a vendor key). Registered with the daemon so a flow such
 * as the built-in playtest flow drafts with the same model as the chat.
 *
 * Every route answers with text only: no tools, the JSON Schema in the system
 * prompt, and the JSON parsed out of the answer. The flow validates it.
 */
import type { Effort } from "@ue-mcp-studio/shared";
import type { MessageParam, ModelProvider } from "./providers.js";
import type { TokenUsage } from "./usage.js";

/** Set by the release bundle: false leaves the Agent SDK out of it. Unset in development and tests. */
declare const __CLAUDE_SIGN_IN__: boolean | undefined;

/** One completion as a flow's agent step asks for it. */
export interface FlowCompletionRequest {
  system?: string;
  /** A single user message, when `messages` is not given. */
  prompt?: string;
  messages?: Array<{ role: string; content: string }>;
  /** JSON Schema the answer must match. */
  schema?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface FlowCompletionResponse {
  text: string;
  /** The answer's JSON, when it has one. */
  parsed?: unknown;
  /** The model that answered. */
  model?: string;
  finishReason?: string;
}

export interface FlowModelOptions {
  projectDir: string;
  model: () => string;
  effort: () => Effort;
  /** True while the selected model runs on the user's Claude sign-in. */
  subscription: () => boolean;
  /** The provider for every other route. Throws with how to connect one when none can run the model. */
  provider: () => ModelProvider;
  /** One flow step's call, for the usage ledger. */
  record?: (model: string, usage: TokenUsage | undefined, durationMs: number) => void;
}

/** The system prompt's line that asks for JSON matching the schema. */
export function schemaInstruction(schema: Record<string, unknown>): string {
  return [
    "Answer with one JSON value that matches this JSON Schema, and nothing else: no prose and no code fence.",
    JSON.stringify(schema),
  ].join("\n");
}

/** The JSON in a model's answer: the whole text, a fenced block, or the outermost object or array. */
export function parseJsonAnswer(text: string): unknown {
  const tries: string[] = [text.trim()];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) tries.push(fence[1].trim());
  for (const [open, close] of [["{", "}"], ["[", "]"]] as const) {
    const a = text.indexOf(open);
    const b = text.lastIndexOf(close);
    if (a >= 0 && b > a) tries.push(text.slice(a, b + 1));
  }
  for (const t of tries) {
    try {
      return JSON.parse(t);
    } catch {
      // the next shape
    }
  }
  return undefined;
}

/** The conversation as the Messages format; a role the format has no place for is sent as the user's. */
function messagesOf(req: FlowCompletionRequest): MessageParam[] {
  const list = req.messages?.length ? req.messages : [{ role: "user", content: req.prompt ?? "" }];
  const out: MessageParam[] = [];
  for (const m of list) {
    if (m.role === "system") continue;
    const role = m.role === "assistant" ? "assistant" : "user";
    const last = out[out.length - 1];
    // Roles alternate in the Messages format: consecutive turns of one role are one message.
    if (last?.role === role) (last.content as Array<{ type: "text"; text: string }>).push({ type: "text", text: m.content });
    else out.push({ role, content: [{ type: "text", text: m.content }] });
  }
  return out;
}

/** The conversation as one prompt, for the Claude sign-in, which takes a single message. */
function promptOf(req: FlowCompletionRequest): string {
  if (!req.messages?.length) return req.prompt ?? "";
  if (req.messages.length === 1) return req.messages[0].content;
  return req.messages
    .filter((m) => m.role !== "system")
    .map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`)
    .join("\n\n");
}

/** The system prompt the request carries, with its own system messages and the schema line. */
function systemOf(req: FlowCompletionRequest): string {
  const parts = [req.system ?? "", ...(req.messages ?? []).filter((m) => m.role === "system").map((m) => m.content)];
  if (req.schema) parts.push(schemaInstruction(req.schema));
  return parts.filter((p) => p.trim()).join("\n\n");
}

/** The part of the daemon's extension API that takes a model provider (API 2, feature "models.provider"). */
export interface ModelHost {
  models?: { register(provider: { complete(req: FlowCompletionRequest): Promise<FlowCompletionResponse> }): () => void };
}

/**
 * Make Studio's model the one flow agent steps run on. A daemon without the
 * hook keeps its own; the function returned takes the registration back.
 */
export function registerFlowModel(host: ModelHost, o: FlowModelOptions): () => void {
  if (typeof host.models?.register !== "function") return () => {};
  return host.models.register(studioFlowModel(o));
}

/** A flow model provider backed by Studio's selected model and route. */
export function studioFlowModel(o: FlowModelOptions): { complete(req: FlowCompletionRequest): Promise<FlowCompletionResponse> } {
  return {
    async complete(req) {
      const model = o.model();
      const system = systemOf(req);
      const signal = req.signal ?? new AbortController().signal;
      const started = Date.now();
      let text: string;
      if (o.subscription()) {
        // A dynamic import the bundler drops when the sign-in is off, and the Agent SDK with it.
        const sdk = typeof __CLAUDE_SIGN_IN__ === "undefined" || __CLAUDE_SIGN_IN__ ? await import("./subscription.js") : null;
        if (!sdk) throw new Error("This Studio build does not include the Claude sign-in.");
        const r = await sdk.runSubscriptionCompletion({ projectDir: o.projectDir, model, effort: o.effort(), system, prompt: promptOf(req), signal });
        if ("error" in r) throw new Error(r.error);
        text = r.text;
        o.record?.(model, r.usage, Date.now() - started);
      } else {
        const turn = await o.provider().run(
          { sessionId: "flow", model, effort: o.effort(), system: [{ type: "text", text: system }], tools: [], search: false, messages: messagesOf(req) },
          () => {},
          signal,
        );
        o.record?.(model, turn.usage, Date.now() - started);
        if (turn.stopReason === "refusal") throw new Error(`The model declined: ${turn.refusal ?? "no reason given"}`);
        text = turn.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
      }
      const parsed = req.schema ? parseJsonAnswer(text) : undefined;
      return { text, model, finishReason: "stop", ...(parsed !== undefined ? { parsed } : {}) };
    },
  };
}

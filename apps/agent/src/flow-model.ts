/**
 * The model a flow's agent step runs on: the one the user picked in Studio,
 * on the route Studio runs it on (the Claude sign-in, the UE-MCP account, a
 * ChatGPT sign-in or a vendor key). Registered with the daemon so a flow such
 * as the built-in playtest flow drafts with the same model as the chat.
 *
 * The durable harness answers it, as it runs every conversation: one answer,
 * no tools, the JSON Schema in the system prompt, and the JSON parsed out of
 * the answer. The flow validates it.
 */
import type { Effort } from "@ue-mcp-studio/shared";
import { required } from "./backend.js";

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
  model: () => string;
  effort: () => Effort;
  /** One answer from the selected model on its route, in the durable harness. Throws with why when none can be had. */
  complete: (system: string, prompt: string, effort: Effort, signal: AbortSignal) => Promise<string>;
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

/** The conversation as one prompt: the harness sends a single user message on every route. */
export function promptOf(req: FlowCompletionRequest): string {
  if (!req.messages?.length) return req.prompt ?? "";
  if (req.messages.length === 1) return req.messages[0].content;
  return req.messages
    .filter((m) => m.role !== "system")
    .map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`)
    .join("\n\n");
}

/** The system prompt the request carries, with its own system messages and the schema line. */
export function systemOf(req: FlowCompletionRequest): string {
  const parts = [req.system ?? "", ...(req.messages ?? []).filter((m) => m.role === "system").map((m) => m.content)];
  if (req.schema) parts.push(schemaInstruction(req.schema));
  return parts.filter((p) => p.trim()).join("\n\n");
}

/** The part of the daemon's extension API that takes a model provider. */
export interface ModelHost {
  models?: { register(provider: { complete(req: FlowCompletionRequest): Promise<FlowCompletionResponse> }): () => void };
}

/** Make Studio's model the one flow agent steps run on; the function returned takes the registration back. */
export function registerFlowModel(host: ModelHost, o: FlowModelOptions): () => void {
  return required(host.models, "models").register(studioFlowModel(o));
}

/** A flow model provider backed by Studio's selected model and route. */
export function studioFlowModel(o: FlowModelOptions): { complete(req: FlowCompletionRequest): Promise<FlowCompletionResponse> } {
  return {
    async complete(req) {
      const model = o.model();
      const signal = req.signal ?? new AbortController().signal;
      const text = await o.complete(systemOf(req), promptOf(req), o.effort(), signal);
      const parsed = req.schema ? parseJsonAnswer(text) : undefined;
      return { text, model, finishReason: "stop", ...(parsed !== undefined ? { parsed } : {}) };
    },
  };
}

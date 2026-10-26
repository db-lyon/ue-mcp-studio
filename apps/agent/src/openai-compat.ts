/**
 * OpenAI's Chat Completions API, and Google's Gemini through its OpenAI
 * compatible endpoint. The agent keeps every conversation in the Messages
 * format, so a session can change models mid-way; this file translates a
 * request out and the streamed answer back.
 */
import type { ContentBlock, ModelProvider, ModelRequest, ModelTurn, MessageParam } from "./providers.js";
import { geminiEffort, openaiEffort } from "./effort.js";
import { openaiUsage, type TokenUsage } from "./usage.js";

export const OPENAI_BASE_URLS = {
  openai: "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
} as const;

type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  /** Provider data that must come back with the call, such as Gemini's thought signature. */
  extra_content?: unknown;
}

/**
 * Where a tool_use block keeps a provider's extra_content between turns. Only
 * this file reads it, and requestBody strips it before a Messages request.
 */
export const PROVIDER_EXTRA = "provider_extra";

type Block = { type: string; [k: string]: unknown };

const blocksOf = (content: MessageParam["content"]): Block[] =>
  typeof content === "string" ? [{ type: "text", text: content }] : (content as unknown as Block[]);

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return (content as Block[]).filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("\n");
  return "";
};

/** The base64 images among Messages content blocks, as data URL parts. */
const imagesOf = (content: unknown): Array<{ type: "image_url"; image_url: { url: string } }> =>
  (Array.isArray(content) ? (content as Block[]) : []).flatMap((b) => {
    const src = b.source as { type?: string; media_type?: string; data?: string } | undefined;
    return b.type === "image" && src?.type === "base64" ? [{ type: "image_url" as const, image_url: { url: `data:${src.media_type};base64,${src.data}` } }] : [];
  });

/** The request in Chat Completions form. Tool results become tool messages, ahead of any text sent with them. */
export function toChatRequest(req: ModelRequest): Record<string, unknown> {
  const messages: ChatMessage[] = [{ role: "system", content: req.system.map((b) => b.text).join("\n\n") }];
  for (const m of req.messages) {
    const blocks = blocksOf(m.content);
    if (m.role === "assistant") {
      const text = blocks.filter((b) => b.type === "text").map((b) => String(b.text)).join("");
      const calls: ChatToolCall[] = blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => ({
          id: String(b.id),
          type: "function",
          function: { name: String(b.name), arguments: JSON.stringify(b.input ?? {}) },
          ...(b[PROVIDER_EXTRA] !== undefined ? { extra_content: b[PROVIDER_EXTRA] } : {}),
        }));
      messages.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // A tool message carries text only: images a tool returned follow in a user message, after every tool message.
    const toolImages: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [];
    for (const b of blocks) {
      if (b.type !== "tool_result") continue;
      const body = textOf(b.content);
      messages.push({ role: "tool", tool_call_id: String(b.tool_use_id), content: b.is_error ? `Error: ${body}` : body });
      const shown = imagesOf(b.content);
      if (shown.length) toolImages.push({ type: "text", text: `[Studio] The image${shown.length === 1 ? "" : "s"} the ${String(b.tool_use_id)} call returned:` }, ...shown);
    }
    const text = blocks.filter((b) => b.type === "text").map((b) => String(b.text)).join("\n");
    // Images go along as data URLs; a PDF is known to the model by the path in its note.
    const images = imagesOf(blocks);
    if (images.length || toolImages.length) messages.push({ role: "user", content: [...toolImages, ...(text ? [{ type: "text" as const, text }] : []), ...images] });
    else if (text) messages.push({ role: "user", content: text });
  }
  const tools = req.tools.map((t) => {
    const tool = t as { name: string; description?: string; input_schema?: unknown };
    return { type: "function", function: { name: tool.name, description: tool.description ?? "", parameters: tool.input_schema ?? { type: "object" } } };
  });
  const effort = openaiEffort(req.model, req.effort) ?? geminiEffort(req.model, req.effort);
  return { model: req.model, messages, ...(tools.length ? { tools } : {}), ...(effort ? { reasoning_effort: effort } : {}), stream: true, stream_options: { include_usage: true } };
}

const STOP: Record<string, string> = { tool_calls: "tool_use", stop: "end_turn", length: "max_tokens", content_filter: "refusal" };

/** Tool ids must match the Messages pattern so the session stays valid on any provider. */
const toolId = (id: string | undefined, i: number): string => {
  const clean = (id ?? "").replace(/[^a-zA-Z0-9_-]/g, "_");
  return clean || `call_${Date.now().toString(36)}_${i}`;
};

interface Delta {
  content?: string | null;
  tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string }; extra_content?: unknown }>;
}

/** Fold a Chat Completions stream (its data lines) into one turn in the Messages form. */
export async function readChatStream(lines: AsyncIterable<string>, onText: (text: string) => void): Promise<ModelTurn> {
  let text = "";
  let finish: string | null = null;
  let usage: TokenUsage | undefined;
  const calls: Array<{ id?: string; name: string; args: string; extra?: unknown }> = [];
  for await (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") break;
    const chunk = JSON.parse(data) as { choices?: Array<{ delta?: Delta; finish_reason?: string | null }>; usage?: unknown };
    // With include_usage the last chunk carries the usage and no choices.
    if (chunk.usage) usage = openaiUsage(chunk.usage);
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const d = choice.delta ?? {};
    if (d.content) {
      text += d.content;
      onText(d.content);
    }
    for (const tc of d.tool_calls ?? []) {
      const c = (calls[tc.index] ??= { name: "", args: "" });
      if (tc.id) c.id = tc.id;
      if (tc.function?.name) c.name += tc.function.name;
      if (tc.function?.arguments) c.args += tc.function.arguments;
      if (tc.extra_content !== undefined) c.extra = tc.extra_content;
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }
  const content: Block[] = [];
  if (text) content.push({ type: "text", text, citations: null });
  calls.filter(Boolean).forEach((c, i) => {
    let input: unknown = {};
    try {
      input = c.args ? JSON.parse(c.args) : {};
    } catch {
      input = { _unparsed: c.args };
    }
    content.push({ type: "tool_use", id: toolId(c.id, i), name: c.name, input, ...(c.extra !== undefined ? { [PROVIDER_EXTRA]: c.extra } : {}) });
  });
  // Some endpoints finish a tool call with "stop"; the calls decide.
  const stopReason = calls.length > 0 ? "tool_use" : finish ? (STOP[finish] ?? "end_turn") : "end_turn";
  return {
    content: content as unknown as ContentBlock[],
    stopReason,
    refusal: stopReason === "refusal" ? "the provider's content filter" : undefined,
    ...(usage ? { usage } : {}),
  };
}

export async function* sseLines(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buf.indexOf("\n")) >= 0) {
      yield buf.slice(0, cut).replace(/\r$/, "");
      buf = buf.slice(cut + 1);
    }
  }
  if (buf) yield buf;
}

export class OpenAICompatibleProvider implements ModelProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async run(req: ModelRequest, onText: (text: string) => void, signal: AbortSignal): Promise<ModelTurn> {
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      signal,
      // A local endpoint may take no key: it then gets no authorization header at all.
      headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify(toChatRequest(req)),
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`${res.status} ${text.slice(0, 300)}`);
    }
    return readChatStream(sseLines(res.body), onText);
  }
}

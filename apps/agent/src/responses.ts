/**
 * OpenAI's Responses API, for a ChatGPT sign-in: the account's plan pays for
 * the calls. Sessions are kept in the Messages format; this translates them to
 * Responses input items and reads the event stream back into content blocks.
 * Every request is sent with store: false and stream: true, as plan usage
 * requires, and a turn counts only once response.completed arrives.
 */
import { isSearchRefusal, type ContentBlock, type ModelProvider, type ModelRequest, type ModelTurn, type WebSearchRecord } from "./providers.js";
import { sseLines } from "./openai-compat.js";
import { openaiEffort, withEffort } from "./effort.js";

export const RESPONSES_URL = "https://api.openai.com/v1/responses";

type Block = { type: string; [k: string]: unknown };

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => (c as { text?: string }).text ?? "").join("") : "";

/** The Responses request for one turn; with search, OpenAI's own web search goes with Studio's tools. */
export function toResponsesRequest(req: ModelRequest, search = false): Record<string, unknown> {
  const input: unknown[] = [];
  for (const m of req.messages) {
    const blocks: Block[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as unknown as Block[]);
    if (m.role === "assistant") {
      const text = blocks.filter((b) => b.type === "text").map((b) => String(b.text)).join("");
      if (text) input.push({ role: "assistant", content: [{ type: "output_text", text }] });
      for (const b of blocks) {
        if (b.type === "tool_use") input.push({ type: "function_call", call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
      }
      continue;
    }
    // A tool result goes first, as the function call's output; then anything the user said with it.
    for (const b of blocks) {
      if (b.type === "tool_result") input.push({ type: "function_call_output", call_id: b.tool_use_id, output: b.is_error ? `Error: ${textOf(b.content)}` : textOf(b.content) });
    }
    const parts: unknown[] = [];
    for (const b of blocks) {
      const src = b.source as { type?: string; media_type?: string; data?: string } | undefined;
      if (b.type === "text") parts.push({ type: "input_text", text: String(b.text) });
      else if (b.type === "image" && src?.type === "base64") parts.push({ type: "input_image", image_url: `data:${src.media_type};base64,${src.data}` });
      else if (b.type === "document" && src?.type === "base64") parts.push({ type: "input_file", filename: "document.pdf", file_data: `data:${src.media_type};base64,${src.data}` });
    }
    if (parts.length) input.push({ role: "user", content: parts });
  }
  const tools = req.tools.map((t) => {
    const tool = t as { name: string; description?: string; input_schema?: unknown };
    return { type: "function", name: tool.name, description: tool.description ?? "", parameters: tool.input_schema ?? { type: "object" } } as Record<string, unknown>;
  });
  if (search) tools.push({ type: "web_search" });
  return {
    model: req.model,
    instructions: req.system.map((b) => b.text).join("\n\n"),
    input,
    tools,
    ...withEffort("reasoning", openaiEffort(req.model, req.effort)),
    store: false,
    stream: true,
  };
}

/** Why a plan-usage request stopped, in words the panel can show. */
const USAGE_ERRORS: Record<string, string> = {
  subscription_sharing_usage_limit_exceeded: "Your ChatGPT plan's usage limit is reached for now.",
  subscription_sharing_usage_unavailable: "Your ChatGPT plan's usage is not available to other apps right now.",
};

/** Fold a Responses event stream into one turn. Rejects unless the stream ends in response.completed. */
export async function readResponsesStream(lines: AsyncIterable<string>, onText: (text: string) => void): Promise<ModelTurn> {
  const content: ContentBlock[] = [];
  const searches: WebSearchRecord[] = [];
  let completed = false;
  for await (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    const e = JSON.parse(data) as { type: string; delta?: string; item?: Block; response?: { error?: { code?: string; message?: string }; incomplete_details?: { reason?: string } } };
    if (e.type === "response.output_text.delta" && e.delta) onText(e.delta);
    else if (e.type === "response.output_item.done" && e.item) {
      const it = e.item;
      if (it.type === "message") {
        const text = ((it.content as Array<{ type: string; text?: string; refusal?: string }>) ?? [])
          .map((c) => (c.type === "output_text" ? c.text ?? "" : c.type === "refusal" ? c.refusal ?? "" : ""))
          .join("");
        if (text) content.push({ type: "text", text, citations: null } as unknown as ContentBlock);
      } else if (it.type === "web_search_call") {
        // The search ran on OpenAI's side; only the transcript keeps it.
        const action = (it.action ?? {}) as { query?: string; sources?: Array<{ url?: string; title?: string }> };
        searches.push({
          id: String(it.id ?? `ws_${searches.length}`),
          query: action.query ?? "",
          results: (action.sources ?? []).map((x) => ({ title: x.title ?? "", url: x.url ?? "" })),
          ...(it.status === "failed" ? { error: "the search failed" } : {}),
        });
      } else if (it.type === "function_call") {
        let input: unknown = {};
        try {
          input = JSON.parse(String(it.arguments ?? "{}"));
        } catch {
          input = { _unparsed: it.arguments };
        }
        content.push({ type: "tool_use", id: String(it.call_id), name: String(it.name), input } as unknown as ContentBlock);
      }
    } else if (e.type === "response.completed") {
      completed = true;
    } else if (e.type === "response.failed" || e.type === "error") {
      const err = e.response?.error ?? (e as unknown as { error?: { code?: string; message?: string } }).error;
      throw new Error((err?.code && USAGE_ERRORS[err.code]) ?? `ChatGPT: ${err?.message ?? err?.code ?? "the response failed"}`);
    } else if (e.type === "response.incomplete") {
      throw new Error(`ChatGPT stopped before finishing (${e.response?.incomplete_details?.reason ?? "incomplete"}).`);
    }
  }
  if (!completed) throw new Error("The ChatGPT response ended before it completed.");
  return { content, stopReason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", searches };
}

export class ResponsesProvider implements ModelProvider {
  constructor(
    private readonly accessToken: () => Promise<string>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Off once the endpoint refused the native search; turns go on without it. */
  private search = true;

  async run(req: ModelRequest, onText: (text: string) => void, signal: AbortSignal): Promise<ModelTurn> {
    try {
      return await this.request(req, onText, signal);
    } catch (e) {
      if (!this.search || !isSearchRefusal(e)) throw e;
      this.search = false;
      return this.request(req, onText, signal);
    }
  }

  private async request(req: ModelRequest, onText: (text: string) => void, signal: AbortSignal): Promise<ModelTurn> {
    const res = await this.fetchImpl(RESPONSES_URL, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${await this.accessToken()}` },
      body: JSON.stringify(toResponsesRequest(req, this.search)),
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      let message = text;
      try {
        message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text;
      } catch {
        // Not JSON: show it as it came.
      }
      throw Object.assign(new Error(`ChatGPT ${res.status}: ${message.slice(0, 300)}`), { status: res.status });
    }
    return readResponsesStream(sseLines(res.body), onText);
  }
}

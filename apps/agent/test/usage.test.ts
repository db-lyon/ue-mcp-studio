/** Each provider's token usage, as a playtest loop's budget counts it. */
import { describe, expect, it } from "vitest";
import { messagesUsage, openaiUsage, usageTokens } from "../src/usage.js";
import { readChatStream } from "../src/openai-compat.js";
import { readResponsesStream } from "../src/responses.js";

async function* lines(...l: string[]): AsyncIterable<string> {
  for (const x of l) yield x;
}

describe("token usage", () => {
  it("counts Messages input with cache writes and without cache reads", () => {
    const u = messagesUsage({ input_tokens: 100, cache_creation_input_tokens: 50, cache_read_input_tokens: 9000, output_tokens: 20 });
    expect(u).toEqual({ input: 150, output: 20, kinds: { input: 100, cacheRead: 9000, cacheWrite: 50, output: 20 } });
    expect(usageTokens(u)).toBe(170);
    expect(messagesUsage(null)).toBeUndefined();
    expect(usageTokens(undefined)).toBe(0);
  });

  it("leaves the cached part of an OpenAI prompt out", () => {
    expect(openaiUsage({ prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 800 }, completion_tokens: 30 })).toEqual({ input: 200, output: 30, kinds: { input: 200, cacheRead: 800, cacheWrite: null, output: 30 } });
    expect(openaiUsage({ input_tokens: 70, input_tokens_details: { cached_tokens: 10 }, output_tokens: 5 })).toEqual({ input: 60, output: 5, kinds: { input: 60, cacheRead: 10, cacheWrite: null, output: 5 } });
  });

  it("reports a kind the vendor leaves out as not reported, never as zero", () => {
    // No cached_tokens at all: the vendor said nothing about cache reads.
    expect(openaiUsage({ prompt_tokens: 50, completion_tokens: 5 })!.kinds).toEqual({ input: 50, cacheRead: null, cacheWrite: null, output: 5 });
  });

  it("reads the usage chunk that ends a Chat Completions stream", async () => {
    const turn = await readChatStream(lines(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] })}`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } })}`,
      "data: [DONE]",
    ), () => {});
    expect(turn.usage).toMatchObject({ input: 12, output: 3, kinds: { input: 12, cacheRead: null, cacheWrite: null, output: 3 } });
  });

  it("reads the usage of a completed Responses stream", async () => {
    const turn = await readResponsesStream(lines(
      `data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "ok" }] } })}`,
      `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 40, output_tokens: 4 } } })}`,
    ), () => {});
    expect(turn.usage).toMatchObject({ input: 40, output: 4, kinds: { input: 40, cacheRead: null, cacheWrite: null, output: 4 } });
  });
});

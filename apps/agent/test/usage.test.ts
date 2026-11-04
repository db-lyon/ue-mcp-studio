/** Each provider's token usage, as a turn counts it. */
import { describe, expect, it } from "vitest";
import { messagesUsage, openaiUsage, promptTokens, usageGrowth, usageTokens } from "../src/usage.js";
import { readChatStream } from "../src/openai-compat.js";
import { readResponsesStream } from "../src/responses.js";

async function* lines(...l: string[]): AsyncIterable<string> {
  for (const x of l) yield x;
}

describe("token usage", () => {
  it("counts Messages input with cache writes and without cache reads", () => {
    const u = messagesUsage({ input_tokens: 100, cache_creation_input_tokens: 50, cache_read_input_tokens: 9000, output_tokens: 20 });
    expect(u).toEqual({ input: 150, output: 20, cacheRead: 9000, cacheWrite: 50 });
    // The context the next request starts from counts the cache reads; the spend does not.
    expect(promptTokens(u!)).toBe(9150);
    expect(usageTokens(u)).toBe(170);
    expect(messagesUsage(null)).toBeUndefined();
    expect(usageTokens(undefined)).toBe(0);
  });

  it("leaves the cached part of an OpenAI prompt out", () => {
    expect(openaiUsage({ prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 800 }, completion_tokens: 30 })).toEqual({ input: 200, output: 30, cacheRead: 800, reasoning: 0 });
    expect(openaiUsage({ input_tokens: 70, input_tokens_details: { cached_tokens: 10 }, output_tokens: 5 })).toEqual({ input: 60, output: 5, cacheRead: 10, reasoning: 0 });
  });

  it("reads reasoning inside the output on Chat Completions (OpenAI, Google, endpoints) and Responses (ChatGPT)", () => {
    expect(openaiUsage({ prompt_tokens: 500, completion_tokens: 300, completion_tokens_details: { reasoning_tokens: 220 } })).toMatchObject({ output: 300, reasoning: 220 });
    expect(openaiUsage({ input_tokens: 500, output_tokens: 90, output_tokens_details: { reasoning_tokens: 64 } })).toMatchObject({ output: 90, reasoning: 64 });
    // An endpoint that reports less than it says was cached never goes negative.
    expect(openaiUsage({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens: 1 })).toMatchObject({ input: 0, cacheRead: 10 });
  });

  it("takes each field's growth when the same message is reported again", () => {
    const first = messagesUsage({ input_tokens: 10, cache_read_input_tokens: 900, output_tokens: 5 })!;
    const again = messagesUsage({ input_tokens: 10, cache_read_input_tokens: 900, output_tokens: 45 })!;
    expect(usageGrowth(again, first)).toEqual({ input: 0, output: 40, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
    expect(usageGrowth(first, undefined)).toMatchObject({ input: 10, output: 5, cacheRead: 900 });
  });


  it("reads the usage chunk that ends a Chat Completions stream", async () => {
    const turn = await readChatStream(lines(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] })}`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } })}`,
      "data: [DONE]",
    ), () => {});
    expect(turn.usage).toMatchObject({ input: 12, output: 3 });
  });

  it("reads the usage of a completed Responses stream", async () => {
    const turn = await readResponsesStream(lines(
      `data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "ok" }] } })}`,
      `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 40, output_tokens: 4 } } })}`,
    ), () => {});
    expect(turn.usage).toMatchObject({ input: 40, output: 4 });
  });
});

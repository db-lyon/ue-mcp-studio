/**
 * The Sign in with ChatGPT route on the durable runtime: pi-ai's Responses
 * API leaves out what the plan refuses only when it sees OpenAI's own
 * provider at api.openai.com and a token that is not an API key. Without
 * that, the plan answered every first request with
 * subscription_sharing_unsupported_capability (found by the live check).
 */
import { describe, expect, it } from "vitest";
import { asChatGpt, isChatGpt } from "../../src/durable/pi.js";
import { routeSpec } from "../../src/durable/routes.js";

const spec = (route: string, vendor = "openai") => routeSpec({ route, model: "gpt-6-luna", vendor, gatewayUrl: "https://gw.example", agentVersion: "0.0.0", endpoint: () => null } as never);

describe("the ChatGPT route", () => {
  it("is told apart from an OpenAI key and every other route", () => {
    expect(isChatGpt(spec("chatgpt"))).toBe(true);
    expect(isChatGpt(spec("key:openai"))).toBe(false);
    expect(isChatGpt(spec("key:anthropic", "anthropic"))).toBe(false);
  });

  it("hands pi-ai the model as OpenAI's, leaving the rest as it was", () => {
    const seen: unknown[][] = [];
    const s = asChatGpt({ stream: (...a: unknown[]) => seen.push(a), streamSimple: (...a: unknown[]) => seen.push(a) });
    const ctx = { messages: [] };
    s.stream({ id: "gpt-6-luna", provider: "chatgpt", baseUrl: "https://api.openai.com/v1" }, ctx, { apiKey: "token" });
    s.streamSimple({ id: "gpt-6-luna", provider: "chatgpt" }, ctx);
    expect(seen[0]).toEqual([{ id: "gpt-6-luna", provider: "openai", baseUrl: "https://api.openai.com/v1" }, ctx, { apiKey: "token" }]);
    expect((seen[1][0] as { provider: string }).provider).toBe("openai");
  });
});

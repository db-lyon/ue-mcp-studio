/**
 * The forced tool choice each provider sends when a request names the one
 * tool the model must call (a /playtest turn's pie): the provider's own form,
 * one call at most, and nothing beside it.
 */
import { describe, expect, it, vi } from "vitest";
import { AnthropicProvider, GatewayProvider, requestBody, type ModelRequest } from "../src/providers.js";
import { toChatRequest } from "../src/openai-compat.js";
import { toResponsesRequest } from "../src/responses.js";

const PIE = { name: "pie", description: "pie, script_create only", input_schema: { type: "object" as const, properties: {} } };
const forced = (model: string): ModelRequest => ({ sessionId: "s", model, system: [{ type: "text", text: "sys" }], tools: [PIE], forceTool: "pie", messages: [{ role: "user", content: "/playtest" }] });

describe("the forced tool choice each provider sends", () => {
  it("Anthropic: tool_choice tool pie, one call, where the model has a forced choice", () => {
    const body = requestBody(forced("claude-opus-5"));
    expect(body.tool_choice).toEqual({ type: "tool", name: "pie", disable_parallel_tool_use: true });
    expect((body.tools as Array<{ name: string }>).map((t) => t.name)).toEqual(["pie"]);
  });

  it("Anthropic: auto with one call, pie alone, on a model that refuses a forced choice", () => {
    expect(requestBody(forced("claude-opus-5-5")).tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
    expect(requestBody({ ...forced("claude-opus-5"), forceTool: undefined }).tool_choice).toBeUndefined();
  });

  it("Anthropic: no web search beside pie, and a 400 for the choice falls back to auto", async () => {
    const sent: Array<{ tool_choice?: unknown; tools: Array<{ name: string }> }> = [];
    const client = { beta: { messages: { stream: vi.fn((body: (typeof sent)[number]) => {
      sent.push(body);
      const refuse = (body.tool_choice as { type?: string } | undefined)?.type === "tool";
      return { on: () => {}, finalMessage: () => (refuse
        ? Promise.reject(Object.assign(new Error("400 tool_choice: type \"tool\" and \"any\" are not supported for this model."), { status: 400 }))
        : Promise.resolve({ content: [], stop_reason: "end_turn" })) };
    }) } } };
    await new AnthropicProvider("k", client as never).run(forced("claude-new-model"), () => {}, new AbortController().signal);
    expect(sent.map((b) => b.tool_choice)).toEqual([
      { type: "tool", name: "pie", disable_parallel_tool_use: true },
      { type: "auto", disable_parallel_tool_use: true },
    ]);
    expect(sent.every((b) => b.tools.map((t) => t.name).join() === "pie")).toBe(true);
  });

  it("the UE-MCP gateway: the same choice in its Messages body", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ content: [], stop_reason: "end_turn" }), { status: 200 });
    }) as unknown as typeof fetch;
    await new GatewayProvider("https://gw.example", "t", "0", fetchImpl).run(forced("claude-opus-5"), () => {}, new AbortController().signal);
    expect(body.tool_choice).toEqual({ type: "tool", name: "pie", disable_parallel_tool_use: true });
  });

  it("OpenAI Chat Completions: the pie function, one call", () => {
    const body = toChatRequest(forced("gpt-6.1"));
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "pie" } });
    expect(body.parallel_tool_calls).toBe(false);
    expect((body.tools as Array<{ function: { name: string } }>).map((t) => t.function.name)).toEqual(["pie"]);
    expect(toChatRequest({ ...forced("gpt-6.1"), forceTool: undefined }).tool_choice).toBeUndefined();
  });

  it("Gemini: the pie function, without the parallel flag its endpoint does not take", () => {
    const body = toChatRequest(forced("gemini-3-pro"));
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "pie" } });
    expect("parallel_tool_calls" in body).toBe(false);
  });

  it("ChatGPT (Responses): the pie function, one call, and no web search even when search is on", () => {
    const body = toResponsesRequest(forced("gpt-6.1"), true);
    expect(body.tool_choice).toEqual({ type: "function", name: "pie" });
    expect(body.parallel_tool_calls).toBe(false);
    expect((body.tools as Array<{ name?: string; type: string }>).map((t) => t.name ?? t.type)).toEqual(["pie"]);
  });
});

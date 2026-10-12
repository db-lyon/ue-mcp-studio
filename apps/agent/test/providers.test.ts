import { describe, expect, it, vi } from "vitest";
import { STUDIO_PLAN_AVAILABLE } from "@ue-mcp-studio/shared";
import { OpenAICompatibleProvider, PROVIDER_EXTRA, readChatStream, toChatRequest } from "../src/openai-compat.js";
import { AnthropicProvider, requestBody, searchesIn, type ModelRequest } from "../src/providers.js";
import { chatModels, signInsFor } from "../src/models.js";
import { StudioSignInFlow } from "../src/signin.js";
import { TOOLS } from "../src/tools.js";

async function* lines(chunks: unknown[]): AsyncIterable<string> {
  for (const c of chunks) yield `data: ${JSON.stringify(c)}`;
  yield "data: [DONE]";
}

const conversation: ModelRequest = {
  sessionId: "s",
  model: "gpt-6-sol",
  system: [{ type: "text", text: "sys" }],
  tools: TOOLS,
  messages: [
    { role: "user", content: [{ type: "text", text: "make a cube" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Searching." },
        { type: "tool_use", id: "call_1", name: "ue_mcp", input: { action: "search", query: "cube" }, [PROVIDER_EXTRA]: { google: { thought_signature: "sig" } } } as never,
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: "level.spawn_actor" },
        { type: "text", text: "[Studio] the editor restarted" },
      ],
    },
  ],
};

describe("OpenAI compatible translation", () => {
  it("sends the conversation as chat messages, tool results ahead of the text sent with them", () => {
    const body = toChatRequest(conversation) as { messages: Array<Record<string, unknown>>; tools: Array<{ function: { name: string } }> };
    expect(body.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "user"]);
    expect(body.messages[2]).toMatchObject({
      content: "Searching.",
      tool_calls: [{ id: "call_1", function: { name: "ue_mcp", arguments: JSON.stringify({ action: "search", query: "cube" }) }, extra_content: { google: { thought_signature: "sig" } } }],
    });
    expect(body.messages[3]).toEqual({ role: "tool", tool_call_id: "call_1", content: "level.spawn_actor" });
    expect(body.tools.map((t) => t.function.name)).toEqual(["ue_mcp", "editor_restart", "shell", "read_file", "write_file", "edit_file", "glob", "grep", "web_fetch", "agent"]);
  });

  it("never sends another provider's tool-call data to the Messages API", () => {
    const body = requestBody({ ...conversation, model: "claude-opus-5-5" });
    expect(JSON.stringify(body)).not.toContain(PROVIDER_EXTRA);
  });

  it("folds a streamed answer with split tool-call arguments into one turn", async () => {
    const out: string[] = [];
    const turn = await readChatStream(lines([
      { choices: [{ delta: { content: "On it." } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call.9", function: { name: "ue_mcp", arguments: "{\"action\":" } , extra_content: { google: { thought_signature: "s2" } } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"search\",\"query\":\"cube\"}" } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]), (t) => out.push(t));
    expect(out).toEqual(["On it."]);
    expect(turn.stopReason).toBe("tool_use");
    expect(turn.content).toEqual([
      { type: "text", text: "On it.", citations: null },
      { type: "tool_use", id: "call_9", name: "ue_mcp", input: { action: "search", query: "cube" }, [PROVIDER_EXTRA]: { google: { thought_signature: "s2" } } },
    ]);
  });

  it("reports a plain answer as the end of the turn", async () => {
    const turn = await readChatStream(lines([{ choices: [{ delta: { content: "Done." }, finish_reason: "stop" }] }]), () => {});
    expect(turn).toMatchObject({ stopReason: "end_turn", content: [{ type: "text", text: "Done." }] });
  });

  it("posts to the provider's chat endpoint with the key", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n", { status: 200 });
    }) as unknown as typeof fetch;
    const turn = await new OpenAICompatibleProvider("https://api.example/v1", "sk-x", fetchImpl).run(conversation, () => {}, new AbortController().signal);
    expect(seen!.url).toBe("https://api.example/v1/chat/completions");
    expect((seen!.init.headers as Record<string, string>).authorization).toBe("Bearer sk-x");
    expect(turn.content).toEqual([{ type: "text", text: "hi", citations: null }]);
  });
});

describe("model lists", () => {
  it("keeps chat models and drops image, audio, embedding and dated snapshots", () => {
    const ids = ["gpt-6-sol", "gpt-6-sol-2026-09-22", "gpt-image-2", "gpt-realtime-2.1", "text-embedding-3-large", "o5", "whisper-1"];
    expect(chatModels("openai", ids.map((id) => ({ id }))).map((m) => m.id)).toEqual(["o5", "gpt-6-sol"]);
    expect(chatModels("google", [{ id: "models/gemini-3.8-flash" }, { id: "models/gemini-3.8-live" }, { id: "models/gemini-embedding-2" }]).map((m) => m.id)).toEqual(["gemini-3.8-flash"]);
    expect(chatModels("anthropic", [{ id: "claude-opus-5-5", name: "Claude Opus 5.5" }])).toEqual([{ id: "claude-opus-5-5", name: "Claude Opus 5.5" }]);
  });
});

describe("Studio sign-in", () => {
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it("shows the code, then saves the account token once GitHub approves it", async () => {
    const polls = [{ error: "authorization_pending" }, { access_token: "gho_x" }];
    let saved: [string, string] | null = null;
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/login/device/code")) return reply({ device_code: "dc", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 });
      if (url.endsWith("/access_token")) return reply(polls.shift());
      if (url.endsWith("/api/cli/exchange")) return reply({ token: "uemcp_t", login: "octo" });
      throw new Error(url);
    }) as unknown as typeof fetch;
    const flow = new StudioSignInFlow((t, l) => { saved = [t, l]; }, fetchImpl, async () => {});
    expect(await flow.start()).toMatchObject({ state: "pending", userCode: "ABCD-1234" });
    await new Promise((r) => setTimeout(r, 10));
    expect(flow.view()).toEqual({ state: "done", login: "octo" });
    expect(saved).toEqual(["uemcp_t", "octo"]);
  });

  it("says so when the user declines", async () => {
    const fetchImpl = (async (url: string) =>
      url.endsWith("/device/code")
        ? reply({ device_code: "dc", user_code: "C", verification_uri: "u", expires_in: 900, interval: 5 })
        : reply({ error: "access_denied" })) as unknown as typeof fetch;
    const flow = new StudioSignInFlow(() => {}, fetchImpl, async () => {});
    await flow.start();
    await new Promise((r) => setTimeout(r, 10));
    expect(flow.view()).toMatchObject({ state: "error", error: expect.stringMatching(/declined/) });
  });
});

describe("sign-ins come before keys", () => {
  it("runs OpenAI models on a ChatGPT sign-in, Claude models on the Claude plan, and the Studio plan's models on Studio next", () => {
    const coverage = { planModels: ["claude-opus-5-5"] };
    expect(signInsFor("anthropic", "claude-opus-5-5", coverage)).toEqual(STUDIO_PLAN_AVAILABLE ? ["claude", "studio"] : ["claude"]);
    expect(signInsFor("anthropic", "claude-haiku-5-5", coverage)).toEqual(["claude"]);
    expect(signInsFor("openai", "gpt-6-sol", coverage)).toEqual(["chatgpt"]);
  });
});

describe("the Anthropic API's own web search", () => {
  const message = {
    content: [
      { type: "server_tool_use", id: "srv1", name: "web_search", input: { query: "unreal 5.8" } },
      { type: "web_search_tool_result", tool_use_id: "srv1", content: [{ type: "web_search_result", title: "Release notes", url: "https://example.com/58" }] },
      { type: "text", text: "Here." },
    ],
    stop_reason: "end_turn",
  };
  const req: ModelRequest = { sessionId: "s", model: "claude-opus-5-5", system: [], tools: TOOLS, messages: [{ role: "user", content: "hi" }] };

  it("goes with Studio's tools, and its searches come back for the transcript", async () => {
    const sent: string[][] = [];
    const client = { beta: { messages: { stream: vi.fn((body: { tools: Array<{ name: string }> }) => {
      sent.push(body.tools.map((t) => t.name));
      return { on: () => {}, finalMessage: () => Promise.resolve(message) };
    }) } } };
    const turn = await new AnthropicProvider("k", client as never).run(req, () => {}, new AbortController().signal);
    expect(sent[0].at(-1)).toBe("web_search");
    expect(turn.searches).toEqual([{ id: "srv1", query: "unreal 5.8", results: [{ title: "Release notes", url: "https://example.com/58" }] }]);
  });

  it("is left out when the API refuses it, and the turn runs without it", async () => {
    const sent: number[] = [];
    const client = { beta: { messages: { stream: vi.fn((body: { tools: unknown[] }) => {
      sent.push(body.tools.length);
      const refuse = body.tools.length > TOOLS.length;
      return { on: () => {}, finalMessage: () => (refuse ? Promise.reject(Object.assign(new Error("400 web_search is not enabled"), { status: 400 })) : Promise.resolve({ content: [], stop_reason: "end_turn" })) };
    }) } } };
    const p = new AnthropicProvider("k", client as never);
    await p.run(req, () => {}, new AbortController().signal);
    await p.run(req, () => {}, new AbortController().signal);
    expect(sent).toEqual([TOOLS.length + 1, TOOLS.length, TOOLS.length]);
  });

  it("reads a failed search as an error", () => {
    expect(searchesIn([{ type: "server_tool_use", id: "x", name: "web_search", input: { query: "q" } }, { type: "web_search_tool_result", tool_use_id: "x", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } }] as never))
      .toEqual([{ id: "x", query: "q", results: [], error: "max_uses_exceeded" }]);
  });
});

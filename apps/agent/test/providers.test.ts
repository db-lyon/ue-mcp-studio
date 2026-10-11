import { describe, expect, it } from "vitest";
import { OpenAICompatibleProvider, PROVIDER_EXTRA, readChatStream, toChatRequest } from "../src/openai-compat.js";
import { requestBody, type ModelRequest } from "../src/providers.js";
import { chatModels, signInsFor } from "../src/models.js";
import { OpenRouterModels, OpenRouterSignInFlow } from "../src/openrouter.js";
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
    expect(body.tools.map((t) => t.function.name)).toEqual(["ue_mcp", "editor_restart"]);
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
  const coverage = {
    planModels: ["claude-opus-5-5"],
    openrouterId: (v: string, m: string) => (["anthropic/claude-opus-5-5", "openai/gpt-6-sol"].includes(`${v}/${m}`) ? `${v}/${m}` : null),
  };

  it("names Studio first, then OpenRouter, for each model they run", () => {
    expect(signInsFor("anthropic", "claude-opus-5-5", coverage)).toEqual(["studio", "openrouter"]);
    expect(signInsFor("openai", "gpt-6-sol", coverage)).toEqual(["openrouter"]);
    expect(signInsFor("google", "gemini-3.8-flash", coverage)).toEqual([]);
  });

  it("finds OpenRouter's spelling of a vendor's model", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ data: [{ id: "anthropic/claude-opus-5.5" }, { id: "openai/gpt-6-sol" }] }))) as unknown as typeof fetch;
    const m = new OpenRouterModels(fetchImpl);
    await m.refresh();
    expect(m.idFor("anthropic", "claude-opus-5-5")).toBe("anthropic/claude-opus-5.5");
    expect(m.idFor("openai", "gpt-6-sol")).toBe("openai/gpt-6-sol");
    expect(m.idFor("google", "gemini-3.8-flash")).toBeNull();
  });

  it("signs in to OpenRouter through the redirect and keeps the issued key", async () => {
    let exchanged: Record<string, string> | null = null;
    let saved: string | null = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      exchanged = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ key: "sk-or-v1-x" }));
    }) as unknown as typeof fetch;
    const flow = new OpenRouterSignInFlow((k) => { saved = k; }, fetchImpl);
    const pending = await flow.start();
    if (pending.state !== "pending") throw new Error("not pending");
    const auth = new URL(pending.url);
    expect(auth.origin + auth.pathname).toBe("https://openrouter.ai/auth");
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    const callback = auth.searchParams.get("callback_url")!.replace("localhost", "127.0.0.1");
    const page = await fetch(`${callback}?code=abc`);
    expect(page.status).toBe(200);
    expect(exchanged).toMatchObject({ code: "abc", code_challenge_method: "S256" });
    expect(exchanged!.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(saved).toBe("sk-or-v1-x");
    expect(flow.view()).toMatchObject({ state: "done" });
  });
});

describe("OpenRouter's public list", () => {
  it("gives each vendor's newest models under the vendor's own ids", async () => {
    const data = [
      { id: "anthropic/claude-opus-5.5", name: "Anthropic: Claude Opus 5.5", created: 3 },
      { id: "anthropic/claude-opus-5.5:batch", name: "batch", created: 4 },
      { id: "openai/gpt-6.1-sol", name: "OpenAI: GPT-6.1 Sol", created: 5 },
      { id: "openai/gpt-6-sol", name: "OpenAI: GPT-6 Sol", created: 2 },
    ];
    const m = new OpenRouterModels((async () => new Response(JSON.stringify({ data }))) as unknown as typeof fetch);
    await m.refresh();
    expect(m.modelsOf("anthropic")).toEqual([{ id: "claude-opus-5-5", name: "Claude Opus 5.5" }]);
    expect(m.modelsOf("openai").map((x) => x.id)).toEqual(["gpt-6.1-sol", "gpt-6-sol"]);
  });
});

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CALLBACK_PORT, ChatGptAuth, ChatGptSignInFlow, FileCredentialStore, TOKEN_URL, chatgptModels, emailOf } from "../src/chatgpt.js";
import { readResponsesStream, toResponsesRequest } from "../src/responses.js";
import { TOOLS } from "../src/tools.js";

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const ISSUER = "https://auth.openai.com";
const realFetch = globalThis.fetch;

/** An access token as OpenAI issues one: a JWT whose profile claim names the account. */
const accessToken = (n: number, email = "ana@example.com") => `${b64url("{}")}.${b64url(JSON.stringify({ "https://api.openai.com/profile": { email } }))}.sig${n}`;

/**
 * OpenAI's auth server as far as the sign-in sees it, in place of the global
 * fetch pi-ai's flow uses. Everything else (the loopback callback) goes out
 * for real.
 */
function fakeOpenAI(opts: { scope?: string; refresh?: "ok" | "invalid_grant" } = {}) {
  const calls: Array<{ url: string; body: URLSearchParams | null }> = [];
  const scope = opts.scope ?? "openid email offline_access resource.invoke chatgpt.tokens.use.direct";
  let refreshes = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(ISSUER)) return realFetch(input, init);
    const raw = init?.body;
    const body = typeof raw === "string" ? new URLSearchParams(raw) : raw instanceof URLSearchParams ? raw : null;
    calls.push({ url, body });
    if (url.endsWith("/.well-known/openid-configuration")) return new Response(JSON.stringify({ issuer: ISSUER, revocation_endpoint: `${ISSUER}/revoke` }));
    if (url === `${ISSUER}/revoke`) return new Response("", { status: 200 });
    if (url === TOKEN_URL && body?.get("grant_type") === "authorization_code") {
      return new Response(JSON.stringify({ access_token: accessToken(1), refresh_token: "rt-1", id_token: "x.y.z", expires_in: 3600, scope }));
    }
    if (url === TOKEN_URL && body?.get("grant_type") === "refresh_token") {
      if (opts.refresh === "invalid_grant") return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      await new Promise((r) => setTimeout(r, 20));
      refreshes++;
      return new Response(JSON.stringify({ access_token: accessToken(1 + refreshes), refresh_token: `rt-${1 + refreshes}`, expires_in: 3600, scope }));
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls, issued: "oaiapp_123" };
}

/** Plays the browser: approve, and follow OpenAI's redirect to the loopback listener. */
async function approve(url: string, issued: string, extra: Record<string, string> = {}) {
  const q = new URL(url).searchParams;
  const back = new URL(q.get("redirect_uri")!);
  back.searchParams.set("code", "code-1");
  back.searchParams.set("state", q.get("state")!);
  back.searchParams.set("client_id", issued);
  for (const [k, v] of Object.entries(extra)) back.searchParams.set(k, v);
  return realFetch(back);
}

const until = async (cond: () => boolean, what: string) => {
  for (const end = Date.now() + 10_000; !cond(); await new Promise((r) => setTimeout(r, 20))) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
};

const saved = (over: Record<string, unknown> = {}) => ({ type: "oauth" as const, access: accessToken(1), refresh: "rt-1", expires: Date.now() + 3600_000, clientId: "oaiapp_123", scopes: ["chatgpt.tokens.use.direct"], email: "ana@example.com", ...over });

let home: string;
let flows: ChatGptSignInFlow[] = [];
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "studio-chatgpt-"));
  process.env.STUDIO_CHATGPT_HOME = home;
  flows = [];
});
afterEach(() => {
  for (const f of flows) f.cancel();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete process.env.STUDIO_CHATGPT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

const flowFor = (auth: ChatGptAuth, onDone: () => void = () => {}) => {
  const f = new ChatGptSignInFlow(auth, onDone);
  flows.push(f);
  return f;
};

describe("Sign in with ChatGPT through pi-ai", () => {
  it("registers this install, keeps the issued client id and the account in pi-ai's credential store, and runs on its token", async () => {
    const fake = fakeOpenAI();
    vi.stubGlobal("fetch", fake.fetchImpl);
    const auth = new ChatGptAuth(fake.fetchImpl);
    let done = 0;
    const flow = flowFor(auth, () => done++);
    const pending = await flow.start();
    if (pending.state !== "pending") throw new Error(`not pending: ${JSON.stringify(pending)}`);
    const q = new URL(pending.url).searchParams;
    expect(q.get("client_id")).toBe("dynamic_agent_client");
    expect(q.get("agent_name_hint")).toBe("UE-MCP Studio");
    expect(q.get("ext_agent_host_id")).toBe(auth.hostId());
    expect(q.get("redirect_uri")).toBe(`http://127.0.0.1:${CALLBACK_PORT}/auth/callback`);
    expect(q.get("scope")).toContain("chatgpt.tokens.use.direct");
    expect(q.get("code_challenge_method")).toBe("S256");

    expect((await approve(pending.url, fake.issued)).status).toBe(200);
    await until(() => flow.view().state === "done", "the sign-in to finish");
    expect(flow.view()).toEqual({ state: "done", login: "ana@example.com" });
    expect(done).toBe(1);
    expect(auth.clientId()).toBe("oaiapp_123");
    const exchange = fake.calls.find((c) => c.body?.get("grant_type") === "authorization_code")!.body!;
    expect(exchange.get("client_id")).toBe("oaiapp_123");
    expect(exchange.get("code_verifier")).toMatch(/^[\w-]{43,}$/);
    expect(exchange.get("resource")).toBe("https://api.openai.com/v1");
    expect(await auth.accessToken()).toBe(accessToken(1));
    // pi-ai's credential shape, under its provider id, readable only by the user.
    const file = JSON.parse(fs.readFileSync(path.join(home, "credentials.json"), "utf-8"));
    expect(file.openai).toMatchObject({ type: "oauth", refresh: "rt-1", clientId: "oaiapp_123", email: "ana@example.com" });
    if (process.platform !== "win32") expect(fs.statSync(path.join(home, "credentials.json")).mode & 0o777).toBe(0o600);
  });

  it("refuses a sign-in that did not grant plan usage, and keeps nothing", async () => {
    const fake = fakeOpenAI({ scope: "openid email offline_access" });
    vi.stubGlobal("fetch", fake.fetchImpl);
    const auth = new ChatGptAuth(fake.fetchImpl);
    const flow = flowFor(auth);
    const pending = await flow.start();
    if (pending.state !== "pending") throw new Error("not pending");
    await approve(pending.url, fake.issued);
    await until(() => flow.view().state === "error", "the refusal");
    expect(flow.view()).toMatchObject({ state: "error", error: expect.stringMatching(/did not grant use of your ChatGPT plan/) });
    expect(auth.signedIn()).toBeNull();
  });

  it("ignores a callback that answers another sign-in, and lets go of the port on cancel", async () => {
    const fake = fakeOpenAI();
    vi.stubGlobal("fetch", fake.fetchImpl);
    const auth = new ChatGptAuth(fake.fetchImpl);
    const flow = flowFor(auth);
    const pending = await flow.start();
    if (pending.state !== "pending") throw new Error("not pending");
    expect((await approve(pending.url, fake.issued, { state: "forged" })).status).toBe(400);
    expect(fake.calls.some((c) => c.url === TOKEN_URL)).toBe(false);
    expect(flow.view().state).toBe("pending");
    flow.cancel();
    expect(flow.view()).toEqual({ state: "idle" });
    // Starting again gets the port back.
    const again = await flow.start();
    expect(again.state).toBe("pending");
  });

  it("says what holds the port when another sign-in has it", async () => {
    const holder = http.createServer((_q, r) => r.end());
    await new Promise<void>((resolve) => holder.listen(CALLBACK_PORT, "127.0.0.1", () => resolve()));
    try {
      const fake = fakeOpenAI();
      vi.stubGlobal("fetch", fake.fetchImpl);
      const view = await flowFor(new ChatGptAuth(fake.fetchImpl)).start();
      expect(view).toMatchObject({ state: "error", error: expect.stringMatching(/port 1455.*Codex CLI/) });
    } finally {
      await new Promise((r) => holder.close(r));
    }
  });

  it("refreshes an expiring token once however many turns ask, keeping the rotated refresh token and the account", async () => {
    const fake = fakeOpenAI();
    vi.stubGlobal("fetch", fake.fetchImpl);
    const auth = new ChatGptAuth(fake.fetchImpl);
    await auth.store.modify("openai", async () => saved({ expires: Date.now() + 5000 }));
    const tokens = await Promise.all([auth.accessToken(), auth.accessToken(), auth.accessToken()]);
    expect(tokens).toEqual([accessToken(2), accessToken(2), accessToken(2)]);
    const refreshes = fake.calls.filter((c) => c.body?.get("grant_type") === "refresh_token");
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0].body!.get("client_id")).toBe("oaiapp_123");
    expect(auth.load()).toMatchObject({ refresh: "rt-2", email: "ana@example.com" });
  });

  it("forgets a sign-in OpenAI no longer accepts, and says to sign in again", async () => {
    const fake = fakeOpenAI({ refresh: "invalid_grant" });
    vi.stubGlobal("fetch", fake.fetchImpl);
    const auth = new ChatGptAuth(fake.fetchImpl);
    await auth.store.modify("openai", async () => saved({ expires: Date.now() + 5000 }));
    await expect(auth.accessToken()).rejects.toThrow(/Sign in again from the model picker/);
    expect(auth.signedIn()).toBeNull();
  });

  it("moves a sign-in an earlier Studio saved into the credential store, once", async () => {
    const fake = fakeOpenAI();
    vi.stubGlobal("fetch", fake.fetchImpl);
    fs.writeFileSync(path.join(home, "session.json"), JSON.stringify({ clientId: "oaiapp_old", hostId: "urn:uuid:x", accessToken: "at-old", refreshToken: "rt-old", expiresAt: Date.now() + 3600_000, scope: "openid chatgpt.tokens.use.direct", sub: "user-1", email: "old@example.com" }));
    const auth = new ChatGptAuth(fake.fetchImpl);
    expect(auth.signedIn()).toEqual({ email: "old@example.com" });
    expect(auth.load()).toMatchObject({ type: "oauth", access: "at-old", refresh: "rt-old", clientId: "oaiapp_old", scopes: ["openid", "chatgpt.tokens.use.direct"] });
    expect(fs.existsSync(path.join(home, "session.json"))).toBe(false);
    expect(fs.existsSync(path.join(home, "session.json.migrated"))).toBe(true);
    expect(await auth.accessToken()).toBe("at-old");
    // Signed out, it stays out: the old file is not read again.
    await auth.signOut();
    expect(new ChatGptAuth(fake.fetchImpl).signedIn()).toBeNull();
  });

  it("does not take an OpenAI key in the environment for a ChatGPT sign-in", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-env");
    const auth = new ChatGptAuth(fakeOpenAI().fetchImpl);
    await expect(auth.accessToken()).rejects.toThrow(/Sign in with ChatGPT to run this model/);
  });

  it("revokes the refresh token on sign-out and forgets the sign-in", async () => {
    const fake = fakeOpenAI();
    const auth = new ChatGptAuth(fake.fetchImpl);
    await auth.store.modify("openai", async () => saved({ refresh: "rt-9" }));
    expect(await auth.signOut()).toEqual({ revoked: true });
    const revoke = fake.calls.find((c) => c.url === `${ISSUER}/revoke`)!.body!;
    expect([revoke.get("token"), revoke.get("token_type_hint"), revoke.get("client_id")]).toEqual(["rt-9", "refresh_token", "oaiapp_123"]);
    expect(auth.signedIn()).toBeNull();
  });

  it("serializes writes from two stores on the same folder, as two daemons would", async () => {
    const a = new FileCredentialStore();
    const b = new FileCredentialStore();
    const bump = (s: FileCredentialStore) => s.modify("n", async (cur) => {
      const n = Number((cur as { key?: string } | undefined)?.key ?? 0);
      await new Promise((r) => setTimeout(r, 10));
      return { type: "api_key", key: String(n + 1) };
    });
    await Promise.all([bump(a), bump(b), bump(a), bump(b)]);
    expect(a.peek("n")).toEqual({ type: "api_key", key: "4" });
    expect(fs.existsSync(path.join(home, "credentials.lock"))).toBe(false);
  });

  it("reads the account's email from the access token's profile claim, and nothing from a token without one", () => {
    expect(emailOf(accessToken(1, "bo@example.com"))).toBe("bo@example.com");
    expect(emailOf("opaque")).toBeNull();
  });

  it("lists the account's listed models in the server's order", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ models: [
      { slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", visibility: "list" },
      { slug: "internal", visibility: "hide" },
      { slug: "gpt-6-luna", display_name: "GPT-6 Luna", visibility: "list" },
    ] }))) as unknown as typeof fetch;
    expect(await chatgptModels("t", fetchImpl)).toEqual([{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol" }, { id: "gpt-6-luna", name: "GPT-6 Luna" }]);
  });
});

describe("the Responses API", () => {
  it("sends the conversation as input items, tool results as function call outputs, never stored", () => {
    const req = toResponsesRequest({
      sessionId: "s", model: "gpt-6.1-sol", system: [{ type: "text", text: "sys" }], tools: TOOLS,
      messages: [
        { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }, { type: "text", text: "look" }] },
        { role: "assistant", content: [{ type: "text", text: "Checking." }, { type: "tool_use", id: "c1", name: "ue_mcp", input: { action: "search", query: "x" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "found" }] },
      ] as never,
    });
    expect(req).toMatchObject({ model: "gpt-6.1-sol", instructions: "sys", store: false, stream: true });
    expect(req.input).toEqual([
      { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AAA" }, { type: "input_text", text: "look" }] },
      { role: "assistant", content: [{ type: "output_text", text: "Checking." }] },
      { type: "function_call", call_id: "c1", name: "ue_mcp", arguments: '{"action":"search","query":"x"}' },
      { type: "function_call_output", call_id: "c1", output: "found" },
    ]);
    expect((req.tools as Array<{ type: string; name: string }>).map((t) => t.name)).toEqual(["ue_mcp", "editor_restart", "shell", "read_file", "write_file", "edit_file", "glob", "grep", "web_fetch", "agent"]);
    // OpenAI's own web search goes along when the route offers it.
    const withSearch = toResponsesRequest({ sessionId: "s", model: "gpt-6.1-sol", system: [], tools: TOOLS, messages: [] }, true);
    expect((withSearch.tools as Array<{ type: string }>).at(-1)).toEqual({ type: "web_search" });
  });

  const stream = async function* (events: unknown[]) {
    for (const e of events) yield `data: ${JSON.stringify(e)}`;
  };

  it("folds text and function calls, and counts the turn only when it completes", async () => {
    const seen: string[] = [];
    const turn = await readResponsesStream(stream([
      { type: "response.output_text.delta", delta: "Look" },
      { type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "Looking." }] } },
      { type: "response.output_item.done", item: { type: "function_call", call_id: "c9", name: "ue_mcp", arguments: '{"action":"search"}' } },
      { type: "response.completed", response: {} },
    ]), (t) => seen.push(t));
    expect(seen).toEqual(["Look"]);
    expect(turn.stopReason).toBe("tool_use");
    expect(turn.content).toEqual([
      { type: "text", text: "Looking.", citations: null },
      { type: "tool_use", id: "c9", name: "ue_mcp", input: { action: "search" } },
    ]);
  });

  it("says when the plan's limit is reached, and refuses a stream that never completes", async () => {
    await expect(readResponsesStream(stream([{ type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded" } } }]), () => {}))
      .rejects.toThrow(/usage limit is reached/);
    await expect(readResponsesStream(stream([{ type: "response.output_text.delta", delta: "Hal" }]), () => {})).rejects.toThrow(/ended before it completed/);
  });

  it("hands a reply cut off at the output limit back as max_tokens, so the loop asks it to go on", async () => {
    const turn = await readResponsesStream(stream([
      { type: "response.output_text.delta", delta: "Half" },
      { type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "Half" }] } },
      { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } },
    ]), () => {});
    expect(turn.stopReason).toBe("max_tokens");
  });
});

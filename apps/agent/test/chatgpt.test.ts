import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatGptAuth, ChatGptSignInFlow, TOKEN_URL, chatgptModels } from "../src/chatgpt.js";
import { readResponsesStream, toResponsesRequest } from "../src/responses.js";
import { TOOLS } from "../src/tools.js";

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: "jwk" }) as object), kid: "k1", alg: "RS256", use: "sig" };
const ISSUER = "https://auth.openai.com";

function idToken(claims: Record<string, unknown>): string {
  const h = b64url(JSON.stringify({ alg: "RS256", kid: "k1" }));
  const p = b64url(JSON.stringify(claims));
  return `${h}.${p}.${b64url(crypto.sign("RSA-SHA256", Buffer.from(`${h}.${p}`), privateKey))}`;
}

/** OpenAI's auth server as far as the sign-in sees it. */
function fakeOpenAI(opts: { scope?: string; issuedClient?: string } = {}) {
  const calls: Array<{ url: string; body: URLSearchParams | null }> = [];
  let nonce = "";
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? new URLSearchParams(init.body) : null;
    calls.push({ url, body });
    if (url.endsWith("/.well-known/openid-configuration")) {
      return new Response(JSON.stringify({ issuer: ISSUER, jwks_uri: `${ISSUER}/jwks`, revocation_endpoint: `${ISSUER}/revoke` }));
    }
    if (url === `${ISSUER}/jwks`) return new Response(JSON.stringify({ keys: [jwk] }));
    if (url === `${ISSUER}/revoke`) return new Response("", { status: 200 });
    if (url === TOKEN_URL && body?.get("grant_type") === "authorization_code") {
      return new Response(JSON.stringify({
        access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, scope: opts.scope ?? "openid email offline_access resource.invoke chatgpt.tokens.use.direct",
        id_token: idToken({ iss: ISSUER, aud: body.get("client_id"), exp: Math.floor(Date.now() / 1000) + 600, nonce, sub: "user-1", email: "ana@example.com" }),
      }));
    }
    if (url === TOKEN_URL && body?.get("grant_type") === "refresh_token") {
      await new Promise((r) => setTimeout(r, 20));
      return new Response(JSON.stringify({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 }));
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, setNonce: (n: string) => (nonce = n), issued: opts.issuedClient ?? "oaiapp_123" };
}

/** Plays the browser: approve, and follow OpenAI's redirect to the loopback listener. */
async function approve(url: string, fake: ReturnType<typeof fakeOpenAI>, extra: Record<string, string> = {}) {
  const q = new URL(url).searchParams;
  fake.setNonce(q.get("nonce")!);
  const back = new URL(q.get("redirect_uri")!);
  back.searchParams.set("code", "code-1");
  back.searchParams.set("state", q.get("state")!);
  if (q.get("client_id") === "dynamic_agent_client") back.searchParams.set("client_id", fake.issued);
  for (const [k, v] of Object.entries(extra)) back.searchParams.set(k, v);
  return fetch(back);
}

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "studio-chatgpt-"));
  process.env.STUDIO_CHATGPT_HOME = home;
});
afterEach(() => {
  delete process.env.STUDIO_CHATGPT_HOME;
});

describe("Sign in with ChatGPT", () => {
  it("registers on first sign-in, checks the ID token and plan usage, and keeps the issued client id", async () => {
    const fake = fakeOpenAI();
    const auth = new ChatGptAuth(fake.fetchImpl);
    let done = 0;
    const flow = new ChatGptSignInFlow(auth, () => done++, fake.fetchImpl);
    const pending = await flow.start();
    if (pending.state !== "pending") throw new Error("not pending");
    const q = new URL(pending.url).searchParams;
    expect(q.get("client_id")).toBe("dynamic_agent_client");
    expect(q.get("agent_name_hint")).toBe("UE-MCP Studio");
    expect(q.get("ext_agent_host_id")).toMatch(/^urn:uuid:/);
    expect(q.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    expect(q.get("scope")).toContain("chatgpt.tokens.use.direct");
    expect(q.get("code_challenge_method")).toBe("S256");

    const page = await approve(pending.url, fake);
    expect(page.status).toBe(200);
    expect(flow.view()).toEqual({ state: "done", login: "ana@example.com" });
    expect(done).toBe(1);
    expect(auth.clientId()).toBe("oaiapp_123");
    const exchange = fake.calls.find((c) => c.body?.get("grant_type") === "authorization_code")!.body!;
    expect(exchange.get("client_id")).toBe("oaiapp_123");
    expect(exchange.get("code_verifier")).toMatch(/^[\w-]{43}$/);
    expect(exchange.get("resource")).toBe("https://api.openai.com/v1");
    expect(await auth.accessToken()).toBe("at-1");

    // The next sign-in reuses the issued id and the same host id.
    const again = await flow.start();
    if (again.state !== "pending") throw new Error("not pending");
    const q2 = new URL(again.url).searchParams;
    expect(q2.get("client_id")).toBe("oaiapp_123");
    expect(q2.get("agent_name_hint")).toBeNull();
    expect(q2.get("ext_agent_host_id")).toBe(q.get("ext_agent_host_id"));
    flow.cancel();
  });

  it("refuses a sign-in that did not grant plan usage, and keeps nothing", async () => {
    const fake = fakeOpenAI({ scope: "openid email offline_access" });
    const auth = new ChatGptAuth(fake.fetchImpl);
    const flow = new ChatGptSignInFlow(auth, () => {}, fake.fetchImpl);
    const pending = await flow.start();
    if (pending.state !== "pending") throw new Error("not pending");
    expect((await approve(pending.url, fake)).status).toBe(400);
    expect(flow.view()).toMatchObject({ state: "error", error: expect.stringMatching(/did not grant use of your ChatGPT plan/) });
    expect(auth.signedIn()).toBeNull();
  });

  it("ignores a callback that answers another sign-in", async () => {
    const fake = fakeOpenAI();
    const flow = new ChatGptSignInFlow(new ChatGptAuth(fake.fetchImpl), () => {}, fake.fetchImpl);
    const pending = await flow.start();
    if (pending.state !== "pending") throw new Error("not pending");
    expect((await approve(pending.url, fake, { state: "forged" })).status).toBe(400);
    expect(fake.calls.some((c) => c.url === TOKEN_URL)).toBe(false);
  });

  it("refreshes an expiring token once however many turns ask, and keeps the rotated refresh token", async () => {
    const fake = fakeOpenAI();
    const auth = new ChatGptAuth(fake.fetchImpl);
    auth.save({ clientId: "oaiapp_123", hostId: "urn:uuid:x", accessToken: "at-1", refreshToken: "rt-1", expiresAt: Date.now() + 5000, scope: "", sub: "u", email: null });
    const tokens = await Promise.all([auth.accessToken(), auth.accessToken(), auth.accessToken()]);
    expect(tokens).toEqual(["at-2", "at-2", "at-2"]);
    const refreshes = fake.calls.filter((c) => c.body?.get("grant_type") === "refresh_token");
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0].body!.get("client_id")).toBe("oaiapp_123");
    expect(auth.load()?.refreshToken).toBe("rt-2");
  });

  it("revokes the refresh token on sign-out and forgets the sign-in", async () => {
    const fake = fakeOpenAI();
    const auth = new ChatGptAuth(fake.fetchImpl);
    auth.save({ clientId: "oaiapp_123", hostId: "h", accessToken: "a", refreshToken: "rt-9", expiresAt: Date.now() + 3600_000, scope: "", sub: "u", email: null });
    expect(await auth.signOut()).toEqual({ revoked: true });
    const revoke = fake.calls.find((c) => c.url === `${ISSUER}/revoke`)!.body!;
    expect([revoke.get("token"), revoke.get("token_type_hint"), revoke.get("client_id")]).toEqual(["rt-9", "refresh_token", "oaiapp_123"]);
    expect(auth.signedIn()).toBeNull();
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
    expect((req.tools as Array<{ type: string; name: string }>).map((t) => [t.type, t.name])).toEqual([["function", "ue_mcp"], ["function", "editor_restart"], ["function", "agent"]]);
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
});

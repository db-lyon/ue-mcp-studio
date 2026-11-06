/** The ue-mcp account's routes: email sign-in and the account's ways to sign in, against a stubbed account service. */
import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionHandler } from "ue-mcp/daemon";
import { ACCOUNT_CODE_ERROR, ACCOUNT_EMAIL_MALFORMED, ACCOUNT_SIGNED_OUT } from "@ue-mcp-studio/shared";
import { registerAccountRoutes } from "../src/account-routes.js";
import { SettingsStore } from "../src/settings.js";

const REGISTRY = "https://registry.test";

interface Hit {
  method: string;
  url: string;
  auth?: string;
  body?: unknown;
}

type Answer = { status: number; body: unknown; headers?: Record<string, string> };

let hits: Hit[];
let answers: Record<string, Answer | ((body: unknown) => Answer)>;

const stubFetch = (async (url: string, init: RequestInit = {}) => {
  const method = init.method ?? "GET";
  const headers = (init.headers ?? {}) as Record<string, string>;
  const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
  const u = String(url).replace(REGISTRY, "");
  hits.push({ method, url: u, auth: headers.authorization, body });
  // The GitHub device flow's own endpoints.
  if (u === "https://github.com/login/device/code") return json(200, { device_code: "dev", user_code: "WXYZ-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 });
  if (u === "https://github.com/login/oauth/access_token") return json(200, { access_token: "gho_linked" });
  const a = answers[`${method} ${u}`];
  if (!a) return json(404, { error: "not found" });
  const r = typeof a === "function" ? a(body) : a;
  return json(r.status, r.body, r.headers);
}) as unknown as typeof fetch;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

const VIEW_EMAIL = { userId: "u1", login: "dev@example.com", email: "dev@example.com", emailVerified: true, github: null };
const VIEW_GITHUB = { userId: "u2", login: "octocat", email: null, emailVerified: false, github: { login: "octocat" } };
const VIEW_BOTH = { userId: "u2", login: "octocat", email: "cat@example.com", emailVerified: true, github: { login: "octocat" } };

let dir: string;
let settings: SettingsStore;
let changes: number;
let registryToken: string | null;

function routes() {
  const map = new Map<string, ExtensionHandler>();
  const out = registerAccountRoutes({ route: (m: string, p: string, h: ExtensionHandler) => void map.set(`${m} ${p}`, h) } as never, {
    settings,
    changed: () => void changes++,
    registryToken: () => registryToken,
    fetch: stubFetch,
    sleep: async () => {},
    authBases: () => [REGISTRY],
  });
  const call = async (key: string, body?: unknown) => {
    const h = map.get(key);
    if (!h) throw new Error(`no route ${key}`);
    return ((await h({ method: "", path: "", params: {}, query: {}, headers: {}, body } as never)) ?? {}) as { status?: number; body?: unknown };
  };
  return Object.assign(call, out);
}

beforeEach(() => {
  hits = [];
  answers = {};
  changes = 0;
  registryToken = null;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-account-"));
  settings = new SettingsStore(dir);
});

describe("GET /auth/methods", () => {
  it("passes the service's email flag on", async () => {
    answers["GET /api/auth/methods"] = { status: 200, body: { email: true, github: true } };
    expect(await routes()("GET /auth/methods")).toEqual({ body: { email: true, github: true } });
  });

  it("flag off: GitHub alone", async () => {
    answers["GET /api/auth/methods"] = { status: 200, body: { email: false, github: true } };
    expect(await routes()("GET /auth/methods")).toEqual({ body: { email: false, github: true } });
  });

  it("a service from before email sign-in, or none reachable: GitHub alone", async () => {
    expect(await routes()("GET /auth/methods")).toEqual({ body: { email: false, github: true } });
    const map = new Map<string, ExtensionHandler>();
    registerAccountRoutes({ route: (m: string, p: string, h: ExtensionHandler) => void map.set(`${m} ${p}`, h) } as never, {
      settings, changed: () => {}, authBases: () => [REGISTRY], fetch: (async () => { throw new Error("offline"); }) as unknown as typeof fetch,
    });
    expect(await map.get("GET /auth/methods")!({} as never)).toEqual({ body: { email: false, github: true } });
  });
});

describe("email sign-in", () => {
  it("sign up: sends the code, verifies it, keeps the token where the UI cannot see it, and says the account is new", async () => {
    answers["POST /api/auth/email/start"] = { status: 200, body: { ok: true, expiresInSeconds: 600 } };
    answers["POST /api/auth/email/verify"] = { status: 200, body: { ok: true, token: "uemcp_new", prefix: "uemcp_ne", login: "dev@example.com", email: "dev@example.com", created: true } };
    answers["GET /api/account"] = { status: 200, body: VIEW_EMAIL };
    const call = routes();
    expect(await call("POST /auth/email/start", { email: " dev@example.com " })).toEqual({ status: undefined, body: { ok: true, expiresInSeconds: 600 } });
    expect(hits[0]).toMatchObject({ method: "POST", url: "/api/auth/email/start", body: { email: "dev@example.com" }, auth: undefined });
    const res = await call("POST /auth/email/verify", { email: "dev@example.com", code: "123456" });
    expect(res).toEqual({ body: { ok: true, login: "dev@example.com", email: "dev@example.com", created: true } });
    expect(JSON.stringify(res)).not.toContain("uemcp_");
    expect(settings.accountToken()).toBe("uemcp_new");
    expect(settings.accountLogin()).toBe("dev@example.com");
    expect(settings.accountProfile()).toEqual({ email: "dev@example.com", github: null });
    expect(hits.at(-1)).toMatchObject({ method: "GET", url: "/api/account", auth: "Bearer uemcp_new" });
    expect(changes).toBeGreaterThan(0);
  });

  it("sign in to an account GitHub created: the account view says GitHub is linked too", async () => {
    answers["POST /api/auth/email/verify"] = { status: 200, body: { ok: true, token: "uemcp_old", prefix: "uemcp_ol", login: "octocat", email: "cat@example.com", created: false } };
    answers["GET /api/account"] = { status: 200, body: VIEW_BOTH };
    const res = await routes()("POST /auth/email/verify", { email: "cat@example.com", code: "654321" });
    expect(res.body).toEqual({ ok: true, login: "octocat", email: "cat@example.com", created: false });
    expect(settings.accountLogin()).toBe("octocat");
    expect(settings.accountProfile()).toEqual({ email: "cat@example.com", github: "octocat" });
  });

  it.each(["", "dev", "dev@", "@example.com", "dev@example", "two words@example.com", 42, null])("refuses %j before asking the service", async (email) => {
    const call = routes();
    expect(await call("POST /auth/email/start", { email })).toEqual({ status: 400, body: { error: ACCOUNT_EMAIL_MALFORMED } });
    expect(await call("POST /auth/email/verify", { email, code: "123456" })).toEqual({ status: 400, body: { error: ACCOUNT_EMAIL_MALFORMED } });
    expect(hits).toEqual([]);
  });

  it("passes a 429 on with retryAfter, from the body or the Retry-After header", async () => {
    answers["POST /api/auth/email/start"] = { status: 429, body: { error: "Too many codes. Wait a minute.", retryAfter: 42 } };
    const call = routes();
    expect(await call("POST /auth/email/start", { email: "dev@example.com" })).toEqual({ status: 429, body: { error: "Too many codes. Wait a minute.", retryAfter: 42 } });
    answers["POST /api/auth/email/start"] = { status: 429, body: { error: "Slow down." }, headers: { "retry-after": "90" } };
    expect(await call("POST /auth/email/start", { email: "dev@example.com" })).toEqual({ status: 429, body: { error: "Slow down.", retryAfter: 90 } });
    answers["POST /api/auth/email/verify"] = { status: 429, body: { error: "Too many tries.", retryAfter: 300 } };
    expect(await call("POST /auth/email/verify", { email: "dev@example.com", code: "111111" })).toEqual({ status: 429, body: { error: "Too many tries.", retryAfter: 300 } });
    expect(settings.accountToken()).toBeNull();
  });

  it("passes the service's one code error on and keeps nothing", async () => {
    answers["POST /api/auth/email/verify"] = { status: 400, body: { error: ACCOUNT_CODE_ERROR } };
    expect(await routes()("POST /auth/email/verify", { email: "dev@example.com", code: "000000" })).toEqual({ status: 400, body: { error: ACCOUNT_CODE_ERROR } });
    expect(settings.accountToken()).toBeNull();
    expect(changes).toBe(0);
  });

  it("refuses a code that is not 6 digits with the same error, before asking the service", async () => {
    expect(await routes()("POST /auth/email/verify", { email: "dev@example.com", code: "12ab" })).toEqual({ status: 400, body: { error: ACCOUNT_CODE_ERROR } });
    expect(hits).toEqual([]);
  });

  it("passes on email sign-in not being available", async () => {
    answers["POST /api/auth/email/start"] = { status: 503, body: { error: "Email sign-in is not available." } };
    expect(await routes()("POST /auth/email/start", { email: "dev@example.com" })).toEqual({ status: 503, body: { error: "Email sign-in is not available." } });
  });
});

describe("the signed-in account", () => {
  const signedIn = (profile = { email: null as string | null, github: "octocat" as string | null }, login = "octocat") => settings.signIn("uemcp_tok", login, profile);

  it("signed out: every account route refuses without asking the service", async () => {
    const call = routes();
    for (const [key, body] of [["GET /account/profile"], ["POST /account/email/start", { email: "a@b.co" }], ["DELETE /account/email"], ["DELETE /account/github"], ["POST /account/github/link"]] as const) {
      expect(await call(key, body), key).toEqual({ status: 401, body: { error: ACCOUNT_SIGNED_OUT } });
    }
    expect(hits).toEqual([]);
  });

  it("reads the account view with the token, keeps its email and GitHub login, and never sends the token on", async () => {
    signedIn({ email: null, github: null });
    answers["GET /api/account"] = { status: 200, body: VIEW_BOTH };
    const res = await routes()("GET /account/profile");
    expect(res.body).toEqual(VIEW_BOTH);
    expect(hits[0].auth).toBe("Bearer uemcp_tok");
    expect(settings.accountProfile()).toEqual({ email: "cat@example.com", github: "octocat" });
    expect(changes).toBe(1);
    // The same view again changes nothing.
    await routes()("GET /account/profile");
    expect(changes).toBe(1);
  });

  it("adds an email to a GitHub account: the code, then the account view with the address", async () => {
    signedIn();
    answers["POST /api/account/email/start"] = { status: 200, body: { ok: true, expiresInSeconds: 600 } };
    answers["POST /api/account/email/verify"] = { status: 200, body: VIEW_BOTH };
    const call = routes();
    expect((await call("POST /account/email/start", { email: "cat@example.com" })).body).toEqual({ ok: true, expiresInSeconds: 600 });
    expect(hits[0]).toMatchObject({ auth: "Bearer uemcp_tok", body: { email: "cat@example.com" } });
    expect((await call("POST /account/email/verify", { email: "cat@example.com", code: "123456" })).body).toEqual(VIEW_BOTH);
    expect(settings.accountProfile()).toEqual({ email: "cat@example.com", github: "octocat" });
  });

  it("an address another account has: the service's 409 passes on", async () => {
    signedIn();
    const error = "That email already belongs to another UE-MCP account. Sign in with it instead.";
    answers["POST /api/account/email/verify"] = { status: 409, body: { error } };
    expect(await routes()("POST /account/email/verify", { email: "taken@example.com", code: "123456" })).toEqual({ status: 409, body: { error } });
    expect(await routes()("POST /account/email/start", { email: "nope" })).toEqual({ status: 400, body: { error: ACCOUNT_EMAIL_MALFORMED } });
  });

  it("links GitHub: the device flow's GitHub token goes to the account, not to the exchange", async () => {
    signedIn({ email: "dev@example.com", github: null }, "dev@example.com");
    answers["POST /api/account/github"] = { status: 200, body: { ...VIEW_BOTH, email: "dev@example.com" } };
    const call = routes();
    const started = await call("POST /account/github/link");
    expect(started.body).toMatchObject({ state: "pending", userCode: "WXYZ-1234", url: "https://github.com/login/device" });
    await waitUntil(async () => ((await call("GET /account/github/link")).body as { state: string }).state === "done");
    expect((await call("GET /account/github/link")).body).toEqual({ state: "done", login: "octocat" });
    const linked = hits.find((h) => h.url === "/api/account/github")!;
    expect(linked).toMatchObject({ method: "POST", auth: "Bearer uemcp_tok", body: { githubToken: "gho_linked" } });
    expect(hits.some((h) => h.url.includes("/api/cli/exchange"))).toBe(false);
    expect(settings.accountToken()).toBe("uemcp_tok");
    expect(settings.accountProfile()).toEqual({ email: "dev@example.com", github: "octocat" });
  });

  it("linking a GitHub account another account has: the flow ends in the service's refusal", async () => {
    signedIn({ email: "dev@example.com", github: null }, "dev@example.com");
    answers["POST /api/account/github"] = { status: 409, body: { error: "That GitHub account belongs to another UE-MCP account." } };
    const call = routes();
    await call("POST /account/github/link");
    await waitUntil(async () => ((await call("GET /account/github/link")).body as { state: string }).state === "error");
    expect((await call("GET /account/github/link")).body).toEqual({ state: "error", error: "That GitHub account belongs to another UE-MCP account." });
    expect(settings.accountProfile()).toEqual({ email: "dev@example.com", github: null });
  });

  it("unlinks GitHub and removes the email, keeping what the service answers", async () => {
    signedIn({ email: "cat@example.com", github: "octocat" });
    answers["DELETE /api/account/github"] = { status: 200, body: { ...VIEW_BOTH, login: "cat@example.com", github: null } };
    const call = routes();
    expect((await call("DELETE /account/github")).body).toMatchObject({ github: null });
    expect(settings.accountProfile()).toEqual({ email: "cat@example.com", github: null });
    expect(settings.accountLogin()).toBe("cat@example.com");
    answers["DELETE /api/account/email"] = { status: 200, body: VIEW_GITHUB };
    expect((await call("DELETE /account/email")).body).toEqual(VIEW_GITHUB);
    expect(settings.accountProfile()).toEqual({ email: null, github: "octocat" });
  });

  it("removing the last way to sign in: the service's 409 passes on and nothing kept changes", async () => {
    signedIn({ email: null, github: "octocat" });
    answers["DELETE /api/account/github"] = { status: 409, body: { error: "Add an email before unlinking GitHub." } };
    answers["DELETE /api/account/email"] = { status: 409, body: { error: "Link GitHub before removing the email." } };
    const call = routes();
    expect(await call("DELETE /account/github")).toEqual({ status: 409, body: { error: "Add an email before unlinking GitHub." } });
    expect(await call("DELETE /account/email")).toEqual({ status: 409, body: { error: "Link GitHub before removing the email." } });
    expect(settings.accountProfile()).toEqual({ email: null, github: "octocat" });
    expect(changes).toBe(0);
  });

  it("a token the service no longer knows reads as signed out", async () => {
    signedIn();
    answers["GET /api/account"] = { status: 401, body: { error: "unknown token" } };
    expect(await routes()("GET /account/profile")).toEqual({ status: 401, body: { error: ACCOUNT_SIGNED_OUT } });
  });
});

describe("a ue-mcp login account", () => {
  it("reads the account view with the ue-mcp login token, to tell an email login from a GitHub login", async () => {
    registryToken = "uemcp_cli";
    answers["GET /api/account"] = { status: 200, body: { ...VIEW_EMAIL } };
    const call = routes();
    expect(call.registryProfile()).toEqual({});
    expect((await call("GET /account/profile")).body).toEqual(VIEW_EMAIL);
    expect(hits[0]).toMatchObject({ method: "GET", url: "/api/account", auth: "Bearer uemcp_cli" });
    expect(call.registryProfile()).toEqual({ email: "dev@example.com", github: null });
    expect(changes).toBe(1);
    // Nothing is written to the panel's sign-in.
    expect(settings.accountToken()).toBeNull();
  });

  it("the view failing leaves the profile unknown, so the login shows without an @", async () => {
    registryToken = "uemcp_cli";
    answers["GET /api/account"] = { status: 500, body: { error: "boom" } };
    const call = routes();
    expect((await call("GET /account/profile")).status).toBe(502);
    expect(call.registryProfile()).toEqual({});
    expect(changes).toBe(0);
  });

  it("a new ue-mcp login token forgets the old account's profile", async () => {
    registryToken = "uemcp_cli";
    answers["GET /api/account"] = { status: 200, body: VIEW_GITHUB };
    const call = routes();
    await call("GET /account/profile");
    expect(call.registryProfile()).toEqual({ email: null, github: "octocat" });
    registryToken = "uemcp_other";
    expect(call.registryProfile()).toEqual({});
  });

  it("changing how it signs in stays with the panel's sign-in", async () => {
    registryToken = "uemcp_cli";
    const call = routes();
    expect((await call("DELETE /account/github")).status).toBe(401);
    expect(hits).toEqual([]);
  });
});

async function waitUntil(check: () => Promise<boolean>, tries = 50): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timed out");
}

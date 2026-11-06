/** The account host: UE_MCP_AUTH_URL alone when set; otherwise accounts.ue-mcp.com, then the registry host once after a network failure. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_URL_DEFAULT, AUTH_URL_ENV, AUTH_URL_FALLBACK, authBases } from "@ue-mcp-studio/shared";
import { authBasesNow, authFetch } from "../src/auth-url.js";
import { StudioSignInFlow } from "../src/signin.js";

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("authBases", () => {
  it("the default host, then the registry host", () => {
    expect(authBases()).toEqual(["https://accounts.ue-mcp.com", "https://plugins.ue-mcp.com"]);
    expect([AUTH_URL_DEFAULT, AUTH_URL_FALLBACK]).toEqual(authBases(""));
  });

  it("an override alone, without its trailing slash", () => {
    expect(authBases("http://localhost:8787/")).toEqual(["http://localhost:8787"]);
  });

  it("reads UE_MCP_AUTH_URL", () => {
    vi.stubEnv(AUTH_URL_ENV, "https://auth.test");
    expect(authBasesNow()).toEqual(["https://auth.test"]);
  });
});

describe("authFetch", () => {
  it("retries once against the registry host when the default cannot be reached", async () => {
    const urls: string[] = [];
    const f = (async (url: string) => {
      urls.push(url);
      if (url.startsWith(AUTH_URL_DEFAULT)) throw new TypeError("fetch failed: getaddrinfo ENOTFOUND accounts.ue-mcp.com");
      return reply({ email: true, github: true });
    }) as unknown as typeof fetch;
    const res = await authFetch(f, "/api/auth/methods", () => ({}), authBases());
    expect(await res.json()).toEqual({ email: true, github: true });
    expect(urls).toEqual(["https://accounts.ue-mcp.com/api/auth/methods", "https://plugins.ue-mcp.com/api/auth/methods"]);
  });

  it("an HTTP answer of any status is the answer: no retry", async () => {
    const urls: string[] = [];
    const f = (async (url: string) => {
      urls.push(url);
      return reply({ error: "boom" }, 500);
    }) as unknown as typeof fetch;
    expect((await authFetch(f, "/api/account", () => ({}), authBases())).status).toBe(500);
    expect(urls).toHaveLength(1);
  });

  it("with UE_MCP_AUTH_URL set, a network failure is not retried elsewhere", async () => {
    vi.stubEnv(AUTH_URL_ENV, "https://auth.test");
    const urls: string[] = [];
    const f = (async (url: string) => {
      urls.push(url);
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(authFetch(f, "/api/account", () => ({}))).rejects.toThrow("fetch failed");
    expect(urls).toEqual(["https://auth.test/api/account"]);
  });

  it("builds the request again for the retry, so a spent signal does not carry over", async () => {
    const inits: RequestInit[] = [];
    let n = 0;
    const f = (async (_url: string, init: RequestInit) => {
      inits.push(init);
      if (n++ === 0) throw new TypeError("fetch failed");
      return reply({});
    }) as unknown as typeof fetch;
    await authFetch(f, "/x", () => ({ signal: new AbortController().signal }), authBases());
    expect(inits).toHaveLength(2);
    expect(inits[0]).not.toBe(inits[1]);
  });
});

describe("the GitHub sign-in's exchange", () => {
  it("goes to the account host, and to the registry host when that cannot be reached", async () => {
    const urls: string[] = [];
    const f = (async (url: string) => {
      urls.push(url);
      if (url.endsWith("/login/device/code")) return reply({ device_code: "dc", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 });
      if (url.endsWith("/access_token")) return reply({ access_token: "gho_x" });
      if (url.startsWith(AUTH_URL_DEFAULT)) throw new TypeError("fetch failed");
      if (url === `${AUTH_URL_FALLBACK}/api/cli/exchange`) return reply({ token: "uemcp_t", login: "octo", email: null });
      throw new Error(url);
    }) as unknown as typeof fetch;
    let saved: string[] = [];
    const flow = new StudioSignInFlow((t, l) => { saved = [t, l]; }, f, async () => {});
    await flow.start();
    await new Promise((r) => setTimeout(r, 10));
    expect(saved).toEqual(["uemcp_t", "octo"]);
    expect(urls.filter((u) => u.includes("/api/cli/exchange"))).toEqual([`${AUTH_URL_DEFAULT}/api/cli/exchange`, `${AUTH_URL_FALLBACK}/api/cli/exchange`]);
  });
});

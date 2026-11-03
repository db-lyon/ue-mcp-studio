/** /billing/checkout and /billing/portal: the gateway's links with the shared account token, against a stub gateway. */
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionHandler } from "ue-mcp/daemon";
import { ACCOUNT_SIGNED_OUT } from "@ue-mcp-studio/shared";
import { AccountSource } from "../src/account-source.js";
import { registerBilling } from "../src/billing-routes.js";

interface Hit {
  method: string;
  url: string;
  auth?: string;
  body: string;
}
const hits: Hit[] = [];
let answer: { status: number; body: unknown } = { status: 200, body: {} };
const gateway = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    hits.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
    res.writeHead(answer.status, { "content-type": "application/json" }).end(JSON.stringify(answer.body));
  });
});
let gatewayUrl = "";

beforeAll(async () => {
  await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", () => r()));
  gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/`;
});
afterAll(async () => {
  gateway.closeAllConnections();
  await new Promise((r) => gateway.close(r));
});
beforeEach(() => {
  hits.length = 0;
  answer = { status: 200, body: { url: "https://checkout.stripe.test/c/1", provider: "stripe" } };
});

function routes(o: { panel?: string | null; registry?: string | null; url?: string } = {}) {
  const map = new Map<string, ExtensionHandler>();
  const account = new AccountSource(
    { accountToken: () => o.panel ?? null, accountLogin: () => null },
    async () => (o.registry ? { login: "cli", token: o.registry } : null),
  );
  registerBilling({ route: (m: string, p: string, h: ExtensionHandler) => void map.set(`${m} ${p}`, h) } as never, { account, gatewayUrl: () => o.url ?? gatewayUrl });
  return async (key: string, body?: unknown) => (await map.get(key)!({ method: "", path: "", params: {}, query: {}, headers: {}, body } as never)) ?? {};
}

describe("POST /billing/checkout", () => {
  it("asks the gateway with the panel sign-in's token ahead of ue-mcp login's, and passes the checkout link on", async () => {
    const call = routes({ panel: "uemcp_panel", registry: "uemcp_cli" });
    expect(await call("POST /billing/checkout", { plan: "pro", interval: "year" })).toEqual({ body: { url: "https://checkout.stripe.test/c/1", provider: "stripe" } });
    expect(hits).toEqual([{ method: "POST", url: "/v1/billing/checkout", auth: "Bearer uemcp_panel", body: JSON.stringify({ plan: "pro", interval: "year" }) }]);
  });

  it("uses the ue-mcp login token when the panel has none, and monthly by default", async () => {
    const call = routes({ registry: "uemcp_cli" });
    await call("POST /billing/checkout", { plan: "studio" });
    expect(hits[0]).toMatchObject({ auth: "Bearer uemcp_cli", body: JSON.stringify({ plan: "studio", interval: "month" }) });
  });

  it("refuses a signed-out computer without asking the gateway, pointing at the in-app sign-in", async () => {
    expect(await routes()("POST /billing/checkout", { plan: "pro" })).toEqual({ status: 401, body: { error: ACCOUNT_SIGNED_OUT, code: "signed-out" } });
    expect(hits).toEqual([]);
  });

  it("refuses a plan or interval the gateway does not sell", async () => {
    const call = routes({ panel: "uemcp_panel" });
    expect((await call("POST /billing/checkout", { plan: "free" })).status).toBe(400);
    expect((await call("POST /billing/checkout", { plan: "pro", interval: "week" })).status).toBe(400);
    expect(hits).toEqual([]);
  });

  it.each([
    [409, { error: "already subscribed" }, { status: 409, body: { error: "This account already has a subscription.", code: "subscribed" } }],
    [401, { error: "unknown token" }, { status: 401, body: { error: ACCOUNT_SIGNED_OUT, code: "signed-out" } }],
    [503, { error: "billing off" }, { status: 503, body: { error: "Plans cannot be bought yet.", code: "unavailable" } }],
    [500, { error: "boom" }, { status: 502, body: { error: "boom" } }],
    [200, { url: "http://checkout.test/insecure" }, { status: 502, body: { error: "The account service sent no payment page." } }],
  ])("gateway %s: answers in Studio's words", async (status, body, expected) => {
    answer = { status, body };
    expect(await routes({ panel: "uemcp_panel" })("POST /billing/checkout", { plan: "pro" })).toEqual(expected);
  });

  it("says so when the gateway cannot be reached", async () => {
    const call = routes({ panel: "uemcp_panel", url: "http://127.0.0.1:1" });
    expect(await call("POST /billing/checkout", { plan: "pro" })).toEqual({ status: 502, body: { error: "Could not reach the account service." } });
  });
});

describe("GET /billing/portal", () => {
  it("passes the portal link on, asked with the account token", async () => {
    answer = { status: 200, body: { url: "https://billing.stripe.test/p/1", provider: "stripe" } };
    expect(await routes({ panel: "uemcp_panel" })("GET /billing/portal")).toEqual({ body: { url: "https://billing.stripe.test/p/1", provider: "stripe" } });
    expect(hits).toEqual([{ method: "GET", url: "/v1/billing/portal", auth: "Bearer uemcp_panel", body: "" }]);
  });

  it("an account without a subscription", async () => {
    answer = { status: 404, body: { error: "no customer" } };
    expect(await routes({ panel: "uemcp_panel" })("GET /billing/portal")).toEqual({ status: 404, body: { error: "This account has no subscription to manage.", code: "no-subscription" } });
  });
});

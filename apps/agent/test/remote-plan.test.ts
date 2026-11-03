/** Remote control's plan check: the gateway's AccountUsage read with the `ue-mcp login` token, cached briefly. */
import { describe, expect, it } from "vitest";
import { hasPaidPlan, type AccountUsage } from "@ue-mcp-studio/shared";
import { PLAN_CHECK_TTL_MS, RemotePlanCheck } from "../src/remote/plan.js";

const NOW = Date.parse("2026-11-03T12:00:00Z");

function usage(over: { plan?: string; status?: AccountUsage["status"]; periodEnd?: string } = {}): AccountUsage {
  return {
    userId: "u1",
    login: "dev",
    plan: { id: over.plan ?? "pro", name: "Pro", models: ["m"] },
    status: over.status ?? "active",
    periodStart: "2026-11-01T00:00:00Z",
    periodEnd: over.periodEnd ?? "2026-12-01T00:00:00Z",
    used: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    billableTokens: 0,
    quota: 1,
    remaining: 1,
  };
}

function check(answer: () => Response | Promise<Response>, o: { token?: string | null; now?: () => number } = {}) {
  const calls: Array<{ url: string; auth?: string }> = [];
  const plan = new RemotePlanCheck({
    token: async () => (o.token === undefined ? "uemcp_dev" : o.token),
    gatewayUrl: () => "https://gateway.test/",
    now: o.now ?? (() => NOW),
    fetch: async (url, init) => {
      calls.push({ url, auth: init?.headers?.authorization });
      return answer();
    },
  });
  return { plan, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("hasPaidPlan", () => {
  const now = new Date(NOW);
  it("is pro or studio, active or past_due, with the period end not passed", () => {
    expect(hasPaidPlan(usage(), now)).toBe(true);
    expect(hasPaidPlan(usage({ plan: "studio", status: "past_due" }), now)).toBe(true);
    expect(hasPaidPlan(usage({ plan: "free" }), now)).toBe(false);
    expect(hasPaidPlan(usage({ status: "canceled" }), now)).toBe(false);
    expect(hasPaidPlan(usage({ status: "none" }), now)).toBe(false);
    expect(hasPaidPlan(usage({ periodEnd: "2026-11-03T11:59:59Z" }), now)).toBe(false);
    expect(hasPaidPlan(usage({ periodEnd: "not a date" }), now)).toBe(false);
  });
});

describe("RemotePlanCheck", () => {
  it("is available for a paid account, asking the gateway's usage route with the account token", async () => {
    const { plan, calls } = check(() => json(usage()));
    expect(await plan.available()).toBe(true);
    expect(calls).toEqual([{ url: "https://gateway.test/v1/account/usage", auth: "Bearer uemcp_dev" }]);
  });

  it.each([
    ["a free account", () => json(usage({ plan: "free" }))],
    ["a canceled plan", () => json(usage({ status: "canceled" }))],
    ["an expired period", () => json(usage({ periodEnd: "2026-10-31T00:00:00Z" }))],
    ["a gateway error", () => json({ error: "boom" }, 500)],
    ["an expired sign-in", () => json({ error: "sign in" }, 401)],
    ["a body that is not JSON", () => new Response("<html>", { status: 200 })],
    ["an unreachable gateway", () => Promise.reject(new Error("ECONNREFUSED"))],
  ])("is not available with %s", async (_name, answer) => {
    expect(await check(answer).plan.available()).toBe(false);
  });

  it("is not available with no token, and does not ask the gateway", async () => {
    const { plan, calls } = check(() => json(usage()), { token: null });
    expect(await plan.available()).toBe(false);
    expect(calls).toEqual([]);
  });

  it("caches the answer for a few minutes; force and invalidate ask again", async () => {
    let now = NOW;
    let paid = false;
    const { plan, calls } = check(() => json(usage({ plan: paid ? "pro" : "free" })), { now: () => now });
    expect(await plan.available()).toBe(false);
    paid = true;
    now += PLAN_CHECK_TTL_MS - 1;
    expect(await plan.available()).toBe(false);
    expect(calls.length).toBe(1);
    now += 1;
    expect(await plan.available()).toBe(true);
    expect(calls.length).toBe(2);
    expect(await plan.available(true)).toBe(true);
    expect(calls.length).toBe(3);
    plan.invalidate();
    await plan.available();
    expect(calls.length).toBe(4);
  });

  it("shares one request between callers that ask at once", async () => {
    const { plan, calls } = check(() => json(usage()));
    expect(await Promise.all([plan.available(true), plan.available(true), plan.available()])).toEqual([true, true, true]);
    expect(calls.length).toBe(1);
  });
});

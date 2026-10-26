/** Usage's routes against a fake daemon API and a ledger on disk. */
import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DaemonExtensionApi } from "ue-mcp/daemon";
import { DEFAULT_BUDGETS, type Budgets, type PlanMeter, type UsageRecord, type UsageSummary, type UsageWarning } from "@ue-mcp-studio/shared";
import { Ledger } from "../src/ledger.js";
import { PlanStore } from "../src/plans.js";
import { PriceStore } from "../src/prices.js";
import { periodOf, registerUsageRoutes } from "../src/usage-routes.js";

type Handler = (req: { body?: unknown; query?: Record<string, string> }) => { status?: number; body?: unknown };
let dir: string;
let routes: Map<string, Handler>;
let ledger: Ledger;
let plans: PlanStore;
let budgets: Budgets;
let published: string[];
const now = new Date(2026, 9, 25, 15);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-usage-routes-"));
  routes = new Map();
  published = [];
  ledger = new Ledger(dir, () => now);
  plans = new PlanStore(dir, () => now);
  budgets = structuredClone(DEFAULT_BUDGETS);
  const api = { route: (m: string, p: string, h: Handler) => void routes.set(`${m} ${p}`, h), events: { publish: (t: string) => void published.push(t) } } as unknown as DaemonExtensionApi;
  registerUsageRoutes(api, {
    ledger,
    prices: new PriceStore(dir),
    plans,
    budgets: () => budgets,
    agentName: (id) => ({ main: "Main agent" } as Record<string, string>)[id] ?? id,
    modelName: (_v, m) => m.toUpperCase(),
    vendorName: (v) => v[0].toUpperCase() + v.slice(1),
    routeName: (r) => ({ claude: "Claude sign-in", key: "API key", chatgpt: "ChatGPT sign-in" } as Record<string, string>)[r] ?? r,
    sessionTitle: (id) => (id === "s1" ? "Dress the cave" : null),
    signedIn: () => [{ route: "claude", name: "Claude sign-in" }, { route: "chatgpt", name: "ChatGPT sign-in" }],
    connectedVendors: () => ["anthropic", "openai"],
    now: () => now,
  });
});

const call = (key: string, query: Record<string, string> = {}, body?: unknown) => routes.get(key)!({ query, body });
const rec = (o: Partial<UsageRecord> = {}): Omit<UsageRecord, "at"> & { at?: string } => ({
  sessionId: "s1", turnId: "s1:0", agentId: "main", parentAgentId: null, source: "chat", vendor: "anthropic", model: "claude-opus-5-5", route: "key",
  tokens: { input: 1000, cacheRead: 0, cacheWrite: 0, output: 100 }, durationMs: 10, ...o,
});

describe("usage routes", () => {
  it("summarises the last seven days by default, grouped and labelled, with sessions by title", () => {
    ledger.append(rec({ at: new Date(2026, 9, 24, 10).toISOString() }));
    ledger.append(rec({ agentId: "scout", vendor: "openai", model: "gpt-6-luna", route: "chatgpt", sessionId: "gone", at: new Date(2026, 9, 25, 10).toISOString() }));
    ledger.append(rec({ at: new Date(2026, 9, 1, 10).toISOString() }));
    const s = call("GET /usage/summary", { groupBy: "model" }).body as UsageSummary;
    expect(s.rows.map((r) => [r.key, r.label])).toEqual([["anthropic:claude-opus-5-5", "CLAUDE-OPUS-5-5"], ["openai:gpt-6-luna", "GPT-6-LUNA"]]);
    expect(s.days).toHaveLength(7);
    expect(s.sessions.map((x) => x.title).sort()).toEqual(["A deleted session", "Dress the cave"]);
    // Only the key call is priced; the sign-in call makes the total partial.
    expect(s.total.cost).not.toBeNull();
    expect(s.total.costPartial).toBe(true);
    expect((call("GET /usage/summary", { groupBy: "route", route: "chatgpt" }).body as UsageSummary).rows.map((r) => r.label)).toEqual(["ChatGPT sign-in"]);
  });

  it("refuses an unknown grouping, a bad period and an unknown source", () => {
    expect(call("GET /usage/summary", { groupBy: "colour" }).status).toBe(400);
    expect(call("GET /usage/summary", { from: "2026-10-20", to: "2026-10-10" }).status).toBe(400);
    expect(call("GET /usage/summary", { source: "web" }).status).toBe(400);
    expect("error" in periodOf({ from: "2024-01-01", to: "2026-01-01" }, now)).toBe(true);
  });

  it("lists records newest first, up to a limit", () => {
    for (let i = 0; i < 5; i++) ledger.append(rec({ durationMs: i, at: new Date(2026, 9, 25, 10, i).toISOString() }));
    const r = call("GET /usage/records", { limit: "2" }).body as { records: UsageRecord[]; total: number };
    expect(r.total).toBe(5);
    expect(r.records.map((x) => x.durationMs)).toEqual([4, 3]);
  });

  it("gives each signed-in plan its last windows and the tokens sent through it, and says when one never reported", () => {
    plans.report("claude", [{ kind: "five_hour", label: "Five-hour window", used: 0.85, resetsAt: new Date(2026, 9, 25, 17).toISOString(), status: "allowed_warning" as never }]);
    ledger.append(rec({ route: "claude", tokens: { input: 10, cacheRead: 90, cacheWrite: 0, output: 5 } }));
    const plansBody = (call("GET /usage/plans").body as { plans: PlanMeter[] }).plans;
    expect(plansBody.map((p) => [p.route, p.reportedAt !== null, p.windows.length, p.tokens.cacheRead])).toEqual([["claude", true, 1, 90], ["chatgpt", false, 0, null]]);
  });

  it("warns on budgets past the warning share and plan windows near their limit", () => {
    budgets.team = { perDayTokens: 1000, perMonthTokens: null, onLimit: "ask" };
    ledger.append(rec());
    plans.report("chatgpt", [{ kind: "primary", label: "5-hour window", used: 0.9, resetsAt: null, status: "allowed" }]);
    const w = (call("GET /usage/warnings").body as { warnings: UsageWarning[] }).warnings;
    expect(w.map((x) => [x.kind, x.severity, x.text])).toEqual([
      ["budget", "bad", "110% of the budget for all agents today"],
      ["plan-limit", "warn", "ChatGPT sign-in: 90% of the 5-hour window limit used"],
    ]);
  });

  it("explains caching for the vendors a connected route reaches", () => {
    const e = (call("GET /usage/cache").body as { explainers: Array<{ vendor: string; what: string; whoDecides: string; cachedReadCost: string; howLong: string }> }).explainers;
    expect(e.map((x) => x.vendor)).toEqual(["anthropic", "openai"]);
    for (const x of e) expect([x.what, x.whoDecides, x.cachedReadCost, x.howLong].every(Boolean)).toBe(true);
  });

  it("explains caching apart for a vendor the price table lists but nothing connects", () => {
    const body = call("GET /usage/cache").body as { explainers: Array<{ vendor: string }>; others: Array<{ vendor: string }> };
    expect(body.others.map((x) => x.vendor)).toEqual(["google"]);
  });

  it("saves the user's own prices and refuses a bad one", () => {
    const put = call("PUT /prices", {}, { prices: [{ vendor: "google", model: "gemini-3.8-flash", perMTok: { input: 0.3, output: 2.5 } }] });
    expect((put.body as { prices: Array<{ vendor: string; user?: boolean }> }).prices[0]).toMatchObject({ vendor: "google", user: true });
    expect(published).toContain("usage.changed");
    expect(call("PUT /prices", {}, { prices: [{ vendor: "google" }] }).status).toBe(400);
  });
});

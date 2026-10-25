/** The usage ledger, the price table, plan windows and the budget states read from them. */
import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_BUDGETS, type Budgets, type PlanWindow, type UsageRecord } from "@ue-mcp-studio/shared";
import { Ledger, budgetStates, budgetText, budgetWarnings, cachedShare, localDay, overBudget, rowOf, summarize } from "../src/ledger.js";
import { PriceStore, SHIPPED_PRICES, costOf, priceFor } from "../src/prices.js";
import { PlanStore, chatgptWindows, claudeWindow } from "../src/plans.js";

let dir: string;
let clock: Date;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-ledger-"));
  clock = new Date(2026, 9, 25, 15, 0, 0);
});

const rec = (o: Partial<UsageRecord> = {}): Omit<UsageRecord, "at"> & { at?: string } => ({
  sessionId: "s1",
  turnId: "s1:0",
  agentId: "main",
  parentAgentId: null,
  source: "chat",
  vendor: "anthropic",
  model: "claude-opus-5-5",
  route: "key",
  tokens: { input: 1000, cacheRead: 3000, cacheWrite: 200, output: 500 },
  durationMs: 1200,
  ...o,
});

describe("the ledger", () => {
  it("appends one JSON line per call to the month's file and reads it back after a restart", () => {
    const l = new Ledger(dir, () => clock);
    l.append(rec());
    l.append(rec({ at: new Date(2026, 8, 30, 12).toISOString() }));
    expect(fs.readdirSync(path.join(dir, "usage")).sort()).toEqual(["2026-09.jsonl", "2026-10.jsonl"]);
    const again = new Ledger(dir, () => clock);
    expect(again.records(new Date(2026, 8, 1), new Date(2026, 10, 1))).toHaveLength(2);
    expect(again.starts()).toBe(new Date(2026, 8, 30, 12).toISOString());
  });

  it("keeps the records of a file whose last line a crash tore", () => {
    fs.mkdirSync(path.join(dir, "usage"), { recursive: true });
    fs.writeFileSync(path.join(dir, "usage", "2026-10.jsonl"), `${JSON.stringify({ ...rec(), at: clock.toISOString() })}\n{"at":"2026-10-2`);
    expect(new Ledger(dir, () => clock).records(new Date(2026, 9, 1), new Date(2026, 10, 1))).toHaveLength(1);
  });

  it("filters by agent, vendor, route, source and session", () => {
    const l = new Ledger(dir, () => clock);
    l.append(rec());
    l.append(rec({ agentId: "scout", vendor: "openai", model: "gpt-6-luna", route: "chatgpt", source: "quick", sessionId: "s2" }));
    const all = [new Date(2026, 9, 1), new Date(2026, 10, 1)] as const;
    expect(l.records(...all, { agent: "scout" })).toHaveLength(1);
    expect(l.records(...all, { vendor: "anthropic" })).toHaveLength(1);
    expect(l.records(...all, { route: "chatgpt", source: "quick", session: "s2" })).toHaveLength(1);
  });

  it("sums today by agent and this month from the records, in budget tokens", () => {
    const l = new Ledger(dir, () => clock);
    l.append(rec());
    l.append(rec({ agentId: "scout" }));
    l.append(rec({ at: new Date(2026, 9, 24, 12).toISOString() }));
    // Budget tokens: input + cache writes + output, cached reads left out.
    expect(l.today().byAgent.get("main")).toBe(1700);
    expect(l.today().total).toBe(3400);
    expect(l.thisMonth().total).toBe(5100);
  });
});

describe("rows and the summary", () => {
  it("prices only key and endpoint calls, says when a row is partly priced, and never shows a missing kind as zero", () => {
    const prices = SHIPPED_PRICES;
    const key = rowOf("k", "Key", [{ ...rec(), at: clock.toISOString() } as UsageRecord], prices);
    // Opus 5.5: 1000 x $4 + 3000 x $0.20 + 200 x $5 + 500 x $20, per million.
    expect(key.cost).toBeCloseTo((1000 * 4 + 3000 * 0.2 + 200 * 5 + 500 * 20) / 1e6, 10);
    expect(key.costPartial).toBe(false);
    const mixed = rowOf("m", "Mixed", [{ ...rec(), at: "" }, { ...rec({ route: "claude" }), at: "" }] as UsageRecord[], prices);
    expect(mixed.costPartial).toBe(true);
    const plan = rowOf("p", "Plan", [{ ...rec({ route: "chatgpt", tokens: { input: 10, cacheRead: null, cacheWrite: null, output: 5 } }), at: "" }] as UsageRecord[], prices);
    expect(plan.cost).toBeNull();
    expect(plan.tokens.cacheRead).toBeNull();
    expect(plan.cachedShare).toBeNull();
  });

  it("groups a period by agent with a bar per day, compares a period the ledger fully saw, and lists sessions", () => {
    const l = new Ledger(dir, () => clock);
    l.append(rec({ sessionId: "old", at: new Date(2026, 9, 10, 9).toISOString() }));
    l.append(rec({ sessionId: "old", at: new Date(2026, 9, 15, 9).toISOString() }));
    l.append(rec({ at: new Date(2026, 9, 24, 9).toISOString() }));
    l.append(rec({ agentId: "scout", parentAgentId: "main", at: new Date(2026, 9, 25, 9).toISOString() }));
    const s = summarize(l, { from: new Date(2026, 9, 19), to: new Date(2026, 9, 26), groupBy: "agent", filter: {}, prices: SHIPPED_PRICES, label: (_g, k) => k.toUpperCase(), sessions: () => ({ title: "Dress the cave" }) });
    expect(s.rows.map((r) => [r.key, r.label, r.budgetTokens])).toEqual([["main", "MAIN", 1700], ["scout", "SCOUT", 1700]]);
    expect(s.days).toHaveLength(7);
    expect(s.days.find((d) => d.day === "2026-10-25")?.byKey).toEqual({ scout: 1700 });
    expect(s.previous).toEqual({ budgetTokens: 1700, cachedShare: 3000 / 4200 });
    expect(s.sessions).toEqual([expect.objectContaining({ id: "s1", title: "Dress the cave", agents: ["main", "scout"], budgetTokens: 3400, turns: 1 })]);
  });

  it("compares with nothing when the ledger started inside the period before", () => {
    const l = new Ledger(dir, () => clock);
    l.append(rec({ at: new Date(2026, 9, 15, 9).toISOString() }));
    const s = summarize(l, { from: new Date(2026, 9, 19), to: new Date(2026, 9, 26), groupBy: "model", filter: {}, prices: [], label: (_g, k) => k, sessions: () => null });
    expect(s.previous).toBeNull();
    expect(s.ledgerStarts).toBe(new Date(2026, 9, 15, 9).toISOString());
  });

  it("reads the cached share against every input read", () => {
    expect(cachedShare({ input: 100, cacheRead: 300, cacheWrite: 100, output: 9 })).toBe(0.6);
    expect(cachedShare({ input: 100, cacheRead: null, cacheWrite: null, output: 9 })).toBeNull();
    expect(localDay(new Date(2026, 0, 2, 23, 59))).toBe("2026-01-02");
  });
});

describe("budget states", () => {
  const budgets = (o: Partial<Budgets> = {}): Budgets => ({ ...DEFAULT_BUDGETS, ...o });

  it("finds the agent's own day, the team's day and the month, each with how it answers", () => {
    const b = budgets({ agents: { scout: { perRunTokens: null, perRunMinutes: null, perDayTokens: 1000, onLimit: "ask" } }, team: { perDayTokens: 5000, perMonthTokens: 9000, onLimit: "stop" } });
    const states = budgetStates(b, { byAgent: new Map([["scout", 1200]]), total: 1200 }, { total: 9500 }, clock);
    expect(states.map((s) => [s.scope, s.spent, s.limit, s.onLimit, s.period])).toEqual([
      ["agent-day", 1200, 1000, "ask", "2026-10-25"],
      ["team-day", 1200, 5000, "stop", "2026-10-25"],
      ["team-month", 9500, 9000, "stop", "2026-10"],
    ]);
    expect(overBudget(states, "scout")?.scope).toBe("agent-day");
    // Another agent is not held by scout's own day, only by the team's month.
    expect(overBudget(states, "main")?.scope).toBe("team-month");
    expect(overBudget(states.slice(0, 2), "main")).toBeNull();
    expect(budgetText(states[2])).toBe("the budget for all agents this month (9,500 of 9,000 tokens) in Usage > Budgets was reached");
  });

  it("warns from the warning share, and says when a budget is reached", () => {
    const states = budgetStates(budgets({ team: { perDayTokens: 1000, perMonthTokens: 10000, onLimit: "ask" } }), { byAgent: new Map(), total: 850 }, { total: 10000 }, clock);
    const w = budgetWarnings(states, 0.8);
    expect(w.map((x) => [x.severity, x.text])).toEqual([
      ["warn", "85% of the budget for all agents today"],
      ["bad", "100% of the budget for all agents this month"],
    ]);
    expect(w[1].detail).toBe("Each further call asks you first.");
  });
});

describe("prices", () => {
  it("prefers the user's own price, matches a family, and leaves an unpriced kind uncosted", () => {
    const store = new PriceStore(dir);
    store.setOwn([{ vendor: "openai", model: "gpt-6*", perMTok: { input: 1, cacheRead: 0.1, cacheWrite: null, output: 4 } }, { vendor: "anthropic", model: "claude-opus-5-5", perMTok: { input: 3, output: 15 } }]);
    const all = new PriceStore(dir).all();
    expect(priceFor(all, "openai", "gpt-6-luna")?.perMTok.output).toBe(4);
    expect(priceFor(all, "anthropic", "claude-opus-5-5")?.user).toBe(true);
    expect(priceFor(all, "anthropic", "claude-sonnet-5-5")?.source).toContain("platform.claude.com");
    // Haiku's cached read has no shipped price: a call that used it gets no cost rather than a guess.
    expect(costOf(priceFor(all, "anthropic", "claude-haiku-5-5"), { input: 10, cacheRead: 5, cacheWrite: 0, output: 1 })).toBeNull();
    expect(costOf(priceFor(all, "anthropic", "claude-haiku-5-5"), { input: 1_000_000, cacheRead: 0, cacheWrite: null, output: 0 })).toBeCloseTo(0.1);
    expect(priceFor(all, "google", "gemini-9-ultra")).toBeNull();
    // Every vendor Studio lists ships priced, each from its own page and dated, with what a flat rate leaves out.
    for (const [vendor, model] of [["openai", "gpt-6-sol"], ["openai", "gpt-6-luna"], ["google", "gemini-3.1-pro-preview"], ["google", "gemini-3.8-flash"]]) {
      const p = priceFor(SHIPPED_PRICES, vendor, model)!;
      expect(p.source).toMatch(/^https:\/\/(developers\.openai\.com|ai\.google\.dev)\//);
      expect(p.note).toBeTruthy();
      expect(p.perMTok.cacheWrite).toBe(0);
    }
  });

  it("refuses a price without a vendor, a model or any rate, and negative rates", () => {
    const store = new PriceStore(dir);
    expect(() => store.setOwn([{ model: "x", perMTok: { input: 1 } }])).toThrow(/vendor and a model/);
    expect(() => store.setOwn([{ vendor: "v", model: "x", perMTok: {} }])).toThrow(/no rate/);
    expect(() => store.setOwn([{ vendor: "v", model: "x", perMTok: { input: -1 } }])).toThrow(/zero or more/);
    expect(() => store.setOwn("nope")).toThrow(/list/);
  });
});

describe("plan windows", () => {
  it("reads ChatGPT's limit headers, and nothing when a response carries none", () => {
    const h = new Headers({ "x-codex-primary-used-percent": "42", "x-codex-primary-window-minutes": "300", "x-codex-primary-reset-after-seconds": "600", "x-codex-secondary-used-percent": "100", "x-codex-secondary-window-minutes": "10080" });
    const w = chatgptWindows(h, Date.UTC(2026, 9, 25, 12));
    expect(w).toEqual([
      { kind: "primary", label: "5-hour window", used: 0.42, resetsAt: "2026-10-25T12:10:00.000Z", status: "allowed" },
      { kind: "secondary", label: "Weekly window", used: 1, resetsAt: null, status: "rejected" },
    ]);
    expect(chatgptWindows(new Headers())).toEqual([]);
  });

  it("hands each ChatGPT response's headers to the meter, even when the call fails, and a bad header never fails it", async () => {
    const { ResponsesProvider } = await import("../src/responses.js");
    const seen: PlanWindow[][] = [];
    const fetchImpl = (async () => new Response("{\"error\":{\"message\":\"limit\"}}", { status: 429, headers: { "x-codex-primary-used-percent": "100", "x-codex-primary-window-minutes": "300" } })) as typeof fetch;
    const p = new ResponsesProvider(async () => "token", fetchImpl, (h) => void seen.push(chatgptWindows(h)));
    await expect(p.run({ sessionId: "s", model: "gpt-6-sol", effort: "high", system: [], tools: [], search: false, messages: [{ role: "user", content: "hi" }] } as never, () => {}, new AbortController().signal)).rejects.toThrow(/ChatGPT 429/);
    expect(seen).toEqual([[expect.objectContaining({ kind: "primary", used: 1, status: "rejected" })]]);
    const throwing = new ResponsesProvider(async () => "token", fetchImpl, () => { throw new Error("meter broke"); });
    await expect(throwing.run({ sessionId: "s", model: "gpt-6-sol", effort: "high", system: [], tools: [], search: false, messages: [{ role: "user", content: "hi" }] } as never, () => {}, new AbortController().signal)).rejects.toThrow(/ChatGPT 429/);
  });

  it("reads the Agent SDK's rate-limit event, its reset in seconds", () => {
    expect(claudeWindow({ type: "seven_day_opus", utilization: 0.9, resetsAt: 1_790_000_000, status: "allowed_warning" })).toEqual({
      kind: "seven_day_opus",
      label: "Weekly, Opus",
      used: 0.9,
      resetsAt: new Date(1_790_000_000_000).toISOString(),
      status: "warning",
    });
  });

  it("keeps each route's last report per window, and shows a window past its reset as reset", () => {
    let now = new Date(Date.UTC(2026, 9, 25, 12));
    const store = new PlanStore(dir, () => now);
    expect(store.get("claude")).toEqual({ reportedAt: null, windows: [] });
    store.report("claude", [{ kind: "five_hour", label: "Five-hour window", used: 0.5, resetsAt: "2026-10-25T13:00:00.000Z", status: "allowed" }]);
    store.report("claude", [{ kind: "seven_day", label: "Weekly", used: 0.2, resetsAt: null, status: "allowed" }]);
    expect(new PlanStore(dir, () => now).get("claude").windows.map((w) => w.kind)).toEqual(["five_hour", "seven_day"]);
    now = new Date(Date.UTC(2026, 9, 25, 14));
    expect(store.get("claude").windows[0]).toMatchObject({ used: 0, status: "allowed", resetsAt: null });
  });
});

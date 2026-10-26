// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { UsageSummary } from "@ue-mcp-studio/shared";

const row = (key: string, label: string, budgetTokens: number, o: Partial<UsageSummary["rows"][number]> = {}) => ({
  key, label, budgetTokens, tokens: { input: budgetTokens, cacheRead: null, cacheWrite: null, output: 0 }, cachedShare: null, calls: 3, runs: 1, cost: null, costPartial: false, ...o,
});
const summary = (o: Partial<UsageSummary> = {}): UsageSummary => ({
  from: new Date(2026, 9, 19).toISOString(),
  to: new Date(2026, 9, 26).toISOString(),
  groupBy: "agent",
  total: { ...row("total", "All", 3000, { tokens: { input: 2000, cacheRead: 6000, cacheWrite: 500, output: 500 }, cachedShare: 0.7, cost: 1.5, costPartial: true, runs: 4, calls: 12 }) },
  rows: [row("main", "Main agent", 2000, { cost: 1.5, costPartial: true }), row("scout", "scout", 1000, { tokens: { input: 900, cacheRead: null, cacheWrite: null, output: 100 } })],
  days: [{ day: "2026-10-24", byKey: { main: 1500, scout: 500 } }, { day: "2026-10-25", byKey: { main: 500, scout: 500 } }],
  previous: { budgetTokens: 2000, cachedShare: 0.5 },
  ledgerStarts: new Date(2026, 8, 1).toISOString(),
  sessions: [{ id: "s1", title: "Dress the cave", agents: ["main", "scout"], budgetTokens: 3000, cost: null, turns: 4, last: new Date(2026, 9, 25, 10).toISOString() }],
  ...o,
});

const m = vi.hoisted(() => ({
  usageSummary: vi.fn(),
  usagePlans: vi.fn(),
  usageWarnings: vi.fn(),
  usageCache: vi.fn(),
  prices: vi.fn(),
  savePrices: vi.fn(),
}));
vi.mock("../../api", () => ({ api: m, ApiError: Error }));
import { UsageDashboard, periodRange } from "./UsageDashboard";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function show(s = summary(), teamPerDay: number | null = null) {
  m.usageSummary.mockResolvedValue(s);
  m.usagePlans.mockResolvedValue({ plans: [
    { route: "claude", name: "Claude sign-in", signedIn: true, reportedAt: new Date().toISOString(), tokens: { input: 1, cacheRead: 2, cacheWrite: 0, output: 3 }, windows: [{ kind: "five_hour", label: "Five-hour window", used: 0.62, resetsAt: null, status: "allowed" }] },
    { route: "chatgpt", name: "ChatGPT sign-in", signedIn: true, reportedAt: null, tokens: { input: null, cacheRead: null, cacheWrite: null, output: null }, windows: [] },
  ] });
  m.usageWarnings.mockResolvedValue({ warnings: [{ kind: "budget", severity: "warn", text: "86% of the budget for all agents today", detail: "Warnings start at 80%." }] });
  m.usageCache.mockResolvedValue({ explainers: [{ vendor: "openai", name: "OpenAI", what: "Prefixes", whoDecides: "The vendor", cachedReadCost: "Less", howLong: "Minutes", asOf: "", source: "https://example.invalid" }] });
  m.prices.mockResolvedValue({ shippedAsOf: "2026-10-06", prices: [{ vendor: "anthropic", model: "claude-opus-5-5", perMTok: { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 }, asOf: "2026-10-06", source: "https://platform.claude.com/docs/en/about-claude/pricing" }] });
  m.savePrices.mockImplementation(async () => ({ shippedAsOf: "2026-10-06", prices: [] }));
  await act(async () => void render(<UsageDashboard teamPerDay={teamPerDay} />));
}

describe("Usage dashboard", () => {
  it("shows tiles against the period before, the plan meters, and says when a plan never reported", async () => {
    await show();
    expect(document.querySelector(".tile-value")?.textContent).toBe("3k");
    expect(screen.getByText("+50% against the period before")).toBeTruthy();
    expect([...document.querySelectorAll(".tile-value")].map((e) => e.textContent)).toEqual(["3k", "70%", "$1.50", "4"]);

    expect(screen.getByText(/some calls had no price or ran on a plan/)).toBeTruthy();
    expect(screen.getByRole("meter", { name: "Claude sign-in, Five-hour window" }).getAttribute("aria-valuenow")).toBe("62");
    expect(screen.getByText("has not reported its limits yet")).toBeTruthy();
    expect(screen.getByText("86% of the budget for all agents today")).toBeTruthy();
    expect(screen.getByText(/Studio has recorded usage since September 1, 2026/)).toBeTruthy();
  });

  it("compares cost and runs with the period before, and says when the period before had no cost", async () => {
    await show(summary({ previous: { budgetTokens: 2000, cachedShare: 0.5, cost: 1, costPartial: false, runs: 5, calls: 10 } }));
    const tiles = [...document.querySelectorAll(".tile")].map((t) => t.textContent ?? "");
    expect(tiles[2]).toContain("+50% against the period before");
    expect(tiles[3]).toContain("-20% against the period before");
    await act(async () => void cleanup());
    await show(summary({ previous: { budgetTokens: 2000, cachedShare: 0.5, cost: null, costPartial: false, runs: 4, calls: 10 } }));
    const again = [...document.querySelectorAll(".tile")].map((t) => t.textContent ?? "");
    expect(again[2]).toContain("no cost the period before: every call ran on a plan");
    expect(again[3]).toContain("same as the period before");
  });

  it("explains caching for a vendor that is priced but not connected, folded under the connected ones", async () => {
    await show();
    m.usageCache.mockResolvedValue({
      explainers: [{ vendor: "openai", name: "OpenAI", what: "Prefixes", whoDecides: "The vendor", cachedReadCost: "Less", howLong: "Minutes", asOf: "", source: "https://example.invalid" }],
      others: [{ vendor: "google", name: "Google", what: "Implicit", whoDecides: "The vendor", cachedReadCost: "Less", howLong: "Unstated", asOf: "", source: "https://example.invalid/g" }],
    });
    await act(async () => void cleanup());
    await act(async () => void render(<UsageDashboard teamPerDay={null} />));
    expect(screen.getByText("Google: priced below, not connected")).toBeTruthy();
    expect(screen.getByText("Google's documentation")).toBeTruthy();
  });

  it("never shows a kind the vendor did not report as zero", async () => {
    await show();
    expect(screen.getAllByText("not reported").length).toBeGreaterThan(0);
    expect(screen.getByText(/never counted as zero/)).toBeTruthy();
    // A partly priced row says so beside its amount.
    expect(document.querySelector(".usage-table .cost")?.textContent).toBe("$1.50 partial");
  });

  it("asks for the period and grouping the controls pick", async () => {
    await show();
    await act(async () => void fireEvent.click(screen.getByRole("radio", { name: "Vendor" })));
    expect(m.usageSummary).toHaveBeenLastCalledWith(expect.objectContaining({ groupBy: "vendor" }));
    await act(async () => void fireEvent.click(screen.getByRole("radio", { name: "Today" })));
    const last = m.usageSummary.mock.calls.at(-1)![0] as { from: string; to: string };
    expect(new Date(last.to).getTime() - new Date(last.from).getTime()).toBe(86_400_000);
  });

  it("stacks each day by series, folds the smallest into Other past seven, and draws the team budget when it is in range", async () => {
    const many = Array.from({ length: 9 }, (_, i) => row(`a${i}`, `Agent ${i}`, 900 - i * 50));
    await show(summary({ rows: many, days: [{ day: "2026-10-25", byKey: Object.fromEntries(many.map((r) => [r.key, r.budgetTokens])) }] }), 9000);
    const legend = [...document.querySelectorAll(".legend-item")].map((e) => e.textContent);
    expect(legend).toEqual(["Agent 0", "Agent 1", "Agent 2", "Agent 3", "Agent 4", "Agent 5", "Other", "Daily budget for all agents"]);
    expect(document.querySelectorAll(".daystack .seg")).toHaveLength(7);
    expect(document.querySelector(".budget-line")).not.toBeNull();
  });

  it("names a team budget far above every day instead of flattening the bars", async () => {
    await show(summary(), 1_000_000);
    expect(document.querySelector(".budget-line")).toBeNull();
    expect(screen.getByText(/is more than twice the busiest day here/)).toBeTruthy();
  });

  it("says nothing is recorded yet on a fresh machine", async () => {
    await show(summary({ rows: [], days: [], sessions: [], ledgerStarts: null, previous: null, total: { ...row("total", "All", 0), calls: 0, runs: 0 } }));
    expect(screen.getByText(/Nothing recorded yet/)).toBeTruthy();
    // No calls: the tiles say so instead of describing calls that never ran.
    expect(screen.getAllByText("No calls yet")).toHaveLength(2);
    expect(screen.queryByText(/Every call ran on a sign-in/)).toBeNull();
    expect(screen.queryByText("Tokens per day")).toBeNull();
  });

  it("adds a price of the user's own", async () => {
    await show();
    fireEvent.change(screen.getByLabelText("Vendor"), { target: { value: "google" } });
    fireEvent.change(screen.getByLabelText("Model, or a prefix ending in *"), { target: { value: "gemini-3*" } });
    fireEvent.change(screen.getByLabelText("Input per million tokens"), { target: { value: "0.3" } });
    fireEvent.change(screen.getByLabelText("Output per million tokens"), { target: { value: "2.5" } });
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Add price" })));
    expect(m.savePrices).toHaveBeenCalledWith([{ vendor: "google", model: "gemini-3*", perMTok: { input: 0.3, cacheRead: null, cacheWrite: null, output: 2.5 } }]);
  });

  it("covers today, seven and thirty days, and the calendar month", () => {
    const now = new Date(2026, 9, 25, 15);
    expect(periodRange("today", now)).toEqual({ from: new Date(2026, 9, 25), to: new Date(2026, 9, 26) });
    expect(periodRange("7d", now).from).toEqual(new Date(2026, 9, 19));
    expect(periodRange("month", now).from).toEqual(new Date(2026, 9, 1));
  });
});

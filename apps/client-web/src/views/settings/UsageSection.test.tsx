// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const body = () => ({
  definition: "Budgets count input, cache writes and output. Cached reads are left out.",
  agents: [{ id: "main", name: "Main agent" }, { id: "playtest-runner", name: "Playtest runner" }],
  helpersPerTurn: 4,
  budgets: {
    team: { perDayTokens: null, perMonthTokens: null, onLimit: "ask" },
    warnAt: 0.8,
    agents: {
      main: { perRunTokens: null, perRunMinutes: null, perDayTokens: null, onLimit: "stop-and-report" },
      "playtest-runner": { perRunTokens: 2_000_000, perRunMinutes: 60, perDayTokens: null, onLimit: "ask" },
    },
  },
});
const m = vi.hoisted(() => ({
  budgets: vi.fn(),
  saveBudgets: vi.fn(),
  usageSummary: vi.fn(async () => ({ from: "", to: "", groupBy: "agent", total: { key: "total", label: "All", tokens: { input: null, cacheRead: null, cacheWrite: null, output: null }, budgetTokens: 0, cachedShare: null, calls: 0, runs: 0, cost: null, costPartial: false }, rows: [], days: [], previous: null, ledgerStarts: null, sessions: [] })),
  usagePlans: vi.fn(async () => ({ plans: [] })),
  usageWarnings: vi.fn(async () => ({ warnings: [] })),
  usageCache: vi.fn(async () => ({ explainers: [] })),
  prices: vi.fn(async () => ({ prices: [], shippedAsOf: "2026-10-06" })),
}));
vi.mock("../../api", () => ({ api: m, ApiError: Error }));
import { UsageSection } from "./UsageSection";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function show() {
  m.budgets.mockResolvedValue(body());
  m.saveBudgets.mockImplementation(async () => body());
  await act(async () => void render(<UsageSection />));
}

describe("Usage > Budgets", () => {
  it("prints the definition, and the two limits Studio had as the first rows", async () => {
    await show();
    expect(screen.getByText(/Cached reads are left out/)).toBeTruthy();
    expect((screen.getByLabelText("Main agent tokens per run") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Playtest runner tokens per run") as HTMLInputElement).value).toBe("2,000,000");
    expect((screen.getByLabelText("Playtest runner minutes per run") as HTMLInputElement).value).toBe("60");
  });

  it("saves the main agent's per-run tokens on Enter, separators allowed", async () => {
    await show();
    const input = screen.getByLabelText("Main agent tokens per run");
    fireEvent.change(input, { target: { value: "250,000" } });
    await act(async () => void fireEvent.keyDown(input, { key: "Enter" }));
    expect(m.saveBudgets).toHaveBeenCalledWith({ agents: { main: { perRunTokens: 250000 } } });
  });

  it("refuses a value too small to finish a model call, and never empties the Playtest runner's limit", async () => {
    await show();
    const main = screen.getByLabelText("Main agent tokens per run");
    fireEvent.change(main, { target: { value: "500" } });
    await act(async () => void fireEvent.blur(main));
    expect(main.getAttribute("aria-invalid")).toBe("true");
    const runner = screen.getByLabelText("Playtest runner tokens per run");
    fireEvent.change(runner, { target: { value: "" } });
    await act(async () => void fireEvent.blur(runner));
    expect(m.saveBudgets).not.toHaveBeenCalled();
  });

  it("sets per-day tokens per agent with ask or stop, and the team's day, month and warning share", async () => {
    await show();
    const day = screen.getByLabelText("Main agent tokens per day");
    fireEvent.change(day, { target: { value: "2,000,000" } });
    await act(async () => void fireEvent.blur(day));
    expect(m.saveBudgets).toHaveBeenCalledWith({ agents: { main: { perDayTokens: 2000000 } } });
    const month = screen.getByLabelText("All agents tokens per month");
    fireEvent.change(month, { target: { value: "50000000" } });
    await act(async () => void fireEvent.blur(month));
    expect(m.saveBudgets).toHaveBeenCalledWith({ team: { perMonthTokens: 50000000 } });
    await act(async () => void fireEvent.click(screen.getByRole("radio", { name: "Stop" })));
    expect(m.saveBudgets).toHaveBeenCalledWith({ team: { onLimit: "stop" } });
    const warn = screen.getByLabelText("Warn at, percent");
    fireEvent.change(warn, { target: { value: "90" } });
    await act(async () => void fireEvent.blur(warn));
    expect(m.saveBudgets).toHaveBeenCalledWith({ warnAt: 0.9 });
    expect(screen.getByText(/A helper's tokens count toward the turn that started it/)).toBeTruthy();
  });

  it("keeps the helpers-per-turn cap as a spend limit", async () => {
    await show();
    const input = screen.getByLabelText("Helpers per turn") as HTMLInputElement;
    expect(input.value).toBe("4");
    fireEvent.change(input, { target: { value: "2" } });
    await act(async () => void fireEvent.blur(input));
    expect(m.saveBudgets).toHaveBeenCalledWith({ helpersPerTurn: 2 });
    fireEvent.change(input, { target: { value: "40" } });
    await act(async () => void fireEvent.blur(input));
    expect(m.saveBudgets).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it } from "vitest";
import { contextView, type ContextUsage } from "@ue-mcp-studio/shared";
import { contextLabel, contextPct, contextRing, planCoversLine, tipLines } from "../src/chat-view.js";

const usage = (input: number, extra: Partial<ContextUsage> = {}): ContextUsage => ({ input, cached: 0, output: 0, model: "claude-sonnet-5-5", at: "2026-11-04T12:00:00Z", ...extra }) as ContextUsage;
const view = (input: number, extra: Partial<ContextUsage> = {}) => contextView(usage(input, extra), "claude-sonnet-5-5", 1_000_000)!;
const names = { nameOf: (id: string) => (id === "claude-sonnet-5-5" ? "Sonnet 5.5" : id), modelName: "Sonnet 5.5", runtime: false, compacting: false };

describe("the context ring", () => {
  it("fills an arc of its circle by the share of the window, and ticks where it compacts", () => {
    const v = view(250_000);
    const ring = contextRing(v);
    expect(ring.r).toBe(6);
    expect(ring.dash).toBeCloseTo(0.25 * ring.circumference, 6);
    const a = v.compactAt * 2 * Math.PI;
    expect(ring.tick.x1).toBeCloseTo(8 + 4 * Math.sin(a), 6);
    expect(ring.tick.y2).toBeCloseTo(8 - 8 * Math.cos(a), 6);
  });

  it("shows a sliver once anything is measured and closes past the window", () => {
    expect(contextRing(view(100)).dash).toBe(0.6);
    const over = contextView(usage(310_000), "claude-haiku-4-5", 200_000)!;
    expect(contextRing(over).dash).toBeCloseTo(contextRing(over).circumference, 6);
  });
});

describe("the meter's words", () => {
  it("names the meter, with compacting, and its numeral", () => {
    expect(contextLabel(view(698_000))).toBe("Context 70% full: 698k of 1M tokens");
    expect(contextLabel(view(862_000), "Scout", true)).toBe("Scout agent's context 86% full: 862k of 1M tokens, compacting");
    expect(contextLabel(null)).toBe("Context not measured yet");
    expect(contextPct(view(41_000, { estimated: true }))).toBe("~4%");
    expect(contextPct(null)).toBe("ctx");
  });

  it("lists the hover card's lines: tokens, the model measured on, where it compacts", () => {
    const v = view(213_000);
    const at = Math.round(v.window * v.compactAt / 1000);
    expect(tipLines(v, usage(213_000), names)).toEqual(["213k of 1M tokens", "Measured on Sonnet 5.5", `Studio compacts at ${at}k (${Math.round(v.compactAt * 100)}%)`]);
    expect(tipLines(v, usage(213_000), { ...names, compacting: true, owner: "Scout" })).toEqual(["Scout agent's context", "213k of 1M tokens", "Measured on Sonnet 5.5", "Compacting now"]);
  });
});

describe("the cost under a plan", () => {
  it("names the plan of every sign-in route alike, and none on a key or an endpoint", () => {
    expect(planCoversLine("chatgpt")).toMatch(/^Your ChatGPT plan covers it/);
    expect(planCoversLine("claude")).toMatch(/^Your Claude plan covers it/);
    expect(planCoversLine("studio")).toMatch(/^Your Studio plan covers it/);
    for (const r of ["key", "endpoint", null, undefined]) expect(planCoversLine(r)).toBeNull();
  });
});

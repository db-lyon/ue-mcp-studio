// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AUTO_COMPACT_FRACTION, contextView, sameModel, contextWindowOf, requestCost, type ContextUsage, type SessionSpend, type TranscriptEntry } from "@ue-mcp-studio/shared";
import { ContextMeter, ContextWarning, dollars } from "./ContextMeter";
import { CompactionMarker } from "./Compaction";

afterEach(cleanup);

const at = "2026-11-04T12:00:00Z";
const ctx = (input: number, model = "claude-sonnet-5-5", over: Partial<ContextUsage> = {}): ContextUsage => ({ input, cached: Math.round(input * 0.9), output: 1_000, model, at, ...over });
const TOTALS: SessionSpend = { input: 400_000, cacheRead: 1_300_000, cacheWrite: 20_000, output: 30_000, reasoning: 9_000, requests: 40, costUsd: 3.21 };

describe("context windows", () => {
  it("knows each family's window and assumes one for a model it does not know", () => {
    expect(contextWindowOf("claude-opus-5-5")).toEqual({ tokens: 1_000_000, known: true });
    expect(contextWindowOf("claude-haiku-4-5").tokens).toBe(200_000);
    expect(contextWindowOf("claude-sonnet-4-5-20250929").tokens).toBe(200_000);
    expect(contextWindowOf("claude-sonnet-4-6").tokens).toBe(1_000_000);
    expect(contextWindowOf("gemini-3.1-pro-preview").tokens).toBe(1_048_576);
    expect(contextWindowOf("models/gemini-3.8-flash").tokens).toBe(1_048_576);
    expect(contextWindowOf("gpt-6-astra").tokens).toBe(400_000);
    expect(contextWindowOf("qwen3-coder:30b")).toEqual({ tokens: 128_000, known: false });
    // A vendor's list wins over what Studio knows.
    expect(contextWindowOf("qwen3-coder:30b", 262_144)).toEqual({ tokens: 262_144, known: true });
  });

  it("prices a request at the vendor's API prices, cache reads and writes apart", () => {
    // Opus 5.5: $4 in, $20 out, $0.20 cache reads, writes at 1.25x input.
    expect(requestCost("claude-opus-5-5", { input: 1_000_000, output: 0 })).toBeCloseTo(4);
    expect(requestCost("claude-opus-5-5", { input: 1_000_000, cacheWrite: 1_000_000, output: 0 })).toBeCloseTo(5);
    expect(requestCost("claude-opus-5-5", { input: 0, cacheRead: 1_000_000, output: 1_000_000 })).toBeCloseTo(20.2);
    expect(requestCost("gpt-6-astra", { input: 1, output: 1 })).toBeNull();
  });
});

describe("the meter's numbers", () => {
  it("is the current context against the next model's window, with levels toward the compaction point", () => {
    expect(contextView(ctx(80_000), "claude-sonnet-5-5")).toMatchObject({ used: 81_000, window: 1_000_000, level: "ok", compactAt: AUTO_COMPACT_FRACTION });
    expect(contextView(ctx(700_000), "claude-sonnet-5-5")!.level).toBe("warn");
    expect(contextView(ctx(820_000), "claude-sonnet-5-5")!.level).toBe("high");
    expect(contextView(undefined, "claude-sonnet-5-5")).toBeNull();
  });

  it("uses the new model's window after a switch, and says where it was measured", () => {
    const v = contextView(ctx(310_000, "claude-sonnet-5-5", { window: 1_000_000 }), "claude-haiku-4-5")!;
    expect(v).toMatchObject({ window: 200_000, level: "high", measuredOn: "claude-sonnet-5-5" });
    expect(v.fraction).toBeGreaterThan(1);
  });

  it("counts a dated or tagged spelling of the model as the same model", () => {
    expect(sameModel("claude-sonnet-5-5[1m]", "claude-sonnet-5-5")).toBe(true);
    expect(sameModel("claude-haiku-4-5-20251001", "claude-haiku-4-5")).toBe(true);
    expect(sameModel("claude-haiku-4-5", "claude-sonnet-5-5")).toBe(false);
    expect(contextView(ctx(100_000, "claude-sonnet-5-5-20260101"), "claude-sonnet-5-5")!.measuredOn).toBeNull();
  });

  it("uses the window and compaction point the runtime reported while the model is the same", () => {
    const v = contextView(ctx(100_000, "claude-sonnet-5-5", { window: 400_000, compactAt: 360_000 }), "claude-sonnet-5-5")!;
    expect(v).toMatchObject({ window: 400_000, compactAt: 0.9 });
  });
});

describe("ContextMeter", () => {
  const meter = (over: Partial<Parameters<typeof ContextMeter>[0]> = {}) => {
    const onCompact = vi.fn();
    render(<ContextMeter context={ctx(698_000)} totals={TOTALS} model="claude-sonnet-5-5" busy={false} compacting={false} runtime={false} onCompact={onCompact} {...over} />);
    return onCompact;
  };

  it("shows the current context as a ring alone, its percentage in its name, not the session's spend", () => {
    meter();
    const b = screen.getByRole("button", { name: /Context 70% full: 699k of 1M tokens/ });
    expect(b.className).toContain("level-warn");
    expect(b.querySelector("svg.context-ring.level-warn")).not.toBeNull();
    // No words beside the ring: the percentage is in the label, the tokens in the hover card.
    expect(b.querySelector(".context-pct")).toBeNull();
    expect(screen.getByRole("tooltip", { hidden: true }).textContent).toContain("699k of 1M tokens");
    // Nothing else is drawn in the bar: the tokens are in the hover card only.
    expect(b.querySelector(".context-of, .context-bar")).toBeNull();
    expect(b.textContent).not.toContain("1.3M");
  });

  it("draws the ring's arc to the share and a tick where it compacts", () => {
    meter();
    const svg = screen.getByRole("button", { name: /Context 70%/ }).querySelector("svg")!;
    const [len, circ] = svg.querySelector(".context-ring-fill")!.getAttribute("stroke-dasharray")!.split(" ").map(Number);
    expect(len / circ).toBeCloseTo(0.699, 2);
    // 85% of the way round, clockwise from the top: left of centre and above it.
    const tick = svg.querySelector(".context-ring-tick")!;
    expect(Number(tick.getAttribute("x2"))).toBeLessThan(8);
    expect(Number(tick.getAttribute("y2"))).toBeLessThan(8);
  });

  it("has a hover card with the tokens of the window, the model it was measured on and where it compacts", () => {
    meter({ nameOf: (id) => (id === "claude-sonnet-5-5" ? "Sonnet 5.5" : id) });
    const b = screen.getByRole("button", { name: /Context 70%/ });
    const tip = screen.getByRole("tooltip", { hidden: true });
    expect(b.getAttribute("aria-describedby")).toBe(tip.id);
    expect([...tip.children].map((c) => c.textContent)).toEqual(["699k of 1M tokens", "Measured on Sonnet 5.5", "Studio compacts at 850k (85%)"]);
    // Opened, the details replace it.
    fireEvent.click(b);
    expect(screen.queryByRole("tooltip", { hidden: true })).toBeNull();
    expect(b.getAttribute("aria-describedby")).toBeNull();
  });

  it("says where Claude's runtime compacts, and when it is past that point", () => {
    meter({ context: ctx(150_000, "claude-sonnet-5-5", { window: 1_000_000, compactAt: 967_000 }), runtime: true });
    expect(screen.getByRole("tooltip", { hidden: true }).textContent).toContain("Claude's runtime compacts at about 967k (97%)");
    cleanup();
    meter({ context: ctx(860_000) });
    expect(screen.getByRole("tooltip", { hidden: true }).textContent).toContain("Past where it compacts (850k): compacts before the next request");
  });

  it("closes the ring and makes it glow past the window", () => {
    meter({ context: ctx(310_000), model: "claude-haiku-4-5", modelName: "Haiku 4.5", nameOf: (id) => (id === "claude-sonnet-5-5" ? "Sonnet 5.5" : id) });
    const b = screen.getByRole("button", { name: /Context 15\d%/ });
    expect(b.querySelector("svg.context-ring.over.level-high")).not.toBeNull();
    const tip = screen.getByRole("tooltip", { hidden: true }).textContent;
    expect(tip).toContain("311k of 200k tokens");
    expect(tip).toContain("Measured on Sonnet 5.5, next turn on Haiku 4.5");
    expect(tip).toContain("Over the window: Studio compacts it before the next request");
  });

  it("opens to the numbers behind it and the session totals, labelled as spend, with Compact now", () => {
    const onCompact = meter();
    fireEvent.click(screen.getByRole("button", { name: /Context 70%/ }));
    const pop = screen.getByRole("dialog", { name: "Context and session totals" });
    expect(pop.textContent).toContain("699,000 of 1,000,000 tokens");
    expect(pop.textContent).toContain("Studio compacts it on its own at 850k tokens (85%)");
    expect(pop.textContent).toContain("Session totals");
    expect(pop.textContent).toContain("1.3M");
    expect(pop.textContent).toContain("$3.21");
    fireEvent.click(screen.getByRole("button", { name: "Compact now" }));
    expect(onCompact).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("disables Compact now while a turn runs, and pulses and says Compacting while it compacts", () => {
    meter({ busy: true, compacting: true });
    const b = screen.getByRole("button", { name: /Context 70% full: .*, compacting/ });
    expect(b.className).toContain("compacting");
    expect(b.querySelector(".context-ring-fill")).not.toBeNull();
    expect(screen.getByRole("tooltip", { hidden: true }).textContent).toContain("Compacting now");
    fireEvent.click(b);
    expect((screen.getByRole("button", { name: "Compact now" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("marks an estimate, and says so inside", () => {
    meter({ context: ctx(40_000, "", { estimated: true, cached: 0, output: 0 }), totals: undefined });
    const b = screen.getByRole("button", { name: /Context 4% full: 40k of 1M tokens, estimated/ });
    expect(screen.getByRole("tooltip", { hidden: true }).textContent).toBe("About 40k of 1M tokens, estimatedEstimated from the conversation's textStudio compacts at 850k (85%)");
    fireEvent.click(b);
    expect(screen.getByRole("dialog").textContent).toContain("The next reply measures it");
  });

  it("names the model it was measured on after a switch to a smaller window", () => {
    meter({ context: ctx(310_000), model: "claude-haiku-4-5", modelName: "Haiku 4.5", nameOf: (id) => (id === "claude-sonnet-5-5" ? "Sonnet 5.5" : id) });
    fireEvent.click(screen.getByRole("button", { name: /Context 15\d%/ }));
    expect(screen.getByRole("dialog").textContent).toContain("Measured on Sonnet 5.5. The next turn runs on Haiku 4.5, whose window is 200k.");
  });

  it("is absent before anything has been measured or spent", () => {
    meter({ context: undefined, totals: undefined });
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("ContextWarning", () => {
  it("offers Compact now and says where it compacts, or that it is past the window", () => {
    const onCompact = vi.fn();
    const { rerender } = render(<ContextWarning view={contextView(ctx(830_000), "claude-sonnet-5-5")!} runtime={false} busy={false} onCompact={onCompact} onDismiss={() => {}} />);
    expect(screen.getByRole("status").textContent).toContain("Context is 83% full. It compacts at 85%.");
    expect(screen.getByRole("status").querySelector("svg.context-ring.level-high")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Compact now" }));
    expect(onCompact).toHaveBeenCalled();
    rerender(<ContextWarning view={contextView(ctx(310_000), "claude-haiku-4-5")!} runtime={false} busy={false} onCompact={onCompact} onDismiss={() => {}} />);
    expect(screen.getByRole("status").textContent).toContain("Context is over the window (311k of 200k). It compacts before the next request.");
  });

  it("writes dollars to the cent below a hundred", () => {
    expect(dollars(12.374)).toBe("$12.37");
    expect(dollars(0.004)).toBe("under $0.01");
    expect(dollars(1234.5)).toBe("$1,235");
  });
});

describe("CompactionMarker", () => {
  const entry = (over: Partial<Extract<TranscriptEntry, { kind: "compaction" }>> = {}) =>
    ({ kind: "compaction", at, trigger: "auto", state: "done", before: 852_000, after: 21_400, summary: "**Done:** the door swings.", method: "summary", model: "Sonnet 5.5", ms: 23_000, ...over }) as Extract<TranscriptEntry, { kind: "compaction" }>;

  it("is a divider with the tokens before and after, and opens to the summary", () => {
    render(<CompactionMarker entry={entry()} />);
    const line = screen.getByRole("button", { name: /Context compacted/ });
    expect(line.textContent).toContain("852k → 21k tokens");
    expect(line.textContent).toContain("automatic");
    expect(line.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/the door swings/)).toBeNull();
    fireEvent.click(line);
    expect(line.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Done:").tagName).toBe("STRONG");
    expect(document.querySelector(".compaction-body")!.textContent).toContain("Sonnet 5.5 summarised the conversation in 23s");
  });

  it("says it is compacting while it runs, with nothing to open", () => {
    render(<CompactionMarker entry={entry({ state: "running", after: undefined, summary: undefined })} />);
    const line = screen.getByRole("button", { name: /Compacting context/ });
    expect((line as HTMLButtonElement).disabled).toBe(true);
  });

  it("says why it failed and that nothing was cut", () => {
    render(<CompactionMarker entry={entry({ state: "failed", after: undefined, summary: undefined, error: "overloaded" })} />);
    fireEvent.click(screen.getByRole("button", { name: /Compaction failed/ }));
    expect(document.querySelector(".compaction-body")!.textContent).toContain("overloaded Nothing was cut");
  });

  it("names a cut instead of a summary as trimmed, and what the user asked to keep", () => {
    render(<CompactionMarker entry={entry({ method: "truncated", trigger: "manual", instructions: "door paths", error: "overloaded" })} />);
    const line = screen.getByRole("button", { name: /Context trimmed/ });
    expect(line.textContent).toContain("by you");
    fireEvent.click(line);
    expect(document.querySelector(".compaction-body")!.textContent).toContain("You asked it to keep: door paths");
  });
});

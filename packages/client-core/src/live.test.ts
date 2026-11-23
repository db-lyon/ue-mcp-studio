import { describe, expect, it } from "vitest";
import { LIVE_OUTPUT_KEEP, NO_LIVE, applyLive, liveTail, thinkingLabel, type LiveParts } from "./live.js";

const run = (events: Array<[string, Record<string, unknown>]>, from: LiveParts = NO_LIVE): LiveParts =>
  events.reduce((s, [type, data]) => applyLive(s, type, data) ?? s, from);

describe("the live parts of a running turn", () => {
  it("adds thinking as it comes, starts over on reset, and drops it once a line lands", () => {
    expect(run([["studio.turn.thinking", { text: "Look at " }], ["studio.turn.thinking", { text: "the level." }]]).thinking).toBe("Look at the level.");
    expect(run([["studio.turn.thinking", { text: "old" }], ["studio.turn.thinking", { text: "new", reset: true }]]).thinking).toBe("new");
    expect(run([["studio.turn.thinking", { text: "x" }], ["studio.transcript.added", {}]]).thinking).toBe("");
  });

  it("times a think from its first part, starts over on a reset, and stops once a line lands", () => {
    let s = applyLive(NO_LIVE, "studio.turn.thinking", { text: "Look " }, 1000)!;
    s = applyLive(s, "studio.turn.thinking", { text: "closer." }, 5000)!;
    expect(s.thinkingSince).toBe(1000);
    // A reset is a new think: the stopped answer's, then the reply's.
    expect(applyLive(s, "studio.turn.thinking", { text: "again", reset: true }, 9000)!.thinkingSince).toBe(9000);
    expect(applyLive(s, "studio.transcript.added", {})!.thinkingSince).toBeNull();
    expect(applyLive(s, "studio.session.changed", { status: "idle" })).toEqual(NO_LIVE);
  });

  it("labels the think with how long it has run, once that reaches a second", () => {
    expect(thinkingLabel(null, 5000)).toBe("Thinking");
    expect(thinkingLabel(5000, 5400)).toBe("Thinking");
    expect(thinkingLabel(5000, 17_000)).toBe("Thinking 12s");
    expect(thinkingLabel(0, 192_000)).toBe("Thinking 3m 12s");
  });

  it("follows the running call's output, a new call's from empty, and drops it when that call finishes", () => {
    const s = run([["studio.tool.output", { callId: "a", text: "Building...\n" }], ["studio.tool.output", { callId: "a", text: "Done.\n" }]]);
    expect(s.output).toEqual({ callId: "a", text: "Building...\nDone.\n" });
    expect(run([["studio.tool.output", { callId: "b", text: "next" }]], s).output).toEqual({ callId: "b", text: "next" });
    expect(run([["studio.tool.finished", { toolUseId: "a" }]], s).output).toBeNull();
    expect(run([["studio.tool.finished", { toolUseId: "other" }]], s).output).not.toBeNull();
  });

  it("shows nothing live once the turn ends", () => {
    const s = run([["studio.turn.thinking", { text: "x" }], ["studio.tool.output", { callId: "a", text: "y" }]]);
    expect(run([["studio.session.changed", { status: "idle" }]], s)).toEqual(NO_LIVE);
    expect(applyLive(s, "studio.session.changed", { status: "running" })).toBeNull();
  });

  it("keeps the newest part of a long output, from a line start", () => {
    const long = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
    const tail = liveTail(long);
    expect(tail.length).toBeLessThanOrEqual(LIVE_OUTPUT_KEEP);
    expect(tail.startsWith("line ")).toBe(true);
    expect(tail.endsWith("line 1999")).toBe(true);
  });

  it("leaves other events alone", () => {
    expect(applyLive(NO_LIVE, "studio.turn.delta", { text: "x" })).toBeNull();
  });
});

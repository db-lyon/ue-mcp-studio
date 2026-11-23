/** Viewport on a playtest card: offered while its run plays in Play In Editor, and nowhere else. */
import { describe, expect, it } from "vitest";
import type { QaRun, QaRunState } from "@ue-mcp-studio/shared";
import { cardControls } from "../src/qa.js";

const run = (state: QaRunState, over: Partial<QaRun> = {}): QaRun =>
  ({ runId: "r1", script: "/Game/T/TS", scriptName: "TS", state, steps: [], awaiting: [], lastSeq: 0, summary: {}, resultsPath: null, sessionId: "s1", toolUseId: null, seenAt: "", ...over }) as unknown as QaRun;
const viewport = (r: QaRun, pie?: boolean) => cardControls(r, { assignSession: "s1", open: false, pie }).viewport;

describe("Viewport on a playtest card", () => {
  it("shows while the run is armed, running or waiting for a verdict and Play In Editor runs", () => {
    for (const state of ["armed", "running", "awaiting_verdict"] as const) expect(viewport(run(state), true), state).toBe(true);
  });

  it("hides while Play In Editor is not running, or where the card cannot open the viewer", () => {
    expect(viewport(run("running"), false)).toBe(false);
    expect(viewport(run("running"))).toBe(false);
  });

  it("hides on a draft, an ended or idle run, and a deleted one", () => {
    for (const state of ["draft", "finished", "stopped", "idle"] as const) expect(viewport(run(state), true), state).toBe(false);
    expect(viewport(run("running", { deleted: true } as Partial<QaRun>), true)).toBe(false);
  });
});

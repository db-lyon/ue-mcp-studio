import { describe, expect, it } from "vitest";
import type { QaRun, QaStep } from "@ue-mcp-studio/shared";
import { ASSIGN_WAITS, cardControls } from "../src/qa.js";

const step = (index: number, over: Partial<QaStep> = {}): QaStep => ({ index, instruction: `step ${index}`, judge: "manual", agentJudgeable: false, status: "pending", ...over }) as QaStep;
const run = (steps: QaStep[]): QaRun =>
  ({ runId: "draft:/Game/T/TS", script: "/Game/T/TS", scriptName: "TS", state: "draft", steps, awaiting: [], lastSeq: 0, summary: {}, resultsPath: null, sessionId: "s1", toolUseId: null, seenAt: "" }) as unknown as QaRun;

describe("Assign to subagent on a playtest only a person can judge", () => {
  it("is shown greyed out with why while every step needs a person, and offered once a step fails", () => {
    const personOnly = cardControls(run([step(1), step(2)]), { assignSession: "s1", open: false });
    expect(personOnly.canAssign).toBe(false);
    expect(personOnly.assignWaits).toBe(ASSIGN_WAITS);

    const failed = cardControls(run([step(1, { status: "failed" }), step(2)]), { assignSession: "s1", open: false });
    expect(failed.canAssign).toBe(true);
    expect(failed.assignWaits).toBeNull();
  });

  it("says nothing where Assign would not be offered anyway: no session to run in", () => {
    expect(cardControls(run([step(1)]), { assignSession: null, open: false }).assignWaits).toBeNull();
  });
});

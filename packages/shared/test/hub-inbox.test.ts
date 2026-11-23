/** The hub inbox's rule for verdicts: only a check's newest run asks a person for one. */
import { describe, expect, it } from "vitest";
import { buildInbox, type QaRun } from "../src/index.js";

const waiting = (runId: string, seenAt: string): QaRun =>
  ({
    runId,
    script: "/Game/PIEStudio/Scripts/TS_Camera_Feel.TS_Camera_Feel",
    scriptName: "TS_Camera_Feel",
    state: "finished",
    steps: [
      { index: 0, instruction: "Hold forward", judge: "auto", status: "passed" },
      { index: 1, instruction: "The camera follows smoothly", judge: "manual", status: "awaiting_verdict" },
    ],
    awaiting: [1],
    lastSeq: 0,
    sessionId: null,
    toolUseId: null,
    seenAt,
  }) as unknown as QaRun;

describe("hub inbox verdicts", () => {
  it("asks for a verdict on a check's newest run only, not on the runs it superseded", () => {
    const items = buildInbox({
      runs: [waiting("old", "2026-11-23T10:00:00.000Z"), waiting("new", "2026-11-23T12:00:00.000Z"), waiting("older", "2026-11-23T09:00:00.000Z")],
      goals: [],
      checks: [],
      plans: [],
      now: Date.parse("2026-11-23T13:00:00.000Z"),
    }).filter((i) => i.kind === "verdict");
    expect(items.map((i) => i.runId)).toEqual(["new"]);
  });
});

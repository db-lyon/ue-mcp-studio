import { describe, expect, it } from "vitest";
import {
  qaApplyEditorEvent,
  qaApplyStreamEvent,
  qaApplyVerdictAnswer,
  qaMergeAnswer,
  qaRunFromAnswer,
  qaVerdictForm,
  type QaRun,
} from "@ue-mcp-studio/shared";

import { RESULTS, RUN, runAnswer } from "./qa-fixture.js";

const base = (): QaRun => qaRunFromAnswer(runAnswer(), { sessionId: "s1", toolUseId: "tu1", seenAt: "2026-10-23T15:00:00.000Z" })!;
const stream = (seq: number, extra: Record<string, unknown>) => ({ runId: RUN, script: "/Game/PIEStudio/Scripts/DoorOpens", atMs: seq * 10, seq, ...extra });

describe("a run from ue-mcp's answer", () => {
  it("takes the steps, the seq and where it was started", () => {
    const r = base();
    expect(r).toMatchObject({ runId: RUN, scriptName: "DoorOpens", state: "armed", lastSeq: 1, resultsPath: RESULTS, sessionId: "s1", toolUseId: "tu1" });
    expect(r.steps.map((s) => [s.index, s.judge, s.status, s.withinMs])).toEqual([[0, "auto", "pending", 3000], [1, "auto", "pending", 5000], [2, "manual", "pending", 5000]]);
    expect(r.summary).toEqual({ total: 3, passed: 0, failed: 0, skipped: 0, pending: 3, awaiting: 0 });
  });

  it("is null for an answer that names no run", () => {
    expect(qaRunFromAnswer({ success: false, error: "no" })).toBeNull();
  });
});

describe("the stream's script events", () => {
  it("move each step through running, pass, fail and awaiting verdict, and finish the run", () => {
    let r = base();
    r = qaApplyStreamEvent(r, "script.step_started", stream(2, { step: { index: 0, instruction: "Walk up to the door", judge: "auto", status: "running" } }));
    expect(r.state).toBe("running");
    expect(r.steps[0].status).toBe("running");
    r = qaApplyStreamEvent(r, "script.step_passed", stream(3, { step: { index: 0, status: "passed", verdictSource: "auto", evidence: { value: "Door.Distance", at_start: 412.5, at_end: 411.9, samples: 2, observed: true } } }));
    r = qaApplyStreamEvent(r, "script.step_failed", stream(5, { step: { index: 1, status: "failed", evidence: { value: "Door.OpenAngle", at_start: 0, at_end: 12, samples: 130, observed: true } } }));
    expect(r.steps[1]).toMatchObject({ status: "failed", evidence: { at_end: 12 } });
    r = qaApplyStreamEvent(r, "script.verdict_requested", stream(7, { awaiting: [{ index: 2, instruction: "The door opens without a visible pop" }] }));
    expect(r.state).toBe("awaiting_verdict");
    expect(r.awaiting).toEqual([2]);
    expect(r.steps[2].status).toBe("awaiting_verdict");
    r = qaApplyStreamEvent(r, "script.verdict", stream(8, { step: { index: 2, status: "failed", note: "Pops on the second frame", verdictSource: "elicitation" } }));
    expect(r.awaiting).toEqual([]);
    expect(r.steps[2]).toMatchObject({ status: "failed", note: "Pops on the second frame", verdictSource: "elicitation" });
    r = qaApplyStreamEvent(r, "script.run_finished", stream(9, { summary: { total: 3, passed: 1, failed: 2, skipped: 0, pending: 0 }, state: "finished", resultsPath: RESULTS }));
    expect(r).toMatchObject({ state: "finished", lastSeq: 9, summary: { total: 3, passed: 1, failed: 2, skipped: 0, pending: 0, awaiting: 0 } });
  });

  it("apply each seq once and ignore another run's events", () => {
    let r = qaApplyStreamEvent(base(), "script.step_passed", stream(3, { step: { index: 0, status: "passed" } }));
    const again = qaApplyStreamEvent(r, "script.step_passed", stream(3, { step: { index: 0, status: "failed" } }));
    expect(again).toBe(r);
    expect(qaApplyStreamEvent(r, "script.step_failed", { ...stream(4, { step: { index: 1, status: "failed" } }), runId: "other" })).toBe(r);
    r = qaApplyStreamEvent(r, "script.something_new", stream(6, {}));
    expect(r.lastSeq).toBe(6);
  });

  it("never take a settled step back to running, but let a verdict replace one", () => {
    let r = qaApplyStreamEvent(base(), "script.step_passed", stream(5, { step: { index: 0, status: "passed" } }));
    r = { ...r, lastSeq: 0 };
    r = qaApplyStreamEvent(r, "script.step_started", stream(2, { step: { index: 0, status: "running" } }));
    expect(r.steps[0].status).toBe("passed");
    r = qaApplyStreamEvent(r, "script.verdict_requested", stream(6, { awaiting: [{ index: 2, instruction: "x" }] }));
    r = qaApplyStreamEvent(r, "script.verdict", stream(7, { step: { index: 2, status: "passed" } }));
    r = qaApplyStreamEvent(r, "script.verdict", stream(8, { step: { index: 2, status: "skipped" } }));
    expect(r.steps[2].status).toBe("skipped");
  });
});

describe("a status read after a drop", () => {
  it("applies the editor's events after since_seq and takes its snapshot", () => {
    const answer = {
      ...runAnswer(),
      state: "awaiting_verdict",
      steps: [
        { ...runAnswer().steps[0], status: "passed" },
        { ...runAnswer().steps[1], status: "passed" },
        { ...runAnswer().steps[2], status: "awaiting_verdict" },
      ],
      awaiting: [{ index: 2, instruction: "The door opens without a visible pop" }],
      events: [
        { seq: 6, type: "step_started", run_id: RUN, step: 2, data: { status: "awaiting_verdict", instruction: "The door opens without a visible pop", judge: "manual" } },
        { seq: 7, type: "awaiting_verdict", run_id: RUN, step: -1, data: { awaiting: [2], blocking: true, steps: [{ index: 2, instruction: "The door opens without a visible pop" }] } },
      ],
      last_seq: 7,
    };
    const r = qaMergeAnswer(base(), answer);
    expect(r).toMatchObject({ state: "awaiting_verdict", lastSeq: 7, awaiting: [2] });
    expect(r.steps.map((s) => s.status)).toEqual(["passed", "passed", "awaiting_verdict"]);
    expect(r.sessionId).toBe("s1");
  });

  it("works from the events alone, as an editor event list reads", () => {
    let r = base();
    r = qaApplyEditorEvent(r, { seq: 2, type: "step_started", run_id: RUN, step: 0, data: { status: "running", instruction: "Walk up to the door", judge: "auto" } });
    r = qaApplyEditorEvent(r, { seq: 3, type: "step_failed", run_id: RUN, step: 0, data: { status: "failed", reason: "timed out" } });
    expect(r.steps[0]).toMatchObject({ status: "failed", evidence: { reason: "timed out" } });
    r = qaApplyEditorEvent(r, { seq: 4, type: "run_finished", run_id: RUN, step: -1, data: { state: "stopped", results_path: RESULTS } });
    expect(r.state).toBe("stopped");
  });

  it("leaves the run alone for another run's answer", () => {
    const r = base();
    expect(qaMergeAnswer(r, { ...runAnswer(), run_id: "other" })).toBe(r);
  });
});

describe("a verdict's answer", () => {
  it("settles the step and the run's state, also on an ended run", () => {
    let r = qaApplyStreamEvent(base(), "script.verdict_requested", stream(7, { awaiting: [{ index: 2, instruction: "x" }] }));
    r = qaApplyStreamEvent(r, "script.run_finished", stream(8, { summary: {}, state: "stopped" }));
    r = qaApplyVerdictAnswer(r, { success: true, run_id: RUN, step: 2, status: "passed", verdict: "pass", verdict_source: "action", note: "fine", state: "stopped", awaiting: [] });
    expect(r.steps[2]).toMatchObject({ status: "passed", note: "fine", verdictSource: "action" });
    expect(r.awaiting).toEqual([]);
    expect(r.summary.awaiting).toBe(0);
  });
});

describe("the verdict form", () => {
  const form = {
    message: `Test script /Game/PIEStudio/Scripts/DoorOpens (run ${RUN}) needs your verdict on one manual step:\n\nStep 3: The door opens without a visible pop`,
    fields: {
      step_2: { type: "string", title: "Step 3", description: "The door opens without a visible pop", enum: ["pass", "fail", "skip"] },
      step_2_note: { type: "string", title: "Step 3 note", description: "Optional. What you saw." },
    },
  };

  it("is recognised, with its run and steps", () => {
    expect(qaVerdictForm(form)).toEqual({ runId: RUN, steps: [2] });
  });

  it("is not any other form", () => {
    expect(qaVerdictForm({ message: "File this?", fields: { revisions: { type: "string" } } })).toBeNull();
    expect(qaVerdictForm({ ...form, fields: { step_2: { type: "string", enum: ["yes", "no"] } } })).toBeNull();
  });
});

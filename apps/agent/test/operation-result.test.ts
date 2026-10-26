import { describe, expect, it } from "vitest";
import { firstFailedStep, stepFailed, stepPayload, stepReason } from "../src/operation-result.js";

describe("an editor operation's steps", () => {
  const json = (v: unknown) => JSON.stringify(v, null, 2);

  it("reads the handler's JSON, also with the daemon's notes after it", () => {
    expect(stepPayload(json({ success: true }))).toEqual({ success: true });
    expect(stepPayload(`${json({ success: false, message: "m", nested: { a: 1 } })}\nserved by editor P`)).toEqual({ success: false, message: "m", nested: { a: 1 } });
    expect(stepPayload("Error [TASK_FAILED]: boom")).toBeNull();
  });

  it("takes the daemon's word on whether a step failed", () => {
    expect(stepFailed({ step: "editor.stop_editor", ok: false, result: "refused" })).toBe(true);
    expect(stepFailed({ step: "editor.stop_editor", ok: true, result: json({ success: false, alreadyStopped: true, message: "No editor is running" }) })).toBe(false);
    expect(stepFailed({ step: "editor.stop_editor", ok: true, result: json({ success: true }) })).toBe(false);
  });

  it("names the first failure by its message", () => {
    const steps = [
      { step: "editor.stop_editor", ok: true, result: json({ success: true }) },
      { step: "project.build", ok: false, result: json({ success: false, message: "Build failed with exit code 6" }) },
      { step: "editor.start_editor", ok: true, result: json({ success: true }) },
    ];
    const failed = firstFailedStep(steps)!;
    expect(failed.step).toBe("project.build");
    expect(stepReason(failed)).toBe("Build failed with exit code 6");
    expect(stepReason({ step: "x", ok: false, result: "a".repeat(900) })).toHaveLength(600);
  });
});

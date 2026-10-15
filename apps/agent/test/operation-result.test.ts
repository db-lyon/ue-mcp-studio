import { describe, expect, it } from "vitest";
import { firstFailedStep, stepFailed, stepPayload, stepReason } from "../src/operation-result.js";

describe("an editor operation's steps", () => {
  const json = (v: unknown) => JSON.stringify(v, null, 2);

  it("reads the handler's JSON, also with the daemon's notes after it", () => {
    expect(stepPayload(json({ success: true }))).toEqual({ success: true });
    expect(stepPayload(`${json({ success: false, message: "m", nested: { a: 1 } })}\nserved by editor P`)).toEqual({ success: false, message: "m", nested: { a: 1 } });
    expect(stepPayload("Error [TASK_FAILED]: boom")).toBeNull();
  });

  it("counts a step marked ok over success: false as failed, except an editor already up and answering", () => {
    expect(stepFailed({ step: "project.build", ok: true, result: json({ success: false, exitCode: 6, message: "Build failed" }) })).toBe(true);
    expect(stepFailed({ step: "editor.start_editor", ok: true, result: json({ success: false, alreadyRunning: true, bridgeReady: true }) })).toBe(false);
    expect(stepFailed({ step: "editor.start_editor", ok: true, result: json({ success: false, alreadyRunning: true, bridgeReady: false }) })).toBe(true);
    expect(stepFailed({ step: "editor.stop_editor", ok: false, result: "refused" })).toBe(true);
    expect(stepFailed({ step: "editor.stop_editor", ok: true, result: json({ success: true }) })).toBe(false);
  });

  it("names the first failure by its message", () => {
    const steps = [
      { step: "editor.stop_editor", ok: true, result: json({ success: true }) },
      { step: "project.build", ok: true, result: json({ success: false, message: "Build failed with exit code 6" }) },
      { step: "editor.start_editor", ok: true, result: json({ success: true }) },
    ];
    const failed = firstFailedStep(steps)!;
    expect(failed.step).toBe("project.build");
    expect(stepReason(failed)).toBe("Build failed with exit code 6");
    expect(stepReason({ step: "x", ok: false, result: "a".repeat(900) })).toHaveLength(600);
  });
});

import { describe, expect, it } from "vitest";
import { QA, SUBAGENT_SYSTEM } from "../src/runner.js";

describe("the agent's instructions", () => {
  it("send a test plan to a script run instead of a list in the reply", () => {
    const text = QA.join("\n");
    expect(text).toMatch(/do not write the steps out as a list/);
    expect(text).toMatch(/pie\.script_create/);
    expect(text).toMatch(/pie\.script_run/);
    expect(text).toMatch(/Never call pie\.verdict for a manual step yourself/);
  });

  it("reach subagents too", () => {
    expect(SUBAGENT_SYSTEM).toContain(QA[0]);
  });
});

import { describe, expect, it } from "vitest";
import { QA, SUBAGENT_SYSTEM } from "../src/runner.js";

describe("the agent's instructions", () => {
  it("send a test plan to a script run instead of a list in the reply", () => {
    const text = QA.join("\n");
    expect(text).toMatch(/do not write the steps out as a list/);
    expect(text).toMatch(/pie\.script_create/);
    expect(text).toMatch(/pie\.script_run/);
    expect(text).toMatch(/Never call pie\.verdict for a manual step yourself/);
    expect(text).toMatch(/Playtest card/);
  });

  it("make a prose PASS or FAIL list a failed playtest, not a choice", () => {
    const text = QA.join("\n");
    expect(text).toMatch(/Every playtest goes through pie\.script_create or pie\.script_run; there is no other way/);
    expect(text).toMatch(/lists steps marked PASS or FAIL[^.]*without a script run in that turn is a failed playtest/);
    expect(text).toMatch(/Never mark a step passed or failed from your own reading/);
  });

  it("let a subagent the user assigned give the verdicts its brief names", () => {
    expect(QA.join("\n")).toMatch(/or the user assigned you the playtest from its card: then follow that brief/);
  });

  it("reach subagents too", () => {
    expect(SUBAGENT_SYSTEM).toContain(QA[0]);
  });
});

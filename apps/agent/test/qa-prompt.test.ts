import { describe, expect, it } from "vitest";
import { PLAYTEST_RUNS_REFUSAL } from "@ue-mcp-studio/shared";
import { QA, SUBAGENT_SYSTEM, playtestRunsLine } from "../src/runner.js";

describe("the agent's instructions", () => {
  it("deliver a playtest as a created script and its card, never a list or a table", () => {
    const text = QA.join("\n");
    expect(text).toMatch(/do not write the steps out as a list in your reply, and not as a table either/);
    expect(text).toMatch(/create a ue-mcp test script with pie\.script_create \(pie\.script_update changes one\)/);
    expect(text).toMatch(/Even when the user asks only for a draft or a plan, the draft is the created script/);
    expect(text).toMatch(/Never call pie\.verdict for a manual step yourself/);
    expect(text).toMatch(/Playtest card/);
  });

  it("make a prose or table PASS or FAIL list a failed playtest, not a choice", () => {
    const text = QA.join("\n");
    expect(text).toMatch(/Every playtest is a created script and its card; there is no other way/);
    expect(text).toMatch(/steps marked PASS or FAIL[^.]*as prose or a table, is a failed playtest/);
    expect(text).toMatch(/Never mark a step passed or failed from your own reading/);
  });

  it("give multiplayer steps a player", () => {
    expect(QA.join("\n")).toMatch(/give each step a player, "host" or "client 1"/);
  });

  it("let a subagent the user assigned give the verdicts its brief names", () => {
    expect(QA.join("\n")).toMatch(/or the user assigned you the playtest from its card: then follow that brief/);
  });

  it("reach subagents too", () => {
    expect(SUBAGENT_SYSTEM).toContain(QA[0]);
  });
});

describe("the Playtest runs line", () => {
  it("under Manual, never starts a run and points at the setting", () => {
    const line = playtestRunsLine("manual");
    expect(line).toMatch(/Playtest runs is set to Manual in Settings > Agent/);
    expect(line).toMatch(/Never call pie\.script_run or pie\.script_replay; Studio refuses them/);
    expect(line).toMatch(/set Playtest runs to Automatic/);
    expect(PLAYTEST_RUNS_REFUSAL).toBe("Playtest runs is set to Manual in Settings > Agent. Click Run on the card to start it.");
  });

  it("under Automatic, may run it with pie.script_run", () => {
    const line = playtestRunsLine("automatic");
    expect(line).toMatch(/Playtest runs is set to Automatic in Settings > Agent: you may start a playtest yourself with pie\.script_run/);
    expect(line).not.toMatch(/Never call pie\.script_run/);
  });
});

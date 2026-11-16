import { describe, expect, it } from "vitest";
import { claudeErrorText, endedText } from "../src/subscription.js";

describe("endedText", () => {
  it("names why the Claude runtime ended a turn, and the way on", () => {
    expect(endedText("error_during_execution")).toBe("The turn ended: the Claude runtime hit an error. Press Retry to send it again.");
    expect(endedText("error_max_turns")).toBe("The turn ended: it reached its step limit. Press Retry, or send \"continue\", to go on.");
    expect(endedText("error_max_budget_usd")).toMatch(/^The turn ended: it reached its spending limit\. Press Retry/);
    expect(endedText("error_new_kind")).toBe("The turn ended: error_new_kind. Press Retry to send it again.");
  });
});

describe("claudeErrorText", () => {
  it("puts each Claude sign-in error in plain words with what to do next", () => {
    expect(claudeErrorText("rate_limit")).toMatch(/usage limit is reached.*Retry once it resets.*model picker/);
    expect(claudeErrorText("authentication_failed")).toMatch(/Sign in to Claude again/);
    expect(claudeErrorText("something_new")).toBe("Claude: something_new. Press Retry to send it again, or pick another model in the model picker.");
  });
});

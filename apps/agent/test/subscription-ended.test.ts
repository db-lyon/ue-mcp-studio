import { describe, expect, it } from "vitest";
import { endedText } from "../src/subscription.js";

describe("endedText", () => {
  it("names why the Claude runtime ended a turn instead of its raw subtype", () => {
    expect(endedText("error_during_execution")).toBe("The turn ended: the Claude runtime hit an error.");
    expect(endedText("error_max_turns")).toBe("The turn ended: it reached its step limit.");
    expect(endedText("error_max_budget_usd")).toBe("The turn ended: it reached its spending limit.");
    expect(endedText("error_new_kind")).toBe("The turn ended: error_new_kind");
  });
});

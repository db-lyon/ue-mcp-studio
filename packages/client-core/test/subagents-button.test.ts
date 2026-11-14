import { describe, expect, it } from "vitest";
import { subagentsLine, subagentsPress, subagentsShownFrom, subagentsShownValue } from "../src/index.js";

describe("the bar's Subagents button", () => {
  it("opens the list where there is no inline list, whatever was chosen", () => {
    for (const shown of [true, false]) for (const inView of [true, false]) expect(subagentsPress({ inline: false, shown, inView })).toBe("open-list");
  });

  it("toggles an inline list, and brings a shown one out of view back instead of hiding it", () => {
    expect(subagentsPress({ inline: true, shown: false, inView: false })).toBe("show");
    expect(subagentsPress({ inline: true, shown: true, inView: true })).toBe("hide");
    expect(subagentsPress({ inline: true, shown: true, inView: false })).toBe("reveal");
  });

  it("shows the inline list unless this viewer hid it", () => {
    expect(subagentsShownFrom(null)).toBe(true);
    expect(subagentsShownFrom(undefined)).toBe(true);
    expect(subagentsShownFrom("garbage")).toBe(true);
    expect(subagentsShownFrom(subagentsShownValue(false))).toBe(false);
    expect(subagentsShownFrom(subagentsShownValue(true))).toBe(true);
  });

  it("heads the list with one line", () => {
    expect(subagentsLine(["working", "done", "done"])).toBe("Subagents: 1 working, 2 done");
  });
});

import { describe, expect, it } from "vitest";
import type { QaHeld } from "@ue-mcp-studio/shared";
import { HELD_COPY, heldForBar, heldLeft, heldOfEvent } from "./held.js";

const held = (runId: string, since: string): QaHeld => ({ runId, scriptName: "Door", sessionId: "s1", step: 1, instruction: "It opens", since, dueAt: "2026-11-23T10:10:00.000Z", paused: true });

describe("a run held for a verdict", () => {
  it("counts down to the deadline the agent set, never below zero", () => {
    const due = "2026-11-23T10:10:00.000Z";
    expect(heldLeft(due, Date.parse("2026-11-23T10:02:18.000Z"))).toBe("7:42");
    expect(heldLeft(due, Date.parse("2026-11-23T10:09:59.400Z"))).toBe("0:01");
    expect(heldLeft(due, Date.parse("2026-11-23T10:11:00.000Z"))).toBe("0:00");
    expect(heldLeft("2026-11-23T11:12:05.000Z", Date.parse("2026-11-23T10:10:00.000Z"))).toBe("1:02:05");
    expect(HELD_COPY.endsIn("7:42")).toBe("Ends in 7:42");
  });

  it("reads the list from its event and shows the longest wait", () => {
    const list = [held("a", "2026-11-23T10:00:00.000Z"), held("b", "2026-11-23T10:01:00.000Z")];
    expect(heldOfEvent({ type: "studio.qa.held", data: { held: list } })).toEqual(list);
    expect(heldOfEvent({ type: "studio.qa.changed", data: { held: list } })).toBeNull();
    expect(heldForBar(list)?.runId).toBe("a");
    expect(heldForBar([])).toBeNull();
    expect(HELD_COPY.waiting(list[0])).toBe("Waiting for your verdict: Door, step 2");
  });
});

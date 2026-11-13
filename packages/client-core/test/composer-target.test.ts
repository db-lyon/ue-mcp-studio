import { describe, expect, it } from "vitest";
import type { ToolCallRecord } from "@ue-mcp-studio/shared";
import { composerPlaceholder, composerQueues, composerTarget } from "../src/composer-target.js";

const call = (outcome: ToolCallRecord["outcome"]): ToolCallRecord => ({ id: "ag", name: "agent", input: { description: "Build the door", prompt: "door" }, outcome, startedAt: "2026-11-13T10:00:00Z" });
const running = { status: "running" as const, mainFree: false };
const free = { status: "running" as const, mainFree: true };
const idle = { status: "idle" as const };

describe("where the composer's message goes", () => {
  it("goes to the main agent from the main thread, as before", () => {
    const t = composerTarget(null);
    expect(t).toEqual({ to: "main" });
    expect(composerPlaceholder(idle, t)).toBe("Ask for something");
    expect(composerPlaceholder(running, t)).toBe("Queue a message");
    expect(composerPlaceholder(free, t)).toBe("Message the main agent");
    expect(composerQueues(running, t)).toBe(true);
  });

  it("goes to a running subagent from its thread, by its description, and never queues behind the main agent", () => {
    const t = composerTarget(call("pending"));
    expect(t.to).toBe("subagent");
    expect(composerPlaceholder(running, t)).toBe('Message "Build the door"');
    expect(composerPlaceholder(free, t)).toBe('Message "Build the door"');
    expect(composerQueues(running, t)).toBe(false);
  });

  it("goes to the main agent from a finished subagent's thread, and says the subagent has finished", () => {
    for (const outcome of ["done", "error", "stopped", "unknown"] as const) {
      const t = composerTarget(call(outcome));
      expect(t.to).toBe("finished");
      expect(composerPlaceholder(idle, t)).toBe('"Build the door" finished. Message the main agent');
      expect(composerPlaceholder(running, t)).toBe('"Build the door" finished. Queue a message for the main agent');
      expect(composerQueues(running, t)).toBe(true);
      expect(composerQueues(free, t)).toBe(false);
    }
  });
});

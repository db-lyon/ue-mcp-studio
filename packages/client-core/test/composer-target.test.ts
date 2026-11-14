import { describe, expect, it } from "vitest";
import type { ToolCallRecord } from "@ue-mcp-studio/shared";
import { composerPlaceholder, composerQueues, composerTarget, messageDeliveryNote, toMainFromThread } from "../src/composer-target.js";

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

  it("goes to the main agent, naming the subagent, when the daemon says a running one cannot take a message", () => {
    const t = composerTarget(call("pending"), { messageable: false });
    expect(t.to).toBe("unreachable");
    expect(toMainFromThread(t)).toBe(true);
    expect(composerPlaceholder(free, t)).toBe('"Build the door" can\'t read messages. Message the main agent');
    expect(composerPlaceholder(running, t)).toBe('"Build the door" can\'t read messages. Queue a message for the main agent');
    expect(composerQueues(running, t)).toBe(true);
    // One the daemon says takes messages, or a daemon too old to say: the subagent, as before.
    expect(composerTarget(call("pending"), { messageable: true }).to).toBe("subagent");
    expect(composerTarget(call("pending"), {}).to).toBe("subagent");
    expect(toMainFromThread(composerTarget(call("pending")))).toBe(false);
    // A finished one is finished whatever it says.
    expect(composerTarget(call("done"), { messageable: false }).to).toBe("finished");
  });
});

describe("what became of a message written in a subagent's thread", () => {
  it("says when it waits for the subagent's next step, or never reached it", () => {
    expect(messageDeliveryNote("waiting")).toBe("Waiting for its next step");
    expect(messageDeliveryNote("main")).toBe("Not delivered: it ended first, so the main agent has it");
    // Read, or from a Studio that did not track it: nothing to say.
    expect(messageDeliveryNote("read")).toBeNull();
    expect(messageDeliveryNote(undefined)).toBeNull();
  });
});

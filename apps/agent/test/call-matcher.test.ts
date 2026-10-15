/** Matching the Agent SDK's tool calls to the blocks the model sent, without crossing them. */
import { describe, expect, it, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ tool: () => ({}), createSdkMcpServer: () => ({}), query: () => ({}) }));
const { CallMatcher } = await import("../src/subscription.js");

describe("matching a call to its block", () => {
  it("matches by name and input, whatever order the input's keys are in", async () => {
    const m = new CallMatcher();
    m.add("a", "read_file", { path: "x", limit: 10 });
    m.add("b", "read_file", { path: "y" });
    expect(await m.take("read_file", { limit: 10, path: "x" })).toBe("a");
    expect(await m.take("read_file", { path: "y" })).toBe("b");
  });

  it("waits for a block that has not been read yet instead of taking another call's", async () => {
    const m = new CallMatcher(2000);
    m.add("agent-1", "agent", { prompt: "p" });
    const pending = m.take("read_file", { path: "x" });
    setTimeout(() => m.add("r1", "read_file", { path: "x" }), 30);
    expect(await pending).toBe("r1");
    expect(await m.take("agent", { prompt: "p" })).toBe("agent-1");
  });

  it("never answers with another tool's block, even when nothing matches", async () => {
    const m = new CallMatcher(20);
    m.add("agent-1", "agent", { prompt: "p" });
    const id = await m.take("web_fetch", { url: "u" });
    expect(id).not.toBe("agent-1");
    expect(id).toMatch(/^call_/);
    // Same tool, input that changed on the way: matched by name after the wait.
    m.add("w1", "web_fetch", { url: "u", max_length: 5 });
    expect(await m.take("web_fetch", { url: "u" })).toBe("w1");
  });
});

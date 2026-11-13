// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { sessionAgents, type ToolCallRecord, type TranscriptEntry } from "@ue-mcp-studio/shared";
import { AgentGroup } from "./Transcript";
import { AgentsContext } from "./asked";

afterEach(cleanup);
const at = "2026-11-10T12:00:00.000Z";
const agent = (id: string, description: string, outcome: ToolCallRecord["outcome"]): ToolCallRecord =>
  ({ id, name: "agent", input: { description, prompt: "p" }, outcome, startedAt: at, ...(outcome === "pending" ? {} : { endedAt: at, result: "x" }) }) as ToolCallRecord;

describe("a subagent's line in the main thread", () => {
  it("stops a running subagent from its line, and offers no Stop once it has ended", () => {
    const onStop = vi.fn();
    const calls = [agent("a1", "Playtest attempt 2", "pending"), agent("a2", "Playtest attempt 3", "stopped")];
    const transcript: TranscriptEntry[] = calls.map((call) => ({ kind: "tool", call }));
    const agents = new Map(sessionAgents(transcript, { status: "running", asked: new Set() }).map((a) => [a.id, a]));
    render(<AgentsContext.Provider value={agents}><AgentGroup calls={calls} onOpen={() => {}} onStop={onStop} /></AgentsContext.Provider>);
    fireEvent.click(screen.getByLabelText("Stop Playtest attempt 2"));
    expect(onStop).toHaveBeenCalledWith("a1");
    expect(screen.queryByLabelText("Stop Playtest attempt 3")).toBeNull();
  });
});

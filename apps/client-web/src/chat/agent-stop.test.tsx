// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ToolCallRecord, TranscriptEntry } from "@ue-mcp-studio/shared";
import { AgentGroup } from "./Transcript";

afterEach(cleanup);
const at = "2026-11-10T12:00:00.000Z";
const agent = (id: string, description: string, outcome: ToolCallRecord["outcome"]): ToolCallRecord =>
  ({ id, name: "agent", input: { description, prompt: "p" }, outcome, startedAt: at, ...(outcome === "pending" ? {} : { endedAt: at, result: "x" }) }) as ToolCallRecord;

describe("a subagent's line in the main thread", () => {
  it("stops a running subagent from its line, and offers no Stop once it has ended", () => {
    const onStop = vi.fn();
    const calls = [agent("a1", "Playtest attempt 2", "pending"), agent("a2", "Playtest attempt 3", "stopped")];
    const transcript: TranscriptEntry[] = calls.map((call) => ({ kind: "tool", call }));
    render(<AgentGroup calls={calls} transcript={transcript} sessionWaiting={false} onOpen={() => {}} onStop={onStop} />);
    fireEvent.click(screen.getByLabelText("Stop Playtest attempt 2"));
    expect(onStop).toHaveBeenCalledWith("a1");
    expect(screen.queryByLabelText("Stop Playtest attempt 3")).toBeNull();
  });
});

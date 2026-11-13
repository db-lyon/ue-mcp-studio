// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { sessionAgents, type ToolCallRecord, type TranscriptEntry } from "@ue-mcp-studio/shared";
import { ChatHeader } from "./ChatHeader";
import { Sheet } from "./Sheet";

afterEach(cleanup);

const at = (secs: number) => new Date(Date.parse("2026-10-11T12:00:00Z") + secs * 1000).toISOString();
const call = (outcome: ToolCallRecord["outcome"]): ToolCallRecord => ({
  id: "a1", name: "agent", input: { description: "Slow fetches", prompt: "fetch" }, outcome, startedAt: at(0), endedAt: outcome === "pending" ? undefined : at(11),
});

function setup(thread: ToolCallRecord | null) {
  const props = { onSessions: vi.fn(), onMain: vi.fn(), onStop: vi.fn() };
  const transcript: TranscriptEntry[] = thread ? [{ kind: "tool", call: thread }] : [];
  // The subagent as the daemon's list has it.
  const agent = sessionAgents(transcript, { status: "idle", asked: new Set() })[0] ?? null;
  render(<ChatHeader title="Start two subagents" thread={agent} {...props} />);
  return props;
}

describe("the narrow conversation's header", () => {
  it("on the main thread, names the session and goes back to the sessions", () => {
    const p = setup(null);
    expect(screen.getByText("Start two subagents")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Back to sessions"));
    expect(p.onSessions).toHaveBeenCalledOnce();
    expect(p.onMain).not.toHaveBeenCalled();
  });

  it("in a subagent's thread, names it under the session and goes back to the main thread", () => {
    const p = setup(call("stopped"));
    expect(screen.getByText("Slow fetches")).toBeTruthy();
    expect(document.querySelector(".chat-back-parent")?.textContent).toBe("Start two subagents");
    expect(screen.getByText("stopped")).toBeTruthy();
    expect(screen.queryByText("Stop")).toBeNull();
    fireEvent.click(screen.getByLabelText("Back to the main thread"));
    expect(p.onMain).toHaveBeenCalledOnce();
    expect(p.onSessions).not.toHaveBeenCalled();
  });

  it("offers Stop while the subagent runs", () => {
    const p = setup(call("pending"));
    fireEvent.click(screen.getByText("Stop"));
    expect(p.onStop).toHaveBeenCalledWith("a1");
  });

  it("holds no Checkpoints or subagents button: they are in the composer bar", () => {
    setup(null);
    expect(screen.queryByText("Checkpoints")).toBeNull();
    expect(screen.queryByLabelText(/Checkpoints|Subagents/)).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
});

describe("the bottom sheet", () => {
  it("shows its content while open and closes from the scrim, Close and Escape", () => {
    const close = vi.fn();
    const { container, rerender } = render(<Sheet open title="Subagents" onClose={close}><span>rows</span></Sheet>);
    expect(container.querySelector(".sheet-root.open")).not.toBeNull();
    fireEvent.click(container.querySelector(".sheet-scrim")!);
    fireEvent.click(screen.getByText("Close"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(close).toHaveBeenCalledTimes(3);
    rerender(<Sheet open={false} title="Subagents" onClose={close}><span>rows</span></Sheet>);
    expect(container.querySelector(".sheet-root")?.getAttribute("aria-hidden")).toBe("true");
  });
});

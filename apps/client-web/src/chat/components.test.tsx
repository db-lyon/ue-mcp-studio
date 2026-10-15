// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { SessionSummary, ToolCallRecord, TranscriptEntry } from "@ue-mcp-studio/shared";

vi.mock("../api", () => ({
  api: {
    updateSession: vi.fn(async () => ({})),
    deleteSession: vi.fn(async () => undefined),
  },
}));
import { api } from "../api";
import { Threads } from "./Threads";
import { SessionRow } from "./SessionRow";
import { EditMessageContext, Entry, MainTranscript, ToolCall } from "./Transcript";
import { AssetTranscriptContext } from "./asset-links";
import { SessionIdContext } from "./attachments";

const T0 = Date.parse("2026-10-11T12:00:00Z");
const at = (secs: number) => new Date(T0 + secs * 1000).toISOString();
const agent = (id: string, outcome: ToolCallRecord["outcome"] = "pending", end?: number): TranscriptEntry => ({
  kind: "tool",
  call: { id, name: "agent", input: { description: `Task ${id}`, prompt: `do ${id}` }, outcome, startedAt: at(0), endedAt: end === undefined ? undefined : at(end) },
});
const step = (parent: string, id: string, outcome: ToolCallRecord["outcome"]): TranscriptEntry => ({
  kind: "tool",
  parent,
  call: { id, name: "ue_mcp", input: { action: "call", category: "asset", method: "list" }, outcome, startedAt: at(1), endedAt: outcome === "pending" ? undefined : at(2) },
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0 + 5000);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("the thread list", () => {
  const transcript = [agent("a"), step("a", "s1", "pending"), agent("b", "done", 4), agent("c", "error", 3), agent("d", "stopped", 2)];
  const renderThreads = (over: Partial<Parameters<typeof Threads>[0]> = {}) => {
    const props = { transcript, thread: null, onThread: vi.fn(), onStop: vi.fn(), sessionWaiting: false, seen: new Set<string>(["d"]), ...over };
    render(<Threads {...props} />);
    return props;
  };

  it("shows running subagents with what they are doing, and hides finished ones until asked", () => {
    renderThreads();
    expect(screen.getByText("Subagents: 1 working, 1 done, 1 stopped, 1 failed")).toBeTruthy();
    expect(screen.getByText("Task a")).toBeTruthy();
    expect(screen.getByText("asset.list")).toBeTruthy();
    expect(screen.queryByText("Task b")).toBeNull();
    const fold = screen.getByRole("button", { name: /Finished \(3\)/ });
    expect(fold.textContent).toContain("2 new");
    expect(fold.textContent).toContain("1 failed");
    fireEvent.click(fold);
    expect(screen.getByText("Task b")).toBeTruthy();
    expect(screen.getAllByText("new")).toHaveLength(2);
  });

  it("opens a thread from its row, and stops a running one without opening it", () => {
    const p = renderThreads();
    fireEvent.click(screen.getByRole("button", { name: "Stop Task a" }));
    expect(p.onStop).toHaveBeenCalledWith("a");
    expect(p.onThread).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Task a"));
    expect(p.onThread).toHaveBeenCalledWith("a");
    fireEvent.click(screen.getByText("Main"));
    expect(p.onThread).toHaveBeenLastCalledWith(null);
  });

  it("dismisses one finished subagent, or every finished one, and leaves running ones", () => {
    const onDismiss = vi.fn();
    renderThreads({ onDismiss });
    expect(screen.queryByRole("button", { name: "Dismiss Task a" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Finished \(3\)/ }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss Task b" }));
    expect(onDismiss).toHaveBeenLastCalledWith(["b"]);
    fireEvent.click(screen.getByRole("button", { name: "Clear finished" }));
    expect(onDismiss).toHaveBeenLastCalledWith(["b", "c", "d"]);
  });

  it("leaves dismissed subagents out of the list and its counts", () => {
    renderThreads({ dismissed: new Set(["b", "c"]), onDismiss: vi.fn() });
    expect(screen.getByText("Subagents: 1 working, 1 stopped")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Finished \(1\)/ })).toBeTruthy();
    cleanup();
    renderThreads({ transcript: [agent("b", "done", 4)], dismissed: new Set(["b"]) });
    expect(screen.queryByText("Main")).toBeNull();
  });

  it("keeps the open thread's row while it is open, even dismissed", () => {
    renderThreads({ thread: "b", dismissed: new Set(["b"]) });
    expect(screen.getByText("Task b")).toBeTruthy();
  });

  it("opens the finished section when the open thread is in it", () => {
    renderThreads({ thread: "b" });
    expect(screen.getByText("Task b")).toBeTruthy();
  });

  it("keeps a quiet subagent working and says how long it has been quiet, never stuck", () => {
    renderThreads({ transcript: [agent("q")] });
    expect(screen.getByText("working")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(100_000);
    });
    expect(screen.queryByText("stuck")).toBeNull();
    expect(screen.getByText(/since its last step/)).toBeTruthy();
  });
});

describe("a session row", () => {
  const s: SessionSummary = {
    id: "s1", title: "Light the level", status: "running", createdAt: at(0), updatedAt: at(0), waitingCause: null, archived: false,
    agents: { total: 5, running: 2 }, awaiting: 0,
  };

  it("says what the session is doing and how many subagents run", () => {
    render(<SessionRow s={s} selected={false} onOpen={vi.fn()} onChanged={vi.fn()} />);
    expect(screen.getByText("Working, 2 of 5 subagents running")).toBeTruthy();
  });

  it("archives from its menu", async () => {
    const onChanged = vi.fn();
    render(<SessionRow s={s} selected={false} onOpen={vi.fn()} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: "Archive" })));
    expect(api.updateSession).toHaveBeenCalledWith("s1", { archived: true });
    expect(onChanged).toHaveBeenCalled();
  });

  it("deletes only on the second click", async () => {
    const onChanged = vi.fn();
    render(<SessionRow s={s} selected={false} onOpen={vi.fn()} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(api.deleteSession).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: "Delete for good" })));
    expect(api.deleteSession).toHaveBeenCalledWith("s1");
    expect(onChanged).toHaveBeenCalledWith("s1");
  });

  it("renames in place: Enter saves, Escape puts the old title back", async () => {
    render(<SessionRow s={s} selected={false} onOpen={vi.fn()} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Session title" });
    fireEvent.change(input, { target: { value: "Night lighting" } });
    await act(async () => fireEvent.keyDown(input, { key: "Enter" }));
    expect(api.updateSession).toHaveBeenCalledWith("s1", { title: "Night lighting" });
  });
});

describe("the main thread", () => {
  const props = { status: "idle" as const, streaming: "", waitingCause: null, error: null, onOpen: vi.fn(), hidden: false };

  it("collapses a large finished group of subagents into one line", () => {
    const t: TranscriptEntry[] = [{ kind: "user", text: "go", at: at(0) }, ...["a", "b", "c", "d"].map((id) => agent(id, "done", 3))];
    render(<MainTranscript transcript={t} {...props} />);
    const head = screen.getByRole("button", { name: /4 subagents/ });
    expect(head.textContent).toContain("4 done");
    expect(screen.queryByText("Task a")).toBeNull();
    fireEvent.click(head);
    expect(screen.getByText("Task a")).toBeTruthy();
  });

  it("keeps a group open while any of it runs, and opens a thread from a row", () => {
    const onOpen = vi.fn();
    const t: TranscriptEntry[] = [{ kind: "user", text: "go", at: at(0) }, ...["a", "b", "c", "d"].map((id) => agent(id, id === "a" ? "pending" : "done", 3))];
    render(<MainTranscript transcript={t} {...props} status="running" onOpen={onOpen} />);
    fireEvent.click(screen.getByText("Task a"));
    expect(onOpen).toHaveBeenCalledWith("a");
  });

  it("folds progress messages behind the final answer", () => {
    const t: TranscriptEntry[] = [
      { kind: "user", text: "go", at: at(0) },
      { kind: "assistant", text: "Started them.", at: at(1) },
      agent("a", "done", 3),
      { kind: "assistant", text: "All done.", at: at(4) },
    ];
    render(<MainTranscript transcript={t} {...props} />);
    expect(screen.queryByText("Started them.")).toBeNull();
    expect(screen.getByText("All done.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /1 progress update/ }));
    expect(screen.getByText("Started them.")).toBeTruthy();
  });
});

describe("a tool call", () => {
  it("indents a JSON result and shortens a long one", () => {
    const lines = Array.from({ length: 50 }, (_, i) => i);
    render(<ToolCall call={{ id: "t", name: "ue_mcp", input: { action: "call", category: "asset", method: "list" }, outcome: "done", startedAt: at(0), result: JSON.stringify(lines) }} />);
    expect(screen.getByText("Result, 52 lines")).toBeTruthy();
    const show = screen.getByRole("button", { name: "Show all 52 lines" });
    fireEvent.click(show);
    expect(screen.getByRole("button", { name: "Show less" })).toBeTruthy();
  });

  it("shows the images the model saw as thumbnails, with the call closed", () => {
    const call: ToolCallRecord = {
      id: "r", name: "read_file", input: { path: "C:/P/Saved/shot.png" }, outcome: "done", startedAt: at(0), result: "shot.png: PNG image",
      images: [{ id: "img1", name: "shot.jpg", type: "image/jpeg", size: 2048 }],
    };
    render(<SessionIdContext.Provider value="s1"><ToolCall call={call} /></SessionIdContext.Provider>);
    const img = screen.getByRole("img", { name: "shot.jpg" }) as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("/v1/ext/studio/sessions/s1/attachments/img1");
    expect(img.closest("details")).toBeNull();
  });
});

describe("editing a sent message", () => {
  const transcript: TranscriptEntry[] = [
    { kind: "user", text: "make a cube", at: at(0) },
    { kind: "assistant", text: "Made it.", at: at(1) },
    { kind: "user", text: "paint it red", at: at(2) },
    { kind: "assistant", text: "Painted.", at: at(3) },
  ];
  const renderEntry = (i: number, onEdit = vi.fn()) => {
    render(
      <AssetTranscriptContext.Provider value={transcript}>
        <EditMessageContext.Provider value={onEdit}><Entry entry={transcript[i]} /></EditMessageContext.Provider>
      </AssetTranscriptContext.Provider>,
    );
    return onEdit;
  };

  it("asks before discarding what came after, saying the project keeps its changes", () => {
    const onEdit = renderEntry(0);
    fireEvent.click(screen.getByRole("button", { name: "Edit this message" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit your message" }), { target: { value: "make a sphere" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and send" }));
    expect(onEdit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Changes the agent already made to the project are not undone");
    fireEvent.click(screen.getByRole("button", { name: "Discard and send" }));
    expect(onEdit).toHaveBeenCalledWith(0, "make a sphere");
  });

  it("cancels without sending", () => {
    const onEdit = renderEntry(2);
    fireEvent.click(screen.getByRole("button", { name: "Edit this message" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onEdit).not.toHaveBeenCalled();
    expect(screen.getByText("paint it red")).toBeTruthy();
  });

  it("offers no edit where editing is not available", () => {
    render(<AssetTranscriptContext.Provider value={transcript}><Entry entry={transcript[0]} /></AssetTranscriptContext.Provider>);
    expect(screen.queryByRole("button", { name: "Edit this message" })).toBeNull();
  });
});

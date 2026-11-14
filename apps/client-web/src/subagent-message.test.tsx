// @vitest-environment jsdom
// A message written in a subagent's thread goes to that subagent while it runs, without queueing
// behind the main agent or stopping anything; from a finished one it goes to the main agent, naming it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const m = vi.hoisted(() => ({ session: vi.fn(), sessions: vi.fn(), messageSubagent: vi.fn(), send: vi.fn(), queue: vi.fn(), stop: vi.fn(), saveDraft: vi.fn() }));
vi.mock("./api", () => {
  const pending = () => new Promise(() => {});
  const api = new Proxy(m as Record<string, unknown>, { get: (t, k: string) => (k === "sessionSync" ? (id: string) => m.session(id) : t[k] ?? pending) });
  return { api, ApiError: class extends Error {} };
});
import { sessionAgents, type TranscriptEntry } from "@ue-mcp-studio/shared";
import { ChatView } from "./views/Chat";

const daemon = { events: [], health: null, streaming: true, error: null, refresh: () => {} } as never;
const agent = (outcome: "pending" | "done") => ({
  kind: "tool",
  call: { id: "a1", name: "agent", input: { description: "Dress the floor", prompt: "x" }, outcome, startedAt: new Date(Date.now() - 60_000).toISOString(), ...(outcome === "done" ? { endedAt: new Date().toISOString(), result: "ok" } : {}) },
});
type Extra = { messageable?: boolean; thread?: TranscriptEntry[] };
const session = (outcome: "pending" | "done", status = "running", extra: Extra = {}) => {
  const transcript = [{ kind: "user", text: "dress the cave", at: new Date().toISOString() }, agent(outcome), ...(extra.thread ?? [])] as TranscriptEntry[];
  return {
    id: "s1", title: "Cave", status, createdAt: 1, updatedAt: 1, archived: false, agents: { total: 1, running: outcome === "pending" ? 1 : 0 }, awaiting: 0,
    mainFree: false, draft: "",
    transcript,
    // The daemon's own answer on whether the running subagent takes a message.
    ...(extra.messageable !== undefined ? { subagents: sessionAgents(transcript, { status: status as "running", asked: new Set(), messageable: () => extra.messageable! }) } : {}),
  };
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.location.hash = "";
});

async function openThread(outcome: "pending" | "done", status = "running", extra: Extra = {}) {
  window.location.hash = "#/chat/s1";
  const s = session(outcome, status, extra);
  m.sessions.mockResolvedValue({ sessions: [s] });
  m.session.mockResolvedValue(s);
  m.messageSubagent.mockResolvedValue({ sessionId: "s1", to: outcome === "pending" ? "subagent" : "queue" });
  m.saveDraft.mockResolvedValue(undefined);
  render(<ChatView daemon={daemon} />);
  const row = await screen.findAllByText("Dress the floor");
  // Its block in the main thread opens its thread (a finished one is folded in the list under the composer).
  fireEvent.click(row.find((r) => r.classList.contains("tool-call"))!);
  return (await screen.findByPlaceholderText(/Dress the floor/)) as HTMLTextAreaElement;
}

describe("the composer in a subagent's thread", () => {
  it("messages the running subagent while the main agent works: it sends rather than queues, and the thread stays open", async () => {
    const box = await openThread("pending");
    expect(box.placeholder).toBe('Message "Dress the floor"');
    fireEvent.change(box, { target: { value: "use the wet stone" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(m.messageSubagent).toHaveBeenCalledWith("s1", "a1", "use the wet stone", [], false));
    expect(m.send).not.toHaveBeenCalled();
    expect(m.queue).not.toHaveBeenCalled();
    expect(m.stop).not.toHaveBeenCalled();
    // Still in the subagent's thread.
    expect(screen.getByPlaceholderText('Message "Dress the floor"')).toBeTruthy();
  });

  it("says before the user types when the daemon says a running subagent cannot read messages, and sends to the main agent", async () => {
    const box = await openThread("pending", "running", { messageable: false });
    expect(box.placeholder).toBe('"Dress the floor" can\'t read messages. Queue a message for the main agent');
    fireEvent.change(box, { target: { value: "make it wetter" } });
    fireEvent.keyDown(box, { key: "Enter" });
    // Through the thread's route, which hands it to the main agent naming the subagent.
    await waitFor(() => expect(m.messageSubagent).toHaveBeenCalledWith("s1", "a1", "make it wetter", [], false));
    expect(m.send).not.toHaveBeenCalled();
  });

  it("marks a message the subagent has not read yet, and one it never read", async () => {
    const at = new Date().toISOString();
    await openThread("pending", "running", {
      messageable: true,
      thread: [
        { kind: "user", text: "first", at, parent: "a1", delivery: "read" },
        { kind: "user", text: "lost one", at, parent: "a1", delivery: "main" },
        { kind: "user", text: "just sent", at, parent: "a1", delivery: "waiting" },
      ],
    });
    expect(await screen.findByText("Waiting for its next step")).toBeTruthy();
    expect(screen.getByText("Not delivered: it ended first, so the main agent has it").className).toContain("undelivered");
    // A read one says nothing more.
    expect(screen.getAllByRole("status").filter((n) => n.classList.contains("msg-delivery"))).toHaveLength(2);
  });

  it("says a finished subagent has finished, and sends to the main agent through its route, naming it", async () => {
    const box = await openThread("done", "idle");
    expect(box.placeholder).toBe('"Dress the floor" finished. Message the main agent');
    fireEvent.change(box, { target: { value: "redo it darker" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(m.messageSubagent).toHaveBeenCalledWith("s1", "a1", "redo it darker", [], false));
    expect(m.send).not.toHaveBeenCalled();
  });
});

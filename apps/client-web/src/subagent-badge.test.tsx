// @vitest-environment jsdom
// The bar's Subagents badge counts what the Subagents list shows: once the finished
// subagents are cleared, the badge drops to the running ones, the same number the list has.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const m = vi.hoisted(() => ({ session: vi.fn(), sessions: vi.fn(), dismissAgents: vi.fn(), saveDraft: vi.fn() }));
vi.mock("./api", () => {
  const pending = () => new Promise(() => {});
  const api = new Proxy(m as Record<string, unknown>, { get: (t, k: string) => (k === "sessionSync" ? (id: string) => m.session(id) : t[k] ?? pending) });
  return { api, ApiError: class extends Error {} };
});
import { ChatView } from "./views/Chat";

const daemon = { events: [], health: null, streaming: true, error: null, refresh: () => {} } as never;
const started = new Date(Date.now() - 60_000).toISOString();
const agent = (id: string, done: boolean) => ({
  kind: "tool",
  call: { id, name: "agent", input: { description: `Task ${id}`, prompt: "x" }, outcome: done ? "done" : "pending", startedAt: started, ...(done ? { endedAt: new Date().toISOString(), result: "ok" } : {}) },
});
const finished = Array.from({ length: 12 }, (_, i) => `f${i}`);
const session = (dismissed: string[]) => ({
  id: "s1", title: "Cave", status: "running", createdAt: 1, updatedAt: 1, archived: false, agents: { total: 14, running: 2 }, awaiting: 0,
  mainFree: true, draft: "", seen: [], dismissed,
  transcript: [{ kind: "user", text: "dress the cave", at: new Date().toISOString() }, agent("r1", false), agent("r2", false), ...finished.map((id) => agent(id, true))],
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.location.hash = "";
});

async function open(dismissed: string[] = []) {
  window.location.hash = "#/chat/s1";
  const s = session(dismissed);
  m.sessions.mockResolvedValue({ sessions: [s] });
  m.session.mockResolvedValue(s);
  m.dismissAgents.mockResolvedValue({ dismissed: finished });
  m.saveDraft.mockResolvedValue(undefined);
  render(<ChatView daemon={daemon} />);
  return screen.findByRole("button", { name: /^Subagents \(\d+\)$/ });
}

describe("the bar's Subagents badge", () => {
  it("counts every subagent while none is dismissed", async () => {
    expect((await open()).getAttribute("aria-label")).toBe("Subagents (14)");
  });

  it("drops to the running ones after Clear finished, matching the list", async () => {
    fireEvent.click(await open());
    // The list shows under the composer and in the sheet: clear from either.
    fireEvent.click(screen.getAllByRole("button", { name: "Clear finished" })[0]);
    await waitFor(() => expect(screen.getByRole("button", { name: /^Subagents \(\d+\)$/ }).getAttribute("aria-label")).toBe("Subagents (2)"));
    expect(m.dismissAgents).toHaveBeenCalledWith("s1", finished);
    // Every list left says 2 working, and none has a Finished fold.
    const summaries = screen.getAllByText(/^Subagents: /).map((e) => e.textContent);
    expect(summaries.length).toBeGreaterThan(0);
    for (const s of summaries) expect(s).toBe("Subagents: 2 working");
    expect(screen.queryByRole("button", { name: /Finished \(/ })).toBeNull();
  });

  it("reads the daemon's dismissals: a session reopened after clearing says 2", async () => {
    expect((await open(finished)).getAttribute("aria-label")).toBe("Subagents (2)");
  });
});

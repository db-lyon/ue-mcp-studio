// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

const sessions = [
  { id: "s1", title: "First", status: "idle", createdAt: 1, updatedAt: 1, archived: false, agents: { total: 0, running: 0 }, awaiting: 0 },
  { id: "s2", title: "Quick ask", status: "running", createdAt: 2, updatedAt: 2, archived: false, agents: { total: 0, running: 0 }, awaiting: 0 },
];
const m = vi.hoisted(() => ({ session: vi.fn(), sessions: vi.fn() }));
vi.mock("./api", () => {
  const pending = () => new Promise(() => {});
  const api = new Proxy(m as Record<string, unknown>, { get: (t, k: string) => t[k] ?? pending });
  return { api, ApiError: class extends Error {} };
});
import { ChatView } from "./views/Chat";

const event = (id: number, type: string, data: Record<string, unknown>) => ({ id, type, data, at: id }) as never;
const daemon = (events: unknown[]) => ({ events, health: null, streaming: true, error: null, refresh: () => {} }) as never;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.location.hash = "";
});

describe("studio.session.focus", () => {
  it("switches the open chat to the session the event names", async () => {
    window.location.hash = "#/chat/s1";
    m.sessions.mockResolvedValue({ sessions });
    m.session.mockImplementation((id: string) => Promise.resolve({ ...sessions.find((s) => s.id === id), transcript: [], draft: "" }));
    const view = render(<ChatView daemon={daemon([event(1, "studio.session.focus", { sessionId: "s1" })])} />);
    await waitFor(() => expect(m.session).toHaveBeenCalledWith("s1"));
    view.rerender(<ChatView daemon={daemon([event(1, "studio.session.focus", { sessionId: "s1" }), event(2, "studio.session.focus", { sessionId: "s2" })])} />);
    await waitFor(() => expect(m.session).toHaveBeenCalledWith("s2"));
    expect(window.location.hash).toBe("#/chat/s2");
  });

  it("does not replay a focus event from before the chat mounted", async () => {
    window.location.hash = "#/chat/s1";
    m.sessions.mockResolvedValue({ sessions });
    m.session.mockImplementation((id: string) => Promise.resolve({ ...sessions.find((s) => s.id === id), transcript: [], draft: "" }));
    render(<ChatView daemon={daemon([event(5, "studio.session.focus", { sessionId: "s2" })])} />);
    await waitFor(() => expect(m.session).toHaveBeenCalledWith("s1"));
    expect(m.session).not.toHaveBeenCalledWith("s2");
  });
});

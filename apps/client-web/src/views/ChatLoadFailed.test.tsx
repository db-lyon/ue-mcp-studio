// @vitest-environment jsdom
/** A session that could not be read says so in place of its transcript, with Try again, as the phone does. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const sessions = [{ id: "s1", title: "First", status: "idle", createdAt: 1, updatedAt: 1, archived: false, agents: { total: 0, running: 0 }, awaiting: 0 }];
const m = vi.hoisted(() => ({ session: vi.fn(), sessions: vi.fn() }));
vi.mock("../api", () => {
  const pending = () => new Promise(() => {});
  const api = new Proxy(m as Record<string, unknown>, { get: (t, k: string) => (k === "sessionSync" ? (id: string) => m.session(id) : t[k] ?? pending) });
  class ApiError extends Error {
    constructor(readonly status: number, message: string) {
      super(message);
    }
  }
  return { api, ApiError };
});
import { ChatView } from "./Chat";

const daemon = { health: null, error: null, streaming: true, events: [], refresh: () => {} };

beforeEach(() => {
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} })) as never;
  m.sessions.mockResolvedValue({ sessions });
  window.location.hash = "#/chat/s1";
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.location.hash = "";
});

describe("a session that could not be loaded", () => {
  it("says why in place of the skeleton, and Try again reads it again", async () => {
    m.session.mockRejectedValueOnce(new Error("the computer answered 500"));
    m.session.mockImplementation((id: string) => Promise.resolve({ ...sessions.find((s) => s.id === id), transcript: [{ kind: "user", text: "Hello there", at: "2026-11-16T10:00:00Z" }], draft: "" }));
    render(<ChatView daemon={daemon} />);
    expect(await screen.findByText("This session could not be loaded: the computer answered 500")).toBeTruthy();
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Load the session again" })));
    expect(await screen.findByText("Hello there")).toBeTruthy();
    expect(screen.queryByText(/could not be loaded/)).toBeNull();
    expect(m.session).toHaveBeenCalledTimes(2);
  });
});

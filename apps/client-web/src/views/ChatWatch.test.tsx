// @vitest-environment jsdom
/**
 * #463 L2: the open session follows its watch. An op from the event stream
 * draws the change in place without reading the session again; a gap reads it.
 * The docked window hosts this same client.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

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

const at = "2026-11-16T10:00:00Z";
const daemonWith = (events: Array<{ id: number; type: string; data: Record<string, unknown> }>) =>
  ({ health: null, error: null, streaming: true, events: events.map((e) => ({ ...e, at })), refresh: () => {} }) as unknown as Parameters<typeof ChatView>[0]["daemon"];

beforeEach(() => {
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} })) as never;
  m.sessions.mockResolvedValue({ sessions });
  m.session.mockImplementation(() => Promise.resolve({ ...sessions[0], hashes: "", transcript: [{ kind: "user", text: "Hello there", at }], draft: "", opsSeq: 10 }));
  window.location.hash = "#/chat/s1";
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.location.hash = "";
});

describe("following the open session's watch", () => {
  it("draws an op's entries without reading the session, and reads it again on a gap", async () => {
    const view = render(<ChatView daemon={daemonWith([])} />);
    expect(await screen.findByText("Hello there")).toBeTruthy();
    const reads = m.session.mock.calls.length;
    const op = { sessionId: "s1", seq: 11, length: 2, entries: [[1, { kind: "assistant", text: "Hi, what shall we build?", at }, 1]] };
    view.rerender(<ChatView daemon={daemonWith([
      { id: 1, type: "studio.transcript.added", data: { sessionId: "s1" } },
      { id: 2, type: "studio.session.ops", data: op },
    ])} />);
    expect(await screen.findByText("Hi, what shall we build?")).toBeTruthy();
    expect(m.session.mock.calls.length).toBe(reads);

    // Op 13 with 12 never seen: the session is read again.
    view.rerender(<ChatView daemon={daemonWith([
      { id: 1, type: "studio.transcript.added", data: { sessionId: "s1" } },
      { id: 2, type: "studio.session.ops", data: op },
      { id: 3, type: "studio.session.ops", data: { ...op, seq: 13 } },
    ])} />);
    await waitFor(() => expect(m.session.mock.calls.length).toBe(reads + 1));
  });
});

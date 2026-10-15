// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { ChatView, LIST_SLOW_MS } from "./Chat";

/** What the panel's other calls read, all empty. */
const OTHER = { dialogs: [], forms: [], approvals: [], providers: [], now: 0, supported: true };
const daemon = { health: null, error: null, streaming: true, events: [], refresh: () => {} };

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Every call answers from `answer`, or never when it returns undefined. */
function stubFetch(answer: (url: string) => unknown) {
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    const body = answer(String(url));
    return body === undefined ? new Promise(() => {}) : Promise.resolve(new Response(JSON.stringify(body)));
  }));
}

describe("the session list", () => {
  it("says it is loading, not that there are no sessions, while Studio has not answered", async () => {
    vi.useFakeTimers();
    stubFetch((url) => (url.includes("/sessions") ? undefined : OTHER));
    render(<ChatView daemon={daemon} />);
    expect(screen.getByText("Loading sessions")).toBeTruthy();
    expect(screen.queryByText("No sessions yet.")).toBeNull();
    await act(async () => void vi.advanceTimersByTime(LIST_SLOW_MS + 1));
    expect(screen.getByText(/Studio is not answering yet/)).toBeTruthy();
  });

  it("says there are no sessions once the list comes back empty", async () => {
    stubFetch((url) => (url.includes("/sessions") ? { sessions: [] } : OTHER));
    render(<ChatView daemon={daemon} />);
    expect(await screen.findByText("No sessions yet.")).toBeTruthy();
    expect(screen.queryByText("Loading sessions")).toBeNull();
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { backToSessions, matches, SINGLE_PANE_CHAT, useMedia } from "./layout";

afterEach(() => vi.unstubAllGlobals());

describe("picking Chat from the menu", () => {
  it("goes back to the session list when the chat already shows one pane", () => {
    expect(backToSessions("Chat", "Chat", true)).toBe(true);
  });

  it("does nothing more than switch tabs otherwise", () => {
    expect(backToSessions("Chat", "Chat", false)).toBe(false);
    expect(backToSessions("Flows", "Chat", true)).toBe(false);
    expect(backToSessions("Chat", "Settings", true)).toBe(false);
  });
});

describe("media queries", () => {
  it("answers from matchMedia, and false where there is none", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === SINGLE_PANE_CHAT }));
    expect(matches(SINGLE_PANE_CHAT)).toBe(true);
    expect(matches("(max-width: 1px)")).toBe(false);
    vi.stubGlobal("matchMedia", undefined);
    expect(matches(SINGLE_PANE_CHAT)).toBe(false);
  });
});

describe("useMedia", () => {
  it("follows the query as the panel is resized", () => {
    let listener: (() => void) | null = null;
    const list = { matches: false, addEventListener: (_: string, f: () => void) => (listener = f), removeEventListener: () => (listener = null) };
    vi.stubGlobal("matchMedia", () => list);
    const { result, unmount } = renderHook(() => useMedia(SINGLE_PANE_CHAT));
    expect(result.current).toBe(false);
    list.matches = true;
    act(() => listener?.());
    expect(result.current).toBe(true);
    unmount();
    expect(listener).toBeNull();
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { matches, NARROW, useMedia } from "./layout";

afterEach(() => vi.unstubAllGlobals());

describe("media queries", () => {
  it("answers from matchMedia, and false where there is none", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === NARROW }));
    expect(matches(NARROW)).toBe(true);
    expect(matches("(max-width: 1px)")).toBe(false);
    vi.stubGlobal("matchMedia", undefined);
    expect(matches(NARROW)).toBe(false);
  });
});

describe("useMedia", () => {
  it("follows the query as the panel is resized", () => {
    let listener: (() => void) | null = null;
    const list = { matches: false, addEventListener: (_: string, f: () => void) => (listener = f), removeEventListener: () => (listener = null) };
    vi.stubGlobal("matchMedia", () => list);
    const { result, unmount } = renderHook(() => useMedia(NARROW));
    expect(result.current).toBe(false);
    list.matches = true;
    act(() => listener?.());
    expect(result.current).toBe(true);
    unmount();
    expect(listener).toBeNull();
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { SessionDetail } from "@ue-mcp-studio/shared";
import { pillsFor, type PillProvider } from "./pill-providers";
import { PillRow } from "./Pills";

afterEach(() => cleanup());

const session = (over: Partial<SessionDetail> = {}): SessionDetail => ({
  id: "s1", title: "t", status: "idle", createdAt: "", updatedAt: "", waitingCause: null, archived: false,
  agents: { total: 0, running: 0 }, awaiting: 0,
  transcript: [], touched: [], draft: "", seen: [], dismissed: [], queue: [], error: null, approvals: [],
  turn: { start: 4, mutations: 1, targets: [] },
  ...over,
} as SessionDetail);

describe("the pill row", () => {
  const go = vi.fn();
  const providers: PillProvider[] = [(s) => ({ id: `one:${s.turn?.start}`, label: "One", run: (a) => a.go!() }), () => ({ id: "other", label: "Other", run: () => {} })];

  it("renders nothing while no provider ships", () => {
    expect(pillsFor(session())).toEqual([]);
    const { container } = render(<PillRow pills={pillsFor(session())} actions={{}} onClear={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });

  it("shows one pill per provider that has one, and a click runs it and clears the row", () => {
    const onClear = vi.fn();
    render(<PillRow pills={pillsFor(session(), new Set(), providers)} actions={{ go }} onClear={onClear} />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["One", "Other"]);
    fireEvent.click(screen.getByRole("button", { name: "One" }));
    expect(go).toHaveBeenCalled();
    expect(onClear).toHaveBeenCalled();
  });

  it("leaves out a dismissed pill", () => {
    expect(pillsFor(session(), new Set(["one:4"]), providers).map((p) => p.id)).toEqual(["other"]);
  });

  it("clears on Escape, but not on an Escape something else took", () => {
    const onClear = vi.fn();
    render(<PillRow pills={pillsFor(session(), new Set(), providers)} actions={{}} onClear={onClear} />);
    const taken = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    taken.preventDefault();
    window.dispatchEvent(taken);
    expect(onClear).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});

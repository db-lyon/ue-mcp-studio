// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { SessionDetail, TurnFacts } from "@ue-mcp-studio/shared";
import { makePlaytestPill, pillsFor, type PillProvider } from "./pill-providers";
import { PillRow } from "./Pills";

afterEach(() => cleanup());

const turn = (over: Partial<TurnFacts> = {}): TurnFacts => ({ start: 4, mutations: 1, targets: [{ kind: "asset", path: "/Game/BP_Hero", saved: false }], playtest: false, ...over });
const session = (over: Partial<SessionDetail> = {}): SessionDetail => ({
  id: "s1", title: "t", status: "idle", createdAt: "", updatedAt: "", waitingCause: null, archived: false,
  agents: { total: 0, running: 0 }, awaiting: 0,
  transcript: [], touched: [], draft: "", seen: [], dismissed: [], queue: [], error: null, approvals: [],
  turn: turn(),
  ...over,
} as SessionDetail);

describe("the Make playtest pill", () => {
  it("shows after a finished turn that changed something, and runs the flow on that turn", () => {
    const pill = makePlaytestPill(session())!;
    expect(pill.label).toBe("Make playtest");
    const playtest = vi.fn();
    pill.run({ playtest });
    expect(playtest).toHaveBeenCalledWith({ text: "", turn: 4 });
  });

  it("does not show for a turn that changed nothing", () => {
    expect(makePlaytestPill(session({ turn: turn({ mutations: 0, targets: [] }) }))).toBeNull();
  });

  it("does not show for a turn that saved a playtest itself or ran the playtest flow", () => {
    expect(makePlaytestPill(session({ turn: turn({ playtest: true }) }))).toBeNull();
  });

  it("does not show while a turn runs or waits, or before any turn", () => {
    expect(makePlaytestPill(session({ status: "running" }))).toBeNull();
    expect(makePlaytestPill(session({ status: "waiting" }))).toBeNull();
    expect(makePlaytestPill(session({ turn: undefined }))).toBeNull();
  });

  it("reads only tool-call facts: an agent message that writes out a test plan makes no pill", () => {
    const prose = session({
      turn: turn({ mutations: 0, targets: [] }),
      transcript: [{ kind: "assistant", text: "Playtest:\n1. Press Space twice. PASS if the hero jumps again.", at: "" }],
    });
    expect(makePlaytestPill(prose)).toBeNull();
  });

  it("is a new pill for each turn, so a dismissed one stays gone only for its turn", () => {
    const first = makePlaytestPill(session())!;
    expect(pillsFor(session(), new Set([first.id]), [makePlaytestPill])).toEqual([]);
    expect(pillsFor(session({ turn: turn({ start: 9 }) }), new Set([first.id]), [makePlaytestPill]).map((p) => p.id)).toEqual(["make-playtest:9"]);
  });

  it("is hidden for now: no provider is on, so the row renders nothing", () => {
    expect(pillsFor(session())).toEqual([]);
    const { container } = render(<PillRow pills={pillsFor(session())} actions={{ playtest: vi.fn() }} onClear={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("the pill row", () => {
  const providers: PillProvider[] = [makePlaytestPill, () => ({ id: "other", label: "Other", run: () => {} })];

  it("shows one pill per provider that has one, and a click runs it and clears the row", () => {
    const playtest = vi.fn();
    const onClear = vi.fn();
    render(<PillRow pills={pillsFor(session(), new Set(), providers)} actions={{ playtest }} onClear={onClear} />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Make playtest", "Other"]);
    fireEvent.click(screen.getByRole("button", { name: "Make playtest" }));
    expect(playtest).toHaveBeenCalledWith({ text: "", turn: 4 });
    expect(onClear).toHaveBeenCalled();
  });

  it("clears on Escape, but not on an Escape something else took", () => {
    const onClear = vi.fn();
    render(<PillRow pills={pillsFor(session(), new Set(), providers)} actions={{ playtest: vi.fn() }} onClear={onClear} />);
    const taken = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    taken.preventDefault();
    window.dispatchEvent(taken);
    expect(onClear).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("renders nothing without pills", () => {
    const { container } = render(<PillRow pills={[]} actions={{ playtest: vi.fn() }} onClear={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });
});

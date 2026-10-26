// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { qaDraftFromScript, qaRunFromAnswer, type PlaytestEntry, type PlaytestIndexAnswer, type QaRun } from "@ue-mcp-studio/shared";

const m = vi.hoisted(() => ({
  qaPlaytests: vi.fn(),
  qaPlaytestCard: vi.fn(),
  qaRun: vi.fn(),
  qaAssign: vi.fn(),
  qaPlaytestScript: vi.fn(),
  qaPlaytestSave: vi.fn(),
  qaPlaytestDelete: vi.fn(),
  qaStatus: vi.fn(() => new Promise(() => {})),
  qaResultsUrl: (id: string) => `/r/${id}`,
}));
vi.mock("../api", () => ({ api: m }));
import { PlaytestsView, ranAgo, usePlaytestIndex } from "./Playtests";
import type { DaemonState } from "../state";

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const NOW = Date.now();
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const run = (id: string, name: string, state: string, statuses: string[], sessionId: string | null, seenAt: string): QaRun =>
  qaRunFromAnswer({
    success: true, run_id: id, script: `/Game/T/${name}`, script_name: name, state, results_path: null,
    steps: statuses.map((status, index) => ({ index, instruction: `${name} ${index + 1}`, judge: index === statuses.length - 1 ? "manual" : "auto", status })),
    awaiting: statuses.flatMap((s, i) => (s === "awaiting_verdict" ? [i] : [])), last_seq: 1,
  }, { sessionId, seenAt })!;
const draftOf = (name: string, sessionId: string | null) => qaDraftFromScript({ path: `/Game/T/${name}`, name, steps: [{ instruction: "Look", judge: "manual" }, { instruction: "Move", judge: "auto" }] }, { sessionId, seenAt: ago(1) })!;

const waiting = run("w1", "Door", "awaiting_verdict", ["passed", "awaiting_verdict"], "s1", ago(3));
const failing = run("f1", "Jump", "finished", ["failed", "passed"], null, ago(120));
const passing = run("p1", "Walk", "finished", ["passed", "passed"], "s2", ago(60 * 30));
const ENTRIES: PlaytestEntry[] = [
  { script: "/Game/T/Door", name: "Door", last: waiting, card: waiting, draft: null, session: { id: "s1", title: "Doors" } },
  { script: "/Game/T/Jump", name: "Jump", last: failing, card: null, draft: null, session: null },
  { script: "/Game/T/Walk", name: "Walk", last: passing, card: passing, draft: null, session: { id: "s2", title: "Walking" } },
  { script: "/Game/T/Fresh", name: "Fresh", last: null, card: null, draft: draftOf("Fresh", null), session: null },
];
const daemon = { events: [], streaming: true } as unknown as DaemonState;

function page(answer: PlaytestIndexAnswer = { playtests: ENTRIES, listed: true }, onOpenSession = vi.fn()) {
  const reload = vi.fn();
  render(<PlaytestsView daemon={daemon} index={{ index: answer, error: null, reload }} onOpenSession={onOpenSession} />);
  return { reload, onOpenSession };
}
const rows = () => screen.queryAllByRole("group", { name: /^Playtest / }).map((g) => g.getAttribute("aria-label"));
const row = (name: string) => screen.getByRole("group", { name: `Playtest ${name}` });

describe("the Playtests page", () => {
  it("opens on what needs the user when something does, with each filter's count", () => {
    page();
    expect(screen.getByRole("button", { name: "Needs you 1", pressed: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Failing 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "All 4" })).toBeTruthy();
    expect(rows()).toEqual(["Playtest Door"]);
    // The verdict is right there.
    expect(within(row("Door")).getByRole("button", { name: "Pass step 2" })).toBeTruthy();
  });

  it("filters to failing and to all, and remembers the pick", () => {
    page();
    fireEvent.click(screen.getByRole("button", { name: "Failing 1" }));
    expect(rows()).toEqual(["Playtest Jump"]);
    fireEvent.click(screen.getByRole("button", { name: "All 4" }));
    expect(rows()).toEqual(["Playtest Door", "Playtest Jump", "Playtest Walk", "Playtest Fresh"]);
    cleanup();
    page();
    expect(screen.getByRole("button", { name: "All 4", pressed: true })).toBeTruthy();
  });

  it("shows each row's last run as its step path, when it ran and in which session", () => {
    page();
    fireEvent.click(screen.getByRole("button", { name: "All 4" }));
    const meta = (name: string) => row(name).querySelector(".qa-meta")?.textContent;
    expect(meta("Door")).toBe("Started 3 minutes ago in Doors↗");
    expect(row("Door").querySelector(".qa-meta-session")?.getAttribute("title")).toBe("Open the card in Doors");
    expect(meta("Jump")).toBe("Ran 2 hours ago outside Studio");
    expect(meta("Walk")).toMatch(/^Ran .* in Walking↗$/);
    expect(meta("Fresh")).toBe("Never run");
    expect(within(row("Jump")).getAllByRole("listitem").map((li) => li.className.split(" ")[1])).toEqual(["bad", "ok"]);
  });

  it("starts a script no session has in a card of its own, in one click", async () => {
    const card = draftOf("Fresh", "s9");
    m.qaPlaytestCard.mockResolvedValue({ run: card });
    m.qaRun.mockResolvedValue({ run: run("r9", "Fresh", "armed", ["pending", "pending"], "s9", ago(0)) });
    const { reload } = page();
    fireEvent.click(screen.getByRole("button", { name: "All 4" }));
    await act(async () => {
      fireEvent.click(within(row("Fresh")).getByRole("button", { name: "Start playtest" }));
    });
    expect(m.qaPlaytestCard).toHaveBeenCalledWith("/Game/T/Fresh");
    expect(m.qaRun).toHaveBeenCalledWith(card.runId, { startPie: true, players: 1, listen: false, record: true });
    expect(reload).toHaveBeenCalled();
    expect(within(row("Fresh")).getAllByRole("status")[0].textContent).toBe("Starting");
  });

  it("runs a finished playtest again from its card in its session", async () => {
    m.qaRun.mockResolvedValue({ run: run("p2", "Walk", "armed", ["pending", "pending"], "s2", ago(0)) });
    page();
    fireEvent.click(screen.getByRole("button", { name: "All 4" }));
    await act(async () => {
      fireEvent.click(within(row("Walk")).getByRole("button", { name: "Run again" }));
    });
    expect(m.qaPlaytestCard).not.toHaveBeenCalled();
    expect(m.qaRun).toHaveBeenCalledWith("p1", expect.objectContaining({ startPie: true }));
  });

  it("assigns a failing playtest started outside Studio to a subagent, through a card of its own", async () => {
    const card = draftOf("Jump", "s9");
    m.qaPlaytestCard.mockResolvedValue({ run: card });
    m.qaAssign.mockResolvedValue({ run: { ...card, assignment: { callId: "", sessionId: "s9", state: "running", at: ago(0) } } });
    page();
    fireEvent.click(screen.getByRole("button", { name: "Failing 1" }));
    await act(async () => {
      fireEvent.click(within(row("Jump")).getByRole("button", { name: "Assign to subagent" }));
    });
    expect(m.qaAssign).toHaveBeenCalledWith(card.runId, null);
  });

  it("opens a playtest's card in its session from the session's name", () => {
    const { onOpenSession } = page();
    fireEvent.click(within(row("Door")).getByRole("button", { name: "Doors" }));
    expect(onOpenSession).toHaveBeenCalledWith("s1", "w1");
    fireEvent.click(screen.getByRole("button", { name: "Failing 1" }));
    // Run outside Studio, it has no session to open.
    expect(within(row("Jump")).queryByRole("button", { name: /↗|session/ })).toBeNull();
  });

  it("opens the full card in place from a step's bar", () => {
    page();
    fireEvent.click(screen.getByRole("button", { name: "All 4" }));
    fireEvent.click(within(row("Jump")).getByRole("button", { name: "Step 1, observer, Failed" }));
    expect(within(row("Jump")).getByText("Jump 1")).toBeTruthy();
  });

  it("says what each empty filter means, and when the editor could not list scripts", () => {
    page({ playtests: [ENTRIES[2]], listed: false });
    expect(screen.getByText(/scripts that have never run are missing/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Needs you 0" }));
    expect(screen.getByText(/Nothing needs you/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Failing 0" }));
    expect(screen.getByText(/No playtest is failing/)).toBeTruthy();
  });

  it("keeps every row's actions in one place, the end of the row under its path, in one order", () => {
    page();
    fireEvent.click(screen.getByRole("button", { name: "All 4" }));
    for (const name of ["Door", "Jump", "Walk", "Fresh"]) {
      const card = row(name);
      expect(card.querySelector(".qa-head button.small-button")).toBeNull();
      expect(card.querySelector(".qa-compact .qa-box-actions")).toBeTruthy();
    }
    const order = (name: string) => [...row(name).querySelectorAll(".qa-box-actions button")].map((b) => b.textContent);
    expect(order("Walk")[0]).toBe("Run again");
    expect(order("Jump")).toContain("Assign to subagent");
  });

  it("says its states are the last known while the editor is away, at full strength", () => {
    page({ playtests: [ENTRIES[0]], listed: false });
    const card = row("Door");
    expect(card.querySelector(".qa-compact-summary")!.textContent).toMatch(/^Last known: /);
    // What it last did, in neutral words: nothing on the page reads as live.
    expect(within(card).getByRole("status").textContent).toBe("Was waiting");
    expect((within(card).getByRole("button", { name: "Pass step 2" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("names only the marks the shown paths carry", () => {
    page();
    const legend = screen.getByRole("group", { name: "What the step marks mean" });
    expect(legend.textContent).toContain("Passed");
    expect(legend.textContent).not.toContain("Not run");
    expect(legend.textContent).toContain("Judged by a person");
  });

  it("with no playtests at all, says how to make one and goes to Chat", () => {
    const onChat = vi.fn();
    render(<PlaytestsView daemon={daemon} index={{ index: { playtests: [], listed: true }, error: null, reload: vi.fn() }} onOpenSession={vi.fn()} onChat={onChat} />);
    expect(screen.getByText("No playtests yet")).toBeTruthy();
    expect(screen.getByText("/playtest").tagName).toBe("CODE");
    fireEvent.click(screen.getByRole("button", { name: "Go to Chat" }));
    expect(onChat).toHaveBeenCalled();
  });

  it("offers no Start playtest on a script that is gone", () => {
    page({ playtests: [{ ...ENTRIES[2], deleted: true }], listed: true });
    expect(within(row("Walk")).queryByRole("button", { name: "Run again" })).toBeNull();
    expect(row("Walk").querySelector(".qa-meta")?.textContent).toMatch(/^Script deleted. Ran /);
  });
});

describe("Edit and Delete on the page", () => {
  const openCard = (name: string) => {
    fireEvent.click(screen.getByRole("button", { name: /^All / }));
    fireEvent.click(within(row(name)).getByRole("button", { name: `Open playtest ${name}` }));
  };

  it("shows Edit and Delete on a collapsed card, in the same row as its other actions", () => {
    page();
    fireEvent.click(screen.getByRole("button", { name: /^All / }));
    const line = row("Jump").querySelector(".qa-compact-line")!;
    expect(within(line as HTMLElement).getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(within(line as HTMLElement).getByRole("button", { name: "Delete" })).toBeTruthy();
    expect(row("Jump").querySelector(".qa-answer .qa-box-actions")).toBeNull();
  });

  it("edits a script no session has in the session's step editor, read as saved", async () => {
    m.qaPlaytestScript.mockResolvedValue({ run: draftOf("Jump", null) });
    m.qaPlaytestSave.mockResolvedValue({ script: "/Game/T/Jump" });
    const { reload } = page();
    openCard("Jump");
    await act(async () => {
      fireEvent.click(within(row("Jump")).getByRole("button", { name: "Edit" }));
    });
    expect(m.qaPlaytestScript).toHaveBeenCalledWith("/Game/T/Jump");
    const first = within(row("Jump")).getByRole("textbox", { name: "Step 1 instruction" }) as HTMLInputElement;
    expect(first.value).toBe("Look");
    fireEvent.change(first, { target: { value: "Look up" } });
    await act(async () => {
      fireEvent.click(within(row("Jump")).getByRole("button", { name: "Save" }));
    });
    expect(m.qaPlaytestSave).toHaveBeenCalledWith("/Game/T/Jump", [expect.objectContaining({ instruction: "Look up", judge: "manual" }), expect.objectContaining({ instruction: "Move", judge: "auto" })]);
    expect(reload).toHaveBeenCalled();
    expect(within(row("Jump")).queryByRole("textbox", { name: "Step 1 instruction" })).toBeNull();
  });

  it("deletes a script only on the second click, then reads the list again", async () => {
    m.qaPlaytestDelete.mockResolvedValue({ script: "/Game/T/Walk" });
    const { reload } = page();
    openCard("Walk");
    fireEvent.click(within(row("Walk")).getByRole("button", { name: "Delete" }));
    expect(m.qaPlaytestDelete).not.toHaveBeenCalled();
    expect(within(row("Walk")).getByText(/Deleting removes the script asset/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(row("Walk")).getByRole("button", { name: "Delete the script" }));
    });
    expect(m.qaPlaytestDelete).toHaveBeenCalledWith("/Game/T/Walk");
    expect(reload).toHaveBeenCalled();
  });

  it("says why the script cannot be read", async () => {
    m.qaPlaytestScript.mockRejectedValue(new Error("the editor is not connected, so the script cannot be read"));
    page();
    openCard("Fresh");
    await act(async () => {
      fireEvent.click(within(row("Fresh")).getByRole("button", { name: "Edit" }));
    });
    expect(within(row("Fresh")).getByText(/cannot be read/)).toBeTruthy();
    expect(within(row("Fresh")).queryByRole("textbox", { name: "Step 1 instruction" })).toBeNull();
  });

  it("draws them disabled while the editor is away, and not at all on a script that is gone", () => {
    page({ playtests: [ENTRIES[1], { ...ENTRIES[2], deleted: true }], listed: false });
    openCard("Jump");
    const edit = within(row("Jump")).getByRole("button", { name: "Edit" }) as HTMLButtonElement;
    expect(edit.disabled).toBe(true);
    expect(edit.title).toBe("The editor is not connected");
    fireEvent.click(within(row("Walk")).getByRole("button", { name: "Open playtest Walk" }));
    expect(within(row("Walk")).queryByRole("button", { name: "Edit" })).toBeNull();
    expect(within(row("Walk")).queryByRole("button", { name: "Delete" })).toBeNull();
  });
});

describe("the page's list", () => {
  it("is read when the stream is up, fresh, and again once runs stop changing", async () => {
    vi.useFakeTimers();
    m.qaPlaytests.mockResolvedValue({ playtests: [], listed: true });
    const Probe = ({ events }: { events: DaemonState["events"] }) => {
      usePlaytestIndex({ events, streaming: true });
      return null;
    };
    const view = render(<Probe events={[]} />);
    expect(m.qaPlaytests).toHaveBeenCalledWith(true);
    view.rerender(<Probe events={[{ id: 1, type: "studio.qa.changed", at: "", data: {} }]} />);
    view.rerender(<Probe events={[{ id: 1, type: "studio.qa.changed", at: "", data: {} }, { id: 2, type: "studio.qa.changed", at: "", data: {} }]} />);
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(m.qaPlaytests).toHaveBeenCalledTimes(2);
    expect(m.qaPlaytests).toHaveBeenLastCalledWith(false);
    vi.useRealTimers();
  });

  it("says when a run happened in words", () => {
    const now = Date.parse("2026-10-25T12:00:00.000Z");
    expect(ranAgo("2026-10-25T11:59:40.000Z", now)).toBe("just now");
    expect(ranAgo("2026-10-25T11:55:00.000Z", now)).toBe("5 minutes ago");
    expect(ranAgo("2026-10-25T09:00:00.000Z", now)).toBe("3 hours ago");
    expect(ranAgo("2026-10-24T10:00:00.000Z", now)).toBe("yesterday");
    expect(ranAgo("2026-10-20T12:00:00.000Z", now)).toBe("5 days ago");
  });
});

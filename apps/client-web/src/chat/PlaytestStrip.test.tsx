// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { DaemonEvent } from "ue-mcp/daemon";
import { qaRunFromAnswer, type QaLoop, type QaRun, type TranscriptEntry } from "@ue-mcp-studio/shared";

const apiCalls = vi.hoisted(() => [] as Array<{ name: string; args: unknown[] }>);
vi.mock("../api", () => ({
  api: new Proxy({}, {
    get: (_t, name) => (...args: unknown[]) => {
      apiCalls.push({ name: String(name), args });
      return new Promise(() => {});
    },
  }),
}));
import { ENDED_GRACE_MS, PinnedContext, PlaytestStrip, TranscriptPlaytest, stripSummary, usePinned, useSessionRuns } from "./PlaytestStrip";

const realMatchMedia = window.matchMedia;
beforeEach(() => {
  window.localStorage.clear();
  apiCalls.length = 0;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.matchMedia = realMatchMedia;
});
/** The panel at 380 px: every max-width query matches. */
const narrow = () => {
  window.matchMedia = ((query: string) => ({ matches: query.includes("max-width"), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
};

const at = "2026-10-25T15:00:00.000Z";
const run = (id: string, name: string, state: string, statuses: string[], over: Partial<QaRun> = {}): QaRun => ({
  ...qaRunFromAnswer({
    success: true, run_id: id, script: `/Game/S/${name}`, script_name: name, state, results_path: null,
    steps: statuses.map((status, index) => ({ index, instruction: `${name} step ${index + 1}`, judge: index === statuses.length - 1 ? "manual" : "auto", status })),
    awaiting: statuses.flatMap((s, i) => (s === "awaiting_verdict" ? [i] : [])), last_seq: 1,
  }, { sessionId: "s1", seenAt: at })!,
  ...over,
});
const loop = (state: QaLoop["state"]): QaLoop => ({ id: `loop-${state}`, state, attempts: [], baseline: "c0", budget: { minutes: 60, tokens: 1000 }, tokens: 0, startedAt: at, ...(state === "needs_you" ? { blocker: { kind: "no_progress", reason: "Nothing changed", evidence: [] } } : {}) });
const entries = (...runs: QaRun[]): TranscriptEntry[] => runs.map((r) => ({ kind: "qa", run: r }));
let nextId = 1;
const changed = (r: QaRun, replaces?: string): DaemonEvent => ({ id: nextId++, type: "studio.qa.changed", at, data: { runId: r.runId, run: r as unknown as Record<string, unknown>, ...(replaces ? { replaces } : {}) } });

/** The chat's wiring: the strip over the transcript's entries. */
function Session({ transcript, events, grouped = false }: { transcript: TranscriptEntry[]; events: DaemonEvent[]; grouped?: boolean }) {
  const runs = useSessionRuns("s1", transcript, events);
  const strip = usePinned(runs.runs, runs.alias);
  return (
    <PinnedContext.Provider value={strip.ids}>
      <PlaytestStrip runs={strip.pinned} onHide={strip.hide} />
      <div data-testid="transcript">{transcript.map((t, i) => (t.kind === "qa" ? <TranscriptPlaytest key={i} run={t.run} {...(grouped ? { transcript, at: i } : {})} /> : null))}</div>
    </PinnedContext.Provider>
  );
}
const stripEl = () => screen.queryByRole("region", { name: "Live playtests" });
const transcriptEl = () => screen.getByTestId("transcript");

describe("the strip of live playtests", () => {
  it("is absent while nothing is live, and the transcript shows every card", () => {
    render(<Session transcript={entries(run("a", "Done", "finished", ["passed", "passed"]), { ...run("d", "Draft", "draft", ["pending"]), state: "draft" })} events={[]} />);
    expect(stripEl()).toBeNull();
    expect(within(transcriptEl()).getAllByRole("group", { name: /^Playtest / }).map((g) => g.getAttribute("aria-label"))).toEqual(["Playtest Done", "Playtest Draft"]);
  });

  it("pins a running playtest as a live card, and its transcript copy gives way to one line", () => {
    render(<Session transcript={entries(run("a", "Jump", "running", ["running", "pending"]))} events={[]} />);
    expect(within(stripEl()!).getByRole("group", { name: "Playtest Jump" })).toBeTruthy();
    expect(within(stripEl()!).queryByRole("button", { expanded: true, name: /Live/ })).toBeNull();
    expect(within(transcriptEl()).queryByRole("group", { name: "Playtest Jump" })).toBeNull();
    expect(within(transcriptEl()).getByRole("note").textContent).toContain("Jump is running on the strip above");
    expect(document.querySelectorAll("[data-run-id='a']")).toHaveLength(1);
  });

  it("takes a verdict right on the strip", () => {
    render(<Session transcript={entries(run("a", "Door", "awaiting_verdict", ["passed", "awaiting_verdict"]))} events={[]} />);
    const ask = within(stripEl()!).getByRole("group", { name: "Step 2 needs you" });
    // The card's Stop sits in the same box, after the verdicts.
    expect(within(ask).getAllByRole("button").map((b) => b.textContent)).toEqual(["Pass", "Fail", "Skip", "Stop"]);
    expect(stripEl()!.className).toContain("needs-you");
  });

  it("with several, sums them up first, needs-you first, and folds away", () => {
    const transcript = entries(
      run("a", "Running", "running", ["running", "pending"]),
      run("b", "Waiting", "awaiting_verdict", ["passed", "awaiting_verdict"]),
      run("c", "Looping", "finished", ["failed", "pending"], { assignment: { callId: "x", sessionId: "s1", state: "running", at, loop: loop("running") } }),
    );
    render(<Session transcript={transcript} events={[]} />);
    const head = within(stripEl()!).getByRole("button", { expanded: true });
    expect(head.textContent).toContain("3 playtests: 1 needs you, 2 running");
    // Two cards, then the rest behind one button that names them.
    expect(within(stripEl()!).getAllByRole("group", { name: /^Playtest / }).map((g) => g.getAttribute("aria-label"))).toEqual(["Playtest Waiting", "Playtest Running"]);
    fireEvent.click(within(stripEl()!).getByRole("button", { name: "Show 1 more: Looping" }));
    expect(within(stripEl()!).getAllByRole("group", { name: /^Playtest / }).map((g) => g.getAttribute("aria-label"))).toEqual(["Playtest Waiting", "Playtest Running", "Playtest Looping"]);
    fireEvent.click(head);
    expect(within(stripEl()!).queryAllByRole("group", { name: /^Playtest / })).toHaveLength(0);
    expect(within(stripEl()!).getByRole("button", { expanded: false })).toBeTruthy();
  });

  it("follows the stream: a run that ends stays a moment, then leaves and its card comes back to the transcript", () => {
    vi.useFakeTimers();
    const start = run("a", "Jump", "running", ["running", "pending"]);
    const transcript = entries(start);
    const view = render(<Session transcript={transcript} events={[]} />);
    expect(stripEl()).toBeTruthy();
    const done = { ...run("a", "Jump", "finished", ["passed", "passed"]), lastSeq: 9 };
    view.rerender(<Session transcript={transcript} events={[changed(done)]} />);
    expect(within(stripEl()!).getByRole("group", { name: "Playtest Jump" })).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(ENDED_GRACE_MS + 10);
    });
    expect(stripEl()).toBeNull();
    expect(within(transcriptEl()).getByRole("group", { name: "Playtest Jump" })).toBeTruthy();
  });

  it("pins a draft's run when it takes the draft's card, and the draft's line in the transcript points at it", () => {
    const d = { ...run("draft:/Game/S/Jump", "Jump", "draft", ["pending", "pending"]), state: "draft" as const };
    const transcript = entries(d);
    const view = render(<Session transcript={transcript} events={[]} />);
    expect(stripEl()).toBeNull();
    const live = run("r1", "Jump", "running", ["running", "pending"]);
    view.rerender(<Session transcript={transcript} events={[changed(live, d.runId)]} />);
    expect(within(stripEl()!).getByRole("group", { name: "Playtest Jump" }).getAttribute("data-run-id")).toBe("r1");
    expect(within(transcriptEl()).getByRole("note")).toBeTruthy();
  });

  it("ignores events the transcript already holds", () => {
    const old = run("a", "Jump", "running", ["running", "pending"]);
    const events = [changed(old)];
    // Read after that event: the transcript says it finished.
    render(<Session transcript={entries(run("a", "Jump", "finished", ["passed", "passed"]))} events={events} />);
    expect(stripEl()).toBeNull();
  });

  it("keeps a loop that needs the user until the user hides it, for this viewer", () => {
    const r = run("a", "Gate", "finished", ["failed", "passed"], { assignment: { callId: "x", sessionId: "s1", state: "done", at, loop: loop("needs_you") } });
    const view = render(<Session transcript={entries(r)} events={[]} />);
    expect(within(stripEl()!).getByText("Nothing changed")).toBeTruthy();
    fireEvent.click(within(stripEl()!).getByRole("button", { name: "Hide Gate from the strip" }));
    expect(stripEl()).toBeNull();
    expect(within(transcriptEl()).getByRole("group", { name: "Playtest Gate" })).toBeTruthy();
    view.unmount();
    render(<Session transcript={entries(r)} events={[]} />);
    expect(stripEl()).toBeNull();
  });

  it("never hides a step that waits for a verdict", () => {
    render(<Session transcript={entries(run("a", "Door", "awaiting_verdict", ["passed", "awaiting_verdict"]))} events={[]} />);
    expect(within(stripEl()!).queryByRole("button", { name: /Hide/ })).toBeNull();
  });

  it("brings a card past the first ones into view from its line in the transcript", async () => {
    const transcript = entries(
      run("a", "Running", "running", ["running", "pending"]),
      run("b", "Waiting", "awaiting_verdict", ["passed", "awaiting_verdict"]),
      run("c", "Third", "running", ["running", "pending"]),
    );
    render(<Session transcript={transcript} events={[]} />);
    expect(within(stripEl()!).queryByRole("group", { name: "Playtest Third" })).toBeNull();
    const line = within(transcriptEl()).getAllByRole("note").find((n) => n.textContent?.includes("Third"))!;
    await act(async () => {
      fireEvent.click(within(line).getByRole("button", { name: "Show it" }));
    });
    expect(within(stripEl()!).getByRole("group", { name: "Playtest Third" })).toBeTruthy();
    expect(within(transcriptEl()).getAllByRole("note").find((n) => n.textContent?.includes("Waiting"))!.textContent).toContain("Waiting needs you on the strip above");
  });

  it("never folds away one that needs the user", () => {
    const transcript = entries(
      run("a", "Running", "running", ["running", "pending"]),
      run("b", "WaitA", "awaiting_verdict", ["passed", "awaiting_verdict"]),
      run("c", "WaitB", "awaiting_verdict", ["passed", "awaiting_verdict"]),
      run("d", "WaitC", "awaiting_verdict", ["passed", "awaiting_verdict"]),
    );
    render(<Session transcript={transcript} events={[]} />);
    expect(within(stripEl()!).getAllByRole("group", { name: /^Playtest / }).map((g) => g.getAttribute("aria-label"))).toEqual(["Playtest WaitA", "Playtest WaitB", "Playtest WaitC"]);
    expect(within(stripEl()!).getByRole("button", { name: "Show 1 more: Running" }).textContent).toContain("Running (running)");
  });

  it("shows every one that needs the user at 380 px too, naming only the rest", () => {
    narrow();
    const transcript = entries(
      run("a", "Running", "running", ["running", "pending"]),
      run("b", "WaitA", "awaiting_verdict", ["passed", "awaiting_verdict"]),
      run("c", "Gate", "finished", ["failed", "passed"], { assignment: { callId: "x", sessionId: "s1", state: "done", at, loop: loop("needs_you") } }),
    );
    render(<Session transcript={transcript} events={[]} />);
    expect(within(stripEl()!).getAllByRole("group", { name: /^Playtest / }).map((g) => g.getAttribute("aria-label"))).toEqual(["Playtest WaitA", "Playtest Gate"]);
    expect(within(stripEl()!).getByRole("button", { name: "Show 1 more: Running" })).toBeTruthy();
  });

  it("at 380 px with none that needs the user, shows one card and names the rest", () => {
    narrow();
    render(<Session transcript={entries(run("a", "One", "running", ["running", "pending"]), run("b", "Two", "running", ["running", "pending"]))} events={[]} />);
    expect(within(stripEl()!).getAllByRole("group", { name: /^Playtest / })).toHaveLength(1);
    expect(within(stripEl()!).getByRole("button", { name: "Show 1 more: Two" })).toBeTruthy();
  });

  it("offers Review, Cancel loop and Hide from strip on a loop that needs the user", () => {
    const r = run("a", "Gate", "finished", ["failed", "passed"], { assignment: { callId: "x", sessionId: "s1", state: "done", at, loop: loop("needs_you") } });
    render(<Session transcript={entries(r)} events={[]} />);
    const box = within(stripEl()!).getByRole("group", { name: "The loop needs you" });
    expect(within(box).getAllByRole("button").map((b) => b.textContent)).toEqual(["Review", "Cancel loop", "Hide from strip"]);
    fireEvent.click(within(box).getByRole("button", { name: "Cancel loop" }));
    expect(apiCalls.find((c) => c.name === "qaCancelAssign")?.args).toEqual(["a"]);
  });

  it("holds the place of the verdict buttons with the step a card is on", () => {
    render(<Session transcript={entries(run("a", "Jump", "running", ["running", "pending"]))} events={[]} />);
    const now = within(stripEl()!).getByRole("status", { name: "Checking: Jump step 1" });
    const box = now.closest(".qa-now") as HTMLElement;
    expect(box.textContent).toContain("Checking");
    expect(within(box).getByRole("button", { name: "Stop playtest Jump" })).toBeTruthy();
  });

  it("says how many steps of an open card on the strip are scrolled out of view, above and below", () => {
    // jsdom lays nothing out: the card's steps are 60 px each in a 100 px window.
    const geometry = (el: HTMLElement, key: string): number => {
      if (el.classList.contains("qa-body")) return ({ clientHeight: 100, scrollHeight: 300 } as Record<string, number>)[key] ?? 0;
      if (el.classList.contains("qa-step")) return key === "offsetTop" ? Number(el.dataset.index) * 60 : key === "offsetHeight" ? 60 : 0;
      return 0;
    };
    const props = ["clientHeight", "scrollHeight", "offsetTop", "offsetHeight"] as const;
    const saved = props.map((k) => [k, Object.getOwnPropertyDescriptor(HTMLElement.prototype, k)] as const);
    for (const k of props) Object.defineProperty(HTMLElement.prototype, k, { configurable: true, get(this: HTMLElement) { return geometry(this, k); } });
    try {
      render(<Session transcript={entries(run("a", "Door", "awaiting_verdict", ["passed", "passed", "passed", "passed", "awaiting_verdict"]))} events={[]} />);
      fireEvent.click(within(stripEl()!).getByRole("button", { name: /PT|Door/, expanded: false }));
      expect(within(stripEl()!).getByRole("button", { name: /4 steps below/ })).toBeTruthy();
      expect(within(stripEl()!).queryByRole("button", { name: /above/ })).toBeNull();
      const body = stripEl()!.querySelector<HTMLElement>(".qa-body")!;
      body.scrollTop = 130;
      act(() => {
        body.dispatchEvent(new Event("scroll"));
      });
      expect(within(stripEl()!).getByRole("button", { name: /3 steps above/ })).toBeTruthy();
      expect(within(stripEl()!).getByRole("button", { name: /2 steps below/ })).toBeTruthy();
    } finally {
      for (const [k, d] of saved) {
        if (d) Object.defineProperty(HTMLElement.prototype, k, d);
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k];
      }
    }
  });

  it("gives playtests side by side in the transcript one line that names each", () => {
    const transcript = entries(
      run("a", "Running", "running", ["running", "pending"]),
      run("b", "Waiting", "awaiting_verdict", ["passed", "awaiting_verdict"]),
      run("c", "Done", "finished", ["passed", "passed"]),
      run("d", "Later", "running", ["running", "pending"]),
    );
    render(<Session transcript={transcript} events={[]} grouped />);
    const notes = within(transcriptEl()).getAllByRole("note");
    expect(notes.map((n) => n.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      // In the strip's order: what needs the user first.
      "↑ 2 playtests are on the strip above: Waiting needs you, Running running.Show them",
      "↑ Playtest Later is running on the strip above.Show it",
    ]);
    // The finished one between them is a full card.
    expect(within(transcriptEl()).getByRole("group", { name: "Playtest Done" })).toBeTruthy();
  });

  it("keeps a card's buttons where they were when it is opened on the strip, adding only detail", () => {
    render(<Session transcript={entries(run("a", "Door", "awaiting_verdict", ["passed", "awaiting_verdict"]))} events={[]} />);
    const buttons = () => within(within(stripEl()!).getByRole("group", { name: "Step 2 needs you" })).getAllByRole("button").map((b) => b.textContent);
    expect(buttons()).toEqual(["Pass", "Fail", "Skip", "Stop"]);
    fireEvent.click(within(stripEl()!).getByRole("button", { name: /Door/, expanded: false }));
    expect(buttons()).toEqual(["Pass", "Fail", "Skip", "Stop"]);
    // The verdict is asked once, in the box; the head carries no buttons.
    expect(within(stripEl()!).getAllByRole("button", { name: "Pass step 2" })).toHaveLength(1);
    expect(stripEl()!.querySelector(".qa-head .qa-actions")).toBeNull();
  });

  it("sums up in words", () => {
    expect(stripSummary([run("a", "A", "running", ["running"]), run("b", "B", "awaiting_verdict", ["awaiting_verdict"])])).toBe("2 playtests: 1 needs you, 1 running");
    expect(stripSummary([run("a", "A", "awaiting_verdict", ["awaiting_verdict"]), run("b", "B", "awaiting_verdict", ["awaiting_verdict"])])).toBe("2 playtests: 2 need you");
  });
});

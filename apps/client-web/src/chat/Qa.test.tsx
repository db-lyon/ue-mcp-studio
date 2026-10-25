// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { openCard } from "./qa-test-helpers";
import type { DaemonEvent } from "ue-mcp/daemon";
import { qaRunFromAnswer, type PendingForm, type QaRun } from "@ue-mcp-studio/shared";

const m = vi.hoisted(() => ({
  qaVerdict: vi.fn(),
  qaStatus: vi.fn(),
  qaAssign: vi.fn(),
  qaCancelAssign: vi.fn(),
  qaStop: vi.fn(),
  qaRun: vi.fn(),
  answerForm: vi.fn(async () => {}),
  qaResultsUrl: (id: string) => `/v1/ext/studio/qa/runs/${id}/results`,
}));
vi.mock("../api", () => ({ api: m }));
import { QaCard, QaContext, type QaLive } from "./Qa";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const RUN = "script_DoorOpens_20261023_100000";
const RESULTS = `C:/MyGame/Saved/MCPObservations/${RUN}/results.json`;
const STEPS = [
  { index: 0, instruction: "Walk up to the door", judge: "auto", expect: { value: "Door.Distance", op: "decreasing", within_ms: 3000 }, status: "pending", within_ms: 3000 },
  { index: 1, instruction: "Open the door", judge: "auto", expect: { value: "Door.OpenAngle", op: "gt", target: 80 }, status: "pending", within_ms: 5000 },
  { index: 2, instruction: "The door opens without a visible pop", judge: "manual", status: "pending", within_ms: 5000 },
];
const answer = (over: Record<string, unknown> = {}) => ({ success: true, run_id: RUN, script: "/Game/PIEStudio/Scripts/DoorOpens", script_name: "DoorOpens", state: "armed", results_path: RESULTS, steps: STEPS, awaiting: [], last_seq: 1, ...over });
const runOf = (over: Record<string, unknown> = {}): QaRun => qaRunFromAnswer(answer(over), { sessionId: "s1", seenAt: "2026-10-23T15:00:00.000Z" })!;

let nextId = 1;
const ev = (type: string, data: Record<string, unknown>): DaemonEvent => ({ id: nextId++, type, at: "2026-10-23T15:00:00.000Z", data: { runId: RUN, script: "/Game/PIEStudio/Scripts/DoorOpens", ...data } });

/** The card in a page whose stream can be fed and dropped. */
function mount(run: QaRun, live: Partial<QaLive> = {}) {
  const value: QaLive = { events: [], streaming: true, forms: [], ...live };
  const ui = (v: QaLive) => (
    <QaContext.Provider value={v}>
      <QaCard run={run} />
    </QaContext.Provider>
  );
  const r = render(ui(value));
  openCard(r.container);
  let cur = value;
  const update = (next: Partial<QaLive>) => {
    cur = { ...cur, ...next };
    r.rerender(ui(cur));
  };
  return { ...r, update, push: (...e: DaemonEvent[]) => update({ events: [...cur.events, ...e] }) };
}

const step = (n: number) => screen.getAllByRole("listitem")[n];

describe("the checklist card", () => {
  it("is titled Playtest and lists each step's instruction, judge and status", () => {
    mount(runOf());
    expect(screen.getByText("DoorOpens")).toBeTruthy();
    expect(screen.getByText("Playtest")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Playtest DoorOpens" })).toBeTruthy();
    expect(step(0).textContent).toContain("Walk up to the door");
    expect(within(step(0)).getByText("auto")).toBeTruthy();
    expect(within(step(2)).getByText("manual")).toBeTruthy();
    expect(screen.getAllByRole("listitem").map((li) => li.getAttribute("data-status"))).toEqual(["pending", "pending", "pending"]);
    expect(within(step(0)).getByText("Pending")).toBeTruthy();
    expect(step(1).textContent).toContain("Door.OpenAngle gt 80, within 5000 ms");
  });

  it("shows every status live from the stream: running, auto pass, auto fail with its evidence on hover, awaiting verdict", () => {
    const page = mount(runOf());
    page.push(ev("script.step_started", { seq: 2, step: { index: 0, status: "running" } }));
    expect(within(step(0)).getByText("Running")).toBeTruthy();
    page.push(
      ev("script.step_passed", { seq: 3, step: { index: 0, status: "passed", verdictSource: "auto" } }),
      ev("script.step_failed", { seq: 5, step: { index: 1, status: "failed", evidence: { value: "Door.OpenAngle", at_start: 0, at_end: 12.5, samples: 130, observed: true } } }),
      ev("script.verdict_requested", { seq: 7, awaiting: [{ index: 2, instruction: "The door opens without a visible pop" }] }),
    );
    expect(within(step(0)).getByText("Auto pass")).toBeTruthy();
    const fail = within(step(1)).getByText("Auto fail");
    expect(fail.getAttribute("title")).toContain("Expected Door.OpenAngle gt 80 within 5000 ms");
    expect(fail.getAttribute("title")).toContain("Door.OpenAngle: 0 at the start, 12.5 at the end, 130 samples");
    expect(within(step(2)).getByText("Needs you")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Needs you");
    // Another run's events change nothing.
    page.push({ ...ev("script.step_failed", { seq: 9, step: { index: 0, status: "failed" } }), data: { runId: "other", seq: 9, step: { index: 0, status: "failed" } } });
    expect(within(step(0)).getByText("Auto pass")).toBeTruthy();
  });

  it("puts Pass, Fail and Skip only on a manual step awaiting its verdict, and Fail asks what went wrong", async () => {
    const waiting = runOf({ state: "awaiting_verdict", steps: [{ ...STEPS[0], status: "passed" }, { ...STEPS[1], status: "passed" }, { ...STEPS[2], status: "awaiting_verdict" }], awaiting: [{ index: 2, instruction: "x" }], last_seq: 7 });
    const settled = { ...waiting, state: "finished" as const, awaiting: [], steps: waiting.steps.map((s) => (s.index === 2 ? { ...s, status: "failed" as const, note: "Pops on the second frame", verdictSource: "action" as const } : s)) };
    m.qaVerdict.mockResolvedValue({ run: settled });
    mount(waiting);
    expect(within(step(0)).queryByRole("button")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Fail step 3" }));
    // Escape cancels without recording anything.
    const box = screen.getByLabelText("What went wrong?");
    expect(document.activeElement).toBe(box);
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByLabelText("What went wrong?")).toBeNull();
    expect(m.qaVerdict).not.toHaveBeenCalled();
    // A note is required.
    fireEvent.click(screen.getByRole("button", { name: "Fail step 3" }));
    const submit = screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("What went wrong?"), { target: { value: "Pops on the second frame" } });
    expect(submit.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(submit);
    });
    expect(m.qaVerdict).toHaveBeenCalledWith(RUN, 2, "fail", "Pops on the second frame");
    expect(within(step(2)).getByText("Failed")).toBeTruthy();
    expect(within(step(2)).getByText("Pops on the second frame")).toBeTruthy();
    expect(within(step(2)).queryByRole("button", { name: "Pass step 3" })).toBeNull();
    // The note can be edited, which sends the verdict again with the new note.
    const edited = { ...settled, steps: settled.steps.map((s) => (s.index === 2 ? { ...s, note: "Pops on frames 2 and 3" } : s)) };
    m.qaVerdict.mockResolvedValue({ run: edited });
    fireEvent.click(within(step(2)).getByRole("button", { name: "Edit the note on step 3" }));
    const editBox = screen.getByLabelText("What went wrong?") as HTMLTextAreaElement;
    expect(editBox.value).toBe("Pops on the second frame");
    fireEvent.change(editBox, { target: { value: "Pops on frames 2 and 3" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    });
    expect(m.qaVerdict).toHaveBeenLastCalledWith(RUN, 2, "fail", "Pops on frames 2 and 3");
    expect(within(step(2)).getByText("Pops on frames 2 and 3")).toBeTruthy();
  });

  it("shows ue-mcp's refusal and lets the user try again", async () => {
    const waiting = runOf({ state: "awaiting_verdict", steps: [STEPS[0], STEPS[1], { ...STEPS[2], status: "awaiting_verdict" }] });
    m.qaVerdict.mockRejectedValue(new Error("Run x is not the current run (y)"));
    mount(waiting);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pass step 3" }));
    });
    expect(screen.getByText("Run x is not the current run (y)")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Pass step 3" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("answers the verdict form ue-mcp raised from the same buttons, once every step it asks about has one", () => {
    const steps = [{ ...STEPS[0], status: "passed" }, { index: 1, instruction: "Looks right", judge: "manual", status: "awaiting_verdict" }, { ...STEPS[2], status: "awaiting_verdict" }];
    const form: PendingForm = {
      id: "f1", sessionId: "s1", call: "pie(script_run)", at: "",
      message: `Test script /Game/PIEStudio/Scripts/DoorOpens (run ${RUN}) needs your verdict on 2 manual steps:`,
      fields: {
        step_1: { type: "string", title: "Step 2", enum: ["pass", "fail", "skip"] },
        step_1_note: { type: "string", title: "Step 2 note" },
        step_2: { type: "string", title: "Step 3", enum: ["pass", "fail", "skip"] },
        step_2_note: { type: "string", title: "Step 3 note" },
      },
      required: [],
    };
    mount(runOf({ state: "awaiting_verdict", steps, awaiting: [1, 2] }), { forms: [form] });
    fireEvent.click(screen.getByRole("button", { name: "Skip step 2" }));
    expect(m.answerForm).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Skip step 2" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Fail step 3" }));
    fireEvent.change(screen.getByLabelText("What went wrong?"), { target: { value: "it pops" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(m.answerForm).toHaveBeenCalledWith("f1", { action: "accept", content: { step_1: "skip", step_2: "fail", step_2_note: "it pops" } });
    expect(m.qaVerdict).not.toHaveBeenCalled();
  });

  it("reads the run again from its last seq when the stream comes back, and applies the events it missed", async () => {
    m.qaStatus.mockResolvedValue({
      run: null,
      answer: answer({
        state: "awaiting_verdict",
        steps: [{ ...STEPS[0], status: "passed" }, { ...STEPS[1], status: "failed", evidence: { value: "Door.OpenAngle", at_start: 0, at_end: 3, samples: 9 } }, { ...STEPS[2], status: "awaiting_verdict" }],
        awaiting: [{ index: 2, instruction: "x" }],
        events: [
          { seq: 4, type: "step_failed", run_id: RUN, step: 1, data: { status: "failed" } },
          { seq: 5, type: "awaiting_verdict", run_id: RUN, step: -1, data: { awaiting: [2], blocking: true } },
        ],
        last_seq: 5,
      }),
    });
    const page = mount(runOf());
    page.push(ev("script.step_passed", { seq: 3, step: { index: 0, status: "passed" } }));
    page.update({ streaming: false });
    expect(m.qaStatus).not.toHaveBeenCalled();
    await act(async () => {
      page.update({ streaming: true });
    });
    expect(m.qaStatus).toHaveBeenCalledWith(RUN, 3);
    expect(within(step(1)).getByText("Auto fail")).toBeTruthy();
    expect(within(step(2)).getByText("Needs you")).toBeTruthy();
    // The stream replays what the daemon still holds: nothing already applied counts twice.
    page.push(ev("script.step_started", { seq: 4, step: { index: 1, status: "running" } }));
    expect(within(step(1)).getByText("Auto fail")).toBeTruthy();
  });

  it("reads the whole run again after a gap in the stream", async () => {
    m.qaStatus.mockResolvedValue({ run: null, answer: answer({ last_seq: 1 }) });
    const page = mount(runOf());
    await act(async () => {
      page.push({ id: nextId++, type: "gap", at: "", data: {} });
    });
    expect(m.qaStatus).toHaveBeenCalledWith(RUN, undefined);
  });

  it("does not read an ended run again", async () => {
    const page = mount(runOf({ state: "finished", steps: STEPS.map((s) => ({ ...s, status: "passed" })) }));
    page.update({ streaming: false });
    await act(async () => {
      page.update({ streaming: true });
    });
    expect(m.qaStatus).not.toHaveBeenCalled();
  });

  it("sums the run up when it finishes, with a link to its results.json", () => {
    const page = mount(runOf({ state: "running", steps: [{ ...STEPS[0], status: "passed" }, { ...STEPS[1], status: "passed" }, { ...STEPS[2], status: "awaiting_verdict" }] }));
    page.push(
      ev("script.verdict", { seq: 8, step: { index: 2, status: "skipped", verdictSource: "elicitation" } }),
      ev("script.run_finished", { seq: 9, state: "finished", summary: { total: 3, passed: 2, failed: 0, skipped: 1, pending: 0 }, resultsPath: RESULTS }),
    );
    const summary = screen.getAllByRole("status").find((e) => e.classList.contains("qa-summary"))!;
    expect(summary.textContent).toContain("Finished: 2 passed, 0 failed, 1 skipped.");
    const link = within(summary).getByRole("link", { name: "results.json" });
    expect(link.getAttribute("href")).toBe(`/v1/ext/studio/qa/runs/${RUN}/results`);
    expect(link.getAttribute("title")).toBe(RESULTS);
  });

  it("takes a newer view the agent announces", () => {
    const page = mount(runOf());
    const newer = { ...runOf({ steps: [{ ...STEPS[0], status: "passed" }, STEPS[1], STEPS[2]] }), lastSeq: 3 };
    page.push({ id: nextId++, type: "studio.qa.changed", at: "", data: { runId: RUN, run: newer as unknown as Record<string, unknown> } });
    expect(within(step(0)).getByText("Auto pass")).toBeTruthy();
  });
});

describe("assigning the playtest to a subagent", () => {
  const running = (r: QaRun): QaRun => ({ ...r, assignment: { callId: "studio_1", sessionId: "s1", state: "running", at: "" } });

  it("starts the subagent from the card, then offers Cancel and its thread while it runs", async () => {
    const run = runOf();
    m.qaAssign.mockResolvedValue({ run: running(run) });
    m.qaCancelAssign.mockResolvedValue({ run: { ...run, assignment: { callId: "studio_1", sessionId: "s1", state: "stopped", at: "" } } });
    const onThread = vi.fn();
    mount(run, { onThread });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Assign to subagent" }));
    });
    expect(m.qaAssign).toHaveBeenCalledWith(RUN, null);
    expect(screen.queryByRole("button", { name: "Assign to subagent" })).toBeNull();
    expect(screen.getByText("A subagent is running this playtest.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open its thread" }));
    expect(onThread).toHaveBeenCalledWith("studio_1");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel the subagent" }));
    });
    expect(m.qaCancelAssign).toHaveBeenCalledWith(RUN);
    expect(screen.getByText("The subagent was stopped.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Assign to subagent" })).toBeTruthy();
  });

  it("runs a playtest started elsewhere in the open session", async () => {
    const run = qaRunFromAnswer(answer(), { sessionId: null, seenAt: "" })!;
    m.qaAssign.mockResolvedValue({ run: running(run) });
    mount(run, { sessionId: "open" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Assign to subagent" }));
    });
    expect(m.qaAssign).toHaveBeenCalledWith(RUN, "open");
  });

  it("follows the agent's word on the subagent even when the card's steps are newer", () => {
    const page = mount(runOf());
    page.push(ev("script.step_passed", { seq: 5, step: { index: 0, status: "passed" } }));
    const older = { ...running(runOf()), lastSeq: 2 };
    page.push({ id: nextId++, type: "studio.qa.changed", at: "", data: { runId: RUN, run: older as unknown as Record<string, unknown> } });
    expect(screen.getByRole("button", { name: "Cancel the subagent" })).toBeTruthy();
    expect(within(step(0)).getByText("Auto pass")).toBeTruthy();
  });

  it("offers nothing to assign when every step left is a person's", () => {
    const steps = [{ ...STEPS[0], status: "passed" }, { ...STEPS[1], status: "passed" }, { ...STEPS[2], agent_judgeable: false, status: "awaiting_verdict" }];
    mount(runOf({ state: "awaiting_verdict", steps }));
    expect(screen.queryByRole("button", { name: "Assign to subagent" })).toBeNull();
    expect(within(step(2)).getByText("yours")).toBeTruthy();
  });

  it("badges the agent's verdict, shows its evidence on hover and expanded, and overrides it with one click", async () => {
    const agentStep = {
      ...STEPS[2], status: "passed", verdict_source: "agent", note: "No pop across 12 frames",
      evidence: { note: "No pop across 12 frames", captures: ["C:/MyGame/Saved/Screenshots/door_01.png", "C:/MyGame/Saved/Screenshots/door_02.png"] },
    };
    const run = runOf({ state: "finished", steps: [{ ...STEPS[0], status: "passed" }, { ...STEPS[1], status: "passed" }, agentStep] });
    const overridden = { ...run, steps: run.steps.map((s) => (s.index === 2 ? { ...s, status: "failed" as const, verdictSource: "action" as const, evidence: undefined, note: undefined } : s)) };
    m.qaVerdict.mockResolvedValue({ run: overridden });
    mount(run);
    expect(screen.getAllByRole("status").find((e) => e.classList.contains("qa-summary"))!.textContent).toContain("The agent judged 1 step.");
    const badge = within(step(2)).getByText("Agent");
    expect(badge.getAttribute("title")).toBe(["No pop across 12 frames", "C:/MyGame/Saved/Screenshots/door_01.png", "C:/MyGame/Saved/Screenshots/door_02.png"].join(String.fromCharCode(10)));
    expect(within(step(0)).queryByText("Agent")).toBeNull();
    const details = step(2).querySelector("details")!;
    expect(within(details).getByText("What the agent saw")).toBeTruthy();
    expect(within(details).getByText("C:/MyGame/Saved/Screenshots/door_02.png")).toBeTruthy();
    // Its own verdict is not offered again.
    expect(within(step(2)).queryByRole("button", { name: "Override step 3 with Pass" })).toBeNull();
    await act(async () => {
      fireEvent.click(within(step(2)).getByRole("button", { name: "Override step 3 with Fail" }));
    });
    // Overriding to Fail asks what went wrong, as Fail does.
    expect(m.qaVerdict).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("What went wrong?"), { target: { value: "It pops on frame 2" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    });
    expect(m.qaVerdict).toHaveBeenCalledWith(RUN, 2, "fail", "It pops on frame 2");
    expect(within(step(2)).getByText("Failed")).toBeTruthy();
    expect(within(step(2)).queryByText("Agent")).toBeNull();
    expect(within(step(2)).queryByRole("button")).toBeNull();
  });
});

describe("the collapsed card", () => {
  const collapsed = (run: QaRun, live: Partial<QaLive> = {}) =>
    render(<QaContext.Provider value={{ events: [], streaming: true, forms: [], ...live }}><QaCard run={run} /></QaContext.Provider>);

  it("is the default: the title, a bar per step in its status's colour, and one line", () => {
    const steps = STEPS.map((s, i) => ({ ...s, status: ["passed", "failed", "pending"][i] }));
    collapsed(runOf({ state: "finished", steps }));
    expect(screen.getByRole("button", { name: /DoorOpens/, expanded: false })).toBeTruthy();
    const bars = within(screen.getByRole("list", { name: "Steps" })).getAllByRole("listitem");
    expect(bars.map((b) => b.className.split(" ")[1])).toEqual(["ok", "bad", ""]);
    const bar = within(bars[1]).getByRole("button");
    expect(bar.getAttribute("aria-label")).toBe("Step 2, auto, Failed");
    expect(bar.getAttribute("title")).toBe("2. Open the door (auto): Auto fail");
    expect(screen.getByText("3 steps: 1 passed, 1 failed")).toBeTruthy();
    expect(screen.queryByText("Walk up to the door")).toBeNull();
    // The pill says how it ended in words, not only in colour.
    expect(screen.getAllByRole("status")[0].textContent).toBe("1 failed");
  });

  it("tells manual steps from auto ones by more than colour", () => {
    collapsed(runOf());
    const bars = within(screen.getByRole("list", { name: "Steps" })).getAllByRole("listitem");
    expect(bars.map((b) => b.classList.contains("manual"))).toEqual([false, false, true]);
    expect(within(bars[2]).getByRole("button").getAttribute("aria-label")).toBe("Step 3, manual, Pending");
  });

  it("opens to the full card on a click, and closes again from its title", () => {
    collapsed(runOf());
    fireEvent.click(screen.getByRole("button", { name: "Open playtest DoorOpens" }));
    expect(screen.getByText("Walk up to the door")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Steps" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /DoorOpens/, expanded: true }));
    expect(screen.queryByText("Walk up to the door")).toBeNull();
  });

  it("opens on the step whose bar was clicked, scrolled to it and focused", () => {
    const scrolled: string[] = [];
    const proto = HTMLElement.prototype as unknown as { scrollIntoView?: (o?: unknown) => void };
    const had = proto.scrollIntoView;
    proto.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this.getAttribute("data-index") ?? "");
    };
    try {
      collapsed(runOf());
      fireEvent.click(screen.getByRole("button", { name: "Step 3, manual, Pending" }));
      expect(screen.getByText("The door opens without a visible pop")).toBeTruthy();
      expect(scrolled).toEqual(["2"]);
      expect(document.activeElement?.getAttribute("data-index")).toBe("2");
      expect(document.activeElement?.classList.contains("flash")).toBe(true);
    } finally {
      proto.scrollIntoView = had;
    }
  });

  it("stays collapsed when a step waits, and takes the verdict there", async () => {
    m.qaVerdict.mockResolvedValue({ run: runOf({ state: "running", steps: STEPS.map((s, i) => ({ ...s, status: "passed" })) }) });
    const steps = STEPS.map((s, i) => ({ ...s, status: i === 2 ? "awaiting_verdict" : "passed" }));
    collapsed(runOf({ state: "awaiting_verdict", steps, awaiting: [2] }));
    expect(screen.getByRole("button", { name: /DoorOpens/, expanded: false })).toBeTruthy();
    const ask = screen.getByRole("group", { name: "Step 3 needs you" });
    expect(within(ask).getByText("The door opens without a visible pop")).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(ask).getByRole("button", { name: "Pass step 3" }));
    });
    expect(m.qaVerdict).toHaveBeenCalledWith(RUN, 2, "pass", undefined);
  });

  it("opens on the waiting step with its note box when the verdict is Fail", () => {
    const steps = STEPS.map((s, i) => ({ ...s, status: i === 2 ? "awaiting_verdict" : "passed" }));
    collapsed(runOf({ state: "awaiting_verdict", steps, awaiting: [2] }));
    fireEvent.click(screen.getByRole("button", { name: "Fail step 3" }));
    expect(screen.getByRole("button", { name: /DoorOpens/, expanded: true })).toBeTruthy();
    expect(screen.getByLabelText("What went wrong?")).toBe(document.activeElement);
    expect(m.qaVerdict).not.toHaveBeenCalled();
  });

  it("asks about the next waiting step, and offers the rest in the full card", () => {
    const two = [...STEPS, { index: 3, instruction: "The hinge sounds right", judge: "manual", status: "awaiting_verdict", within_ms: 5000 }];
    const steps = two.map((s, i) => ({ ...s, status: i >= 2 ? "awaiting_verdict" : "passed" }));
    collapsed(runOf({ state: "awaiting_verdict", steps, awaiting: [2, 3] }));
    expect(screen.getByRole("group", { name: "Step 3 needs you" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "1 more" }));
    expect(screen.getByText("The hinge sounds right")).toBeTruthy();
  });

  it("names the step a running run is on", () => {
    collapsed(runOf({ state: "running", steps: STEPS.map((s, i) => ({ ...s, status: ["passed", "running", "pending"][i] })) }));
    expect(screen.getAllByRole("status")[0].textContent).toBe("Running step 2 of 3");
  });

  it("stops a live run from its collapsed card", async () => {
    m.qaStop.mockResolvedValue({ run: runOf({ state: "stopped" }) });
    collapsed(runOf({ state: "running", steps: STEPS.map((s, i) => ({ ...s, status: i === 0 ? "running" : "pending" })) }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop playtest DoorOpens" }));
    });
    expect(m.qaStop).toHaveBeenCalledWith(RUN);
    expect(screen.getAllByRole("status")[0].textContent).toBe("Stopped");
  });

  it("runs an ended playtest again from its card in the session, in one click", async () => {
    m.qaRun.mockResolvedValue({ run: { ...runOf({ state: "armed" }), runId: "next" } });
    collapsed(runOf({ state: "finished", steps: STEPS.map((s) => ({ ...s, status: "passed" })) }));
    expect(screen.queryByRole("button", { name: /^Stop/ })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Run again" }));
    });
    expect(m.qaRun).toHaveBeenCalledWith(RUN, { startPie: true, players: 1, listen: false, record: true });
  });

  it("draws its actions disabled, saying why, while it cannot act", () => {
    const steps = STEPS.map((s, i) => ({ ...s, status: i === 2 ? "awaiting_verdict" : "passed" }));
    render(<QaContext.Provider value={{ events: [], streaming: true, forms: [] }}><QaCard run={runOf({ state: "awaiting_verdict", steps, awaiting: [2] })} offline="The editor is not connected" /></QaContext.Provider>);
    const pass = screen.getByRole("button", { name: "Pass step 3" }) as HTMLButtonElement;
    expect(pass.disabled).toBe(true);
    expect(pass.title).toBe("The editor is not connected");
  });

  it("offers Review on a loop that stopped for the user, and Assign again only in the open card", () => {
    const loop = { id: "l1", state: "needs_you", attempts: [], baseline: "c0", budget: { minutes: 60, tokens: 1 }, tokens: 0, startedAt: "", blocker: { kind: "no_progress", reason: "Nothing changed", evidence: [] } };
    collapsed({ ...runOf({ state: "finished", steps: STEPS.map((s) => ({ ...s, status: "failed" })) }), assignment: { callId: "c", sessionId: "s1", state: "done", at: "", loop } as QaRun["assignment"] }, { sessionId: "s1" });
    expect(screen.queryByRole("button", { name: /Assign/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Run again" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByRole("button", { name: "Assign again" })).toBeTruthy();
  });

  it("brings the card into view when it opens, and clears a step's mark after a moment", () => {
    vi.useFakeTimers();
    const scrolled: string[] = [];
    const proto = HTMLElement.prototype as unknown as { scrollIntoView?: (o?: unknown) => void };
    const had = proto.scrollIntoView;
    proto.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this.getAttribute("data-run-id") ?? this.getAttribute("data-index") ?? "");
    };
    try {
      collapsed(runOf());
      fireEvent.click(screen.getByRole("button", { name: "Open playtest DoorOpens" }));
      expect(scrolled).toEqual([RUN]);
      fireEvent.click(screen.getByRole("button", { name: /DoorOpens/, expanded: true }));
      fireEvent.click(screen.getByRole("button", { name: "Step 2, auto, Pending" }));
      const li = document.querySelector(".qa-step[data-index='1']")!;
      expect(li.classList.contains("flash")).toBe(true);
      act(() => {
        vi.advanceTimersByTime(1700);
      });
      expect(li.classList.contains("flash")).toBe(false);
    } finally {
      proto.scrollIntoView = had;
      vi.useRealTimers();
    }
  });

  it("says what a loop that stopped needs, and opens on Review", () => {
    const loop = { id: "l1", state: "needs_you", attempts: [], baseline: "c0", budget: { minutes: 60, tokens: 1 }, tokens: 0, startedAt: "", blocker: { kind: "no_progress", reason: "Two attempts changed nothing", evidence: [] } };
    collapsed({ ...runOf({ state: "finished", steps: STEPS.map((s) => ({ ...s, status: "failed" })) }), assignment: { callId: "c", sessionId: "s1", state: "done", at: "", loop } as QaRun["assignment"] });
    expect(screen.getByText("Two attempts changed nothing")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByRole("button", { name: /DoorOpens/, expanded: true })).toBeTruthy();
  });
});

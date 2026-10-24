// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { DaemonEvent } from "ue-mcp/daemon";
import { qaRunFromAnswer, type PendingForm, type QaRun } from "@ue-mcp-studio/shared";

const m = vi.hoisted(() => ({
  qaVerdict: vi.fn(),
  qaStatus: vi.fn(),
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
  let cur = value;
  const update = (next: Partial<QaLive>) => {
    cur = { ...cur, ...next };
    r.rerender(ui(cur));
  };
  return { ...r, update, push: (...e: DaemonEvent[]) => update({ events: [...cur.events, ...e] }) };
}

const step = (n: number) => screen.getAllByRole("listitem")[n];

describe("the checklist card", () => {
  it("lists each step's instruction, judge and status", () => {
    mount(runOf());
    expect(screen.getByText("DoorOpens")).toBeTruthy();
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
    expect(within(step(2)).getByText("Awaiting verdict")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Waiting for you");
    // Another run's events change nothing.
    page.push({ ...ev("script.step_failed", { seq: 9, step: { index: 0, status: "failed" } }), data: { runId: "other", seq: 9, step: { index: 0, status: "failed" } } });
    expect(within(step(0)).getByText("Auto pass")).toBeTruthy();
  });

  it("puts Pass, Fail and Skip only on a manual step awaiting its verdict, and sends it with the note", async () => {
    const waiting = runOf({ state: "awaiting_verdict", steps: [{ ...STEPS[0], status: "passed" }, { ...STEPS[1], status: "passed" }, { ...STEPS[2], status: "awaiting_verdict" }], awaiting: [{ index: 2, instruction: "x" }], last_seq: 7 });
    const settled = { ...waiting, state: "finished" as const, awaiting: [], steps: waiting.steps.map((s) => (s.index === 2 ? { ...s, status: "failed" as const, note: "Pops on the second frame", verdictSource: "action" as const } : s)) };
    m.qaVerdict.mockResolvedValue({ run: settled });
    mount(waiting);
    expect(within(step(0)).queryByRole("button")).toBeNull();
    fireEvent.change(screen.getByLabelText("Note for step 3"), { target: { value: "Pops on the second frame" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Fail step 3" }));
    });
    expect(m.qaVerdict).toHaveBeenCalledWith(RUN, 2, "fail", "Pops on the second frame");
    expect(within(step(2)).getByText("Failed")).toBeTruthy();
    expect(within(step(2)).getByText("Pops on the second frame")).toBeTruthy();
    expect(within(step(2)).queryByRole("button")).toBeNull();
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
    fireEvent.change(screen.getByLabelText("Note for step 3"), { target: { value: "smooth" } });
    fireEvent.click(screen.getByRole("button", { name: "Pass step 3" }));
    expect(m.answerForm).toHaveBeenCalledWith("f1", { action: "accept", content: { step_1: "skip", step_2: "pass", step_2_note: "smooth" } });
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
    expect(within(step(2)).getByText("Awaiting verdict")).toBeTruthy();
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

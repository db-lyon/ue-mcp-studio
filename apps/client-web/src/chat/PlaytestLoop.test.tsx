// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { openCard } from "./qa-test-helpers";
import { qaRunFromAnswer, type QaLoop, type QaRun } from "@ue-mcp-studio/shared";

const m = vi.hoisted(() => ({
  qaVerdict: vi.fn(),
  qaStatus: vi.fn(),
  qaAssign: vi.fn(),
  qaCancelAssign: vi.fn(),
  qaRevertLoop: vi.fn(),
  answerForm: vi.fn(async () => {}),
  qaResultsUrl: (id: string) => `/v1/ext/studio/qa/runs/${id}/results`,
}));
vi.mock("../api", () => ({ api: m }));
import { QaCard, QaContext, type QaLive } from "./Qa";
import { loopHeadline } from "./PlaytestLoop";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const RUN = "script_DoorOpens_2";
const runOf = (loop: QaLoop, over: Record<string, unknown> = {}): QaRun => ({
  ...qaRunFromAnswer({
    run_id: RUN, script: "/Game/S/DoorOpens", script_name: "DoorOpens", state: "finished", awaiting: [], last_seq: 4,
    steps: [{ index: 0, instruction: "Open the door", judge: "auto", status: "failed" }, { index: 1, instruction: "Sound feels right", judge: "manual", agent_judgeable: false, status: "awaiting_verdict" }],
    ...over,
  }, { sessionId: "s1", seenAt: "2026-10-24T10:00:00.000Z" })!,
  assignment: { callId: loop.attempts.at(-1)?.callId ?? "", sessionId: "s1", state: loop.state === "running" ? "running" : "done", at: "x", loop },
});

const attempt = (n: number, changes: Array<{ path: string; status: "added" | "modified" | "deleted" }>, over: Record<string, unknown> = {}) => ({
  n, callId: `studio_${n}`, before: `b${n}`, after: `a${n}`, changes, failing: [], startedAt: "x", endedAt: "y", tokens: 100, ...over,
});
const loopOf = (over: Partial<QaLoop>): QaLoop => ({ id: "l1", state: "running", attempts: [], baseline: "b0", budget: { minutes: 60, tokens: 2_000_000 }, tokens: 0, startedAt: "x", ...over });

const mount = (run: QaRun, live: Partial<QaLive> = {}) => {
  const r = render(<QaContext.Provider value={{ events: [], streaming: true, forms: [], sessionId: "s1", ...live }}><QaCard run={run} /></QaContext.Provider>);
  openCard(r.container);
  return r;
};

describe("the loop on the playtest card", () => {
  it("shows Needs you with the reason and the evidence", () => {
    mount(runOf(loopOf({
      state: "needs_you",
      attempts: [attempt(1, []), attempt(2, [{ path: "Content/BP_Door.uasset", status: "modified" }])],
      blocker: { kind: "no_progress", step: 0, reason: "No progress: Step 1 fails the same way on two attempts in a row after a change.", evidence: ["Step 1 (Open the door) failed. Door.OpenAngle never went above 80."] },
    })));
    expect(screen.getByRole("status", { name: "Loop: Needs you" }).textContent).toBe("Needs you");
    // The reason once, in the box under the path; what it saw in the loop's panel.
    expect(screen.getAllByText(/No progress: Step 1 fails the same way/)).toHaveLength(1);
    expect(screen.getByText(/Door\.OpenAngle never went above 80/)).toBeTruthy();
    expect(screen.getByText(/paused after 2 attempts, waiting for you/)).toBeTruthy();
    expect(document.querySelector(".qa-card.needs-you")).toBeTruthy();
    expect(document.querySelector(`[data-run-id="${RUN}"]`)).toBeTruthy();
  });

  it("shows Passed with the attempt count and each attempt's changes, grouped", () => {
    mount(runOf(loopOf({ state: "passed", attempts: [attempt(1, []), attempt(2, [{ path: "Content/BP_Door.uasset", status: "modified" }, { path: "Config/DefaultInput.ini", status: "modified" }])] }), { steps: [{ index: 0, instruction: "Open the door", judge: "auto", status: "passed" }] }));
    expect(screen.getByRole("status", { name: "Loop: Passed" })).toBeTruthy();
    expect(screen.getByText("Passed after 2 attempts.")).toBeTruthy();
    expect(screen.getByText("Attempt 2")).toBeTruthy();
    expect(screen.getAllByText("2 changes").length).toBeGreaterThan(0);
    expect(screen.getByText("Blueprints:")).toBeTruthy();
    expect(screen.getByText("Config:")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Assign to subagent" })).toBeNull();
  });

  it("reverts one attempt, or every attempt with Revert every attempt", async () => {
    const loop = loopOf({ state: "stopped", attempts: [attempt(1, [{ path: "Content/A.uasset", status: "modified" }]), attempt(2, [{ path: "Content/B.uasset", status: "added" }])] });
    m.qaRevertLoop.mockResolvedValue({ run: runOf(loop), outcome: { restored: [], conflicts: [], missing: [] } });
    mount(runOf(loop));
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Revert attempt 2" })));
    expect(m.qaRevertLoop).toHaveBeenCalledWith(RUN, 2);
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Revert every attempt" })));
    expect(m.qaRevertLoop).toHaveBeenLastCalledWith(RUN, undefined);
  });

  it("offers no revert while the loop runs, and Cancel stops the loop", async () => {
    const loop = loopOf({ state: "running", attempts: [attempt(1, [{ path: "Content/A.uasset", status: "modified" }]), attempt(2, [], { endedAt: undefined })] });
    m.qaCancelAssign.mockResolvedValue({ run: runOf(loop) });
    mount(runOf(loop));
    expect(screen.getByRole("status", { name: "Loop: Attempt 2" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Revert/ })).toBeNull();
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "End the loop" })));
    expect(m.qaCancelAssign).toHaveBeenCalledWith(RUN);
  });

  it("opens each attempt's thread", () => {
    const onThread = vi.fn();
    mount(runOf(loopOf({ state: "passed", attempts: [attempt(1, [])] })), { onThread });
    fireEvent.click(screen.getByRole("button", { name: "Open attempt 1's thread" }));
    expect(onThread).toHaveBeenCalledWith("studio_1");
  });

  it("says where the loop is", () => {
    expect(loopHeadline(loopOf({ attempts: [attempt(1, [], { endedAt: undefined })] }))).toMatch(/Attempt 1 is running: the subagent runs the playtest/);
    expect(loopHeadline(loopOf({ attempts: [attempt(1, []), attempt(2, [])] }))).toMatch(/Attempt 2 is running: the subagent fixes what failed/);
    expect(loopHeadline(loopOf({ state: "failed", error: "the card is gone" }))).toBe("The loop stopped on an error: the card is gone");
  });
});

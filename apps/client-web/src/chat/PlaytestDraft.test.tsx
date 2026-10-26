// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { openCard } from "./qa-test-helpers";
import type { DaemonEvent } from "ue-mcp/daemon";
import { qaDraftFromScript, qaRunFromAnswer, type QaRun } from "@ue-mcp-studio/shared";

const m = vi.hoisted(() => ({
  qaRun: vi.fn(),
  qaSaveScript: vi.fn(),
  qaDeleteScript: vi.fn(),
  qaAssign: vi.fn(),
  qaCancelAssign: vi.fn(),
  qaVerdict: vi.fn(),
  qaStatus: vi.fn(),
  answerForm: vi.fn(async () => {}),
  qaResultsUrl: (id: string) => `/v1/ext/studio/qa/runs/${id}/results`,
}));
vi.mock("../api", () => ({ api: m }));
import { QaCard, QaContext, type QaLive } from "./Qa";
import { playersNeeded } from "./PlaytestDraft";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const PATH = "/Game/PIEStudio/Scripts/SigilPickup";
const RUN = "script_SigilPickup_20261024_120000";
const STEPS = [
  { instruction: "Pick up the sigil", judge: "auto", expect: { value: "PlayerState.SigilAttributes.Sigil.CurrentValue", op: "eq", target: 100, within_ms: 5000 } },
  { instruction: "The pickup plays on the client", judge: "manual" },
];
const draft = (over: Partial<QaRun> = {}): QaRun => ({ ...qaDraftFromScript({ path: PATH, name: "SigilPickup", default_within_ms: 5000, steps: STEPS }, { sessionId: "s1", players: { 0: "host", 1: "client 1" }, seenAt: "" })!, ...over });
const live = (): QaRun => qaRunFromAnswer({ run_id: RUN, script: PATH, script_name: "SigilPickup", state: "armed", steps: STEPS.map((s, index) => ({ ...s, index, status: "pending" })), awaiting: [], last_seq: 1 }, { sessionId: "s1" })!;

let nextId = 1;
function mount(run: QaRun, extra: Partial<QaLive> = {}) {
  let cur: QaLive = { events: [], streaming: true, forms: [], sessionId: "s1", ...extra };
  const ui = (v: QaLive) => <QaContext.Provider value={v}><QaCard run={run} /></QaContext.Provider>;
  const r = render(ui(cur));
  openCard(r.container);
  return { ...r, push: (...e: DaemonEvent[]) => { cur = { ...cur, events: [...cur.events, ...e] }; r.rerender(ui(cur)); } };
}
const step = (n: number) => document.querySelectorAll<HTMLElement>(".qa-step")[n];

describe("a manual step's verdict before Start playtest", () => {
  const MANUAL = "script_SigilPickup_manual";
  const manual = (status: "awaiting_verdict" | "passed" | "failed", note?: string): QaRun => ({
    ...qaRunFromAnswer({ run_id: MANUAL, mode: "manual", script: PATH, script_name: "SigilPickup", state: "awaiting_verdict", steps: STEPS.map((s, index) => ({ ...s, index, status: index === 1 ? status : "pending", ...(index === 1 && note ? { note } : {}) })), awaiting: status === "awaiting_verdict" ? [1] : [], last_seq: 1 }, { sessionId: "s1" })!,
  });

  it("is sent from the draft, and the card stays in place as the manual run, with Start playtest still there", async () => {
    m.qaVerdict.mockResolvedValue({ run: manual("passed") });
    mount(draft());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pass step 2" }));
    });
    expect(m.qaVerdict).toHaveBeenCalledWith(`draft:${PATH}`, 1, "pass", undefined);
    expect(screen.getAllByRole("group", { name: "Playtest SigilPickup" })).toHaveLength(1);
    expect(within(step(1)).getByText("Passed")).toBeTruthy();
    expect(within(step(0)).getByText("Checked when the playtest runs")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start playtest" })).toBeTruthy();
  });

  it("Fail asks what went wrong first, and sends the note", async () => {
    m.qaVerdict.mockResolvedValue({ run: manual("failed", "No sound on the client") });
    mount(draft());
    fireEvent.click(screen.getByRole("button", { name: "Fail step 2" }));
    expect(m.qaVerdict).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("What went wrong?"), { target: { value: "No sound on the client" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    });
    expect(m.qaVerdict).toHaveBeenCalledWith(`draft:${PATH}`, 1, "fail", "No sound on the client");
    expect(within(step(1)).getByText("No sound on the client")).toBeTruthy();
  });
});

describe("a draft Playtest card", () => {
  it("lists every step unrun, with its player, and auto with its check or manual", () => {
    mount(draft());
    expect(screen.getByText("Playtest draft")).toBeTruthy();
    // The eyebrow says Draft; no pill repeats it.
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText(PATH)).toBeTruthy();
    expect(within(step(0)).getByText("host")).toBeTruthy();
    expect(within(step(0)).getByText("Observer")).toBeTruthy();
    expect(step(0).textContent).toContain("PlayerState.SigilAttributes.Sigil.CurrentValue eq 100, within 5000 ms");
    expect(within(step(1)).getByText("client 1")).toBeTruthy();
    expect(within(step(1)).getByText("Person")).toBeTruthy();
    // Unrun: the auto step waits for Start playtest, the manual step takes its verdict now.
    expect(within(step(0)).queryByText("To come")).toBeNull();
    expect(within(step(0)).getByText("Checked when the playtest runs")).toBeTruthy();
    expect(within(step(0)).queryByRole("button")).toBeNull();
    expect(within(step(1)).getAllByRole("button").map((b) => b.textContent)).toEqual(["Pass", "Fail", "Skip"]);
    for (const name of ["Start playtest", "Assign to subagent", "Edit", "Delete"]) expect(screen.getByRole("button", { name })).toBeTruthy();
  });

  it("Start playtest starts in one click, even collapsed, with the players its steps name, and the same card goes live", async () => {
    m.qaRun.mockResolvedValue({ run: live() });
    render(<QaContext.Provider value={{ events: [], streaming: true, forms: [], sessionId: "s1" }}><QaCard run={draft()} /></QaContext.Provider>);
    expect(screen.getByRole("button", { name: /SigilPickup/, expanded: false })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start playtest" }));
    });
    expect(m.qaRun).toHaveBeenCalledWith(`draft:${PATH}`, { startPie: true, players: 2, listen: true, record: true });
    expect(screen.getByText("Playtest")).toBeTruthy();
    expect(screen.getAllByRole("status")[0].textContent).toBe("Starting");
  });

  it("Start playtest's options open its panel, start with what was picked, and the same card goes live", async () => {
    m.qaRun.mockResolvedValue({ run: live() });
    const page = mount(draft());
    fireEvent.click(screen.getByRole("button", { name: "Start playtest options" }));
    const options = screen.getByRole("group", { name: "Start playtest options" });
    // Two players named: two players and a listen server, to start with.
    expect((within(options).getByLabelText("Players") as HTMLInputElement).value).toBe("2");
    expect((within(options).getByRole("checkbox", { name: "Listen server" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(options).getByRole("checkbox", { name: /Start PIE/ }));
    fireEvent.click(within(options).getByRole("checkbox", { name: /Record/ }));
    await act(async () => {
      fireEvent.click(within(options).getByRole("button", { name: "Start" }));
    });
    expect(m.qaRun).toHaveBeenCalledWith(`draft:${PATH}`, { startPie: false, players: 2, listen: true, record: false });
    expect(screen.getByText("Playtest")).toBeTruthy();
    expect(screen.getAllByRole("status")[0].textContent).toBe("Starting");
    expect(within(step(0)).getByText("To come")).toBeTruthy();
    // Live, with the run's events applied.
    page.push({ id: nextId++, type: "script.step_passed", at: "", data: { runId: RUN, seq: 3, step: { index: 0, status: "passed" } } });
    expect(within(step(0)).getByText("Passed")).toBeTruthy();
  });

  it("goes live when a run of its script takes it elsewhere, as an assigned subagent's does", () => {
    const page = mount(draft());
    page.push({ id: nextId++, type: "studio.qa.changed", at: "", data: { runId: RUN, run: live() as unknown as Record<string, unknown>, replaces: `draft:${PATH}` } });
    expect(screen.getByText("Playtest")).toBeTruthy();
    expect(within(step(0)).getByText("To come")).toBeTruthy();
  });

  it("Edit changes steps in place and saves them, players included", async () => {
    m.qaSaveScript.mockImplementation(async (_id: string, steps: unknown[]) => ({ run: draft({ steps: draft().steps.slice(1) }) , steps }));
    mount(draft());
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Step 1 instruction"), { target: { value: "Pick up the sigil on the altar" } });
    fireEvent.change(screen.getByLabelText("Step 1 target"), { target: { value: "50" } });
    fireEvent.change(screen.getByLabelText("Step 2 judge"), { target: { value: "auto" } });
    fireEvent.change(screen.getByLabelText("Step 2 player"), { target: { value: "host" } });
    fireEvent.change(screen.getByLabelText("Step 2 value"), { target: { value: "BP_ShrineGate_C.bIsOpen" } });
    fireEvent.click(screen.getByRole("button", { name: "Add a step" }));
    fireEvent.change(screen.getByLabelText("Step 3 instruction"), { target: { value: "The gate looks right" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(m.qaSaveScript).toHaveBeenCalledWith(`draft:${PATH}`, [
      { instruction: "Pick up the sigil on the altar", judge: "auto", expect: { value: "PlayerState.SigilAttributes.Sigil.CurrentValue", op: "eq", target: 50, within_ms: 5000 }, player: "host" },
      { instruction: "The pickup plays on the client", judge: "auto", expect: { value: "BP_ShrineGate_C.bIsOpen", op: "eq" }, player: "host" },
      { instruction: "The gate looks right", judge: "manual" },
    ], "");
    // The editor closes on the saved draft.
    expect(screen.queryByRole("group", { name: "Edit the playtest" })).toBeNull();
    expect(document.querySelectorAll(".qa-step")).toHaveLength(1);
  });

  it("Delete asks once more, then deletes the script", async () => {
    m.qaDeleteScript.mockResolvedValue({ run: draft({ deleted: true }) });
    mount(draft());
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(m.qaDeleteScript).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete the script" }));
    });
    expect(m.qaDeleteScript).toHaveBeenCalledWith(`draft:${PATH}`);
    expect(screen.getByRole("status").textContent).toBe("Deleted");
    expect(screen.queryByRole("button", { name: "Start playtest" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Assign to subagent" })).toBeNull();
  });

  it("Assign to subagent on a draft hands it over and offers Cancel", async () => {
    m.qaAssign.mockResolvedValue({ run: draft({ assignment: { callId: "studio_1", sessionId: "s1", state: "running", at: "" } }) });
    mount(draft(), { onThread: vi.fn() });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Assign to subagent" }));
    });
    expect(m.qaAssign).toHaveBeenCalledWith(`draft:${PATH}`, null);
    expect(screen.getByRole("button", { name: "Cancel the subagent" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start playtest" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open its thread" })).toBeTruthy();
  });

  it("shows ue-mcp's refusal of a Start playtest", async () => {
    m.qaRun.mockRejectedValue(new Error("PIE could not be set to 2 players: no editor"));
    mount(draft());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start playtest" }));
    });
    expect(screen.getByText("PIE could not be set to 2 players: no editor")).toBeTruthy();
    expect(screen.getByText("Playtest draft")).toBeTruthy();
  });

  it("counts the players the steps name", () => {
    expect(playersNeeded(draft())).toBe(2);
    expect(playersNeeded(draft({ steps: draft().steps.map((s) => ({ ...s, player: undefined })) }))).toBe(1);
  });
});

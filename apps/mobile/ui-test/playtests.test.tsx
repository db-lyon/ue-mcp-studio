import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import type { Transport } from "@ue-mcp-studio/client-core";
import type { PendingForm, PlaytestEntry, QaRun } from "@ue-mcp-studio/shared";
import { RUNS, run } from "../../client-web/src/visual-qa/fixtures";
import { QaCard } from "../src/screens/playtests/QaCard";
import { FILTER_KEY, PlaytestsScreen } from "../src/screens/playtests/Playtests";
import { QaContext } from "../src/screens/playtests/live";
import { store } from "./mocks/secure-store";
import { ProjectContext } from "../src/nav";
import { fakeApi, fakeProject, renderInProject, settle } from "./helpers";

/** Presses the button (or link) named `label`. */
const press = (label: string) => fireEvent.click(screen.getAllByLabelText(label).find((el) => ["button", "link", "checkbox"].includes(el.getAttribute("role") ?? el.tagName.toLowerCase())) ?? screen.getAllByLabelText(label)[0]);
const pressText = (text: string) => fireEvent.click(screen.getAllByText(text)[0]);

describe("QaCard", () => {
  it("asks for the waiting step's verdict in the box under its path", async () => {
    const api = fakeApi();
    api.qaVerdict.mockResolvedValue({ run: { ...RUNS.waiting, state: "running", lastSeq: 9, steps: RUNS.waiting.steps.map((s) => (s.index === 3 ? { ...s, status: "passed" } : s)) } });
    renderInProject(<QaCard run={RUNS.waiting} />, api);
    expect(screen.getByText("PT_DoorOpens")).toBeTruthy();
    expect(screen.getByText("Needs you")).toBeTruthy();
    expect(screen.getByText("5 steps: 3 passed, 1 needs you")).toBeTruthy();
    expect(screen.getByText(/Check in PIE/)).toBeTruthy();
    press("Pass step 4");
    expect(api.qaVerdict).toHaveBeenCalledWith(RUNS.waiting.runId, 3, "pass", undefined);
    await settle();
    expect(screen.queryByText(/Check in PIE/)).toBeNull();
  });

  it("fails a step only with a note on what went wrong", () => {
    const api = fakeApi();
    api.qaVerdict.mockResolvedValue({ run: RUNS.waiting });
    renderInProject(<QaCard run={RUNS.waiting} />, api);
    press("Fail step 4");
    expect(screen.getByText("What went wrong?")).toBeTruthy();
    press("Submit");
    expect(api.qaVerdict).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("What went wrong?"), { target: { value: "It pops on frame 1" } });
    press("Submit");
    expect(api.qaVerdict).toHaveBeenCalledWith(RUNS.waiting.runId, 3, "fail", "It pops on frame 1");
  });

  it("opens on a step from its bar, with who judges each step and its status", () => {
    renderInProject(<QaCard run={RUNS.waiting} />);
    expect(screen.queryByText("Observer")).toBeNull();
    press("Step 4, person, Needs you");
    expect(screen.getAllByText("Observer").length).toBe(3);
    expect(screen.getAllByText("Person").length).toBe(2);
    expect(screen.getByText("JumpCurrentCount gt 0")).toBeTruthy();
    // The open card asks on the step's own row, not in the box.
    expect(screen.queryByText(/Check in PIE/)).toBeNull();
    expect(screen.getByLabelText("Pass step 4")).toBeTruthy();
  });

  it("starts a draft in one press, or with its options", async () => {
    const api = fakeApi();
    api.qaRun.mockResolvedValue({ run: RUNS.armed });
    renderInProject(<QaCard run={RUNS.draft} />, api);
    expect(screen.getByText("Playtest draft")).toBeTruthy();
    expect(screen.getByText("5 steps, 2 judged by a person")).toBeTruthy();
    press("Start playtest");
    expect(api.qaRun).toHaveBeenCalledWith(RUNS.draft.runId, { startPie: true, players: 1, listen: false, record: true });
    await settle();
    expect(screen.getByText("Starting")).toBeTruthy();
  });

  it("offers Start playtest's options: PIE, players, listen server and recording", () => {
    const api = fakeApi();
    renderInProject(<QaCard run={RUNS.draft} />, api);
    press("Start playtest options");
    expect(screen.getByText("Listen server")).toBeTruthy();
    press("Record");
    fireEvent.change(screen.getByLabelText("Players"), { target: { value: "2" } });
    press("Listen server");
    pressText("Start");
    expect(api.qaRun).toHaveBeenCalledWith(RUNS.draft.runId, { startPie: true, players: 2, listen: true, record: false });
  });

  it("edits a draft's steps and saves them", () => {
    const api = fakeApi();
    api.qaSaveScript.mockResolvedValue({ run: RUNS.draft });
    renderInProject(<QaCard run={RUNS.draft} />, api);
    press("Open PT_DoorOpens");
    press("Edit");
    expect(screen.getByLabelText("Edit the playtest")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Step 1 instruction"), { target: { value: "Jump twice" } });
    press("Remove step 5");
    pressText("Save");
    const [runId, steps, map] = api.qaSaveScript.mock.calls[0];
    expect(runId).toBe(RUNS.draft.runId);
    expect(steps).toHaveLength(4);
    expect(steps[0]).toMatchObject({ instruction: "Jump twice", judge: "auto", expect: { value: "JumpCurrentCount", op: "gt", target: 0 } });
    expect(map).toBe("");
  });

  it("deletes a saved script after a second press, or keeps it", async () => {
    const api = fakeApi();
    api.qaPlaytestDelete.mockResolvedValue({ script: RUNS.failed.script });
    renderInProject(<QaCard run={RUNS.failed} />, api);
    press("Delete");
    expect(screen.getByText("Delete this playtest?")).toBeTruthy();
    press("Keep");
    expect(screen.queryByText("Delete this playtest?")).toBeNull();
    press("Delete");
    press("Delete");
    expect(api.qaPlaytestDelete).toHaveBeenCalledWith(RUNS.failed.script);
  });

  it("shows an ended run's outcome, its summary, and edits a failed step's note", () => {
    const api = fakeApi();
    api.qaVerdict.mockResolvedValue({ run: RUNS.failed });
    renderInProject(<QaCard run={RUNS.failed} />, api);
    expect(screen.getByText("2 failed")).toBeTruthy();
    press("Open PT_LandingCheck");
    expect(screen.getByText(/Finished: 2 passed, 2 failed, 1 skipped/)).toBeTruthy();
    expect(screen.getByText("The landing clips through the ledge")).toBeTruthy();
    expect(screen.getByText("results.json")).toBeTruthy();
    press("Edit the note on step 2");
    fireEvent.change(screen.getByLabelText("What went wrong?"), { target: { value: "Clips on the left ledge" } });
    press("Submit");
    expect(api.qaVerdict).toHaveBeenCalledWith(RUNS.failed.runId, 1, "fail", "Clips on the left ledge");
  });

  it("overrides the agent's verdict, and shows what it saw through the tunnel", async () => {
    const api = fakeApi();
    api.qaVerdict.mockResolvedValue({ run: RUNS.judged });
    const transport: Transport = async (_m, path) =>
      path.endsWith("/captures/0")
        ? { status: 200, headers: { "content-type": "image/png" }, body: (async function* () { yield new Uint8Array([137, 80, 78, 71]); })() }
        : { status: 404, headers: {} as Record<string, string>, body: null };
    renderInProject(<QaCard run={RUNS.judged} />, api, fakeProject(transport).project);
    press("Open PT_DoorLooks");
    expect(screen.getByText("Agent")).toBeTruthy();
    press("What the agent saw");
    await settle();
    await settle();
    expect(screen.getByLabelText("door_open_01.png")).toBeTruthy();
    expect(screen.getByText(/could not be read/)).toBeTruthy();
    press("Override step 4 with Skip");
    expect(api.qaVerdict).toHaveBeenCalledWith(RUNS.judged.runId, 3, "skip", undefined);
  });

  it("stops a running run and assigns it to a subagent", () => {
    const api = fakeApi();
    renderInProject(<QaCard run={RUNS.running} />, api);
    expect(screen.getByText("Step 2 of 5: play this step")).toBeTruthy();
    press("Stop playtest PT_JumpCheck");
    expect(api.qaStop).toHaveBeenCalledWith(RUNS.running.runId);
    press("Assign to subagent");
    expect(api.qaAssign).toHaveBeenCalledWith(RUNS.running.runId, null);
  });

  it("reviews a loop that needs the user: its attempts, Undo, Revert every attempt and End loop", async () => {
    const api = fakeApi();
    renderInProject(<QaCard run={RUNS.loopNeedsYou} />, api);
    expect(screen.getByText("Two attempts changed nothing about step 3: the door trigger never fires in PIE.")).toBeTruthy();
    pressText("Review");
    expect(screen.getByText(/The loop is paused after 2 attempts/)).toBeTruthy();
    api.qaRevertLoop.mockResolvedValue({ run: RUNS.loopNeedsYou, outcome: { restored: [], conflicts: [], missing: [] } });
    press("Revert attempt 1");
    expect(api.qaRevertLoop).toHaveBeenCalledWith(RUNS.loopNeedsYou.runId, 1);
    await settle();
    pressText("Revert every attempt");
    expect(api.qaRevertLoop).toHaveBeenCalledWith(RUNS.loopNeedsYou.runId, undefined);
    press("End loop");
    expect(api.qaCancelAssign).toHaveBeenCalledWith(RUNS.loopNeedsYou.runId);
    expect(screen.getByLabelText("Assign again")).toBeTruthy();
  });

  it("draws an away editor's card as last known, its actions off", () => {
    renderInProject(<QaCard run={RUNS.waiting} offline="The editor is not connected" />);
    expect(screen.getByText("Was waiting")).toBeTruthy();
    expect(screen.getByText(/Last known/)).toBeTruthy();
    expect(screen.getByLabelText("Pass step 4").getAttribute("aria-disabled")).toBe("true");
  });

  it("answers a verdict form ue-mcp raised for the run", () => {
    const api = fakeApi();
    api.answerForm.mockResolvedValue(undefined);
    const form = { id: "f1", sessionId: "qa-session", message: `Test script ${RUNS.waiting.script} (run ${RUNS.waiting.runId})`, fields: { step_3: { title: "The door opens without a visible pop", enum: ["pass", "fail", "skip"] } }, at: "2026-11-04T12:00:00Z" } as unknown as PendingForm;
    renderInProject(<QaCard run={RUNS.waiting} form={form} />, api);
    press("Pass step 4");
    expect(api.answerForm).toHaveBeenCalledWith("f1", { action: "accept", content: { step_3: "pass" } });
    expect(api.qaVerdict).not.toHaveBeenCalled();
  });

  it("follows the run's events", () => {
    const finished = { ...RUNS.armed, state: "finished" as const, lastSeq: 10, steps: RUNS.armed.steps.map((x) => ({ ...x, status: "passed" as const })), summary: undefined };
    const live = (events: Array<{ id: number; type: string; at: string; data: Record<string, unknown> }>) => <QaContext.Provider value={{ events, streaming: true, forms: [] }}><QaCard run={RUNS.armed} /></QaContext.Provider>;
    const view = renderInProject(live([]));
    expect(screen.getByText("Starting")).toBeTruthy();
    view.rerender(<ProjectContext.Provider value={view.nav}>{live([{ id: 1, type: "studio.qa.changed", at: "", data: { run: finished } }])}</ProjectContext.Provider>);
    expect(screen.getByText("Passed")).toBeTruthy();
  });

});

const entry = (r: QaRun | null, over: Partial<PlaytestEntry> & { script: string; name: string }): PlaytestEntry => ({ last: r, card: r?.sessionId ? r : null, draft: null, session: r?.sessionId ? { id: "qa-session", title: "Door playtest" } : null, ...over });
const PROJECT: PlaytestEntry[] = [
  entry(RUNS.waiting, { script: RUNS.waiting.script, name: "PT_DoorOpens" }),
  entry(RUNS.running, { script: RUNS.running.script, name: "PT_JumpCheck" }),
  entry({ ...RUNS.failed, sessionId: null }, { script: RUNS.failed.script, name: "PT_LandingCheck" }),
  { script: "/Game/PIEStudio/Scripts/PT_Crouch", name: "PT_Crouch", last: null, card: null, draft: { ...run("draft_crouch", "PT_Crouch", "draft", ["pending"]), sessionId: null }, session: null },
];

describe("PlaytestsScreen", () => {
  it("lists the project's playtests with their filters, Active first when one runs", async () => {
    store.delete(FILTER_KEY);
    const api = fakeApi();
    api.qaPlaytests.mockResolvedValue({ playtests: PROJECT, listed: true });
    renderInProject(<PlaytestsScreen onOpenSession={() => undefined} />, api);
    await settle();
    expect(api.qaPlaytests).toHaveBeenCalledWith(true);
    expect(screen.getByText(/4 in this project/)).toBeTruthy();
    expect(screen.getByText(/· 1 needs you/)).toBeTruthy();
    expect(screen.getByLabelText("Active 2").getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByText("PT_LandingCheck")).toBeNull();
    press("All 4");
    expect(screen.getByText("PT_LandingCheck")).toBeTruthy();
    expect(screen.getByText("PT_Crouch")).toBeTruthy();
    expect(screen.getByText("Never run")).toBeTruthy();
    expect(screen.getByText(/outside Studio/)).toBeTruthy();
    await settle();
    expect(store.get(FILTER_KEY)).toBe("all");
    press("Failing 1");
    expect(screen.getByText("PT_LandingCheck")).toBeTruthy();
    expect(screen.queryByText("PT_DoorOpens")).toBeNull();
  });

  it("opens a row's card in its session", async () => {
    store.set(FILTER_KEY, "all");
    const api = fakeApi();
    api.qaPlaytests.mockResolvedValue({ playtests: PROJECT, listed: true });
    const open = vi.fn();
    renderInProject(<PlaytestsScreen onOpenSession={open} />, api);
    await settle();
    press("Open the card in Door playtest");
    expect(open).toHaveBeenCalledWith("qa-session", RUNS.waiting.runId);
  });

  it("makes a card in a session for a script that has none on its first Start", async () => {
    store.set(FILTER_KEY, "all");
    const api = fakeApi();
    api.qaPlaytests.mockResolvedValue({ playtests: PROJECT, listed: true });
    api.qaPlaytestCard.mockResolvedValue({ run: { ...PROJECT[3].draft!, runId: "card-crouch", sessionId: "s-new" } });
    api.qaRun.mockResolvedValue({ run: RUNS.armed });
    renderInProject(<PlaytestsScreen onOpenSession={() => undefined} />, api);
    await settle();
    const starts = screen.getAllByLabelText("Start playtest");
    fireEvent.click(starts[starts.length - 1]);
    await settle();
    expect(api.qaPlaytestCard).toHaveBeenCalledWith("/Game/PIEStudio/Scripts/PT_Crouch");
    expect(api.qaRun).toHaveBeenCalledWith("card-crouch", { startPie: true, players: 1, listen: false, record: true });
  });

  it("says when the editor cannot list scripts, disables the cards, and reads the list again on Refresh", async () => {
    store.set(FILTER_KEY, "all");
    const api = fakeApi();
    api.qaPlaytests.mockResolvedValue({ playtests: PROJECT.slice(0, 2), listed: false });
    renderInProject(<PlaytestsScreen onOpenSession={() => undefined} />, api);
    await settle();
    expect(screen.getByText(/The editor is not connected: scripts that have never run are missing/)).toBeTruthy();
    expect(screen.getByText(/2 last known/)).toBeTruthy();
    expect(screen.getByText("Was waiting")).toBeTruthy();
    press("Refresh: list the project's scripts again");
    expect(api.qaPlaytests).toHaveBeenCalledTimes(2);
  });

  it("shows the empty project, the loading line and an error", async () => {
    store.set(FILTER_KEY, "all");
    const api = fakeApi();
    let fail: (e: Error) => void = () => undefined;
    api.qaPlaytests.mockReturnValueOnce(new Promise((_r, j) => (fail = j)));
    const view = renderInProject(<PlaytestsScreen onOpenSession={() => undefined} onChat={() => undefined} />, api);
    expect(screen.getByText("Loading playtests")).toBeTruthy();
    await act(async () => fail(new Error("Studio is not reachable")));
    expect(screen.getByText("Studio is not reachable")).toBeTruthy();
    view.unmount();
    api.qaPlaytests.mockResolvedValue({ playtests: [], listed: true });
    renderInProject(<PlaytestsScreen onOpenSession={() => undefined} onChat={() => undefined} />, api);
    await settle();
    expect(screen.getByText("No playtests yet")).toBeTruthy();
    expect(screen.getByText("Go to Chat")).toBeTruthy();
  });

  it("reads the list again once runs change", async () => {
    store.set(FILTER_KEY, "all");
    const api = fakeApi();
    api.qaPlaytests.mockResolvedValue({ playtests: PROJECT, listed: true });
    const { project, emit } = fakeProject();
    renderInProject(<PlaytestsScreen onOpenSession={() => undefined} />, api, project);
    await settle();
    expect(api.qaPlaytests).toHaveBeenCalledTimes(1);
    emit("studio.qa.changed", { run: RUNS.waiting });
    await act(async () => void (await new Promise((r) => setTimeout(r, 900))));
    expect(api.qaPlaytests).toHaveBeenCalledTimes(2);
  });
});

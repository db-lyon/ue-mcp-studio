// @vitest-environment jsdom
/**
 * The Arrangement's transport: Play and Space audition from the playhead
 * without queuing a run, Run queues a test with the chosen runner, and a take
 * recorded on the armed track lands on it at the playhead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Arrangement, ArrangementView, HubOverview } from "ue-mcp/daemon";

const m = vi.hoisted(() => ({
  arrangement: vi.fn(),
  putArrangement: vi.fn(),
  performers: vi.fn(),
  playState: vi.fn(),
  play: vi.fn(),
  stopPlay: vi.fn(),
  recordStart: vi.fn(),
  recordStop: vi.fn(),
  recordState: vi.fn(),
}));
vi.mock("../../api", () => ({ api: { hub: m } }));
import { HubContext, type HubContextValue } from "./state";
import { ArrangementScreen } from "./Arrangement";

const A: Arrangement = {
  id: "arena", title: "Arena", level: null, rate: 60,
  tracks: [
    { id: "t1", title: "Player", performer: { kind: "player", client: 0 }, mute: false, solo: false, instances: [] },
    { id: "t2", title: "Client 1", performer: { kind: "player", client: 1 }, mute: false, solo: false, instances: [] },
  ],
  checks: [{ id: "c1", title: "Alive", at: 0, length: 120, mode: "throughout", expect: { value: "pawn.alive", op: "==", target: true } }],
  regions: [],
};
const VIEW: ArrangementView = { arrangement: A, length: 120, findings: [], clips: {}, tests: [] };
const O = { clips: [], arrangements: [], suites: [], tests: [], recent: [], schedules: [], problems: [], lease: null, queue: { paused: false, waiting: [], running: [], queued: [] } } as unknown as HubOverview;
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

let ctx: HubContextValue;
function mount() {
  ctx = { o: O, data: { overview: O, error: null, version: 1, reload: vi.fn() }, route: { screen: "arrangement", id: "arena" }, go: vi.fn(), narrow: false, notify: vi.fn(), run: vi.fn(async () => undefined) };
  return render(<HubContext.Provider value={ctx}><ArrangementScreen id="arena" runId={null} /></HubContext.Provider>);
}

beforeEach(() => {
  m.arrangement.mockResolvedValue(VIEW);
  m.putArrangement.mockImplementation(async (a: Arrangement) => ({ ...VIEW, arrangement: a }));
  m.performers.mockResolvedValue({ performers: [] });
  m.playState.mockResolvedValue(null);
  m.play.mockResolvedValue({ playId: "p1", test: "arena", from: 0, loop: false, startedAt: "", state: "running", checks: [] });
  m.recordStart.mockResolvedValue({ recording: true });
  m.recordState.mockResolvedValue(null);
  m.recordStop.mockResolvedValue({ id: "take", title: "Take", performer: "player", rate: 60, length: 90, input: [] });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the Arrangement's transport", () => {
  it("auditions from the playhead on Space and Play, and Run queues with the chosen runner", async () => {
    mount();
    await flush();
    fireEvent.keyDown(window, { key: " " });
    await flush();
    expect(m.play).toHaveBeenCalledWith({ test: "arena", from: 0 });
    expect(screen.getByText("Auditioning")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Where it runs"), { target: { value: "headless" } });
    m.stopPlay.mockResolvedValue({ playId: "p1", test: "arena", from: 0, loop: false, startedAt: "", state: "stopped", checks: [] });
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(ctx.run).toHaveBeenCalledWith({ test: "arena", runner: "headless" }, "Arena");
  });

  it("records a take on the armed player track and places it at the playhead", async () => {
    mount();
    await flush();
    expect((screen.getByLabelText("Arm for recording: Client 1") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Arm for recording: Player"));
    fireEvent.click(screen.getByRole("button", { name: "Record" }));
    await flush();
    expect(m.recordStart).toHaveBeenCalledWith({ performer: { kind: "player", client: 0 }, rate: 60, arrangement: "arena", track: "t1", at: 0 });
    expect(screen.getByText("Recording Player")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
    await flush();
    expect(m.recordStop).toHaveBeenCalledWith({ title: "Take" });
    await act(async () => void (await new Promise((r) => setTimeout(r, 250))));
    const saved = m.putArrangement.mock.calls.at(-1)![0] as Arrangement;
    expect(saved.tracks[0]!.instances).toEqual([{ id: "i1", clip: "take", at: 0 }]);
    expect(ctx.notify).toHaveBeenCalledWith("Take is on Player");
  });

  it("picks a recording back up after a reload and still places the take on its track", async () => {
    m.recordState.mockResolvedValue({ performer: { kind: "player", client: 0 }, rate: 60, startedAt: new Date(Date.now() - 1000).toISOString(), arrangement: "arena", track: "t1", at: 30 });
    mount();
    await flush();
    await flush();
    expect(screen.getByText("Recording Player")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
    await flush();
    expect(m.recordStop).toHaveBeenCalledWith({ title: "Take" });
    await act(async () => void (await new Promise((r) => setTimeout(r, 250))));
    const saved = m.putArrangement.mock.calls.at(-1)![0] as Arrangement;
    expect(saved.tracks[0]!.instances).toEqual([{ id: "i1", clip: "take", at: 30 }]);
  });

  it("leaves a recording of another arrangement alone", async () => {
    m.recordState.mockResolvedValue({ performer: { kind: "player", client: 0 }, startedAt: new Date().toISOString(), arrangement: "other", track: "t1", at: 0 });
    mount();
    await flush();
    await flush();
    expect(screen.queryByText("Recording Player")).toBeNull();
  });
});

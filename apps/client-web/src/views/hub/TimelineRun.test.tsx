// @vitest-environment jsdom
/**
 * Playing and recording a timeline playtest: Play a region, the cursor and
 * check results from clip.* events, a manual check's verdict, polling when
 * the daemon has no clip events, recording with armed tracks and the take
 * drawn live, and run history missing from an older ue-mcp.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import type { DaemonEvent } from "ue-mcp/daemon";
import type { Clip, HubOverview } from "@ue-mcp-studio/shared";

const m = vi.hoisted(() => ({
  hub: { overview: vi.fn(), check: vi.fn(), runs: vi.fn(), runCheck: vi.fn(), plan: vi.fn(), resultsUrl: (id: string) => `/r/${id}` },
  clips: { list: vi.fn(), create: vi.fn(), read: vi.fn(), update: vi.fn(), edit: vi.fn(), run: vi.fn(), record: vi.fn(), recordStop: vi.fn(), stop: vi.fn(), status: vi.fn(), verdict: vi.fn(), runs: vi.fn() },
}));
vi.mock("../../api", () => {
  class ApiError extends Error {
    constructor(readonly status: number, message: string, readonly body?: unknown) {
      super(message);
    }
  }
  return { ApiError, api: { hub: m.hub, clips: m.clips, settings: () => new Promise(() => {}), agentSettings: () => new Promise(() => {}) } };
});
import { HubView } from "./Hub";
import type { HubData } from "./state";
import { hubFixture } from "./test-data";

const PATH = "/Game/PIEStudio/Clips/CL_Door";
const MOVE = "/Game/Input/IA_Move.IA_Move";
const JUMP = "/Game/Input/IA_Jump.IA_Jump";
const CLIP: Clip = {
  rate: 60,
  regions: [{ id: "r1", name: "Walk", start: 0, end: 120 }, { id: "r2", name: "Door", start: 120, end: 240 }],
  tracks: [{ action: MOVE, type: "axis2d", keys: [{ id: "k1", t: 0, v: [0, 1] }] }, { action: JUMP, type: "bool", notes: [{ id: "n1", start: 40, length: 6 }] }],
  checks: [
    { id: "c1", start: 0, length: 100, mode: "by_end", expect: { value: "pos_x", op: "increasing", target: 200 } },
    { id: "c2", start: 120, length: 0, mode: "hold", expect: { value: "speed2d", op: "lt", target: 1 } },
    { id: "c4", start: 200, length: 30, mode: "hold", manual: true, instruction: "The door swings open without a pop" },
  ],
};

let setEvents: (e: DaemonEvent[]) => void = () => {};
function Harness({ features }: { features: string[] }) {
  const [overview, setOverview] = useState<HubOverview | null>(hubFixture());
  const [events, set] = useState<DaemonEvent[]>([]);
  setEvents = set;
  const data: HubData = { overview, error: null, version: 0, reload: () => {}, patch: (f) => setOverview((o) => (o ? f(o) : o)) };
  return <HubView data={data} narrow={false} onOpenChat={() => {}} events={events} health={{ features }} />;
}
let n = 0;
const ev = (type: string, data: Record<string, unknown>): DaemonEvent => ({ id: ++n, type, at: "", data: { runId: "clip-1", clip: PATH, seq: n, ...data } });

beforeEach(() => {
  for (const f of [...Object.values(m.hub), ...Object.values(m.clips)]) if (typeof f === "function" && "mockReset" in f) (f as ReturnType<typeof vi.fn>).mockReset();
  m.clips.read.mockResolvedValue({ path: PATH, clip: CLIP, warnings: [] });
  m.clips.status.mockRejectedValue(new Error("no run"));
  m.clips.runs.mockResolvedValue({ runs: [] });
  window.location.hash = `#/playtests/clips/${encodeURIComponent(PATH)}`;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.location.hash = "";
});

describe("playing", () => {
  it("plays one region and follows the run on clip events: cursor, results and a verdict", async () => {
    render(<Harness features={["events.clip"]} />);
    await screen.findByRole("heading", { name: "CL_Door" });
    m.clips.run.mockResolvedValue({ run_id: "clip-1", clip: PATH, state: "running" });
    fireEvent.change(screen.getByRole("combobox", { name: "Play" }), { target: { value: "r2" } });
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    await waitFor(() => expect(m.clips.run).toHaveBeenCalledWith(PATH, "r2"));

    setEvents([ev("clip.run_started", { mode: "play" }), ev("clip.position", { position: 130, length: 240, state: "running", holding: "c2" })]);
    expect(await screen.findByText("Waiting at check c2 until its condition is true")).toBeTruthy();
    expect(document.querySelector(".hub-clip-cursor")).toBeTruthy();

    setEvents([
      ev("clip.check", { check: { id: "c2", status: "passed" } }),
      ev("clip.check", { check: { id: "c1", status: "failed", evidence: { reason: "pos_x rose 120, short of 200" } } }),
      ev("clip.verdict_requested", { awaiting: ["c4"] }),
    ]);
    await waitFor(() => expect(document.querySelector(".hub-clip-check.st-passed")).toBeTruthy());
    expect(document.querySelector(".hub-clip-check.st-failed")).toBeTruthy();

    m.clips.verdict.mockResolvedValue({ run_id: "clip-1", clip: PATH, state: "running", awaiting: [] });
    const card = await screen.findByRole("group", { name: "Waiting for your verdict" });
    expect(card.textContent).toContain("The door swings open without a pop");
    fireEvent.change(screen.getByRole("textbox", { name: "Note (optional)" }), { target: { value: "Smooth" } });
    fireEvent.click(screen.getByRole("button", { name: "Pass" }));
    await waitFor(() => expect(m.clips.verdict).toHaveBeenCalledWith("c4", "pass", "Smooth"));

    m.clips.runs.mockResolvedValue({ runs: [{ run_id: "clip-1", passed: false, state: "finished", region: "r2", mode: "play", summary: { total: 2, failed: 1 } }] });
    setEvents([ev("clip.run_finished", { state: "finished", passed: false, summary: { total: 2, failed: 1 } })]);
    expect(await screen.findByText("Failed 1 of 2 checks")).toBeTruthy();
    expect(screen.getByText(/pos_x rose 120, short of 200/)).toBeTruthy();
    // The history picks up the run once it ends.
    await waitFor(() => expect(m.clips.runs).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/Played · Door/)).toBeTruthy();
  });

  it("polls clip_status while a run plays when the daemon has no clip events", async () => {
    render(<Harness features={[]} />);
    await screen.findByRole("heading", { name: "CL_Door" });
    m.clips.run.mockResolvedValue({ run_id: "clip-1", clip: PATH, state: "running", position: 0, length: 240 });
    m.clips.status.mockResolvedValue({ run_id: "clip-1", clip: PATH, state: "running", position: 61, length: 240 });
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(await screen.findByText("Playing frame 61 of 240", undefined, { timeout: 2000 })).toBeTruthy();
    expect(m.clips.status).toHaveBeenCalledWith("clip-1");
  });

  it("says plainly when ue-mcp keeps no run history", async () => {
    m.clips.runs.mockResolvedValue({ runs: null });
    render(<Harness features={["events.clip"]} />);
    expect(await screen.findByText("Past runs need a newer ue-mcp. Update it in Settings, under Updates.")).toBeTruthy();
  });
});

describe("recording", () => {
  it("records into the armed tracks from a hold check and draws the take as it arrives", async () => {
    render(<Harness features={["events.clip", "events.clip.take"]} />);
    await screen.findByRole("heading", { name: "CL_Door" });
    fireEvent.click(screen.getByRole("checkbox", { name: /IA_Move/ }));
    fireEvent.change(screen.getByRole("combobox", { name: /Punch in at/ }), { target: { value: "c:c2" } });
    m.clips.record.mockResolvedValue({ run_id: "clip-1", clip: PATH, mode: "record", state: "running" });
    fireEvent.click(screen.getByRole("button", { name: "Record" }));
    await waitFor(() => expect(m.clips.record).toHaveBeenCalledWith({ path: PATH, from_check: "c2", armed: [JUMP] }));

    setEvents([
      ev("clip.run_started", { mode: "record" }),
      ev("clip.position", { position: 150, length: 240, state: "running" }),
      ev("clip.take_progress", { takeId: "t1", punchIn: 120, tracks: [{ action: "/Game/Input/IA_Jump", type: "bool", notes: [{ start: 140, length: 4, open: true }], keys: [], keysFrom: 0 }] }),
    ]);
    expect(await screen.findByText("Recording at frame 150")).toBeTruthy();
    await waitFor(() => expect(document.querySelector(".hub-clip-take.open")).toBeTruthy());

    m.clips.recordStop.mockResolvedValue({});
    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
    await waitFor(() => expect(m.clips.recordStop).toHaveBeenCalled());
    setEvents([ev("clip.run_finished", { state: "stopped", stopReason: "clip_record_stop" })]);
    // The saved take comes back with the clip.
    await waitFor(() => expect(m.clips.read).toHaveBeenCalledTimes(2));
  });

  it("says the take appears once saved when the daemon does not stream it", async () => {
    render(<Harness features={["events.clip"]} />);
    await screen.findByRole("heading", { name: "CL_Door" });
    m.clips.record.mockResolvedValue({ run_id: "clip-1", clip: PATH, mode: "record", state: "running" });
    fireEvent.click(screen.getByRole("button", { name: "Record" }));
    expect(await screen.findByText(/The take appears when it is saved/)).toBeTruthy();
    expect(m.clips.record).toHaveBeenCalledWith({ path: PATH, armed: [MOVE, JUMP] });
  });
});

// @vitest-environment jsdom
/**
 * The Arrangement against stubbed daemon answers: dragging clips in from
 * Clips, moving, trimming and Alt-duplicating instances and moving them to
 * another track, every drag's keyboard equivalent, tracks and scenes (add,
 * rename, color, reorder, mute, solo, player, a scene's tracks), findings
 * with their candidates, and a run's playhead, results and verdicts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import type { DaemonEvent } from "ue-mcp/daemon";
import type { HubOverview, SetAnswer } from "@ue-mcp-studio/shared";

const m = vi.hoisted(() => ({
  hub: { overview: vi.fn(), cancelPlan: vi.fn(), resultsUrl: (id: string) => `/r/${id}` },
  set: { read: vi.fn(), edit: vi.fn(), clips: vi.fn(), run: vi.fn(), runDetail: vi.fn(), verdict: vi.fn() },
  // The piano roll a double-click opens; it never answers here.
  clips: { read: () => new Promise(() => {}), runs: () => new Promise(() => {}), status: () => new Promise(() => {}) },
}));
vi.mock("../../api", () => {
  class ApiError extends Error {
    constructor(readonly status: number, message: string, readonly body?: unknown) {
      super(message);
    }
  }
  return { ApiError, api: { hub: m.hub, set: m.set, clips: m.clips, settings: () => new Promise(() => {}), agentSettings: () => new Promise(() => {}) } };
});
import { ApiError } from "../../api";
import { HubView } from "./Hub";
import type { HubData } from "./state";
import { hubFixture } from "./test-data";

// jsdom has neither PointerEvent nor DragEvent; these carry the position and keys the timelines read.
if (typeof window.PointerEvent === "undefined") {
  class PointerEventShim extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
    }
  }
  (window as unknown as { PointerEvent: unknown }).PointerEvent = PointerEventShim;
}
if (typeof (window as unknown as { DragEvent?: unknown }).DragEvent === "undefined") {
  (window as unknown as { DragEvent: unknown }).DragEvent = class extends MouseEvent {};
}

const WALK = "/Game/Clips/CL_Walk";
const PATROL = "/Game/Clips/CL_Patrol";
const DOOR = "/Game/Tests/PT_Door";
const lay = (id: string, kind: "clip" | "script", target: string, start: number, length: number) => ({ id, kind, target, name: target.split("/").pop()!, start, end: start + length, length, known: true });
function setFixture(): SetAnswer {
  return {
    rate: 60,
    text: "",
    findings: [],
    tracks: [
      { id: "walk", title: "Walk", order: 0, color: "green", player: 0, mute: false, solo: false, status: "failing",
        arrangement: { rate: 60, instances: [{ id: "i1", kind: "clip", target: WALK, start: 0, in: 0 }, { id: "i2", kind: "script", target: DOOR, start: 240, length: 600 }] },
        layout: [lay("i1", "clip", WALK, 0, 240), lay("i2", "script", DOOR, 240, 600)] },
      { id: "guard", title: "Guard", order: 1, player: 1, mute: false, solo: false, status: "not_started", arrangement: { rate: 60, instances: [] }, layout: [] },
    ],
    scenes: [
      { id: "boss", title: "Boss fight", order: 0, color: "orange", status: "failing", tracks: ["walk"] },
      { id: "calm", title: "Calm", order: 1, status: "not_started", tracks: [] },
    ],
  };
}

let setEvents: (e: DaemonEvent[]) => void = () => {};
let setOverview: (f: (o: HubOverview) => HubOverview) => void = () => {};
function Harness({ features = ["hub", "hub.arrangement", "events.clip"] }: { features?: string[] }) {
  const [overview, set] = useState<HubOverview | null>(hubFixture());
  const [events, setE] = useState<DaemonEvent[]>([]);
  setEvents = setE;
  setOverview = (f) => set((o) => (o ? f(o) : o));
  const data: HubData = { overview, error: null, version: 0, reload: () => {}, patch: (f) => set((o) => (o ? f(o) : o)) };
  return <HubView data={data} narrow={false} onOpenChat={() => {}} events={events} health={{ features }} />;
}

const surface = () => screen.getByRole("group", { name: "Arrangement" });
const lastLines = (): string => m.set.edit.mock.calls[m.set.edit.mock.calls.length - 1][0].join("\n");
const dt = (data: Record<string, string>) => ({ types: Object.keys(data), getData: (t: string) => data[t] ?? "", setData: () => {} });
const block = (name: RegExp) => screen.findByRole("button", { name });
const pick = async (name: RegExp) => {
  const b = await block(name);
  fireEvent.pointerDown(b, { button: 0, clientX: 0 });
  fireEvent.pointerUp(b, { clientX: 0 });
};

beforeEach(() => {
  for (const f of [...Object.values(m.hub), ...Object.values(m.set)] as unknown[]) if (typeof f === "function" && "mockReset" in f) (f as ReturnType<typeof vi.fn>).mockReset();
  m.set.read.mockResolvedValue(setFixture());
  m.set.edit.mockImplementation(async () => ({ ...setFixture(), changed: ["i3"] }));
  m.set.clips.mockResolvedValue({ clips: [
    { kind: "clip", target: PATROL, name: "CL_Patrol", length: 120, rate: 30, lastRun: null },
    { kind: "script", target: DOOR, name: "PT_Door", length: null, rate: 60, lastRun: { runId: "r", outcome: "passed", at: "" } },
  ] });
  m.set.run.mockResolvedValue({ plan: { id: "p1", title: "Arrangement", items: [] }, placement: { state: "started", position: 0, ahead: 0 } });
  m.set.verdict.mockResolvedValue({});
  window.location.hash = "#/playtests/arrangement";
});
afterEach(() => {
  cleanup();
  window.location.hash = "";
});

describe("feature", () => {
  it("hides the Arrangement from the rail and says why on its screen when the daemon has no set routes", async () => {
    render(<Harness features={["hub"]} />);
    expect(await screen.findByText("Update ue-mcp to use the Arrangement.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /^Arrangement/ })).toBeNull();
    expect(m.set.read).not.toHaveBeenCalled();
  });
  it("is in the rail, with its own history entry", async () => {
    window.location.hash = "#/playtests";
    render(<Harness />);
    fireEvent.click(await screen.findByRole("link", { name: /^Arrangement/ }));
    await waitFor(() => expect(window.location.hash).toBe("#/playtests/arrangement"));
    expect(await block(/^CL_Walk, 0 s to 4 s/)).toBeTruthy();
  });
});

describe("timelines", () => {
  it("moves, trims and Alt-duplicates by dragging, and drags to another track", async () => {
    render(<Harness />);
    const walk = await block(/^CL_Walk, 0 s to 4 s/);
    // 80 px a second: 40 px is half a second, 30 frames.
    fireEvent.pointerDown(walk, { button: 0, clientX: 100, clientY: 10 });
    fireEvent.pointerMove(walk, { clientX: 140, clientY: 10 });
    fireEvent.pointerUp(walk, { clientX: 140, clientY: 10 });
    await waitFor(() => expect(lastLines()).toBe("move walk/i1 to 30"));
    fireEvent.pointerDown(walk.querySelector("[data-edge=end]")!, { button: 0, clientX: 300, clientY: 10 });
    fireEvent.pointerMove(walk, { clientX: 260, clientY: 10 });
    fireEvent.pointerUp(walk, { clientX: 260, clientY: 10 });
    await waitFor(() => expect(lastLines()).toBe("trim walk/i1 out=210"));
    const door = await block(/^PT_Door, /);
    fireEvent.pointerDown(door.querySelector("[data-edge=start]")!, { button: 0, clientX: 400, clientY: 10 });
    fireEvent.pointerMove(door, { clientX: 440, clientY: 10 });
    fireEvent.pointerUp(door, { clientX: 440, clientY: 10 });
    await waitFor(() => expect(lastLines()).toBe("trim walk/i2 length=570\nmove walk/i2 by 30"));
    fireEvent.pointerDown(walk, { button: 0, clientX: 100, clientY: 10, altKey: true });
    fireEvent.pointerMove(walk, { clientX: 1300, clientY: 10 });
    fireEvent.pointerUp(walk, { clientX: 1300, clientY: 10 });
    await waitFor(() => expect(lastLines()).toBe("duplicate walk/i1 at 900"));
    fireEvent.pointerDown(walk, { button: 0, clientX: 100, clientY: 10 });
    fireEvent.pointerMove(walk, { clientX: 100, clientY: 54 });
    fireEvent.pointerUp(walk, { clientX: 100, clientY: 54 });
    await waitFor(() => expect(lastLines()).toBe("move walk/i1 to guard at 0"));
  });

  it("trims a clip in its own frames, at the rate the layout gives", async () => {
    const f = setFixture();
    f.tracks[0].layout[0] = { ...f.tracks[0].layout[0], clipRate: 30, clipLength: 120 };
    m.set.read.mockResolvedValue(f);
    render(<Harness />);
    await pick(/^CL_Walk/);
    // A quarter second off the end is 15 track frames, 7.5 of the clip's own at 30 a second.
    fireEvent.keyDown(surface(), { key: "ArrowLeft", altKey: true });
    await waitFor(() => expect(lastLines()).toBe("trim walk/i1 out=112.5"));
  });

  it("drops a clip from Clips onto a timeline at the drop position", async () => {
    render(<Harness />);
    await block(/^CL_Walk/);
    fireEvent.drop(screen.getByRole("group", { name: "Guard" }), { clientX: 160, dataTransfer: dt({ "application/x-ue-mcp-clip": JSON.stringify({ kind: "script", target: DOOR }) }) });
    await waitFor(() => expect(lastLines()).toBe(`add guard script ${DOOR} at 120`));
  });

  it("does every timeline drag from the keyboard, and copy, paste and I", async () => {
    render(<Harness />);
    await pick(/^CL_Walk/);
    const s = surface();
    fireEvent.keyDown(s, { key: "ArrowRight" });
    await waitFor(() => expect(lastLines()).toBe("move walk/i1 to 15"));
    fireEvent.keyDown(s, { key: "ArrowRight", shiftKey: true });
    await waitFor(() => expect(lastLines()).toBe("move walk/i1 to 60"));
    fireEvent.keyDown(s, { key: "ArrowLeft", altKey: true });
    await waitFor(() => expect(lastLines()).toBe("trim walk/i1 out=225"));
    fireEvent.keyDown(s, { key: "ArrowRight", altKey: true, shiftKey: true });
    await waitFor(() => expect(lastLines()).toBe("trim walk/i1 in=15\nmove walk/i1 by 15"));
    fireEvent.keyDown(s, { key: "ArrowDown" });
    await waitFor(() => expect(lastLines()).toBe("move walk/i1 to guard at 0"));
    // The answer is the truth: the stub still has i1 on Walk.
    await pick(/^CL_Walk/);
    fireEvent.keyDown(s, { key: "d", ctrlKey: true });
    await waitFor(() => expect(lastLines()).toBe("duplicate walk/i1"));
    await pick(/^CL_Walk/);
    fireEvent.keyDown(s, { key: "c", ctrlKey: true });
    fireEvent.keyDown(s, { key: "Delete" });
    await waitFor(() => expect(lastLines()).toBe("delete walk/i1"));
    // Track selected, playhead at one second: paste the copy there, then add the clip picked in Clips.
    fireEvent.click(screen.getByRole("button", { name: "Guard", pressed: false }));
    fireEvent.keyDown(s, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(s, { key: "v", ctrlKey: true });
    await waitFor(() => expect(lastLines()).toBe("copy walk/i1 to guard at 60"));
    fireEvent.click(await screen.findByRole("button", { name: /CL_Patrol/ }));
    fireEvent.keyDown(s, { key: "i" });
    await waitFor(() => expect(lastLines()).toBe(`add guard clip ${PATROL} at 60`));
  });

  it("renames with F2, colors and makes unique", async () => {
    render(<Harness />);
    await pick(/^CL_Walk/);
    fireEvent.keyDown(surface(), { key: "F2" });
    const name = screen.getByLabelText("Name") as HTMLInputElement;
    expect(document.activeElement).toBe(name);
    fireEvent.change(name, { target: { value: "Walk in" } });
    fireEvent.blur(name);
    await waitFor(() => expect(lastLines()).toBe('rename walk/i1 "Walk in"'));
    fireEvent.click(screen.getByRole("button", { name: "Teal" }));
    await waitFor(() => expect(lastLines()).toBe("color walk/i1 teal"));
    fireEvent.click(screen.getByRole("button", { name: "Make unique" }));
    await waitFor(() => expect(lastLines()).toBe("unique walk/i1"));
  });

  it("replaces a clip from Clips by dropping it on a block, with R, or from the inspector", async () => {
    render(<Harness />);
    const walk = await block(/^CL_Walk/);
    fireEvent.drop(walk, { clientX: 0, dataTransfer: dt({ "application/x-ue-mcp-clip": JSON.stringify({ kind: "clip", target: PATROL }) }) });
    await waitFor(() => expect(lastLines()).toBe(`retarget walk/i1 ${PATROL}`));
    // The drop did not also add the clip to the lane under the block.
    expect(m.set.edit.mock.calls.flatMap((c) => c[0])).not.toContain(`add walk clip ${PATROL} at 0`);
    await pick(/^CL_Walk/);
    const clips = screen.getByRole("region", { name: "Clips" });
    fireEvent.click(await within(clips).findByRole("button", { name: /^PT_Door/ }));
    fireEvent.click(screen.getByRole("button", { name: "Replace with PT_Door" }));
    await waitFor(() => expect(lastLines()).toBe(`retarget walk/i1 script ${DOOR}`));
    fireEvent.click(within(clips).getByRole("button", { name: /^CL_Patrol/ }));
    fireEvent.keyDown(surface(), { key: "r" });
    await waitFor(() => expect(lastLines()).toBe(`retarget walk/i1 ${PATROL}`));
  });

  it("opens a timeline clip's piano roll on double-click", async () => {
    render(<Harness />);
    fireEvent.doubleClick(await block(/^CL_Walk/));
    await waitFor(() => expect(window.location.hash).toBe(`#/playtests/clips/${encodeURIComponent(WALK)}`));
  });

  it("shows a refusal's findings and retries with a candidate", async () => {
    m.set.edit.mockRejectedValueOnce(new ApiError(400, "refused", {
      error: "refused", finding: { id: "/Game/Clips/CL_Patrl", field: "target", message: "No timeline clip at /Game/Clips/CL_Patrl", candidates: [PATROL], blocks: true }, findings: [],
    }));
    render(<Harness />);
    await block(/^CL_Walk/);
    fireEvent.drop(screen.getByRole("group", { name: "Guard" }), { clientX: 0, dataTransfer: dt({ "application/x-ue-mcp-clip": JSON.stringify({ kind: "clip", target: "/Game/Clips/CL_Patrl" }) }) });
    expect((await screen.findByRole("alert")).textContent).toContain("No timeline clip");
    fireEvent.click(screen.getByRole("button", { name: `Use ${PATROL}` }));
    await waitFor(() => expect(lastLines()).toBe(`add guard clip ${PATROL} at 0`));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});

describe("tracks and scenes", () => {
  it("adds, reorders, mutes, solos and sets a track's player", async () => {
    render(<Harness />);
    await block(/^CL_Walk/);
    const s = surface();
    fireEvent.keyDown(s, { key: "t", ctrlKey: true });
    await waitFor(() => expect(lastLines()).toBe('track add "Track 3"'));
    fireEvent.click(screen.getByRole("button", { name: "Walk", pressed: false }));
    fireEvent.keyDown(s, { key: "ArrowDown", altKey: true });
    await waitFor(() => expect(lastLines()).toBe("track move walk to 1"));
    fireEvent.click(screen.getByRole("button", { name: "Mute Guard" }));
    await waitFor(() => expect(lastLines()).toBe("track mute guard on"));
    fireEvent.click(screen.getByRole("button", { name: "Solo Walk" }));
    await waitFor(() => expect(lastLines()).toBe("track solo walk on"));
    fireEvent.change(screen.getByLabelText("Player for Walk"), { target: { value: "2" } });
    await waitFor(() => expect(lastLines()).toBe("track player walk 2"));
    fireEvent.keyDown(s, { key: "Enter" });
    await waitFor(() => expect(m.set.run).toHaveBeenCalledWith({ kind: "track", goalId: "walk" }));
  });

  it("lists scenes, plays one, and edits its tracks, name, color, order and copies", async () => {
    render(<Harness />);
    await block(/^CL_Walk/);
    fireEvent.click(screen.getByRole("button", { name: "Play Boss fight" }));
    await waitFor(() => expect(m.set.run).toHaveBeenCalledWith({ kind: "scene", goalId: "boss" }));
    fireEvent.click(screen.getByRole("button", { name: "Boss fight", pressed: false }));
    const guardIn = screen.getByRole("checkbox", { name: "Guard plays in Boss fight" }) as HTMLInputElement;
    expect(guardIn.checked).toBe(false);
    expect((screen.getByRole("checkbox", { name: "Walk plays in Boss fight" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(guardIn);
    await waitFor(() => expect(lastLines()).toBe("scene track boss add guard"));
    const s = surface();
    fireEvent.keyDown(s, { key: "F2" });
    const name = screen.getByLabelText("Name") as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Boss rush" } });
    fireEvent.blur(name);
    await waitFor(() => expect(lastLines()).toBe('scene rename boss "Boss rush"'));
    fireEvent.click(screen.getByRole("button", { name: "Pink" }));
    await waitFor(() => expect(lastLines()).toBe("scene color boss pink"));
    fireEvent.keyDown(s, { key: "ArrowDown", altKey: true });
    await waitFor(() => expect(lastLines()).toBe("scene move boss to 1"));
    fireEvent.keyDown(s, { key: "d", ctrlKey: true });
    await waitFor(() => expect(lastLines()).toBe("scene duplicate boss"));
    fireEvent.keyDown(s, { key: "i", ctrlKey: true });
    await waitFor(() => expect(lastLines()).toBe('scene insert "Scene 3" at 0'));
    fireEvent.keyDown(s, { key: "Enter" });
    await waitFor(() => expect(m.set.run).toHaveBeenLastCalledWith({ kind: "scene", goalId: "boss" }));
  });

  it("deletes a track or scene through its op after a confirmation, and keeps a refusal in the dialog", async () => {
    render(<Harness />);
    await block(/^CL_Walk/);
    fireEvent.click(screen.getByRole("button", { name: "Walk", pressed: false }));
    fireEvent.keyDown(surface(), { key: "Delete" });
    const dialog = await screen.findByRole("dialog", { name: 'Delete the track "Walk"?' });
    // Boss fight plays Walk, so the dialog names it.
    expect(within(dialog).getByRole("list").textContent).toContain("Boss fight");
    m.set.edit.mockRejectedValueOnce(new ApiError(400, "refused", { error: "refused", finding: { id: "walk", field: "delete", message: '"Walk" can\'t be deleted while a run made for it is queued or running', blocks: true } }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete track" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("can't be deleted while a run made for it is queued or running");
    expect(lastLines()).toBe("track delete walk");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete track" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(m.hub.overview).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Calm", pressed: false }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: 'Delete the scene "Calm"?' })).getByRole("button", { name: "Delete scene" }));
    await waitFor(() => expect(lastLines()).toBe("scene delete calm"));
  });
});

describe("runs", () => {
  it("plays every timeline and follows the run: playhead, results, Stop and a verdict", async () => {
    m.set.runDetail.mockResolvedValue({ record: {}, run: null, steps: [], arrangement: {
      kind: "arrangement", rate: 60, length: 840, tracks: [{ goalId: "walk", title: "Walk", player: 0, status: "running" }],
      instances: [
        { key: "walk-i1", goalId: "walk", id: "i1", kind: "clip", target: WALK, name: "CL_Walk", player: 0, start: 0, end: 240, status: "awaiting_verdict", checks: { total: 1, passed: 0, failed: 0, pending: 0, awaiting: 1 }, awaiting: [{ check: "walk-i1.c4", instruction: "Does the door glow?" }], segmentRunId: "c1" },
        { key: "walk-i2", goalId: "walk", id: "i2", kind: "script", target: DOOR, name: "PT_Door", player: 0, start: 240, end: 840, status: "pending", checks: { total: 0, passed: 0, failed: 0, pending: 0, awaiting: 0 }, segmentRunId: null },
      ],
      segments: [{ index: 0, kind: "clip", runId: "c1", offset: 0, length: 240, state: "running" }],
    } });
    m.hub.cancelPlan.mockResolvedValue({});
    m.set.run.mockResolvedValue({ plan: { id: "p1", title: "Arrangement", items: [] }, placement: { state: "started", position: 0, ahead: 0 }, runId: "run-9" });
    render(<Harness />);
    await block(/^CL_Walk/);
    fireEvent.keyDown(surface(), { key: " " });
    await waitFor(() => expect(m.set.run).toHaveBeenCalledWith({ kind: "arrangement" }));
    // The run's id comes from the run route's answer; the queue's item has not recorded it yet.
    act(() => setOverview((o) => ({ ...o, queue: { ...o.queue, current: { id: "p1", title: "Arrangement", scope: { kind: "arrangement" }, items: [{ check: { kind: "script", target: "arrangement" }, name: "Arrangement", state: "running", runId: null }] } as never } })));
    await waitFor(() => expect(m.set.runDetail).toHaveBeenCalledWith("run-9"));
    await waitFor(() => expect((screen.getAllByRole("button", { name: /^CL_Walk, / })[0]).className).toContain("st-awaiting_verdict"));
    act(() => setEvents([{ id: 1, type: "clip.position", at: "", data: { runId: "c1", position: 120 } }] as DaemonEvent[]));
    const cursor = await waitFor(() => {
      const c = document.querySelector(".hub-set-cursor") as HTMLElement | null;
      expect(c).toBeTruthy();
      return c!;
    });
    expect(cursor.style.left).toBe("160px");
    const card = await screen.findByRole("group", { name: "CL_Walk needs your verdict" });
    expect(card.textContent).toContain("Does the door glow?");
    fireEvent.click(card.querySelector("button")!);
    await waitFor(() => expect(m.set.verdict).toHaveBeenCalledWith("run-9", "walk-i1.c4", "pass", undefined));
    fireEvent.keyDown(surface(), { key: " " });
    await waitFor(() => expect(m.hub.cancelPlan).toHaveBeenCalledWith("p1"));
  });
});

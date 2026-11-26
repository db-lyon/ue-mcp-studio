// @vitest-environment jsdom
/**
 * Timeline playtests on the hub: reached from the playtest editor with Back
 * returning there, a clip created by name, notes drawn and moved through
 * clip_edit, undo and redo through its rollback, keyboard delete, and a
 * warning's candidate applied as a fix.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Profiler, useState } from "react";
import type { Clip, HubOverview } from "@ue-mcp-studio/shared";

const m = vi.hoisted(() => ({
  hub: { overview: vi.fn(), check: vi.fn(), runs: vi.fn(), runCheck: vi.fn(), plan: vi.fn(), resultsUrl: (id: string) => `/r/${id}` },
  drafting: { catalog: vi.fn(), script: vi.fn(), validate: vi.fn(), create: vi.fn(), save: vi.fn() },
  clips: { list: vi.fn(), create: vi.fn(), read: vi.fn(), update: vi.fn(), edit: vi.fn(), run: vi.fn(), record: vi.fn(), recordStop: vi.fn(), stop: vi.fn(), status: vi.fn(), verdict: vi.fn(), runs: vi.fn() },
}));
vi.mock("../../api", () => {
  class ApiError extends Error {
    constructor(readonly status: number, message: string, readonly body?: unknown) {
      super(message);
    }
  }
  return { ApiError, api: { hub: m.hub, drafting: m.drafting, clips: m.clips, settings: () => new Promise(() => {}), agentSettings: () => new Promise(() => {}) } };
});
import { HubView } from "./Hub";
import type { HubData } from "./state";
import { hubFixture } from "./test-data";
import { ApiError } from "../../api";

const PATH = "/Game/PIEStudio/Clips/CL_Door";
const JUMP = "/Game/Input/IA_Jump.IA_Jump";
const base = (): Clip => ({
  rate: 60,
  grid: "frame",
  regions: [{ id: "r1", name: "Walk", start: 0, end: 120 }],
  tracks: [{ action: JUMP, type: "bool", notes: [{ id: "n1", start: 40, length: 6 }] }],
  checks: [{ id: "c1", start: 0, length: 100, mode: "by_end", expect: { value: "Speed2", op: "gt", target: 1 } }],
  events: [],
});

// jsdom has no PointerEvent; this one carries the position and pointer the lanes read.
if (typeof window.PointerEvent === "undefined") {
  class PointerEventShim extends MouseEvent {
    readonly pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  (window as unknown as { PointerEvent: unknown }).PointerEvent = PointerEventShim;
}

function Harness({ start }: { start: HubOverview }) {
  const [overview, setOverview] = useState<HubOverview | null>(start);
  const data: HubData = { overview, error: null, version: 0, reload: () => {}, patch: (f) => setOverview((o) => (o ? f(o) : o)) };
  return <HubView data={data} narrow={false} onOpenChat={() => {}} />;
}

beforeEach(() => {
  for (const group of [m.hub, m.drafting, m.clips]) for (const f of Object.values(group)) if (typeof f === "function" && "mockReset" in f) (f as ReturnType<typeof vi.fn>).mockReset();
  m.drafting.catalog.mockResolvedValue({ values: {}, inputActions: [], levels: [], currentLevel: null, gaps: [] });
  m.clips.list.mockResolvedValue({ clips: [{ path: PATH, name: "CL_Door", last_run: { run_id: "x", passed: true } }] });
  m.clips.read.mockResolvedValue({ path: PATH, clip: base(), warnings: [] });
  m.clips.runs.mockResolvedValue({ runs: [] });
  m.clips.status.mockRejectedValue(new Error("no run"));
  // jsdom has no layout: every lane starts at x 0, so a pixel is a quarter frame at the default zoom.
  Element.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: 400, bottom: 20, width: 400, height: 20, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
});
afterEach(() => {
  cleanup();
  window.location.hash = "";
});

describe("reaching the timeline", () => {
  it("opens from the playtest editor, with the breadcrumbs leading back the way the user came", async () => {
    window.location.hash = "#/playtests/checks/new";
    render(<Harness start={hubFixture()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Timeline clips" }));
    expect(window.location.hash).toBe("#/playtests/clips");
    fireEvent.click(await screen.findByRole("link", { name: /CL_Door/ }));
    expect(window.location.hash).toBe(`#/playtests/clips/${encodeURIComponent(PATH)}`);
    await screen.findByRole("heading", { name: "CL_Door" });
    // The breadcrumbs follow the way the user came, not the hub's map.
    expect(screen.getByRole("navigation", { name: "Where you came from" }).textContent).toContain("New script clip");
  });

  it("creates a clip by name and opens it", async () => {
    window.location.hash = "#/playtests/clips";
    m.clips.list.mockResolvedValue({ clips: [] });
    m.clips.create.mockResolvedValue({ path: "/Game/PIEStudio/Clips/CL_Jump" });
    render(<Harness start={hubFixture()} />);
    fireEvent.click((await screen.findAllByRole("button", { name: "New timeline clip" }))[0]);
    const name = screen.getByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "CL Jump" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(screen.getByText("Use letters, digits and underscores.")).toBeTruthy();
    fireEvent.change(name, { target: { value: "CL_Jump" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(window.location.hash).toBe(`#/playtests/clips/${encodeURIComponent("/Game/PIEStudio/Clips/CL_Jump")}`));
    expect(m.clips.create).toHaveBeenCalledWith("CL_Jump");
  });
});

describe("editing on the timeline", () => {
  const open = async () => {
    window.location.hash = `#/playtests/clips/${encodeURIComponent(PATH)}`;
    render(<Harness start={hubFixture()} />);
    await screen.findByRole("heading", { name: "CL_Door" });
  };
  const answer = (clip: Clip, changed: string[] = []) => ({ path: PATH, clip, changed, warnings: [], rollback: { path: PATH, clip: base() } });

  it("draws a note on a Boolean lane by dragging, snapped to the grid", async () => {
    await open();
    const withNote = base();
    withNote.tracks![0].notes!.push({ id: "n2", start: 100, length: 12 });
    m.clips.edit.mockResolvedValue(answer(withNote, ["n2"]));
    const lane = document.querySelectorAll(".hub-clip-lane")[2] as HTMLElement;
    fireEvent.pointerDown(lane, { button: 0, clientX: 400, pointerId: 1 });
    fireEvent.pointerMove(lane, { clientX: 449, pointerId: 1 });
    fireEvent.pointerUp(lane, { clientX: 449, pointerId: 1 });
    await waitFor(() => expect(m.clips.edit).toHaveBeenCalledWith(PATH, [{ op: "add", kind: "note", track: JUMP, start: 100, length: 12 }]));
    // The new note is selected, its fields in the inspector.
    expect(await screen.findByRole("region", { name: /Note n2/ })).toBeTruthy();
  });

  it("moves a note by dragging it, then undoes and redoes through the rollback", async () => {
    await open();
    const moved = base();
    moved.tracks![0].notes![0].start = 60;
    m.clips.edit.mockResolvedValue(answer(moved, ["n1"]));
    const note = screen.getByRole("button", { name: /Note n1/ });
    // The note spans pixels 160 to 184; press in its middle.
    fireEvent.pointerDown(note, { button: 0, clientX: 172, pointerId: 1 });
    fireEvent.pointerMove(note, { clientX: 252, pointerId: 1 });
    fireEvent.pointerUp(note, { clientX: 252, pointerId: 1 });
    await waitFor(() => expect(m.clips.edit).toHaveBeenCalledWith(PATH, [{ op: "move", id: "n1", to: 60 }]));

    m.clips.update.mockResolvedValueOnce({ path: PATH, clip: base(), rollback: { path: PATH, clip: moved } });
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(m.clips.update).toHaveBeenCalledWith({ path: PATH, clip: base() }));
    m.clips.update.mockResolvedValueOnce({ path: PATH, clip: moved, rollback: { path: PATH, clip: base() } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Redo" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    await waitFor(() => expect(m.clips.update).toHaveBeenLastCalledWith({ path: PATH, clip: moved }));
  });

  it("deletes the selected note from the keyboard", async () => {
    await open();
    m.clips.edit.mockResolvedValue(answer({ ...base(), tracks: [{ action: JUMP, type: "bool", notes: [] }] }));
    fireEvent.click(screen.getByRole("button", { name: /Note n1/ }));
    fireEvent.keyDown(screen.getByRole("group", { name: "Timeline clip" }), { key: "Delete" });
    await waitFor(() => expect(m.clips.edit).toHaveBeenCalledWith(PATH, [{ op: "delete", id: "n1" }]));
  });

  it("offers a warning's candidates as fixes and shows a refusal's closest ids", async () => {
    m.clips.read.mockResolvedValue({ path: PATH, clip: base(), warnings: [{ id: "c1", field: "expect.value", message: "No value Speed2 on the pawn", candidates: ["speed2d"] }] });
    await open();
    m.clips.edit.mockRejectedValueOnce(new ApiError(409, "The edit was not applied", { error: "The edit was not applied", errors: [{ id: "c9", message: "No check c9", candidates: ["c1"] }] }));
    fireEvent.click(screen.getByRole("button", { name: "speed2d" }));
    await waitFor(() => expect(m.clips.edit).toHaveBeenCalledWith(PATH, [{ op: "set", id: "c1", expect: { value: "speed2d" } }]));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("No check c9");
    expect(alert.textContent).toContain("Closest: c1");
  });

  it("keeps a dropped note, region and check where they were let go while clip_edit is out", async () => {
    await open();
    let reply!: (a: ReturnType<typeof answer>) => void;
    m.clips.edit.mockImplementationOnce(() => new Promise((r) => (reply = r)));
    const note = screen.getByRole("button", { name: /Note n1/ });
    fireEvent.pointerDown(note, { button: 0, clientX: 172, pointerId: 1 });
    fireEvent.pointerMove(note, { clientX: 252, pointerId: 1 });
    fireEvent.pointerUp(note, { clientX: 252, pointerId: 1 });
    // At frame 60 in the same render as the drop; no placeholder takes the timeline's place.
    const there = screen.getByRole("button", { name: /Note n1, Start 60/ });
    expect(there.style.left).toBe("240px");
    expect(screen.queryByLabelText("Loading")).toBeNull();
    await waitFor(() => expect(m.clips.edit).toHaveBeenCalledWith(PATH, [{ op: "move", id: "n1", to: 60 }]));
    // A second drag while the first is out waits its turn, drawn at once all the same.
    m.clips.edit.mockImplementationOnce(() => new Promise(() => {}));
    const region = screen.getByTitle(/^Walk \(0 to 120\)/);
    fireEvent.pointerDown(region, { button: 0, clientX: 200, pointerId: 1 });
    fireEvent.pointerMove(region, { clientX: 240, pointerId: 1 });
    fireEvent.pointerUp(region, { clientX: 240, pointerId: 1 });
    expect(region.style.left).toBe("40px");
    expect(m.clips.edit).toHaveBeenCalledTimes(1);
    const moved = base();
    moved.tracks![0].notes![0].start = 60;
    await act(async () => reply(answer(moved, ["n1"])));
    expect(screen.getByRole("button", { name: /Note n1, Start 60/ }).style.left).toBe("240px");
    await waitFor(() => expect(m.clips.edit).toHaveBeenLastCalledWith(PATH, [{ op: "move", id: "r1", to: 10 }]));
    expect(region.style.left).toBe("40px");
  });

  it("takes a refused drag back and says why", async () => {
    await open();
    m.clips.edit.mockRejectedValueOnce(new ApiError(409, "The edit was not applied", { error: "n1 would overlap n2", errors: [] }));
    const note = screen.getByRole("button", { name: /Note n1/ });
    fireEvent.pointerDown(note, { button: 0, clientX: 172, pointerId: 1 });
    fireEvent.pointerMove(note, { clientX: 252, pointerId: 1 });
    fireEvent.pointerUp(note, { clientX: 252, pointerId: 1 });
    expect(await screen.findByText("Put back: n1 would overlap n2")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Note n1, Start 40/ }).style.left).toBe("160px");
  });

  it("moves a note and draws a span without rendering while the pointer moves", async () => {
    let commits = 0;
    window.location.hash = `#/playtests/clips/${encodeURIComponent(PATH)}`;
    const raf = window.requestAnimationFrame;
    window.requestAnimationFrame = (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    };
    try {
      render(<Profiler id="t" onRender={() => commits++}><Harness start={hubFixture()} /></Profiler>);
      await screen.findByRole("heading", { name: "CL_Door" });
      const note = screen.getByRole("button", { name: /Note n1/ });
      fireEvent.pointerDown(note, { button: 0, clientX: 172, pointerId: 1 });
      commits = 0;
      for (let x = 176; x <= 252; x += 4) fireEvent.pointerMove(note, { clientX: x, pointerId: 1 });
      expect(commits).toBe(0);
      expect(note.style.left).toBe("240px");
      fireEvent.keyDown(window, { key: "Escape" });
      expect(note.style.left).toBe("160px");
      const lane = document.querySelectorAll(".hub-clip-lane")[2] as HTMLElement;
      fireEvent.pointerDown(lane, { button: 0, clientX: 400, pointerId: 1 });
      commits = 0;
      for (let x = 404; x <= 448; x += 4) fireEvent.pointerMove(lane, { clientX: x, pointerId: 1 });
      expect(commits).toBe(0);
      const span = lane.querySelector(".hub-clip-drawing") as HTMLElement;
      expect([span.style.left, span.style.width]).toEqual(["400px", "48px"]);
      fireEvent.pointerUp(lane, { clientX: 448, pointerId: 1 });
      expect(lane.querySelector(".hub-clip-drawing")).toBeNull();
    } finally {
      window.requestAnimationFrame = raf;
    }
  });

  it("edits a note's length from the inspector", async () => {
    await open();
    m.clips.edit.mockResolvedValue(answer(base(), ["n1"]));
    fireEvent.click(screen.getByRole("button", { name: /Note n1/ }));
    const length = screen.getByRole("textbox", { name: /Length/ });
    fireEvent.change(length, { target: { value: "10" } });
    await act(async () => {
      fireEvent.blur(length);
    });
    expect(m.clips.edit).toHaveBeenCalledWith(PATH, [{ op: "trim", id: "n1", length: 10 }]);
  });
});

describe("move, action and value lanes", () => {
  const lanes = (): Clip => ({
    ...base(),
    performer: { kind: "actor", actor: "Guard" },
    lanes: [
      { id: "L1", kind: "move", points: [{ id: "p1", t: 0, at: [0, 0, 0] }, { id: "p2", t: 120, at: [400, -50, 0], radius: 30 }] },
      { id: "L2", kind: "action", performer: { kind: "actor", actor: "Gate" }, calls: [{ id: "a1", t: 200, fn: "Open", args: [1] }] },
      { id: "L3", kind: "value", target: "bb:Alert", type: "axis1d", keys: [{ id: "v1", t: 60, v: 0 }, { id: "v2", t: 180, v: 10 }] },
    ],
  });
  const open = async () => {
    m.clips.read.mockResolvedValue({ path: PATH, clip: lanes(), warnings: [] });
    window.location.hash = `#/playtests/clips/${encodeURIComponent(PATH)}`;
    render(<Harness start={hubFixture()} />);
    await screen.findByRole("heading", { name: "CL_Door" });
  };
  const answer = (changed: string[] = []) => ({ path: PATH, clip: lanes(), changed, warnings: [], rollback: { path: PATH, clip: lanes() } });
  const laneEl = (name: string) => screen.getByRole("group", { name });
  const commit = (label: string, value: string) => {
    const box = screen.getByLabelText(label);
    fireEvent.change(box, { target: { value } });
    fireEvent.blur(box);
  };

  it("draws each lane beside the Input Action lanes: points with their coordinates, calls with their function, and a value curve", async () => {
    await open();
    expect(screen.getByRole("button", { name: "Move to" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Actions" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "bb:Alert" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Point p2/ }).textContent).toBe("400, -50, 0");
    expect(screen.getByRole("button", { name: /Call a1/ }).textContent).toBe("Open");
    expect(laneEl("bb:Alert").querySelector("polyline")).toBeTruthy();
    // Each lane names its performer: its own, else the clip's.
    expect(document.querySelector("[data-lane=L2] .hub-clip-lane-who")?.textContent).toBe("Gate");
    expect(document.querySelector("[data-lane=L1] .hub-clip-lane-who")?.textContent).toBe("Guard");
  });

  it("adds a point where the last one went and a key on the curve with a click, and a call through the inspector", async () => {
    await open();
    m.clips.edit.mockResolvedValue(answer(["p3"]));
    // A pixel is a quarter frame: 600 is frame 150.
    fireEvent.pointerDown(laneEl("Move to"), { button: 0, clientX: 600, pointerId: 1 });
    await waitFor(() => expect(m.clips.edit).toHaveBeenLastCalledWith(PATH, [{ op: "add", kind: "point", lane: "L1", time: 150, at: [400, -50, 0] }]));
    m.clips.edit.mockResolvedValue(answer(["v3"]));
    fireEvent.pointerDown(laneEl("bb:Alert"), { button: 0, clientX: 480, pointerId: 1 });
    await waitFor(() => expect(m.clips.edit).toHaveBeenLastCalledWith(PATH, [{ op: "add", kind: "key", lane: "L3", time: 120, value: 5 }]));
    fireEvent.pointerDown(laneEl("Actions"), { button: 0, clientX: 400, pointerId: 1 });
    const form = await screen.findByRole("region", { name: /Add call/ });
    fireEvent.change(within(form).getByLabelText("Function"), { target: { value: "Weapon.Fire" } });
    fireEvent.change(within(form).getByLabelText("Arguments (JSON array)"), { target: { value: "[2" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add call" }));
    expect(within(form).getByText(/Enter a JSON array/)).toBeTruthy();
    fireEvent.change(within(form).getByLabelText("Arguments (JSON array)"), { target: { value: '[2, "x"]' } });
    m.clips.edit.mockResolvedValue(answer(["a2"]));
    fireEvent.click(within(form).getByRole("button", { name: "Add call" }));
    await waitFor(() => expect(m.clips.edit).toHaveBeenLastCalledWith(PATH, [{ op: "add", kind: "call", lane: "L2", time: 100, fn: "Weapon.Fire", args: [2, "x"] }]));
  });

  it("drags a call in time, edits a point's coordinates and radius, a call's function, and a key's value", async () => {
    await open();
    m.clips.edit.mockResolvedValue(answer(["a1"]));
    const call = screen.getByRole("button", { name: /Call a1/ });
    fireEvent.pointerDown(call, { button: 0, clientX: 802, pointerId: 1 });
    fireEvent.pointerMove(call, { clientX: 882, pointerId: 1 });
    fireEvent.pointerUp(call, { clientX: 882, pointerId: 1 });
    await waitFor(() => expect(m.clips.edit).toHaveBeenLastCalledWith(PATH, [{ op: "move", id: "a1", to: 220 }]));

    fireEvent.click(screen.getByRole("button", { name: /Point p2/ }));
    await screen.findByRole("region", { name: /Point p2/ });
    commit("Walk to (x, y, z)", "1, 2");
    expect(screen.getByText("Enter three numbers: x, y, z.")).toBeTruthy();
    commit("Walk to (x, y, z)", "1, 2, 3");
    await waitFor(() => expect(m.clips.edit).toHaveBeenLastCalledWith(PATH, [{ op: "set", id: "p2", at: [1, 2, 3] }]));
    commit("Arrival radius (cm)", "50");
    await waitFor(() => expect(m.clips.edit).toHaveBeenLastCalledWith(PATH, [{ op: "set", id: "p2", radius: 50 }]));

    fireEvent.click(screen.getByRole("button", { name: /Call a1/ }));
    await screen.findByRole("region", { name: /Call a1/ });
    commit("Function", "Close");
    await waitFor(() => expect(m.clips.edit).toHaveBeenLastCalledWith(PATH, [{ op: "set", id: "a1", fn: "Close" }]));

    fireEvent.click(screen.getByRole("button", { name: /Key v2/ }));
    await screen.findByRole("region", { name: /Key v2/ });
    commit("Value", "7.5");
    await waitFor(() => expect(m.clips.edit).toHaveBeenLastCalledWith(PATH, [{ op: "set", id: "v2", v: 7.5 }]));
  });

  it("sets a lane's performer and target from its header, adds a lane its performer takes, and deletes a lane", async () => {
    await open();
    m.clips.edit.mockResolvedValue(answer());
    fireEvent.click(screen.getByRole("button", { name: "bb:Alert" }));
    await screen.findByRole("region", { name: /Value · bb:Alert/ });
    expect((screen.getByLabelText("Performer") as HTMLInputElement).placeholder).toBe("The clip's: Guard");
    commit("Performer", "Client 2");
    await waitFor(() => expect(m.clips.edit).toHaveBeenLastCalledWith(PATH, [{ op: "set", id: "L3", performer: { kind: "player", client: 2 } }]));
    commit("Property or blackboard key", "Health");
    await waitFor(() => expect(m.clips.edit).toHaveBeenLastCalledWith(PATH, [{ op: "set", id: "L3", target: "Health" }]));
    // The lane names no performer of its own, so a new one inherits the clip's: an actor takes move lanes.
    expect(Array.from((screen.getByLabelText("Lane") as HTMLSelectElement).options).map((o) => o.value)).toEqual(["move", "action", "value"]);
    fireEvent.click(screen.getByRole("button", { name: "Add move lane" }));
    await waitFor(() => expect(m.clips.edit).toHaveBeenLastCalledWith(PATH, [{ op: "add", kind: "lane", capability: "move" }]));
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    fireEvent.keyDown(screen.getByRole("group", { name: "Timeline clip" }), { key: "Delete" });
    await waitFor(() => expect(m.clips.edit).toHaveBeenLastCalledWith(PATH, [{ op: "delete", id: "L2" }]));
  });

  it("sets the clip's performer, and offers only the lanes a player takes", async () => {
    m.clips.read.mockResolvedValue({ path: PATH, clip: { ...base(), performer: { kind: "player", client: 0 } }, warnings: [] });
    window.location.hash = `#/playtests/clips/${encodeURIComponent(PATH)}`;
    render(<Harness start={hubFixture()} />);
    await screen.findByRole("heading", { name: "CL_Door" });
    expect(Array.from((screen.getByLabelText("Lane") as HTMLSelectElement).options).map((o) => o.value)).toEqual(["action", "value"]);
    fireEvent.change(screen.getByLabelText("Lane"), { target: { value: "value" } });
    // A value lane needs its target.
    expect((screen.getByRole("button", { name: "Add value lane" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Property or blackboard key"), { target: { value: "Stamina" } });
    m.clips.edit.mockResolvedValue({ path: PATH, clip: base(), changed: ["L9"], warnings: [], rollback: null });
    fireEvent.click(screen.getByRole("button", { name: "Add value lane" }));
    await waitFor(() => expect(m.clips.edit).toHaveBeenLastCalledWith(PATH, [{ op: "add", kind: "lane", capability: "value", target: "Stamina", type: "axis1d" }]));
    m.clips.edit.mockResolvedValue({ path: PATH, clip: { ...base(), performer: { kind: "actor", actor: "Guard 2" } }, changed: [], warnings: [], rollback: null });
    commit("Performer", "actor:Guard 2");
    await waitFor(() => expect(m.clips.edit).toHaveBeenLastCalledWith(PATH, [{ op: "set_clip", performer: { kind: "actor", actor: "Guard 2" } }]));
    commit("Performer", "");
    await waitFor(() => expect(m.clips.edit).toHaveBeenLastCalledWith(PATH, [{ op: "set_clip", performer: null }]));
  });
});

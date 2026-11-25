// @vitest-environment jsdom
/**
 * Timeline playtests on the hub: reached from the playtest editor with Back
 * returning there, a clip created by name, notes drawn and moved through
 * clip_edit, undo and redo through its rollback, keyboard delete, and a
 * warning's candidate applied as a fix.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
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

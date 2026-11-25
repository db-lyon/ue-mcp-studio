/**
 * Timeline playtests' pure parts: the grid, values, curves, undo and redo
 * stacks, finding fixes, and the hub's addresses for the clip screens.
 */
import { describe, expect, it } from "vitest";
import type { Clip } from "@ue-mcp-studio/shared";
import {
  applyTakeProgress,
  clipEventsOn,
  clipLiveFromStatus,
  clipPlaying,
  clipTakeEventsOn,
  driftText,
  foldClipEvent,
  clipEnd,
  clipName,
  curveAt,
  emptyHistory,
  findingFix,
  gridStep,
  historyAfterEdit,
  historyAfterRedo,
  historyAfterUndo,
  hubPath,
  parseHubPath,
  parseValue,
  snapFrame,
  valueText,
} from "./index.js";

const clip: Clip = {
  rate: 60,
  tracks: [
    { action: "/Game/Input/IA_Move.IA_Move", type: "axis2d", keys: [{ id: "k1", t: 0, v: [0, 1] }, { id: "k2", t: 60, v: [1, 0], interp: "constant" }, { id: "k3", t: 120, v: [0, 0] }] },
    { action: "/Game/Input/IA_Jump.IA_Jump", type: "bool", notes: [{ id: "n1", start: 40, length: 6 }] },
  ],
  checks: [{ id: "c1", start: 0, length: 300, mode: "by_end", expect: { value: "Speed2", op: "gt", target: 1 } }],
};

describe("the grid", () => {
  it("steps a frame, a fraction of a second, or not at all", () => {
    expect(gridStep(clip)).toBe(1);
    expect(gridStep(clip, "1/4")).toBe(15);
    expect(gridStep(clip, "free")).toBe(0);
    expect(snapFrame(22.6, clip, "1/4")).toBe(30);
    expect(snapFrame(22.637, clip, "free")).toBe(22.64);
    expect(snapFrame(-3, clip)).toBe(0);
  });

  it("ends at the last thing on the clip, never under two seconds", () => {
    expect(clipEnd(clip)).toBe(300);
    expect(clipEnd({ rate: 30 })).toBe(60);
  });
});

describe("values and curves", () => {
  it("reads and writes a track's values by its number of components", () => {
    expect(parseValue("0.5", "axis1d")).toBe(0.5);
    expect(parseValue("0, 1", "axis2d")).toEqual([0, 1]);
    expect(parseValue("1", "axis2d")).toBeNull();
    expect(valueText([0.12345, 1])).toBe("0.123,1");
  });

  it("follows the curve as playback does: nothing before the first key, steps on constant", () => {
    const move = clip.tracks![0];
    expect(curveAt(move, 30)).toEqual([0.5, 0.5]);
    expect(curveAt(move, 90)).toEqual([1, 0]);
    expect(curveAt(move, 500)).toEqual([0, 0]);
    expect(curveAt({ action: "/a", type: "axis1d", keys: [{ id: "k1", t: 10, v: 1 }] }, 5)).toBeUndefined();
  });
});

describe("undo and redo", () => {
  it("undoes an edit with its rollback and redoes it with the undo's", () => {
    const a = { path: "/Game/C", clip: { rate: 60 } };
    const b = { path: "/Game/C", clip: { rate: 30 } };
    let h = historyAfterEdit(emptyHistory(), a);
    expect(h).toEqual({ undo: [a], redo: [] });
    h = historyAfterUndo(h, b);
    expect(h).toEqual({ undo: [], redo: [b] });
    h = historyAfterRedo(h, a);
    expect(h).toEqual({ undo: [a], redo: [] });
    expect(historyAfterEdit({ undo: [], redo: [b] }, null)).toEqual({ undo: [], redo: [] });
  });
});

describe("fixes from findings", () => {
  it("sets a check's expectation from a candidate, and offers none for an id", () => {
    expect(findingFix(clip, { id: "c1", field: "expect.value", message: "", candidates: ["speed2d"] }, "speed2d")).toEqual({ op: "set", id: "c1", expect: { value: "speed2d" } });
    expect(findingFix(clip, { id: "n9", field: "id", message: "" }, "n1")).toBeNull();
  });
});

describe("following a run", () => {
  const PATH = "/Game/Clips/CL_Door";
  const ev = (type: string, data: Record<string, unknown>) => ({ type, data: { runId: "clip-1", clip: `${PATH}.CL_Door`, ...data } });

  it("starts on clip.run_started for this clip and folds position, checks, regions and the finish", () => {
    let l = foldClipEvent(null, ev("clip.run_started", { mode: "play", seq: 1 }), PATH);
    l = foldClipEvent(l, ev("clip.position", { position: 42, length: 300, state: "running", holding: "c2", seq: 2 }), PATH);
    expect(l).toMatchObject({ runId: "clip-1", position: 42, length: 300, holding: "c2" });
    l = foldClipEvent(l, ev("clip.check", { check: { id: "c1", status: "passed" }, seq: 3 }), PATH);
    l = foldClipEvent(l, ev("clip.region", { region: { id: "r1", status: "failed", drift: { max_position_cm: 26.94 } }, seq: 4 }), PATH);
    l = foldClipEvent(l, ev("clip.verdict_requested", { awaiting: ["c4"], seq: 5 }), PATH);
    expect(clipPlaying(l)).toBe(true);
    l = foldClipEvent(l, ev("clip.run_finished", { state: "finished", passed: false, summary: { total: 2, failed: 1 }, seq: 6 }), PATH);
    expect(l).toMatchObject({ state: "finished", passed: false, awaiting: [], holding: null, checks: { c1: { status: "passed" } }, regions: { r1: { status: "failed" } } });
    expect(driftText(l!.regions.r1.drift)).toBe("26.9 cm");
    expect(clipPlaying(l)).toBe(false);
  });

  it("ignores another clip's events and stale ones", () => {
    const l = foldClipEvent(null, ev("clip.run_started", { seq: 1 }), PATH);
    expect(foldClipEvent(l, { type: "clip.position", data: { runId: "clip-1", clip: "/Game/Clips/CL_Other", position: 9, seq: 2 } }, PATH)).toBe(l);
    const at5 = foldClipEvent(l, ev("clip.position", { position: 5, seq: 5 }), PATH);
    expect(foldClipEvent(at5, ev("clip.position", { position: 3, seq: 4 }), PATH)!.position).toBe(5);
  });

  it("replaces a take's notes and appends its keys at keysFrom", () => {
    let t = applyTakeProgress(null, { takeId: "t1", punchIn: 150, tracks: [{ action: "/a", notes: [{ start: 150, length: 1, open: true }], keys: [{ t: 150, v: 0 }], keysFrom: 0 }] });
    t = applyTakeProgress(t, { tracks: [{ action: "/a", notes: [{ start: 150, length: 8 }], keys: [{ t: 151, v: 0.5 }, { t: 152, v: 1 }], keysFrom: 1 }] });
    expect(t.tracks[0]).toMatchObject({ notes: [{ start: 150, length: 8 }], keys: [{ t: 150, v: 0 }, { t: 151, v: 0.5 }, { t: 152, v: 1 }] });
    expect(t.punchIn).toBe(150);
  });

  it("reads the features from health", () => {
    expect(clipEventsOn({ features: ["events.clip"] })).toBe(true);
    expect(clipTakeEventsOn({ features: ["events.clip"] })).toBe(false);
    expect(clipEventsOn(null)).toBe(false);
  });

  it("starts a run mid-take from clip_status's live_take", () => {
    const l = clipLiveFromStatus({ run_id: "clip-2", mode: "record", state: "running", position: 200, take: { live_take: { samples: 50, frame: 200, tracks: [{ action: "/a", notes: [] }] } } });
    expect(l.take?.frame).toBe(200);
  });
});

describe("addresses", () => {
  it("round-trips the clip list and a clip by its path", () => {
    expect(parseHubPath("clips")).toEqual({ screen: "clips" });
    const r = { screen: "clip" as const, path: "/Game/PIEStudio/Clips/CL_Door" };
    expect(parseHubPath(hubPath(r))).toEqual(r);
    expect(clipName("/Game/PIEStudio/Clips/CL_Door.CL_Door")).toBe("CL_Door");
  });
});

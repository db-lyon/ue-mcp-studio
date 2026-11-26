/**
 * Edits drawn ahead of their answers: a ghost lands an instance where the
 * lines dragLines sends would put it, and the piano roll's ops move, trim and
 * add on the clip as clip_edit does.
 */
import { describe, expect, it } from "vitest";
import { dragLines } from "@ue-mcp-studio/client-core";
import type { Clip, SetTrackView } from "@ue-mcp-studio/shared";
import { COPY_ID, NEW_ID, applyClipOps, dragGhost, withGhosts } from "./optimistic";

const lay = (id: string, start: number, length: number) => ({ id, kind: "clip" as const, target: `/Game/${id}`, name: id, start, end: start + length, length, known: true });
const tracks = (): SetTrackView[] => [
  { id: "a", title: "A", order: 0, player: 0, mute: false, solo: false, status: "not_started", arrangement: { rate: 60, instances: [{ id: "i1", kind: "clip", target: "/Game/i1", start: 30, in: 10 }] }, layout: [lay("i1", 30, 120)] },
  { id: "b", title: "B", order: 1, player: 0, mute: false, solo: false, status: "not_started", arrangement: { rate: 60, instances: [] }, layout: [] },
] as SetTrackView[];

describe("ghosts over the set", () => {
  it("lands a trimmed start where the lines put it, in and start together", () => {
    const [a] = tracks();
    const inst = a.arrangement.instances[0];
    // Past the clip's own first frame: held at in 0, as dragLines holds it.
    expect(dragLines("a", inst, a.layout[0], "trimStart", -30, { scale: 0.5 })).toEqual(["trim a/i1 in=0", "move a/i1 by -20"]);
    const g = dragGhost("a", inst, a.layout[0], "trimStart", -30, { scale: 0.5 })!;
    const t = withGhosts(tracks(), [g]);
    expect(t[0].layout[0]).toMatchObject({ start: 10, end: 150, length: 140 });
    expect(t[0].arrangement.instances[0]).toMatchObject({ start: 10, in: 0 });
  });

  it("moves an instance to another track, copies one under a stand-in id, and reorders tracks", () => {
    const [a] = tracks();
    const inst = a.arrangement.instances[0];
    const moved = withGhosts(tracks(), [dragGhost("a", inst, a.layout[0], "move", 60, { toTrack: "b" })!]);
    expect(moved[0].layout).toEqual([]);
    expect(moved[1].layout[0]).toMatchObject({ id: "i1", start: 90, end: 210 });
    const copied = withGhosts(tracks(), [dragGhost("a", inst, a.layout[0], "move", 60, { duplicate: true })!]);
    expect(copied[0].layout.map((l) => [l.id, l.start])).toEqual([["i1", 30], [COPY_ID, 90]]);
    const ordered = withGhosts(tracks(), [{ kind: "order", track: "a", index: 1 }]);
    expect(ordered.map((t) => [t.id, t.order])).toEqual([["b", 0], ["a", 1]]);
    expect(dragGhost("a", inst, a.layout[0], "move", 0)).toBeNull();
  });
});

describe("the piano roll's ops", () => {
  const clip = (): Clip => ({
    rate: 60,
    regions: [{ id: "r1", name: "Walk", start: 0, end: 120 }],
    tracks: [{ action: "IA", type: "bool", notes: [{ id: "n1", start: 40, length: 6 }], keys: [{ id: "k1", t: 5, v: 1 }] }],
    checks: [{ id: "c1", start: 0, length: 100, mode: "by_end" }],
    events: [{ id: "e1", at: 3, do: {} }],
  });

  it("moves, trims and adds by id, leaving other ops to the answer", () => {
    const c = applyClipOps(clip(), [
      { op: "move", id: "n1", to: 60 },
      { op: "move", id: "k1", by: 4 },
      { op: "trim", id: "c1", start: 10, length: 50 },
      { op: "trim", id: "r1", start: 5, end: 90 },
      { op: "move", id: "e1", to: 8 },
      { op: "add", kind: "note", track: "IA", start: 100, length: 12 },
      { op: "delete", id: "n1" },
    ]);
    expect(c.tracks![0].notes).toEqual([{ id: "n1", start: 60, length: 6 }, { id: NEW_ID, start: 100, length: 12 }]);
    expect(c.tracks![0].keys![0].t).toBe(9);
    expect(c.checks![0]).toMatchObject({ start: 10, length: 50 });
    expect(c.regions![0]).toMatchObject({ start: 5, end: 90 });
    expect(c.events![0].at).toBe(8);
  });
});

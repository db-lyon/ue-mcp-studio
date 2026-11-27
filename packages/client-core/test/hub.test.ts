/** The hub's addresses, the edits a person makes on the Arrangement and the clip roll, run feedback and the queue's line. */
import { describe, expect, it } from "vitest";
import type { Arrangement, Clip, QueueState, RunRecord } from "ue-mcp/daemon";
import {
  addCheck,
  addInstance,
  addNote,
  addRegion,
  arrangementRun,
  awaitingVerdicts,
  hubAddressRoute,
  hubPath,
  instanceFits,
  moveInstance,
  nextTitle,
  parseHubPath,
  queuedText,
  regionFits,
  rollRows,
  rootSuites,
  setPoint,
  updateCheck,
  type HubRoute,
} from "../src/hub.js";

const A: Arrangement = {
  id: "arena", title: "Arena", level: null, rate: 60,
  tracks: [
    { id: "t1", title: "Player", performer: { kind: "player", client: 0 }, mute: false, solo: false, instances: [{ id: "i1", clip: "run", at: 0 }] },
    { id: "t2", title: "Guard", performer: { kind: "actor", actor: "BP_Guard" }, mute: false, solo: false, instances: [] },
  ],
  checks: [],
  regions: [{ id: "r1", name: "Start", start: 0, end: 120 }],
};
const SPANS = { run: { length: 120, rate: 60 }, walk: { length: 60, rate: 30 } };

describe("hub addresses", () => {
  it("round-trip every screen", () => {
    const routes: HubRoute[] = [
      { screen: "arrangements" },
      { screen: "arrangement", id: "arena" },
      { screen: "arrangement", id: "arena", run: "run-1" },
      { screen: "clip", id: "jump" },
      { screen: "clip", id: "jump", from: "arena" },
      { screen: "suites" },
      { screen: "suites", id: "smoke" },
      { screen: "runs" },
    ];
    for (const r of routes) expect(parseHubPath(hubPath(r))).toEqual(r);
    expect(parseHubPath("goals/doors")).toEqual({ screen: "arrangements" });
    expect(hubAddressRoute("#/playtests/suites/smoke")).toEqual({ screen: "suites", id: "smoke" });
    expect(hubAddressRoute("https://example.com")).toBeNull();
  });
});

describe("arrangement edits", () => {
  it("place a clip with a fresh id and move it between tracks", () => {
    const { arrangement, id } = addInstance(A, "t1", "run", 180);
    expect(id).toBe("i2");
    expect(arrangement.tracks[0]!.instances.map((i) => [i.id, i.at])).toEqual([["i1", 0], ["i2", 180]]);
    const moved = moveInstance(arrangement, "i2", 30, "t2");
    expect(moved.tracks[0]!.instances.map((i) => i.id)).toEqual(["i1"]);
    expect(moved.tracks[1]!.instances).toEqual([{ id: "i2", clip: "run", at: 30 }]);
  });

  it("refuse an overlap on one track, a clip at another rate counted at the arrangement's", () => {
    expect(instanceFits(A.tracks[0]!, SPANS, 60, "run", 60)).toBe(false);
    expect(instanceFits(A.tracks[0]!, SPANS, 60, "run", 120)).toBe(true);
    expect(instanceFits(A.tracks[0]!, SPANS, 60, "run", 60, "i1")).toBe(true);
  });

  it("give a check the fields its mode takes", () => {
    const { arrangement, id } = addCheck(A, 30, "by_end", 60);
    expect(arrangement.checks[0]).toMatchObject({ id, mode: "by_end", expect: { value: "pawn.alive" } });
    const manual = updateCheck(arrangement, id, { mode: "manual" }).checks[0]!;
    expect(manual.expect).toBeUndefined();
    expect(manual.instruction).toBeTruthy();
    const hold = updateCheck(updateCheck(arrangement, id, { mode: "manual", personOnly: true }), id, { mode: "hold" }).checks[0]!;
    expect(hold).toMatchObject({ mode: "hold", expect: { value: "pawn.alive" } });
    expect(hold.personOnly).toBeUndefined();
  });

  it("add regions that do not overlap", () => {
    const { arrangement } = addRegion(A, 120, 240);
    expect(arrangement.regions.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(regionFits(arrangement, 100, 130)).toBe(false);
    expect(regionFits(arrangement, 240, 300)).toBe(true);
  });

  it("name a new one after the taken ones", () => {
    expect(nextTitle("Suite", [])).toBe("Suite");
    expect(nextTitle("Suite", ["suite", "Suite 2"])).toBe("Suite 3");
  });
});

describe("clip roll", () => {
  const clip: Clip = {
    id: "c", title: "C", performer: "player", rate: 60, length: 120,
    input: [{ action: "/Game/Input/IA_Jump.IA_Jump", type: "bool", notes: [{ id: "n1", start: 0, length: 10 }], keys: [] }],
    lanes: [{ id: "walk", kind: "move", points: [{ id: "p1", t: 0, at: [0, 0, 0] }] }],
  };
  it("draws a row per lane and edits notes and points", () => {
    const rows = rollRows(clip);
    expect(rows.map((r) => [r.key, r.label])).toEqual([["input:0", "IA_Jump"], ["lane:walk", "Move walk"]]);
    const { clip: added, id } = addNote(clip, "input:0", 40, 10);
    expect(added.input[0]!.notes.map((n) => n.id)).toEqual(["n1", id]);
    const moved = setPoint(clip, "lane:walk", "p1", 30);
    expect(moved.lanes[0]).toMatchObject({ points: [{ id: "p1", t: 30 }] });
  });
});

describe("run feedback", () => {
  const run = (o: Partial<RunRecord>): RunRecord => ({ runId: "r", test: "arena", title: "Arena", runner: "editor", source: "person", batch: "b", startedAt: "2026-11-27T10:00:00Z", endedAt: null, state: "running", checks: [], revision: null, dirty: null, ...o });
  it("shows the arrangement's newest run, a region's included, and the manual checks waiting", () => {
    const recent = [run({ runId: "old", startedAt: "2026-11-27T09:00:00Z", state: "passed" }), run({ runId: "new", test: "arena:r1", state: "awaiting_verdict", checks: [{ id: "c1", status: "awaiting_verdict" }] }), run({ runId: "other", test: "lobby" })];
    const r = arrangementRun(recent, "arena");
    expect(r?.runId).toBe("new");
    expect(arrangementRun(recent, "arena", "old")?.runId).toBe("old");
    const checks = [{ id: "c1", title: "Looks right", at: 0, length: 0, mode: "manual" as const, instruction: "Look" }];
    expect(awaitingVerdicts(r, checks).map((c) => c.id)).toEqual(["c1"]);
    expect(awaitingVerdicts({ ...r!, state: "failed" }, checks)).toEqual([]);
  });

  it("says where a Run went", () => {
    const queue: QueueState = { paused: false, waiting: [], running: [], queued: [] };
    const item = { id: "q", test: "arena", title: "Arena", runner: "editor" as const, source: "person" as const, batch: "b", queuedAt: "", state: "queued" as const };
    expect(queuedText({ queued: [], skipped: [{ test: "arena", reason: "Arena has no checks" }], queue }, "Arena")).toEqual({ text: "Arena has no checks", tone: "bad" });
    expect(queuedText({ queued: [{ ...item, state: "running" }], skipped: [], queue }, "Arena").text).toBe("Running Arena");
    expect(queuedText({ queued: [item], skipped: [], queue: { ...queue, paused: true } }, "Arena").text).toBe("Queued 1 test. The queue is paused.");
  });

  it("roots the suite tree at the suites no other holds", () => {
    const s = (id: string, items: Array<{ test: string } | { suite: string }>) => ({ id, title: id, items }) as never;
    expect(rootSuites([s("b", []), s("a", [{ suite: "b" }])]).map((x: { id: string }) => x.id)).toEqual(["a"]);
  });
});

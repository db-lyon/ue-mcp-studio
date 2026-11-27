/** The hub's addresses, the edits a person makes on the Arrangement and the clip roll, run feedback and the queue's line. */
import { describe, expect, it } from "vitest";
import type { Arrangement, Clip, QueueState, RunRecord } from "ue-mcp/daemon";
import {
  addCheck,
  addInstance,
  addNote,
  addRegion,
  arrangementRun,
  auditionLive,
  auditionOf,
  auditionRequest,
  awaitingVerdicts,
  instanceAt,
  loopRangeOf,
  punchRange,
  runnerRequest,
  runnerText,
  scheduleDaysText,
  scheduleTargetKey,
  scheduleTargetOf,
  toggleDay,
  hubAddressRoute,
  hubPath,
  instanceFits,
  moveInstance,
  nextTitle,
  offersPerformer,
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
    { id: "t2", title: "Client 1", performer: { kind: "player", client: 1 }, mute: false, solo: false, instances: [] },
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
    input: [
      { action: "/Game/Input/IA_Jump.IA_Jump", type: "bool", notes: [{ id: "n1", start: 0, length: 10 }], keys: [] },
      { action: "/Game/Input/IA_Look.IA_Look", type: "axis2d", notes: [], keys: [{ id: "k1", t: 0, v: [0, 0] }] },
    ],
    lanes: [],
  };
  it("draws a row per Input Action lane and edits notes and keys", () => {
    const rows = rollRows(clip);
    expect(rows.map((r) => [r.key, r.label])).toEqual([["input:0", "IA_Jump"], ["input:1", "IA_Look"]]);
    const { clip: added, id } = addNote(clip, "input:0", 40, 10);
    expect(added.input[0]!.notes.map((n) => n.id)).toEqual(["n1", id]);
    const moved = setPoint(clip, "input:1", "k1", 30);
    expect(moved.input[1]!.keys).toMatchObject([{ id: "k1", t: 30 }]);
  });

  it("offers players only on a track", () => {
    expect(offersPerformer({ kind: "player" })).toBe(true);
    expect(offersPerformer({ kind: "actor" })).toBe(false);
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

describe("audition, recording and where runs play", () => {
  it("loops the selected region, the one under the playhead, or the whole arrangement", () => {
    expect(loopRangeOf(A, 600, 300, "r1")).toEqual({ start: 0, end: 120, region: "r1" });
    expect(loopRangeOf(A, 600, 30)).toEqual({ start: 0, end: 120, region: "r1" });
    expect(loopRangeOf(A, 600, 300)).toEqual({ start: 0, end: 600 });
  });

  it("auditions a region when looping over one, else the arrangement from the playhead", () => {
    expect(auditionRequest("arena", 200, null)).toEqual({ test: "arena", from: 200 });
    expect(auditionRequest("arena", 200, { start: 0, end: 600 })).toEqual({ test: "arena", from: 200, loop: true });
    expect(auditionRequest("arena", 200, { start: 0, end: 120, region: "r1" })).toEqual({ test: "arena:r1", from: 119, loop: true });
    expect(auditionLive({ state: "running" })).toBe(true);
    expect(auditionLive({ state: "finished" })).toBe(false);
    expect(auditionOf({ test: "arena:r1" }, "arena")).toBe(true);
  });

  it("finds the clip under a frame and turns a range into the clip's own frames", () => {
    expect(instanceAt(A.tracks[0]!, 60, SPANS, 60)?.id).toBe("i1");
    expect(instanceAt(A.tracks[0]!, 130, SPANS, 60)).toBeNull();
    // walk runs at 30 fps: arrangement frames 20 to 80 of an instance at 10 are its frames 5 to 35, clamped to its 60.
    expect(punchRange({ at: 10 }, SPANS.walk, 60, 20, 80)).toEqual({ from: 5, to: 35 });
    expect(punchRange({ at: 0 }, SPANS.run, 60, 100, 400)).toEqual({ from: 100, to: 120 });
    expect(punchRange({ at: 0 }, SPANS.run, 60, 200, 300)).toBeNull();
  });

  it("says where a queued test plays and why", () => {
    expect(runnerText({ runner: "headless", runnerReason: "a hidden editor fits in memory" })).toBe("Headless, because a hidden editor fits in memory");
    expect(runnerText({ runner: "editor" })).toBe("Open editor, as chosen");
    expect(runnerRequest("auto")).toEqual({});
    expect(runnerRequest("editor")).toEqual({ runner: "editor" });
  });

  it("names schedule days and keeps at least one", () => {
    expect(scheduleDaysText([0, 1, 2, 3, 4, 5, 6])).toBe("Every day");
    expect(scheduleDaysText([1, 2, 3, 4, 5])).toBe("Weekdays");
    expect(scheduleDaysText([6, 0])).toBe("Weekends");
    expect(scheduleDaysText([5, 1, 3])).toBe("Mon, Wed, Fri");
    expect(toggleDay([1], 1)).toEqual([1]);
    expect(toggleDay([1], 3)).toEqual([1, 3]);
    expect(scheduleTargetOf(scheduleTargetKey({ test: "arena:r1" }))).toEqual({ test: "arena:r1" });
    expect(scheduleTargetOf("suite:smoke")).toEqual({ suite: "smoke" });
    expect(scheduleTargetOf("nope")).toBeNull();
  });
});

import { describe, expect, it, vi } from "vitest";
import type { ArrangementRun, HubOverview, Instance, InstanceLayout, InstanceStatus, RunRecord, SetAnswer } from "@ue-mcp-studio/shared";
import {
  ARRANGE_ZOOM_MAX,
  ARRANGE_ZOOM_MIN,
  SET_OPS,
  activeSetRun,
  arrangeClock,
  arrangementFindings,
  clampZoom,
  findingPlace,
  rulerMinor,
  zoomStep,
  zoomToFit,
  arrangeSeconds,
  arrangeStep,
  arrangementCursor,
  arrangementFromPlayhead,
  arrangementOn,
  awaitingChecks,
  candidateLines,
  clipScale,
  dragLines,
  emptySegmentLive,
  foldSegmentEvents,
  nextName,
  refusalFindings,
  replaceLines,
  rulerTicks,
  setApi,
  setResults,
  snapTo,
  spanProgress,
  stepSelection,
} from "./arrangement.js";

const lay = (id: string, start: number, length: number, kind: "clip" | "script" = "clip"): InstanceLayout => ({ id, kind, target: `/Game/C/${id}`, name: id, start, end: start + length, length, known: true });

describe("set api", () => {
  it("sends each route to the daemon's /v1/hub, edits as op lines", async () => {
    const req = vi.fn().mockResolvedValue({});
    const a = setApi(req);
    await a.read();
    await a.edit([SET_OPS.trackAdd('Walk "fast"'), SET_OPS.sceneTrack("boss", "walk", true)]);
    await a.clips("door", "script");
    await a.clips();
    await a.run({ kind: "scene", goalId: "boss" });
    await a.run({ kind: "arrangement" }, true);
    await a.verdict("r1", "i2.c4", "pass", "ok");
    expect(req.mock.calls).toEqual([
      ["GET", "/v1/hub/set"],
      ["POST", "/v1/hub/set/edit", { ops: "track add \"Walk 'fast'\"\nscene track boss add walk" }],
      ["GET", "/v1/hub/clips?q=door&kind=script"],
      ["GET", "/v1/hub/clips"],
      ["POST", "/v1/hub/run", { scope: { kind: "scene", goalId: "boss" } }],
      ["POST", "/v1/hub/run", { scope: { kind: "arrangement" }, next: true }],
      ["POST", "/v1/hub/runs/r1/verdict", { check: "i2.c4", verdict: "pass", note: "ok" }],
    ]);
  });
  it("reads the feature from health", () => {
    expect(arrangementOn({ features: ["hub", "hub.arrangement"] })).toBe(true);
    expect(arrangementOn({ features: ["hub"] })).toBe(false);
    expect(arrangementOn(null)).toBe(false);
  });
  it("writes every op line the issue lists", () => {
    expect(SET_OPS.trackMute("walk", true)).toBe("track mute walk on");
    expect(SET_OPS.sceneInsert("Boss", 1)).toBe('scene insert "Boss" at 1');
    expect(SET_OPS.sceneCapture("boss", 240)).toBe("scene capture boss at 240");
    expect(SET_OPS.sceneCapture("boss")).toBe("scene capture boss");
    expect(SET_OPS.sceneTrack("a", "walk", false)).toBe("scene track a remove walk");
    expect(SET_OPS.trim("walk", "i1", { in: null, out: 120.5 })).toBe("trim walk/i1 in=- out=120.5");
    expect(SET_OPS.moveToTrack("walk", "i1", "guard", 60)).toBe("move walk/i1 to guard at 60");
    expect(nextName("Track", ["Track 1", "Track 3"])).toBe("Track 4");
  });
});

describe("time", () => {
  it("plays the arrangement from the playhead, in frames at 60 a second", () => {
    expect(arrangementFromPlayhead(0, 60)).toEqual({ kind: "arrangement" });
    expect(arrangementFromPlayhead(90, 60)).toEqual({ kind: "arrangement", from: 90 });
    expect(arrangementFromPlayhead(45, 30)).toEqual({ kind: "arrangement", from: 90 });
  });
  it("snaps to quarter seconds, or whole seconds with Shift, and shows seconds", () => {
    expect(arrangeStep(60)).toBe(15);
    expect(arrangeStep(60, true)).toBe(60);
    expect(snapTo(22, 15)).toBe(15);
    expect(snapTo(-20, 15)).toBe(0);
    expect(arrangeSeconds(90, 60)).toBe("1.5 s");
    expect(arrangeSeconds(0, 60)).toBe("0 s");
    expect(rulerTicks(600, 60, 80)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(rulerTicks(600, 60, 20)).toEqual([0, 5, 10]);
    expect(rulerTicks(60, 60, 320)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(rulerMinor(80)).toBe(0.25);
    expect(rulerMinor(20)).toBe(1);
    expect(rulerMinor(4)).toBe(6);
    expect(spanProgress(100, 200, 150)).toBe(0.5);
    expect(spanProgress(100, 200, null)).toBe(0);
  });
  it("shows time as a clock, and zooms in steps, to fit, and inside its range", () => {
    expect(arrangeClock(0, 60)).toBe("0:00");
    expect(arrangeClock(5430, 60)).toBe("1:30");
    expect(arrangeClock(75, 60, true)).toBe("0:01.25");
    expect(arrangeClock(3599.7, 60, true)).toBe("1:00.00");
    expect(zoomStep(80, 1)).toBe(120);
    expect(zoomStep(5, -1)).toBe(ARRANGE_ZOOM_MIN);
    expect(clampZoom(1e9)).toBe(ARRANGE_ZOOM_MAX);
    // Twenty seconds across 800 pixels; a single frame is shown as half a second.
    expect(zoomToFit(0, 1200, 60, 800)).toBe(40);
    expect(zoomToFit(100, 101, 60, 800)).toBe(1280);
  });
});

describe("lines from drags", () => {
  const clip: Instance = { id: "i1", kind: "clip", target: "/Game/C/i1", start: 100, in: 10 };
  const script: Instance = { id: "i2", kind: "script", target: "/Game/T/i2", start: 300, length: 200 };
  it("moves, duplicates with Alt, and moves or copies to another track", () => {
    expect(dragLines("w", clip, lay("i1", 100, 100), "move", 30)).toEqual(["move w/i1 to 130"]);
    expect(dragLines("w", clip, lay("i1", 100, 100), "move", -500)).toEqual(["move w/i1 to 0"]);
    expect(dragLines("w", clip, lay("i1", 100, 100), "move", 0)).toBeNull();
    expect(dragLines("w", clip, lay("i1", 100, 100), "move", 200, { duplicate: true })).toEqual(["duplicate w/i1 at 300"]);
    expect(dragLines("w", clip, lay("i1", 100, 100), "move", 0, { toTrack: "g" })).toEqual(["move w/i1 to g at 100"]);
    expect(dragLines("w", clip, lay("i1", 100, 100), "move", 0, { toTrack: "g", duplicate: true })).toEqual(["copy w/i1 to g at 100"]);
  });
  it("trims a clip's out and in points in its own frames, keeping the end in place", () => {
    expect(dragLines("w", clip, lay("i1", 100, 100), "trimEnd", -40)).toEqual(["trim w/i1 out=70"]);
    expect(dragLines("w", clip, lay("i1", 100, 100), "trimEnd", -40, { scale: 0.5 })).toEqual(["trim w/i1 out=40"]);
    expect(dragLines("w", clip, lay("i1", 100, 100), "trimStart", 20)).toEqual(["trim w/i1 in=30", "move w/i1 by 20"]);
    expect(dragLines("w", clip, lay("i1", 100, 100), "trimStart", -50)).toEqual(["trim w/i1 in=0", "move w/i1 by -10"]);
  });
  it("resizes a step-list instance's space", () => {
    expect(dragLines("w", script, lay("i2", 300, 200, "script"), "trimEnd", 60)).toEqual(["trim w/i2 length=260"]);
    expect(dragLines("w", script, lay("i2", 300, 200, "script"), "trimStart", 50)).toEqual(["trim w/i2 length=150", "move w/i2 by 50"]);
    expect(dragLines("w", script, lay("i2", 300, 200, "script"), "trimEnd", -500)).toEqual(["trim w/i2 length=1"]);
    expect(clipScale(60, 30)).toBe(0.5);
    expect(clipScale(60, null)).toBe(1);
  });
});

describe("findings", () => {
  const set = {
    tracks: [{ id: "walk", arrangement: { rate: 60, instances: [{ id: "i3", kind: "clip", target: "/Game/C/Jmp", start: 240 }] } }],
    scenes: [],
  } as unknown as Pick<SetAnswer, "tracks" | "scenes">;
  it("retries refused lines with a candidate path", () => {
    const f = { id: "/Game/C/Jmp", field: "target", message: "no timeline clip", candidates: ["/Game/C/Jump"], blocks: true };
    expect(candidateLines(f, "/Game/C/Jump", ["add walk clip /Game/C/Jmp at 60"], null)).toEqual(["add walk clip /Game/C/Jump at 60"]);
  });
  it("points a saved instance whose clip is missing at the candidate, in place", () => {
    expect(candidateLines({ id: "walk/i3", field: "target", message: "", blocks: false }, "/Game/C/Jump", null, set)).toEqual(["retarget walk/i3 /Game/C/Jump"]);
    expect(candidateLines({ id: "walk/i3", field: "start", message: "", blocks: false }, "x", null, set)).toBeNull();
  });
  it("replaces an instance's clip, naming the kind only when it changes", () => {
    const inst = { id: "i3", kind: "clip" as const, target: "/Game/C/Jmp" };
    expect(replaceLines("walk", inst, { kind: "clip", target: "/Game/C/Jump" })).toEqual(["retarget walk/i3 /Game/C/Jump"]);
    expect(replaceLines("walk", inst, { kind: "script", target: "/Game/T/PT_Door" })).toEqual(["retarget walk/i3 script /Game/T/PT_Door"]);
    expect(replaceLines("walk", inst, { kind: "clip", target: "/Game/C/Jmp" })).toBeNull();
  });
  it("puts the refused finding first", () => {
    const a = { id: "walk/i1", field: "start", message: "overlaps i2", blocks: true };
    const b = { id: "walk/i4", field: "target", message: "missing", blocks: false };
    expect(refusalFindings({ error: "x", finding: a, findings: [a, b] })).toEqual([a, b]);
    expect(refusalFindings(undefined)).toEqual([]);
  });
  it("leaves a scene's findings to the Session view and places the rest on a track or a block", () => {
    const s = {
      tracks: [{ id: "walk", layout: [lay("i1", 0, 60)] }],
      scenes: [{ id: "boss" }],
      findings: [
        { id: "boss", field: "tracks", message: "plays nothing", blocks: false },
        { id: "walk/i1", field: "target", message: "missing", blocks: false },
        { id: "walk", field: "player", message: "no client 4", blocks: false },
      ],
    } as unknown as SetAnswer;
    const refused = [{ id: "walk/i1", field: "target", message: "missing", blocks: true }];
    expect(arrangementFindings(s).map((f) => f.id)).toEqual(["walk/i1", "walk"]);
    expect(arrangementFindings(s, refused)).toEqual([refused[0], s.findings[2]]);
    expect(findingPlace({ id: "walk/i1" }, s)).toEqual({ track: "walk", instance: "i1" });
    expect(findingPlace({ id: "walk" }, s)).toEqual({ track: "walk" });
    expect(findingPlace({ id: "/Game/C/Jmp" }, s)).toBeNull();
  });
  it("steps the selection by start", () => {
    const l = [lay("i2", 300, 10), lay("i1", 0, 10)];
    expect(stepSelection(l, null, 1)).toBe("i1");
    expect(stepSelection(l, "i1", 1)).toBe("i2");
    expect(stepSelection(l, "i2", 1)).toBe("i2");
    expect(stepSelection([], null, -1)).toBeNull();
  });
});

describe("runs", () => {
  const queue = { paused: false, current: null, queued: [], recent: [], schedules: [], editor: { connected: true } };
  it("follows the plan on the editor when it plays part of the set", () => {
    const plan = { id: "p", scope: { kind: "scene", goalId: "boss" }, items: [{ runId: "sr-2" }] };
    expect(activeSetRun({ queue: { ...queue, current: plan as never } } as Pick<HubOverview, "queue">)).toEqual({ planId: "p", runId: "sr-2" });
    expect(activeSetRun({ queue: { ...queue, current: { ...plan, scope: { kind: "goal", goalId: "x" } } as never } } as Pick<HubOverview, "queue">)).toBeNull();
    // A run this view started is known by the id the run route answered, before the queue's item shows it.
    const starting = { ...plan, items: [{ runId: null }] };
    expect(activeSetRun({ queue: { ...queue, current: starting as never } } as Pick<HubOverview, "queue">, { planId: "p", runId: "mine" })).toEqual({ planId: "p", runId: "mine" });
    expect(activeSetRun({ queue: { ...queue, current: plan as never } } as Pick<HubOverview, "queue">, { planId: "older", runId: "mine" })).toEqual({ planId: "p", runId: "sr-2" });
  });
  it("lists each instance's waiting checks with its name and question", () => {
    const inst = (name: string, awaiting?: Array<{ check: string; instruction: string }>) => ({ name, awaiting }) as never;
    expect(awaitingChecks({ instances: [inst("Look", [{ check: "i1.c1", instruction: "Does it glow?" }]), inst("Door"), inst("Open", [{ check: "2", instruction: "Is it open?" }])] } as unknown as ArrangementRun)).toEqual([
      { check: "i1.c1", instruction: "Does it glow?", name: "Look" },
      { check: "2", instruction: "Is it open?", name: "Open" },
    ]);
    expect(awaitingChecks(null)).toEqual([]);
  });
  it("keeps the newest result of each scene, track in a scene, instance and track", () => {
    const inst = (goalId: string, id: string, status: string) => ({ key: id, goalId, id, kind: "clip", target: "", name: "", player: 0, start: 0, end: 1, status, checks: { total: 0, passed: 0, failed: 0, pending: 0, awaiting: 0 }, segmentRunId: null });
    const track = (goalId: string, status: InstanceStatus) => ({ goalId, title: "", player: 0, status });
    const rec = (runId: string, kind: string, target: string, outcome: string, arrangement: Partial<ArrangementRun>) =>
      ({ runId, kind, target, name: "", outcome, startedAt: "", source: "person", arrangement: { rate: 60, length: 1, segments: [], instances: [], kind, ...arrangement } }) as unknown as RunRecord;
    const r = setResults([
      rec("a", "scene", "boss", "failed", { instances: [inst("walk", "i1", "passed"), inst("guard", "i1", "failed")] as never, tracks: [track("walk", "passed"), track("guard", "failed")] }),
      rec("b", "scene", "boss", "passed", { instances: [inst("walk", "i1", "failed")] as never, tracks: [track("walk", "failed")] }),
      rec("c", "arrangement", "arrangement", "passed", { instances: [inst("walk", "i2", "passed")] as never, tracks: [track("walk", "failed")] }),
    ]);
    expect(r.scenes).toEqual({ boss: "failed" });
    expect(r.sceneTracks).toEqual({ "boss/walk": "passed", "boss/guard": "failed" });
    expect(r.instances).toEqual({ "walk/i1": "passed", "guard/i1": "failed", "walk/i2": "passed" });
    expect(r.tracks).toEqual({ walk: "passed", guard: "failed" });
  });
  it("draws the playhead at the running segment's offset plus its clip run's position", () => {
    const run: ArrangementRun = { kind: "arrangement", goalId: "arrangement", rate: 60, length: 900, instances: [], segments: [
      { index: 0, kind: "clip", runId: "c1", offset: 0, length: 240, state: "finished" },
      { index: 1, kind: "clip", runId: "c2", offset: 840, length: 60, state: "running" },
    ] };
    let live = foldSegmentEvents(emptySegmentLive(), [
      { id: 1, type: "clip.position", data: { runId: "c2", position: 12 } },
      { id: 2, type: "clip.position", data: { runId: "other", position: 99 } },
      { id: 3, type: "clip.verdict_requested", data: { runId: "c2", awaiting: ["i3.c4"] } },
    ], new Set(["c1", "c2"]));
    expect(arrangementCursor(run, live)).toBe(852);
    live = foldSegmentEvents(live, [{ id: 1, type: "clip.position", data: { runId: "c2", position: 1 } }], new Set(["c2"]));
    expect(live.position.c2).toBe(12);
    expect(arrangementCursor({ ...run, segments: [] }, live)).toBeNull();
  });
});

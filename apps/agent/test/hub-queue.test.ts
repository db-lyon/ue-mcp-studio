/**
 * The plan queue: one item on the editor at a time, manual steps (the plan
 * waits for the verdict; a run that ended without one is not judged), stop
 * on failure, pause, cancel, move, and a plan that survives a restart.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_PLAN_OPTIONS, qaRunFromAnswer, type PlanOptions, type PlanRun, type QaRun } from "@ue-mcp-studio/shared";
import { PlanQueue, type ItemStart, type QueueRunner } from "../src/hub/queue.js";

let root: string;
let runs: Map<string, QaRun>;
let starts: string[];
let stops: Array<{ runId: string; reason: string }>;
let connected: boolean;
let busy: string | null;
/** What starting each script does; a run id by default. */
let onStart: (script: string) => ItemStart;
let n: number;

const qa = (runId: string, state: string, statuses: string[], judges: string[] = []): QaRun => qaRunFromAnswer({
  run_id: runId,
  script: "/Game/T/X",
  script_name: "X",
  state,
  steps: statuses.map((status, index) => ({ index, instruction: `s${index}`, judge: judges[index] ?? "auto", status })),
}, { sessionId: "s", seenAt: "2026-11-23T00:00:00.000Z" })!;

const runner = (): QueueRunner => ({
  connected: () => connected,
  busy: () => busy,
  start: async (item) => {
    starts.push(item.check.target);
    const r = onStart(item.check.target);
    if ("runId" in r && !runs.has(r.runId)) runs.set(r.runId, qa(r.runId, "running", ["running", "pending"]));
    return r;
  },
  run: (id) => runs.get(id),
  stop: async (runId, reason) => {
    stops.push({ runId, reason });
  },
  refresh: async () => {},
});

const plan = (scripts: string[], options: Partial<PlanOptions> = {}): PlanRun => ({
  id: `p${n++}`,
  title: "Plan",
  scope: { kind: "all" },
  options: { ...DEFAULT_PLAN_OPTIONS, ...options },
  state: "queued",
  items: scripts.map((s) => ({ check: { kind: s.startsWith("/") ? "script" : "manual", target: s }, name: s, state: "queued" })),
  trigger: "person",
  createdAt: "2026-11-23T00:00:00.000Z",
});

const make = () => new PlanQueue({ dataDir: root, runner: runner(), now: () => "2026-11-23T01:00:00.000Z" });
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hub-queue-"));
  runs = new Map();
  starts = [];
  stops = [];
  connected = true;
  busy = null;
  n = 0;
  let i = 0;
  onStart = () => ({ runId: `run${i++}` });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("PlanQueue", () => {
  it("runs a plan's items one at a time, each when the one before ended", async () => {
    const q = make();
    const p = q.enqueue(plan(["/Game/A", "/Game/B"]));
    await settle();
    expect(starts).toEqual(["/Game/A"]);
    expect(q.state().current?.state).toBe("running");
    q.observe(qa("run0", "finished", ["passed", "passed"]));
    await settle();
    expect(starts).toEqual(["/Game/A", "/Game/B"]);
    q.observe(qa("run1", "finished", ["passed", "failed"]));
    await settle();
    const done = q.state().recent[0];
    expect(done.id).toBe(p.id);
    expect(done.state).toBe("done");
    expect(done.items.map((i) => i.state)).toEqual(["passed", "failed"]);
    expect(q.state().current).toBeNull();
  });

  it("a run stopped because no verdict came: the item is not judged, with the run's reason, and the plan moves on", async () => {
    const q = make();
    q.enqueue(plan(["/Game/A", "/Game/B"]));
    await settle();
    q.observe(qa("run0", "awaiting_verdict", ["passed", "awaiting_verdict", "pending"], ["auto", "manual", "auto"]));
    expect(q.state().current!.items[0]).toMatchObject({ state: "needs_you", reason: "waiting for a verdict" });
    q.observe({ ...qa("run0", "stopped", ["passed", "awaiting_verdict", "pending"], ["auto", "manual", "auto"]), stopReason: "no verdict" });
    await settle();
    expect(q.state().current!.items[0]).toMatchObject({ state: "unjudged", reason: "no verdict" });
    expect(stops).toEqual([]);
    expect(starts).toEqual(["/Game/A", "/Game/B"]);
  });

  it("the plan waits at the verdict, then carries on", async () => {
    const q = make();
    q.enqueue(plan(["/Game/A", "/Game/B"]));
    await settle();
    q.observe(qa("run0", "awaiting_verdict", ["passed", "awaiting_verdict"], ["auto", "manual"]));
    await settle();
    expect(stops).toEqual([]);
    expect(q.state().current!.items[0].state).toBe("needs_you");
    expect(starts).toEqual(["/Game/A"]);
    expect(q.currentRun()).toBe("run0");
    q.observe(qa("run0", "finished", ["passed", "passed"], ["auto", "manual"]));
    await settle();
    expect(starts).toEqual(["/Game/A", "/Game/B"]);
  });

  it("stop on failure cancels what is left, and the plan failed", async () => {
    const q = make();
    q.enqueue(plan(["/Game/A", "/Game/B"], { stopOnFailure: true }));
    await settle();
    q.observe(qa("run0", "finished", ["failed"]));
    await settle();
    const p = q.state().recent[0];
    expect(p.state).toBe("failed");
    expect(p.items.map((i) => i.state)).toEqual(["failed", "cancelled"]);
    expect(starts).toEqual(["/Game/A"]);
  });

  it("an item that cannot run is skipped or an error, and the plan goes on", async () => {
    onStart = (s) => (s === "/Game/A" ? { error: "the open level has unsaved changes" } : { skipped: "Manual check checks cannot run yet" });
    const q = make();
    q.enqueue(plan(["/Game/A", "Looks right"]));
    await settle();
    const p = q.state().recent[0];
    expect(p.items.map((i) => [i.state, i.reason])).toEqual([["error", "the open level has unsaved changes"], ["skipped", "Manual check checks cannot run yet"]]);
    expect(p.state).toBe("done");
  });

  it("waits while paused, while the editor is away, and while a loop holds the editor", async () => {
    const q = make();
    q.setPaused(true);
    q.enqueue(plan(["/Game/A"]));
    await settle();
    expect(starts).toEqual([]);
    connected = false;
    q.setPaused(false);
    await settle();
    expect(starts).toEqual([]);
    connected = true;
    busy = "a subagent loop is running a playtest";
    await q.pump();
    expect(starts).toEqual([]);
    busy = null;
    await q.pump();
    expect(starts).toEqual(["/Game/A"]);
  });

  it("cancel: a queued plan leaves, the running one stops its run", async () => {
    const q = make();
    const a = q.enqueue(plan(["/Game/A"]));
    const b = q.enqueue(plan(["/Game/B"]));
    await settle();
    expect((await q.cancel(b.id)).state).toBe("cancelled");
    await q.cancel(a.id);
    expect(stops).toEqual([{ runId: "run0", reason: "The plan was cancelled" }]);
    expect(q.state().recent.map((p) => p.id)).toEqual([a.id, b.id]);
    await expect(q.cancel(a.id)).rejects.toMatchObject({ status: 409 });
    await expect(q.cancel("nope")).rejects.toMatchObject({ status: 404 });
  });

  it("moves a queued plan", async () => {
    const q = make();
    q.setPaused(true);
    const [a, b, c] = [q.enqueue(plan(["/Game/A"])), q.enqueue(plan(["/Game/B"])), q.enqueue(plan(["/Game/C"]))];
    q.move(c.id, 0);
    expect(q.state().queued.map((p) => p.id)).toEqual([c.id, a.id, b.id]);
    q.move(c.id, 99);
    expect(q.state().queued.map((p) => p.id)).toEqual([a.id, b.id, c.id]);
  });

  it("an editor that goes away mid-run queues the item again", async () => {
    const q = make();
    q.enqueue(plan(["/Game/A"]));
    await settle();
    connected = false;
    await q.tick();
    expect(q.state().current!.items[0]).toMatchObject({ state: "queued", runId: null });
    connected = true;
    await q.tick();
    expect(starts).toEqual(["/Game/A", "/Game/A"]);
  });

  it("survives a restart: a run Studio still has is followed, one it lost is run again", async () => {
    const q = make();
    q.enqueue(plan(["/Game/A"]));
    await settle();
    // Studio still holds run0: the new queue follows it.
    const again = make();
    expect(again.state().current!.items[0]).toMatchObject({ state: "running", runId: "run0" });
    again.observe(qa("run0", "finished", ["passed", "passed"]));
    await settle();
    expect(again.state().recent[0].items[0].state).toBe("passed");

    // A plan whose run Studio lost is queued again for when the editor is back.
    connected = false;
    const q2 = make();
    q2.enqueue(plan(["/Game/B"]));
    const file = path.join(root, "hub", "queue.json");
    const stored = JSON.parse(fs.readFileSync(file, "utf-8"));
    stored.current = { ...stored.queued[0], state: "running", items: [{ ...stored.queued[0].items[0], state: "running", runId: "gone" }] };
    stored.queued = [];
    fs.writeFileSync(file, JSON.stringify(stored));
    const q3 = make();
    expect(q3.state().current!.items[0]).toMatchObject({ state: "queued", runId: null, reason: "queued again after Studio restarted" });
  });

  it("keeps schedules with the queue", () => {
    const q = make();
    q.putSchedule({ id: "s1", title: "Nightly", scope: { kind: "all" }, options: DEFAULT_PLAN_OPTIONS, at: "02:00", days: [1], enabled: true });
    expect(make().schedules().map((s) => s.id)).toEqual(["s1"]);
    expect(q.deleteSchedule("s1")).toBe(true);
    expect(q.deleteSchedule("s1")).toBe(false);
  });
});

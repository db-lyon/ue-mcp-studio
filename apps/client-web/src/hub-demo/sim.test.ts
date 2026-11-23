import { describe, expect, it } from "vitest";
import { checkId, type HubOverview, type PlanRun, type QueueState, type RunDetail } from "@ue-mcp-studio/shared";
import { demoState } from "./seed";
import { HubDemo } from "./sim";

const T0 = Date.parse("2026-11-23T15:00:00Z");
const BASE = "/v1/ext/studio";

/** A demo on a clock the test moves, every random draw a pass. */
function demo(seed: "full" | "empty" | "fresh" = "full", random = () => 0.5) {
  let now = T0;
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  const d = new HubDemo(demoState(seed, T0), { now: () => now, random, emit: (type, data) => events.push({ type, data }) });
  const call = <T>(method: string, path: string, body?: unknown): T => {
    const url = new URL(`http://x${BASE}${path}`);
    const a = d.handle(method, url.pathname, url.searchParams, body)!;
    if (a.status >= 400) throw new Error(`${method} ${path}: ${JSON.stringify(a.body)}`);
    return a.body as T;
  };
  /** Move the clock in small steps, ticking each time. */
  const run = (ms: number) => {
    for (let t = 0; t < ms; t += 250) {
      now += 250;
      d.tick();
    }
  };
  return { d, call, run, events };
}

const goalOf = (o: HubOverview, id: string) => o.goals.find((g) => g.goal.id === id)!;

describe("the hub demo's seed", () => {
  it("computes the planned spread of statuses with the shared rules", () => {
    const { call } = demo();
    const o = call<HubOverview>("GET", "/hub");
    expect(goalOf(o, "tutorial-glade").status).toBe("met");
    expect(goalOf(o, "traversal-feel").status).toBe("at_risk");
    expect(goalOf(o, "lantern-combat").status).toBe("failing");
    expect(goalOf(o, "pause-settings").status).toBe("needs_you");
    expect(goalOf(o, "coop-join").status).toBe("at_risk");
    expect(goalOf(o, "coop-revive").status).toBe("failing");
    expect(goalOf(o, "shared-loot").status).toBe("not_started");
    expect(goalOf(o, "ashwood-perf").status).toBe("needs_you");
    expect(goalOf(o, "save-load").status).toBe("met");
    expect(goalOf(o, "vertical-slice").status).toBe("needs_you");
    expect(goalOf(o, "vertical-slice").children).toContain("lantern-combat");
    const health = Object.fromEntries(o.checks.map((c) => [c.name, c.health]));
    expect(health).toMatchObject({ PT_LedgeGrab: "flaky", PT_Coop_Join_Late: "stale", PT_Revive_Downed_Old: "missing", PT_Revive_Timer: "never_run", PT_Settings_Apply: "needs_you", PT_Stagger_Wisp: "failing", PT_Boss_Phase2: "failing" });
    expect(o.inbox.map((i) => i.kind)).toEqual(expect.arrayContaining(["verdict", "loop_blocked", "sign_off", "regression", "missing_check"]));
    expect(o.queue.queued).toHaveLength(2);
    expect(o.queue.schedules[0].nextRunAt).toBeTruthy();
  });

  it("has scripts and runs but no goals when empty, and nothing when fresh", () => {
    const empty = demo("empty").call<HubOverview>("GET", "/hub");
    expect(empty.goals).toEqual([]);
    expect(empty.checks.length).toBeGreaterThan(20);
    expect(empty.recent.length).toBeGreaterThan(0);
    const fresh = demo("fresh").call<HubOverview>("GET", "/hub");
    expect(fresh.checks).toEqual([]);
  });
});

describe("the hub demo's simulation", () => {
  it("advances the queue: a plan's items run in order, step by step, and the plan finishes", () => {
    const { call, run, events } = demo();
    call("PUT", "/hub/queue/paused", { paused: true });
    // Clear the seeded plans so only this one runs.
    for (const p of call<QueueState>("GET", "/hub/queue").queued) call("POST", `/hub/plans/${p.id}/cancel`);
    const { plan } = call<{ plan: PlanRun }>("POST", "/hub/plans", { scope: { kind: "goal", goalId: "save-load" } });
    expect(plan.items.map((i) => i.name)).toEqual(["PT_Save_Load_Checkpoint", "PT_Save_Slot_Overwrite"]);
    run(2000);
    expect(call<QueueState>("GET", "/hub/queue").current).toBeNull();
    call("PUT", "/hub/queue/paused", { paused: false });
    run(1000);
    const q = call<QueueState>("GET", "/hub/queue");
    expect(q.current?.id).toBe(plan.id);
    expect(q.current?.items[0].state).toBe("running");
    expect(events.some((e) => e.type === "script.run_started")).toBe(true);
    expect(events.some((e) => e.type === "studio.hub.changed")).toBe(true);
    run(40_000);
    const after = call<QueueState>("GET", "/hub/queue");
    expect(after.current).toBeNull();
    const done = after.recent.find((p) => p.id === plan.id)!;
    expect(done.state).toBe("done");
    // The first script's manual step was deferred: it waits in the inbox while the plan moved on.
    expect(done.items.map((i) => i.state)).toEqual(["needs_you", "passed"]);
    const types = events.map((e) => e.type);
    for (const t of ["script.step_started", "script.step_passed", "script.verdict_requested", "script.run_finished"]) expect(types).toContain(t);
  });

  it("settles a verdict and recomputes the goal's status", () => {
    const { call } = demo();
    const o = call<HubOverview>("GET", "/hub");
    const item = o.inbox.find((i) => i.kind === "verdict")!;
    expect(goalOf(o, "pause-settings").status).toBe("needs_you");
    call("POST", `/qa/runs/${encodeURIComponent(item.runId!)}/verdict`, { step: item.step, verdict: "pass" });
    const after = call<HubOverview>("GET", "/hub");
    expect(after.inbox.find((i) => i.id === item.id)).toBeUndefined();
    expect(goalOf(after, "pause-settings").status).toBe("met");
    const detail = call<RunDetail>("GET", `/hub/runs/${encodeURIComponent(item.runId!)}`);
    expect(detail.record.outcome).toBe("passed");
    expect(Object.keys(detail.series ?? {}).length).toBeGreaterThan(0);
  });

  it("holds a blocking plan at a manual step until the verdict comes", () => {
    const { call, run } = demo();
    for (const p of call<QueueState>("GET", "/hub/queue").queued) call("POST", `/hub/plans/${p.id}/cancel`);
    const check = { kind: "script", target: "/Game/PIEStudio/Scripts/Save/PT_Save_Load_Checkpoint" };
    call("POST", "/hub/plans", { scope: { kind: "checks", checks: [check] }, options: { manualSteps: "block" } });
    run(30_000);
    const q = call<QueueState>("GET", "/hub/queue");
    expect(q.current?.items[0].state).toBe("needs_you");
    const runId = q.current!.items[0].runId!;
    call("POST", `/qa/runs/${runId}/verdict`, { step: 2, verdict: "fail", note: "The tip names chapter one" });
    run(5000);
    const after = call<QueueState>("GET", "/hub/queue");
    expect(after.current).toBeNull();
    expect(after.recent[0].items[0].state).toBe("failed");
  });

  it("fixes a failing check with a fix loop, so its goal stops failing", () => {
    const { call, run } = demo();
    call("PUT", "/hub/queue/paused", { paused: true });
    const id = checkId({ kind: "script", target: "/Game/PIEStudio/Scripts/Combat/PT_Stagger_Wisp" });
    const { queued } = call<{ queued: number }>("POST", "/hub/assign-failing", { goalId: "lantern-combat" });
    expect(queued).toBe(1);
    run(15_000);
    const o = call<HubOverview>("GET", "/hub");
    // Fixed, with the failure still in its recent runs: flaky until enough passes follow, by the shared rule.
    expect(o.checks.find((c) => c.id === id)!.health).toBe("flaky");
    expect(goalOf(o, "lantern-combat").status).toBe("at_risk");
    expect(o.inbox.some((i) => i.checkId === id)).toBe(false);
  });

  it("writes playtests for a goal after a short wait", () => {
    const { call, run } = demo();
    const before = call<HubOverview>("GET", "/hub");
    const n = goalOf(before, "shared-loot").checks.length;
    call("POST", "/hub/goals/shared-loot/write-playtests", {});
    run(10_000);
    expect(goalOf(call<HubOverview>("GET", "/hub"), "shared-loot").checks.length).toBeGreaterThan(n);
  });

  it("creates, links and deletes goals, and the queue respects pause and moves", () => {
    const { call } = demo();
    const { goal } = call<{ goal: { id: string } }>("POST", "/hub/goals", { title: "Fishing is relaxing", checks: [{ kind: "script", target: "/Game/PIEStudio/Scripts/Fishing/PT_Fishing_Minigame" }] });
    expect(goal.id).toBe("fishing-is-relaxing");
    const o = call<HubOverview>("GET", "/hub");
    expect(goalOf(o, goal.id).status).toBe("not_started");
    expect(o.checks.find((c) => c.name === "PT_Fishing_Minigame")!.goalIds).toEqual([goal.id]);
    call("PUT", "/hub/queue/paused", { paused: true });
    const q = call<QueueState>("GET", "/hub/queue");
    const moved = call<QueueState>("POST", `/hub/plans/${q.queued[1].id}/move`, { to: 0 });
    expect(moved.queued[0].id).toBe(q.queued[1].id);
    call("DELETE", `/hub/goals/${goal.id}`);
    expect(call<HubOverview>("GET", "/hub").goals.some((g) => g.goal.id === goal.id)).toBe(false);
  });

  it("seeds tracker links and answers the link routes as the agent does", () => {
    const { call } = demo();
    const o = call<HubOverview>("GET", "/hub");
    const tutorial = goalOf(o, "tutorial-glade").goal;
    expect(tutorial.links?.[0].url).toBe("https://git.example.com/ember/hollow/issues/42");
    expect(goalOf(o, "lantern-combat").goal.checks.find((c) => c.target.endsWith("PT_Stagger_Wisp"))?.links?.[0].rel).toBe("blocks");
    const filed = o.recent.concat(call<{ runs: RunDetail["record"][] }>("GET", `/hub/runs?limit=200`).runs).find((r) => r.links?.length);
    expect(filed?.links?.[0].rel).toBe("filed-from-run");

    const url = "https://trello.com/c/abc/1-card";
    expect(call<{ goal: { links: unknown[] } }>("PUT", "/hub/goals/tutorial-glade", { links: [...tutorial.links!, { url }] }).goal.links).toHaveLength(2);
    expect(() => call("PUT", "/hub/goals/tutorial-glade", { links: [{ url: "javascript:x" }] })).toThrow(/400|not allowed/);
    const cid = checkId(tutorial.checks[0]);
    const put = call<{ goal: { checks: Array<{ links?: unknown[] }> } }>("PUT", `/hub/goals/tutorial-glade/checks/${encodeURIComponent(cid)}`, { links: [{ url: "jira://HOL-1" }] });
    expect(put.goal.checks[0].links).toEqual([{ url: "jira://HOL-1" }]);
    const runId = o.recent[0].runId;
    expect(call<{ record: { links: unknown[] } }>("POST", `/hub/runs/${runId}/links`, { link: { url } }).record.links).toEqual([{ url }]);
    expect(call<{ record: { links?: unknown[] } }>("DELETE", `/hub/runs/${runId}/links?url=${encodeURIComponent(url)}`).record.links).toBeUndefined();
  });

  it("ends the live run when the editor goes away, and waits for it to come back", () => {
    const { d, call, run } = demo();
    run(3000);
    const runId = call<QueueState>("GET", "/hub/queue").current!.items[0].runId!;
    d.setEditor(false);
    expect(call<RunDetail>("GET", `/hub/runs/${runId}`).record.outcome).toBe("stopped");
    expect(call<HubOverview>("GET", "/hub").editor.connected).toBe(false);
    run(5000);
    expect(call<QueueState>("GET", "/hub/queue").current!.items[1].state).toBe("queued");
    d.setEditor(true);
    run(3000);
    expect(call<QueueState>("GET", "/hub/queue").current!.items[1].state).toBe("running");
  });
});

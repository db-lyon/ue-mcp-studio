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
    // A flaky ledge grab keeps two passes in a row from counting: partial evidence is progress, not risk.
    expect(goalOf(o, "traversal-feel").status).toBe("in_progress");
    expect(goalOf(o, "lantern-combat").status).toBe("failing");
    // Its newest run was not judged: no result, so the runs before it speak for the check.
    expect(goalOf(o, "pause-settings").status).toBe("met");
    expect(goalOf(o, "coop-join").status).toBe("in_progress");
    // One of its playtests is not on this checkout: the goal waits for it, it does not fail.
    expect(goalOf(o, "coop-revive").status).toBe("in_progress");
    expect(goalOf(o, "shared-loot").status).toBe("not_started");
    expect(goalOf(o, "ashwood-perf").status).toBe("ready_to_sign_off");
    expect(goalOf(o, "save-load").status).toBe("met");
    expect(goalOf(o, "vertical-slice").status).toBe("failing");
    expect(goalOf(o, "vertical-slice").requires.map((r) => r.goal)).toContain("lantern-combat");
    // One goal under both milestones, one check in two goals at different places.
    expect(goalOf(o, "lantern-combat").parents).toEqual(["vertical-slice", "coop-beta"]);
    const jump = checkId({ kind: "script", target: o.checks.find((c) => c.name === "PT_Tutorial_Jump")!.check.target });
    expect(goalOf(o, "tutorial-glade").checks.findIndex((c) => c.id === jump)).toBe(1);
    expect(goalOf(o, "traversal-feel").checks.findIndex((c) => c.id === jump)).toBe(4);
    expect(o.checks.find((c) => c.id === jump)?.goalIds).toEqual(["tutorial-glade", "traversal-feel"]);
    expect(goalOf(o, "save-load").unused).toBe(true);
    const health = Object.fromEntries(o.checks.map((c) => [c.name, c.health]));
    expect(health).toMatchObject({ PT_LedgeGrab: "flaky", PT_Coop_Join_Late: "stale", PT_Revive_Downed_Old: "missing", PT_Revive_Timer: "never_run", PT_Settings_Apply: "passing", PT_Stagger_Wisp: "failing", PT_Boss_Phase2: "failing" });
    expect(o.attention.map((i) => i.kind)).toEqual(expect.arrayContaining(["loop_blocked", "sign_off", "regression"]));
    // A playtest missing on this checkout is no goal error and needs nobody.
    expect(o.attention.map((i) => i.kind)).not.toContain("missing_check");
    expect(goalOf(o, "coop-revive").status).not.toBe("failing");
    expect(o.queue.queued).toHaveLength(2);
    expect(o.rules.staleAfterDays).toBe(14);
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

describe("the hub demo's relationship graph", () => {
  it("answers the requires and order routes as the agent does, refusing a loop", () => {
    const { d, call } = demo();
    const status = (method: string, path: string, body?: unknown) => d.handle(method, `${BASE}${path}`, new URLSearchParams(), body)!.status;
    call("POST", "/hub/goals/coop-beta/requires", { goal: "save-load" });
    let o = call<HubOverview>("GET", "/hub");
    expect(goalOf(o, "save-load").parents).toEqual(["coop-beta"]);
    expect(goalOf(o, "save-load").unused).toBeUndefined();
    expect(status("POST", "/hub/goals/save-load/requires", { goal: "coop-beta" })).toBe(400);
    const order = goalOf(o, "coop-beta").requires.map((r) => r.goal).reverse();
    expect(call<{ goal: { requires: Array<{ goal: string }> } }>("PUT", "/hub/goals/coop-beta/requires", { order }).goal.requires.map((r) => r.goal)).toEqual(order);
    expect(status("PUT", "/hub/goals/coop-beta/requires", { order: order.slice(1) })).toBe(400);
    call("DELETE", "/hub/goals/coop-beta/requires/save-load");
    expect(status("DELETE", "/hub/goals/coop-beta/requires/save-load")).toBe(404);
    const checks = goalOf(o, "save-load").checks.map((c) => c.id).reverse();
    call("PUT", "/hub/goals/save-load/checks/order", { order: checks });
    o = call<HubOverview>("GET", "/hub");
    expect(goalOf(o, "save-load").checks.map((c) => c.id)).toEqual(checks);
    // Parents given in an update are written to the parents.
    call("PUT", "/hub/goals/save-load", { parents: ["vertical-slice"] });
    expect(goalOf(call<HubOverview>("GET", "/hub"), "save-load").parents).toEqual(["vertical-slice"]);
  });

  it("runs a milestone's checks through its goals, each once, in order", () => {
    const { call } = demo();
    const o = call<HubOverview>("GET", "/hub");
    const { plan } = call<{ plan: PlanRun }>("POST", "/hub/plans", { scope: { kind: "goal", goalId: "vertical-slice" } });
    const ids = plan.items.map((i) => checkId(i.check));
    expect(new Set(ids).size).toBe(ids.length);
    const want = ["tutorial-glade", "traversal-feel", "lantern-combat", "pause-settings"].flatMap((g) => goalOf(o, g).checks.map((c) => c.id));
    expect(ids).toEqual([...new Set(want)]);
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
    // The first script holds at its manual step: the plan waits for the verdict.
    const held = call<QueueState>("GET", "/hub/queue").current!;
    expect(held.items.map((i) => i.state)).toEqual(["needs_you", "queued"]);
    const runId = held.items[0].runId!;
    const step = call<RunDetail>("GET", `/hub/runs/${encodeURIComponent(runId)}`).steps.find((s) => s.status === "awaiting_verdict")!.index;
    call("POST", `/qa/runs/${encodeURIComponent(runId)}/verdict`, { step, verdict: "pass" });
    run(40_000);
    const after = call<QueueState>("GET", "/hub/queue");
    expect(after.current).toBeNull();
    const done = after.recent.find((p) => p.id === plan.id)!;
    expect(done.state).toBe("done");
    expect(done.items.map((i) => i.state)).toEqual(["passed", "passed"]);
    const types = events.map((e) => e.type);
    for (const t of ["script.step_started", "script.step_passed", "script.verdict_requested", "script.run_finished"]) expect(types).toContain(t);
  });

  it("an unattended plan skips a check that needs a person", () => {
    const { call, run } = demo();
    for (const p of call<QueueState>("GET", "/hub/queue").queued) call("POST", `/hub/plans/${p.id}/cancel`);
    const check = { kind: "script", target: "/Game/PIEStudio/Scripts/Save/PT_Save_Load_Checkpoint" };
    call("POST", "/hub/plans", { scope: { kind: "checks", checks: [check] }, options: { attended: false } });
    run(5000);
    expect(call<QueueState>("GET", "/hub/queue").recent[0].items[0]).toMatchObject({ state: "skipped", reason: "needs a person" });
  });

  it("holds a plan at a manual step until the verdict comes", () => {
    const { call, run } = demo();
    for (const p of call<QueueState>("GET", "/hub/queue").queued) call("POST", `/hub/plans/${p.id}/cancel`);
    const check = { kind: "script", target: "/Game/PIEStudio/Scripts/Save/PT_Save_Load_Checkpoint" };
    call("POST", "/hub/plans", { scope: { kind: "checks", checks: [check] } });
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

  it("a fix loop's passing attempt does not count; a run over its uncommitted change reads as fixed, not yet accepted", () => {
    const { call, run } = demo();
    call("PUT", "/hub/queue/paused", { paused: true });
    for (const p of call<QueueState>("GET", "/hub/queue").queued) call("POST", `/hub/plans/${p.id}/cancel`);
    const id = checkId({ kind: "script", target: "/Game/PIEStudio/Scripts/Combat/PT_Stagger_Wisp" });
    const { queued } = call<{ queued: number }>("POST", "/hub/fix", { goalId: "lantern-combat" });
    expect(queued).toBe(1);
    run(15_000);
    let o = call<HubOverview>("GET", "/hub");
    const check = () => o.checks.find((c) => c.id === id)!;
    expect(check().last?.trigger).toBe("loop");
    expect(check().health).toBe("failing");
    expect(o.evidence.current.dirty).toBe(1);
    // The regression is no longer the newest word on the check, so it leaves Needs attention.
    expect(o.attention.some((i) => i.checkId === id)).toBe(false);
    call("POST", `/hub/checks/${encodeURIComponent(id)}/run`, {});
    call("PUT", "/hub/queue/paused", { paused: false });
    run(40_000);
    // It holds at its manual step: a person passes it.
    const runId = call<QueueState>("GET", "/hub/queue").current!.items[0].runId!;
    const step = call<RunDetail>("GET", `/hub/runs/${encodeURIComponent(runId)}`).steps.find((s) => s.status === "awaiting_verdict")!.index;
    call("POST", `/qa/runs/${encodeURIComponent(runId)}/verdict`, { step, verdict: "pass" });
    run(40_000);
    o = call<HubOverview>("GET", "/hub");
    expect(check().health).toBe("passing");
    expect(check().change?.kind).toBe("fixed");
    expect(check().last?.provenance?.dirty).toBe(1);
    // A run over uncommitted changes never counts toward acceptance: the goal is in progress.
    expect(goalOf(o, "lantern-combat").status).toBe("in_progress");
  });

  it("writes playtests for a goal after a short wait", () => {
    const { call, run } = demo();
    const before = call<HubOverview>("GET", "/hub");
    const n = goalOf(before, "shared-loot").checks.length;
    call("POST", "/hub/goals/shared-loot/write-playtests", {});
    run(10_000);
    expect(goalOf(call<HubOverview>("GET", "/hub"), "shared-loot").checks.length).toBeGreaterThan(n);
  });

  it("creates, links and deletes goals, and the queue respects pause", () => {
    const { call } = demo();
    const { goal } = call<{ goal: { id: string } }>("POST", "/hub/goals", { title: "Fishing is relaxing", checks: [{ kind: "script", target: "/Game/PIEStudio/Scripts/Fishing/PT_Fishing_Minigame" }] });
    expect(goal.id).toMatch(/^fishing-is-relaxing-[0-9a-z]{4}$/);
    const o = call<HubOverview>("GET", "/hub");
    expect(goalOf(o, goal.id).status).toBe("not_started");
    expect(o.checks.find((c) => c.name === "PT_Fishing_Minigame")!.goalIds).toEqual([goal.id]);
    expect(call<QueueState>("PUT", "/hub/queue/paused", { paused: true }).paused).toBe(true);
    call("DELETE", `/hub/goals/${goal.id}`);
    expect(call<HubOverview>("GET", "/hub").goals.some((g) => g.goal.id === goal.id)).toBe(false);
  });

  it("seeds tracker links and answers the link routes as the agent does", () => {
    const { call } = demo();
    const o = call<HubOverview>("GET", "/hub");
    const tutorial = goalOf(o, "tutorial-glade").goal;
    expect(tutorial.links?.[0].url).toBe("https://git.example.com/ember/hollow/issues/42");
    expect(o.checks.find((c) => c.check.target.endsWith("PT_Stagger_Wisp"))?.links?.[0].rel).toBe("blocks");
    const filed = o.recent.concat(call<{ runs: RunDetail["record"][] }>("GET", `/hub/runs?limit=200`).runs).find((r) => r.links?.length);
    expect(filed?.links?.[0].rel).toBe("filed-from-run");

    const url = "https://trello.com/c/abc/1-card";
    expect(call<{ goal: { links: unknown[] } }>("PUT", "/hub/goals/tutorial-glade", { links: [...tutorial.links!, { url }] }).goal.links).toHaveLength(2);
    expect(() => call("PUT", "/hub/goals/tutorial-glade", { links: [{ url: "javascript:x" }] })).toThrow(/400|not allowed/);
    const cid = checkId(tutorial.checks[0]);
    const put = call<{ meta: { links?: unknown[] } }>("PUT", `/hub/checks/${encodeURIComponent(cid)}`, { links: [{ url: "jira://HOL-1" }] });
    expect(put.meta.links).toEqual([{ url: "jira://HOL-1" }]);
    // The goal store moves as one file: exported, then imported into the same store, nothing changes.
    const file = call<{ records: unknown[] }>("GET", "/hub/store");
    expect(call<{ added: number; conflicts: unknown[] }>("POST", "/hub/store", file)).toMatchObject({ added: 0, conflicts: [] });
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

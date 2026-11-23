/**
 * The Playtest Hub end to end over the real QaBroker, PlaytestIndex and
 * session store, with ue-mcp faked: the overview and missing checks, goal
 * routes and their errors, a plan that runs through the card and holds at
 * manual steps for their verdicts, unattended plans, Write
 * playtests linking what it drafts, the run screen's evidence, schedules,
 * hub.changed, remote access and the experiment setting.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ActionResult } from "ue-mcp/daemon";
import { HUB_ROUTES, type HubOverview, type PlanRun, type QueueState } from "@ue-mcp-studio/shared";
import { remotePath } from "@ue-mcp-studio/remote";
import { SessionStore } from "../src/sessions.js";
import { QaBroker, type QaHost } from "../src/qa.js";
import { PlaytestIndex } from "../src/playtest-index.js";
import { registerHub } from "../src/hub/routes.js";
import type { Hub } from "../src/hub/hub.js";
import { nextRunAt } from "../src/hub/schedules.js";
import { sample, seriesOf } from "../src/hub/evidence.js";
import { sensitiveRequest } from "../src/remote/pin-lock.js";
import { SettingsStore } from "../src/settings.js";

const ok = (body: Record<string, unknown>): ActionResult => ({ isError: false, content: [{ type: "text", text: JSON.stringify({ success: true, ...body }) }] });
const fail = (error: string): ActionResult => ({ isError: false, content: [{ type: "text", text: JSON.stringify({ success: false, error }) }] });

const DOOR = "/Game/Tests/DoorOpens";
const JUMP = "/Game/Tests/JumpCheck";
const STEPS = [{ instruction: "Walk to the door", judge: "auto", expect: { value: "Door.Distance", op: "decreasing" } }, { instruction: "It looks right", judge: "manual" }];

type Handler = (req: { params: Record<string, string>; query?: unknown; body?: unknown }) => unknown;
let root: string;
let store: SessionStore;
let connected: boolean;
let listed: string[];
let calls: Array<{ action: string; args: Record<string, unknown> }>;
let published: Array<{ type: string; data?: Record<string, unknown> }>;
let listeners: Array<(e: { type: string; data: Record<string, unknown> }) => void>;
/** Each run's status as the fake editor reports it. */
let status: Map<string, Record<string, unknown>>;
/** The run the fake editor holds: verdicts for any other are refused. */
let held: string | null;
let routes: Map<string, Handler>;
let k: number;
let hub: Hub;
let broker: QaBroker;

const steps = (statuses: string[]) => statuses.map((s, index) => ({ index, instruction: STEPS[index].instruction, judge: STEPS[index].judge, status: s }));

const host = (): QaHost & Record<string, unknown> => ({
  projectDir: path.join(root, "project"),
  dataDir: path.join(root, "data"),
  callAction: async (_category: string, action: string, args: Record<string, unknown> = {}) => {
    calls.push({ action, args });
    switch (action) {
      case "script_list":
        return ok({ scripts: listed.map((p) => ({ path: p, name: p.split("/").pop(), map: "/Game/Maps/Test" })), count: listed.length });
      case "script_read":
        return listed.includes(String(args.path)) ? ok({ path: args.path, name: String(args.path).split("/").pop(), steps: STEPS }) : fail(`no script at ${String(args.path)}`);
      case "script_run": {
        const runId = `script_${String(args.script).split("/").pop()}_${k++}`;
        const s = { run_id: runId, script: args.script, script_name: String(args.script).split("/").pop(), state: "armed", mode: "full", steps: steps(["pending", "pending"]), awaiting: [], last_seq: 1 };
        status.set(runId, s);
        held = runId;
        return ok(s);
      }
      case "script_status":
      case "script_results":
        return ok(status.get(String(args.run_id)) ?? { run_id: args.run_id, state: "idle", steps: [] });
      case "script_stop": {
        const s = status.get(String(args.run_id));
        if (s) status.set(String(args.run_id), { ...s, state: "stopped", ...(args.reason ? { stop_reason: args.reason } : {}) });
        return ok({ stopped: true });
      }
      case "verdict": {
        // As the bridge words it: a verdict is taken only for the run the editor holds, ended or not.
        if (args.run_id !== held) return fail(`Run ${String(args.run_id)} is not the current run (${held})`);
        const s = status.get(String(args.run_id))!;
        return ok({ run_id: args.run_id, step: args.step, status: args.verdict === "pass" ? "passed" : "failed", verdict: args.verdict, verdict_source: "action", state: s.state, awaiting: [] });
      }
      case "script_runs":
        return ok({ runs: [] });
      default:
        return ok({});
    }
  },
  editors: () => [{ connected }],
  events: {
    publish: (type: string, data?: Record<string, unknown>) => void published.push({ type, data }),
    subscribe: (l: (e: { type: string; data: Record<string, unknown> }) => void) => {
      listeners.push(l);
      return () => void (listeners = listeners.filter((x) => x !== l));
    },
  },
  log: { info() {}, warn() {} },
  route: (method: string, p: string, h: Handler) => void routes.set(`${method} ${p}`, h),
});

/** Call a registered route as the daemon would, matching :params. */
async function call(method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  const [p, qs] = url.split("?");
  for (const [key, h] of routes) {
    const [m, pattern] = key.split(" ");
    if (m !== method) continue;
    const a = pattern.split("/");
    const b = p.split("/");
    if (a.length !== b.length) continue;
    const params: Record<string, string> = {};
    if (!a.every((seg, i) => (seg.startsWith(":") ? ((params[seg.slice(1)] = decodeURIComponent(b[i])), true) : seg === b[i]))) continue;
    const query = Object.fromEntries(new URLSearchParams(qs ?? ""));
    const r = (await h({ params, query, body })) as { status?: number; body?: unknown };
    return { status: r.status ?? 200, body: r.body };
  }
  throw new Error(`no route ${method} ${url}`);
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const enc = encodeURIComponent;

function setup(o: { writePlaytests?: (sid: string, text: string) => Promise<void>; enabled?: boolean } = {}) {
  const h = host();
  broker = new QaBroker({ host: h, store });
  const index = new PlaytestIndex({ host: h as never, broker, store });
  hub = registerHub(h as never, { broker, index, store, playtestRuns: () => "manual", signer: () => "octocat", enabled: () => o.enabled !== false, writePlaytests: o.writePlaytests, timers: false });
  return h;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hub-"));
  fs.mkdirSync(path.join(root, "project"), { recursive: true });
  store = new SessionStore(path.join(root, "data"), () => {});
  connected = true;
  listed = [DOOR, JUMP];
  calls = [];
  published = [];
  listeners = [];
  status = new Map();
  held = null;
  routes = new Map();
  k = 0;
});
afterEach(() => {
  hub?.dispose();
  broker?.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("routes", () => {
  it("registers every route HUB_ROUTES names", () => {
    setup();
    for (const spec of Object.values(HUB_ROUTES)) {
      const [method, p] = spec.split(" ");
      expect(routes.has(`${method} ${p.split("?")[0]}`), spec).toBe(true);
    }
  });

  it("goals: create, read, update, checks, sign-off, delete, with 400 and 404", async () => {
    setup();
    expect((await call("POST", "/hub/goals", { title: "" })).status).toBe(400);
    const created = await call("POST", "/hub/goals", { title: "Door opens", checks: [{ kind: "script", target: DOOR }] });
    expect(created.status).toBe(200);
    const id = created.body.goal.id;
    expect(fs.existsSync(path.join(root, "project", "QA", "Goals", `${id}.json`))).toBe(true);
    expect((await call("GET", `/hub/goals/${id}`)).body).toMatchObject({ status: "not_started", progress: { met: 0, total: 1 } });
    expect((await call("GET", "/hub/goals/nope")).status).toBe(404);
    expect((await call("PUT", `/hub/goals/${id}`, { priority: "p9" })).status).toBe(400);
    expect((await call("POST", `/hub/goals/${id}/checks`, { checks: [{ kind: "script", target: JUMP }] })).body.goal.checks).toHaveLength(2);
    expect((await call("DELETE", `/hub/goals/${id}/checks/${enc(`script:${JUMP}`)}`)).body.goal.checks).toHaveLength(1);
    expect((await call("POST", `/hub/goals/${id}/sign-off`, { note: "ok" })).body.goal.signOff).toMatchObject({ by: "octocat", note: "ok" });
    expect((await call("DELETE", `/hub/goals/${id}/sign-off`)).body.goal.signOff).toBeUndefined();
    expect((await call("DELETE", `/hub/goals/${id}`)).status).toBe(204);
    expect((await call("DELETE", `/hub/goals/${id}`)).status).toBe(404);
  });

  it("required goals: add, reorder, remove, a loop is 400 with its path, and the overview shows parents and unused", async () => {
    setup();
    const mk = async (title: string, extra: Record<string, unknown> = {}) => (await call("POST", "/hub/goals", { title, ...extra })).body.goal.id as string;
    const alpha = await mk("Alpha", { kind: "milestone" });
    const beta = await mk("Beta", { kind: "milestone" });
    const door = await mk("Door", { checks: [{ kind: "script", target: DOOR }] });
    const jump = await mk("Jump", { checks: [{ kind: "script", target: JUMP }, { kind: "script", target: DOOR }] });
    await mk("Loose");
    expect((await call("POST", `/hub/goals/${alpha}/requires`, { goal: door })).status).toBe(200);
    await call("POST", `/hub/goals/${alpha}/requires`, { goal: jump });
    await call("POST", `/hub/goals/${beta}/requires`, { goal: door });
    expect((await call("PUT", `/hub/goals/${alpha}/requires`, { order: [jump, door] })).body.goal.requires).toEqual([{ goal: jump }, { goal: door }]);
    const loop = await call("POST", `/hub/goals/${door}/requires`, { goal: alpha });
    expect(loop.status).toBe(400);
    expect(loop.body.error).toContain(`${door} > ${alpha} > ${door}`);
    expect((await call("PUT", `/hub/goals/${jump}/checks/order`, { order: [`script:${DOOR}`, `script:${JUMP}`] })).body.goal.checks[0].target).toBe(DOOR);
    const o = (await call("GET", "/hub")).body as HubOverview;
    const g = (id: string) => o.goals.find((x) => x.goal.id === id)!;
    expect(g(door).parents).toEqual([alpha, beta]);
    expect(g(alpha).requires).toEqual([{ goal: jump, required: true, status: "not_started" }, { goal: door, required: true, status: "not_started" }]);
    expect(g("loose").unused).toBe(true);
    expect(g(door).unused).toBeUndefined();
    expect(g(alpha).unused).toBeUndefined();
    // Running a milestone runs each check reachable through its goals once, in order.
    const plan = (await call("POST", "/hub/plans", { scope: { kind: "goal", goalId: alpha } })).body.plan as PlanRun;
    expect(plan.items.map((i) => i.check.target)).toEqual([DOOR, JUMP]);
    expect((await call("DELETE", `/hub/goals/${alpha}/requires/${jump}`)).body.goal.requires).toEqual([{ goal: door }]);
    expect((await call("DELETE", `/hub/goals/${alpha}/requires/${jump}`)).status).toBe(404);
  });

  it("bad plan, schedule and query bodies are 400; unknown ids 404", async () => {
    setup();
    expect((await call("POST", "/hub/plans", { scope: { kind: "nope" } })).status).toBe(400);
    expect((await call("POST", "/hub/plans", { scope: { kind: "all" }, options: { attended: "yes" } })).status).toBe(400);
    expect((await call("POST", "/hub/plans", { scope: { kind: "all" }, options: { verdictWaitMinutes: 7 } })).status).toBe(400);
    expect((await call("POST", "/hub/plans", { scope: { kind: "goal", goalId: "missing" } })).status).toBe(404);
    expect((await call("POST", "/hub/schedules", { title: "N", scope: { kind: "all" }, at: "25:00", days: [1] })).status).toBe(400);
    expect((await call("POST", "/hub/schedules", { title: "N", scope: { kind: "all" }, at: "02:00", days: [] })).status).toBe(400);
    expect((await call("PUT", "/hub/schedules/nope", { enabled: false })).status).toBe(404);
    expect((await call("PUT", "/hub/queue/paused", { paused: "yes" })).status).toBe(400);
    expect((await call("POST", "/hub/plans/nope/cancel")).status).toBe(404);
    expect((await call("GET", "/hub/runs/nope")).status).toBe(404);
    expect((await call("GET", "/hub/runs?check=bad")).status).toBe(400);
    expect((await call("GET", `/hub/checks/${enc("script:/Game/Nothing")}`)).status).toBe(404);
  });
});

describe("overview", () => {
  it("checks are the goals' and the editor's scripts; a script the editor no longer lists is missing only while it is connected", async () => {
    setup();
    await call("POST", "/hub/goals", { title: "Gone", checks: [{ kind: "script", target: "/Game/Tests/Deleted" }, { kind: "manual", target: "Feels good" }] });
    const o = (await call("GET", "/hub")).body as HubOverview;
    expect(o.checks.map((c) => c.id).sort()).toEqual([`manual:Feels good`, `script:${DOOR}`, `script:${JUMP}`, "script:/Game/Tests/Deleted"].sort());
    expect(o.checks.find((c) => c.id === "script:/Game/Tests/Deleted")).toMatchObject({ health: "missing", missing: true, goalIds: ["gone"] });
    expect(o.checks.find((c) => c.id === `script:${DOOR}`)).toMatchObject({ health: "never_run", goalIds: [], map: "/Game/Maps/Test", name: "DoorOpens" });
    expect(o.goals[0].status).toBe("failing");
    expect(o.attention.map((i) => i.kind)).toEqual(["missing_check"]);
    expect(o.goalsDir).toBe("QA/Goals");

    // Offline nothing is flagged missing.
    connected = false;
    setup();
    const off = (await call("GET", "/hub")).body as HubOverview;
    expect(off.checks.find((c) => c.id === "script:/Game/Tests/Deleted")?.health).toBe("never_run");
    expect(off.editor.connected).toBe(false);
  });

  it("goal files that do not parse are warnings", async () => {
    fs.mkdirSync(path.join(root, "project", "QA", "Goals"), { recursive: true });
    fs.writeFileSync(path.join(root, "project", "QA", "Goals", "bad.json"), "{");
    setup();
    expect(((await call("GET", "/hub")).body as HubOverview).warnings[0]).toContain("bad.json is not valid JSON");
  });
});

describe("plans", () => {
  it("runs a goal through the card; the plan holds at its manual step with PIE paused until the verdict, then moves on", async () => {
    setup();
    const g = (await call("POST", "/hub/goals", { title: "Doors", checks: [{ kind: "script", target: DOOR }, { kind: "script", target: JUMP }, { kind: "manual", target: "Feels good" }] })).body.goal;
    const planned = await call("POST", "/hub/plans", { scope: { kind: "goal", goalId: g.id } });
    expect(planned.body.plan).toMatchObject({ title: "Run Doors", trigger: "person", options: { attended: true }, items: [{ name: "DoorOpens" }, { name: "JumpCheck" }, { name: "Feels good" }] });
    await settle();
    await settle();

    // The script's card is made in one session for the plan, and its run holds at manual steps (ue-mcp's default).
    const start = calls.find((c) => c.action === "script_run")!;
    expect(start.args).toMatchObject({ script: DOOR, start_pie: true });
    expect(start.args.block_on_manual).toBeUndefined();
    const plan = () => ((call("GET", "/hub/queue") as Promise<{ body: QueueState }>));
    let q = (await plan()).body;
    const run0 = q.current!.items[0].runId!;
    expect(run0).toBe("script_DoorOpens_0");
    expect(store.all().map((s) => s.title)).toContain("Plan: Run Doors");
    expect(hub.runs.get(run0)).toMatchObject({ source: "plan", planRunId: q.current!.id });

    // The manual step waits: PIE is paused, the item needs you, and nothing else starts.
    status.set(run0, { ...status.get(run0)!, state: "awaiting_verdict", steps: steps(["passed", "awaiting_verdict"]), awaiting: [1] });
    await hub.tick();
    await settle();
    expect(calls.filter((c) => c.action === "set_pie_paused").map((c) => c.args)).toEqual([{ paused: true, mode: "debug" }]);
    expect(broker.hold.held()).toMatchObject([{ runId: run0, step: 1, instruction: "It looks right", paused: true }]);
    expect(calls.some((c) => c.action === "script_stop")).toBe(false);
    q = (await plan()).body;
    expect(q.current!.items.map((i) => i.state)).toEqual(["needs_you", "queued", "queued"]);
    expect(((await call("GET", "/hub")).body as HubOverview).goals[0].status).toBe("needs_you");

    // The verdict: PIE runs again, the run finishes and the plan goes on.
    expect("run" in (await broker.verdict(run0, { step: 1, verdict: "pass" }))).toBe(true);
    await settle();
    expect(calls.filter((c) => c.action === "set_pie_paused").map((c) => c.args.paused)).toEqual([true, false]);
    expect(broker.hold.held()).toEqual([]);
    status.set(run0, { ...status.get(run0)!, state: "finished", steps: steps(["passed", "passed"]), awaiting: [] });
    await hub.tick();
    await settle();
    q = (await plan()).body;
    expect(q.current!.items[0].state).toBe("passed");
    expect(q.current!.items[1]).toMatchObject({ state: "running", runId: "script_JumpCheck_1" });

    // The second item fails; the manual check is skipped; the plan is done.
    const run1 = "script_JumpCheck_1";
    status.set(run1, { ...status.get(run1)!, state: "finished", steps: steps(["failed", "skipped"]) });
    await hub.tick();
    await settle();
    q = (await plan()).body;
    expect(q.current).toBeNull();
    expect(q.recent[0].items.map((i) => i.state)).toEqual(["passed", "failed", "skipped"]);
    expect(q.recent[0].items[2].reason).toBe("Manual check checks cannot run yet");
  });

  it("a plan's own verdict wait sets the held run's deadline; Stop now ends the run and PIE, and the item is not judged", async () => {
    setup();
    await call("POST", "/hub/plans", { scope: { kind: "checks", checks: [{ kind: "script", target: DOOR }] }, options: { verdictWaitMinutes: 2 } });
    await settle();
    await settle();
    const run0 = "script_DoorOpens_0";
    status.set(run0, { ...status.get(run0)!, state: "awaiting_verdict", steps: steps(["passed", "awaiting_verdict"]), awaiting: [1] });
    await hub.tick();
    const [h] = broker.hold.held();
    expect(Date.parse(h.dueAt) - Date.parse(h.since)).toBe(2 * 60_000);

    // The fake editor records the stop's reason as ue-mcp does.
    expect("run" in (await broker.stopRun(run0, "no verdict"))).toBe(true);
    expect(calls.filter((c) => c.action === "script_stop").map((c) => c.args)).toEqual([{ run_id: run0, reason: "no verdict" }]);
    expect(calls.filter((c) => c.action === "play_in_editor").map((c) => c.args)).toEqual([{ pieAction: "stop" }]);
    await hub.tick();
    await settle();
    const q = (await call("GET", "/hub/queue")).body as QueueState;
    expect(q.recent[0].items[0]).toMatchObject({ state: "unjudged", reason: "no verdict" });
    // No result: the check keeps the health it had (never run here), it is not failing.
    expect(hub.runs.get(run0)?.outcome).toBe("unjudged");
    expect(((await call("GET", "/hub")).body as HubOverview).checks.find((c) => c.id === `script:${DOOR}`)?.health).toBe("never_run");
    expect(broker.hold.held()).toEqual([]);
    // Stopped for the verdict, PIE was not resumed.
    expect(calls.filter((c) => c.action === "set_pie_paused").map((c) => c.args.paused)).toEqual([true]);
  });

  it("an unattended plan never starts a check that needs a person; a schedule's plans are unattended unless it says otherwise", async () => {
    setup();
    listed = [DOOR, JUMP, "/Game/Tests/AutoOnly"];
    await call("POST", "/hub/plans", { scope: { kind: "checks", checks: [{ kind: "script", target: DOOR }] }, options: { attended: false } });
    await settle();
    await settle();
    let q = (await call("GET", "/hub/queue")).body as QueueState;
    expect(q.recent[0].items[0]).toMatchObject({ state: "skipped", reason: "needs a person" });
    expect(calls.some((c) => c.action === "script_run")).toBe(false);
    const p = await hub.plan({ scope: { kind: "checks", checks: [{ kind: "script", target: JUMP }] } }, "schedule");
    expect(p.options.attended).toBe(false);
    await settle();
    await settle();
    q = (await call("GET", "/hub/queue")).body as QueueState;
    expect(q.recent[0].items[0]).toMatchObject({ state: "skipped", reason: "needs a person" });
    expect(calls.some((c) => c.action === "script_run")).toBe(false);
    expect(broker.hold.held()).toEqual([]);
  });

  it("run a check is a one-item plan; agents may not plan under Manual", async () => {
    setup();
    const r = await call("POST", `/hub/checks/${enc(`script:${DOOR}`)}/run`, {});
    expect((r.body.plan as PlanRun).items).toHaveLength(1);
    await expect(hub.plan({ scope: { kind: "all" } }, "agent")).rejects.toMatchObject({ status: 409 });
  });

  it("a plan with nothing in scope is refused", async () => {
    setup();
    expect((await call("POST", "/hub/plans", { scope: { kind: "failing" } })).status).toBe(409);
  });

  it("with the experiment off a queued plan waits and a tick asks the editor for nothing", async () => {
    let on = false;
    const h = host();
    broker = new QaBroker({ host: h, store });
    hub = registerHub(h as never, { broker, index: new PlaytestIndex({ host: h as never, broker, store }), store, playtestRuns: () => "manual", signer: () => "you", enabled: () => on, timers: false });
    await call("POST", "/hub/plans", { scope: { kind: "checks", checks: [{ kind: "script", target: DOOR }] } });
    calls = [];
    await hub.tick();
    await settle();
    expect(calls).toEqual([]);
    expect((await call("GET", "/hub/queue")).body.queued).toHaveLength(1);
    on = true;
    await hub.tick();
    await settle();
    expect(calls.some((c) => c.action === "script_run")).toBe(true);
  });

  it("waits while a session's own run is on the editor", async () => {
    setup();
    await call("POST", "/hub/plans", { scope: { kind: "checks", checks: [{ kind: "script", target: DOOR }] } });
    await settle();
    await settle();
    expect(calls.filter((c) => c.action === "script_run")).toHaveLength(1);
    // The plan's run ends; a person's run of another script holds the editor before the next plan starts.
    const run0 = "script_DoorOpens_0";
    status.set(run0, { ...status.get(run0)!, state: "finished", steps: steps(["passed", "passed"]) });
    await hub.tick();
    const other = broker.all().find((r) => r.runId === run0)!;
    (broker as unknown as { runs: Map<string, unknown> }).runs.set("chat_run", { ...other, runId: "chat_run", state: "running" });
    await call("POST", "/hub/plans", { scope: { kind: "checks", checks: [{ kind: "script", target: JUMP }] } });
    await settle();
    expect(calls.filter((c) => c.action === "script_run")).toHaveLength(1);
    expect((await call("GET", "/hub/queue")).body.queued).toHaveLength(1);
  });
});

describe("write playtests", () => {
  it("runs the flow in a new session seeded with the goal, and links what it drafts", async () => {
    let seeded = "";
    setup({
      writePlaytests: async (sid, text) => {
        seeded = text;
        await broker.drafted(sid, { path: "/Game/Tests/NewOne", name: "NewOne", steps: STEPS });
      },
    });
    const g = (await call("POST", "/hub/goals", { title: "Doors", description: "Every door opens", checks: [{ kind: "script", target: DOOR }] })).body.goal;
    const r = await call("POST", `/hub/goals/${g.id}/write-playtests`, {});
    expect(r.status).toBe(202);
    await settle();
    expect(store.get(r.body.sessionId)?.title).toBe("Playtests for Doors");
    expect(seeded).toContain('"Doors"');
    expect(seeded).toContain("Every door opens");
    expect(seeded).toContain("DoorOpens");
    // Names, not paths: a path would become the flow's target.
    expect(seeded).not.toContain(DOOR);
    expect(hub.goals.get(g.id)?.checks.map((c) => c.target)).toEqual([DOOR, "/Game/Tests/NewOne"]);
  });

  it("is a 409 without a flow and a 404 for no goal", async () => {
    setup();
    const g = (await call("POST", "/hub/goals", { title: "Doors" })).body.goal;
    expect((await call("POST", `/hub/goals/${g.id}/write-playtests`, {})).status).toBe(409);
    expect((await call("POST", "/hub/goals/nope/write-playtests", {})).status).toBe(404);
  });
});

describe("run screen", () => {
  it("a backfilled run with its results, observed series, last pass and changed steps", async () => {
    const obs = path.join(root, "project", "Saved", "MCPObservations");
    const write = (id: string, at: string, stepStatus: string[]) => {
      fs.mkdirSync(path.join(obs, id), { recursive: true });
      fs.writeFileSync(path.join(obs, id, "results.json"), JSON.stringify({ run_id: id, script: DOOR, script_name: "DoorOpens", state: "finished", started_at: at, ended_at: at, steps: steps(stepStatus).map((s, i) => ({ ...s, started_at_ms: i * 1000, ended_at_ms: i * 1000 + 500 })) }));
    };
    write("script_DoorOpens_old", "2026-11-20T00:00:00.000Z", ["passed", "passed"]);
    write("script_DoorOpens_new", "2026-11-22T00:00:00.000Z", ["failed", "passed"]);
    const rows = ["# observer", "frame,time,t:Door.Distance,speed2d", ...Array.from({ length: 1000 }, (_, i) => `${i},${(i / 60).toFixed(4)},${500 - i * 0.1},${i % 7}`)];
    fs.writeFileSync(path.join(obs, "script_DoorOpens_new", "observation.csv"), rows.join("\n"));
    // No editor: the results files are the backfill.
    connected = false;
    setup();
    await hub.backfill(true);
    const d = (await call("GET", "/hub/runs/script_DoorOpens_new")).body;
    expect(d.record).toMatchObject({ outcome: "failed", source: "outside", failedSteps: [0] });
    expect(d.steps[0]).toMatchObject({ index: 0, judge: "auto", status: "failed", startMs: 0, endMs: 500 });
    expect(d.series["Door.Distance"]).toHaveLength(300);
    expect(d.series["Door.Distance"][0]).toEqual([0, 500]);
    expect(d.series.speed2d).toBeDefined();
    expect(d.lastPass.runId).toBe("script_DoorOpens_old");
    expect(d.changedSteps).toEqual([0]);
    expect(d.resultsUrl).toBe("/v1/ext/studio/qa/runs/script_DoorOpens_new/results");
    const page = (await call("GET", `/hub/runs?check=${enc(`script:${DOOR}`)}&limit=1`)).body;
    expect(page.runs.map((r: { runId: string }) => r.runId)).toEqual(["script_DoorOpens_new"]);
    expect(page.more).toBe(true);
    const o = (await call("GET", "/hub")).body as HubOverview;
    expect(o.attention.find((i) => i.kind === "regression")).toMatchObject({ runId: "script_DoorOpens_new", checkId: `script:${DOOR}` });
    const detail = (await call("GET", `/hub/checks/${enc(`script:${DOOR}`)}`)).body;
    expect(detail.state).toMatchObject({ health: "failing", recent: ["failed", "passed"] });
  });

  it("links: a run's are kept in the history and survive the run changing; a check's show on the check across goals", async () => {
    const obs = path.join(root, "project", "Saved", "MCPObservations", "script_DoorOpens_1");
    fs.mkdirSync(obs, { recursive: true });
    fs.writeFileSync(path.join(obs, "results.json"), JSON.stringify({ run_id: "script_DoorOpens_1", script: DOOR, script_name: "DoorOpens", state: "finished", started_at: "2026-11-22T00:00:00.000Z", ended_at: "2026-11-22T00:00:00.000Z", steps: steps(["failed", "passed"]) }));
    connected = false;
    setup();
    const url = "https://git.example.com/ember/hollow/issues/42";
    // A run only results.json knows is recorded on its first link.
    const added = await call("POST", "/hub/runs/script_DoorOpens_1/links", { link: { url, rel: "filed-from-run" } });
    expect(added.status).toBe(200);
    expect(added.body.record.links).toEqual([{ url, rel: "filed-from-run" }]);
    expect((await call("POST", "/hub/runs/script_DoorOpens_1/links", { link: { url: "javascript:x" } })).status).toBe(400);
    expect((await call("POST", "/hub/runs/nope/links", { link: { url } })).status).toBe(404);
    await hub.backfill(true);
    expect((await call("GET", "/hub/runs/script_DoorOpens_1")).body.record.links).toEqual([{ url, rel: "filed-from-run" }]);
    expect((await call("DELETE", `/hub/runs/script_DoorOpens_1/links?url=${enc("https://other")}`)).status).toBe(404);
    expect((await call("DELETE", `/hub/runs/script_DoorOpens_1/links?url=${enc(url)}`)).body.record.links).toBeUndefined();

    const a = (await call("POST", "/hub/goals", { title: "A", checks: [{ kind: "script", target: DOOR, links: [{ url: "https://trello.com/c/1" }] }] })).body.goal;
    const b = (await call("POST", "/hub/goals", { title: "B", checks: [{ kind: "script", target: DOOR }] })).body.goal;
    const put = await call("PUT", `/hub/goals/${b.id}/checks/${enc(`script:${DOOR}`)}`, { links: [{ url: "jira://HOL-9" }] });
    expect(put.body.goal.checks[0].links).toEqual([{ url: "jira://HOL-9" }]);
    expect((await call("PUT", `/hub/goals/${a.id}/checks/${enc("script:/Game/None")}`, { title: "x" })).status).toBe(404);
    const detail = (await call("GET", `/hub/checks/${enc(`script:${DOOR}`)}`)).body;
    expect(detail.state.check.links).toEqual([{ url: "https://trello.com/c/1" }, { url: "jira://HOL-9" }]);
    expect((await call("GET", `/hub/goals/${b.id}`)).body.checks[0].check.links).toEqual([{ url: "jira://HOL-9" }]);
  });

  it("samples a series down to the cap and keeps its end", () => {
    const pts = Array.from({ length: 1001 }, (_, i) => [i, i] as [number, number]);
    const s = sample(pts, 300);
    expect(s).toHaveLength(300);
    expect(s[0]).toEqual([0, 0]);
    expect(s[299]).toEqual([1000, 1000]);
    expect(seriesOf("frame,time\n1,0")).toEqual({});
  });
});

describe("schedules", () => {
  it("the next run is the next allowed day at that local time", () => {
    const mon = new Date(2026, 10, 23, 1, 0); // a Monday, 01:00 local
    expect(nextRunAt({ at: "02:00", days: [1] }, mon)?.getTime()).toBe(new Date(2026, 10, 23, 2, 0).getTime());
    expect(nextRunAt({ at: "00:30", days: [1] }, mon)?.getTime()).toBe(new Date(2026, 10, 30, 0, 30).getTime());
    expect(nextRunAt({ at: "02:00", days: [3] }, mon)?.getTime()).toBe(new Date(2026, 10, 25, 2, 0).getTime());
  });

  it("a due schedule with the editor closed is skipped and says why; with it open, it queues its plan", async () => {
    let now = new Date(2026, 10, 23, 1, 0).getTime();
    const h = host();
    broker = new QaBroker({ host: h, store });
    hub = registerHub(h as never, { broker, index: new PlaytestIndex({ host: h as never, broker, store }), store, playtestRuns: () => "manual", signer: () => "you", enabled: () => true, timers: false, now: () => now });
    const s = (await call("POST", "/hub/schedules", { title: "Nightly", scope: { kind: "all" }, at: "02:00", days: [0, 1, 2, 3, 4, 5, 6] })).body.schedule;
    expect(s.nextRunAt).toBe(new Date(2026, 10, 23, 2, 0).toISOString());
    connected = false;
    now = new Date(2026, 10, 23, 2, 1).getTime();
    await hub.tick();
    let got = (await call("GET", "/hub/queue")).body.schedules[0];
    expect(got).toMatchObject({ lastSkipped: "the editor was not connected", nextRunAt: new Date(2026, 10, 24, 2, 0).toISOString() });
    connected = true;
    now = new Date(2026, 10, 24, 2, 0, 30).getTime();
    await hub.tick();
    await settle();
    const q = (await call("GET", "/hub/queue")).body as QueueState;
    got = q.schedules[0];
    expect(got.lastSkipped).toBeNull();
    expect(got.lastRunAt).toBe(new Date(now).toISOString());
    const plan = q.current ?? q.queued[0] ?? q.recent[0];
    expect(plan).toMatchObject({ trigger: "schedule", scheduleId: s.id, title: "Nightly" });
    expect((await call("DELETE", `/hub/schedules/${s.id}`)).status).toBe(204);
  });
});

describe("events and access", () => {
  it("changes are gathered into one studio.hub.changed", async () => {
    setup();
    published = [];
    await call("POST", "/hub/goals", { title: "A" });
    await call("POST", "/hub/goals", { title: "B" });
    hub.flush();
    const hubEvents = published.filter((e) => e.type === "hub.changed");
    expect(hubEvents).toHaveLength(1);
    expect(hubEvents[0].data).toEqual({ what: ["goals", "checks", "attention"] });
  });

  it("a paired browser reaches the hub's routes; running playtests asks for the PIN", () => {
    expect(remotePath("GET", "/v1/ext/studio/hub")).toBe("/v1/ext/studio/hub");
    expect(remotePath("GET", `/v1/ext/studio/hub/checks/${enc(`script:${DOOR}`)}`)).not.toBeNull();
    expect(remotePath("POST", "/v1/ext/studio/hub/plans")).toBe("/v1/ext/studio/hub/plans");
    expect(sensitiveRequest("POST", "/v1/ext/studio/hub/plans", false)).toBe(true);
    expect(sensitiveRequest("POST", `/v1/ext/studio/hub/checks/${enc(`script:${DOOR}`)}/run`, false)).toBe(true);
    expect(sensitiveRequest("POST", "/v1/ext/studio/hub/goals/doors/write-playtests", false)).toBe(true);
    expect(sensitiveRequest("POST", "/v1/ext/studio/hub/goals", false)).toBe(false);
    expect(sensitiveRequest("GET", "/v1/ext/studio/hub", false)).toBe(false);
  });

  it("the experiment is off until switched on, and only known experiments are taken", () => {
    const d = path.join(root, "settings");
    fs.mkdirSync(d, { recursive: true });
    const s = new SettingsStore(d, path.join(d, "keys"));
    expect(s.experiments()).toEqual({ playtestHub: false });
    expect(s.view().experiments).toEqual({ playtestHub: false });
    s.update({ experiments: { playtestHub: true } });
    expect(new SettingsStore(d, path.join(d, "keys")).experiments()).toEqual({ playtestHub: true });
    expect(() => s.update({ experiments: { nope: true } as never })).toThrow(/no experiment nope/);
    expect(() => s.update({ experiments: { playtestHub: "yes" } as never })).toThrow(/must be a boolean/);
  });
});

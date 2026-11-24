/**
 * The Studio agent's Playtest Hub tools: reading goals and playtests,
 * creating and updating goals, adding and removing links on goals,
 * playtests and runs, all in the goal store and never in a project file (so
 * none asks as a file change), and that the agent has none while the hub is
 * off.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CheckDetail, GoalState, HubOverview, RunRecord, TrackerLink } from "@ue-mcp-studio/shared";
import { GoalFiles } from "../src/hub/goal-files.js";
import { Goals } from "../src/hub/goals.js";
import { notFound } from "../src/hub/util.js";
import { HUB_TOOLS, HUB_TOOL_NAMES, runHubTool, type HubToolTarget } from "../src/hub-tools.js";
import { approvalKind, NO_EFFECTS } from "../src/approval-kind.js";
import { validateInput } from "../src/tools.js";
import { toolOptions } from "../src/subscription.js";

let root: string;
let goals: Goals;
let runs: Map<string, RunRecord>;
let hub: HubToolTarget;
const DOOR = "/Game/Tests/DoorOpens";
const ISSUE = "https://git.example.com/ember/hollow/issues/42";

const stateOf = (id: string): GoalState => {
  const goal = goals.get(id);
  if (!goal) throw notFound(`no goal ${id}`);
  const parents = goals.list().filter((g) => (g.requires ?? []).some((r) => r.goal === id)).map((g) => g.id);
  return { goal, status: "not_started", progress: { met: 0, total: goal.checks.length }, parents, requires: (goal.requires ?? []).map((r) => ({ goal: r.goal, required: r.required !== false, status: "not_started" as const })), checks: goal.checks.map((c) => ({ id: `${c.kind}:${c.target}`, check: c, name: c.target.split("/").pop()!, goalIds: [id], health: "never_run", last: null, recent: [], passRate: null })) };
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hub-tools-"));
  goals = new Goals({ store: new GoalFiles(path.join(root, "data")), projectDir: root });
  runs = new Map([["run_1", { runId: "run_1", kind: "script", target: DOOR, name: "DoorOpens", outcome: "failed", startedAt: "2026-11-22T00:00:00.000Z", source: "person" }]]);
  const setLinks = (runId: string, f: (l: TrackerLink[]) => TrackerLink[]) => {
    const r = runs.get(runId);
    if (!r) throw notFound(`no run ${runId}`);
    const next = { ...r, links: f(r.links ?? []) };
    runs.set(runId, next);
    return next;
  };
  hub = {
    goals,
    overview: async () => ({ goals: goals.list().map((g) => stateOf(g.id)), warnings: [] }) as unknown as HubOverview,
    goal: async (id: string) => stateOf(id),
    check: async (id: string) => ({ state: { id, check: { kind: "script", target: DOOR }, name: "DoorOpens", goalIds: [], health: "failing", last: null, recent: [], passRate: 0, links: goals.meta(id)?.links }, runs: [...runs.values()], more: false }) as CheckDetail,
    addRunLink: (runId: string, body: unknown) => setLinks(runId, (l) => [...l, (body as { link: TrackerLink }).link]),
    removeRunLink: (runId: string, url: unknown) => setLinks(runId, (l) => l.filter((x) => x.url !== url)),
    updateCheckMeta: (id: string, body: unknown) => goals.updateMeta({ kind: "script", target: id.slice("script:".length) }, body),
  } as unknown as HubToolTarget;
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const run = (name: string, input: Record<string, unknown>) => runHubTool(hub, name, input);

describe("hub tools", () => {
  it("are all defined, and say so when the hub is off", async () => {
    expect(HUB_TOOLS.map((t) => t.name)).toEqual([...HUB_TOOL_NAMES]);
    const r = await runHubTool(null, "hub_list_goals", {});
    expect(r).toMatchObject({ isError: true });
    expect(r.text).toContain("Playtest Hub is off");
  });

  it("create, update, list and read a goal, in the goal store and not the project", async () => {
    const c = await run("hub_create_goal", { title: "Door opens", priority: "p1", due: "2026-12-01", checks: [{ kind: "script", target: DOOR }], links: [{ url: ISSUE, rel: "counterpart" }] });
    expect(c.isError).toBe(false);
    const id = goals.list()[0].id;
    expect(id).toMatch(/^door-opens-[0-9a-z]{4}$/);
    expect(c.text).toContain(`"id": "${id}"`);
    expect(fs.existsSync(path.join(root, "QA"))).toBe(false);
    expect((await run("hub_update_goal", { id, owner: "Ama" })).isError).toBe(false);
    expect(goals.get(id)).toMatchObject({ owner: "Ama", priority: "p1", due: "2026-12-01" });
    expect(await run("hub_update_goal", { id: "nope", owner: "x" })).toMatchObject({ isError: true, text: "no goal nope" });
    const list = JSON.parse((await run("hub_list_goals", {})).text);
    expect(list.goals[0]).toMatchObject({ id, status: "not_started", progress: "0/1", owner: "Ama", priority: "p1", links: [{ url: ISSUE, rel: "counterpart" }] });
    const read = JSON.parse((await run("hub_read_goal", { id })).text);
    expect(read).toMatchObject({ goal: { owner: "Ama" }, checks: [{ id: `script:${DOOR}`, health: "never_run" }] });
    const check = JSON.parse((await run("hub_read_check", { check_id: `script:${DOOR}` })).text);
    expect(check.runs[0]).toMatchObject({ runId: "run_1", outcome: "failed" });
  });

  it("add and remove links on a goal, a playtest and a run", async () => {
    goals.create({ title: "A", id: "a", checks: [{ kind: "script", target: DOOR }] });
    expect((await run("hub_add_link", { goal_id: "a", url: ISSUE, title: "Door", rel: "counterpart" })).isError).toBe(false);
    // The same URL again replaces it.
    await run("hub_add_link", { goal_id: "a", url: ISSUE, title: "Door, renamed" });
    expect(goals.get("a")?.links).toEqual([{ url: ISSUE, title: "Door, renamed" }]);
    expect(await run("hub_add_link", { goal_id: "a", url: "javascript:alert(1)" })).toMatchObject({ isError: true });
    // A playtest's links are its own, whichever goals list it.
    expect((await run("hub_add_link", { check_id: `script:${DOOR}`, url: "jira://HOL-3" })).isError).toBe(false);
    expect(goals.meta(`script:${DOOR}`)?.links).toEqual([{ url: "jira://HOL-3" }]);
    expect((await run("hub_remove_link", { check_id: `script:${DOOR}`, url: "jira://HOL-3" })).isError).toBe(false);
    expect(goals.meta(`script:${DOOR}`)).toBeUndefined();
    expect((await run("hub_remove_link", { goal_id: "a", url: "https://nowhere" })).isError).toBe(true);
    const r = await run("hub_add_link", { run_id: "run_1", url: ISSUE, rel: "filed-from-run" });
    expect(JSON.parse(r.text)).toEqual({ runId: "run_1", links: [{ url: ISSUE, rel: "filed-from-run" }] });
    expect((await run("hub_add_link", { run_id: "run_1", goal_id: "a", url: ISSUE })).isError).toBe(true);
    expect((await run("hub_add_link", { url: ISSUE })).text).toContain("say what to link");
  });

  it("require and unrequire a goal, refusing a loop", async () => {
    goals.create({ title: "Alpha", id: "alpha", kind: "milestone" });
    goals.create({ title: "Beta", id: "beta", kind: "milestone" });
    goals.create({ title: "Door", id: "door" });
    expect((await run("hub_require_goal", { goal_id: "alpha", requires: "door" })).isError).toBe(false);
    expect((await run("hub_require_goal", { goal_id: "beta", requires: "door", required: false })).isError).toBe(false);
    expect(goals.get("beta")?.requires).toEqual([{ goal: "door", required: false }]);
    const read = JSON.parse((await run("hub_read_goal", { id: "door" })).text);
    expect(read.partOf).toEqual(["alpha", "beta"]);
    expect((await run("hub_require_goal", { goal_id: "door", requires: "alpha" })).text).toContain("loop: door > alpha > door");
    expect((await run("hub_unrequire_goal", { goal_id: "alpha", requires: "door" })).isError).toBe(false);
    expect(goals.get("alpha")?.requires).toBeUndefined();
    expect(validateInput("hub_require_goal", { goal_id: "a" })).toContain("needs goal_id and requires");
  });

  it("change no project file, so none asks as a file change", () => {
    for (const name of HUB_TOOL_NAMES) expect(approvalKind(name, { goal_id: "a", url: ISSUE, title: "x", id: "a" }, NO_EFFECTS)).toBeNull();
  });

  it("inputs are checked before they run, and the Claude sign-in allows them only while the hub is on", () => {
    expect(validateInput("hub_add_link", { url: ISSUE, goal_id: "a" })).toBeNull();
    expect(validateInput("hub_add_link", { goal_id: "a" })).toContain("needs url");
    expect(validateInput("hub_add_link", { url: ISSUE, goal_id: "a", check_id: "script:/Game/X" })).toContain("exactly one");
    expect(validateInput("hub_read_goal", {})).toContain("needs id");
    expect(toolOptions({ agent: true, user: true, hub: true, skills: false }).allowedTools).toContain("mcp__studio__hub_add_link");
    expect(toolOptions({ agent: true, user: true, skills: false }).allowedTools.some((n) => n.includes("hub_"))).toBe(false);
  });
});

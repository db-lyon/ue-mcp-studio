/**
 * The Studio agent's Playtest Hub tools: reading goals and checks, creating
 * and updating goals, adding and removing links on goals, checks and runs,
 * the approval they ask under (a goal file change, with its diff; a run's
 * links never ask), and that the agent has none while the hub is off.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CheckDetail, GoalState, HubOverview, RunRecord, TrackerLink } from "@ue-mcp-studio/shared";
import { GoalStore } from "../src/hub/goals.js";
import { notFound } from "../src/hub/util.js";
import { HUB_TOOLS, HUB_TOOL_NAMES, hubChangesFiles, hubPreview, runHubTool, type HubToolTarget } from "../src/hub-tools.js";
import { approvalKind, NO_EFFECTS } from "../src/approval-kind.js";
import { callInsideProject } from "../src/project-scope.js";
import { validateInput } from "../src/tools.js";
import { toolOptions } from "../src/subscription.js";

let root: string;
let goals: GoalStore;
let runs: Map<string, RunRecord>;
let hub: HubToolTarget;
const DOOR = "/Game/Tests/DoorOpens";
const ISSUE = "https://git.example.com/ember/hollow/issues/42";

const stateOf = (id: string): GoalState => {
  const goal = goals.get(id);
  if (!goal) throw notFound(`no goal ${id}`);
  return { goal, status: "not_started", progress: { met: 0, total: goal.checks.length }, parents: goals.parentsOfGoal(id).map((p) => p.id), requires: (goal.requires ?? []).map((r) => ({ goal: r.goal, required: r.required !== false, status: "not_started" as const })), checks: goal.checks.map((c) => ({ id: `${c.kind}:${c.target}`, check: c, name: c.target.split("/").pop()!, goalIds: [id], health: "never_run", last: null, recent: [], passRate: null })) };
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hub-tools-"));
  goals = new GoalStore({ projectDir: root });
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
    overview: async () => ({ goalsDir: goals.relDir, goals: goals.list().map((g) => stateOf(g.id)), warnings: [] }) as unknown as HubOverview,
    goal: async (id: string) => stateOf(id),
    check: async (id: string) => ({ state: { id, check: { kind: "script", target: DOOR }, name: "DoorOpens", goalIds: [], health: "failing", last: null, recent: [], passRate: 0 }, runs: [...runs.values()], more: false }) as CheckDetail,
    addRunLink: (runId: string, body: unknown) => setLinks(runId, (l) => [...l, (body as { link: TrackerLink }).link]),
    removeRunLink: (runId: string, url: unknown) => setLinks(runId, (l) => l.filter((x) => x.url !== url)),
  } as unknown as HubToolTarget;
});
afterEach(() => {
  goals.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

const run = (name: string, input: Record<string, unknown>) => runHubTool(hub, name, input);

describe("hub tools", () => {
  it("are all defined, and say so when the hub is off", async () => {
    expect(HUB_TOOLS.map((t) => t.name)).toEqual([...HUB_TOOL_NAMES]);
    const r = await runHubTool(null, "hub_list_goals", {});
    expect(r).toMatchObject({ isError: true });
    expect(r.text).toContain("Playtest Hub is off");
  });

  it("create, update, list and read a goal", async () => {
    const c = await run("hub_create_goal", { title: "Door opens", priority: "p1", checks: [{ kind: "script", target: DOOR }], links: [{ url: ISSUE, rel: "counterpart" }] });
    expect(c.isError).toBe(false);
    const id = goals.list()[0].id;
    expect(id).toMatch(/^door-opens-[0-9a-z]{4}$/);
    expect(c.text).toContain(`Created QA/Goals/${id}.json`);
    expect(goals.get(id)?.links).toEqual([{ url: ISSUE, rel: "counterpart" }]);
    expect((await run("hub_update_goal", { id, owner: "Ama" })).isError).toBe(false);
    expect(goals.get(id)?.owner).toBe("Ama");
    expect(await run("hub_update_goal", { id: "nope", owner: "x" })).toMatchObject({ isError: true, text: "no goal nope" });
    const list = JSON.parse((await run("hub_list_goals", {})).text);
    expect(list.goals[0]).toMatchObject({ id, status: "not_started", progress: "0/1", links: [{ url: ISSUE, rel: "counterpart" }] });
    const read = JSON.parse((await run("hub_read_goal", { id })).text);
    expect(read).toMatchObject({ file: `QA/Goals/${id}.json`, goal: { owner: "Ama" }, checks: [{ id: `script:${DOOR}`, health: "never_run" }] });
    const check = JSON.parse((await run("hub_read_check", { check_id: `script:${DOOR}` })).text);
    expect(check.runs[0]).toMatchObject({ runId: "run_1", outcome: "failed" });
  });

  it("add and remove links on a goal, a check and a run", async () => {
    await goals.create({ title: "A", id: "a", checks: [{ kind: "script", target: DOOR }] });
    expect((await run("hub_add_link", { goal_id: "a", url: ISSUE, title: "Door", rel: "counterpart" })).isError).toBe(false);
    // The same URL again replaces it.
    await run("hub_add_link", { goal_id: "a", url: ISSUE, title: "Door, renamed" });
    expect(goals.get("a")?.links).toEqual([{ url: ISSUE, title: "Door, renamed" }]);
    expect(await run("hub_add_link", { goal_id: "a", url: "javascript:alert(1)" })).toMatchObject({ isError: true });
    // One goal lists the check: no goal_id needed.
    expect((await run("hub_add_link", { check_id: `script:${DOOR}`, url: "jira://HOL-3" })).isError).toBe(false);
    expect(goals.get("a")?.checks[0].links).toEqual([{ url: "jira://HOL-3" }]);
    await goals.create({ title: "B", id: "b", checks: [{ kind: "script", target: DOOR }] });
    expect((await run("hub_add_link", { check_id: `script:${DOOR}`, url: "https://trello.com/c/x" })).text).toContain("give goal_id");
    expect((await run("hub_add_link", { check_id: `script:${DOOR}`, goal_id: "b", url: "https://trello.com/c/x" })).isError).toBe(false);
    expect((await run("hub_add_link", { check_id: "script:/Game/None", url: "https://trello.com/c/x" })).text).toContain("no goal lists");
    expect((await run("hub_remove_link", { check_id: `script:${DOOR}`, goal_id: "a", url: "jira://HOL-3" })).isError).toBe(false);
    expect(goals.get("a")?.checks[0].links).toBeUndefined();
    expect((await run("hub_remove_link", { goal_id: "a", url: "https://nowhere" })).isError).toBe(true);
    const r = await run("hub_add_link", { run_id: "run_1", url: ISSUE, rel: "filed-from-run" });
    expect(JSON.parse(r.text)).toEqual({ runId: "run_1", links: [{ url: ISSUE, rel: "filed-from-run" }] });
    expect((await run("hub_add_link", { run_id: "run_1", goal_id: "a", url: ISSUE })).isError).toBe(true);
    expect((await run("hub_add_link", { url: ISSUE })).text).toContain("say what to link");
  });

  it("require and unrequire a goal, writing only the requiring goal's file, refusing a loop", async () => {
    await goals.create({ title: "Alpha", id: "alpha", kind: "milestone" });
    await goals.create({ title: "Beta", id: "beta", kind: "milestone" });
    await goals.create({ title: "Door", id: "door" });
    expect(approvalKind("hub_require_goal", { goal_id: "alpha", requires: "door" }, NO_EFFECTS)).toBe("files");
    const p = hubPreview(hub, "hub_require_goal", { goal_id: "alpha", requires: "door" })!;
    expect(p).toMatchObject({ tool: "edit_file", path: path.join(root, "QA", "Goals", "alpha.json") });
    expect(goals.get("alpha")?.requires).toBeUndefined();
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

  it("goal changes ask as file changes, inside the project, with the goal file's diff; a run's links do not ask", async () => {
    await goals.create({ title: "A", id: "a" });
    const add = { goal_id: "a", url: ISSUE };
    expect(approvalKind("hub_add_link", add, NO_EFFECTS)).toBe("files");
    expect(approvalKind("hub_create_goal", { title: "x" }, NO_EFFECTS)).toBe("files");
    expect(approvalKind("hub_add_link", { run_id: "run_1", url: ISSUE }, NO_EFFECTS)).toBeNull();
    expect(approvalKind("hub_read_goal", { id: "a" }, NO_EFFECTS)).toBeNull();
    expect(hubChangesFiles("hub_list_goals", {})).toBe(false);
    expect(callInsideProject(root, "hub_add_link", add)).toBe(true);
    const p = hubPreview(hub, "hub_add_link", add)!;
    expect(p).toMatchObject({ tool: "edit_file", path: path.join(root, "QA", "Goals", "a.json") });
    expect(p.diff!.some((d) => d.op === "+" && d.text.includes(ISSUE))).toBe(true);
    // Nothing was written by the preview.
    expect(goals.get("a")?.links).toBeUndefined();
    // The preview names the file the create will write.
    const create = { title: "New one" };
    const preview = hubPreview(hub, "hub_create_goal", create)!;
    expect(preview).toMatchObject({ tool: "write_file", creates: true });
    expect(path.basename(preview.path!)).toMatch(/^new-one-[0-9a-z]{4}\.json$/);
    expect((await run("hub_create_goal", create)).text).toContain(path.basename(preview.path!));
    expect(hubPreview(hub, "hub_add_link", { goal_id: "nope", url: ISSUE })).toBeNull();
  });

  it("inputs are checked before they run, and the Claude sign-in allows them only while the hub is on", () => {
    expect(validateInput("hub_add_link", { url: ISSUE, goal_id: "a" })).toBeNull();
    expect(validateInput("hub_add_link", { goal_id: "a" })).toContain("needs url");
    expect(validateInput("hub_read_goal", {})).toContain("needs id");
    expect(toolOptions({ agent: true, user: true, hub: true, skills: false }).allowedTools).toContain("mcp__studio__hub_add_link");
    expect(toolOptions({ agent: true, user: true, skills: false }).allowedTools.some((n) => n.includes("hub_"))).toBe(false);
  });
});

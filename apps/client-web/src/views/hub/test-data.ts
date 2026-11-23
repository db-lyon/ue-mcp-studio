/** A small project for the hub's tests: two goals under a milestone, a goal of its own, checks, what needs attention and a queue. */
import { DEFAULT_ACCEPTANCE, type CheckState, type Goal, type GoalState, type HubOverview, type RunRecord } from "@ue-mcp-studio/shared";

const goalOf = (id: string, title: string, over: Partial<Goal> = {}): Goal => ({
  schema: 1, id, kind: "goal", title, acceptance: DEFAULT_ACCEPTANCE, checks: [], ...over,
});

const runOf = (runId: string, name: string, outcome: RunRecord["outcome"], startedAt = "2026-11-22T10:00:00Z"): RunRecord => ({
  runId, kind: "script", target: `/Game/Tests/${name}`, name, outcome, startedAt, source: "person", durationMs: 42_000,
});

export const jumpCheck: CheckState = {
  id: "script:/Game/Tests/Jump", check: { kind: "script", target: "/Game/Tests/Jump" }, name: "Jump", goalIds: ["movement"], health: "failing",
  last: runOf("run-jump-2", "Jump", "failed"), recent: ["failed", "passed", "passed"], passRate: 2 / 3, map: "/Game/Maps/Arena", steps: 4,
  change: { kind: "regressed", runId: "run-jump-2", at: "2026-11-22T10:00:00Z" },
};
export const swimCheck: CheckState = {
  id: "script:/Game/Tests/Swim", check: { kind: "script", target: "/Game/Tests/Swim" }, name: "Swim", goalIds: ["movement"], health: "passing",
  last: runOf("run-swim-1", "Swim", "passed"), recent: ["passed", "passed"], passRate: 1, map: "/Game/Maps/Arena", steps: 3,
};
export const menuCheck: CheckState = {
  id: "script:/Game/Tests/Menu", check: { kind: "script", target: "/Game/Tests/Menu" }, name: "Menu", goalIds: [], health: "never_run",
  last: null, recent: [], passRate: null, steps: 2,
};

const goalState = (goal: Goal, status: GoalState["status"], checks: CheckState[], progress = { met: 0, total: checks.length }, parents: string[] = []): GoalState => ({
  goal, status, checks, progress, parents, requires: (goal.requires ?? []).map((r) => ({ goal: r.goal, required: r.required !== false, status: null })),
});

export function hubFixture(): HubOverview {
  const milestone = goalOf("alpha", "Alpha", { kind: "milestone", due: "2026-12-15", requires: [{ goal: "movement" }, { goal: "tutorial" }] });
  const movement = goalOf("movement", "Movement feels right", { owner: "dana", priority: "p1", checks: [jumpCheck.check, swimCheck.check] });
  const tutorial = goalOf("tutorial", "Tutorial completes");
  return {
    goalsDir: "QA/Goals",
    goals: [
      goalState(milestone, "failing", [], { met: 0, total: 0 }),
      goalState(movement, "failing", [jumpCheck, swimCheck], { met: 1, total: 2 }, ["alpha"]),
      goalState(tutorial, "not_started", [], undefined, ["alpha"]),
    ],
    checks: [jumpCheck, swimCheck, menuCheck],
    attention: [
      { id: "loop_blocked:loop-1", kind: "loop_blocked", at: "2026-11-22T09:00:00Z", title: "Door opens", detail: "The fix loop stopped and needs you.", goalIds: ["movement"], runId: "run-a", checkId: swimCheck.id },
      { id: "missing_check:script:/Game/T/Menu", kind: "missing_check", at: "2026-11-22T09:30:00Z", title: "Menu shows", goalIds: [], checkId: menuCheck.id },
      { id: "regression:run-jump-2", kind: "regression", at: "2026-11-22T10:00:00Z", title: "Jump failed after passing", goalIds: ["movement"], runId: "run-jump-2", checkId: jumpCheck.id },
    ],
    queue: { paused: false, current: null, queued: [], recent: [], schedules: [], editor: { connected: true } },
    recent: [jumpCheck.last!, swimCheck.last!],
    evidence: { store: "local", current: { vcs: "git", revision: "a1b2c3d4e5f60718", dirty: 0 } },
    editor: { connected: true },
    warnings: [],
  };
}

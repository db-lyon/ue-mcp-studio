/** A small project for the hub's tests: two goals under a milestone, a goal of its own, checks, an inbox and a queue. */
import { DEFAULT_ACCEPTANCE, type CheckState, type Goal, type GoalState, type HubOverview, type RunRecord } from "@ue-mcp-studio/shared";

const goalOf = (id: string, title: string, over: Partial<Goal> = {}): Goal => ({
  schema: 1, id, kind: "goal", title, acceptance: DEFAULT_ACCEPTANCE, checks: [], createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", ...over,
});

const runOf = (runId: string, name: string, outcome: RunRecord["outcome"], startedAt = "2026-11-22T10:00:00Z"): RunRecord => ({
  runId, kind: "script", target: `/Game/Tests/${name}`, name, outcome, startedAt, source: "person", durationMs: 42_000,
});

export const jumpCheck: CheckState = {
  id: "script:/Game/Tests/Jump", check: { kind: "script", target: "/Game/Tests/Jump" }, name: "Jump", goalIds: ["movement"], health: "failing",
  last: runOf("run-jump-2", "Jump", "failed"), recent: ["failed", "passed", "passed"], passRate: 2 / 3, map: "/Game/Maps/Arena", steps: 4,
};
export const swimCheck: CheckState = {
  id: "script:/Game/Tests/Swim", check: { kind: "script", target: "/Game/Tests/Swim" }, name: "Swim", goalIds: ["movement"], health: "passing",
  last: runOf("run-swim-1", "Swim", "passed"), recent: ["passed", "passed"], passRate: 1, map: "/Game/Maps/Arena", steps: 3,
};
export const menuCheck: CheckState = {
  id: "script:/Game/Tests/Menu", check: { kind: "script", target: "/Game/Tests/Menu" }, name: "Menu", goalIds: [], health: "never_run",
  last: null, recent: [], passRate: null, steps: 2,
};

const goalState = (goal: Goal, status: GoalState["status"], checks: CheckState[], progress = { met: 0, total: checks.length }): GoalState => ({ goal, status, checks, progress, children: [] });

export function hubFixture(): HubOverview {
  const milestone = goalOf("alpha", "Alpha", { kind: "milestone", due: "2026-12-15" });
  const movement = goalOf("movement", "Movement feels right", { parent: "alpha", owner: "dana", priority: "p1", checks: [jumpCheck.check, swimCheck.check] });
  const tutorial = goalOf("tutorial", "Tutorial completes", { parent: "alpha" });
  return {
    goalsDir: "QA/Goals",
    goals: [
      goalState(milestone, "failing", [], { met: 0, total: 0 }),
      goalState(movement, "failing", [jumpCheck, swimCheck], { met: 1, total: 2 }),
      goalState(tutorial, "not_started", []),
    ],
    checks: [jumpCheck, swimCheck, menuCheck],
    inbox: [
      { id: "verdict:run-a:1", kind: "verdict", at: "2026-11-22T09:00:00Z", title: "Door opens", goalIds: ["movement"], runId: "run-a", step: 1, instruction: "Walk to the door and see it open", checkId: swimCheck.id },
      { id: "verdict:run-b:0", kind: "verdict", at: "2026-11-22T09:30:00Z", title: "Menu shows", goalIds: [], runId: "run-b", step: 0, instruction: "The main menu is on screen" },
      { id: "regression:run-jump-2", kind: "regression", at: "2026-11-22T10:00:00Z", title: "Jump failed after passing", goalIds: ["movement"], runId: "run-jump-2", checkId: jumpCheck.id },
    ],
    queue: { paused: false, current: null, queued: [], recent: [], schedules: [], editor: { connected: true } },
    recent: [jumpCheck.last!, swimCheck.last!],
    editor: { connected: true },
    warnings: [],
  };
}

/**
 * The inbox: everything that waits for a person, worked out from what the
 * hub already knows, never stored. Verdicts waiting and loops blocked come
 * from the QaBroker's runs; regressions and missing checks from the checks'
 * history; sign-offs from the goals; failed plans from the queue. Ids stay
 * the same while the thing waits, so a client can keep its place.
 */
import {
  INBOX_ORDER,
  checkId,
  qaIsDraft,
  qaScriptKey,
  type CheckState,
  type GoalState,
  type InboxItem,
  type PlanRun,
  type QaRun,
} from "@ue-mcp-studio/shared";

/** How long a failed plan stays in the inbox. */
export const PLAN_FAILED_DAYS = 3;

export interface InboxInput {
  runs: QaRun[];
  goals: GoalState[];
  checks: CheckState[];
  plans: PlanRun[];
  now: number;
}

const FINISHED = new Set(["passed", "failed", "incomplete", "stopped", "error"]);

export function buildInbox(i: InboxInput): InboxItem[] {
  const goalsOf = new Map(i.checks.map((c) => [c.id, c.goalIds]));
  const scriptGoals = (script: string) => goalsOf.get(checkId({ kind: "script", target: qaScriptKey(script) })) ?? [];
  const out: InboxItem[] = [];

  for (const run of i.runs) {
    if (qaIsDraft(run) || run.deleted || run.script === "inline") continue;
    const cid = checkId({ kind: "script", target: qaScriptKey(run.script) });
    for (const step of run.steps) {
      if (step.status !== "awaiting_verdict") continue;
      out.push({
        id: `verdict:${run.runId}:${step.index}`,
        kind: "verdict",
        at: run.seenAt,
        title: run.scriptName,
        detail: `Step ${step.index + 1} waits for a verdict`,
        goalIds: scriptGoals(run.script),
        runId: run.runId,
        step: step.index,
        instruction: step.instruction,
        checkId: cid,
      });
    }
  }

  // A loop is carried by every card its attempts took: the newest carrier speaks for it.
  const loops = new Map<string, QaRun>();
  for (const run of i.runs) {
    const loop = run.assignment?.loop;
    if (!loop || loop.state !== "needs_you" || run.deleted) continue;
    const had = loops.get(loop.id);
    if (!had || had.seenAt <= run.seenAt) loops.set(loop.id, run);
  }
  for (const [loopId, run] of loops) {
    const loop = run.assignment!.loop!;
    out.push({
      id: `loop_blocked:${loopId}`,
      kind: "loop_blocked",
      at: loop.endedAt ?? loop.startedAt,
      title: run.scriptName,
      detail: loop.blocker?.reason ?? "The fix loop stopped and needs you.",
      goalIds: scriptGoals(run.script),
      runId: run.runId,
      ...(loop.blocker?.step !== undefined ? { step: loop.blocker.step } : {}),
      checkId: checkId({ kind: "script", target: qaScriptKey(run.script) }),
    });
  }

  for (const g of i.goals) {
    const goal = g.goal;
    if (goal.archived || !goal.acceptance.signOff || goal.signOff || g.status !== "needs_you") continue;
    // Needs you only for the sign-off: no check of it waits for a verdict.
    if (g.checks.some((c) => c.health === "needs_you")) continue;
    out.push({ id: `sign_off:${goal.id}`, kind: "sign_off", at: goal.updatedAt, title: goal.title, detail: "Every check passes: the goal waits for its sign-off", goalIds: [goal.id] });
  }

  for (const c of i.checks) {
    const done = c.recent;
    if (c.last && FINISHED.has(c.last.outcome) && done[0] === "failed" && done.slice(1).find((o) => o === "passed" || o === "failed") === "passed") {
      out.push({
        id: `regression:${c.id}:${c.last.runId}`,
        kind: "regression",
        at: c.last.endedAt ?? c.last.startedAt,
        title: c.name,
        detail: "Failed after passing",
        goalIds: c.goalIds,
        runId: c.last.runId,
        checkId: c.id,
      });
    }
    if (c.missing && c.goalIds.length > 0) {
      const named = i.goals.filter((g) => c.goalIds.includes(g.goal.id)).map((g) => g.goal.updatedAt).sort()[0];
      out.push({
        id: `missing_check:${c.id}`,
        kind: "missing_check",
        at: c.last?.endedAt ?? c.last?.startedAt ?? named ?? new Date(i.now).toISOString(),
        title: c.name,
        detail: `${c.check.target} no longer exists in the project`,
        goalIds: c.goalIds,
        checkId: c.id,
      });
    }
  }

  for (const p of i.plans) {
    if (p.state !== "failed" || !p.endedAt || i.now - Date.parse(p.endedAt) > PLAN_FAILED_DAYS * 86_400_000) continue;
    const bad = p.items.find((x) => x.state === "failed" || x.state === "error");
    out.push({
      id: `plan_failed:${p.id}`,
      kind: "plan_failed",
      at: p.endedAt,
      title: p.title,
      detail: bad ? `${bad.name}: ${bad.reason ?? bad.state}` : "The plan failed",
      goalIds: p.scope.kind === "goal" ? [p.scope.goalId] : "goalId" in p.scope && p.scope.goalId ? [p.scope.goalId] : [],
      planRunId: p.id,
      ...(bad?.runId ? { runId: bad.runId } : {}),
    });
  }

  const rank = (k: InboxItem["kind"]) => INBOX_ORDER.indexOf(k);
  return out.sort((a, b) => rank(a.kind) - rank(b.kind) || (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
}

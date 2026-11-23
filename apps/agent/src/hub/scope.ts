/** Reading a plan's scope and options from a body. */
import { GOAL_ID, type PlanOptions, type PlanScope } from "@ue-mcp-studio/shared";
import { bad, checkRefOf, isObject } from "./util.js";

const SCOPE_HELP = "scope must be { kind: goal, goalId } | { kind: checks, checks } | { kind: failing | stale, goalId? } | { kind: all }";

export function scopeOf(v: unknown): PlanScope {
  if (!isObject(v)) throw bad(SCOPE_HELP);
  const goalId = (required: boolean): string | undefined => {
    if (v.goalId === undefined && !required) return undefined;
    if (typeof v.goalId !== "string" || !GOAL_ID.test(v.goalId)) throw bad("goalId must be a goal's id");
    return v.goalId;
  };
  switch (v.kind) {
    case "goal":
      return { kind: "goal", goalId: goalId(true)! };
    case "failing":
    case "stale": {
      const g = goalId(false);
      return g ? { kind: v.kind, goalId: g } : { kind: v.kind };
    }
    case "all":
      return { kind: "all" };
    case "checks": {
      if (!Array.isArray(v.checks) || v.checks.length === 0) throw bad("checks must list at least one { kind, target }");
      const checks = v.checks.map((c, i) => {
        const ref = checkRefOf(c);
        if (!ref) throw bad(`check ${i + 1} must be { kind, target }, a script's target an asset path`);
        return ref;
      });
      return { kind: "checks", checks };
    }
    default:
      throw bad(SCOPE_HELP);
  }
}

export function planOptionsOf(v: unknown, base: PlanOptions): PlanOptions {
  if (v === undefined) return { ...base };
  if (!isObject(v)) throw bad("options must be { manualSteps?, stopOnFailure?, replay? }");
  const out = { ...base };
  if (v.manualSteps !== undefined) {
    if (v.manualSteps !== "defer" && v.manualSteps !== "block") throw bad("options.manualSteps must be defer or block");
    out.manualSteps = v.manualSteps;
  }
  if (v.stopOnFailure !== undefined) {
    if (typeof v.stopOnFailure !== "boolean") throw bad("options.stopOnFailure must be a boolean");
    out.stopOnFailure = v.stopOnFailure;
  }
  if (v.replay !== undefined) {
    if (typeof v.replay !== "boolean") throw bad("options.replay must be a boolean");
    out.replay = v.replay;
  }
  return out;
}

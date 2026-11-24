import { describe, expect, it } from "vitest";
import type { Goal, GoalState } from "@ue-mcp-studio/shared";
import { goalCheckIds, paletteEntries, runGoalLabel } from "./hub.js";

describe("a milestone's run", () => {
  const goal = (id: string, over: Partial<Goal>): GoalState => ({ goal: { schema: 1, id, kind: "goal", title: id, acceptance: { stableRuns: 1 }, checks: [], ...over } } as unknown as GoalState);
  const goals = [
    goal("alpha", { kind: "milestone", requires: [{ goal: "move" }, { goal: "swim" }], checks: [{ kind: "script", target: "/Game/T/Own" }] }),
    goal("move", { checks: [{ kind: "script", target: "/Game/T/Jump" }, { kind: "script", target: "/Game/T/Run" }] }),
    goal("swim", { checks: [{ kind: "script", target: "/Game/T/Jump" }, { kind: "script", target: "/Game/T/Swim" }] }),
  ];

  it("covers every playtest under its required goals once, then its own", () => {
    expect(goalCheckIds("alpha", goals)).toEqual(["script:/Game/T/Jump", "script:/Game/T/Run", "script:/Game/T/Swim", "script:/Game/T/Own"]);
  });

  it("is labelled Run all with that count on a milestone, Run goal on a goal, in the palette too", () => {
    expect(runGoalLabel(goals[0].goal, 4)).toBe("Run all (4)");
    expect(runGoalLabel(goals[1].goal, 2)).toBe("Run goal");
    const entries = paletteEntries({ goals: goals.map((g) => ({ ...g, status: "not_started" })) as GoalState[], checks: [], recent: [] });
    expect(entries.find((e) => e.id === "run-goal:alpha")?.hint).toBe("Run all (4)");
    expect(entries.find((e) => e.id === "run-goal:move")?.hint).toBe("Run goal");
  });
});

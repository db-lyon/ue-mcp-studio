import { describe, expect, it } from "vitest";
import type { HubOverview } from "@ue-mcp-studio/shared";
import { HUB_TRAIL_MAX, freshTrail, hubRouteLabel, trailCrumbs, trailHasBack, trailOf, trailPush } from "./hub-trail.js";
import type { HubRoute } from "./hub.js";

const milestone: HubRoute = { screen: "goal", goalId: "alpha" };
const run: HubRoute = { screen: "run", runId: "run-1" };
const check: HubRoute = { screen: "check", checkId: "script:/Game/Tests/Jump" };
const o = {
  goals: [{ goal: { id: "alpha", title: "Alpha", kind: "milestone" } }],
  checks: [{ id: "script:/Game/Tests/Jump", name: "Jump" }],
  recent: [{ runId: "run-1", name: "Jump" }],
} as unknown as Pick<HubOverview, "goals" | "checks" | "recent">;

describe("the hub trail", () => {
  it("keeps the way taken: milestone, run, playtest, and back goes to the run, then the milestone", () => {
    const t = trailPush(trailPush(freshTrail(milestone), run), check);
    expect(t.routes).toEqual([milestone, run, check]);
    const { crumbs } = trailCrumbs(t, o);
    expect(crumbs.map((c) => [c.label, c.steps])).toEqual([["Alpha", 2], ["Run of Jump", 1], ["Jump", 0]]);
    expect(trailHasBack(t)).toBe(true);
  });

  it("does not grow when the screen on show is opened again", () => {
    const t = trailPush(freshTrail(milestone), milestone);
    expect(t.routes).toEqual([milestone]);
  });

  it("starts at the tab a link came from, which is a crumb of its own", () => {
    const t = freshTrail(check, "Chat");
    expect(trailHasBack(t)).toBe(true);
    expect(trailCrumbs(t, o).crumbs).toEqual([{ label: "Chat", steps: 1, route: null }, { label: "Jump", steps: 0, route: check }]);
  });

  it("is fresh for a deep link opened with no history, so the screen falls back to its parent", () => {
    expect(trailOf(null, check)).toEqual({ routes: [check] });
    expect(trailHasBack(trailOf(null, check))).toBe(false);
    // A kept trail that ends elsewhere (the hash was edited) is not this screen's.
    expect(trailOf({ hubTrail: { routes: [milestone, run] } }, check)).toEqual({ routes: [check] });
    expect(trailOf({ hubTrail: { routes: "junk" } }, check)).toEqual({ routes: [check] });
  });

  it("reads back the trail a history entry kept", () => {
    const kept = { hubTrail: { routes: [milestone, run, check], from: "Chat" } };
    expect(trailOf(kept, check)).toEqual({ routes: [milestone, run, check], from: "Chat" });
  });

  it("drops its oldest screens past the cap, and the tab it came from with them", () => {
    let t = freshTrail(milestone, "Chat");
    for (let i = 0; i < HUB_TRAIL_MAX + 5; i++) t = trailPush(t, { screen: "run", runId: `r${i}` });
    expect(t.routes).toHaveLength(HUB_TRAIL_MAX);
    expect(t.from).toBeUndefined();
  });

  it("folds the oldest crumbs past the most shown", () => {
    let t = freshTrail(milestone);
    for (let i = 0; i < 6; i++) t = trailPush(t, { screen: "run", runId: `r${i}` });
    const { crumbs, folded } = trailCrumbs(t, o, 4);
    expect(folded).toBe(3);
    expect(crumbs.map((c) => c.steps)).toEqual([3, 2, 1, 0]);
  });

  it("names screens it has no record for plainly", () => {
    expect(hubRouteLabel({ screen: "run", runId: "unknown" }, o)).toBe("Run");
    expect(hubRouteLabel({ screen: "library" }, null)).toBe("Clips");
    expect(hubRouteLabel({ screen: "draft" }, null)).toBe("New script clip");
  });
});

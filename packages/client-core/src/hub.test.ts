import { describe, expect, it } from "vitest";
import { DEFAULT_ACCEPTANCE, type CheckState, type Goal, type GoalState, type InboxItem, type QueueState, type PlanRun } from "@ue-mcp-studio/shared";
import {
  CHECK_HEALTH_LOOK,
  GOAL_STATUS_LOOK,
  dueText,
  filterChecks,
  flips,
  goalDraftOf,
  goalFormErrors,
  goalFormOf,
  goalSummary,
  hubApi,
  hubHash,
  hubKeymap,
  hubPath,
  milestoneGroups,
  moveQueued,
  paletteEntries,
  parseHubPath,
  parseTags,
  planProgress,
  proposeGoals,
  regressions,
  runTimeline,
  scheduleErrors,
  scheduleText,
  searchPalette,
  sortChecks,
  sortGoals,
  sortInbox,
  sparkBars,
  typingTarget,
  type HubRoute,
} from "./hub.js";

const goal = (id: string, over: Partial<Goal> = {}): Goal => ({
  schema: 1, id, kind: "goal", title: id, acceptance: DEFAULT_ACCEPTANCE, checks: [], createdAt: "", updatedAt: "", ...over,
});
const gs = (id: string, status: GoalState["status"], over: Partial<Goal> = {}): GoalState => ({ goal: goal(id, over), status, checks: [], progress: { met: 0, total: 0 }, children: [] });
const check = (name: string, health: CheckState["health"], over: Partial<CheckState> = {}): CheckState => ({
  id: `script:/Game/T/${name}`, check: { kind: "script", target: `/Game/T/${name}` }, name, goalIds: [], health, last: null, recent: [], passRate: null, ...over,
});

describe("hub routes", () => {
  it("round-trips every screen through the hash, encoding ids", () => {
    const routes: HubRoute[] = [
      { screen: "overview" }, { screen: "inbox" }, { screen: "library" }, { screen: "queue" },
      { screen: "goal", goalId: "tutorial" },
      { screen: "check", checkId: "script:/Game/Tests/Jump Test" },
      { screen: "run", runId: "run/42:a" },
    ];
    for (const r of routes) expect(parseHubPath(hubPath(r))).toEqual(r);
    expect(hubHash({ screen: "check", checkId: "script:/Game/X" })).toBe("#/playtests/checks/script%3A%2FGame%2FX");
    expect(hubHash({ screen: "overview" })).toBe("#/playtests");
  });

  it("falls back to the overview for what it does not know", () => {
    expect(parseHubPath("nowhere")).toEqual({ screen: "overview" });
    expect(parseHubPath("goals")).toEqual({ screen: "overview" });
    expect(parseHubPath("checks/%E0%A4%A")).toEqual({ screen: "library" });
    expect(parseHubPath(null)).toEqual({ screen: "overview" });
  });
});

describe("the status ladder", () => {
  it("gives every status its own shape and a label, so none is told apart by colour alone", () => {
    const checkGlyphs = Object.values(CHECK_HEALTH_LOOK).map((l) => l.glyph);
    expect(new Set(checkGlyphs).size).toBe(checkGlyphs.length);
    const goalGlyphs = Object.values(GOAL_STATUS_LOOK).map((l) => l.glyph);
    expect(new Set(goalGlyphs).size).toBe(goalGlyphs.length);
    for (const l of [...Object.values(CHECK_HEALTH_LOOK), ...Object.values(GOAL_STATUS_LOOK)]) expect(l.label).toMatch(/^[A-Z]/);
  });

  it("sorts goals worst first, then by priority, due date and title", () => {
    const sorted = sortGoals([gs("b", "met"), gs("a", "failing", { priority: "p2" }), gs("c", "needs_you"), gs("d", "failing", { priority: "p0" }), gs("e", "at_risk")]);
    expect(sorted.map((g) => g.goal.id)).toEqual(["c", "d", "a", "e", "b"]);
  });

  it("sorts checks worst first, then the most recently run", () => {
    const older = { runId: "1", kind: "script" as const, target: "", name: "", outcome: "failed" as const, startedAt: "2026-01-01T00:00:00Z", source: "person" as const };
    const newer = { ...older, runId: "2", startedAt: "2026-02-01T00:00:00Z" };
    const sorted = sortChecks([check("p", "passing"), check("f1", "failing", { last: older }), check("f2", "failing", { last: newer }), check("n", "needs_you")]);
    expect(sorted.map((c) => c.name)).toEqual(["n", "f2", "f1", "p"]);
  });

  it("puts verdicts first in the inbox, oldest first within a kind", () => {
    const item = (id: string, kind: InboxItem["kind"], at: string): InboxItem => ({ id, kind, at, title: id, goalIds: [] });
    expect(sortInbox([item("r", "regression", "1"), item("v2", "verdict", "3"), item("v1", "verdict", "2")]).map((i) => i.id)).toEqual(["v1", "v2", "r"]);
  });
});

describe("overview models", () => {
  it("groups goals under milestones by due date, loose goals last, archived left out", () => {
    const groups = milestoneGroups([
      gs("m2", "met", { kind: "milestone", due: "2026-12-01" }),
      gs("m1", "failing", { kind: "milestone", due: "2026-11-01" }),
      gs("g1", "met", { parent: "m1" }),
      gs("g2", "failing", { parent: "m1" }),
      gs("g3", "met", { parent: "gone" }),
      gs("g4", "met", { archived: true }),
    ]);
    expect(groups.map((g) => g.milestone?.goal.id ?? null)).toEqual(["m1", "m2", null]);
    expect(groups[0].goals.map((g) => g.goal.id)).toEqual(["g2", "g1"]);
    expect(groups[2].goals.map((g) => g.goal.id)).toEqual(["g3"]);
  });

  it("says how many goals are in each status, milestones aside", () => {
    expect(goalSummary([gs("a", "failing"), gs("b", "met"), gs("c", "met"), gs("m", "met", { kind: "milestone" })])).toBe("3 goals: 1 failing, 2 met");
    expect(goalSummary([])).toBe("No goals");
  });

  it("finds checks that just broke and counts flips", () => {
    expect(regressions([check("a", "failing", { recent: ["failed", "passed"] }), check("b", "failing", { recent: ["failed", "failed"] })]).map((c) => c.name)).toEqual(["a"]);
    expect(flips(["passed", "failed", "passed", "passed", "stopped", "failed"])).toBe(3);
  });

  it("draws the win/loss line oldest first, with shape for each outcome", () => {
    expect(sparkBars(["failed", "passed", "stopped"]).map((b) => b.dir)).toEqual(["mid", "up", "down"]);
  });

  it("proposes one goal per map for scripts in no goal", () => {
    const p = proposeGoals([
      check("a", "passing", { map: "/Game/Maps/Arena" }),
      check("b", "failing", { map: "/Game/Maps/Arena" }),
      check("c", "never_run"),
      check("d", "passing", { goalIds: ["x"], map: "/Game/Maps/Hub" }),
    ]);
    expect(p.map((x) => [x.title, x.checks.length])).toEqual([["Arena plays through", 2], ["Other playtests", 1]]);
  });
});

describe("library filters", () => {
  const all = [check("Jump", "failing", { goalIds: ["move"], map: "/Game/Maps/Arena" }), check("Swim", "flaky"), check("Menu", "never_run")];
  it("filters by health, goal and words, matching goal titles too", () => {
    expect(filterChecks(all, { health: "at_risk" }).map((c) => c.name)).toEqual(["Swim"]);
    expect(filterChecks(all, { goalId: "none" }).map((c) => c.name)).toEqual(["Swim", "Menu"]);
    expect(filterChecks(all, { text: "arena" }).map((c) => c.name)).toEqual(["Jump"]);
    expect(filterChecks(all, { text: "movement" }, [gs("move", "failing", { title: "Movement feels right" })]).map((c) => c.name)).toEqual(["Jump"]);
  });
});

describe("timeline", () => {
  it("lays steps out on the run's clock, untimed ones after the last timed one", () => {
    const { bars, totalMs } = runTimeline([
      { index: 0, instruction: "", status: "passed", judge: "auto", startMs: 0, endMs: 1000 },
      { index: 1, instruction: "", status: "failed", judge: "auto", startMs: 1000, endMs: 4000 },
      { index: 2, instruction: "", status: "pending", judge: "manual", startMs: null, endMs: null },
    ]);
    expect(totalMs).toBe(4000);
    expect(bars[0]).toMatchObject({ left: 0, width: 25 });
    expect(bars[1]).toMatchObject({ left: 25, width: 75 });
    expect(bars[2].left).toBe(99);
  });
});

describe("the goal form", () => {
  it("needs a title and checks every number and date", () => {
    const f = { ...goalFormOf(), title: " ", stableRuns: "0", staleAfterDays: "abc", due: "2026-02-30", tags: "ok, bad tag!" };
    const e = goalFormErrors(f);
    expect(Object.keys(e).sort()).toEqual(["due", "stableRuns", "staleAfterDays", "tags", "title"]);
  });

  it("refuses a milestone inside a milestone and a parent that is not one", () => {
    const goals = [gs("m", "met", { kind: "milestone" }), gs("g", "met")];
    expect(goalFormErrors({ ...goalFormOf(), title: "x", kind: "milestone", parent: "m" }, { goals }).parent).toBeTruthy();
    expect(goalFormErrors({ ...goalFormOf(), title: "x", parent: "g" }, { goals }).parent).toBe("Pick a milestone.");
    expect(goalFormErrors({ ...goalFormOf(), title: "x", parent: "m" }, { goals })).toEqual({});
  });

  it("makes a draft from what was typed", () => {
    const d = goalDraftOf({ ...goalFormOf(), title: "  Four players join ", tags: "#net, multiplayer net", stableRuns: "3", staleAfterDays: "", signOff: true, priority: "p1" });
    expect(d).toMatchObject({ title: "Four players join", tags: ["net", "multiplayer"], priority: "p1", acceptance: { stableRuns: 3, staleAfterDays: null, signOff: true } });
    expect(parseTags("a, a b")).toEqual(["a", "b"]);
  });

  it("says when a goal is due against today", () => {
    const now = Date.UTC(2026, 10, 23, 12);
    expect(dueText("2026-11-23", now)?.text).toBe("Due today");
    expect(dueText("2026-11-20", now)).toEqual({ text: "3 days overdue", overdue: true });
    expect(dueText("2026-11-26", now)?.text).toBe("Due in 3 days");
    expect(dueText(null, now)).toBeNull();
  });
});

describe("schedules and the queue", () => {
  it("says when a schedule runs and what is wrong with one", () => {
    expect(scheduleText({ days: [0, 1, 2, 3, 4, 5, 6], at: "02:00" })).toBe("Every day at 02:00");
    expect(scheduleText({ days: [5, 1, 2, 3, 4], at: "18:30" })).toBe("Weekdays at 18:30");
    expect(scheduleText({ days: [4, 1], at: "09:00" })).toBe("Mon, Thu at 09:00");
    expect(Object.keys(scheduleErrors({ title: "", at: "25:00", days: [], scope: { kind: "all" } })).sort()).toEqual(["at", "days", "title"]);
  });

  it("moves a queued plan and counts a plan's progress", () => {
    const plan = (id: string): PlanRun => ({ id, title: id, scope: { kind: "all" }, options: { manualSteps: "defer", stopOnFailure: false, replay: false }, state: "queued", items: [], trigger: "person", createdAt: "" });
    const q: QueueState = { paused: false, current: null, queued: [plan("a"), plan("b"), plan("c")], recent: [], schedules: [], editor: { connected: true } };
    expect(moveQueued(q, "c", 0).queued.map((p) => p.id)).toEqual(["c", "a", "b"]);
    const p = planProgress({ items: [
      { check: { kind: "script", target: "a" }, name: "a", state: "passed" },
      { check: { kind: "script", target: "b" }, name: "b", state: "running" },
      { check: { kind: "script", target: "c" }, name: "c", state: "failed" },
    ] });
    expect(p).toMatchObject({ done: 2, total: 3, failed: 1, current: { name: "b" } });
  });
});

describe("keys", () => {
  it("jumps with g then a letter, within the chord time", () => {
    let t = 0;
    const k = hubKeymap(() => t);
    expect(k.press({ key: "g" })).toBeNull();
    expect(k.pending()).toBe(true);
    expect(k.press({ key: "i" })).toEqual({ type: "go", to: "inbox" });
    k.press({ key: "g" });
    t = 5000;
    expect(k.press({ key: "i" })).toBeNull();
    expect(k.press({ key: "j" })).toEqual({ type: "next" });
    expect(k.press({ key: "k", ctrl: true })).toEqual({ type: "palette" });
    expect(k.press({ key: "r", ctrl: true })).toBeNull();
  });

  it("leaves keys alone in text fields", () => {
    expect(typingTarget({ tagName: "INPUT", type: "text" })).toBe(true);
    expect(typingTarget({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(typingTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(typingTarget({ tagName: "DIV" })).toBe(false);
  });
});

describe("the command palette", () => {
  const o = { goals: [gs("tutorial", "failing", { title: "Tutorial completes" })], checks: [check("JumpHeight", "passing")], recent: [] };
  it("finds goals and checks by a few letters, best match first", () => {
    const found = searchPalette(paletteEntries(o), "tut");
    expect(found[0]).toMatchObject({ kind: "goal", route: { screen: "goal", goalId: "tutorial" } });
    expect(searchPalette(paletteEntries(o), "jmph").some((e) => e.id === "check:script:/Game/T/JumpHeight")).toBe(true);
    expect(searchPalette(paletteEntries(o), "zzzz")).toEqual([]);
  });
  it("offers commands and screens before anything is typed", () => {
    expect(searchPalette(paletteEntries(o), "")[0].id).toBe("cmd:new-goal");
  });
});

describe("the hub API", () => {
  it("calls the routes HUB_ROUTES names, with ids encoded", async () => {
    const calls: Array<[string, string, unknown]> = [];
    const api = hubApi(async <T,>(m: string, p: string, b?: unknown) => {
      calls.push([m, p, b]);
      return {} as T;
    });
    await api.overview();
    await api.removeCheck("tut", "script:/Game/A");
    await api.check("script:/Game/A", { limit: 30 });
    await api.runs({ check: "script:/Game/A", before: "r1" });
    await api.movePlan("p1", 2);
    await api.verdict("r 1", 3, "fail", "fell through");
    expect(calls).toEqual([
      ["GET", "/v1/ext/studio/hub", undefined],
      ["DELETE", "/v1/ext/studio/hub/goals/tut/checks/script%3A%2FGame%2FA", undefined],
      ["GET", "/v1/ext/studio/hub/checks/script%3A%2FGame%2FA?limit=30", undefined],
      ["GET", "/v1/ext/studio/hub/runs?check=script%3A%2FGame%2FA&before=r1", undefined],
      ["POST", "/v1/ext/studio/hub/plans/p1/move", { to: 2 }],
      ["POST", "/v1/ext/studio/qa/runs/r%201/verdict", { step: 3, verdict: "fail", note: "fell through" }],
    ]);
  });
});

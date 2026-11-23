/** The Playtest Hub's shared rules: check health, acceptance, goal status, goal ids and run outcomes. */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ACCEPTANCE,
  RESULT_OUTCOMES,
  checkHealth,
  checkId,
  checkSatisfied,
  checkStateOf,
  goalChecksDeep,
  goalLoops,
  goalParents,
  goalSlug,
  goalStatus,
  goalTree,
  loopIfRequired,
  rollUpGoals,
  needsSignOff,
  outcomeOf,
  parseCheckId,
  GOAL_ID,
  linkHost,
  trackerLinkOf,
  trackerUrlProblem,
  uniqueLinks,
  type AcceptanceRule,
  type CheckRef,
  type Goal,
  type QaStep,
  type RunOutcome,
  type RunRecord,
} from "../src/index.js";

describe("tracker links", () => {
  it("takes web, mail and app links, and refuses schemes that run code or read local data", () => {
    for (const ok of ["https://git.example.com/ember/hollow/issues/42", "http://localhost:3000/x", "mailto:qa@example.com", "jira://HOL-1", "trello:card/abc"]) expect(trackerUrlProblem(ok), ok).toBeNull();
    for (const bad of ["javascript:alert(1)", "JavaScript:x", "data:text/html,x", "vbscript:x", "file:///C:/x", "https://", "no-scheme.example.com", "https://a b", "", "jira:"]) expect(trackerUrlProblem(bad), bad).not.toBeNull();
  });

  it("normalizes a link and keeps one per URL", () => {
    expect(trackerLinkOf({ url: " https://x.y/1 ", title: "  T ", rel: "" })).toEqual({ link: { url: "https://x.y/1", title: "T" } });
    expect(trackerLinkOf({ url: "https://x.y", title: 3 })).toHaveProperty("problem");
    expect(uniqueLinks([{ url: "a:1" }, { url: "a:1", title: "b" }, { url: "a:2" }])).toEqual([{ url: "a:1" }, { url: "a:2" }]);
  });

  it("names a link by its host, its address, or its app", () => {
    expect(linkHost("https://www.Example.com:8080/a?b")).toBe("example.com");
    expect(linkHost("https://user@git.example.com/x")).toBe("git.example.com");
    expect(linkHost("mailto:qa%40x@example.com?subject=1")).toBe("qa@x@example.com");
    expect(linkHost("jira://HOL-1")).toBe("jira");
    expect(linkHost("nonsense")).toBe("");
  });
});

const NOW = Date.parse("2026-11-23T12:00:00Z");
const DAY = 86_400_000;
const script: CheckRef = { kind: "script", target: "/Game/Tests/Door" };

let n = 0;
/** Runs newest first, each a day older than the one before. */
const runs = (...outcomes: RunOutcome[]): RunRecord[] => outcomes.map((outcome, i) => {
  const at = new Date(NOW - (i + 1) * 3600_000).toISOString();
  return { runId: `r${n++}`, kind: "script", target: script.target, name: "Door", outcome, startedAt: at, endedAt: at, source: "person" };
});

const goal = (over: Partial<Goal> = {}): Goal => ({
  schema: 1, id: "g", kind: "goal", title: "G", acceptance: { ...DEFAULT_ACCEPTANCE }, checks: [script], createdAt: "", updatedAt: "", ...over,
});
const state = (rs: RunRecord[], ref: CheckRef = script, acceptance: AcceptanceRule = DEFAULT_ACCEPTANCE, missing = false) =>
  ({ state: checkStateOf({ check: ref, runs: rs, acceptance, now: NOW, goalIds: ["g"], missing }), runs: rs });

describe("checkHealth", () => {
  it("missing first, whatever the runs say", () => {
    expect(checkHealth({ check: script, runs: runs("passed"), missing: true, now: NOW })).toBe("missing");
  });

  it("a live run that waits for a verdict, or runs, says so", () => {
    expect(checkHealth({ check: script, runs: runs("needs_you", "passed"), now: NOW })).toBe("needs_you");
    expect(checkHealth({ check: script, runs: runs("running", "failed"), now: NOW })).toBe("running");
  });

  it("never run with no finished run", () => {
    expect(checkHealth({ check: script, runs: [], now: NOW })).toBe("never_run");
    expect(checkHealth({ check: { kind: "manual", target: "Looks right" }, runs: [], now: NOW })).toBe("never_run");
  });

  it("failing when the newest result did not pass, incomplete included", () => {
    expect(checkHealth({ check: script, runs: runs("failed", "passed"), now: NOW })).toBe("failing");
    expect(checkHealth({ check: script, runs: runs("incomplete"), now: NOW })).toBe("failing");
  });

  it("a stopped or unjudged run is no result: the run before it speaks for the check", () => {
    expect(checkHealth({ check: script, runs: runs("stopped", "passed"), now: NOW })).toBe("passing");
    expect(checkHealth({ check: script, runs: runs("unjudged", "passed"), now: NOW })).toBe("passing");
    expect(checkSatisfied(runs("unjudged", "passed"), DEFAULT_ACCEPTANCE)).toBe(true);
    expect(checkHealth({ check: script, runs: runs("stopped", "failed"), now: NOW })).toBe("failing");
    expect(checkHealth({ check: script, runs: runs("stopped"), now: NOW })).toBe("never_run");
  });

  it("flaky when a failure sits in the window behind a pass", () => {
    expect(checkHealth({ check: script, runs: runs("passed", "failed", "passed"), now: NOW })).toBe("flaky");
    // The window is max(3, stableRuns + 2): a failure four runs back is outside it by default.
    expect(checkHealth({ check: script, runs: runs("passed", "passed", "passed", "failed"), now: NOW })).toBe("passing");
    expect(checkHealth({ check: script, runs: runs("passed", "passed", "passed", "failed"), acceptance: { ...DEFAULT_ACCEPTANCE, stableRuns: 2 }, now: NOW })).toBe("flaky");
  });

  it("stale when the newest pass is older than staleAfterDays, never with null", () => {
    const old: RunRecord = { ...runs("passed")[0], startedAt: new Date(NOW - 20 * DAY).toISOString(), endedAt: new Date(NOW - 20 * DAY).toISOString() };
    expect(checkHealth({ check: script, runs: [old], now: NOW })).toBe("stale");
    expect(checkHealth({ check: script, runs: [old], acceptance: { ...DEFAULT_ACCEPTANCE, staleAfterDays: null }, now: NOW })).toBe("passing");
  });
});

describe("checkSatisfied", () => {
  it("the latest stableRuns finished runs all passed, and there are that many", () => {
    const two = { ...DEFAULT_ACCEPTANCE, stableRuns: 2 };
    expect(checkSatisfied(runs("passed"), DEFAULT_ACCEPTANCE)).toBe(true);
    expect(checkSatisfied(runs("passed"), two)).toBe(false);
    expect(checkSatisfied(runs("passed", "passed"), two)).toBe(true);
    expect(checkSatisfied(runs("passed", "failed"), two)).toBe(false);
  });

  it("live runs do not count either way", () => {
    expect(checkSatisfied(runs("running", "passed"), DEFAULT_ACCEPTANCE)).toBe(true);
    expect(checkSatisfied(runs("needs_you"), DEFAULT_ACCEPTANCE)).toBe(false);
  });
});

describe("checkStateOf", () => {
  it("recent and passRate from finished runs only", () => {
    const s = checkStateOf({ check: script, runs: runs("running", "passed", "failed"), now: NOW, goalIds: [] });
    expect(s.id).toBe("script:/Game/Tests/Door");
    expect(s.name).toBe("Door");
    expect(s.recent).toEqual(["passed", "failed"]);
    expect(s.passRate).toBe(0.5);
    expect(s.last?.outcome).toBe("running");
    expect(checkStateOf({ check: script, runs: [], goalIds: [] }).passRate).toBeNull();
  });
});

describe("goalStatus", () => {
  it("not started with no checks, or none run", () => {
    expect(goalStatus(goal({ checks: [] }), []).status).toBe("not_started");
    expect(goalStatus(goal(), [state([])]).status).toBe("not_started");
  });

  it("met when every required check passed, with progress", () => {
    const r = goalStatus(goal(), [state(runs("passed"))]);
    expect(r).toEqual({ status: "met", progress: { met: 1, total: 1 } });
  });

  it("failing when a required check fails or is missing; an optional one does not count", () => {
    expect(goalStatus(goal(), [state(runs("failed"))]).status).toBe("failing");
    expect(goalStatus(goal(), [state(runs("passed"), script, DEFAULT_ACCEPTANCE, true)]).status).toBe("failing");
    const optional: CheckRef = { kind: "script", target: "/Game/Tests/Extra", required: false };
    const g = goal({ checks: [script, optional] });
    expect(goalStatus(g, [state(runs("passed")), state(runs("failed"), optional)]).status).toBe("met");
  });

  it("needs you above failing", () => {
    const other: CheckRef = { kind: "script", target: "/Game/Tests/Other" };
    expect(goalStatus(goal({ checks: [script, other] }), [state(runs("needs_you")), state(runs("failed"), other)]).status).toBe("needs_you");
  });

  it("at risk when met but flaky or stale, or when only some evidence is in", () => {
    expect(goalStatus(goal(), [state(runs("passed", "failed", "passed"))]).status).toBe("at_risk");
    const other: CheckRef = { kind: "script", target: "/Game/Tests/Other" };
    expect(goalStatus(goal({ checks: [script, other] }), [state(runs("passed")), state([], other)]).status).toBe("at_risk");
  });

  it("sign-off: needs you once everything passes, met once given", () => {
    const g = goal({ acceptance: { ...DEFAULT_ACCEPTANCE, signOff: true } });
    expect(goalStatus(g, [state(runs("passed"))]).status).toBe("needs_you");
    expect(goalStatus({ ...g, signOff: { by: "you", at: "2026-11-23" } }, [state(runs("passed"))]).status).toBe("met");
  });

  it("a manual check is satisfied by the goal's sign-off", () => {
    const manual: CheckRef = { kind: "manual", target: "The door looks right" };
    const g = goal({ checks: [script, manual] });
    expect(goalStatus(g, [state(runs("passed")), state([], manual)]).progress).toEqual({ met: 1, total: 2 });
    expect(goalStatus({ ...g, signOff: { by: "you", at: "x" } }, [state(runs("passed")), state([], manual)])).toEqual({ status: "met", progress: { met: 2, total: 2 } });
  });

  it("waits on a person when only a required manual check's sign-off is missing, without the sign-off rule", () => {
    const manual: CheckRef = { kind: "manual", target: "The door looks right" };
    expect(needsSignOff(goal({ checks: [script, manual] }))).toBe(true);
    expect(goalStatus(goal({ checks: [script, manual] }), [state(runs("passed")), state([], manual)]).status).toBe("needs_you");
    expect(goalStatus(goal({ checks: [manual] }), [state([], manual)]).status).toBe("needs_you");
    // Automated evidence still missing: not yet a sign-off.
    expect(goalStatus(goal({ checks: [script, manual] }), [state([]), state([], manual)]).status).toBe("not_started");
  });

  it("a milestone follows its goals", () => {
    const m = goal({ id: "m", kind: "milestone", checks: [] });
    expect(goalStatus(m, [], ["met", "met"]).status).toBe("met");
    expect(goalStatus(m, [], ["met", "failing"]).status).toBe("failing");
    expect(goalStatus(m, [], ["met", "at_risk"]).status).toBe("at_risk");
    expect(goalStatus(m, [], ["not_started"]).status).toBe("not_started");
  });

  it("an optional goal never blocks, but a verdict or run in it shows", () => {
    const m = goal({ id: "m", kind: "milestone", checks: [] });
    expect(goalStatus(m, [], ["met"], ["failing"]).status).toBe("met");
    expect(goalStatus(m, [], ["met"], ["needs_you"]).status).toBe("needs_you");
    expect(goalStatus(m, [], ["met"], ["running"]).status).toBe("running");
  });
});

describe("the relationship graph", () => {
  const g = (id: string, requires: Array<string | { goal: string; required?: boolean }> = [], over: Partial<Goal> = {}): Goal =>
    goal({ id, checks: [], requires: requires.map((r) => (typeof r === "string" ? { goal: r } : r)), ...over });
  const door: CheckRef = { kind: "script", target: "/Game/Tests/Door" };
  const jump: CheckRef = { kind: "script", target: "/Game/Tests/Jump" };
  const swim: CheckRef = { kind: "script", target: "/Game/Tests/Swim" };

  it("rolls status up through a goal shared by two milestones, working each goal out once", () => {
    const shared = g("shared", [], { checks: [door] });
    const goals = [g("a", ["shared", "ok"], { kind: "milestone" }), g("b", ["shared"], { kind: "milestone" }), shared, g("ok", [], { checks: [jump] }), g("loose", [], { checks: [jump] })];
    let asked = 0;
    const out = rollUpGoals(goals, (x) => {
      asked++;
      return x.checks.map((c) => state(c === door ? runs("failed") : runs("passed"), c));
    });
    expect(asked).toBe(goals.length);
    const by = (id: string) => out.find((s) => s.goal.id === id)!;
    expect(by("shared").status).toBe("failing");
    expect(by("a").status).toBe("failing");
    expect(by("b").status).toBe("failing");
    expect(by("ok").status).toBe("met");
    expect(by("shared").parents).toEqual(["a", "b"]);
    expect(by("a").requires).toEqual([{ goal: "shared", required: true, status: "failing" }, { goal: "ok", required: true, status: "met" }]);
    expect(by("loose").unused).toBe(true);
    expect(by("shared").unused).toBeUndefined();
    expect(by("a").unused).toBeUndefined();
  });

  it("goes three deep, and an optional goal does not hold its parent back", () => {
    const goals = [g("top", ["mid", { goal: "extra", required: false }], { kind: "milestone" }), g("mid", ["leaf"]), g("leaf", [], { checks: [door] }), g("extra", [], { checks: [jump] })];
    const out = rollUpGoals(goals, (x) => x.checks.map((c) => state(c === jump ? runs("failed") : runs("passed"), c)));
    expect(out.map((s) => s.status)).toEqual(["met", "met", "met", "failing"]);
  });

  it("finds loops the same way every time, and rolls status up without going round", () => {
    const goals = [g("c", ["a"]), g("a", ["b"]), g("b", ["c"]), g("d", ["missing"])];
    expect(goalLoops(goals).cycles).toEqual([["a", "b", "c", "a"]]);
    expect([...goalLoops(goals).edges]).toEqual(["c>a"]);
    const out = rollUpGoals(goals, () => []);
    expect(out.map((s) => s.status)).toEqual(["not_started", "not_started", "not_started", "not_started"]);
    expect(out.find((s) => s.goal.id === "d")!.requires).toEqual([{ goal: "missing", required: true, status: null }]);
    expect(loopIfRequired(goals, "d", "d")).toEqual(["d", "d"]);
    expect(loopIfRequired([g("x", ["y"]), g("y")], "y", "x")).toEqual(["y", "x", "y"]);
    expect(loopIfRequired([g("x", ["y"]), g("y")], "x", "y")).toBeNull();
  });

  it("a goal's checks are its required goals' at any depth, then its own, each once", () => {
    const goals = [g("m", ["a", "b"], { checks: [swim] }), g("a", ["b"], { checks: [jump, door] }), g("b", [], { checks: [door] }), g("gone", [], { archived: true, checks: [swim] })];
    expect(goalTree(goals, "m")).toEqual(["b", "a", "m"]);
    expect(goalChecksDeep(goals, "m").map((c) => c.target)).toEqual([door.target, jump.target, swim.target]);
    // Archived goals are left out, and a loop is followed once.
    expect(goalChecksDeep([g("x", ["gone", "y"]), g("y", ["x"], { checks: [jump] }), goals[3]], "x").map((c) => c.target)).toEqual([jump.target]);
  });

  it("parents leave out archived goals; a check no goal lists is unused", () => {
    expect([...goalParents([g("m", ["a"]), g("old", ["a"], { archived: true })])]).toEqual([["a", ["m"]]]);
    expect(checkStateOf({ check: door, runs: [], goalIds: [] }).unused).toBe(true);
    expect(checkStateOf({ check: door, runs: [], goalIds: ["g"] }).unused).toBeUndefined();
  });
});

describe("goalSlug and ids", () => {
  it("lowercase words joined by dashes, at most 64 characters, never empty", () => {
    expect(goalSlug("A new player finishes the tutorial!")).toBe("a-new-player-finishes-the-tutorial");
    expect(goalSlug("Café  au lait")).toBe("cafe-au-lait");
    expect(goalSlug("!!!")).toBe("goal");
    const long = goalSlug("word ".repeat(40));
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long.endsWith("-")).toBe(false);
    expect(GOAL_ID.test(long)).toBe(true);
  });

  it("check ids round-trip, and a bad one is null", () => {
    expect(parseCheckId(checkId(script))).toEqual({ kind: "script", target: "/Game/Tests/Door" });
    expect(parseCheckId("manual:Has: a colon")).toEqual({ kind: "manual", target: "Has: a colon" });
    expect(parseCheckId("nope:x")).toBeNull();
    expect(parseCheckId("script:")).toBeNull();
  });
});

describe("outcomeOf", () => {
  const step = (status: QaStep["status"], judge: QaStep["judge"] = "auto"): QaStep => ({ index: 0, instruction: "", judge, status });
  const run = (state: Parameters<typeof outcomeOf>[0]["state"], steps: QaStep[]) => outcomeOf({ state, steps: steps.map((s, index) => ({ ...s, index })), summary: undefined as never });

  it("needs you while a live run waits for a verdict; not judged, no result, once it ended without one", () => {
    expect(run("awaiting_verdict", [step("passed"), step("awaiting_verdict", "manual")])).toBe("needs_you");
    expect(run("stopped", [step("passed"), step("awaiting_verdict", "manual"), step("pending")])).toBe("unjudged");
    expect(run("finished", [step("passed"), step("awaiting_verdict", "manual")])).toBe("unjudged");
    // A failure before the hold still makes the run failed.
    expect(run("stopped", [step("failed"), step("awaiting_verdict", "manual")])).toBe("failed");
    expect(RESULT_OUTCOMES).not.toContain("unjudged");
  });

  it("running, or failed as soon as a step fails", () => {
    expect(run("running", [step("passed"), step("pending")])).toBe("running");
    expect(run("armed", [])).toBe("running");
    expect(run("running", [step("failed"), step("pending")])).toBe("failed");
  });

  it("an ended run: failed, stopped, incomplete or passed", () => {
    expect(run("finished", [step("passed"), step("failed")])).toBe("failed");
    expect(run("stopped", [step("passed"), step("pending")])).toBe("stopped");
    expect(run("finished", [step("passed"), step("pending")])).toBe("incomplete");
    expect(run("finished", [])).toBe("incomplete");
    expect(run("finished", [step("passed"), step("skipped")])).toBe("passed");
  });

  it("a stopped run whose every step settled is judged by its steps", () => {
    expect(run("stopped", [step("passed"), step("passed", "manual")])).toBe("passed");
    expect(run("stopped", [step("passed"), step("failed", "manual")])).toBe("failed");
    expect(run("stopped", [])).toBe("stopped");
  });
});

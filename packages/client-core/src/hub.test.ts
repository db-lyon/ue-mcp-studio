import { describe, expect, it } from "vitest";
import { DEFAULT_ACCEPTANCE, type CheckState, type EvidenceScope, type Goal, type GoalState, type AttentionItem, type QueueState, type PlanRun } from "@ue-mcp-studio/shared";
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
  signOffText,
  hubApi,
  hubHash,
  hubKeymap,
  hubPath,
  milestoneGroups,
  moveId,
  moveQueued,
  goalCheckIds,
  parentCandidates,
  parentGoals,
  requireCandidates,
  requiredRows,
  paletteEntries,
  parseHubPath,
  parseTags,
  planProgress,
  proposeGoals,
  regressions,
  evidenceLabel,
  provenanceParts,
  revisionText,
  runMarks,
  runTimeline,
  scheduleErrors,
  scheduleText,
  searchPalette,
  sortChecks,
  sortGoals,
  sortAttention,
  sparkBars,
  typingTarget,
  hubLiveView,
  hubViewerLine,
  playingStep,
  playingFor,
  playingRuns,
  runPlaying,
  type HubLiveInput,
  type HubRoute,
  checkLinks,
  linkChip,
  linkFromRow,
  typedUrl,
  withLink,
  withoutLink,
} from "./hub.js";
import type { RunRecord, ViewportStatus } from "@ue-mcp-studio/shared";

const goal = (id: string, over: Partial<Goal> = {}): Goal => ({
  schema: 1, id, kind: "goal", title: id, acceptance: DEFAULT_ACCEPTANCE, checks: [], ...over,
});
const gs = (id: string, status: GoalState["status"], over: Partial<Goal> = {}, parents: string[] = []): GoalState => ({
  goal: goal(id, over), status, checks: [], progress: { met: 0, total: 0 }, parents,
  requires: (over.requires ?? []).map((r) => ({ goal: r.goal, required: r.required !== false, status: null })),
});
/** Goal states with parents worked out from their requires, as the agent does. */
const graph = (...states: GoalState[]): GoalState[] =>
  states.map((s) => ({ ...s, parents: states.filter((p) => !p.goal.archived && (p.goal.requires ?? []).some((r) => r.goal === s.goal.id)).map((p) => p.goal.id) }));
const check = (name: string, health: CheckState["health"], over: Partial<CheckState> = {}): CheckState => ({
  id: `script:/Game/T/${name}`, check: { kind: "script", target: `/Game/T/${name}` }, name, goalIds: [], health, last: null, recent: [], passRate: null, ...over,
});

describe("hub routes", () => {
  it("round-trips every screen through the hash, encoding ids", () => {
    const routes: HubRoute[] = [
      { screen: "overview" }, { screen: "library" }, { screen: "queue" },
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

describe("sign-off", () => {
  const record = { goalId: "g", by: "octocat", at: "2026-11-23T10:00:00Z", revision: "abc", runIds: [], requirements: "" };
  it("names who signed and from which paired device, or why it lapsed", () => {
    expect(signOffText({ record, lapsed: null })).toEqual({ title: "Signed off by octocat" });
    expect(signOffText({ record: { ...record, via: "Ama's phone" }, lapsed: null }).title).toBe("Signed off by octocat from Ama's phone");
    expect(signOffText({ record, lapsed: "revision" })).toMatchObject({ title: "Signed off on an earlier revision" });
    expect(signOffText({ record, lapsed: "failed" }).detail).toBe("A required check failed after it.");
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

  it("puts blocked loops first in Needs attention, oldest first within a kind", () => {
    const item = (id: string, kind: AttentionItem["kind"], at: string): AttentionItem => ({ id, kind, at, title: id, goalIds: [] });
    expect(sortAttention([item("r", "regression", "1"), item("l2", "loop_blocked", "3"), item("l1", "loop_blocked", "2")]).map((i) => i.id)).toEqual(["l1", "l2", "r"]);
  });
});

describe("overview models", () => {
  it("groups goals under milestones by due date in each milestone's order, a shared goal under both, other goals last", () => {
    const all = graph(
      gs("m2", "met", { kind: "milestone", due: "2026-12-01", requires: [{ goal: "shared" }] }),
      gs("m1", "failing", { kind: "milestone", due: "2026-11-01", requires: [{ goal: "g1" }, { goal: "shared" }, { goal: "gone" }] }),
      gs("g1", "met", { requires: [{ goal: "deep" }] }),
      gs("shared", "failing"),
      gs("deep", "met"),
      gs("g3", "met"),
      gs("g4", "met", { archived: true }),
    );
    const groups = milestoneGroups(all);
    expect(groups.map((g) => g.milestone?.goal.id ?? null)).toEqual(["m1", "m2", null]);
    expect(groups[0].goals.map((g) => g.goal.id)).toEqual(["g1", "shared"]);
    expect(groups[1].goals.map((g) => g.goal.id)).toEqual(["shared"]);
    // The same row, not a copy.
    expect(groups[1].goals[0]).toBe(groups[0].goals[1]);
    // A goal only another goal requires shows on that goal's screen.
    expect(groups[2].goals.map((g) => g.goal.id)).toEqual(["g3"]);
  });

  it("lists a goal's parents, required goals and deep checks, and what can be added without a loop", () => {
    const door = { kind: "script" as const, target: "/Game/T/Door" };
    const jump = { kind: "script" as const, target: "/Game/T/Jump" };
    const all = graph(
      gs("m", "met", { kind: "milestone", requires: [{ goal: "a" }, { goal: "b", required: false }] }),
      gs("n", "met", { kind: "goal", requires: [{ goal: "a" }] }),
      gs("a", "met", { checks: [jump, door], requires: [{ goal: "b" }] }),
      gs("b", "met", { checks: [door] }),
      gs("c", "met"),
    );
    const a = all.find((g) => g.goal.id === "a")!;
    expect(parentGoals(a, all).map((g) => g.goal.id)).toEqual(["m", "n"]);
    expect(requiredRows(all[0], all).map((r) => [r.state.goal.id, r.required])).toEqual([["a", true], ["b", false]]);
    expect(goalCheckIds("m", all)).toEqual(["script:/Game/T/Door", "script:/Game/T/Jump"]);
    expect(requireCandidates("a", all).map((g) => g.goal.id).sort()).toEqual(["c"]);
    expect(parentCandidates("a", all).map((g) => g.goal.id)).toEqual(["m", "c", "n"]);
    expect(parentCandidates(null, all)).toHaveLength(5);
    expect(moveId(["x", "y", "z"], "z", -1)).toEqual(["x", "z", "y"]);
    expect(moveId(["x", "y"], "x", -1)).toEqual(["x", "y"]);
  });

  it("says how many goals are in each status, milestones aside", () => {
    expect(goalSummary([gs("a", "failing"), gs("b", "met"), gs("c", "met"), gs("m", "met", { kind: "milestone" })])).toBe("3 goals: 1 failing, 2 met");
    expect(goalSummary([])).toBe("No goals");
  });

  it("finds checks that just broke, a fail after a pass on something else, and counts flips", () => {
    const broke = { kind: "regressed" as const, runId: "r", at: "2026-11-22T10:00:00Z" };
    expect(regressions([
      check("a", "failing", { recent: ["failed", "passed"], change: broke }),
      check("b", "failing", { recent: ["failed", "passed"] }),
      check("c", "passing", { change: { ...broke, kind: "fixed" } }),
    ]).map((c) => c.name)).toEqual(["a"]);
    expect(flips(["passed", "failed", "passed", "passed", "stopped", "failed"])).toBe(3);
  });

  it("says whose view the statuses are, at which revision", () => {
    const at = (current: EvidenceScope["current"]): string => evidenceLabel({ store: "local", current });
    expect(at({ vcs: "git", revision: "a1b2c3d4e5f6", dirty: 0 })).toBe("On this computer at a1b2c3d");
    expect(at({ vcs: "perforce", revision: "1234", dirty: 3 })).toBe("On this computer at changelist 1234 with 3 changed files");
    expect(at({ vcs: "git", revision: null, dirty: null })).toBe("On this computer, revision unknown");
    expect(at({ vcs: "none", revision: null, dirty: null })).toBe("On this computer");
  });

  it("marks runs that do not count, and says what a run tested", () => {
    const p = { vcs: "git" as const, revision: "a1b2c3d4e5", dirty: 0, scriptHash: "sha256:3f2a9c1d00", engine: "5.5", players: { count: 2, netMode: "listen" as const } };
    expect(runMarks({ provenance: p })).toEqual([]);
    expect(runMarks({ trigger: "loop", provenance: p }).map((m) => m.label)).toEqual(["Fix loop attempt"]);
    expect(runMarks({ replayOf: "x", provenance: { ...p, dirty: 2 } }).map((m) => m.label)).toEqual(["Replay", "Uncommitted changes"]);
    expect(runMarks({}).map((m) => m.label)).toEqual(["Revision unknown"]);
    expect(provenanceParts(p)).toEqual(["At a1b2c3d", "Script 3f2a9c1", "UE 5.5", "2 players, listen server"]);
    expect(provenanceParts({ ...p, revision: null, dirty: 1, scriptHash: null, players: null })).toEqual(["Revision unknown", "1 changed file", "UE 5.5"]);
    expect(provenanceParts(undefined)).toEqual(["Revision unknown"]);
    expect(revisionText("svn", "88")).toBe("revision 88");
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

  it("takes any goals as parents, but not itself, an unknown one, or one it requires", () => {
    const goals = graph(gs("m", "met", { kind: "milestone" }), gs("g", "met"), gs("self", "met", { requires: [{ goal: "g" }] }));
    expect(goalFormErrors({ ...goalFormOf(), title: "x", parents: ["m", "g"] }, { goals })).toEqual({});
    expect(goalFormErrors({ ...goalFormOf(), title: "x", kind: "milestone", parents: ["m"] }, { goals })).toEqual({});
    expect(goalFormErrors({ ...goalFormOf(), title: "x", parents: ["self"] }, { goals, selfId: "self" }).parents).toBe("A goal cannot be part of itself.");
    expect(goalFormErrors({ ...goalFormOf(), title: "x", parents: ["gone"] }, { goals }).parents).toBe("Pick goals from the list.");
    expect(goalFormErrors({ ...goalFormOf(), title: "x", parents: ["g"] }, { goals, selfId: "self" }).parents).toContain("already requires g");
    expect(goalFormOf(goals[1].goal, ["m"]).parents).toEqual(["m"]);
    expect(goalDraftOf({ ...goalFormOf(), title: "x", parents: ["m"] }).parents).toEqual(["m"]);
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
    const plan = (id: string): PlanRun => ({ id, title: id, scope: { kind: "all" }, options: { attended: true, stopOnFailure: false, replay: false }, state: "queued", items: [], trigger: "person", createdAt: "" });
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
    expect(k.press({ key: "q" })).toEqual({ type: "go", to: "queue" });
    k.press({ key: "g" });
    t = 5000;
    expect(k.press({ key: "q" })).toBeNull();
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
    await api.addRequire("m", "a b");
    await api.addRequire("m", "a", false);
    await api.removeRequire("m", "a b");
    await api.orderRequires("m", ["a", "b"]);
    await api.orderChecks("g", ["script:/Game/B", "script:/Game/A"]);
    expect(calls.slice(6)).toEqual([
      ["POST", "/v1/ext/studio/hub/goals/m/requires", { goal: "a b" }],
      ["POST", "/v1/ext/studio/hub/goals/m/requires", { goal: "a", required: false }],
      ["DELETE", "/v1/ext/studio/hub/goals/m/requires/a%20b", undefined],
      ["PUT", "/v1/ext/studio/hub/goals/m/requires", { order: ["a", "b"] }],
      ["PUT", "/v1/ext/studio/hub/goals/g/checks/order", { order: ["script:/Game/B", "script:/Game/A"] }],
    ]);
    expect(calls.slice(0, 6)).toEqual([
      ["GET", "/v1/ext/studio/hub", undefined],
      ["DELETE", "/v1/ext/studio/hub/goals/tut/checks/script%3A%2FGame%2FA", undefined],
      ["GET", "/v1/ext/studio/hub/checks/script%3A%2FGame%2FA?limit=30", undefined],
      ["GET", "/v1/ext/studio/hub/runs?check=script%3A%2FGame%2FA&before=r1", undefined],
      ["POST", "/v1/ext/studio/hub/plans/p1/move", { to: 2 }],
      ["POST", "/v1/ext/studio/qa/runs/r%201/verdict", { step: 3, verdict: "fail", note: "fell through" }],
    ]);
  });
});

describe("the live viewport in the hub", () => {
  const rec = (runId: string, name: string, outcome: RunRecord["outcome"], endedAt: string | null = null): RunRecord => ({
    runId, kind: "script", target: `/Game/T/${name}`, name, outcome, startedAt: "2026-11-23T10:00:00Z", endedAt, source: "plan",
  });
  const idle: QueueState = { paused: false, current: null, queued: [], recent: [], schedules: [], editor: { connected: true } };
  const over = (recent: RunRecord[], queue: QueueState = idle, connected = true) => ({ recent, queue, editor: { connected } });

  it("counts a run as playing until it ends, including one holding for a person's verdict", () => {
    expect(runPlaying(rec("a", "A", "running"))).toBe(true);
    expect(runPlaying(rec("a", "A", "needs_you"))).toBe(true);
    expect(runPlaying(rec("a", "A", "passed", "2026-11-23T10:01:00Z"))).toBe(false);
  });

  it("finds what plays from the run list, then the queue, and nothing while the editor is away", () => {
    const plan = { id: "p", title: "Run goal", state: "running", items: [
      { check: { kind: "script", target: "/Game/T/B" }, name: "B", state: "running", runId: "b" },
      { check: { kind: "script", target: "/Game/T/A" }, name: "A", state: "running", runId: "a" },
    ] } as unknown as PlanRun;
    const o = over([rec("a", "A", "passed", "2026-11-23T10:01:00Z")], { ...idle, current: plan });
    // The run list says a ended, whatever the plan still says; b is not listed yet, so the plan decides.
    expect(playingRuns(o)).toEqual([{ runId: "b", checkId: "script:/Game/T/B", name: "B" }]);
    expect(playingFor(o, ["script:/Game/T/B"])?.runId).toBe("b");
    expect(playingFor(o, ["script:/Game/T/A"])).toBeNull();
    expect(playingRuns(over([rec("c", "C", "running")], idle, false))).toEqual([]);
  });

  it("draws only the line while collapsed, and once expanded the video or a notice, never an empty box", () => {
    const base: HubLiveInput = { open: true, playing: true, endedFrame: false, gated: false, phase: "live" };
    expect(hubLiveView(base)).toBe("video");
    expect(hubLiveView({ ...base, open: false })).toBe("collapsed");
    expect(hubLiveView({ ...base, open: false, playing: false })).toBe("collapsed");
    expect(hubLiveView({ ...base, phase: "connecting" })).toBe("notice");
    expect(hubLiveView({ ...base, gated: true })).toBe("notice");
    // Play In Editor not running: the viewer waits, and the card says so.
    expect(hubLiveView({ ...base, playing: false, phase: "waiting" })).toBe("notice");
    expect(hubLiveView({ ...base, playing: false, phase: "live" })).toBe("video");
    expect(hubLiveView({ ...base, playing: false, phase: "waiting", endedFrame: true })).toBe("ended");
    // Already shown during this run: a stream that drops back keeps its last frame.
    expect(hubLiveView({ ...base, phase: "waiting", seenFrame: true })).toBe("held");
    expect(hubLiveView({ ...base, phase: "failed", seenFrame: true })).toBe("notice");
    expect(hubLiveView({ ...base, phase: "waiting", seenFrame: true, gated: true })).toBe("notice");
  });

  it("says in one line what the editor does, or which of the screen's checks runs", () => {
    const ready = { access: "ok", editor: "ready", streamer: false, source: null, viewers: 0, pie: false } as ViewportStatus;
    const run = { runId: "r", checkId: "script:/Game/T/A", name: "Door opens" };
    expect(hubViewerLine({ editorConnected: false, status: ready, running: null })).toEqual({ tone: "off", text: "Editor offline", run: null });
    expect(hubViewerLine({ editorConnected: true, status: { ...ready, editor: "no-editor" }, running: null }).text).toBe("Editor offline");
    expect(hubViewerLine({ editorConnected: true, status: ready, running: null }).text).toBe("Play In Editor is not running");
    expect(hubViewerLine({ editorConnected: true, status: null, running: null }).text).toBe("Play In Editor is not running");
    expect(hubViewerLine({ editorConnected: true, status: { ...ready, pie: true }, running: null })).toEqual({ tone: "on", text: "Play In Editor is running", run: null });
    expect(hubViewerLine({ editorConnected: true, status: { ...ready, pie: true }, running: run })).toEqual({ tone: "run", text: "Running now", run });
    expect(hubViewerLine({ editorConnected: true, status: { ...ready, editor: "plugin-off" }, running: null })).toEqual({ tone: "warn", text: "Streaming unavailable: Pixel Streaming 2 is off", run: null });
    expect(hubViewerLine({ editorConnected: true, status: { ...ready, editor: "no-actions" }, running: null }).text).toBe("Streaming unavailable: ue-mcp needs an update");
  });

  it("follows the running step, then the one waiting for a verdict, then the next to start", () => {
    expect(playingStep([{ status: "passed" }, { status: "awaiting_verdict" }, { status: "running" }])).toEqual({ status: "running" });
    expect(playingStep([{ status: "passed" }, { status: "awaiting_verdict" }, { status: "pending" }])).toEqual({ status: "awaiting_verdict" });
    expect(playingStep([{ status: "passed" }, { status: "pending", n: 1 }, { status: "pending", n: 2 }])).toEqual({ status: "pending", n: 1 });
    expect(playingStep([{ status: "passed" }, { status: "failed" }])).toBeNull();
  });
});

describe("tracker links", () => {
  const issue = { url: "https://git.example.com/ember/hollow/issues/42" };

  it("shows a link as its host and title, or the end of its address", () => {
    expect(linkChip({ ...issue, title: "Tutorial glade" })).toMatchObject({ host: "git.example.com", label: "Tutorial glade" });
    expect(linkChip(issue)).toMatchObject({ host: "git.example.com", label: "issues/42" });
    expect(linkChip({ url: "jira://HOL-118" })).toMatchObject({ host: "jira", label: "HOL-118" });
    expect(linkChip({ url: "https://www.trello.com/c/a1b2" })).toMatchObject({ host: "trello.com", label: "c/a1b2" });
    expect(linkChip({ url: "mailto:qa@example.com" })).toMatchObject({ host: "qa@example.com", label: "" });
    expect(linkChip({ ...issue, rel: "filed-from-run" }).tip).toBe(`Filed from a run\n${issue.url}`);
  });

  it("reads what was typed: a bare host is https, an unsafe scheme is refused", () => {
    expect(typedUrl("git.example.com/x/issues/4")).toBe("https://git.example.com/x/issues/4");
    expect(typedUrl("jira://HOL-1")).toBe("jira://HOL-1");
    expect(linkFromRow({ url: " git.example.com/x ", title: " T " })).toEqual({ link: { url: "https://git.example.com/x", title: "T" } });
    expect(linkFromRow({ url: "javascript:alert(1)" })).toHaveProperty("error");
    expect(linkFromRow({ url: "not a url" })).toHaveProperty("error");
    expect(linkFromRow({ url: "" })).toEqual({ error: "Paste the link's URL." });
  });

  it("adds a link once per URL and removes one by URL", () => {
    const a = withLink([issue], { ...issue, title: "Again" });
    expect(a).toEqual([{ ...issue, title: "Again" }]);
    expect(withoutLink(a, issue.url)).toEqual([]);
  });

  it("gathers a check's links across the goals that list it", () => {
    const ref = (links?: Array<{ url: string }>) => ({ kind: "script" as const, target: "/Game/T/A", ...(links ? { links } : {}) });
    const goals = [gs("a", "met", { checks: [ref([issue])] }), gs("b", "met", { checks: [ref([issue, { url: "jira://X-1" }])] }), gs("c", "met", { checks: [ref()] })];
    expect(checkLinks("script:/Game/T/A", goals)).toEqual([{ link: issue, goalIds: ["a", "b"] }, { link: { url: "jira://X-1" }, goalIds: ["b"] }]);
  });

  it("the goal form carries links, and says what is wrong with one", () => {
    const f = { ...goalFormOf({ links: [issue] }), title: "x" };
    expect(f.links).toEqual([{ url: issue.url, title: "", rel: "" }]);
    expect(goalDraftOf({ ...f, links: [...f.links, { url: "", title: "", rel: "" }] }).links).toEqual([issue]);
    expect(goalFormErrors({ ...f, links: [{ url: "data:x", title: "", rel: "" }] }).links).toBeTruthy();
  });

  it("calls the link routes", async () => {
    const calls: Array<[string, string, unknown]> = [];
    const api = hubApi(async <T,>(m: string, p: string, b?: unknown) => {
      calls.push([m, p, b]);
      return {} as T;
    });
    await api.updateCheck("tut", "script:/Game/A", { links: [issue] });
    await api.addRunLink("r 1", issue);
    await api.removeRunLink("r 1", issue.url);
    expect(calls).toEqual([
      ["PUT", "/v1/ext/studio/hub/goals/tut/checks/script%3A%2FGame%2FA", { links: [issue] }],
      ["POST", "/v1/ext/studio/hub/runs/r%201/links", { link: issue }],
      ["DELETE", `/v1/ext/studio/hub/runs/r%201/links?url=${encodeURIComponent(issue.url)}`, undefined],
    ]);
  });
});

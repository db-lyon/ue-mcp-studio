/**
 * The Playtest Hub's screens for the visual QA harness: one small project
 * (an arena arrangement with two player tracks, a Checks track in all four modes and
 * two regions; three clips; nested suites with history, a flaky test and a
 * quarantined one) and the daemon's answers to the hub routes for it.
 */
import type { Arrangement, ArrangementView, Clip, HubOverview, RunRecord, SuiteState, TestState } from "ue-mcp/daemon";
import type { Scenario } from "./fixtures";

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const CLIPS: Record<string, Clip> = {
  "sprint-to-gate": {
    id: "sprint-to-gate", title: "Sprint to the gate", performer: "player", rate: 60, length: 300,
    input: [
      { action: "/Game/Input/IA_Move.IA_Move", type: "axis2d", notes: [{ id: "n1", start: 0, length: 240, value: [0, 1] }], keys: [] },
      { action: "/Game/Input/IA_Sprint.IA_Sprint", type: "bool", notes: [{ id: "n1", start: 20, length: 200 }], keys: [] },
      { action: "/Game/Input/IA_Jump.IA_Jump", type: "bool", notes: [{ id: "n1", start: 150, length: 12 }, { id: "n2", start: 260, length: 12 }], keys: [] },
      { action: "/Game/Input/IA_Look.IA_Look", type: "axis2d", notes: [], keys: [{ id: "k1", t: 40, v: [0, 0] }, { id: "k2", t: 120, v: [0.4, 0] }, { id: "k3", t: 200, v: [0, 0] }] },
    ],
    lanes: [],
  },
  "open-gate": {
    id: "open-gate", title: "Open the gate", performer: "player", rate: 60, length: 180,
    input: [{ action: "/Game/Input/IA_Interact.IA_Interact", type: "bool", notes: [{ id: "n1", start: 30, length: 10 }], keys: [] }],
    lanes: [],
  },
  "flank-left": {
    id: "flank-left", title: "Flank left", performer: "player", rate: 60, length: 420,
    input: [
      { action: "/Game/Input/IA_Move.IA_Move", type: "axis2d", notes: [{ id: "n1", start: 0, length: 180, value: [-1, 0.5] }, { id: "n2", start: 200, length: 200, value: [0, 1] }], keys: [] },
      { action: "/Game/Input/IA_Crouch.IA_Crouch", type: "bool", notes: [{ id: "n1", start: 60, length: 120 }], keys: [] },
    ],
    lanes: [],
  },
};

const ARENA: Arrangement = {
  id: "arena-gate", title: "Arena gate", level: "/Game/Maps/L_Arena", rate: 60,
  tracks: [
    { id: "t1", title: "Player", performer: { kind: "player", client: 0 }, mute: false, solo: false, instances: [{ id: "i1", clip: "sprint-to-gate", at: 0 }, { id: "i2", clip: "open-gate", at: 330 }] },
    { id: "t2", title: "Client 1", performer: { kind: "player", client: 1 }, mute: false, solo: false, instances: [{ id: "i3", clip: "flank-left", at: 60 }] },
  ],
  checks: [
    { id: "c1", title: "Reaches the gate", at: 120, length: 180, mode: "by_end", expect: { value: "pawn.distance_to:Gate", op: "<", target: 150 } },
    { id: "c2", title: "Stays alive", at: 0, length: 540, mode: "throughout", expect: { value: "pawn.health", op: ">", target: 0 } },
    { id: "c3", title: "Gate opens", at: 350, length: 90, mode: "hold", expect: { value: "BP_Gate.bOpen", op: "==", target: true } },
    { id: "c4", title: "Gate swing looks right", at: 450, length: 0, mode: "manual", instruction: "Watch the gate swing: it eases in and does not clip the wall." },
  ],
  regions: [{ id: "approach", name: "Approach", start: 0, end: 320 }, { id: "gate", name: "Gate", start: 320, end: 540 }],
};

const RUN: RunRecord = {
  runId: "run-41", test: "arena-gate", title: "Arena gate", runner: "editor", source: "person", batch: "b-41",
  startedAt: ago(1), endedAt: null, state: "awaiting_verdict", frame: 452, revision: "a3f9c21e", dirty: 0,
  checks: [
    { id: "c1", status: "passed", frame: 262 },
    { id: "c2", status: "running" },
    { id: "c3", status: "passed", frame: 371 },
    { id: "c4", status: "awaiting_verdict", frame: 450 },
  ],
};

const test = (id: string, title: string, health: TestState["health"], passRate: number | null, o: Partial<TestState> = {}): TestState => ({
  id, arrangement: id.split(":")[0]!, ...(id.includes(":") ? { region: id.split(":")[1] } : {}), title, health, checks: 2, passRate,
  flaky: { detected: false, marked: false, checks: [] }, quarantined: false, ...(passRate !== null ? { last: { runId: `r-${id}`, state: health === "failing" ? "failed" : "passed", startedAt: ago(40), endedAt: ago(39) } } : {}), ...o,
});

const TESTS: TestState[] = [
  test("arena-gate", "Arena gate", "running", 0.85, { checks: 4 }),
  test("arena-gate:approach", "Arena gate: Approach", "passing", 1),
  test("arena-gate:gate", "Arena gate: Gate", "flaky", 0.6, { flaky: { detected: true, marked: false, checks: ["c3"] } }),
  test("bridge-crossing", "Bridge crossing", "failing", 0.4),
  test("lobby-idle", "Lobby idle", "never_run", null, { quarantined: true }),
];

const history = (rates: number[]) => rates.map((r, i) => ({ batch: `b${i}`, at: ago(60 * (rates.length - i)), passed: Math.round(r * 5), total: 5, rate: r }));

const SUITES: SuiteState[] = [
  {
    id: "smoke", title: "Smoke", items: [{ test: "arena-gate:approach" }, { test: "arena-gate:gate" }, { test: "lobby-idle" }, { suite: "traversal" }], health: "flaky", passRate: 0.78,
    history: history([1, 0.8, 1, 0.6, 0.8, 1, 0.8, 0.6, 1, 0.8, 0.8, 0.6]), tests: [TESTS[1]!, TESTS[2]!, TESTS[4]!, TESTS[3]!], quarantined: ["lobby-idle"], flaky: [], missing: [],
  },
  {
    id: "traversal", title: "Traversal", items: [{ test: "bridge-crossing" }], health: "failing", passRate: 0.4,
    history: history([0.6, 0.4, 0.4, 0.2, 0.4]), tests: [TESTS[3]!], quarantined: [], flaky: [], missing: [],
  },
  {
    id: "nightly", title: "Nightly", items: [{ suite: "smoke" }, { test: "arena-gate" }], health: "running", passRate: 0.8,
    history: history([0.8, 1, 0.8, 0.8]), tests: [TESTS[1]!, TESTS[2]!, TESTS[4]!, TESTS[3]!, TESTS[0]!], quarantined: [], flaky: [], missing: [],
  },
];

const OVERVIEW: HubOverview = {
  clips: Object.values(CLIPS).map((c) => ({ id: c.id, title: c.title, performer: c.performer, rate: c.rate, length: c.length, lanes: c.input.length + c.lanes.length, usedBy: ["arena-gate"] })),
  arrangements: [
    { id: "arena-gate", title: "Arena gate", level: "/Game/Maps/L_Arena", tracks: 2, checks: 4, regions: ARENA.regions.map((r) => ({ id: r.id, name: r.name })), length: 540, findings: [] },
    { id: "bridge-crossing", title: "Bridge crossing", level: "/Game/Maps/L_Bridge", tracks: 1, checks: 2, regions: [], length: 900, findings: [] },
    { id: "lobby-idle", title: "Lobby idle", level: null, tracks: 1, checks: 2, regions: [], length: 600, findings: [{ path: "tracks[0].instances[0]", message: "Player: no clip idle-loop", blocks: true }] },
  ],
  suites: SUITES,
  tests: TESTS,
  queue: {
    paused: false, waiting: [],
    running: [{ id: "q1", test: "arena-gate", title: "Arena gate", runner: "editor", source: "person", batch: "b-41", queuedAt: ago(2), state: "running", runId: "run-41" }],
    queued: [
      { id: "q2", test: "bridge-crossing", title: "Bridge crossing", runner: "editor", source: "schedule", batch: "b-42", suite: "traversal", queuedAt: ago(1), state: "queued" },
      { id: "q3", test: "arena-gate:approach", title: "Arena gate: Approach", runner: "editor", source: "person", batch: "b-43", suite: "smoke", queuedAt: ago(1), state: "queued" },
    ],
  },
  lease: null,
  recent: [
    RUN,
    { runId: "run-40", test: "bridge-crossing", title: "Bridge crossing", runner: "editor", source: "schedule", batch: "b-40", suite: "traversal", startedAt: ago(42), endedAt: ago(40), state: "failed", revision: "a3f9c21e", dirty: 0, checks: [{ id: "c1", status: "passed" }, { id: "c2", status: "failed", message: "pawn.z fell below -500" }] },
    { runId: "run-39", test: "arena-gate:gate", title: "Arena gate: Gate", runner: "editor", source: "person", batch: "b-39", suite: "smoke", startedAt: ago(70), endedAt: ago(69), state: "passed", revision: "a3f9c21e", dirty: 0, checks: [{ id: "c3", status: "passed" }, { id: "c4", status: "passed", verdict: { by: "person", at: ago(69) } }] },
  ],
  schedules: [],
  problems: [],
};

const VIEW: ArrangementView = { arrangement: ARENA, length: 540, findings: [], clips: CLIPS, tests: TESTS.slice(0, 3) };

/** The daemon's answers to the hub routes for this project. */
function hubGet(p: string): unknown {
  if (p === "/v1/hub") return OVERVIEW;
  if (p === "/v1/hub/lease") return { lease: null };
  if (p === "/v1/hub/arrangements/arena-gate") return VIEW;
  if (p.startsWith("/v1/hub/performers")) return { level: "/Game/Maps/L_Arena", performers: [{ performer: { kind: "player", client: 0 }, label: "Player 1", capabilities: ["input", "move", "action", "value"] }, { performer: { kind: "player", client: 1 }, label: "Client 1", capabilities: ["input", "move", "action", "value"] }] };
  const clip = /^\/v1\/hub\/clips\/([^/]+)$/.exec(p);
  if (clip && CLIPS[decodeURIComponent(clip[1]!)]) return { clip: CLIPS[decodeURIComponent(clip[1]!)] };
  return undefined;
}

const hub = (title: string, hash: string, extra: Partial<Scenario> = {}): Scenario => ({
  title,
  hash,
  settings: { experiments: { playtestHub: true } },
  get: hubGet,
  ...extra,
});

export const HUB_SCENARIOS: Record<string, Scenario> = {
  "hub-arrangements": hub("Playtest Hub, Arrangements: each arrangement's level, tracks, checks, regions and last result", "#/playtests"),
  "hub-arrangement": hub("The Arrangement: two tracks, the regions above them and the Checks track in its four modes, a run waiting for a manual verdict", "#/playtests/arrangements/arena-gate", { waitFor: { selector: ".hub-set-check", timeout: 5000 } }),
  "hub-arrangement-check": hub("The Arrangement with the manual check selected: its instruction, person-only, and Pass and Fail in the inspector", "#/playtests/arrangements/arena-gate", { waitFor: { selector: ".hub-set-check", timeout: 5000 }, click: ".hub-set-check.mode-manual" }),
  "hub-clip": hub("A clip as a piano roll: notes on its input lanes and keys on its look lane, no checks", "#/playtests/clips/sprint-to-gate/in/arena-gate", { waitFor: { selector: ".hub-roll-note", timeout: 5000 } }),
  "hub-suites": hub("Suites: nested suites with their health, the pass-rate history, a flaky test and a quarantined one", "#/playtests/suites/smoke"),
  "hub-runs": hub("Runs: the test playing now, the queue behind it and the recent runs", "#/playtests/runs"),
};

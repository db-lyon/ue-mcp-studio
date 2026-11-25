/**
 * The Playtest Hub's screens for the visual QA harness, drawn from the same
 * project the hub demo plays (hub-demo/seed.ts): each scenario is a snapshot
 * of the simulated daemon at one moment, its GETs answered by the simulator
 * itself, so the shots and the demo always agree.
 */
import { checkId, type Clip } from "@ue-mcp-studio/shared";
import { demoRandom, demoState, DEMO_PROJECT, DEMO_SCRIPTS_DIR, type DemoSeed } from "../hub-demo/seed";
import { HubDemo } from "../hub-demo/sim";
import type { Scenario } from "./fixtures";

/** The simulated project after `ms` of play: the queue's first plan under way. */
function snapshot(seed: DemoSeed, ms: number, editor = true): HubDemo {
  const start = Date.now() - ms - 5_000;
  let now = start;
  const state = demoState(seed, start);
  state.editor = editor;
  const d = new HubDemo(state, { now: () => now, random: demoRandom(11) });
  for (let t = 0; t < ms; t += 250) {
    now += 250;
    d.tick();
  }
  return d;
}

/** The daemon's health with the demo project's editor connected or not. */
const health = (connected: boolean) => ({
  ok: true, pid: 4120, version: "1.4.11-beta.4", apiVersion: 1, projectRoot: "c:/users/dev/projects/emberhollow", startedAt: "2026-11-23T08:00:00Z",
  editors: [{ name: DEMO_PROJECT, connected, port: 9877, pid: connected ? 22816 : null, lastDisconnect: connected ? null : { cause: "closed", at: "2026-11-23T14:10:00Z" } }],
  clients: 1, inflight: 0, lastEventId: 0, extensions: [{ name: "studio", version: "dev" }], ui: "dev", features: ["checkpoints", "hub", "hub.goalDelete"],
});

function hub(title: string, hash: string, d: HubDemo, extra: Partial<Scenario> = {}): Scenario {
  const index = d.handle("GET", "/v1/ext/studio/qa/playtests", new URLSearchParams())!.body as Scenario["index"];
  return {
    title,
    hash,
    index,
    settings: { experiments: { playtestHub: true } },
    get: (p, url) => {
      if (p === "/v1/health") return health(d.state.editor);
      const a = d.handle("GET", p, url.searchParams);
      return a && a.status < 400 ? a.body : undefined;
    },
    // The playtest editor's check of a draft, which changes nothing.
    post: (p, body) => {
      if (!p.endsWith("/qa/drafting/validate")) return undefined;
      const a = d.handle("POST", p, new URLSearchParams(), body);
      return a ? { status: a.status, body: a.body } : undefined;
    },
    ...extra,
  };
}

const full = snapshot("full", 6_000);
const offline = snapshot("full", 0, false);
const empty = snapshot("empty", 0);
const enc = encodeURIComponent;
const ledge = checkId({ kind: "script", target: `${DEMO_SCRIPTS_DIR}/Traversal/PT_LedgeGrab` });
const staggerRun = full.state.runs.find((r) => r.name === "PT_Stagger_Wisp" && r.outcome === "failed")!.runId;
const editOf = (path: string) => `#/playtests/checks/${enc(checkId({ kind: "script", target: path }))}/edit`;

/** A project with a playtest whose first step names a value the pawn does not have: the editor's finding and its fixes. */
const typo = snapshot("full", 0);
const TYPO = `${DEMO_SCRIPTS_DIR}/Traversal/PT_Jump_Count`;
typo.state.scripts.push({
  path: TYPO,
  name: "PT_Jump_Count",
  map: "/Game/EmberHollow/Maps/L_Ashwood",
  author: "Sam Okafor",
  tags: [],
  profile: {},
  steps: [
    { instruction: "Press Jump, then JumpCurentCount is greater than 0 within 1 s", judge: "auto", act: [{ press: { action: "/Game/EmberHollow/Input/IA_Jump" } }], expect: { value: "JumpCurentCount", op: "gt", target: 0, within_ms: 1000 } },
    { instruction: "Hold Sprint and the stamina ring shows", judge: "auto", act: [{ hold: { action: "/Game/EmberHollow/Input/IA_Sprint", value: 1, ms: 1500 } }], expect: { value: "WBP_StaminaRing", op: "visible", within_ms: 2000 } },
    { instruction: "The jump arc looks smooth, with no snap at the peak", judge: "manual", agent_judgeable: false },
  ],
});

/** A timeline playtest: walk forward to a door, jump, then hold until the door is open, with a person's check at the end. */
const CLIP_PATH = "/Game/EmberHollow/Clips/CL_DoorOpens";
const IA = "/Game/EmberHollow/Input";
const DEMO_CLIP: Clip = {
  rate: 60,
  length: 300,
  grid: "frame",
  regions: [{ id: "r1", name: "Walk to the door", start: 0, end: 150 }, { id: "r2", name: "Door opens", start: 150, end: 300 }],
  tracks: [
    { action: `${IA}/IA_Move.IA_Move`, type: "axis2d", keys: [{ id: "k1", t: 0, v: [0, 1], interp: "constant" }, { id: "k2", t: 110, v: [0.4, 0.8] }, { id: "k3", t: 150, v: [0, 0], interp: "constant" }] },
    { action: `${IA}/IA_Jump.IA_Jump`, type: "bool", notes: [{ id: "n1", start: 60, length: 8 }, { id: "n2", start: 196, length: 6 }] },
    { action: `${IA}/IA_Interact.IA_Interact`, type: "bool", notes: [{ id: "n3", start: 160, length: 20 }] },
  ],
  events: [{ id: "e1", at: 0, do: { console: "stat fps" } }],
  checks: [
    { id: "c1", start: 0, length: 140, mode: "by_end", expect: { value: "pos_x", op: "increasing", target: 400 } },
    { id: "c2", start: 150, length: 0, mode: "hold", expect: { value: "BP_Door.bOpen", op: "eq", target: true } },
    { id: "c3", start: 40, length: 60, mode: "throughout", expect: { value: "Speed2", op: "gt", target: 100 } },
    { id: "c4", start: 260, length: 30, mode: "hold", manual: true, instruction: "The door swings open without a pop" },
  ],
};
const CLIP_WARNINGS = [{ id: "c3", field: "expect.value", message: "Speed2 is not a value on BP_Hero.", candidates: ["speed2d", "speed"] }];

/** Answers the timeline's routes for a scenario, on top of the demo's. */
function clipRoutes(p: string): unknown {
  if (p === "/v1/ext/studio/clips") return { clips: [
    { path: CLIP_PATH, name: "CL_DoorOpens", map: "/Game/EmberHollow/Maps/L_Ashwood", last_run: { run_id: "clip-7", passed: false, state: "finished" } },
    { path: "/Game/EmberHollow/Clips/CL_LedgeHop", name: "CL_LedgeHop", map: "/Game/EmberHollow/Maps/L_Ashwood", last_run: { run_id: "clip-5", passed: true, state: "finished" } },
    { path: "/Game/EmberHollow/Clips/CL_Swim", name: "CL_Swim", last_run: null },
  ] };
  if (p === "/v1/ext/studio/clips/clip") return { path: CLIP_PATH, clip: DEMO_CLIP, warnings: CLIP_WARNINGS };
  if (p === "/v1/ext/studio/clips/runs") return { runs: [] };
  return undefined;
}

/** A hub scenario that also answers the timeline's routes, with a run under way or finished (`status`) and a history. */
function clipScenario(title: string, hash: string, extra: Partial<Scenario> = {}, run?: { status: unknown; runs?: unknown[] }): Scenario {
  const s = hub(title, hash, full, extra);
  const demo = s.get!;
  return {
    ...s,
    get: (p, url) => {
      if (p === "/v1/health") return { ...(demo(p, url) as object), features: ["checkpoints", "hub", "hub.goalDelete", "events.clip", "events.clip.take"] };
      if (run && p === "/v1/ext/studio/clips/status") return run.status;
      if (run?.runs && p === "/v1/ext/studio/clips/runs") return { runs: run.runs };
      return clipRoutes(p) ?? demo(p, url);
    },
  };
}
const FAILED_RUN = {
  run_id: "clip-7", clip: CLIP_PATH, mode: "play", state: "finished", passed: false, position: 300, length: 300,
  summary: { total: 4, passed: 2, failed: 1, skipped: 1 },
  drift: { compared: true, max_position_cm: 26.9, first_over_frame: 114 },
  checks: [
    { id: "c1", status: "passed" },
    { id: "c2", status: "passed", hold: { held_ms: 420, drift_ms: 120 } },
    { id: "c3", status: "failed", evidence: { reason: "speed2d fell to 64 at frame 88, under 100" } },
    { id: "c4", status: "skipped" },
  ],
  regions: [{ id: "r1", status: "failed", drift: { max_position_cm: 4.8 } }, { id: "r2", status: "passed", drift: { max_position_cm: 26.9 } }],
};
const RUNS = [
  { ...FAILED_RUN, started_at: "2026-11-25T14:02:00Z" },
  { run_id: "clip-6", mode: "play", state: "finished", passed: true, region: "r2", started_at: "2026-11-25T13:40:00Z", summary: { total: 2, passed: 2 }, drift: { max_position_cm: 3.1 } },
  { run_id: "clip-5", mode: "record", state: "stopped", stop_reason: "Take saved", region: "r2", started_at: "2026-11-25T13:31:00Z", summary: { total: 2 } },
];
const AWAITING_RUN = { ...FAILED_RUN, state: "running", passed: undefined, position: 262, holding: "c4", awaiting: ["c4"], checks: FAILED_RUN.checks.slice(0, 3).map((c) => (c.id === "c3" ? { ...c, status: "passed", evidence: undefined } : c)), regions: [{ id: "r1", status: "passed" }] };
const RECORDING_RUN = {
  run_id: "clip-8", clip: CLIP_PATH, mode: "record", state: "running", position: 214, length: 300,
  checks: [{ id: "c1", status: "passed" }, { id: "c2", status: "passed" }], regions: [{ id: "r1", status: "passed" }],
  take: { live_take: { takeId: "t3", punchIn: 150, samples: 64, frame: 214, tracks: [
    { action: `${IA}/IA_Jump`, type: "bool", notes: [{ start: 171, length: 9 }, { start: 204, length: 10, open: true }], keys: [] },
    { action: `${IA}/IA_Move`, type: "axis2d", notes: [], keys: [{ t: 150, v: [0, 0.2] }, { t: 170, v: [0.3, 0.9] }, { t: 200, v: [-0.4, 0.6] }, { t: 214, v: [0, 1] }] },
  ] } },
};
const clipHash = `#/playtests/clips/${enc(CLIP_PATH)}`;

export const HUB_SCENARIOS: Record<string, Scenario> = {
  "hub-clips": clipScenario("Timeline clips: each clip with its newest run, and New timeline clip", "#/playtests/clips"),
  "hub-clip-edit": clipScenario("A timeline clip: regions, an axis curve and Boolean notes per Input Action, check notes in their modes, an event, and a warning with its candidates", clipHash),
  "hub-clip-note": clipScenario("A note selected on the timeline: its start and length in the inspector", clipHash, { clicks: [".hub-clip-note"] }),
  "hub-clip-check": clipScenario("A hold check selected: its mode, span and expectation in the inspector", clipHash, { clicks: [".hub-clip-check.mode-hold"] }),
  "hub-clip-run": clipScenario("A finished run on the timeline: each check and region passed or failed, region drift, why a check failed, and the run history", clipHash, {}, { status: FAILED_RUN, runs: RUNS }),
  "hub-clip-verdict": clipScenario("A run paused on a person's check: the cursor at the check and the verdict card", clipHash, {}, { status: AWAITING_RUN, runs: RUNS }),
  "hub-clip-recording": clipScenario("Recording from the hold check: armed lanes, the take's notes and keys drawn as they arrive, and Stop recording", clipHash, {}, { status: RECORDING_RUN, runs: RUNS }),
  "hub-overview": hub("Playtest Hub overview: Now running with the runs waiting and finished, scenes and tracks by status, every clip, Needs attention and what just broke", "#/playtests", full),
  "hub-overview-empty": hub("Playtest Hub overview on a project with clips and no tracks: every clip with its health, Run all and Run failing", "#/playtests", empty),
  "hub-goal": hub("A failing track: its clips with health and history, owner, priority and due date, Run track, Fix with an agent and Write clips", "#/playtests/goals/lantern-combat", full),
  "hub-goal-not-on-checkout": hub("A track with a clip that is not on this checkout: shown as such, the track in progress rather than failing", "#/playtests/goals/coop-revive", full),
  "hub-goal-milestone": hub("A scene: its tracks' statuses rolled up, with progress", "#/playtests/goals/vertical-slice", full),
  "hub-goal-delete": hub("Deleting a track: its clips stay with their past runs, and the scenes and tracks that required it are named", "#/playtests/goals/lantern-combat", full, { clicks: [".hub-delete-goal"] }),
  "hub-library": hub("The Clips screen: every clip with its health, tracks and pass rate", "#/playtests/checks", full),
  "hub-check": hub("A flaky clip: its steps, its own links and every run, newest first", `#/playtests/checks/${enc(ledge)}`, full),
  "hub-run": hub("A failed run: the step timeline, the observed values, the log and the comparison with the last pass", `#/playtests/runs/${enc(staggerRun)}`, full),
  "hub-queue": hub("The queue: a run on the editor, the runs waiting with Run next and the arrows, the schedules, one of them skipped, and the runs that finished", "#/playtests/queue", full),
  "hub-editor-offline": hub("The hub with the editor closed: Now running waits for it", "#/playtests", offline),
  "hub-draft-new": hub("New script clip: a name, the level it plays in, and a first step to fill in", "#/playtests/checks/new", full),
  "hub-draft-picker": hub("New script clip with the value picker open: the pawn's values, movement channels, actors, widgets and input actions, each with its type", "#/playtests/checks/new", full, { clicks: [".hub-draft-check .hub-draft-pick"] }),
  "hub-draft-edit": hub("Editing a saved clip: each step as a sentence, the first open with its value, operator, target and time limit", editOf(`${DEMO_SCRIPTS_DIR}/Traversal/PT_LedgeGrab`), full),
  "hub-draft-problem": hub("A step whose value the pawn does not have: the editor's finding on the value, with its candidates as one-click fixes", editOf(TYPO), typo),
  "hub-draft-manual": hub("A person step open: what a person checks, and that only a person may judge it", editOf(TYPO), typo, { clicks: [".hub-draft-step:nth-child(3) .hub-draft-step-toggle"] }),
  "hub-draft-offline": hub("The clip editor with the editor closed: the steps can still be written, and nothing is checked", "#/playtests/checks/new", offline),
};

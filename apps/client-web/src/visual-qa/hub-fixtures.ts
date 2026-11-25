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

/** A hub scenario that also answers the timeline's routes. */
function clipScenario(title: string, hash: string, extra: Partial<Scenario> = {}): Scenario {
  const s = hub(title, hash, full, extra);
  const demo = s.get!;
  return { ...s, get: (p, url) => clipRoutes(p) ?? demo(p, url) };
}
const clipHash = `#/playtests/clips/${enc(CLIP_PATH)}`;

export const HUB_SCENARIOS: Record<string, Scenario> = {
  "hub-clips": clipScenario("Timeline playtests: each clip with its newest run, and New timeline playtest", "#/playtests/clips"),
  "hub-clip-edit": clipScenario("A timeline playtest: regions, an axis curve and Boolean notes per Input Action, check notes in their modes, an event, and a warning with its candidates", clipHash),
  "hub-clip-note": clipScenario("A note selected on the timeline: its start and length in the inspector", clipHash, { clicks: [".hub-clip-note"] }),
  "hub-clip-check": clipScenario("A hold check selected: its mode, span and expectation in the inspector", clipHash, { clicks: [".hub-clip-check.mode-hold"] }),
  "hub-overview": hub("Playtest Hub overview: Now running with the runs waiting and finished, milestones and goals by status, every playtest, Needs attention and what just broke", "#/playtests", full),
  "hub-overview-empty": hub("Playtest Hub overview on a project with playtests and no goals: every playtest with its health, Run all and Run failing", "#/playtests", empty),
  "hub-goal": hub("A failing goal: its playtests with health and history, owner, priority and due date, Run goal, Fix with an agent and Write playtests", "#/playtests/goals/lantern-combat", full),
  "hub-goal-not-on-checkout": hub("A goal with a playtest that is not on this checkout: shown as such, the goal in progress rather than failing", "#/playtests/goals/coop-revive", full),
  "hub-goal-milestone": hub("A milestone: its goals' statuses rolled up, with progress", "#/playtests/goals/vertical-slice", full),
  "hub-goal-delete": hub("Deleting a goal: its playtests stay in the library with their past runs, and the milestones and goals that required it are named", "#/playtests/goals/lantern-combat", full, { clicks: [".hub-delete-goal"] }),
  "hub-library": hub("The library: every playtest with its health, goals and pass rate", "#/playtests/checks", full),
  "hub-check": hub("A flaky playtest: its steps, its own links and every run, newest first", `#/playtests/checks/${enc(ledge)}`, full),
  "hub-run": hub("A failed run: the step timeline, the observed values, the log and the comparison with the last pass", `#/playtests/runs/${enc(staggerRun)}`, full),
  "hub-queue": hub("The queue: a run on the editor, the runs waiting with Run next and the arrows, the schedules, one of them skipped, and the runs that finished", "#/playtests/queue", full),
  "hub-editor-offline": hub("The hub with the editor closed: Now running waits for it", "#/playtests", offline),
  "hub-draft-new": hub("New playtest: a name, the level it plays in, and a first step to fill in", "#/playtests/checks/new", full),
  "hub-draft-picker": hub("New playtest with the value picker open: the pawn's values, movement channels, actors, widgets and input actions, each with its type", "#/playtests/checks/new", full, { clicks: [".hub-draft-check .hub-draft-pick"] }),
  "hub-draft-edit": hub("Editing a saved playtest: each step as a sentence, the first open with its value, operator, target and time limit", editOf(`${DEMO_SCRIPTS_DIR}/Traversal/PT_LedgeGrab`), full),
  "hub-draft-problem": hub("A step whose value the pawn does not have: the editor's finding on the value, with its candidates as one-click fixes", editOf(TYPO), typo),
  "hub-draft-manual": hub("A person step open: what a person checks, and that only a person may judge it", editOf(TYPO), typo, { clicks: [".hub-draft-step:nth-child(3) .hub-draft-step-toggle"] }),
  "hub-draft-offline": hub("The playtest editor with the editor closed: the steps can still be written, and nothing is checked", "#/playtests/checks/new", offline),
};

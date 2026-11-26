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

/** A set of three tracks and three scenes, one timeline clip trimmed, a step-list playtest, a muted track and a finding. */
const SETS = "/Game/EmberHollow/Clips";
const setLayout = (id: string, kind: "clip" | "script", target: string, start: number, length: number, known = true) => ({
  id, kind, target, name: target.split("/").pop()!, start, end: start + length, length, known, ...(kind === "clip" && known ? { clipRate: 60, clipLength: length + 60 } : {}),
});
const DEMO_SET = {
  rate: 60,
  text: "",
  findings: [{ id: "guard/i1", field: "target", message: "No timeline clip at /Game/EmberHollow/Clips/CL_Patrl.", candidates: [`${SETS}/CL_Patrol`], blocks: false }],
  tracks: [
    { id: "hero", title: "Hero", order: 0, color: "green", player: 0, mute: false, solo: false, status: "failing",
      arrangement: { rate: 60, instances: [{ id: "i1", kind: "clip", target: CLIP_PATH, start: 0, out: 240 }, { id: "i2", kind: "script", target: `${DEMO_SCRIPTS_DIR}/Traversal/PT_LedgeGrab`, start: 300, length: 600 }, { id: "i3", kind: "clip", target: `${SETS}/CL_LedgeHop`, start: 960, color: "cyan" }] },
      layout: [setLayout("i1", "clip", CLIP_PATH, 0, 240), setLayout("i2", "script", `${DEMO_SCRIPTS_DIR}/Traversal/PT_LedgeGrab`, 300, 600), setLayout("i3", "clip", `${SETS}/CL_LedgeHop`, 960, 180)] },
    { id: "guard", title: "Guard", order: 1, color: "red", player: 1, mute: false, solo: false, status: "not_started",
      arrangement: { rate: 60, instances: [{ id: "i1", kind: "clip", target: `${SETS}/CL_Patrl`, start: 120 }] },
      layout: [setLayout("i1", "clip", `${SETS}/CL_Patrl`, 120, 600, false)] },
    { id: "camera", title: "Camera", order: 2, color: "gray", player: 0, mute: true, solo: false, status: "not_started", arrangement: { rate: 60, instances: [] }, layout: [] },
  ],
  scenes: [
    { id: "door", title: "Door opens", order: 0, color: "orange", status: "failing", tracks: ["hero", "guard"] },
    { id: "ledge", title: "Ledge run", order: 1, color: "blue", status: "passing", tracks: ["hero"] },
    { id: "swim", title: "Swim", order: 2, status: "not_started", tracks: [] },
  ],
};
const SET_CLIPS = { clips: [
  { kind: "clip", target: CLIP_PATH, name: "CL_DoorOpens", length: 300, rate: 60, lastRun: { runId: "clip-7", outcome: "failed", at: "2026-11-25T14:02:00Z" } },
  { kind: "clip", target: `${SETS}/CL_LedgeHop`, name: "CL_LedgeHop", length: 180, rate: 60, lastRun: { runId: "clip-5", outcome: "passed", at: "2026-11-25T13:31:00Z" } },
  { kind: "clip", target: `${SETS}/CL_Patrol`, name: "CL_Patrol", length: 600, rate: 60, lastRun: null },
  { kind: "script", target: `${DEMO_SCRIPTS_DIR}/Traversal/PT_LedgeGrab`, name: "PT_LedgeGrab", length: 540, rate: 60, lastRun: { runId: "r-1", outcome: "passed", at: "2026-11-25T12:00:00Z" } },
] };
const setInstance = (goalId: string, id: string, name: string, start: number, end: number, status: string) => ({
  key: `${goalId}-${id}`, goalId, id, kind: "clip", target: "", name, player: goalId === "guard" ? 1 : 0, start, end, status, checks: { total: 2, passed: status === "passed" ? 2 : 0, failed: status === "failed" ? 1 : 0, pending: 0, awaiting: 0 }, segmentRunId: "seg-1",
});
/** The Arrangement playing: Hero's first clip passed, the step list playing, the playhead inside it. */
const SET_RUN = {
  kind: "arrangement", rate: 60, length: 1140,
  tracks: [{ goalId: "hero", title: "Hero", player: 0, status: "running" }, { goalId: "guard", title: "Guard", player: 1, status: "failed" }],
  instances: [setInstance("hero", "i1", "CL_DoorOpens", 0, 240, "passed"), setInstance("hero", "i2", "PT_LedgeGrab", 300, 900, "running"), setInstance("hero", "i3", "CL_LedgeHop", 960, 1140, "pending"), setInstance("guard", "i1", "CL_Patrl", 120, 720, "failed")],
  segments: [{ index: 0, kind: "clip", runId: "seg-1", offset: 0, length: 300, state: "finished" }, { index: 1, kind: "script", runId: "seg-2", offset: 300, length: 600, state: "running" }],
};
/** The same run held at a manual step in the script clip, waiting for a verdict. */
const SET_RUN_WAITING = {
  ...SET_RUN,
  instances: SET_RUN.instances.map((i) => (i.id === "i2" && i.goalId === "hero" ? { ...i, status: "awaiting_verdict", awaiting: [{ check: "2", instruction: "Does Mara grab the ledge and pull herself up without clipping through the wall?" }] } : i)),
};

/** A set with many tracks, each a few clips long, for density and scrolling. */
const BUSY_SET = {
  ...DEMO_SET,
  findings: [...DEMO_SET.findings, { id: "camera", field: "player", message: "Client 4 is not connected.", blocks: false }, { id: "door", field: "tracks", message: "Door opens plays no track that has clips.", blocks: false }],
  tracks: [
    ...DEMO_SET.tracks.slice(0, 2),
    { ...DEMO_SET.tracks[2], player: 4, mute: false },
    ...["Boss phase two with the long name", "Lantern", "Swim", "Crowd", "Doors", "Weather", "Music cues"].map((title, n) => {
      const id = `t${n}`;
      const len = 180 + n * 60;
      const items = [0, 1, 2].map((k) => ({ id: `i${k}`, start: 120 + k * (len + 240) + n * 30 }));
      const colors = ["orange", "blue", "teal", "violet", "yellow", "pink", "lime"];
      return {
        id, title, order: 3 + n, color: colors[n], player: n % 3, mute: n === 4, solo: n === 1, status: "not_started",
        arrangement: { rate: 60, instances: items.map((i) => ({ id: i.id, kind: "clip", target: `${SETS}/CL_${title.split(" ")[0]}${i.id}`, start: i.start })) },
        layout: items.map((i, k) => setLayout(i.id, k === 1 ? "script" : "clip", `${SETS}/CL_${title.split(" ")[0]}_${k + 1}`, i.start, len)),
      };
    }),
  ],
};
const EMPTY_SET = { ...DEMO_SET, findings: [], tracks: [] };

/** A hub scenario on the set's routes, with the Arrangement playing `run` when given. */
function setScenario(title: string, hash: string, extra: Partial<Scenario> = {}, run: object | null = null, setData: object = DEMO_SET): Scenario {
  const playing = run !== null;
  const s = hub(title, hash, full, extra);
  const demo = s.get!;
  return {
    ...s,
    get: (p, url) => {
      if (p === "/v1/health") return { ...(demo(p, url) as object), features: ["checkpoints", "hub", "hub.goalDelete", "hub.arrangement", "events.clip"] };
      if (p === "/v1/hub/set") return setData;
      if (p === "/v1/hub/clips") return SET_CLIPS;
      if (playing && p.startsWith("/v1/hub/runs/run-set")) return { record: {}, run: null, steps: [], arrangement: run };
      const a = demo(p, url);
      if (playing && p === "/v1/hub" && a) {
        const o = a as { queue: Record<string, unknown> };
        return { ...o, queue: { ...o.queue, current: { id: "plan-set", title: "Arrangement", scope: { kind: "arrangement" }, options: {}, state: "running", trigger: "person", createdAt: "2026-11-25T14:00:00Z", items: [{ check: { kind: "arrangement", target: "arrangement" }, name: "Arrangement", state: "running", runId: "run-set" }] } } };
      }
      return a;
    },
  };
}

/** A project with named arrangements: the story pass beside a boss rush and a night pass, each with its own tracks and level. */
const ARRANGEMENTS = {
  default: "main",
  arrangements: [
    { id: "main", title: "Story", order: 0, level: "/Game/EmberHollow/Maps/L_Hollow", tracks: 4, scenes: 2, status: "failing", lastRun: { runId: "run-set", outcome: "failed", at: new Date(Date.now() - 40 * 60_000).toISOString() } },
    { id: "boss-rush-k3f9", title: "Boss rush", order: 1, level: "/Game/EmberHollow/Maps/L_Arena", tracks: 3, scenes: 1, status: "met", lastRun: { runId: "run-boss", outcome: "passed", at: new Date(Date.now() - 3 * 3_600_000).toISOString() } },
    { id: "night-pass-a1b2", title: "Night pass with every lantern lit and the fog turned up", order: 2, level: null, tracks: 1, scenes: 0, status: "not_started", lastRun: null },
  ],
};

/** The Arrangement on a daemon whose projects hold named arrangements: the switcher in the transport, and the list. */
function arrangementsScenario(title: string, hash: string, extra: Partial<Scenario> = {}): Scenario {
  const s = setScenario(title, hash, extra);
  const base = s.get!;
  return {
    ...s,
    get: (p, url) => {
      if (p === "/v1/health") return { ...(base(p, url) as { features: string[] }), features: ["checkpoints", "hub", "hub.goalDelete", "hub.arrangement", "hub.arrangements", "events.clip"] };
      if (p === "/v1/hub/arrangements") return ARRANGEMENTS;
      if (p === "/v1/hub/set") return { ...DEMO_SET, arrangement: { id: "main", title: "Story", order: 0, level: "/Game/EmberHollow/Maps/L_Hollow" } };
      return base(p, url);
    },
  };
}

/** A set whose tracks drive actors as well as players: a wolf on patrol, the north gate, and a lane the gate does not take. */
const ACTOR_SET = {
  ...DEMO_SET,
  findings: [{ id: "gate/i1", field: "performer", message: "BP_Gate_North takes move, action and value lanes, and the clip has an Input Action lane for IA_Interact", candidates: ["move", "action", "value"], blocks: true }],
  tracks: [
    { ...DEMO_SET.tracks[0], performer: { kind: "player", client: 0 } },
    { id: "wolf", title: "Wolf patrol", order: 1, color: "violet", player: 0, performer: { kind: "actor", actor: "Wolf_Alpha" }, mute: false, solo: false, status: "passing",
      arrangement: { rate: 60, instances: [{ id: "i1", kind: "clip", target: `${SETS}/CL_WolfPatrol`, start: 60 }, { id: "i2", kind: "clip", target: `${SETS}/CL_WolfPatrol`, start: 600 }] },
      layout: [setLayout("i1", "clip", `${SETS}/CL_WolfPatrol`, 60, 360), setLayout("i2", "clip", `${SETS}/CL_WolfPatrol`, 600, 360)] },
    { id: "gate", title: "North gate", order: 2, color: "teal", player: 0, performer: { kind: "actor", actor: "BP_Gate_North" }, mute: false, solo: false, status: "not_started",
      arrangement: { rate: 60, instances: [{ id: "i1", kind: "clip", target: `${SETS}/CL_GateOpens`, start: 180 }] },
      layout: [setLayout("i1", "clip", `${SETS}/CL_GateOpens`, 180, 240)] },
    { ...DEMO_SET.tracks[1], player: 1, performer: { kind: "player", client: 1 }, order: 3 },
  ],
};
const PERFORMERS = {
  level: "/Game/EmberHollow/Maps/L_Ashwood",
  performers: [
    ...[0, 1, 2, 3].map((client) => ({ performer: { kind: "player", client }, label: client ? `Client ${client}` : "Editor player", capabilities: ["input", "action", "value"] })),
    ...[
      ["Wolf_Alpha", "BP_Wolf_C", true],
      ["Wolf_Beta", "BP_Wolf_C", true],
      ["Mara_Companion", "BP_Companion_C", true],
      ["BP_Gate_North", "BP_Gate_C", false],
      ["Lantern_03", "BP_Lantern_C", false],
    ].map(([actor, className, pawn]) => ({ performer: { kind: "actor", actor }, label: actor, className, pawn, capabilities: ["move", "action", "value"] })),
  ],
};
const PERFORMER_FEATURES = ["checkpoints", "hub", "hub.goalDelete", "hub.arrangement", "hub.performers", "events.clip", "events.clip.take"];

/** The Arrangement on a daemon whose tracks drive performers, with the open level's actors to pick from. */
function performerScenario(title: string, hash: string, extra: Partial<Scenario> = {}): Scenario {
  const s = setScenario(title, hash, extra, null, ACTOR_SET);
  const base = s.get!;
  return {
    ...s,
    get: (p, url) => {
      if (p === "/v1/health") return { ...(base(p, url) as object), features: PERFORMER_FEATURES };
      if (p === "/v1/hub/performers") return PERFORMERS;
      return base(p, url);
    },
  };
}

/** A wolf's patrol: walk to three points, the gate opened and locked by its own lane, and the wolf's alert level and sprint over time. */
const LANE_CLIP_PATH = `${SETS}/CL_WolfPatrol`;
const LANE_CLIP: Clip = {
  rate: 60,
  length: 360,
  grid: "frame",
  performer: { kind: "actor", actor: "Wolf_Alpha" },
  regions: [{ id: "r1", name: "Patrol to the gate", start: 0, end: 200 }, { id: "r2", name: "Alert", start: 200, end: 360 }],
  tracks: [],
  lanes: [
    { id: "L1", kind: "move", points: [{ id: "p1", t: 0, at: [1200, -340, 92] }, { id: "p2", t: 90, at: [1480, -340, 92], radius: 40 }, { id: "p3", t: 210, at: [1480, 120, 92] }] },
    { id: "L2", kind: "action", performer: { kind: "actor", actor: "BP_Gate_North" }, calls: [{ id: "a1", t: 150, fn: "OpenGate" }, { id: "a2", t: 300, fn: "Lock.Engage", args: [true] }], watch: ["bOpen"] },
    { id: "L3", kind: "value", target: "bb:AlertLevel", type: "axis1d", keys: [{ id: "v1", t: 0, v: 0 }, { id: "v2", t: 200, v: 0.2 }, { id: "v3", t: 260, v: 1, interp: "constant" }] },
    { id: "L4", kind: "value", target: "bIsSprinting", type: "bool", keys: [{ id: "v4", t: 0, v: false }, { id: "v5", t: 240, v: true }] },
  ],
  events: [],
  checks: [{ id: "c1", start: 200, length: 0, mode: "hold", expect: { value: "BP_Gate_North.bOpen", op: "eq", target: true } }],
};

/** The piano roll on a clip with move, action and value lanes. */
function laneScenario(title: string, extra: Partial<Scenario> = {}): Scenario {
  const s = clipScenario(title, `#/playtests/clips/${enc(LANE_CLIP_PATH)}`, extra);
  const base = s.get!;
  return {
    ...s,
    get: (p, url) => {
      if (p === "/v1/health") return { ...(base(p, url) as object), features: PERFORMER_FEATURES };
      if (p === "/v1/hub/performers") return PERFORMERS;
      if (p === "/v1/ext/studio/clips/clip") return { path: LANE_CLIP_PATH, clip: LANE_CLIP, warnings: [] };
      return base(p, url);
    },
  };
}

export const HUB_SCENARIOS: Record<string, Scenario> = {
  "hub-arrangement-actor": performerScenario("Tracks that drive actors: each header shows its performer, P and the player or A and the actor, a wolf's patrol and the north gate beside the players, and a lane the gate does not take flagged on its clip", "#/playtests/arrangement"),
  "hub-arrangement-performer-picker": performerScenario("A track's performer picker open: the players, then the open level's actors with their classes, pawns first", "#/playtests/arrangement", { clicks: ["[data-track=wolf] .hub-set-performer"] }),
  "hub-clip-lanes": laneScenario("A clip with actor lanes: points the wolf walks to with their coordinates, the gate's calls by function, a number curve and a Boolean curve, each lane naming its performer"),
  "hub-clip-lane-point": laneScenario("A move lane's point selected: its frame, coordinates and arrival radius in the inspector", { clicks: [".hub-clip-point:nth-of-type(2)"] }),
  "hub-clip-lane-header": laneScenario("A lane selected from its header: its performer, target and type, and a lane of a kind its performer takes to add", { clicks: ["[data-lane=L3] .hub-clip-track-name"] }),
  "hub-arrangements": arrangementsScenario("A project's arrangements: each with its status, track and scene counts, the level it opens and its last run, with Rename, Level, Duplicate and Delete, and New arrangement", "#/playtests/arrangements"),
  "hub-arrangements-new": arrangementsScenario("New arrangement: its name and the level its runs open", "#/playtests/arrangements", { clicks: [".hub-head-actions .primary"] }),
  "hub-arrangement-switcher": arrangementsScenario("The Arrangement's switcher open in the transport: the arrangement shown, the others with their counts, and All arrangements", "#/playtests/arrangement", { clicks: [".hub-set-switch"] }),
  "hub-arrangement": setScenario("Arrangement: the transport, each track's timeline under one ruler with a 150px header (the name on one line, Play, M, S and the player as Ed or C1 on the next), a trimmed clip, a step-list clip's reserved space, a clip of unknown length with its warning marker, a muted track, empty rows to six, and the warnings count", "#/playtests/arrangement"),
  "hub-arrangement-instance": setScenario("A clip selected on a timeline: the footer inspector with its name, color, Open clip, Duplicate, Make unique and Delete", "#/playtests/arrangement", { clicks: [".hub-set-block.kind-clip"] }),
  "hub-arrangement-track": setScenario("A track selected: its header lit, and its name, color, order and Delete in the footer inspector", "#/playtests/arrangement", { clicks: [".hub-set-head .hub-set-title"] }),
  "hub-arrangement-playing": setScenario("The Arrangement playing: the run's playhead, results on each block, Stop, and per-track status", "#/playtests/arrangement", {}, SET_RUN),
  "hub-arrangement-verdict": setScenario("The Arrangement held at a manual step: the one-line verdict strip with the step's question", "#/playtests/arrangement", {}, SET_RUN_WAITING),
  "hub-arrangement-clips": setScenario("The Clips drawer open in the footer: search, kind, the clips with Add and Open, and the hint", "#/playtests/arrangement", { clicks: [".hub-set-drawer-toggle"] }),
  "hub-arrangement-replace": setScenario("A clip picked in Clips and a clip selected on a timeline: Replace with the picked clip", "#/playtests/arrangement", { clicks: [".hub-set-drawer-toggle", ".hub-set-clips li:nth-child(3) .hub-set-clip", ".hub-set-block.kind-clip"] }),
  "hub-arrangement-warnings": setScenario("The warnings list open from its count: each warning with its fix and Show", "#/playtests/arrangement", { clicks: [".hub-set-warnings"] }),
  "hub-arrangement-loop": setScenario("Loop turned on with a clip selected: the loop brace on the ruler and the range shaded", "#/playtests/arrangement", { clicks: [".hub-set-block.kind-clip", ".hub-set-transport-btn[aria-pressed]"] }),
  "hub-arrangement-keys": setScenario("The Arrangement's shortcuts, opened from the keyboard button", "#/playtests/arrangement", { clicks: [".hub-set-pop-anchor > .icon-button"] }),
  "hub-arrangement-busy": setScenario("Ten tracks in 150px headers: long names cut short with an ellipsis, short player labels (Ed, C1, C4), a warning on a track header, and the timelines scrolling under the sticky ruler and headers", "#/playtests/arrangement", {}, null, BUSY_SET),
  "hub-arrangement-empty": setScenario("An empty Arrangement: six empty rows with Drop clips here, and Add track above the header column", "#/playtests/arrangement", {}, null, EMPTY_SET),
  "hub-arrangement-window": setScenario("In Studio's own window: the button that opens Clips in a window of its own", "#/playtests/arrangement", { studioWindow: true }),
  "hub-arrangement-clips-window": setScenario("The Clips window popped out of the Arrangement, before the Arrangement answers", "#/clips-window", { height: 760 }),
  "hub-arrangement-delete": setScenario("Deleting a track: the confirmation naming the scenes that stop playing it", "#/playtests/arrangement", { clicks: [".hub-set-head .hub-set-title", ".hub-set-inspector > button:last-of-type"] }),
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

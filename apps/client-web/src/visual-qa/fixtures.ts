/**
 * Playtest states for the visual QA harness (visual-qa.html): each scenario is
 * what the daemon would answer for one open session or the Playtests page.
 * The runs are built with the same shared helpers the agent uses, so the UI
 * draws them exactly as it would draw a live run in that state.
 */
import {
  qaActive,
  qaDraftFromScript,
  qaNeedsYou,
  qaRunFromAnswer,
  mentionToken,
  rankMentions,
  type CustomEndpoint,
  type MentionMatch,
  type MentionSearchResponse,
  type PlaytestEntry,
  type PlaytestIndexAnswer,
  type QaLoop,
  type QaRun,
  type SessionDetail,
  type SessionSummary,
  type StudioSettings,
  type TranscriptEntry,
} from "@ue-mcp-studio/shared";

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const SCRIPTS = "/Game/PIEStudio/Scripts";

/** Steps as a PIE test script has them: an auto check or a person's judgement. */
const STEPS: Array<{ instruction: string; judge: "auto" | "manual"; expect?: { value: string; op: string; target?: number } }> = [
  { instruction: "Press jump and the character leaves the ground", judge: "auto", expect: { value: "JumpCurrentCount", op: "gt", target: 0 } },
  { instruction: "The jump arc looks right and lands cleanly", judge: "manual" },
  { instruction: "Walk into the door trigger and the door opens", judge: "auto", expect: { value: "BP_Door.OpenAngle", op: "gt", target: 80 } },
  { instruction: "The door opens without a visible pop", judge: "manual" },
  { instruction: "Sprint speed stays above 600 while running", judge: "auto", expect: { value: "CharacterMovement.Velocity.Size", op: "gt", target: 600 } },
];

export function run(id: string, name: string, state: string, statuses: string[], over: Partial<QaRun> = {}): QaRun {
  const r = qaRunFromAnswer({
    success: true,
    run_id: id,
    script: `${SCRIPTS}/${name}`,
    script_name: name,
    state,
    results_path: `C:/Projects/StudioE2E/Saved/MCPObservations/${id}/results.json`,
    steps: statuses.map((status, index) => {
      const s = STEPS[index % STEPS.length];
      return {
        index,
        ...s,
        status,
        ...(s.judge === "auto" && status === "failed" ? { evidence: { value: s.expect?.value, at_start: 0, at_end: 0, samples: 120, observed: true, reason: "The value never changed in the window" } } : {}),
        ...(s.judge === "manual" && status === "failed" ? { note: index === 1 ? "The landing clips through the ledge" : "The door snaps open on the first frame", verdict_source: "action" } : {}),
      };
    }),
    awaiting: statuses.flatMap((s, i) => (s === "awaiting_verdict" ? [i] : [])),
    last_seq: 4,
  }, { sessionId: "qa-session", seenAt: ago(4) })!;
  return { ...r, ...over };
}

function loop(state: QaLoop["state"]): QaLoop {
  const first = { n: 1, callId: "agent-1", before: "cp-0", after: "cp-1", changes: [{ path: "Content/Blueprints/BP_Door.uasset", status: "modified" as const }], failing: ["Step 3: the door never opened"], startedAt: ago(9), endedAt: ago(6) };
  const second = { n: 2, callId: "agent-2", before: "cp-1", ...(state === "running" ? {} : { after: "cp-2", endedAt: ago(2) }), changes: [], failing: state === "running" ? [] : ["Step 3: the door never opened"], startedAt: ago(5) };
  return {
    id: `loop-${state}`,
    state,
    attempts: [first, second],
    baseline: "cp-0",
    startedAt: ago(9),
    ...(state === "needs_you" ? { endedAt: ago(2), blocker: { kind: "no_progress" as const, reason: "Two attempts changed nothing about step 3: the door trigger never fires in PIE.", evidence: ["Step 3: the door never opened"], step: 2 } } : {}),
  };
}

const assigned = (state: QaLoop["state"]) => ({ callId: "agent-2", sessionId: "qa-session", state: state === "running" ? "running" as const : "done" as const, at: ago(9), loop: loop(state) });

/** A draft whose steps name assets the ways a model writes them: a markdown link, a code span, a bare path, a bare name, and arrange and act targets. */
const LINKED_STEPS = [
  { instruction: "Load [L_WG_Meadow](/Game/Maps/L_WG_Meadow) and walk up to BP_Obstacle_BrokenBridge", judge: "manual" as const },
  { instruction: "Press `IA_Jump` at the gap past /Game/Props/SM_PlankWorn.SM_PlankWorn; BP_NotInThisProject stays plain", judge: "manual" as const,
    arrange: [{ kind: "spawn", class: "/Game/AI/BP_Wolf.BP_Wolf_C" }, { kind: "set", target: "BridgeGate", path: "bLocked", value: false }],
    act: [{ place: { at: "BridgeGate", offset: [-150, 0, 0] } }, { press: { action: "/Game/Input/IA_Jump.IA_Jump" } }] },
  { instruction: "The character lands on the far side", judge: "auto" as const, expect: { value: "CharacterMovement.MovementMode", op: "eq", target: 1 } },
];

/** What the agent answers for the names and paths in LINKED_STEPS. */
const LINKED_ASSETS: Record<string, string> = {
  BP_Obstacle_BrokenBridge: "/Game/Obstacles/BP_Obstacle_BrokenBridge.BP_Obstacle_BrokenBridge",
  IA_Jump: "/Game/Input/IA_Jump.IA_Jump",
  "/Game/Props/SM_PlankWorn.SM_PlankWorn": "/Game/Props/SM_PlankWorn.SM_PlankWorn",
};
const resolveLinked = (path: string, body: unknown) => {
  if (path !== "/v1/ext/studio/assets/resolve") return undefined;
  const refs = ((body as { refs?: Array<{ token: string }> } | undefined)?.refs ?? []);
  return { status: 200, body: { results: refs.map((r) => (LINKED_ASSETS[r.token] ? { status: "resolved", paths: [LINKED_ASSETS[r.token]] } : { status: "unresolved" })) } };
};

export const RUNS = {
  linked: { ...qaDraftFromScript({ path: `${SCRIPTS}/TS_Playtest_BP_Obstacle_BrokenBridge`, name: "TS_Playtest_BP_Obstacle_BrokenBridge", map: "/Game/Maps/L_WG_Meadow", steps: LINKED_STEPS }, { sessionId: "qa-session", seenAt: ago(6) })! },
  draft:{ ...qaDraftFromScript({ path: `${SCRIPTS}/PT_DoorOpens`, name: "PT_DoorOpens", steps: STEPS }, { sessionId: "qa-session", seenAt: ago(6) })! },
  armed: run("script_PT_DoorOpens_armed", "PT_DoorOpens", "armed", ["pending", "pending", "pending", "pending", "pending"]),
  running: run("script_PT_JumpCheck_running", "PT_JumpCheck", "running", ["passed", "running", "pending", "pending", "pending"]),
  waiting: run("script_PT_DoorOpens_waiting", "PT_DoorOpens", "awaiting_verdict", ["passed", "passed", "passed", "awaiting_verdict", "pending"]),
  failed: run("script_PT_LandingCheck_done", "PT_LandingCheck", "finished", ["passed", "failed", "passed", "failed", "skipped"]),
  stopped: run("script_PT_Sprint_stopped", "PT_Sprint", "stopped", ["passed", "passed", "pending", "pending", "pending"]),
  loopRunning: run("script_PT_LedgeGrab_loop", "PT_LedgeGrab", "running", ["passed", "passed", "running", "pending", "pending"], { assignment: assigned("running") }),
  judged: (() => {
    const r = run("script_PT_DoorLooks_unreadable-1", "PT_DoorLooks", "finished", ["passed", "passed", "passed", "passed", "passed"]);
    return { ...r, steps: r.steps.map((s) => (s.index === 3 ? { ...s, verdictSource: "agent" as const, note: "The door swings over 9 frames with no pop.", evidence: { note: "The door swings over 9 frames with no pop.", captures: ["C:/Projects/StudioE2E/Saved/Screenshots/door_open_01.png", "C:/Projects/StudioE2E/Saved/Screenshots/door_open_02_unreadable.png"] } } : s)) };
  })(),
  loopNeedsYou: run("script_PT_GateTrigger_blocked", "PT_GateTrigger", "finished", ["passed", "passed", "failed", "skipped", "passed"], { assignment: assigned("needs_you") }),
};

const SESSION_ID = "qa-session";
const summary = (title: string, minutes: number): SessionSummary => ({
  id: SESSION_ID,
  title,
  status: "idle",
  createdAt: ago(minutes + 20),
  updatedAt: ago(minutes),
  waitingCause: null,
  archived: false,
  agents: { total: 0, running: 0 },
  awaiting: 0,
});

/** A conversation that leads up to the playtests it holds. */
function transcript(runs: QaRun[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [
    { kind: "user", text: "Make a playtest for L_Playtest: jump, walk into the door trigger and sprint, and let me judge how the jump and the door look.", at: ago(12) },
  ];
  if (runs.length === 0) {
    entries.push({ kind: "assistant", text: "Which level should it run in? L_Playtest is open now.", at: ago(11) });
    return entries;
  }
  entries.push({ kind: "assistant", text: "I saved it as a script. The observer checks the jump, the door angle and the sprint speed; you judge the jump arc and how the door opens.", at: ago(11) });
  for (const r of runs) entries.push({ kind: "qa", run: r });
  const text = runs.some(qaNeedsYou) ? "It needs you now: the card below has what it is waiting on."
    : runs.every((r) => r.state === "armed") ? "It is starting. I will read the results when it ends."
    : runs.some(qaActive) ? "It is running. I will read the results when it ends."
    : runs.some((r) => r.state === "finished" || r.state === "stopped") ? "The run ended; its card has each step's result."
    : "It is ready. Press Start playtest on its card to run it.";
  entries.push({ kind: "assistant", text, at: ago(3) });
  return entries;
}

function detail(title: string, runs: QaRun[]): SessionDetail {
  return { ...summary(title, 3), transcript: transcript(runs), touched: [], draft: "", seen: [], dismissed: [], queue: [], error: null, approvals: [], review: null, timeline: [] };
}

const entry = (r: QaRun | null, over: Partial<PlaytestEntry> & { script: string; name: string }): PlaytestEntry =>
  ({ last: r, card: r?.sessionId ? r : null, draft: null, session: r?.sessionId ? { id: SESSION_ID, title: "Door playtest" } : null, ...over });

const PROJECT: PlaytestEntry[] = [
  entry(RUNS.waiting, { script: RUNS.waiting.script, name: "PT_DoorOpens" }),
  entry(RUNS.loopNeedsYou, { script: RUNS.loopNeedsYou.script, name: "PT_GateTrigger", session: { id: SESSION_ID, title: "Fix the gate trigger so the playtest passes on every attempt" } }),
  entry(RUNS.running, { script: RUNS.running.script, name: "PT_JumpCheck", session: { id: "s-jump", title: "Jump feel" } }),
  entry({ ...RUNS.failed, sessionId: null, seenAt: ago(130) }, { script: RUNS.failed.script, name: "PT_LandingCheck" }),
  entry({ ...run("script_PT_Walk_done", "PT_Walk", "finished", ["passed", "passed", "passed"]), seenAt: ago(60 * 26) }, { script: `${SCRIPTS}/PT_Walk`, name: "PT_Walk", session: { id: "s-walk", title: "Walking" } }),
  { script: `${SCRIPTS}/PT_Crouch`, name: "PT_Crouch", last: null, card: null, draft: { ...qaDraftFromScript({ path: `${SCRIPTS}/PT_Crouch`, name: "PT_Crouch", steps: STEPS.slice(0, 3) }, { seenAt: ago(1) })! }, session: null },
];

export interface Scenario {
  /** What the shot shows, for the index. */
  title: string;
  hash: string;
  session?: SessionDetail;
  index: PlaytestIndexAnswer;
  /** The Playtests page's filter, as the viewer last picked it. */
  filter?: "needs-you" | "failing" | "all";
  /** Clicked after the page settles: a CSS selector. */
  click?: string;
  /** Focused from the keyboard after the page settles, to show the focus ring: a CSS selector. */
  focus?: string;
  /** A line that arrives after the reader has scrolled the conversation up: the session is read again with it. */
  arrives?: TranscriptEntry;
  /** Clicked one after another after the page settles, each a CSS selector; after click, when both are given. */
  clicks?: string[];
  /** Scrolled to the top of its scroller after the clicks, to show what lies below the fold: a CSS selector. */
  scroll?: string;
  /** The window's height for the shot, for a page taller than the default 860 pixels. */
  height?: number;
  /** Settings the scenario changes from the harness's own. */
  settings?: Partial<StudioSettings>;
  /** GETs answered 404, as an agent or daemon from before the route answers them. */
  missing?: string[];
  /** GETs the scenario answers itself, before the harness's defaults; undefined falls through. */
  get?: (path: string, url: URL) => unknown;
  /** Writes the scenario answers itself, with their status; undefined is the harness's 409. */
  post?: (path: string, body?: unknown) => { status: number; body: unknown } | undefined;
  /** Typed from the keyboard into an element after the page settles: a CSS selector and the keys. */
  type?: { into: string; text: string };
  /** The custom endpoints Models & accounts lists; "error" answers their route with a failure. */
  endpoints?: CustomEndpoint[] | "error";
  /** Shoot the whole page, for a settings section taller than the window. */
  fullPage?: boolean;
}

const ENDPOINTS: CustomEndpoint[] = [
  {
    id: "local-ollama",
    name: "Local Ollama",
    baseUrl: "http://localhost:11434/v1",
    hasKey: false,
    models: [
      { id: "qwen3-coder:30b" },
      { id: "llama-3.3-70b-instruct" },
      { id: "my-finetune", typed: true },
    ],
    listedAt: ago(5),
    listError: null,
  },
  {
    id: "team-vllm",
    name: "Team vLLM",
    baseUrl: "https://llm.internal.example.com/v1",
    hasKey: true,
    models: [{ id: "deepseek-v4", typed: true }],
    listedAt: ago(2),
    listError: "its /models answered 401",
  },
];

/** What a mention search finds in the door project. */
const MENTIONS: MentionMatch[] = [
  { kind: "asset", name: "BP_Door", type: "Blueprint", path: "/Game/Props/Doors/BP_Door.BP_Door", target: "/Game/Props/Doors/BP_Door.BP_Door" },
  { kind: "asset", name: "SM_Door", type: "StaticMesh", path: "/Game/Props/Doors/Meshes/SM_Door.SM_Door", target: "/Game/Props/Doors/Meshes/SM_Door.SM_Door" },
  { kind: "asset", name: "M_DoorWood_Weathered", type: "MaterialInstanceConstant", path: "/Game/Props/Doors/Materials/Instances/M_DoorWood_Weathered.M_DoorWood_Weathered", target: "/Game/Props/Doors/Materials/Instances/M_DoorWood_Weathered.M_DoorWood_Weathered" },
  { kind: "actor", name: "Front Door", type: "StaticMeshActor", path: "/Game/Maps/Cave.Cave:PersistentLevel.StaticMeshActor_12", target: "actor:/Game/Maps/Cave.Cave:PersistentLevel.StaticMeshActor_12" },
  { kind: "file", name: "DoorComponent.cpp", type: "C++ source", path: "Source/StudioE2E/Doors/DoorComponent.cpp", target: "file:Source/StudioE2E/Doors/DoorComponent.cpp" },
  { kind: "actor", name: "PlayerStart", type: "PlayerStart", path: "/Game/Maps/Cave.Cave:PersistentLevel.PlayerStart_0", target: "actor:/Game/Maps/Cave.Cave:PersistentLevel.PlayerStart_0" },
  { kind: "file", name: "DoorComponent.h", type: "C++ header", path: "Source/StudioE2E/Doors/DoorComponent.h", target: "file:Source/StudioE2E/Doors/DoorComponent.h" },
];

/** A session whose composer has `text` typed into it, the mention search answered from MENTIONS. */
function mentionScenario(title: string, text: string, sources: MentionSearchResponse["sources"] = { asset: "editor", actor: "editor", file: "disk" }): Scenario {
  const s = inSession(title, "Door playtest", []);
  return {
    ...s,
    session: { ...s.session!, draft: "Put a light over " },
    type: { into: ".composer textarea:not(.composer-mirror)", text },
    post: (path, body) => {
      if (path !== "/v1/ext/studio/mentions/search") return undefined;
      const b = body as { query: string; kinds?: MentionMatch["kind"][] };
      const pool = MENTIONS.filter((m) => (!b.kinds || b.kinds.includes(m.kind)) && sources[m.kind] !== "unavailable");
      return { status: 200, body: { query: b.query, results: rankMentions(b.query, pool), sources: Object.fromEntries(Object.entries(sources).filter(([k]) => !b.kinds || b.kinds.includes(k as MentionMatch["kind"]))) } };
    },
  };
}

const inSession = (title: string, sessionTitle: string, runs: QaRun[], click?: string, focus?: string): Scenario =>
  ({ title, hash: `#/chat/${SESSION_ID}`, session: detail(sessionTitle, runs), index: { playtests: PROJECT, listed: true }, ...(click ? { click } : {}), ...(focus ? { focus } : {}) });

/** A session whose main agent started two subagents, both running: the thread list with each agent's tokens. */
function withAgents(): SessionDetail {
  const d = detail("Dress the cave", []);
  const call = (id: string, description: string, outcome: "pending" | "done", minutes: number): TranscriptEntry =>
    ({ kind: "tool", call: { id, name: "agent", input: { description, prompt: description }, outcome, startedAt: ago(minutes), ...(outcome === "done" ? { endedAt: ago(1), result: "Done." } : {}) } });
  const step = (id: string, parent: string, method: string, minutes: number): TranscriptEntry =>
    ({ kind: "tool", call: { id, name: "ue_mcp", input: { action: "call", category: "level", method }, outcome: "done", startedAt: ago(minutes), endedAt: ago(minutes), result: "{}" }, parent });
  return {
    ...d,
    status: "running",
    transcript: [
      { kind: "user", text: "Dress the cave with rocks and fog, and check the lighting.", at: ago(8) },
      call("agent-rocks", "Place rocks along the cave floor", "pending", 6),
      step("rocks-1", "agent-rocks", "spawn_actor", 5),
      call("agent-light", "Check the cave lighting", "pending", 6),
      step("light-1", "agent-light", "get_outliner", 5),
    ],
    agents: { total: 2, running: 2 },
    tokens: { main: 48_200, "agent-rocks": 12_950, "agent-light": 6_400 },
  };
}

export const SCENARIOS: Record<string, Scenario> = {
  "agents-tokens": { title: "The thread list: the main agent and its subagents, each with the tokens it spent this session", hash: `#/chat/${SESSION_ID}`, session: withAgents(), index: { playtests: [], listed: true } },
  "endpoints-empty": { title: "Models & accounts with no custom endpoint yet, and the route order", hash: "#/settings/models", index: { playtests: [], listed: true }, endpoints: [], fullPage: true },
  "endpoints-populated": { title: "Models & accounts with two custom endpoints, one whose model list failed", hash: "#/settings/models", index: { playtests: [], listed: true }, endpoints: ENDPOINTS, fullPage: true },
  "endpoints-error": { title: "Models & accounts when the endpoints cannot be read", hash: "#/settings/models", index: { playtests: [], listed: true }, endpoints: "error", fullPage: true },
  "endpoints-add": { title: "Adding a custom endpoint", hash: "#/settings/models", index: { playtests: [], listed: true }, endpoints: [], click: ".endpoints-card h2.cfg-label button", fullPage: true },
  "endpoints-edit": { title: "Editing a custom endpoint: its models", hash: "#/settings/models", index: { playtests: [], listed: true }, endpoints: ENDPOINTS, click: ".endpoint-row:nth-of-type(2) .endpoint-actions button:nth-child(2)", fullPage: true },
  "composer-idle": (() => {
    const s = inSession("The composer bar idle, with a draft: Send at the right end", "Door playtest", []);
    return { ...s, session: { ...s.session!, draft: "Add a second door trigger by the ledge" } };
  })(),
  "composer-running": (() => {
    const s = inSession("The composer bar while a turn runs: Queue and Stop at the right end", "Door playtest", []);
    return { ...s, session: { ...s.session!, status: "running" as const, draft: "Then check the sprint speed" } };
  })(),
  "composer-menu": (() => {
    const s = inSession("The composer's model menu open: with an Effort row when the bar has merged model and effort", "Door playtest", [], ".composer-bar .picker-button");
    return { ...s, session: { ...s.session!, draft: "Add a second door trigger by the ledge" } };
  })(),
  "mention-menu": mentionScenario("The @-mention menu: assets, an actor and files matching @Door, each with its name, type and path", "@Door"),
  "mention-actor": mentionScenario("The @-mention menu narrowed to actors with @actor:, with no editor attached", "@actor:Fro", { actor: "unavailable" }),
  "mention-empty": mentionScenario("The @-mention menu when nothing matches", "@Zebra"),
  "mention-sent": (() => {
    const s = inSession("Mentions in the message being written, as chips over the box, and in a sent message", "Door playtest", []);
    const text = `Swap the mesh on ${mentionToken(MENTIONS[3])} for ${mentionToken(MENTIONS[1])} and log it in ${mentionToken(MENTIONS[4])}`;
    return {
      ...s,
      session: {
        ...s.session!,
        transcript: [...s.session!.transcript, { kind: "user" as const, text, at: ago(2) }, { kind: "assistant" as const, text: "Done: the front door now uses SM_Door.", at: ago(1) }],
        draft: `Now make ${mentionToken(MENTIONS[0])} open toward ${mentionToken(MENTIONS[5])} `,
      },
    };
  })(),
  "session-empty": inSession("A session with no playtest: Checkpoints in the composer bar", "Door playtest", []),
  "draft": inSession("A draft: collapsed card in the transcript with Start playtest on it", "Door playtest", [RUNS.draft]),
  "draft-asset-links": { ...inSession("A draft opened: asset names in its steps, its script path and its arrange and act targets as links; a name that does not resolve stays plain", "Broken bridge", [RUNS.linked], ".thread-stage .qa-toggle"), post: resolveLinked, focus: ".thread-stage .qa-instruction .asset-link:not(.code)" },
  "armed": inSession("Armed: the latest item in the conversation", "Door playtest", [RUNS.armed]),
  "running": inSession("Running: the latest item in the conversation", "Jump check", [RUNS.running]),
  "waiting": inSession("Waiting for a verdict: Pass, Fail and Skip on the card", "Door playtest", [RUNS.waiting]),
  "waiting-open": inSession("Waiting, opened in place from the waiting step's bar", "Door playtest", [RUNS.waiting], ".thread-stage .qa-path-step[data-status='awaiting_verdict'] button"),
  "focus-step-bar": inSession("Keyboard focus on a step bar of a waiting card", "Door playtest", [RUNS.waiting], undefined, ".thread-stage .qa-path-step:nth-child(2) button"),
  "focus-verdict": inSession("Keyboard focus on Pass", "Door playtest", [RUNS.waiting], undefined, ".thread-stage .qa-answer button"),
  "finished-failures": inSession("Finished with failures", "Landing check", [RUNS.failed]),
  "finished-failures-open": inSession("Finished with failures, opened from a failed step's bar", "Landing check", [RUNS.failed], ".qa-path-step[data-status='failed'] button"),
  "stopped": inSession("Stopped: in the transcript, a neutral pill, with the steps it never reached marked", "Sprint", [RUNS.stopped]),
  "agent-captures": { ...inSession("A step the agent judged, opened: one capture it saw and one it can no longer read", "Door looks", [RUNS.judged]), clicks: [".thread-stage .qa-toggle", ".thread-stage .qa-agent-evidence summary"], scroll: ".thread-stage .qa-agent-evidence" },
  "loop-running": inSession("Assigned loop running, with its attempt", "Ledge grab", [RUNS.loopRunning]),
  "loop-needs-you": inSession("Loop that needs you, with its reason and Review", "Gate trigger", [RUNS.loopNeedsYou]),
  "loop-needs-you-open": { ...inSession("Loop that needs you, opened: Assign again and Cancel loop", "Gate trigger", [RUNS.loopNeedsYou], ".thread-stage .qa-toggle"), scroll: ".thread-stage .qa-loop" },
  "strip-two-need-you": inSession("Two that need you and one running", "Door playtest", [RUNS.running, RUNS.waiting, RUNS.loopNeedsYou]),
  "strip-several": inSession("Several live in one conversation", "Door playtest", [RUNS.failed, RUNS.running, RUNS.waiting, RUNS.loopRunning, RUNS.loopNeedsYou]),
  "new-messages": (() => {
    const s = inSession("New messages arrive while the reader is scrolled up: the pill takes its own row, over no line", "Door playtest", [RUNS.armed]);
    const talk: TranscriptEntry[] = Array.from({ length: 6 }, (_, i) => ({ kind: i % 2 ? "assistant" as const : "user" as const, text: i % 2 ? "The observer reads the door angle every frame; the run ends when every step has a result." : "How does it decide the door opened?", at: ago(20 - i) }));
    return { ...s, session: { ...s.session!, transcript: [...talk, ...s.session!.transcript] }, arrives: { kind: "assistant", text: "PIE is up; the first step is running.", at: ago(0) } };
  })(),
  "page-needs-you": { title: "Playtests page, Needs you", hash: "#/playtests", index: { playtests: PROJECT, listed: true }, filter: "needs-you" },
  "page-failing": { title: "Playtests page, Failing", hash: "#/playtests", index: { playtests: PROJECT, listed: true }, filter: "failing" },
  "page-all": { title: "Playtests page, All", hash: "#/playtests", index: { playtests: PROJECT, listed: true }, filter: "all" },
  "page-row-open": { title: "Playtests page, a row's full card opened in place", hash: "#/playtests", index: { playtests: PROJECT, listed: true }, filter: "all", click: ".playtests-row:nth-child(4) .qa-toggle" },
  "page-row-edit": { title: "Playtests page, Edit on a script run outside Studio: the step editor in place", hash: "#/playtests", index: { playtests: PROJECT, listed: true }, filter: "all", clicks: [".playtests-row:nth-child(4) .qa-toggle", ".playtests-row:nth-child(4) .qa-script-edit"] },
  "page-row-delete": { title: "Playtests page, Delete waiting for its second click", hash: "#/playtests", index: { playtests: PROJECT, listed: true }, filter: "all", clicks: [".playtests-row:nth-child(4) .qa-toggle", ".playtests-row:nth-child(4) .qa-script-delete"] },
  "page-row-offline-open": { title: "Playtests page, an open row while the editor is away: Edit and Delete disabled", hash: "#/playtests", index: { playtests: PROJECT.slice(0, 5), listed: false }, filter: "all", click: ".playtests-row:nth-child(4) .qa-toggle" },
  "page-empty": { title: "Playtests page with no playtests in the project", hash: "#/playtests", index: { playtests: [], listed: true }, filter: "all" },
  "page-editor-offline": { title: "Playtests page while the editor cannot list scripts", hash: "#/playtests", index: { playtests: PROJECT.slice(0, 5), listed: false }, filter: "all" },
};

/**
 * The demo project for the Playtest Hub: "Ember Hollow", an original co-op
 * action-adventure, with its test scripts, goals, a month of run history and
 * a queue. Built from a seeded random source, relative to the
 * moment it is made, so the same seed gives the same project shape. Pure data:
 * no DOM, so the visual QA harnesses on both clients can import it.
 */
import {
  DEFAULT_ACCEPTANCE,
  DEFAULT_PLAN_OPTIONS,
  DEFAULT_HEALTH_RULE,
  HUB_SCHEMA,
  checkId,
  itemStateOf,
  planOptionsFor,
  qaScriptKey,
  type CheckMeta,
  type CurrentProvenance,
  type Goal,
  type HealthRule,
  type PlanItem,
  type PlanRun,
  type QaLoop,
  type QaRun,
  type QaScriptStep,
  type QueuePause,
  type RunOutcome,
  type RunProvenance,
  type RunRecord,
  type RunSource,
  type Schedule,
  type SignOff,
} from "@ue-mcp-studio/shared";

export type DemoSeed = "full" | "empty" | "fresh";
export const DEMO_SEEDS: readonly DemoSeed[] = ["full", "empty", "fresh"];

export const DEMO_PROJECT = "EmberHollow";
export const DEMO_PROJECT_DIR = "C:/Users/dev/Projects/EmberHollow";
/** Who "you" are in the demo: sign-offs and runs started from the page are theirs. */
export const DEMO_USER = "Sam Okafor";
export const DEMO_SCRIPTS_DIR = "/Game/PIEStudio/Scripts";
const MAPS = "/Game/EmberHollow/Maps";
const DAY = 86_400_000;
const MIN = 60_000;

/** How a script behaves when the simulation runs it. */
export interface DemoProfile {
  /** An auto step that fails every run until a fix loop fixes it. */
  failStep?: number | null;
  /** An auto step that fails some runs. */
  flakyStep?: number | null;
  flakyRate?: number;
  /** A fix loop on this script succeeds; otherwise it stops for a person. */
  fixable?: boolean;
}

export interface DemoScript {
  path: string;
  name: string;
  map: string;
  steps: QaScriptStep[];
  author: string;
  tags: string[];
  profile: DemoProfile;
  /** Gone from the project: goals still name it and its runs remain. */
  missing?: boolean;
}

/** Something the simulation does later: a fix loop settling, or new scripts arriving. */
export type DemoJob =
  | { at: number; kind: "loop"; runId: string }
  | { at: number; kind: "write"; goalId: string; sessionId: string };

/** The live run the editor is on, and when it takes its next step. */
export interface DemoLive {
  runId: string;
  nextAt: number;
  planId: string | null;
  /** Holding at a manual step for its verdict. */
  blocked: boolean;
}

export interface DemoState {
  /** 4: goals are kept as the goal store keeps them (no schedules, playtests' own records, the health rule); a state saved before is seeded again. */
  version: 4;
  seed: DemoSeed;
  /** The demo project's workspace: its newest commit, and the files a fix loop changed since. */
  workspace: CurrentProvenance;
  speed: number;
  editor: boolean;
  goals: Goal[];
  /** Sign-offs by goal id, records in the goal store. */
  signOffs: Record<string, SignOff>;
  /** What each playtest says about itself, by check id. */
  checkMetas: Record<string, CheckMeta>;
  /** The project's rule for flaky and stale. */
  rules: HealthRule;
  scripts: DemoScript[];
  /** Every run, newest first. */
  runs: RunRecord[];
  /** Runs with more than their record says: live ones, ones waiting for a verdict, ones with a fix loop. */
  qa: Record<string, QaRun>;
  live: DemoLive | null;
  /** No new item starts before this, so a plan breathes between runs. */
  idleUntil: number;
  paused: boolean;
  /** Who paused the queue; absent in a state saved before Release the editor was. */
  pausedBy?: QueuePause | null;
  current: PlanRun | null;
  queued: PlanRun[];
  recent: PlanRun[];
  /** Absent in a state saved while the hub had none: none then. */
  schedules?: Schedule[];
  jobs: DemoJob[];
  /** Runs waiting for their fix loop: one loop at a time. */
  loopQueue: string[];
  /** The run whose fix loop is going now. */
  loopActive: string | null;
  /** For ids. */
  counter: number;
}

// ---------- Steps ----------

const auto = (instruction: string, value: string, op: string, target?: number | boolean, withinMs?: number, player?: string): QaScriptStep => ({
  instruction,
  judge: "auto",
  expect: { value, op, ...(target !== undefined ? { target } : {}), ...(withinMs ? { within_ms: withinMs } : {}) },
  ...(player ? { player } : {}),
});
const manual = (instruction: string, agentJudgeable = true): QaScriptStep => ({ instruction, judge: "manual", ...(agentJudgeable ? {} : { agent_judgeable: false }) });

interface ScriptSeed {
  folder: string;
  name: string;
  map: string;
  author: string;
  tags: string[];
  steps: QaScriptStep[];
  profile?: DemoProfile;
  /** How its history looks. */
  history: "nightly" | "often" | "stale" | "flaky" | "regressed" | "awaiting" | "blocked" | "gone" | "never";
}

const SCRIPT_SEEDS: ScriptSeed[] = [
  // The tutorial glade.
  { folder: "Tutorial", name: "PT_Tutorial_Movement", map: `${MAPS}/L_Tutorial_Glade`, author: "Ama Mensah", tags: ["tutorial", "onboarding"], history: "nightly", steps: [
    auto("Push the left stick forward and the lantern-bearer walks toward the shrine", "Pawn.Velocity.Size", "gt", 150, 2000),
    auto("The move prompt hides after the first five metres", "WBP_Prompt_Move", "visible", false, 4000),
    manual("Check the walk-to-run blend has no foot sliding"),
  ] },
  { folder: "Tutorial", name: "PT_Tutorial_Jump", map: `${MAPS}/L_Tutorial_Glade`, author: "Ama Mensah", tags: ["tutorial", "traversal"], history: "nightly", steps: [
    auto("Press IA_Jump at the fallen log and pos_z increasing", "pos_z", "increasing", undefined, 1500),
    auto("The character lands on the far side of the log", "CharacterMovement.MovementMode", "eq", 1, 2500),
    manual("Check the jump prompt reads clearly against the foliage"),
  ] },
  { folder: "Tutorial", name: "PT_Tutorial_LanternLight", map: `${MAPS}/L_Tutorial_Glade`, author: "Ama Mensah", tags: ["tutorial", "lantern"], history: "nightly", steps: [
    auto("Hold IA_LanternRaise and the lantern's intensity rises above 0.8", "LanternComponent.Intensity", "gt", 0.8, 2000),
    auto("The thornwall BP_Thornwall_Tutorial burns away", "BP_Thornwall_Tutorial", "exists", false, 5000),
    manual("Check the ember particles follow the lantern without trailing"),
  ] },
  { folder: "Tutorial", name: "PT_Tutorial_Exit", map: `${MAPS}/L_Tutorial_Glade`, author: "Ama Mensah", tags: ["tutorial", "streaming"], history: "nightly", steps: [
    auto("Walk through the glade gate and L_Ashwood streams in", "Streaming.L_Ashwood.Loaded", "eq", true, 8000),
    auto("WBP_ChapterTitle visible", "WBP_ChapterTitle", "visible", true, 4000),
  ] },
  // Traversal.
  { folder: "Traversal", name: "PT_Jump_Height", map: `${MAPS}/L_Ashwood`, author: "Jun Park", tags: ["traversal"], history: "nightly", steps: [
    auto("Press IA_Jump and pos_z increasing", "pos_z", "increasing", undefined, 800),
    auto("The jump peaks above 180 cm", "Jump.PeakHeight", "gt", 180, 1500),
    auto("JumpCurrentCount returns to 0 on landing", "JumpCurrentCount", "eq", 0, 2000),
  ] },
  { folder: "Traversal", name: "PT_DodgeRoll", map: `${MAPS}/L_Ashwood`, author: "Jun Park", tags: ["traversal", "combat"], history: "nightly", steps: [
    auto("Press IA_Dodge and Stamina decreasing", "Stamina", "decreasing", undefined, 500),
    auto("The dodge covers at least 350 cm", "Dodge.Distance", "gt", 350, 1200),
    manual("Check the dodge roll animation blends without popping"),
    auto("The wisp's swipe misses while rolling", "Player.bInvulnerable", "eq", true, 900),
  ] },
  { folder: "Traversal", name: "PT_LedgeGrab", map: `${MAPS}/L_Ashwood`, author: "Jun Park", tags: ["traversal"], history: "flaky", profile: { flakyStep: 0, flakyRate: 0.3, fixable: true }, steps: [
    auto("Jump at the broken pillar and the character catches the ledge", "Traversal.LedgeState", "eq", 2, 2500),
    auto("Press IA_Jump to mantle and pos_z increasing", "pos_z", "increasing", undefined, 1200),
    manual("Check the hands line up with the ledge edge"),
  ] },
  { folder: "Traversal", name: "PT_Sprint_Stamina", map: `${MAPS}/L_Ashwood`, author: "Jun Park", tags: ["traversal"], history: "nightly", steps: [
    auto("Hold IA_Sprint and speed goes above 600", "CharacterMovement.Velocity.Size", "gt", 600, 1500),
    auto("Stamina decreasing while sprinting", "Stamina", "decreasing", undefined, 2000),
    auto("Sprint ends when stamina runs out", "Stamina", "lt", 1, 9000),
    auto("WBP_StaminaRing visible while stamina refills", "WBP_StaminaRing", "visible", true, 2000),
  ] },
  // Lantern combat.
  { folder: "Combat", name: "PT_Lantern_Strike", map: `${MAPS}/L_Ashwood`, author: "Mateo Silva", tags: ["combat", "lantern"], history: "nightly", steps: [
    auto("Press IA_Attack next to BP_Wisp_Dummy and its health decreasing", "Wisp.Health", "decreasing", undefined, 1500),
    auto("Three strikes in a row play the combo finisher", "Combat.ComboIndex", "eq", 3, 3000),
    manual("Check the hit flash and camera shake feel weighty, not noisy"),
  ] },
  { folder: "Combat", name: "PT_Stagger_Wisp", map: `${MAPS}/L_Ashwood`, author: "Mateo Silva", tags: ["combat", "ai"], history: "regressed", profile: { failStep: 1, fixable: true }, steps: [
    auto("Strike BP_Wisp_Elite four times and StaggerMeter increasing", "Wisp.StaggerMeter", "increasing", undefined, 4000),
    auto("The elite wisp staggers", "Wisp.bStaggered", "eq", true, 3000),
    manual("Check the stagger animation reads from across the arena"),
  ] },
  { folder: "Combat", name: "PT_Player_Damage", map: `${MAPS}/L_Ashwood`, author: "Mateo Silva", tags: ["combat", "hud"], history: "nightly", steps: [
    auto("Stand in the ember vent and Player.Health decreasing", "Player.Health", "decreasing", undefined, 3000),
    auto("WBP_DamageVignette visible while health drops", "WBP_DamageVignette", "visible", true, 1000),
    auto("Health regenerates after leaving the vent", "Player.Health", "increasing", undefined, 4000),
  ] },
  // Pause menu and settings.
  { folder: "UI", name: "PT_PauseMenu_Open", map: `${MAPS}/L_Ashwood`, author: "Ama Mensah", tags: ["ui"], history: "nightly", steps: [
    auto("Press IA_Pause and WBP_PauseMenu visible", "WBP_PauseMenu", "visible", true, 1000),
    auto("The world pauses", "World.TimeDilation", "eq", 0, 1000),
    manual("Check the blur behind the menu leaves the HUD edge readable"),
  ] },
  { folder: "UI", name: "PT_Settings_Apply", map: `${MAPS}/L_Ashwood`, author: "Ama Mensah", tags: ["ui", "settings"], history: "awaiting", steps: [
    auto("Open Settings and WBP_Settings visible", "WBP_Settings", "visible", true, 1500),
    auto("Set field of view to 100 and the camera follows", "Camera.FOV", "eq", 100, 1500),
    manual("Check the new field of view applies without a hitch mid-combat", false),
    auto("Apply closes the settings panel", "WBP_Settings", "visible", false, 1500),
  ] },
  { folder: "UI", name: "PT_Pause_Resume", map: `${MAPS}/L_Ashwood`, author: "Ama Mensah", tags: ["ui"], history: "nightly", steps: [
    auto("Resume and the world runs again", "World.TimeDilation", "eq", 1, 1000),
    auto("Input returns to the pawn: IA_Jump and pos_z increasing", "pos_z", "increasing", undefined, 1500),
  ] },
  // Co-op.
  { folder: "Coop", name: "PT_Coop_Join_Listen", map: `${MAPS}/L_Coop_Lobby`, author: "Priya Raman", tags: ["coop", "network"], history: "often", steps: [
    auto("The host opens a listen server", "Session.State", "eq", 2, 5000, "host"),
    auto("Three clients join", "Session.PlayerCount", "eq", 4, 20000, "host"),
    manual("Check every nameplate floats over the right character"),
    auto("Client 3's lantern colour replicates to the host", "Lantern.ColorIndex", "eq", 3, 3000, "client 3"),
  ] },
  { folder: "Coop", name: "PT_Coop_Join_Late", map: `${MAPS}/L_Ashwood`, author: "Priya Raman", tags: ["coop", "network"], history: "stale", steps: [
    auto("A fourth player joins mid-encounter", "Session.PlayerCount", "eq", 4, 20000, "host"),
    auto("The late joiner spawns at the last shrine", "Player.SpawnShrine", "eq", 2, 5000, "client 3"),
    manual("Check the late joiner's camera fades in without a pop"),
  ] },
  { folder: "Coop", name: "PT_Coop_Lobby_Ready", map: `${MAPS}/L_Coop_Lobby`, author: "Priya Raman", tags: ["coop", "ui"], history: "often", steps: [
    auto("Every player presses IA_Ready", "Lobby.ReadyCount", "eq", 4, 6000, "host"),
    auto("WBP_LobbyCountdown visible", "WBP_LobbyCountdown", "visible", true, 2000),
    auto("Travel to L_Ashwood starts when the countdown ends", "Streaming.L_Ashwood.Loaded", "eq", true, 15000),
  ] },
  { folder: "Coop", name: "PT_Revive_Ally", map: `${MAPS}/L_Ashwood`, author: "Jun Park", tags: ["coop", "combat"], history: "often", steps: [
    auto("Client 1 goes down", "Player.DownedState", "eq", 1, 4000, "client 1"),
    auto("The host holds IA_Interact on the ally and ReviveProgress increasing", "Revive.Progress", "increasing", undefined, 3000, "host"),
    auto("The ally stands with more than 30 health", "Player.Health", "gt", 30, 6000, "client 1"),
    manual("Check the revive beam lines up between both lanterns"),
  ] },
  { folder: "Coop", name: "PT_Revive_Timer", map: `${MAPS}/L_Ashwood`, author: "Jun Park", tags: ["coop"], history: "never", steps: [
    auto("A downed player's bleed-out timer decreasing", "Player.BleedOut", "decreasing", undefined, 1000, "client 1"),
    auto("Bleeding out sends the player to spectate", "Player.bSpectating", "eq", true, 32000, "client 1"),
  ] },
  { folder: "Coop", name: "PT_Revive_Downed_Old", map: `${MAPS}/L_Ashwood`, author: "Jun Park", tags: ["coop"], history: "gone", steps: [
    auto("The downed player crawls: pos_x increasing", "pos_x", "increasing", undefined, 3000),
    manual("Check the crawl animation"),
  ] },
  { folder: "Loot", name: "PT_Loot_Split", map: `${MAPS}/L_Ashwood`, author: "Sam Okafor", tags: ["coop", "loot"], history: "never", steps: [
    auto("Open BP_Chest_Ember and four drops spawn", "Loot.DropCount", "eq", 4, 3000, "host"),
    auto("Each player's ember shards increasing", "Inventory.EmberShards", "increasing", undefined, 6000),
    manual("Check each player sees only their own drop highlight"),
  ] },
  { folder: "Loot", name: "PT_Loot_Pickup_Sync", map: `${MAPS}/L_Ashwood`, author: "Sam Okafor", tags: ["coop", "loot", "network"], history: "never", steps: [
    auto("Client 2 picks up the relic", "Relic.OwnerIndex", "eq", 2, 4000, "client 2"),
    auto("The relic disappears for every other player", "BP_Relic_Ember", "exists", false, 2000, "client 1"),
  ] },
  // The Cinder Warden.
  { folder: "Boss", name: "PT_Boss_Phase1", map: `${MAPS}/L_CinderKeep`, author: "Mateo Silva", tags: ["boss", "coop"], history: "often", steps: [
    auto("Two players enter the arena and the fight starts", "Boss.Phase", "eq", 1, 6000),
    auto("Breaking the ember plates sends Boss.Health decreasing", "Boss.Health", "decreasing", undefined, 20000),
    auto("The warden enters phase two below 60% health", "Boss.Phase", "eq", 2, 60000),
    manual("Check the warden's slam telegraph reads for both players"),
  ] },
  { folder: "Boss", name: "PT_Boss_Phase2", map: `${MAPS}/L_CinderKeep`, author: "Mateo Silva", tags: ["boss", "coop"], history: "blocked", profile: { failStep: 1, fixable: false }, steps: [
    auto("Phase two spawns more than three cinder adds", "Boss.AddCount", "gt", 3, 8000),
    auto("Two lanterns raised together put out the cinder storm", "Boss.bStormActive", "eq", false, 6000),
    auto("The warden's health reaches 0", "Boss.Health", "lt", 1, 240000),
    manual("Check the death sequence plays fully for both players"),
  ] },
  // Performance and saves.
  { folder: "Perf", name: "PT_Perf_Ashwood_Flythrough", map: `${MAPS}/L_Ashwood`, author: "Jun Park", tags: ["perf"], history: "often", steps: [
    auto("The flythrough camera reaches the ridge: pos_x increasing", "pos_x", "increasing", undefined, 30000),
    auto("Frame time stays under 16.6 ms", "Stats.FrameTimeMs", "lt", 16.6, 30000),
    auto("No hitch over 50 ms", "Stats.MaxHitchMs", "lt", 50, 30000),
    manual("Check distant trees don't pop in at the ridge"),
  ] },
  { folder: "Save", name: "PT_Save_Load_Checkpoint", map: `${MAPS}/L_Ashwood`, author: "Sam Okafor", tags: ["save"], history: "often", steps: [
    auto("Touch the shrine BP_Shrine_02 and slot 0 is written", "SaveGame.Slot0.Exists", "eq", true, 3000),
    auto("Load the slot and the player is back at the shrine", "Player.DistanceToShrine", "lt", 100, 8000),
    manual("Check the loading screen tip matches the chapter"),
  ] },
  { folder: "Save", name: "PT_Save_Slot_Overwrite", map: `${MAPS}/L_Ashwood`, author: "Sam Okafor", tags: ["save", "ui"], history: "often", steps: [
    auto("Save to a used slot and WBP_ConfirmOverwrite visible", "WBP_ConfirmOverwrite", "visible", true, 2000),
    auto("Confirm and slot 1's timestamp increasing", "SaveGame.Slot1.Timestamp", "increasing", undefined, 3000),
  ] },
  // Scripts no goal names yet.
  { folder: "Audio", name: "PT_Audio_Footsteps", map: `${MAPS}/L_Ashwood`, author: "Ama Mensah", tags: ["audio"], history: "often", steps: [
    auto("Walk on ash and the footstep surface is ash", "Audio.Footstep.Surface", "eq", 3, 2000),
    manual("Check footsteps on wet stone sound wet, not dry"),
  ] },
  { folder: "Camera", name: "PT_Camera_Collision", map: `${MAPS}/L_Ashwood`, author: "Jun Park", tags: ["camera"], history: "often", steps: [
    auto("Back the camera into the cliff and the arm shortens below 200", "Camera.ArmLength", "lt", 200, 2000),
    manual("Check the camera stays out of the cliff mesh"),
  ] },
  { folder: "Fishing", name: "PT_Fishing_Minigame", map: `${MAPS}/L_Ashwood`, author: "Priya Raman", tags: ["minigame"], history: "never", steps: [
    auto("Cast at the ember pool and the line is out", "Fishing.State", "eq", 1, 3000),
    manual("Check the bobber floats on the lava surface"),
  ] },
];

const scriptPath = (folder: string, name: string) => `${DEMO_SCRIPTS_DIR}/${folder}/${name}`;
const ref = (folder: string, name: string) => ({ kind: "script" as const, target: scriptPath(folder, name) });

// ---------- Randomness ----------

/** A seeded random source in [0, 1). */
export function demoRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A number from a string, for values that must stay the same each time a run is drawn. */
export function demoHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** How long a step takes in game time, the same every time the run is drawn. */
export function demoStepMs(runId: string, index: number, step: QaScriptStep): number {
  const r = demoRandom(demoHash(`${runId}:${index}`))();
  const within = step.expect?.within_ms ?? 3000;
  if (step.judge === "manual") return 1500 + Math.round(r * 2500);
  return Math.min(within, Math.max(400, Math.round(within * (0.25 + r * 0.6))));
}

// ---------- Runs ----------

const iso = (ms: number) => new Date(ms).toISOString();
export const demoResultsPath = (runId: string) => `${DEMO_PROJECT_DIR}/Saved/MCPObservations/${runId}/results.json`;
export const demoRunId = (name: string, at: number, n: number) => `script_${name}_${Math.floor(at / 1000).toString(36)}${n.toString(36)}`;

const hex8 = (s: string): string => demoHash(s).toString(16).padStart(8, "0");

/** The demo project's commit k steps back from its newest (0), as Git names it. */
export const demoRevision = (k: number): string => [0, 1, 2, 3, 4].map((i) => hex8(`ember-commit-${k}-${i}`)).join("");

/** A script's version: its path and steps, so an edit changes it. */
export const demoScriptHash = (s: Pick<DemoScript, "path" | "steps">): string => `sha256:${hex8(s.path)}${hex8(JSON.stringify(s.steps))}`;

/** What a demo run tested: a revision, the script's version, UE 5.5, and a listen server for a script with client steps. */
export function demoProvenance(s: Pick<DemoScript, "path" | "steps">, revision: string | null, dirty = 0): RunProvenance {
  const clients = s.steps.map((x) => /^client (\d+)$/.exec(x.player ?? "")?.[1]).filter((x): x is string => !!x).map(Number);
  return {
    vcs: "git",
    revision,
    dirty,
    scriptHash: demoScriptHash(s),
    engine: "5.5",
    players: clients.length ? { count: Math.max(...clients) + 1, netMode: "listen" } : null,
  };
}

function record(script: DemoScript, at: number, failed: number[], source: RunSource, n: number, provenance: RunProvenance, planRunId: string | null = null, outcome?: RunOutcome): RunRecord {
  const runId = demoRunId(script.name, at, n);
  const durationMs = script.steps.reduce((sum, s, i) => sum + demoStepMs(runId, i, s), 0) + 1800;
  const total = script.steps.length;
  return {
    runId,
    kind: "script",
    target: script.path,
    name: script.name,
    outcome: outcome ?? (failed.length ? "failed" : "passed"),
    startedAt: iso(at),
    endedAt: iso(at + durationMs),
    durationMs,
    summary: { total, passed: total - failed.length, failed: failed.length, skipped: 0, pending: 0, awaiting: 0 },
    failedSteps: failed,
    source,
    trigger: "run",
    sessionId: null,
    planRunId,
    replayOf: null,
    recordingId: null,
    map: script.map,
    provenance,
  };
}

const autoSteps = (s: DemoScript) => s.steps.flatMap((x, i) => (x.judge === "auto" ? [i] : []));

/** A nightly plan's id for the night `d` days ago. */
const nightlyId = (d: number) => `plan-nightly-${d}`;

function history(scripts: DemoScript[], seeds: ScriptSeed[], now: number, rand: () => number): { runs: RunRecord[]; qa: Record<string, QaRun>; nights: Map<number, RunRecord[]> } {
  const runs: RunRecord[] = [];
  const qa: Record<string, QaRun> = {};
  const nights = new Map<number, RunRecord[]>();
  let n = 0;
  const today2am = new Date(now);
  today2am.setHours(2, 0, 0, 0);
  // Last night's runs finished well before the newest daytime ones, whatever the hour now.
  if (today2am.getTime() > now - 90 * MIN) today2am.setDate(today2am.getDate() - 1);
  const night = (d: number) => today2am.getTime() - d * DAY;
  // The team commits in the evening every other day, the newest four hours before last night's runs.
  const lastCommit = night(0) - 4 * 3_600_000;
  const revisionAt = (at: number) => demoRevision(at >= lastCommit ? 0 : Math.ceil((lastCommit - at) / (2 * DAY)));
  /** An old failure now and then, long since fixed. */
  const noise = (s: DemoScript, ageDays: number, horizon: number): number[] => {
    const autos = autoSteps(s);
    return ageDays > horizon && rand() < 0.07 && autos.length ? [autos[Math.floor(rand() * autos.length)]] : [];
  };
  scripts.forEach((script, k) => {
    const kind = seeds[k].history;
    const mine: RunRecord[] = [];
    // A person's daytime run is now and then over uncommitted work; the evening batches run on a clean workspace.
    const add = (at: number, failed: number[], source: RunSource, planRunId: string | null = null, dirty = 0) => {
      if (at > now - 5 * MIN) return null;
      const r = record(script, at, failed, source, n++, demoProvenance(script, revisionAt(at), dirty), planRunId);
      mine.push(r);
      if (planRunId?.startsWith("plan-nightly-")) {
        const d = Number(planRunId.slice("plan-nightly-".length));
        nights.set(d, [...(nights.get(d) ?? []), r]);
      }
      return r;
    };
    if (kind === "never") return;
    if (kind === "nightly" || kind === "flaky" || kind === "regressed" || kind === "awaiting") {
      for (let d = 29; d >= 0; d--) {
        const at = night(d) + k * 3 * MIN + Math.floor(rand() * 40_000);
        let failed = noise(script, d, 10);
        if (kind === "flaky" && d <= 12 && rand() < 0.3) failed = [0];
        if (kind === "flaky" && d === 1) failed = [0];
        if (kind === "flaky" && d === 0) failed = [];
        if (kind === "regressed") failed = d === 0 ? [1] : noise(script, d, 10);
        add(at, failed, "plan", nightlyId(d));
        // A person runs it during the day now and then.
        if (rand() < 0.15 && d > 0) add(night(d) + (9 + rand() * 8) * 3_600_000, noise(script, d, 10), "person", null, rand() < 0.3 ? 2 : 0);
      }
      // Flaky on the same commit: it failed for a person after the newest commit, then passed in the night.
      if (kind === "flaky") add(lastCommit + 40 * MIN, [0], "person");
      if (kind === "awaiting") {
        // Run from the hub forty minutes ago; nobody gave its manual step a verdict in time, so it has no result.
        const r = add(now - 40 * MIN, [], "plan");
        if (r) {
          const manualAt = script.steps.findIndex((s) => s.judge === "manual");
          r.outcome = "unjudged";
          r.summary = { ...r.summary!, passed: r.summary!.total - 1, pending: 1, awaiting: 1 };
          qa[r.runId] = demoQaRun(script, r, { awaiting: [manualAt] });
        }
      }
    } else if (kind === "often") {
      for (let d = 28 - (k % 3); d >= 1; d -= 2 + Math.floor(rand() * 3)) add(night(d) + (10 + rand() * 7) * 3_600_000, noise(script, d, 16), "person");
      // Checked again on the newest commit.
      add(lastCommit + (20 + k) * MIN, [], "person");
    } else if (kind === "stale") {
      for (let d = 30; d >= 19; d -= 4) add(night(d) + 14 * 3_600_000 + k * MIN, [], "person");
    } else if (kind === "gone") {
      add(night(25) + 15 * 3_600_000, [], "person");
      add(night(22) + 11 * 3_600_000, [], "person");
    } else if (kind === "blocked") {
      for (let d = 20; d >= 1; d -= 3) add(night(d) + 16 * 3_600_000, d <= 7 ? [1] : [], "person");
      const last = add(now - 3 * 3_600_000, [1], "person");
      if (last) {
        const run = demoQaRun(script, last);
        const at = Date.parse(last.endedAt!);
        const loop: QaLoop = {
          id: `loop-${last.runId}`,
          state: "needs_you",
          baseline: "cp-warden-0",
          startedAt: iso(at + 2 * MIN),
          endedAt: iso(at + 24 * MIN),
          attempts: [
            { n: 1, callId: "agent-warden-1", before: "cp-warden-0", after: "cp-warden-1", changes: [{ path: "Content/EmberHollow/Boss/BP_CinderStorm.uasset", status: "modified" }], failing: ["Step 2: the storm stayed active"], startedAt: iso(at + 2 * MIN), endedAt: iso(at + 12 * MIN) },
            { n: 2, callId: "agent-warden-2", before: "cp-warden-1", after: "cp-warden-2", changes: [{ path: "Content/EmberHollow/Boss/BP_CinderWarden.uasset", status: "modified" }, { path: "Source/EmberHollow/Lantern/LanternSyncComponent.cpp", status: "modified" }], failing: ["Step 2: the storm stayed active"], startedAt: iso(at + 13 * MIN), endedAt: iso(at + 24 * MIN) },
          ],
          blocker: {
            kind: "no_progress",
            reason: "Two attempts changed the storm and the lantern sync, and step 2 still fails: the storm only checks the host's lantern, so the two-lantern rule never holds in PIE.",
            evidence: ["Step 2: the storm stayed active", "Boss.bStormActive stayed true for 6000 ms with both lanterns raised"],
            step: 1,
          },
        };
        qa[last.runId] = { ...run, assignment: { callId: "agent-warden-2", sessionId: "hub-demo", state: "done", at: iso(at + 2 * MIN), loop } };
      }
    }
    runs.push(...mine);
  });
  runs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  return { runs, qa, nights };
}

/**
 * A run's QaRun from its record and script: steps settled as the record says,
 * timed the same way every time. `awaiting` leaves those manual steps waiting.
 */
export function demoQaRun(script: Pick<DemoScript, "path" | "name" | "map" | "steps">, r: RunRecord, o: { awaiting?: number[] } = {}): QaRun {
  const failed = new Set(r.failedSteps ?? []);
  const stopped = r.outcome === "stopped" || r.outcome === "error" || r.outcome === "incomplete";
  const doneSteps = stopped ? Math.max(1, Math.floor(script.steps.length / 2)) : script.steps.length;
  let t = 900;
  const steps = script.steps.map((s, index) => {
    const dur = demoStepMs(r.runId, index, s);
    const startedAtMs = t;
    t += dur + 250;
    if (index >= doneSteps) return { index, instruction: s.instruction, judge: s.judge, ...(s.expect ? { expect: s.expect } : {}), status: "pending" as const, withinMs: s.expect?.within_ms ?? 5000, ...(s.player ? { player: s.player } : {}) };
    const awaiting = o.awaiting?.includes(index);
    const status = awaiting ? "awaiting_verdict" as const : failed.has(index) ? "failed" as const : "passed" as const;
    return {
      index,
      instruction: s.instruction,
      judge: s.judge,
      ...(s.expect ? { expect: s.expect } : {}),
      status,
      withinMs: s.expect?.within_ms ?? 5000,
      startedAtMs,
      ...(awaiting ? {} : { endedAtMs: startedAtMs + dur }),
      ...(s.player ? { player: s.player } : {}),
      ...(s.judge === "manual" && s.agent_judgeable === false ? { agentJudgeable: false } : {}),
      ...(s.judge === "auto" && !awaiting ? { verdictSource: "auto" as const, evidence: demoEvidence(s, status === "passed", r.runId, index) } : {}),
      ...(s.judge === "manual" && !awaiting ? { verdictSource: "action" as const } : {}),
    };
  });
  const awaiting = steps.filter((s) => s.status === "awaiting_verdict").map((s) => s.index);
  const summary = {
    total: steps.length,
    passed: steps.filter((s) => s.status === "passed").length,
    failed: steps.filter((s) => s.status === "failed").length,
    skipped: 0,
    pending: steps.filter((s) => s.status !== "passed" && s.status !== "failed").length,
    awaiting: awaiting.length,
  };
  return {
    runId: r.runId,
    script: qaScriptKey(script.path),
    scriptName: script.name,
    map: script.map,
    state: stopped || r.outcome === "unjudged" ? "stopped" : "finished",
    steps,
    awaiting,
    lastSeq: steps.length * 2 + 2,
    summary,
    resultsPath: demoResultsPath(r.runId),
    sessionId: null,
    toolUseId: null,
    seenAt: r.startedAt,
  };
}

/** What the observer saw for an auto step that passed or failed. */
export function demoEvidence(s: QaScriptStep, passed: boolean, runId: string, index: number): Record<string, unknown> {
  const e = s.expect!;
  const r = demoRandom(demoHash(`${runId}:${index}:e`))();
  const target = typeof e.target === "number" ? e.target : 0;
  let start: number;
  let end: number;
  if (e.op === "visible" || e.op === "exists" || typeof e.target === "boolean") {
    const want = e.target === false ? 0 : 1;
    start = 1 - want;
    end = passed ? want : start;
  } else if (e.op === "eq") {
    start = target === 0 ? 1 : 0;
    end = passed ? target : start;
  } else if (e.op === "increasing") {
    start = 0;
    end = passed ? 40 + r * 200 : start;
  } else if (e.op === "decreasing") {
    start = 100;
    end = passed ? 60 + r * 20 : start;
  } else if (e.op === "gt") {
    start = 0;
    end = target * (passed ? 1.1 + r * 0.3 : 0.5 + r * 0.3);
  } else {
    start = target <= 1 ? 100 : target * 1.25 + 1;
    end = passed ? target * (0.5 + r * 0.3) : target <= 1 ? 30 + r * 20 : target * 1.4;
  }
  return {
    value: e.value,
    at_start: Math.round(start * 100) / 100,
    at_end: Math.round(end * 100) / 100,
    samples: 60 + Math.round(r * 300),
    observed: true,
    ...(passed ? {} : { reason: e.op === "visible" || e.op === "exists" ? `${e.value} did not change in the window` : `${e.value} never met ${e.op}${e.target !== undefined ? ` ${String(e.target)}` : ""} within ${e.within_ms ?? 5000} ms` }),
  };
}

// ---------- Goals ----------

function goal(g: Omit<Goal, "schema" | "acceptance"> & { acceptance?: Partial<Goal["acceptance"]> }): Goal {
  return { schema: HUB_SCHEMA, ...g, acceptance: { ...DEFAULT_ACCEPTANCE, ...g.acceptance } };
}

/** Tracker items the demo's goals, checks and a run point at: a self-hosted Gitea, a Jira and a Trello board. */
export const DEMO_LINKS = {
  tutorialIssue: "https://git.example.com/ember/hollow/issues/42",
  exitIssue: "https://git.example.com/ember/hollow/issues/57",
  combatEpic: "https://emberhollow.atlassian.net/browse/HOL-118",
  staggerBug: "https://emberhollow.atlassian.net/browse/HOL-131",
  reviveCard: "https://trello.com/c/Xr4dP2qL/57-revive-a-downed-ally",
} as const;

function goals(): Goal[] {
  return [
    goal({ id: "vertical-slice", kind: "milestone", title: "Vertical Slice", description: "The tutorial glade into Ashwood, played start to finish with lantern combat and a working pause menu. What we show at the December review.", owner: "Priya Raman", priority: "p0", due: "2026-12-18", requires: [{ goal: "tutorial-glade" }, { goal: "traversal-feel" }, { goal: "lantern-combat" }, { goal: "pause-settings" }], checks: [] }),
    goal({ id: "tutorial-glade", kind: "goal", title: "A new player finishes the tutorial glade", description: "Walk, jump, light the lantern and leave the glade without help.", owner: "Ama Mensah", priority: "p0", due: "2026-12-05", links: [{ url: DEMO_LINKS.tutorialIssue, title: "Tutorial glade: first-time player flow", rel: "counterpart" }], checks: [ref("Tutorial", "PT_Tutorial_Movement"), ref("Tutorial", "PT_Tutorial_Jump"), ref("Tutorial", "PT_Tutorial_LanternLight"), ref("Tutorial", "PT_Tutorial_Exit")] }),
    goal({ id: "traversal-feel", kind: "goal", title: "Traversal feels responsive", description: "Jump, dodge, ledge grab and sprint respond within a frame and hold up over repeated runs.", owner: "Jun Park", priority: "p1", due: "2026-12-12", acceptance: { stableRuns: 2 }, checks: [ref("Traversal", "PT_Jump_Height"), ref("Traversal", "PT_DodgeRoll"), ref("Traversal", "PT_LedgeGrab"), ref("Traversal", "PT_Sprint_Stamina"), ref("Tutorial", "PT_Tutorial_Jump")] }),
    goal({ id: "lantern-combat", kind: "goal", title: "Lantern combat lands hits and staggers enemies", owner: "Mateo Silva", priority: "p0", due: "2026-12-10", links: [{ url: DEMO_LINKS.combatEpic, title: "Lantern combat", rel: "counterpart" }], checks: [ref("Combat", "PT_Lantern_Strike"), ref("Combat", "PT_Stagger_Wisp"), ref("Combat", "PT_Player_Damage")] }),
    goal({ id: "pause-settings", kind: "goal", title: "Pause and settings work mid-combat", owner: "Ama Mensah", priority: "p2", due: "2026-12-15", checks: [ref("UI", "PT_PauseMenu_Open"), ref("UI", "PT_Settings_Apply"), ref("UI", "PT_Pause_Resume")] }),
    // Lantern combat is in both milestones: one goal, required by each, never a copy.
    goal({ id: "coop-beta", kind: "milestone", title: "Co-op Beta", description: "Four friends can join, fight the Cinder Warden together, revive each other and split the loot.", owner: "Mateo Silva", priority: "p1", due: "2027-02-26", requires: [{ goal: "coop-join" }, { goal: "lantern-combat" }, { goal: "coop-revive" }, { goal: "shared-loot", required: false }, { goal: "warden-fight" }], checks: [] }),
    goal({ id: "coop-join", kind: "goal", title: "Four players join a listen server", owner: "Priya Raman", priority: "p1", due: "2027-01-15", checks: [ref("Coop", "PT_Coop_Join_Listen"), ref("Coop", "PT_Coop_Join_Late"), ref("Coop", "PT_Coop_Lobby_Ready")] }),
    goal({ id: "coop-revive", kind: "goal", title: "A downed player can be revived", owner: "Jun Park", priority: "p1", due: "2027-01-29", links: [{ url: DEMO_LINKS.reviveCard, title: "Revive a downed ally", rel: "counterpart" }], checks: [ref("Coop", "PT_Revive_Ally"), ref("Coop", "PT_Revive_Timer"), ref("Coop", "PT_Revive_Downed_Old")] }),
    goal({ id: "shared-loot", kind: "goal", title: "Loot is shared fairly", owner: DEMO_USER, priority: "p2", due: "2027-02-12", checks: [ref("Loot", "PT_Loot_Split"), ref("Loot", "PT_Loot_Pickup_Sync")] }),
    goal({ id: "warden-fight", kind: "goal", title: "Two players can beat the Cinder Warden", owner: "Mateo Silva", priority: "p0", due: "2027-01-30", checks: [ref("Boss", "PT_Boss_Phase1"), ref("Boss", "PT_Boss_Phase2")] }),
    goal({ id: "ashwood-perf", kind: "goal", title: "Ashwood holds 60 fps on the min-spec machine", description: "Measured on the GTX 1060 laptop. A person signs off after watching the flythrough.", owner: "Jun Park", priority: "p1", due: "2026-12-18", acceptance: { signOff: true }, checks: [ref("Perf", "PT_Perf_Ashwood_Flythrough")] }),
    goal({ id: "save-load", kind: "goal", title: "Saves load back to the same spot", owner: DEMO_USER, priority: "p2", due: null, checks: [ref("Save", "PT_Save_Load_Checkpoint"), ref("Save", "PT_Save_Slot_Overwrite")] }),
  ];
}

/** What the demo's playtests say about themselves: the issues two of them are linked to. */
function checkMetas(): Record<string, CheckMeta> {
  return {
    [checkId(ref("Tutorial", "PT_Tutorial_Exit"))]: { links: [{ url: DEMO_LINKS.exitIssue, title: "Exit gate opens before the lantern is lit", rel: "related" }] },
    [checkId(ref("Combat", "PT_Stagger_Wisp"))]: { links: [{ url: DEMO_LINKS.staggerBug, title: "Elite wisps ignore stagger", rel: "blocks" }] },
  };
}

// ---------- Plans ----------

function plan(p: Partial<PlanRun> & Pick<PlanRun, "id" | "title" | "scope" | "items" | "createdAt">): PlanRun {
  return { options: { ...DEFAULT_PLAN_OPTIONS }, state: "queued", trigger: "person", startedAt: null, endedAt: null, ...p };
}

const itemFrom = (r: RunRecord): PlanItem => ({
  check: { kind: "script", target: r.target },
  name: r.name,
  state: r.outcome === "needs_you" || r.outcome === "running" ? r.outcome : itemStateOf(r.outcome),
  runId: r.runId,
  startedAt: r.startedAt,
  endedAt: r.endedAt ?? null,
});

// ---------- The state ----------

export function demoState(seed: DemoSeed, now = Date.now(), randomSeed = 7): DemoState {
  const rand = demoRandom(randomSeed);
  const base: DemoState = {
    version: 4, seed, workspace: { vcs: "git", revision: demoRevision(0), dirty: 0 }, speed: 1, editor: true, goals: [], signOffs: {}, checkMetas: {}, rules: { ...DEFAULT_HEALTH_RULE },
    scripts: [], runs: [], qa: {}, live: null, idleUntil: 0, paused: false, current: null, queued: [], recent: [], jobs: [], loopQueue: [], loopActive: null, counter: 1,
  };
  if (seed === "fresh") return base;
  const seeds = seed === "full" ? SCRIPT_SEEDS : SCRIPT_SEEDS.filter((s) => s.history !== "gone");
  const scripts: DemoScript[] = seeds.map((s) => ({
    path: scriptPath(s.folder, s.name),
    name: s.name,
    map: s.map,
    steps: s.steps,
    author: s.author,
    tags: s.tags,
    profile: { fixable: true, ...s.profile },
    ...(s.history === "gone" ? { missing: true } : {}),
  }));
  const { runs, qa, nights } = history(scripts, seeds, now, rand);
  if (seed === "empty") {
    // A solo developer's first look: scripts and runs, nothing organised yet.
    for (const r of runs) {
      if (r.source === "plan") r.source = "person";
      r.planRunId = null;
    }
    return { ...base, scripts, runs, qa };
  }
  // The stagger bug was filed from the newest failing run of its check.
  const filed = runs.filter((r) => r.target.endsWith("/PT_Stagger_Wisp") && r.outcome === "failed").sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0];
  if (filed) filed.links = [{ url: DEMO_LINKS.staggerBug, title: "Elite wisps ignore stagger", rel: "filed-from-run" }];
  // Someone runs the Vertical Slice before leaving each evening.
  const recent = [...nights.entries()]
    .sort(([a], [b]) => a - b)
    .slice(0, 6)
    .map(([d, rs]) => {
      const items = rs.slice().sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1)).map(itemFrom);
      return plan({ id: nightlyId(d), title: "Run Vertical Slice", scope: { kind: "goal", goalId: "vertical-slice" }, items, createdAt: items[0].startedAt!, startedAt: items[0].startedAt!, endedAt: items[items.length - 1].endedAt ?? null, state: "done" });
    });
  const queued = [
    plan({ id: "plan-seed-1", title: "Run Lantern combat lands hits and staggers enemies", scope: { kind: "goal", goalId: "lantern-combat" }, createdAt: iso(now - 2 * MIN), items: [
      { check: ref("Combat", "PT_Lantern_Strike"), name: "PT_Lantern_Strike", state: "queued" },
      { check: ref("Combat", "PT_Stagger_Wisp"), name: "PT_Stagger_Wisp", state: "queued" },
      { check: ref("Combat", "PT_Player_Damage"), name: "PT_Player_Damage", state: "queued" },
    ] }),
    plan({ id: "plan-seed-2", title: "Run Four players join a listen server", scope: { kind: "goal", goalId: "coop-join" }, createdAt: iso(now - MIN), items: [
      { check: ref("Coop", "PT_Coop_Join_Listen"), name: "PT_Coop_Join_Listen", state: "queued" },
      { check: ref("Coop", "PT_Coop_Join_Late"), name: "PT_Coop_Join_Late", state: "queued" },
      { check: ref("Coop", "PT_Coop_Lobby_Ready"), name: "PT_Coop_Lobby_Ready", state: "queued" },
    ] }),
  ];
  // A nightly run of the slice, and a weekday co-op check that waited for the editor and gave up.
  const schedules: Schedule[] = [
    { id: "sched-nightly", title: "Nightly: Vertical Slice", scope: { kind: "goal", goalId: "vertical-slice" }, options: planOptionsFor("schedule"), at: "02:00", days: [0, 1, 2, 3, 4, 5, 6], enabled: true, lastRunAt: null, lastSkipped: null, waiting: null, nextRunAt: null },
    { id: "sched-coop", title: "Co-op smoke test", scope: { kind: "goal", goalId: "coop-join" }, options: { ...planOptionsFor("schedule"), stopOnFailure: true }, at: "13:00", days: [1, 2, 3, 4, 5], enabled: true, lastRunAt: null, lastSkipped: "waited an hour: The editor is not connected", waiting: null, nextRunAt: null },
  ];
  for (const s of schedules) s.nextRunAt = demoNextRun(s, now);
  // The team's rule: a pass not run for two weeks is stale.
  return { ...base, goals: goals(), checkMetas: checkMetas(), rules: { ...DEFAULT_HEALTH_RULE, staleAfterDays: 14 }, scripts, runs, qa, recent, queued, schedules };
}

/** When a schedule next runs after `now`, in local time; null while it is off or names no day. */
export function demoNextRun(s: Pick<Schedule, "at" | "days" | "enabled">, now: number): string | null {
  const m = /^(\d{2}):(\d{2})$/.exec(s.at);
  if (!s.enabled || !m || s.days.length === 0) return null;
  const from = new Date(now);
  for (let d = 0; d <= 7; d++) {
    const t = new Date(from.getFullYear(), from.getMonth(), from.getDate() + d, Number(m[1]), Number(m[2]), 0, 0);
    if (t.getTime() > now && s.days.includes(t.getDay())) return t.toISOString();
  }
  return null;
}

/** Steps for scripts an agent writes for a goal: a believable first draft. */
export function demoWrittenScripts(goal: Pick<Goal, "id" | "title">, n: number): Array<{ name: string; steps: QaScriptStep[] }> {
  const word = goal.title.replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).filter((w) => w.length > 3).slice(0, 2).map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join("") || "Goal";
  const drafts = [
    { name: `PT_${word}_Basic`, steps: [auto("Start at the shrine and the pawn spawns", "Pawn.bSpawned", "eq", true, 3000), auto("Walk to the objective marker: pos_x increasing", "pos_x", "increasing", undefined, 6000), manual(`Check that "${goal.title}" holds on a first try`)] },
    { name: `PT_${word}_EdgeCases`, steps: [auto("Repeat the action quickly three times", "Input.ActionCount", "gt", 2, 3000), auto("No error is logged", "Log.ErrorCount", "eq", 0, 5000), manual("Check nothing looks off when the action is spammed")] },
    { name: `PT_${word}_Coop`, steps: [auto("The host and one client start together", "Session.PlayerCount", "eq", 2, 15000, "host"), auto("The client sees the same result", "Replication.bInSync", "eq", true, 5000, "client 1")] },
  ];
  return drafts.slice(0, n);
}

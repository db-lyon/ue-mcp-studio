/**
 * The demo project's answers for the playtest editor: what Ember Hollow's
 * open level lets a step name (as pie(script_values), its Input Actions and
 * levels come back through GET /qa/drafting/catalog), and a check of a draft
 * shaped like pie(script_validate)'s, with the closest names as candidates,
 * so the editor can be tried without an editor.
 */
import { qaScriptKey } from "@ue-mcp-studio/shared";

const MAPS = "/Game/EmberHollow/Maps";
const INPUT = "/Game/EmberHollow/Input";
const PAWN = "BP_Lanternbearer";

export const DEMO_LEVELS = ["L_Ashwood", "L_CinderKeep", "L_Coop_Lobby", "L_Tutorial_Glade"].map((n) => ({ path: `${MAPS}/${n}`, name: n }));
export const DEMO_CURRENT_LEVEL = `${MAPS}/L_Ashwood`;
export const DEMO_INPUTS = ["IA_Jump", "IA_Dodge", "IA_Attack", "IA_Sprint", "IA_Interact", "IA_Pause", "IA_LanternRaise", "IA_Move", "IA_Look", "IA_Crouch", "IA_Ready"].map((n) => `${INPUT}/${n}`);

const MOVEMENT = [["MOVE_None", 0], ["MOVE_Walking", 1], ["MOVE_NavWalking", 2], ["MOVE_Falling", 3], ["MOVE_Swimming", 4], ["MOVE_Flying", 5], ["MOVE_Custom", 6]] as const;
const LEDGE = [["None", 0], ["Reaching", 1], ["Hanging", 2], ["Mantling", 3]] as const;
const DOWNED = [["Standing", 0], ["Downed", 1], ["Reviving", 2]] as const;
const en = (rows: ReadonlyArray<readonly [string, number]>) => rows.map(([name, value]) => ({ name, value }));

interface DemoValue {
  path: string;
  kind: "number" | "integer" | "boolean" | "enum";
  type: string;
  values?: Array<{ name: string; value: number }>;
}

export const DEMO_VALUES: DemoValue[] = [
  { path: "JumpCurrentCount", kind: "integer", type: "int32" },
  { path: "JumpMaxCount", kind: "integer", type: "int32" },
  { path: "JumpMaxHoldTime", kind: "number", type: "float" },
  { path: "bIsCrouched", kind: "boolean", type: "bool" },
  { path: "BaseEyeHeight", kind: "number", type: "float" },
  { path: "Stamina", kind: "number", type: "float" },
  { path: "MaxStamina", kind: "number", type: "float" },
  { path: "CharacterMovement.MovementMode", kind: "enum", type: "EMovementMode", values: en(MOVEMENT) },
  { path: "CharacterMovement.MaxWalkSpeed", kind: "number", type: "float" },
  { path: "CharacterMovement.JumpZVelocity", kind: "number", type: "float" },
  { path: "CharacterMovement.GravityScale", kind: "number", type: "float" },
  { path: "CharacterMovement.bOrientRotationToMovement", kind: "boolean", type: "bool" },
  { path: "CollisionCylinder.CapsuleHalfHeight", kind: "number", type: "float" },
  { path: "LanternComponent.Intensity", kind: "number", type: "float" },
  { path: "LanternComponent.bRaised", kind: "boolean", type: "bool" },
  { path: "Traversal.LedgeState", kind: "enum", type: "ELedgeState", values: en(LEDGE) },
  { path: "Combat.ComboIndex", kind: "integer", type: "int32" },
  { path: "Player.Health", kind: "number", type: "float" },
  { path: "Player.bInvulnerable", kind: "boolean", type: "bool" },
  { path: "Player.DownedState", kind: "enum", type: "EDownedState", values: en(DOWNED) },
  { path: "Player.bSpectating", kind: "boolean", type: "bool" },
  { path: "Player.BleedOut", kind: "number", type: "float" },
  { path: "Player.SpawnShrine", kind: "integer", type: "int32" },
  { path: "Player.DistanceToShrine", kind: "number", type: "float" },
  { path: "Camera.FOV", kind: "number", type: "float" },
  { path: "Camera.ArmLength", kind: "number", type: "float" },
  { path: "Inventory.EmberShards", kind: "integer", type: "int32" },
  { path: "Dodge.Distance", kind: "number", type: "float" },
  { path: "Jump.PeakHeight", kind: "number", type: "float" },
  { path: "Audio.Footstep.Surface", kind: "integer", type: "uint8" },
];
const CHANNELS = ["pos_x", "pos_y", "pos_z", "vel_x", "vel_y", "vel_z", "rot_pitch", "rot_yaw", "rot_roll", "speed2d"];
const PROFILE = [
  "Pawn.Velocity.Size", "CharacterMovement.Velocity.Size", "Wisp.Health", "Wisp.StaggerMeter", "Wisp.bStaggered", "Boss.Health", "Boss.Phase", "Boss.AddCount", "Boss.bStormActive",
  "Session.State", "Session.PlayerCount", "Streaming.L_Ashwood.Loaded", "World.TimeDilation", "Stats.FrameTimeMs", "Stats.MaxHitchMs", "SaveGame.Slot0.Exists", "SaveGame.Slot1.Timestamp",
  "Lobby.ReadyCount", "Loot.DropCount", "Relic.OwnerIndex", "Revive.Progress", "Lantern.ColorIndex", "Fishing.State",
];
const ACTORS = ["BP_Wisp_Dummy", "BP_Wisp_Elite", "BP_Chest_Ember", "BP_Shrine_01", "BP_Shrine_02", "BP_EmberVent", "BP_Door_Keep", "BP_FallenLog", "BP_BrokenPillar", "BP_Relic_Ember", "BP_Thornwall_Tutorial", "PlayerStart", "DirectionalLight", "SkyAtmosphere"];
const SPAWNED = [PAWN, "BP_Wisp_Minion"];
const WIDGETS = ["WBP_HUD", "WBP_PauseMenu", "WBP_Settings", "WBP_StaminaRing", "WBP_DamageVignette", "WBP_ChapterTitle", "WBP_Prompt_Move", "WBP_Prompt_Jump", "WBP_ConfirmOverwrite", "WBP_LobbyCountdown", "WBP_Inventory"];

/** GET /qa/drafting/catalog's answer for the demo project. */
export function demoCatalog(): Record<string, unknown> {
  return {
    values: {
      success: true,
      pawn: { class: `/Game/EmberHollow/Characters/${PAWN}.${PAWN}_C`, source: "player 0's pawn", components: ["CollisionCylinder", "CharacterMovement", "LanternComponent", "Traversal", "Combat"] },
      pawn_channels: CHANNELS,
      values: DEMO_VALUES,
      truncated: false,
      profile_values: PROFILE,
      actors: ACTORS,
      spawned_classes: SPAWNED,
      widgets: WIDGETS,
    },
    inputActions: DEMO_INPUTS,
    levels: DEMO_LEVELS,
    currentLevel: DEMO_CURRENT_LEVEL,
    gaps: [],
  };
}

export interface DemoFinding {
  step: number | null;
  field: string;
  message: string;
  candidates?: string[];
}

function distance(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  const row = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (x[i - 1] === y[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[y.length];
}

/** The closest names to what was written, best first. */
export function closest(word: string, pool: readonly string[], n = 4): string[] {
  const leaf = (s: string) => s.split("/").pop() ?? s;
  const scored = [...pool].map((p) => ({ p, d: Math.min(distance(word, p), distance(leaf(word), leaf(p))) })).sort((a, b) => a.d - b.d);
  // Only names near enough to be what was meant, as ue-mcp offers them.
  const near = scored.filter((x) => x.d <= Math.max(3, Math.ceil(leaf(word).length / 3)));
  return (near.length ? near : scored.slice(0, 1)).slice(0, n).map((x) => x.p);
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const OPS = ["decreasing", "increasing", "eq", "gt", "lt", "visible", "exists", "triggered"];
const NUMERIC = new Set(["decreasing", "increasing", "eq", "gt", "lt"]);

/**
 * A draft checked the way pie(script_validate) checks one, against the demo's
 * level: every finding with the step, the field and the closest valid names.
 */
export function demoValidate(steps: unknown, map: string, manualOnly: boolean): DemoFinding[] {
  const out: DemoFinding[] = [];
  const list = Array.isArray(steps) ? steps : [];
  if (list.length === 0) out.push({ step: null, field: "steps", message: "steps must hold at least one step" });
  if (map && !DEMO_LEVELS.some((l) => l.path === qaScriptKey(map))) {
    out.push({ step: null, field: "map", message: `map '${map}' is not a level asset`, candidates: closest(map, DEMO_LEVELS.map((l) => l.path), 3) });
  }
  const numeric = [...DEMO_VALUES.map((v) => v.path), ...CHANNELS, ...PROFILE];
  const inputs = DEMO_INPUTS;
  let anyAuto = false;
  list.forEach((raw, i) => {
    const s = rec(raw);
    const at = `steps[${i}]`;
    const pie = s.resolve_in_pie === true;
    const acts = Array.isArray(s.act) ? s.act : [];
    acts.forEach((a, j) => {
      const o = rec(a);
      for (const verb of ["press", "hold"]) {
        const b = rec(o[verb]);
        if (o[verb] === undefined) continue;
        const action = typeof b.action === "string" ? qaScriptKey(b.action) : "";
        if (!inputs.includes(action)) out.push({ step: i, field: `act[${j}].${verb}.action`, message: `${at}.act[${j}].${verb}.action: Input Action '${action}' not found`, candidates: closest(action, inputs) });
      }
      const place = rec(o.place);
      if (o.place !== undefined && typeof place.at === "string" && !pie && !ACTORS.includes(place.at)) {
        out.push({ step: i, field: `act[${j}].place.at`, message: `${at}.act[${j}].place.at: no actor '${place.at}' in L_Ashwood. If it only exists once PIE is running, set resolve_in_pie: true on the step.`, candidates: closest(place.at, ACTORS) });
      }
    });
    const e = s.expect === undefined ? null : rec(s.expect);
    if (s.judge === "manual") {
      if (e) out.push({ step: i, field: "expect", message: `${at}.expect: a manual step takes no expect` });
      return;
    }
    if (!e) return;
    anyAuto = true;
    const value = typeof e.value === "string" ? e.value : "";
    const op = typeof e.op === "string" ? e.op : "";
    if (!OPS.includes(op)) {
      out.push({ step: i, field: "expect.op", message: `${at}.expect.op '${op}' is unknown (${OPS.join(", ")})`, candidates: ["eq", "gt", "lt"] });
      return;
    }
    if (op === "triggered") {
      if (!inputs.includes(qaScriptKey(value))) out.push({ step: i, field: "expect.value", message: `${at}.expect.value: Input Action '${value}' not found`, candidates: closest(value, inputs) });
      return;
    }
    if (op === "visible") {
      if (!WIDGETS.includes(value)) out.push({ step: i, field: "expect.value", message: `${at}.expect.value: no widget class or Widget Blueprint named ${value}`, candidates: closest(value, WIDGETS) });
      return;
    }
    if (op === "exists") {
      if (!pie && !ACTORS.includes(value) && !SPAWNED.includes(value)) out.push({ step: i, field: "expect.value", message: `${at}.expect.value: no actor '${value}' in the level, and the game mode spawns no such class. If it only exists once PIE is running, set resolve_in_pie: true on the step.`, candidates: closest(value, [...ACTORS, ...SPAWNED]) });
      return;
    }
    if (!NUMERIC.has(op)) return;
    const known = DEMO_VALUES.find((v) => v.path === value || v.path.split(".").pop() === value);
    if (!known && !numeric.includes(value)) {
      if (!pie) out.push({ step: i, field: "expect.value", message: `${at}.expect.value: '${value}' cannot be read: ${PAWN} has no property or component named ${value} (the observer reads it from the player pawn, ${PAWN}, the DefaultPawnClass of BP_EmberGameMode). If it only exists once PIE is running, set resolve_in_pie: true on the step.`, candidates: closest(value, numeric) });
      return;
    }
    if (known?.kind === "boolean" && !(op === "eq" && typeof e.target === "boolean")) {
      out.push({ step: i, field: "expect.op", message: `${at}.expect.op: ${value} is a bool, so it takes only eq with true or false`, candidates: ["eq"] });
    } else if (known?.kind === "enum" && known.values && !(op === "eq" && known.values.some((v) => v.value === e.target))) {
      out.push({ step: i, field: "expect.target", message: `${at}.expect.target: ${String(e.target ?? "nothing")} is not a value of ${known.type} (${known.values.map((v) => `${v.name}=${v.value}`).join(", ")})`, candidates: known.values.map((v) => String(v.value)) });
    } else if ((op === "eq" || op === "gt" || op === "lt") && typeof e.target !== "number") {
      out.push({ step: i, field: "expect.target", message: `${at}.expect.target: ${op} needs a number target` });
    } else if (known?.kind === "integer" && op === "eq" && typeof e.target === "number" && !Number.isInteger(e.target)) {
      out.push({ step: i, field: "expect.target", message: `${at}.expect.target: ${value} is an ${known.type} and can never equal ${e.target}`, candidates: [String(Math.round(e.target))] });
    }
  });
  if (list.length && !anyAuto && !manualOnly) out.push({ step: null, field: "steps", message: "A script needs an auto step with an expect, or manual_only: true", candidates: ["manual_only"] });
  return out;
}

/**
 * The Playtest Hub's playtest editor without the drawing: the catalog of what
 * a step can name (ue-mcp's pie(script_values), the project's Input Actions
 * and levels), the draft and its steps, which operators suit which value, the
 * sentence each step reads as, the steps as ue-mcp's script format, the checks
 * made before ue-mcp is asked, and ue-mcp's own findings anchored to the step
 * and field they are about, with its candidates as fixes.
 */
import { checkId, leafName, qaScriptKey } from "@ue-mcp-studio/shared";
import type { HubRequest } from "./hub.js";

// ---------- The catalog ----------

/** What a value is, which decides the operators it takes. */
export type SubjectKind = "number" | "integer" | "boolean" | "enum" | "actor" | "widget" | "input";
/** Where a value comes from, as the picker groups them. */
export type SubjectGroup = "pawn" | "channel" | "profile" | "actor" | "widget" | "input";

export interface EnumValue {
  name: string;
  value: number;
}

/** One thing a step can check: a value path, an actor, a widget or an Input Action. */
export interface Subject {
  /** What the step names: the path ue-mcp reads. */
  path: string;
  /** What a person reads: the path, or an asset's short name. */
  label: string;
  kind: SubjectKind;
  group: SubjectGroup;
  /** The type in Unreal's words (float, int32, bool, EMovementMode), or the group's word. */
  type: string;
  enumValues?: EnumValue[];
}

export interface DraftCatalog {
  subjects: Subject[];
  /** Input Actions, by package path: what press and hold drive. */
  inputActions: Subject[];
  /** Actor labels in the open level: what place moves the player next to. */
  actors: string[];
  levels: Array<{ path: string; name: string }>;
  /** The level open in the editor, by package path: the one the values were read from. */
  currentLevel: string | null;
  /** The player pawn's class, as ue-mcp found it. */
  pawnClass: string | null;
  /** The value list was cut at ue-mcp's limit. */
  truncated: boolean;
  /** Parts that could not be read. */
  gaps: string[];
}

export const EMPTY_CATALOG: DraftCatalog = { subjects: [], inputActions: [], actors: [], levels: [], currentLevel: null, pawnClass: null, truncated: false, gaps: [] };

/** The picker's groups, in the order it lists them. */
export const SUBJECT_GROUPS: ReadonlyArray<{ id: SubjectGroup; label: string }> = [
  { id: "pawn", label: "Player pawn" },
  { id: "channel", label: "Pawn movement" },
  { id: "profile", label: "Profile values" },
  { id: "actor", label: "Actors in the level" },
  { id: "widget", label: "Widgets" },
  { id: "input", label: "Input actions" },
];

/** What the movement channels are, since ue-mcp lists only their names. */
const CHANNEL_NOTE: Record<string, string> = {
  pos_x: "position x", pos_y: "position y", pos_z: "position z",
  vel_x: "velocity x", vel_y: "velocity y", vel_z: "velocity z",
  rot_pitch: "pitch", rot_yaw: "yaw", rot_roll: "roll", speed2d: "ground speed",
};

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : []);

/** An Input Action's name as a person says it: IA_Jump is Jump. */
export function inputLabel(path: string): string {
  const leaf = leafName(path.split(".")[0] ?? path);
  return leaf.replace(/^IA_/i, "") || leaf;
}

/** A level's short name: /Game/Maps/L_Arena is L_Arena. */
export const levelName = (path: string): string => leafName(qaScriptKey(path));

/**
 * The catalog from GET /qa/drafting/catalog: { values (pie(script_values)),
 * inputActions, levels, currentLevel, gaps }. Anything missing is empty.
 */
export function draftCatalogOf(raw: unknown): DraftCatalog {
  const r = rec(raw) ?? {};
  const v = rec(r.values) ?? {};
  const subjects: Subject[] = [];
  const seen = new Set<string>();
  const add = (s: Subject) => {
    const key = `${s.group}:${s.path}`;
    if (seen.has(key)) return;
    seen.add(key);
    subjects.push(s);
  };
  for (const row of Array.isArray(v.values) ? v.values : []) {
    const o = rec(row);
    if (!o || typeof o.path !== "string" || !o.path) continue;
    const kind: SubjectKind = o.kind === "integer" || o.kind === "boolean" || o.kind === "enum" ? o.kind : "number";
    const enumValues = (Array.isArray(o.values) ? o.values : []).flatMap((e) => {
      const x = rec(e);
      return x && typeof x.name === "string" && typeof x.value === "number" ? [{ name: x.name, value: x.value }] : [];
    });
    add({ path: o.path, label: o.path, kind: kind === "enum" && enumValues.length === 0 ? "integer" : kind, group: "pawn", type: typeof o.type === "string" && o.type ? o.type : kind, ...(enumValues.length ? { enumValues } : {}) });
  }
  for (const c of strs(v.pawn_channels)) add({ path: c, label: c, kind: "number", group: "channel", type: CHANNEL_NOTE[c] ?? "number" });
  for (const p of strs(v.profile_values)) add({ path: p, label: p, kind: "number", group: "profile", type: "tracked" });
  const actors = strs(v.actors);
  for (const a of actors) add({ path: a, label: a, kind: "actor", group: "actor", type: "actor" });
  for (const c of strs(v.spawned_classes)) add({ path: c, label: c, kind: "actor", group: "actor", type: "spawned" });
  for (const w of strs(v.widgets)) add({ path: w, label: w, kind: "widget", group: "widget", type: "widget" });
  const inputActions: Subject[] = [];
  for (const p of strs(r.inputActions)) {
    const s: Subject = { path: qaScriptKey(p), label: inputLabel(p), kind: "input", group: "input", type: "input" };
    inputActions.push(s);
    add(s);
  }
  const levels = (Array.isArray(r.levels) ? r.levels : []).flatMap((l) => {
    const o = rec(l);
    return o && typeof o.path === "string" ? [{ path: qaScriptKey(o.path), name: typeof o.name === "string" ? o.name : levelName(o.path) }] : [];
  });
  levels.sort((a, b) => a.name.localeCompare(b.name));
  const pawn = rec(v.pawn);
  return {
    subjects,
    inputActions,
    actors,
    levels,
    currentLevel: typeof r.currentLevel === "string" && r.currentLevel ? qaScriptKey(r.currentLevel) : null,
    pawnClass: pawn && typeof pawn.class === "string" ? pawn.class : null,
    truncated: v.truncated === true,
    gaps: strs(r.gaps),
  };
}

/** The subject a step names, or null when the catalog has no such thing (typed by hand, or only in PIE). */
export function findSubject(catalog: DraftCatalog, path: string, op?: string): Subject | null {
  if (!path) return null;
  const want = op === "triggered" ? "input" : op === "visible" ? "widget" : op === "exists" ? "actor" : null;
  const matches = catalog.subjects.filter((s) => s.path === path || (s.kind === "input" && qaScriptKey(path) === s.path));
  return matches.find((s) => (want ? s.kind === want : s.kind !== "actor" && s.kind !== "widget" && s.kind !== "input")) ?? matches[0] ?? null;
}

/** The subjects matching what is typed, best first, each group kept together in the picker's order. */
export function searchSubjects(subjects: readonly Subject[], query: string, max = 200): Subject[] {
  const q = query.trim().toLowerCase();
  const order = (s: Subject) => SUBJECT_GROUPS.findIndex((g) => g.id === s.group);
  if (!q) return [...subjects].sort((a, b) => order(a) - order(b)).slice(0, max);
  const scored = subjects.flatMap((s) => {
    const hay = `${s.label} ${s.path}`.toLowerCase();
    const at = hay.indexOf(q);
    if (at >= 0) return [{ s, score: (s.label.toLowerCase().startsWith(q) ? 0 : 1) + at / 1000 }];
    // Each letter in order: "jcc" finds JumpCurrentCount.
    let i = 0;
    for (const ch of hay) if (ch === q[i]) i++;
    return i === q.length ? [{ s, score: 2 }] : [];
  });
  return scored.sort((a, b) => order(a.s) - order(b.s) || a.score - b.score).slice(0, max).map((x) => x.s);
}

// ---------- Operators ----------

/** One choice in the operator picker: ue-mcp's op, and the target it fixes, if it fixes one. */
export interface OpChoice {
  id: string;
  op: string;
  label: string;
  /** A target the choice sets itself: true or false. */
  target?: "true" | "false";
  /** What the target field asks for: a number, one of the enum's values, an optional least change, or nothing. */
  needs: "number" | "enum" | "least" | null;
}

const NUMBER_CHOICES: OpChoice[] = [
  { id: "gt", op: "gt", label: "is greater than", needs: "number" },
  { id: "lt", op: "lt", label: "is less than", needs: "number" },
  { id: "eq", op: "eq", label: "equals", needs: "number" },
  { id: "increasing", op: "increasing", label: "increases", needs: "least" },
  { id: "decreasing", op: "decreasing", label: "decreases", needs: "least" },
];
const BOOL_CHOICES: OpChoice[] = [
  { id: "is-true", op: "eq", label: "is true", target: "true", needs: null },
  { id: "is-false", op: "eq", label: "is false", target: "false", needs: null },
];
const ENUM_CHOICES: OpChoice[] = [{ id: "is", op: "eq", label: "is", needs: "enum" }];
const WIDGET_CHOICES: OpChoice[] = [
  { id: "visible", op: "visible", label: "is visible", target: "true", needs: null },
  { id: "hidden", op: "visible", label: "is hidden", target: "false", needs: null },
];
const ACTOR_CHOICES: OpChoice[] = [
  { id: "exists", op: "exists", label: "exists", target: "true", needs: null },
  { id: "gone", op: "exists", label: "is gone", target: "false", needs: null },
];
const INPUT_CHOICES: OpChoice[] = [{ id: "triggered", op: "triggered", label: "is triggered", needs: null }];

/**
 * The operators a value takes, by its kind (ue-mcp's rule: a bool only eq with
 * true or false, an enum only eq with one of its values, a number a number
 * target). A value the catalog does not know (null) takes any of them.
 */
export function opChoices(kind: SubjectKind | null): OpChoice[] {
  switch (kind) {
    case "number":
    case "integer": return NUMBER_CHOICES;
    case "boolean": return BOOL_CHOICES;
    case "enum": return ENUM_CHOICES;
    case "widget": return WIDGET_CHOICES;
    case "actor": return ACTOR_CHOICES;
    case "input": return INPUT_CHOICES;
    default: return [...NUMBER_CHOICES, ...BOOL_CHOICES, ...WIDGET_CHOICES, ...ACTOR_CHOICES, ...INPUT_CHOICES];
  }
}

const truthy = (t: string): "true" | "false" | null => (/^(true|1)$/i.test(t.trim()) ? "true" : /^(false|0)$/i.test(t.trim()) ? "false" : null);

/** The choice a step's op and target are, among those its value takes; null when none fits. */
export function choiceOf(step: Pick<DraftStep, "op" | "target">, kind: SubjectKind | null): OpChoice | null {
  const choices = opChoices(kind).filter((c) => c.op === step.op);
  const t = step.target.trim() === "" && (step.op === "visible" || step.op === "exists") ? "true" : truthy(step.target);
  // eq on a number takes any target; eq on a bool only true or false.
  return choices.find((c) => !c.target) ?? choices.find((c) => c.target === t) ?? null;
}

/** The choice a value starts with when it is picked. */
function defaultChoice(kind: SubjectKind | null): OpChoice {
  if (kind === "integer") return NUMBER_CHOICES[2];
  return opChoices(kind)[0];
}

/** A step given another operator: the target kept where it still fits, else cleared or set. */
export function withChoice<S extends DraftStep>(step: S, choice: OpChoice, subject: Subject | null): S {
  let target = step.target;
  if (choice.target) target = choice.target;
  else if (choice.needs === "enum") target = subject?.enumValues?.some((e) => String(e.value) === step.target) ? step.target : String(subject?.enumValues?.[0]?.value ?? "");
  else if (choice.needs === "number" || choice.needs === "least") target = numberText(step.target) !== null ? step.target : "";
  else target = "";
  return { ...step, op: choice.op, target };
}

/** A step given another value: its operator kept when the value takes it, else the value's default. */
export function withSubject<S extends DraftStep>(step: S, path: string, subject: Subject | null, opts: { inPie?: boolean } = {}): S {
  const kind = subject?.kind ?? null;
  const next = { ...step, value: path, resolveInPie: subject ? false : opts.inPie ?? step.resolveInPie };
  const kept = step.value && step.op ? choiceOf(step, kind) : null;
  return withChoice(next, kept ?? defaultChoice(kind), subject);
}

// ---------- The draft ----------

export type ActVerb = "press" | "hold" | "wait" | "place" | "console";

/** What the engine does before the check, one entry of ue-mcp's act. */
export interface DraftAct {
  id: string;
  verb: ActVerb | "other";
  /** press and hold: the Input Action, by package path. */
  action: string;
  /** hold and wait: seconds, as typed. */
  seconds: string;
  /** hold: the value held, "1" or "0, 1", as typed. */
  value: string;
  /** place: the actor the player is put next to. */
  at: string;
  /** console: the command. */
  command: string;
  /** The entry as written, for the fields this editor does not draw (frames, offset, face, client) and verbs it does not edit. */
  raw: Record<string, unknown>;
}

export interface DraftStep {
  id: string;
  judge: "auto" | "manual";
  /** Manual: what a person checks. Auto: what the person playing is told; empty, the step's sentence. */
  instruction: string;
  acts: DraftAct[];
  /** Auto: what is checked. */
  value: string;
  op: string;
  /** As typed: a number, true or false, or an enum's value. */
  target: string;
  /** Seconds, as typed; empty uses the playtest's default. */
  within: string;
  agentJudgeable: boolean;
  /** The value or the actors named exist only once PIE runs, so saving does not check them. */
  resolveInPie: boolean;
  /** Which player in a multiplayer playtest, kept as Studio keeps it. */
  player: string;
  /** Step fields this editor does not draw (arrange, anything newer), kept as written. */
  keep: Record<string, unknown>;
  /** expect fields this editor does not draw (client), kept as written. */
  keepExpect: Record<string, unknown>;
}

export interface Draft {
  /** The asset name: typed for a new playtest, fixed for a saved one. */
  name: string;
  /** A saved playtest's asset path; null for a new one. */
  path: string | null;
  /** The level it plays in, by package path; empty plays whatever level is open. */
  map: string;
  /** What a step with no time limit of its own gets, in ms. */
  defaultWithinMs: number;
  steps: DraftStep[];
}

/** Where new playtests are saved, as pie(script_create) saves them. */
export const DRAFT_SCRIPTS_DIR = "/Game/PIEStudio/Scripts";
export const DRAFT_DEFAULT_WITHIN_MS = 5000;

let seq = 0;
const nextId = (p: string) => `${p}${++seq}`;

export function draftAct(verb: ActVerb, raw: Record<string, unknown> = {}): DraftAct {
  return { id: nextId("a"), verb, action: "", seconds: verb === "wait" ? "0.5" : verb === "hold" ? "1" : "", value: "1", at: "", command: "", raw };
}

export function draftStep(judge: "auto" | "manual"): DraftStep {
  return { id: nextId("s"), judge, instruction: "", acts: [], value: "", op: "", target: "", within: "", agentJudgeable: true, resolveInPie: false, player: "", keep: {}, keepExpect: {} };
}

export function emptyDraft(map: string | null): Draft {
  return { name: "", path: null, map: map ?? "", defaultWithinMs: DRAFT_DEFAULT_WITHIN_MS, steps: [draftStep("auto")] };
}

/** Seconds as typed, or null when it is no positive number. */
export function numberText(t: string): number | null {
  const s = t.trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
const positive = (t: string): number | null => {
  const n = numberText(t);
  return n !== null && n > 0 ? n : null;
};
/** ms as seconds for a field: 1500 is "1.5". */
const secondsOf = (ms: unknown): string => (typeof ms === "number" && ms > 0 ? String(Math.round(ms) / 1000) : "");

/** A duration in words: 1000 is "1 s", 250 is "0.25 s", 90000 is "90 s". */
export function durationText(ms: number): string {
  const s = Math.round(ms) / 1000;
  return `${Number.isInteger(s) ? s : Number(s.toFixed(2))} s`;
}

function actOf(entry: unknown): DraftAct {
  const raw = rec(entry) ?? {};
  const [verb, body] = Object.entries(raw).find(([k]) => k !== "client") ?? ["", undefined];
  const b = rec(body) ?? {};
  const act = draftAct("press", raw);
  if (verb === "press" && typeof b.action === "string") return { ...act, verb: "press", action: qaScriptKey(b.action) };
  if (verb === "hold" && typeof b.action === "string") {
    const v = b.value;
    return { ...act, verb: "hold", action: qaScriptKey(b.action), seconds: secondsOf(b.ms), value: Array.isArray(v) ? v.join(", ") : v === undefined ? "1" : typeof v === "boolean" ? (v ? "1" : "0") : String(v) };
  }
  if (verb === "wait_ms" && typeof body === "number") return { ...act, verb: "wait", seconds: secondsOf(body) };
  if (verb === "place" && typeof b.at === "string") return { ...act, verb: "place", at: b.at };
  if (verb === "console" && typeof body === "string") return { ...act, verb: "console", command: body };
  return { ...act, verb: "other" };
}

/**
 * A saved script as the editor holds it, from GET /qa/drafting/script:
 * pie(script_read)'s answer and Studio's players. Every field it does not
 * draw is kept, so saving it back changes only what was edited.
 */
export function draftFromScript(script: unknown, players: Record<number, string> = {}): Draft {
  const s = rec(script) ?? {};
  const path = typeof s.path === "string" ? qaScriptKey(s.path) : null;
  const within = typeof s.default_within_ms === "number" && s.default_within_ms > 0 ? s.default_within_ms : DRAFT_DEFAULT_WITHIN_MS;
  const steps = (Array.isArray(s.steps) ? s.steps : []).map((x, i): DraftStep => {
    const o = rec(x) ?? {};
    const { instruction, judge, expect, agent_judgeable, resolve_in_pie, act, player, ...keep } = o;
    const e = rec(expect);
    const { value, op, target, within_ms, ...keepExpect } = e ?? {};
    const isManual = judge === "manual";
    return {
      ...draftStep(isManual ? "manual" : "auto"),
      instruction: typeof instruction === "string" ? instruction : "",
      acts: (Array.isArray(act) ? act : act ? [act] : []).map(actOf),
      value: typeof value === "string" ? (op === "triggered" ? qaScriptKey(value) : value) : "",
      op: typeof op === "string" ? op : "",
      target: target === undefined || target === null ? "" : String(target),
      within: secondsOf(within_ms),
      agentJudgeable: agent_judgeable !== false,
      resolveInPie: resolve_in_pie === true,
      player: typeof player === "string" ? player : players[i] ?? "",
      keep,
      keepExpect,
    };
  });
  return { name: typeof s.name === "string" ? s.name : path ? leafName(path) : "", path, map: typeof s.map === "string" ? qaScriptKey(s.map) : "", defaultWithinMs: within, steps };
}

/** What a typed name saves as: letters, digits and underscores, spaces and dashes made underscores. */
export function assetNameOf(text: string): string {
  return text.trim().replace(/[\s-]+/g, "_").replace(/[^A-Za-z0-9_]/g, "").replace(/_+/g, "_");
}

export const scriptPathOf = (name: string): string => `${DRAFT_SCRIPTS_DIR}/${assetNameOf(name)}`;
/** The hub's id for the playtest a draft is or will be. */
export const draftCheckId = (d: Pick<Draft, "path" | "name">): string => checkId({ kind: "script", target: d.path ?? scriptPathOf(d.name) });

// ---------- Editing ----------

export function moveDraftStep(d: Draft, id: string, by: number): Draft {
  const i = d.steps.findIndex((s) => s.id === id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= d.steps.length) return d;
  const steps = [...d.steps];
  [steps[i], steps[j]] = [steps[j], steps[i]];
  return { ...d, steps };
}

export function duplicateDraftStep(d: Draft, id: string): { draft: Draft; id: string | null } {
  const i = d.steps.findIndex((s) => s.id === id);
  if (i < 0) return { draft: d, id: null };
  const src = d.steps[i];
  const copy: DraftStep = { ...src, id: nextId("s"), acts: src.acts.map((a) => ({ ...a, id: nextId("a") })) };
  const steps = [...d.steps];
  steps.splice(i + 1, 0, copy);
  return { draft: { ...d, steps }, id: copy.id };
}

/** A draft with fresh ids for its steps and actions, as one kept from an earlier page is read back. */
export const reIdDraft = (d: Draft): Draft => ({ ...d, steps: d.steps.map((s) => ({ ...s, id: nextId("s"), acts: s.acts.map((a) => ({ ...a, id: nextId("a") })) })) });

/** A draft kept in storage, or null when it is not one. */
export function draftOfStored(v: unknown): Draft | null {
  const d = rec(v);
  if (!d || typeof d.name !== "string" || typeof d.map !== "string" || !Array.isArray(d.steps)) return null;
  if (!d.steps.every((s) => rec(s) && typeof (s as DraftStep).id === "string" && Array.isArray((s as DraftStep).acts))) return null;
  return reIdDraft({ name: d.name, path: typeof d.path === "string" ? d.path : null, map: d.map, defaultWithinMs: typeof d.defaultWithinMs === "number" ? d.defaultWithinMs : DRAFT_DEFAULT_WITHIN_MS, steps: d.steps as DraftStep[] });
}

export const removeDraftStep =(d: Draft, id: string): Draft => ({ ...d, steps: d.steps.filter((s) => s.id !== id) });
export const updateDraftStep = (d: Draft, id: string, f: (s: DraftStep) => DraftStep): Draft => ({ ...d, steps: d.steps.map((s) => (s.id === id ? f(s) : s)) });

/** A step switched between the observer and a person, keeping what it had for the other. */
export function withJudge(step: DraftStep, judge: "auto" | "manual"): DraftStep {
  return { ...step, judge };
}

// ---------- The sentence ----------

/** One piece of a step's sentence: words, or a part the person chose (or has yet to). */
export type SentencePart =
  | { text: string }
  | { token: string; role: "action" | "value" | "op" | "target" | "time" | "actor" | "command" | "instruction"; missing?: boolean; title?: string };

const T = (token: string, role: Extract<SentencePart, { token: string }>["role"], missing = false, title?: string): SentencePart => ({ token, role, ...(missing ? { missing } : {}), ...(title ? { title } : {}) });

function actParts(a: DraftAct): SentencePart[] {
  switch (a.verb) {
    case "press": return [{ text: "press " }, a.action ? T(inputLabel(a.action), "action", false, a.action) : T("an input", "action", true)];
    case "hold": {
      const secs = positive(a.seconds);
      const value = a.value.trim() && a.value.trim() !== "1" ? [{ text: " at " }, T(a.value.trim(), "target")] : [];
      return [{ text: "hold " }, a.action ? T(inputLabel(a.action), "action", false, a.action) : T("an input", "action", true), ...value, { text: " for " }, secs ? T(durationText(secs * 1000), "time") : T("some time", "time", true)];
    }
    case "wait": {
      const secs = positive(a.seconds);
      return [{ text: "wait " }, secs ? T(durationText(secs * 1000), "time") : T("some time", "time", true)];
    }
    case "place": return [{ text: "place the player at " }, a.at ? T(a.at, "actor") : T("an actor", "actor", true)];
    case "console": return [{ text: "run " }, a.command.trim() ? T(a.command.trim(), "command") : T("a command", "command", true)];
    default: {
      const [verb, body] = Object.entries(a.raw).find(([k]) => k !== "client") ?? ["act", null];
      const b = rec(body);
      const what = b ? ["action", "at", "key", "text"].map((k) => b[k]).find((x) => typeof x === "string") : typeof body === "string" ? body : null;
      return [{ text: verb === "capture" ? "take a capture" : verb === "key" ? "send the key " : `${verb} ` }, ...(typeof what === "string" && verb !== "capture" ? [T(verb === "tape" || verb === "inject" ? inputLabel(what) : what, "action")] : [])];
    }
  }
}

/** One action on its own, as its row reads where the editor does not draw its fields: "Tape Move". */
export function actSentence(a: DraftAct): SentencePart[] {
  const parts = actParts(a);
  const first = parts[0];
  return first && "text" in first ? [{ text: first.text.charAt(0).toUpperCase() + first.text.slice(1) }, ...parts.slice(1)] : parts;
}

function targetToken(step: DraftStep, choice: OpChoice | null, subject: Subject | null): SentencePart[] {
  if (!choice?.needs) return [];
  const t = step.target.trim();
  if (choice.needs === "enum") {
    const name = subject?.enumValues?.find((e) => String(e.value) === t)?.name;
    return [{ text: " " }, t ? T(name ?? t, "target") : T("a value", "target", true)];
  }
  if (choice.needs === "least") return numberText(t) && Number(t) > 0 ? [{ text: " by at least " }, T(t, "target")] : [];
  return [{ text: " " }, numberText(t) !== null ? T(t, "target") : T("a number", "target", true)];
}

/**
 * A step as one sentence: what the engine does, then what is checked and
 * how long it has, "Press Jump, then JumpCurrentCount is greater than 0
 * within 1 s". Parts not chosen yet read as what they should be.
 */
export function stepSentence(step: DraftStep, catalog: DraftCatalog, defaultWithinMs = DRAFT_DEFAULT_WITHIN_MS): SentencePart[] {
  const out: SentencePart[] = [];
  step.acts.forEach((a, i) => {
    if (i > 0) out.push({ text: ", " });
    out.push(...actParts(a));
  });
  if (out.length) out.push({ text: ", then " });
  if (step.judge === "manual") {
    out.push({ text: "a person judges: " }, step.instruction.trim() ? T(step.instruction.trim(), "instruction") : T("what to check", "instruction", true));
    if (!step.agentJudgeable) out.push({ text: " (a person only)" });
  } else {
    const subject = findSubject(catalog, step.value, step.op);
    const kind = subject?.kind ?? null;
    const choice = step.value ? choiceOf(step, kind) : null;
    const name = subject ? subject.label : step.value;
    if (step.op === "triggered") out.push({ text: "the player triggers " }, step.value ? T(name, "value", false, step.value) : T("an input", "value", true));
    else {
      out.push(step.value ? T(name, "value", false, step.value !== name ? step.value : undefined) : T("a value", "value", true));
      if (!step.value) out.push({ text: " is checked" });
      else out.push({ text: " " }, choice ? T(choice.label, "op") : T("is checked", "op", true));
      out.push(...targetToken(step, choice, subject));
    }
    const secs = positive(step.within);
    if (secs) out.push({ text: " within " }, T(durationText(secs * 1000), "time"));
    else if (step.op !== "triggered") out.push({ text: " within " }, T(durationText(defaultWithinMs), "time", false, "The playtest's default"));
  }
  // The first word is capitalised, unless it is a name the step uses as written (pos_z, bIsCrouched).
  const first = out[0];
  if (first && "text" in first) out[0] = { text: first.text.charAt(0).toUpperCase() + first.text.slice(1) };
  else if (first && first.missing) out[0] = { ...first, token: first.token.charAt(0).toUpperCase() + first.token.slice(1) };
  return out;
}

export const sentenceText = (parts: readonly SentencePart[]): string => parts.map((p) => ("text" in p ? p.text : p.token)).join("");

/**
 * A saved draft with each observer step's instruction cleared where it is
 * only the step's sentence, as this editor saves an empty one: the sentence
 * then follows the step as it changes instead of keeping its old words.
 */
export function withAutoInstructions(d: Draft, catalog: DraftCatalog): Draft {
  return {
    ...d,
    steps: d.steps.map((s) => {
      if (s.judge !== "auto" || !s.instruction) return s;
      const said = s.instruction.trim();
      const plain = { ...s, instruction: "" };
      const same = [catalog, EMPTY_CATALOG].some((c) => sentenceText(stepSentence(plain, c, d.defaultWithinMs)) === said);
      return same ? plain : s;
    }),
  };
}

// ---------- Saving ----------

function valueOf(text: string): number | number[] {
  const parts = text.split(",").map((x) => Number(x.trim())).filter((n) => Number.isFinite(n));
  return parts.length > 1 ? parts.slice(0, 3) : parts[0] ?? 1;
}

function actOut(a: DraftAct): Record<string, unknown> {
  const client = a.raw.client !== undefined ? { client: a.raw.client } : {};
  const body = (k: string) => rec(a.raw[k]) ?? {};
  switch (a.verb) {
    case "press": return { ...client, press: { ...body("press"), action: a.action } };
    case "hold": return { ...client, hold: { ...body("hold"), action: a.action, value: valueOf(a.value), ms: Math.round((positive(a.seconds) ?? 0) * 1000) } };
    case "wait": return { ...client, wait_ms: Math.round((positive(a.seconds) ?? 0) * 1000) };
    case "place": return { ...client, place: { ...body("place"), at: a.at } };
    case "console": return { ...client, console: a.command.trim() };
    default: return a.raw;
  }
}

function targetOut(step: DraftStep, choice: OpChoice | null): number | boolean | undefined {
  const t = step.target.trim();
  if (choice?.target) {
    // visible and exists default to true: only the opposite is written.
    if (choice.op === "visible" || choice.op === "exists") return choice.target === "false" ? false : undefined;
    return choice.target === "true";
  }
  if (step.op === "triggered") return undefined;
  const n = numberText(t);
  if (step.op === "increasing" || step.op === "decreasing") return n !== null && n > 0 ? n : undefined;
  if (n !== null) return n;
  const b = truthy(t);
  return b ? b === "true" : undefined;
}

/** One step in ue-mcp's script format, with its player beside it. */
export function draftStepOut(step: DraftStep, catalog: DraftCatalog, defaultWithinMs = DRAFT_DEFAULT_WITHIN_MS): Record<string, unknown> {
  const out: Record<string, unknown> = { ...step.keep };
  const written = step.instruction.trim();
  out.instruction = written || sentenceText(stepSentence(step, catalog, defaultWithinMs));
  out.judge = step.judge;
  if (step.acts.length) out.act = step.acts.map(actOut);
  if (step.judge === "auto" && step.value.trim()) {
    const subject = findSubject(catalog, step.value, step.op);
    const choice = choiceOf(step, subject?.kind ?? null);
    const target = targetOut(step, choice);
    const ms = positive(step.within);
    out.expect = { ...step.keepExpect, value: step.value.trim(), op: step.op, ...(target !== undefined ? { target } : {}), ...(ms ? { within_ms: Math.round(ms * 1000) } : {}) };
  }
  if (step.judge === "manual" && !step.agentJudgeable) out.agent_judgeable = false;
  if (step.resolveInPie && (out.expect || out.act || out.arrange)) out.resolve_in_pie = true;
  if (step.player) out.player = step.player;
  return out;
}

/** What a draft saves as, and what is checked: its steps, level, and whether a person judges every step. */
export function draftPayload(d: Draft, catalog: DraftCatalog): { steps: Array<Record<string, unknown>>; map: string; manual_only: boolean } {
  return {
    steps: d.steps.map((s) => draftStepOut(s, catalog, d.defaultWithinMs)),
    map: d.map,
    manual_only: d.steps.length > 0 && d.steps.every((s) => s.judge === "manual"),
  };
}

/** What tells two drafts apart for unsaved changes: what they would save, and the name. */
export const draftKey = (d: Draft): string => JSON.stringify({ name: d.name, map: d.map, steps: d.steps.map((s) => ({ ...s, id: 0, acts: s.acts.map((a) => ({ ...a, id: 0 })) })) });

// ---------- Problems ----------

/** Where on the screen a problem belongs. */
export type DraftField = "name" | "map" | "steps" | "step" | "instruction" | "value" | "op" | "target" | "within" | "setup" | `act:${string}`;

export interface DraftProblem {
  /** The step, or null for the whole playtest. */
  stepId: string | null;
  field: DraftField;
  message: string;
  /** ue-mcp's closest valid names, offered as one-click fixes. */
  candidates: string[];
  /** incomplete: not filled in yet, shown once Save is pressed. editor: ue-mcp found it. */
  kind: "incomplete" | "invalid" | "editor";
}

/**
 * What stops a save before ue-mcp is asked: no name, a name taken, a step
 * not filled in. `taken` holds the asset paths the project already has.
 */
export function draftProblems(d: Draft, catalog: DraftCatalog, ctx: { taken?: ReadonlySet<string> } = {}): DraftProblem[] {
  const out: DraftProblem[] = [];
  const p = (stepId: string | null, field: DraftField, message: string, kind: DraftProblem["kind"] = "incomplete") => out.push({ stepId, field, message, candidates: [], kind });
  if (!d.path) {
    const name = assetNameOf(d.name);
    if (!name) p(null, "name", DRAFT_COPY.needsName);
    else if (!/^[A-Za-z]/.test(name)) p(null, "name", DRAFT_COPY.nameStart, "invalid");
    else if (ctx.taken?.has(scriptPathOf(name))) p(null, "name", DRAFT_COPY.nameTaken(name), "invalid");
  }
  if (d.steps.length === 0) p(null, "steps", DRAFT_COPY.needsStep);
  for (const s of d.steps) {
    for (const a of s.acts) {
      const f: DraftField = `act:${a.id}`;
      if ((a.verb === "press" || a.verb === "hold") && !a.action) p(s.id, f, DRAFT_COPY.needsInput);
      else if ((a.verb === "hold" || a.verb === "wait") && !positive(a.seconds)) p(s.id, f, DRAFT_COPY.needsSeconds, a.seconds.trim() ? "invalid" : "incomplete");
      else if (a.verb === "place" && !a.at.trim()) p(s.id, f, DRAFT_COPY.needsActor);
      else if (a.verb === "console" && !a.command.trim()) p(s.id, f, DRAFT_COPY.needsCommand);
    }
    if (s.judge === "manual") {
      if (!s.instruction.trim()) p(s.id, "instruction", DRAFT_COPY.needsInstruction);
      continue;
    }
    if (!s.value.trim()) {
      p(s.id, "value", DRAFT_COPY.needsValue);
      continue;
    }
    const subject = findSubject(catalog, s.value, s.op);
    const choice = choiceOf(s, subject?.kind ?? null);
    if (!choice) p(s.id, "op", DRAFT_COPY.needsOp);
    else if (choice.needs === "number" && numberText(s.target) === null) p(s.id, "target", DRAFT_COPY.needsNumber, s.target.trim() ? "invalid" : "incomplete");
    else if (choice.needs === "enum" && !s.target.trim()) p(s.id, "target", DRAFT_COPY.needsEnum);
    else if (choice.needs === "least" && s.target.trim() && !positive(s.target)) p(s.id, "target", DRAFT_COPY.needsLeast, "invalid");
    if (s.within.trim() && !positive(s.within)) p(s.id, "within", DRAFT_COPY.needsSeconds, "invalid");
  }
  return out;
}

/** One finding as ue-mcp reports it: script_validate's errors, script_create's errors and warnings. */
export interface ScriptFinding {
  step: number | null;
  field: string;
  message: string;
  candidates?: string[];
}

/** ue-mcp's message without the steps[n].field it starts with, and without advice the screen offers as a button. */
export function findingText(message: string): string {
  return message
    .replace(/^steps\[\d+\](\.[\w.[\]]+)?(:\s*|\s+)/, "")
    .replace(/\s*If it only exists once PIE is running, set resolve_in_pie: true on the step\.?/i, "")
    .trim();
}

/**
 * ue-mcp's findings on the steps that were sent, each on the step (by id, so
 * a reorder since keeps it there) and the field it is about: expect.value is
 * the value, act[1].press.action the step's second action, map the level.
 */
export function anchorFindings(findings: readonly ScriptFinding[], sent: ReadonlyArray<Pick<DraftStep, "id" | "acts">>): DraftProblem[] {
  return findings.flatMap((f): DraftProblem[] => {
    const step = typeof f.step === "number" ? sent[f.step] : undefined;
    const candidates = Array.isArray(f.candidates) ? f.candidates.filter((c) => typeof c === "string" && c !== "manual_only") : [];
    const message = findingText(String(f.message ?? ""));
    const field = String(f.field ?? "");
    if (!step) {
      // The playtest as a whole: no auto step is handled by manual_only, which the payload sets.
      const whole: DraftField = field === "map" ? "map" : field === "name" ? "name" : "steps";
      return [{ stepId: null, field: whole, message, candidates, kind: "editor" as const }];
    }
    const act = /^act\[(\d+)\]/.exec(field);
    let at: DraftField = "step";
    if (act) at = step.acts[Number(act[1])] ? `act:${step.acts[Number(act[1])].id}` : "step";
    else if (field.startsWith("expect.value")) at = "value";
    else if (field.startsWith("expect.op")) at = "op";
    else if (field.startsWith("expect.target")) at = "target";
    else if (field.startsWith("expect.within_ms")) at = "within";
    else if (field.startsWith("arrange")) at = "setup";
    else if (field === "instruction") at = "instruction";
    return [{ stepId: step.id, field: at, message, candidates, kind: "editor" as const }];
  });
}

/** Problems a refused save carries (ApiError's body: { errors, warnings }), anchored like the checks. */
export function refusalProblems(e: unknown, sent: ReadonlyArray<Pick<DraftStep, "id" | "acts">>): DraftProblem[] {
  const body = rec((e as { body?: unknown } | null)?.body);
  const list = [...(Array.isArray(body?.errors) ? body!.errors : []), ...(Array.isArray(body?.warnings) ? body!.warnings : [])] as ScriptFinding[];
  return anchorFindings(list.filter((f) => rec(f)), sent);
}

/** A candidate put where its problem is: the value, operator, target, an action's input or actor, or the level. */
export function applyCandidate(d: Draft, problem: Pick<DraftProblem, "stepId" | "field">, candidate: string, catalog: DraftCatalog): Draft {
  if (problem.field === "map") return { ...d, map: qaScriptKey(candidate) };
  if (problem.field === "name") return { ...d, name: candidate };
  if (!problem.stepId) return d;
  return updateDraftStep(d, problem.stepId, (s) => {
    if (problem.field === "value") return withSubject(s, candidate, findSubject(catalog, candidate, s.op));
    if (problem.field === "op") return { ...s, op: candidate };
    if (problem.field === "target") return { ...s, target: candidate };
    if (problem.field.startsWith("act:")) {
      const id = problem.field.slice(4);
      return { ...s, acts: s.acts.map((a) => (a.id !== id ? a : a.verb === "place" ? { ...a, at: candidate } : a.verb === "press" || a.verb === "hold" ? { ...a, action: qaScriptKey(candidate) } : a)) };
    }
    return s;
  });
}

/** Whether "It exists only in PIE" helps with a problem: a value or an actor the level does not have yet. */
export function inPieHelps(problem: DraftProblem, step: DraftStep | undefined): boolean {
  if (!step || problem.kind !== "editor" || step.resolveInPie) return false;
  if (problem.field === "value") return step.op !== "triggered";
  if (problem.field.startsWith("act:")) return step.acts.find((a) => `act:${a.id}` === problem.field)?.verb === "place";
  return problem.field === "setup";
}

/** A candidate as the fix reads: an Input Action by its name, anything else as given. */
export const candidateLabel = (problem: Pick<DraftProblem, "field">, c: string): string =>
  (problem.field.startsWith("act:") || problem.field === "value") && c.startsWith("/") ? inputLabel(c) : problem.field === "map" ? levelName(c) : c;

/** The problems on screen: the checks before ue-mcp always; what is not filled in only once Save was pressed. */
export function shownProblems(local: readonly DraftProblem[], editor: readonly DraftProblem[], tried: boolean): DraftProblem[] {
  // While a step is still being filled in, ue-mcp's word on the whole script (no auto step yet) is noise.
  const filling = local.some((p) => p.kind === "incomplete");
  return [...local.filter((p) => tried || p.kind !== "incomplete"), ...editor.filter((p) => !(filling && p.stepId === null && p.field === "steps"))];
}

/** The status line at the foot of the editor. */
export interface DraftStatus {
  tone: "idle" | "busy" | "ok" | "warn" | "bad";
  text: string;
}

export function draftStatus(o: {
  checking: boolean;
  checkError: string | null;
  local: readonly DraftProblem[];
  editor: readonly DraftProblem[];
  checkedLevel: string | null;
  saving: "save" | "run" | "wait" | null;
  savedName?: string;
}): DraftStatus {
  if (o.saving === "wait") return { tone: "busy", text: DRAFT_COPY.waitingForList(o.savedName ?? "") };
  if (o.saving) return { tone: "busy", text: DRAFT_COPY.saving };
  const unfinished = o.local.filter((p) => p.kind !== "editor");
  if (o.checkError) return { tone: "warn", text: DRAFT_COPY.notChecked(o.checkError) };
  if (o.checking) return { tone: "busy", text: DRAFT_COPY.checking };
  if (o.editor.length) return { tone: "bad", text: DRAFT_COPY.problems(o.editor.length) };
  if (unfinished.some((p) => p.kind === "invalid")) return { tone: "bad", text: unfinished.find((p) => p.kind === "invalid")!.message };
  if (unfinished.length) return { tone: "idle", text: DRAFT_COPY.unfinished(unfinished.length) };
  return { tone: "ok", text: DRAFT_COPY.checked(o.checkedLevel) };
}

/** How long the editor waits after a change before asking ue-mcp to check the draft. */
export const DRAFT_CHECK_MS = 600;

// ---------- Copy ----------

export const DRAFT_COPY = {
  newPlaytest: "New playtest",
  editPlaytest: "Edit playtest",
  draftWithAgent: "Draft with an agent",
  draftWithAgentTitle: "Describe the playtest",
  draftWithAgentLead: "An agent reads the project, writes the steps and checks them with the editor in a chat session. The playtest appears in the Library once it is saved.",
  draftWithAgentPlaceholder: "For example: the door opens when the player walks up and presses Interact",
  draftWithAgentGo: "Draft in chat",
  nameLabel: "Name",
  namePlaceholder: "PT_DoorOpens",
  savesAs: "Saves as",
  levelLabel: "Plays in",
  anyLevel: "The open level",
  valuesFrom: (level: string) => `Values are listed from ${level}, the level open in the editor.`,
  steps: "Steps",
  addCheck: "Check a value",
  addAsk: "Ask a person",
  addAction: "Add an action",
  judgedBy: "Judged by",
  observer: "Observer",
  person: "Person",
  doLabel: "First",
  checkLabel: "Then check",
  askLabel: "Then ask",
  askPlaceholder: "The door swings open without a visible pop",
  agentMay: "An agent may judge it from a capture",
  playerNote: "Tell the player",
  playerNotePlaceholder: "Optional. Empty shows the step's sentence.",
  within: "within",
  seconds: "s",
  noLimit: "no limit",
  valuePlaceholder: "Choose a value",
  searchValues: "Search values, actors, widgets and inputs",
  useTyped: (v: string) => `Use "${v}"`,
  useTypedNote: "Not listed for the open level",
  noValues: "No match in the open level.",
  inPie: "It exists only in PIE",
  inPieOn: "Exists only in PIE: not checked until it runs.",
  moveUp: "Move up",
  moveDown: "Move down",
  duplicate: "Duplicate",
  remove: "Delete step",
  removeShort: "Delete",
  moved: (n: number) => `Moved to step ${n}`,
  save: "Save",
  saveRun: "Save and run",
  cancel: "Cancel",
  saving: "Saving",
  checking: "Checking with the editor",
  checked: (level: string | null) => (level ? `No problems found in ${levelName(level)}` : "No problems found"),
  problems: (n: number) => `${n} ${n === 1 ? "problem" : "problems"} to fix before it runs`,
  unfinished: (n: number) => `${n} ${n === 1 ? "part is" : "parts are"} not filled in`,
  notChecked: (why: string) => `Not checked: ${why}`,
  waitingForList: (name: string) => `Saved ${name}. Opening it once the hub lists it.`,
  savedTitle: (name: string) => `Saved ${name}`,
  saveFailed: "Not saved.",
  discardTitle: "Discard your changes?",
  discardLead: "The playtest keeps what it had when you opened it.",
  discardNewLead: "Nothing is saved.",
  discard: "Discard",
  keepEditing: "Keep editing",
  restored: "Your unsaved changes from earlier are back.",
  needsName: "Name the playtest",
  nameStart: "Start the name with a letter",
  nameTaken: (n: string) => `A playtest named ${n} already exists`,
  needsStep: "Add a step",
  needsInput: "Choose an input action",
  needsSeconds: "Enter seconds, such as 1.5",
  needsActor: "Choose an actor",
  needsCommand: "Enter a console command",
  needsInstruction: "Say what a person checks",
  needsValue: "Choose a value to check",
  needsOp: "Choose how it is checked",
  needsNumber: "Enter a number",
  needsEnum: "Choose a value",
  needsLeast: "Enter a change above 0, or leave it empty",
  leastPlaceholder: "any change",
  setupKept: (n: number) => `Also sets up ${n} ${n === 1 ? "thing" : "things"} before it starts, kept as written.`,
  otherKept: "Kept as written",
  addsToGoal: (title: string) => `Adds to ${title}`,
  noEditor: "The editor is not connected. Values, levels and checks need it; you can still write the steps.",
  emptyHint: "A playtest is steps played in order. An observer step checks a value in PIE; a person step asks for a verdict.",
  verbs: { press: "Press", hold: "Hold", wait: "Wait", place: "Place player at", console: "Run command" } as Record<ActVerb, string>,
  holdFor: "for",
  holdValue: "value",
} as const;

// ---------- API ----------

const QA = "/v1/ext/studio/qa";

/** Studio's routes for the editor (apps/agent drafting-routes.ts), and the save of an edit. */
export function draftingApi(request: HubRequest) {
  return {
    catalog: () => request<unknown>("GET", `${QA}/drafting/catalog`),
    script: (path: string) => request<{ script: unknown; players: Record<number, string> }>("GET", `${QA}/drafting/script?script=${encodeURIComponent(path)}`),
    validate: (p: { steps: unknown[]; map: string; manual_only: boolean }) => request<{ valid: boolean; errors: ScriptFinding[] }>("POST", `${QA}/drafting/validate`, p),
    create: (p: { name: string; steps: unknown[]; map: string; manual_only: boolean }) => request<{ path: string; warnings: ScriptFinding[] }>("POST", `${QA}/drafting/create`, p),
    save: (script: string, p: { steps: unknown[]; map: string; manual_only?: boolean }) => request<{ script: string }>("PUT", `${QA}/playtests/script`, { script, steps: p.steps, map: p.map }),
  };
}
export type DraftingApi = ReturnType<typeof draftingApi>;

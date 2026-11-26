/**
 * Timeline playtests (ue-mcp's playtest clips) as the hub draws them: the
 * agent's /clips routes, the grid edits snap to, the ops a drawn change
 * becomes, undo and redo through clip_edit's rollback, and the copy.
 */
import { CLIP_EVENTS_FEATURE, CLIP_TAKE_EVENTS_FEATURE } from "@ue-mcp-studio/shared";
import type {
  Clip,
  ClipCheckResult,
  ClipDrift,
  ClipEditAnswer,
  ClipFinding,
  ClipLane,
  ClipLaneResult,
  ClipListEntry,
  ClipLiveTake,
  ClipRead,
  ClipRegionResult,
  ClipRunsAnswer,
  ClipRunStatus,
  ClipRunSummary,
  ClipRunTally,
  ClipTakeTrack,
  ClipTrack,
  ClipTrackType,
  ClipValue,
  Performer,
} from "@ue-mcp-studio/shared";
import type { HubRequest } from "./hub.js";
import { takesLane } from "./performers.js";

export const CLIPS_BASE = "/v1/ext/studio/clips";
const enc = encodeURIComponent;

/** clip_update's params: what undo and redo send. */
export interface ClipUpdate {
  path: string;
  clip: Clip;
}

/** Studio's routes for timeline playtests (apps/agent clip-routes.ts). */
export function clipsApi(request: HubRequest) {
  return {
    list: () => request<{ clips: ClipListEntry[] }>("GET", CLIPS_BASE),
    create: (name: string) => request<{ path: string }>("POST", CLIPS_BASE, { name }),
    read: (path: string) => request<ClipRead>("GET", `${CLIPS_BASE}/clip?path=${enc(path)}`),
    update: (u: ClipUpdate) => request<ClipRead & { rollback: ClipUpdate | null }>("PUT", `${CLIPS_BASE}/clip`, u),
    edit: (path: string, ops: ClipOp[]) => request<ClipEditAnswer>("POST", `${CLIPS_BASE}/edit`, { path, ops }),
    run: (path: string, region?: string) => request<ClipRunStatus>("POST", `${CLIPS_BASE}/run`, region ? { path, region } : { path }),
    record: (p: { path: string; region?: string; from_check?: string; armed?: string[] }) => request<ClipRunStatus>("POST", `${CLIPS_BASE}/record`, p),
    recordStop: () => request<unknown>("POST", `${CLIPS_BASE}/record/stop`, {}),
    stop: (runId?: string) => request<unknown>("POST", `${CLIPS_BASE}/stop`, runId ? { run_id: runId } : {}),
    status: (runId?: string) => request<ClipRunStatus>("GET", `${CLIPS_BASE}/status${runId ? `?run_id=${enc(runId)}` : ""}`),
    verdict: (check: string, verdict: "pass" | "fail" | "skip", note?: string) => request<ClipRunStatus>("POST", `${CLIPS_BASE}/verdict`, note ? { check, verdict, note } : { check, verdict }),
    runs: (path: string, limit = 20) => request<ClipRunsAnswer>("GET", `${CLIPS_BASE}/runs?path=${enc(path)}&limit=${limit}`),
  };
}
export type ClipsApi = ReturnType<typeof clipsApi>;

/** One clip_edit op, as docs/pie-clips.md in ue-mcp lists them. */
export type ClipOp = { op: "add" | "move" | "trim" | "set" | "delete" | "quantize" | "set_clip"; [k: string]: unknown };

// ---------- Names ----------

/** An asset's name from its path: "/Game/Clips/CL_Door.CL_Door" is CL_Door. */
export const clipName = (path: string): string => (path.split("/").pop() ?? path).split(".")[0] || path;
/** A track's name: its Input Action's asset name. */
export const trackName = (action: string): string => clipName(action);
/** The package part of an object path, so "/Game/X.X" and "/Game/X" compare equal. */
export const clipPackage = (path: string): string => path.split(".")[0] ?? path;

// ---------- Time ----------

export const clipRate = (c: Clip): number => (typeof c.rate === "number" && c.rate > 0 ? c.rate : 60);

/** Frames per grid step: 1 on "frame", rate/N on "1/N", 0 on "free". */
export function gridStep(c: Clip, grid = c.grid ?? "frame"): number {
  if (grid === "free") return 0;
  const m = /^1\/(\d+)$/.exec(grid);
  return m && Number(m[1]) > 0 ? clipRate(c) / Number(m[1]) : 1;
}

/** A frame on the clip's grid; free keeps two decimals. Never before frame 0. */
export function snapFrame(f: number, c: Clip, grid?: string): number {
  const step = gridStep(c, grid);
  const v = step > 0 ? Math.round(f / step) * step : Math.round(f * 100) / 100;
  return Math.max(0, Math.round(v * 1000) / 1000);
}

/** Where the clip ends: its length, or the last thing on it, and never under two seconds. */
export function clipEnd(c: Clip): number {
  let end = typeof c.length === "number" && c.length > 0 ? c.length : 0;
  for (const r of c.regions ?? []) end = Math.max(end, r.end);
  for (const t of c.tracks ?? []) {
    for (const n of t.notes ?? []) end = Math.max(end, n.start + n.length);
    for (const k of t.keys ?? []) end = Math.max(end, k.t);
  }
  for (const k of c.checks ?? []) end = Math.max(end, k.start + k.length);
  for (const e of c.events ?? []) end = Math.max(end, e.at);
  for (const l of c.lanes ?? []) for (const x of laneItems(l)) end = Math.max(end, x.t);
  return Math.max(end, clipRate(c) * 2);
}

/** A frame as seconds of game time, for the ruler and the inspector. */
export const frameSeconds = (f: number, c: Clip): string => `${(f / clipRate(c)).toFixed(2).replace(/\.?0+$/, "") || "0"} s`;

/** The grids the snap picker offers. */
export const CLIP_GRIDS = ["frame", "1/4", "1/8", "1/16", "free"] as const;

// ---------- Values ----------

const DIMS: Record<ClipTrackType, number> = { bool: 1, axis1d: 1, axis2d: 2, axis3d: 3 };

/** A value as the inspector shows it: "0.5" or "0,1". */
export function valueText(v: ClipValue | undefined): string {
  const one = (n: number) => String(Math.round(n * 1000) / 1000);
  return v === undefined ? "" : Array.isArray(v) ? v.map(one).join(",") : one(v);
}

/** A typed value for a track, or null when it does not have the track's number of components. */
export function parseValue(text: string, type: ClipTrackType): ClipValue | null {
  const parts = text.split(",").map((s) => s.trim()).filter(Boolean).map(Number);
  if (parts.length !== DIMS[type] || parts.some((n) => !Number.isFinite(n))) return null;
  return DIMS[type] === 1 ? parts[0] : parts;
}

/** A track's curve value at a frame, as playback reads it: nothing before the first key, the last key's after it. */
export function curveAt(track: ClipTrack, f: number): ClipValue | undefined {
  const keys = [...(track.keys ?? [])].sort((a, b) => a.t - b.t);
  if (!keys.length || f < keys[0].t) return undefined;
  let i = 0;
  while (i + 1 < keys.length && keys[i + 1].t <= f) i++;
  const a = keys[i];
  const b = keys[i + 1];
  if (!b || a.interp === "constant") return a.v;
  const u = (f - a.t) / (b.t - a.t);
  const mix = (x: number, y: number) => x + (y - x) * u;
  return Array.isArray(a.v) && Array.isArray(b.v) ? a.v.map((x, j) => mix(x, (b.v as number[])[j] ?? x)) : typeof a.v === "number" && typeof b.v === "number" ? mix(a.v, b.v) : a.v;
}

/** The value a new key gets on an axis track: the curve's own at that frame, or zero. */
export function newKeyValue(track: ClipTrack, f: number): ClipValue {
  const at = curveAt(track, f);
  if (at !== undefined) return at;
  const n = DIMS[track.type];
  return n === 1 ? 0 : Array.from({ length: n }, () => 0);
}

// ---------- Move, action and value lanes ----------

/** The lane kinds beside Input Action lanes. */
export type ClipLaneKind = ClipLane["kind"];
export const CLIP_LANE_KINDS: readonly ClipLaneKind[] = ["move", "action", "value"];

/** The points, calls or keys on a lane, each with its id and frame. */
export const laneItems = (l: ClipLane): Array<{ id: string; t: number }> => (l.kind === "move" ? l.points : l.kind === "action" ? l.calls : l.keys) ?? [];

/** The performer a lane names: its own, else the clip's; null when neither does, and its track's performer drives it. */
export const lanePerformer = (l: Pick<ClipLane, "performer">, c: Pick<Clip, "performer">): Performer | null => l.performer ?? c.performer ?? null;

/** The kinds a new lane may be for a performer: those it takes, or all three when none is named. */
export const laneKindsFor = (p: Performer | null): ClipLaneKind[] => CLIP_LANE_KINDS.filter((k) => !p || takesLane(p, k));

/** A lane's name: Move to, Actions, or a value lane's target. */
export const laneTitle = (l: ClipLane): string => (l.kind === "value" ? l.target : l.kind === "move" ? CLIP_COPY.laneMove : CLIP_COPY.laneAction);

/** clip_edit's ops for lanes and what is on them, as docs/pie-clips.md in ue-mcp lists them. */
export const LANE_OPS = {
  /** A lane of a kind; a value lane needs its target. */
  add: (kind: ClipLaneKind, o: { performer?: Performer | null; target?: string; type?: "axis1d" | "bool"; watch?: string[] } = {}): ClipOp => ({
    op: "add",
    kind: "lane",
    capability: kind,
    ...(o.performer ? { performer: o.performer } : {}),
    ...(kind === "value" ? { target: o.target ?? "", type: o.type ?? "axis1d" } : {}),
    ...(kind === "action" && o.watch?.length ? { watch: o.watch } : {}),
  }),
  point: (lane: string, time: number, at: [number, number, number], radius?: number): ClipOp => ({ op: "add", kind: "point", lane, time, at, ...(radius !== undefined ? { radius } : {}) }),
  call: (lane: string, time: number, fn: string, args?: unknown[]): ClipOp => ({ op: "add", kind: "call", lane, time, fn, ...(args?.length ? { args } : {}) }),
  key: (lane: string, time: number, value: number | boolean, interp?: string): ClipOp => ({ op: "add", kind: "key", lane, time, value, ...(interp ? { interp } : {}) }),
  /** A lane's performer (null: the clip's), target, type or watch list. */
  set: (id: string, fields: { performer?: Performer | null; target?: string; type?: "axis1d" | "bool"; watch?: string[] }): ClipOp => ({ op: "set", id, ...fields }),
  /** The clip's performer; null clears it. */
  clipPerformer: (p: Performer | null): ClipOp => ({ op: "set_clip", performer: p }),
};

/** A point's coordinates as the inspector shows them: "120, -40, 0". */
export const atText = (at: readonly number[]): string => at.map((n) => String(Math.round(n * 100) / 100)).join(", ");

/** Coordinates from "x, y, z", or null when they are not three numbers. */
export function parseAt(text: string): [number, number, number] | null {
  const parts = text.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean).map(Number);
  return parts.length === 3 && parts.every((n) => Number.isFinite(n)) ? [parts[0], parts[1], parts[2]] : null;
}

/** A call's arguments as the inspector shows them: a JSON array, empty for none. */
export const argsText = (args: unknown[] | undefined): string => (args?.length ? JSON.stringify(args) : "");

/** Arguments from a JSON array, or one JSON value as the only argument; [] for empty, null when it is not JSON. */
export function parseArgs(text: string): unknown[] | null {
  if (!text.trim()) return [];
  try {
    const v = JSON.parse(text) as unknown;
    return Array.isArray(v) ? v : [v];
  } catch {
    return null;
  }
}

/** Where a new point goes: where the point before it went, or the origin. */
export function newPointAt(l: Extract<ClipLane, { kind: "move" }>, f: number): [number, number, number] {
  const before = [...l.points].filter((p) => p.t <= f).sort((a, b) => b.t - a.t)[0] ?? [...l.points].sort((a, b) => a.t - b.t)[0];
  return before ? [...before.at] as [number, number, number] : [0, 0, 0];
}

/** A value lane's value at a frame: nothing before its first key, the last key's after it, linear between unless a key is constant. */
export function laneValueAt(l: Extract<ClipLane, { kind: "value" }>, f: number): number | boolean | undefined {
  const keys = [...l.keys].sort((a, b) => a.t - b.t);
  if (!keys.length || f < keys[0].t) return undefined;
  let i = 0;
  while (i + 1 < keys.length && keys[i + 1].t <= f) i++;
  const a = keys[i];
  const b = keys[i + 1];
  if (!b || a.interp === "constant" || typeof a.v !== "number" || typeof b.v !== "number") return a.v;
  return a.v + (b.v - a.v) * ((f - a.t) / (b.t - a.t));
}

/** The value a new key on a value lane gets: the curve's own at that frame, or zero (false). */
export const newLaneValue = (l: Extract<ClipLane, { kind: "value" }>, f: number): number | boolean => laneValueAt(l, f) ?? (l.type === "bool" ? false : 0);

/** The span a value lane's curve is drawn over: 0 to 1 for a Boolean, its keys' range otherwise, never flat. */
export function laneValueRange(l: Extract<ClipLane, { kind: "value" }>): { min: number; max: number } {
  if (l.type === "bool") return { min: 0, max: 1 };
  const vs = l.keys.map((k) => Number(k.v)).filter((n) => Number.isFinite(n));
  if (!vs.length) return { min: -1, max: 1 };
  let min = Math.min(0, ...vs);
  let max = Math.max(...vs);
  if (max - min < 1e-6) max = min + 1;
  const pad = (max - min) * 0.1;
  return { min: min - pad, max: max + pad };
}

/** A value lane's value as typed: a number, or true and false on a Boolean lane. Null when it is neither. */
export function parseLaneValue(text: string, type: "axis1d" | "bool"): number | boolean | null {
  const t = text.trim().toLowerCase();
  if (type === "bool") return t === "true" || t === "1" ? true : t === "false" || t === "0" ? false : null;
  const n = Number(t);
  return t !== "" && Number.isFinite(n) ? n : null;
}

// ---------- Undo ----------

/** Undo and redo, each a stack of clip_update params. */
export interface ClipHistory {
  undo: ClipUpdate[];
  redo: ClipUpdate[];
}
export const CLIP_UNDO_MAX = 100;
export const emptyHistory = (): ClipHistory => ({ undo: [], redo: [] });
/** After an edit: its rollback can be undone, and nothing can be redone. */
export const historyAfterEdit = (h: ClipHistory, rollback: ClipUpdate | null): ClipHistory => (rollback ? { undo: [...h.undo, rollback].slice(-CLIP_UNDO_MAX), redo: [] } : { undo: h.undo, redo: [] });
/** After an undo: `back` puts the undone change back. */
export const historyAfterUndo = (h: ClipHistory, back: ClipUpdate): ClipHistory => ({ undo: h.undo.slice(0, -1), redo: [...h.redo, back] });
/** After a redo: `back` undoes it again. */
export const historyAfterRedo = (h: ClipHistory, back: ClipUpdate): ClipHistory => ({ undo: [...h.undo, back].slice(-CLIP_UNDO_MAX), redo: h.redo.slice(0, -1) });

// ---------- Findings ----------

/** Where a finding points on the clip, so selecting it is possible. */
export function findingTarget(c: Clip, f: ClipFinding): { kind: "note" | "key" | "check" | "event" | "region" | "lane" | "point" | "call" | "laneKey"; id: string; track?: string; lane?: string } | null {
  if (!f.id) return null;
  for (const t of c.tracks ?? []) {
    if (t.notes?.some((n) => n.id === f.id)) return { kind: "note", id: f.id, track: t.action };
    if (t.keys?.some((k) => k.id === f.id)) return { kind: "key", id: f.id, track: t.action };
  }
  for (const l of c.lanes ?? []) {
    if (l.id === f.id) return { kind: "lane", id: f.id, lane: l.id };
    if (laneItems(l).some((x) => x.id === f.id)) return { kind: l.kind === "move" ? "point" : l.kind === "action" ? "call" : "laneKey", id: f.id, lane: l.id };
  }
  if (c.checks?.some((k) => k.id === f.id)) return { kind: "check", id: f.id };
  if (c.events?.some((e) => e.id === f.id)) return { kind: "event", id: f.id };
  if (c.regions?.some((r) => r.id === f.id)) return { kind: "region", id: f.id };
  return null;
}

/** The op that takes one of a finding's candidates, or null when the candidate is not a field value (an id or a track). */
export function findingFix(c: Clip, f: ClipFinding, candidate: string): ClipOp | null {
  const at = findingTarget(c, f);
  if (!at || !f.field) return null;
  const field = f.field.replace(/^expect\./, "");
  if (at.kind === "check" && (field === "value" || field === "op" || field === "target")) return { op: "set", id: at.id, expect: { [field]: candidate } };
  // A performer finding's candidates are the lane kinds it takes, not values to set.
  if (field === "id" || field === "track" || field === "lane" || field === "performer") return null;
  return { op: "set", id: at.id, [field]: candidate };
}

// ---------- Runs ----------

/** A run as the timeline follows it: from clip_status, then clip.* events or polling. */
export interface ClipLive {
  runId: string;
  clip?: string;
  mode: "play" | "record";
  state: string;
  position: number;
  length: number;
  holding: string | null;
  awaiting: string[];
  checks: Record<string, ClipCheckResult>;
  regions: Record<string, ClipRegionResult>;
  passed?: boolean;
  summary?: ClipRunTally;
  stopReason?: string;
  drift?: ClipDrift;
  /** The take so far while a recording plays, when ue-mcp offers it. */
  take: ClipLiveTake | null;
  /** Each move, action and value lane: what it fired and its errors. */
  lanes: Record<string, ClipLaneResult>;
  seq: number;
}

/** Poll clip_status this often while a run plays and the daemon has no clip events. */
export const CLIP_POLL_MS = 250;

export const clipEventsOn = (health: unknown): boolean => featureOn(health, CLIP_EVENTS_FEATURE);
export const clipTakeEventsOn = (health: unknown): boolean => featureOn(health, CLIP_TAKE_EVENTS_FEATURE);
function featureOn(health: unknown, f: string): boolean {
  const features = Array.isArray(health) ? health : (health as { features?: unknown } | null)?.features;
  return Array.isArray(features) && features.includes(f);
}

/** Whether a run is still going: armed or running. */
export const clipPlaying = (l: ClipLive | null): boolean => !!l && (l.state === "running" || l.state === "armed");

const byId = <T extends { id: string }>(rows: T[] | undefined): Record<string, T> => Object.fromEntries((rows ?? []).filter((r) => r && typeof r.id === "string").map((r) => [r.id, r]));

/** A run from clip_status. */
export function clipLiveFromStatus(s: ClipRunStatus): ClipLive {
  return {
    runId: s.run_id,
    clip: s.clip,
    mode: s.mode === "record" ? "record" : "play",
    state: s.state ?? "running",
    position: s.position ?? 0,
    length: s.length ?? 0,
    holding: s.holding ?? null,
    awaiting: s.awaiting ?? [],
    checks: byId(s.checks),
    regions: byId(s.regions),
    passed: s.passed,
    summary: s.summary,
    stopReason: s.stop_reason,
    drift: s.drift,
    take: s.take?.live_take ? { ...s.take.live_take, tracks: s.take.live_take.tracks ?? [] } : null,
    lanes: byId(s.lanes),
    seq: 0,
  };
}

/** A run from clip_runs' history, for showing its results on the timeline. */
export function clipLiveFromSummary(r: ClipRunSummary): ClipLive {
  return { ...clipLiveFromStatus({ run_id: r.run_id, clip: r.clip, mode: r.mode, state: r.state ?? "finished", passed: r.passed, summary: r.summary, checks: r.checks, regions: r.regions, drift: r.drift, stop_reason: r.stop_reason }), take: null };
}

/** The take after a clip.take_progress: each track's notes replaced, its keys appended at keysFrom. */
export function applyTakeProgress(take: ClipLiveTake | null, d: Record<string, unknown>): ClipLiveTake {
  const tracks = new Map((take?.tracks ?? []).map((t) => [t.action, t]));
  for (const raw of Array.isArray(d.tracks) ? (d.tracks as ClipTakeTrack[]) : []) {
    if (!raw || typeof raw.action !== "string") continue;
    const had = tracks.get(raw.action);
    const from = typeof raw.keysFrom === "number" ? raw.keysFrom : had?.keys?.length ?? 0;
    const keys = raw.keys?.length ? [...(had?.keys ?? []).slice(0, from), ...raw.keys] : had?.keys ?? [];
    tracks.set(raw.action, { action: raw.action, type: raw.type ?? had?.type, notes: raw.notes ?? had?.notes ?? [], keys });
  }
  return {
    takeId: typeof d.takeId === "string" ? d.takeId : take?.takeId,
    punchIn: typeof d.punchIn === "number" ? d.punchIn : take?.punchIn,
    samples: typeof d.samples === "number" ? d.samples : take?.samples,
    frame: typeof d.frame === "number" ? d.frame : take?.frame,
    tracks: [...tracks.values()],
  };
}

/**
 * The run after one daemon event, or the run unchanged when the event is for
 * another clip or an older run. clip.run_started for this clip starts a new run.
 */
export function foldClipEvent(live: ClipLive | null, e: { type: string; data: Record<string, unknown> }, clipPath: string): ClipLive | null {
  const d = e.data ?? {};
  if (!e.type.startsWith("clip.") || typeof d.runId !== "string") return live;
  if (typeof d.clip === "string" && clipPackage(d.clip) !== clipPackage(clipPath)) return live;
  const seq = typeof d.seq === "number" ? d.seq : 0;
  let l = live;
  if (e.type === "clip.run_started" && (!l || l.runId !== d.runId)) {
    l = { ...clipLiveFromStatus({ run_id: d.runId, clip: d.clip as string | undefined, mode: d.mode as "play" | "record", state: "running" }), seq: -1 };
  }
  if (!l || l.runId !== d.runId) return live;
  if (seq && seq <= l.seq) return l;
  const n: ClipLive = { ...l, seq: seq || l.seq };
  const num = (k: string, v: number) => (typeof d[k] === "number" ? (d[k] as number) : v);
  switch (e.type) {
    case "clip.run_started":
    case "clip.position":
      n.position = num("position", n.position);
      n.length = num("length", n.length);
      if (typeof d.state === "string") n.state = d.state;
      if (e.type === "clip.position") n.holding = typeof d.holding === "string" ? d.holding : null;
      break;
    case "clip.check":
      if (d.check && typeof (d.check as ClipCheckResult).id === "string") n.checks = { ...n.checks, [(d.check as ClipCheckResult).id]: d.check as ClipCheckResult };
      break;
    case "clip.region":
      if (d.region && typeof (d.region as ClipRegionResult).id === "string") n.regions = { ...n.regions, [(d.region as ClipRegionResult).id]: d.region as ClipRegionResult };
      break;
    case "clip.verdict_requested":
      n.awaiting = Array.isArray(d.awaiting) ? (d.awaiting as string[]) : [];
      break;
    case "clip.take_progress":
      n.take = applyTakeProgress(n.take, d);
      break;
    case "clip.run_finished":
      n.state = typeof d.state === "string" ? d.state : "finished";
      n.passed = typeof d.passed === "boolean" ? d.passed : n.passed;
      n.summary = (d.summary as ClipRunTally | undefined) ?? n.summary;
      n.drift = (d.drift as ClipDrift | undefined) ?? n.drift;
      n.stopReason = typeof d.stopReason === "string" ? d.stopReason : n.stopReason;
      if (Array.isArray(d.lanes)) n.lanes = byId(d.lanes as ClipLaneResult[]);
      n.holding = null;
      n.awaiting = [];
      break;
  }
  return n;
}

/** How far the pawn drifted from the recording, as a short label: "drift 4.8 cm". */
export const driftText = (d: ClipDrift | undefined): string | undefined => (typeof d?.max_position_cm === "number" ? `drift ${d.max_position_cm.toFixed(1)} cm` : undefined);
/** The distance alone, for a sentence that names it: "4.8 cm". */
export const driftCm = (d: ClipDrift | undefined): string | undefined => (typeof d?.max_position_cm === "number" ? `${d.max_position_cm.toFixed(1)} cm` : undefined);

// ---------- Copy ----------

export const CLIP_MODE_LABEL: Record<string, string> = { by_end: "By the end", throughout: "Throughout", hold: "Hold until true" };
export const CLIP_INTERP_LABEL: Record<string, string> = { linear: "Linear", constant: "Constant", cubic: "Cubic" };
export const CLIP_GRID_LABEL: Record<string, string> = { frame: "Frame", "1/4": "1/4 s", "1/8": "1/8 s", "1/16": "1/16 s", free: "Off" };

export const CLIP_COPY = {
  clips: "Timeline clips",
  clip: "Timeline clip",
  open: "Timeline clips",
  lead: "Each timeline clip lays out input, events and checks on game time. Draw the input or record it by playing.",
  empty: "No timeline clips yet",
  newClip: "New timeline clip",
  nameLabel: "Name",
  namePlaceholder: "CL_DoorOpens",
  create: "Create",
  creating: "Creating",
  badName: "Use letters, digits and underscores.",
  neverRun: "Never run",
  passed: "Passed",
  failed: "Failed",
  running: "Running",
  regions: "Regions",
  checks: "Checks",
  events: "Events",
  undo: "Undo",
  redo: "Redo",
  delete: "Delete",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  snap: "Snap",
  frames: "frames",
  hint: "Drag on an Input Action lane to draw a note, or click a move, action or value lane to add a point, call or key. Drag an item to move it, or a note's right edge to trim it. Arrow keys nudge the selection.",
  laneMove: "Move to",
  laneAction: "Actions",
  laneValue: "Value",
  lane: "Lane",
  point: "Point",
  call: "Call",
  performer: "Performer",
  /** What an empty performer field means on the clip, and on a lane. */
  trackPerformer: "The track's performer",
  clipPerformerIs: (name: string) => `The clip's: ${name}`,
  performerHelp: "A player or an actor in the level. Left empty, the track's performer drives it.",
  at: "Walk to (x, y, z)",
  radius: "Arrival radius (cm)",
  radiusHelp: "Left empty, the controller's own.",
  fn: "Function",
  fnPlaceholder: "OpenGate or Weapon.Fire",
  args: "Arguments (JSON array)",
  laneTarget: "Property or blackboard key",
  laneTargetPlaceholder: "Health or bb:TargetActor",
  laneTypeNumber: "Number",
  laneTypeBool: "Boolean",
  watch: "Watch (properties, comma separated)",
  laneKind: "Lane",
  addLaneOf: (kind: string) => `Add ${kind === "move" ? "move" : kind === "action" ? "action" : "value"} lane`,
  addCall: "Add call",
  needTarget: "Name a property or a blackboard key.",
  needFn: "Name the function to call.",
  badAt: "Enter three numbers: x, y, z.",
  badArgs: 'Enter a JSON array, such as [1, "Gate"].',
  badBool: "Enter true or false.",
  laneFired: (n: number) => `Fired ${n}`,
  laneErrors: (n: number) => `${n} ${n === 1 ? "error" : "errors"}`,
  addTrack: "Add lane",
  addRegion: "Add region",
  addCheck: "Add check",
  addEvent: "Add event",
  trackAction: "Input Action",
  trackType: "Type",
  note: "Note",
  key: "Key",
  check: "Check",
  region: "Region",
  event: "Event",
  clipSettings: "Timeline settings",
  start: "Start",
  length: "Length",
  end: "End",
  time: "Time",
  value: "Value",
  interp: "Curve",
  name: "Name",
  mode: "Mode",
  manual: "Manual check (needs a verdict)",
  instruction: "What a person checks",
  checkValue: "Value to check",
  op: "Operator",
  target: "Target",
  eventDo: "What it does (JSON)",
  rate: "Frames per second",
  clipLength: "Length (frames)",
  warnings: "Warnings",
  selectIt: "Select",
  replaceWith: "Replace with",
  closest: "Closest",
  badValue: (n: number) => (n === 1 ? "Enter a number." : `Enter ${n} numbers separated by commas.`),
  badJson: "Enter valid JSON.",
  loadFailed: "The timeline clip did not load",
  /** A toast when an edit drawn ahead of clip_edit's answer was refused and taken back. */
  putBack: (why: string) => `Put back: ${why}`,
  tryAgain: "Try again",
  newRegion: (n: number) => `Region ${n}`,
  arm: "Record into this lane",
  play: "Play",
  wholeClip: "Whole timeline",
  record: "Record",
  punchIn: "Punch in at",
  frameZero: "Frame 0",
  holdCheck: (name: string) => `Hold check ${name}`,
  stop: "Stop",
  stopRecording: "Stop recording",
  starting: "Starting",
  playing: (pos: number, len: number) => (len > 0 ? `Playing frame ${Math.round(pos)} of ${Math.round(len)}` : `Playing frame ${Math.round(pos)}`),
  recording: (pos: number) => `Recording at frame ${Math.round(pos)}`,
  pausedAt: (pos: number) => `Paused at frame ${Math.round(pos)}`,
  holdingAt: (check: string) => `Waiting at check ${check} until its condition is true`,
  armNone: "Choose at least one lane to record into.",
  passedSummary: (passed: number, total: number) => `Passed ${passed} of ${total} checks`,
  failedSummary: (failed: number, total: number) => `Failed ${failed} of ${total} checks`,
  stopped: (reason?: string) => (reason ? `Stopped: ${reason}` : "Stopped"),
  unreachable: "The editor stopped answering during the run.",
  drift: (cm: string) => `Drift from the recording: up to ${cm}`,
  verdictTitle: "Waiting for your verdict",
  pass: "Pass",
  fail: "Fail",
  skip: "Skip",
  verdictNote: "Note (optional)",
  runs: "Runs",
  noRuns: "No runs yet.",
  runsUnavailable: "Past runs need a newer ue-mcp. Update it in Settings, under Updates.",
  played: "Played",
  recorded: "Recorded",
  showingRun: (when: string) => `Showing the run from ${when}`,
  showLatest: "Show the latest",
  liveTakeHidden: "The take appears when it is saved. To see it while you play, update ue-mcp in Settings, under Updates.",
} as const;

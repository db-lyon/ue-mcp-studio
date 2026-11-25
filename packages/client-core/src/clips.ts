/**
 * Timeline playtests (ue-mcp's playtest clips) as the hub draws them: the
 * agent's /clips routes, the grid edits snap to, the ops a drawn change
 * becomes, undo and redo through clip_edit's rollback, and the copy.
 */
import type { Clip, ClipEditAnswer, ClipFinding, ClipListEntry, ClipRead, ClipRunsAnswer, ClipRunStatus, ClipTrack, ClipTrackType, ClipValue } from "@ue-mcp-studio/shared";
import type { HubRequest } from "./hub.js";

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
export function findingTarget(c: Clip, f: ClipFinding): { kind: "note" | "key" | "check" | "event" | "region"; id: string; track?: string } | null {
  if (!f.id) return null;
  for (const t of c.tracks ?? []) {
    if (t.notes?.some((n) => n.id === f.id)) return { kind: "note", id: f.id, track: t.action };
    if (t.keys?.some((k) => k.id === f.id)) return { kind: "key", id: f.id, track: t.action };
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
  if (field === "id" || field === "track") return null;
  return { op: "set", id: at.id, [field]: candidate };
}

// ---------- Copy ----------

export const CLIP_MODE_LABEL: Record<string, string> = { by_end: "By the end", throughout: "Throughout", hold: "Hold until true" };
export const CLIP_INTERP_LABEL: Record<string, string> = { linear: "Linear", constant: "Constant", cubic: "Cubic" };
export const CLIP_GRID_LABEL: Record<string, string> = { frame: "Frame", "1/4": "1/4 s", "1/8": "1/8 s", "1/16": "1/16 s", free: "Off" };

export const CLIP_COPY = {
  clips: "Timeline playtests",
  clip: "Timeline playtest",
  open: "Timeline playtests",
  lead: "Input, events and checks laid out on game time. Draw input here, or record it by playing.",
  empty: "No timeline playtests yet",
  emptyBody: "Create one, then draw its input or record it by playing.",
  newClip: "New timeline playtest",
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
  hint: "Drag on a track to draw a note. Drag a note to move it, or its right edge to trim it. Arrow keys nudge the selection.",
  addTrack: "Add track",
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
  clipSettings: "Clip",
  start: "Start",
  length: "Length",
  end: "End",
  time: "Time",
  value: "Value",
  interp: "Curve",
  name: "Name",
  mode: "Mode",
  manual: "A person judges it",
  instruction: "What a person checks",
  checkValue: "Value to check",
  op: "Operator",
  target: "Target",
  eventDo: "Action, as JSON",
  rate: "Frames per second",
  clipLength: "Length (frames)",
  warnings: "Warnings",
  selectIt: "Select",
  replaceWith: "Replace with",
  closest: "Closest",
  notApplied: "The edit was not applied",
  badValue: (n: number) => (n === 1 ? "Enter a number." : `Enter ${n} numbers separated by commas.`),
  badJson: "Enter the action as JSON.",
  loadFailed: "The clip did not load",
  editorClosed: "Open the editor to edit this clip.",
  tryAgain: "Try again",
  newRegion: (n: number) => `Region ${n}`,
  arm: "Record into this track",
} as const;

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
} from "@ue-mcp-studio/shared";
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
  hint: "Drag on a lane to draw a note. Drag a note to move it, or its right edge to trim it. Arrow keys nudge the selection.",
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

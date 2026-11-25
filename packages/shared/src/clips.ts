/**
 * Playtest clips: a playtest laid out on a timeline of game time (ue-mcp's
 * pie clip_* actions, docs/pie-clips.md in ue-mcp). These are the shapes
 * Studio reads from those actions and from the daemon's clip.* events,
 * declared here rather than imported, since the ue-mcp version Studio pins
 * may predate them. Every field ue-mcp may leave out is optional.
 */

export type ClipTrackType = "bool" | "axis1d" | "axis2d" | "axis3d";
export type ClipInterp = "linear" | "constant" | "cubic";
export type ClipCheckMode = "by_end" | "throughout" | "hold";
/** A value on a track: a number for bool and axis1d, an array for axis2d and axis3d. */
export type ClipValue = number | number[];

export interface ClipNote {
  id: string;
  start: number;
  length: number;
  /** An axis note's held value. */
  value?: ClipValue;
}

export interface ClipKey {
  id: string;
  t: number;
  v: ClipValue;
  interp?: ClipInterp;
}

export interface ClipTrack {
  /** The Input Action's object path; it names the track. */
  action: string;
  type: ClipTrackType;
  notes?: ClipNote[];
  keys?: ClipKey[];
}

export interface ClipExpect {
  value: string;
  op: string;
  target?: unknown;
}

export interface ClipCheck {
  id: string;
  start: number;
  length: number;
  mode: ClipCheckMode;
  name?: string;
  expect?: ClipExpect;
  manual?: boolean;
  instruction?: string;
  agent_judgeable?: boolean;
  resolve_in_pie?: boolean;
}

export interface ClipEvent {
  id: string;
  at: number;
  do: unknown;
}

export interface ClipRegion {
  id: string;
  name: string;
  start: number;
  end: number;
}

export interface Clip {
  rate?: number;
  length?: number;
  /** "frame", "1/N" or "free". */
  grid?: string;
  map?: string;
  profile?: string;
  description?: string;
  hold_timeout?: number;
  reference?: string;
  regions?: ClipRegion[];
  tracks?: ClipTrack[];
  events?: ClipEvent[];
  checks?: ClipCheck[];
  takes?: unknown[];
  [k: string]: unknown;
}

/** A finding of clip_validate, a save or an edit: what is at fault and, where ue-mcp has them, close matches. */
export interface ClipFinding {
  id?: string;
  field?: string;
  message: string;
  candidates?: string[];
}

/** A run as clip_runs lists it, or the newest run clip_list carries as last_run. */
export interface ClipRunSummary {
  run_id: string;
  clip?: string;
  clip_name?: string;
  mode?: "play" | "record";
  state?: string;
  passed?: boolean;
  stop_reason?: string;
  region?: string;
  started_at?: string;
  ended_at?: string;
  summary?: ClipRunTally;
  drift?: ClipDrift;
  checks?: ClipCheckResult[];
  regions?: ClipRegionResult[];
}

export interface ClipRunTally {
  total?: number;
  passed?: number;
  failed?: number;
  skipped?: number;
  pending?: number;
  awaiting?: number;
}

export interface ClipDrift {
  compared?: boolean;
  frames_compared?: number;
  max_position_cm?: number;
  max_velocity_cms?: number;
  first_over_frame?: number;
  error?: string;
}

export type ClipCheckStatus = "pending" | "running" | "passed" | "failed" | "awaiting_verdict" | "skipped";

export interface ClipCheckResult {
  id: string;
  mode?: ClipCheckMode;
  status: ClipCheckStatus;
  start?: number;
  length?: number;
  started_frame?: number;
  ended_frame?: number;
  evidence?: { reason?: string; note?: string; last?: unknown };
  hold?: { held_ms?: number; resolved_frame?: number; recorded_ms?: number; drift_ms?: number };
}

export interface ClipRegionResult {
  id: string;
  name?: string;
  start?: number;
  end?: number;
  /** skipped: every check in it was skipped, as outside the one region a run played. */
  status: "passed" | "failed" | "pending" | "skipped" | "empty";
  drift?: ClipDrift;
}

/** One armed track of a take so far. Notes replace what was drawn; keys append at keysFrom. */
export interface ClipTakeTrack {
  action: string;
  type?: ClipTrackType;
  notes?: Array<{ start: number; length: number; value?: ClipValue; open?: boolean }>;
  keys?: Array<{ t: number; v: ClipValue; interp?: ClipInterp }>;
  keysFrom?: number;
}

/** The take of a recording run while it plays: clip_status's take.live_take, or what clip.take_progress events add up to. */
export interface ClipLiveTake {
  takeId?: string;
  punchIn?: number;
  samples?: number;
  frame?: number;
  tracks: ClipTakeTrack[];
}

/** pie(clip_status) as Studio reads it: the run's results while it plays or after. */
export interface ClipRunStatus {
  run_id: string;
  clip?: string;
  mode?: "play" | "record";
  state: string;
  stop_reason?: string;
  passed?: boolean;
  position?: number;
  length?: number;
  game_ms?: number;
  held_ms?: number;
  frames?: number;
  holding?: string | null;
  awaiting?: string[];
  summary?: ClipRunTally;
  checks?: ClipCheckResult[];
  regions?: ClipRegionResult[];
  drift?: ClipDrift;
  take?: { live_take?: ClipLiveTake; take_id?: string; saved?: boolean; error?: string; [k: string]: unknown };
}

/** A clip_list row. */
export interface ClipListEntry {
  path: string;
  object_path?: string;
  name: string;
  map?: string;
  last_run?: ClipRunSummary | null;
}

/** GET /v1/ext/studio/clips/clip and every answer that carries the clip after a change. */
export interface ClipRead {
  path: string;
  clip: Clip;
  text?: string;
  warnings?: ClipFinding[];
}

/** POST /v1/ext/studio/clips/edit: the clip after the ops, and the clip_update that puts it back. */
export interface ClipEditAnswer extends ClipRead {
  changed: string[];
  /** clip_update's params with the clip as it was, for undo. */
  rollback: { path: string; clip: Clip } | null;
}

/** GET /v1/ext/studio/clips/runs. `runs` is null when ue-mcp has no clip_runs. */
export interface ClipRunsAnswer {
  runs: ClipRunSummary[] | null;
  total?: number;
}

/** A refusal from a clip route: why, and the findings with candidates when ue-mcp gave them. */
export interface ClipRefusal {
  error: string;
  errors?: ClipFinding[];
  warnings?: ClipFinding[];
}

/** The /v1/health features that say the daemon streams clip runs and live takes. */
export const CLIP_EVENTS_FEATURE = "events.clip";
export const CLIP_TAKE_EVENTS_FEATURE = "events.clip.take";

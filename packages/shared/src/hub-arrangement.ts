/**
 * The hub's set of tracks and scenes, as the Arrangement view reads it: the wire types of the daemon's /v1/hub set routes (db-lyon/ue-mcp
 * issue 2113). They mirror ue-mcp's src/contract/hub-arrangement.ts and
 * src/contract/hub-compose.ts and are declared here until Studio pins a
 * ue-mcp release that exports them. Only types and constants: the daemon
 * validates, lays out and composes.
 *
 * Wire names keep "goal": a track is a goal of kind "goal" and a scene one of
 * kind "milestone".
 */
import type { GoalStatus } from "ue-mcp/hub";

/** Listed in GET /v1/health features by a daemon that serves the set routes. */
export const ARRANGEMENT_FEATURE = "hub.arrangement";

/** Frames per second a timeline is laid out in when it says nothing else. */
export const ARRANGEMENT_DEFAULT_RATE = 60;

/** The fixed palette tracks, scenes, slots and instances are colored from. */
export const HUB_COLORS = ["red", "orange", "yellow", "lime", "green", "teal", "cyan", "blue", "indigo", "violet", "pink", "gray"] as const;
export type HubColor = (typeof HUB_COLORS)[number];

export type InstanceKind = "clip" | "script";

/** A clip placed on a track's timeline. Times are frames at the track's rate. */
export interface Instance {
  id: string;
  kind: InstanceKind;
  /** The asset path without the object name. */
  target: string;
  start: number;
  /** Clip instances: frames trimmed off the clip's start, in the clip's own frames. */
  in?: number;
  /** Clip instances: the clip frame the instance ends at, in the clip's own frames; the clip's length when absent. */
  out?: number;
  /** Step-list instances: frames the instance takes up on the timeline. */
  length?: number;
  name?: string;
  color?: string;
}

export interface Arrangement {
  rate: number;
  instances: Instance[];
}

/** One finding about the set. */
export interface ArrangementFinding {
  id: string;
  field: string;
  message: string;
  candidates?: string[];
  /** It refuses an edit or a run; a warning otherwise. */
  blocks: boolean;
}

/** An instance as a client draws it, resolved against its clip. */
export interface InstanceLayout {
  id: string;
  kind: InstanceKind;
  target: string;
  name: string;
  start: number;
  end: number;
  length: number;
  /** False when the clip could not be read, so its length is a guess. */
  known: boolean;
  /** Timeline clips that could be read: the clip's own frame rate, which `in` and `out` count in. */
  clipRate?: number;
  /** Timeline clips that could be read: the clip's whole length in its own frames. */
  clipLength?: number;
}

/** A track: a row of the Arrangement, a timeline that drives one player. */
export interface SetTrack {
  id: string;
  title: string;
  order: number;
  color?: string;
  /** 0 is the editor's own player; N is remote client N. */
  player: number;
  mute: boolean;
  solo: boolean;
  arrangement: Arrangement;
  layout: InstanceLayout[];
  status: GoalStatus;
}

/** A scene: tracks whose timelines play together. */
export interface SetScene {
  id: string;
  title: string;
  order: number;
  color?: string;
  /** Its tracks' ids, in order. */
  tracks: string[];
  status: GoalStatus;
}

/** GET /hub/set, and POST /hub/set/edit with `changed`. */
export interface SetAnswer {
  rate: number;
  tracks: SetTrack[];
  scenes: SetScene[];
  text: string;
  findings: ArrangementFinding[];
  changed?: string[];
}

/** The 400 body of POST /hub/set/edit. */
export interface SetRefusal {
  error: string;
  finding?: ArrangementFinding;
  findings?: ArrangementFinding[];
}

/** What POST /hub/run plays. */
export type SetRunScope =
  | { kind: "track"; goalId: string }
  | { kind: "scene"; goalId: string }
  | { kind: "arrangement" };

/** One entry of GET /hub/clips: a timeline clip or a step-list playtest. */
export interface HubClipEntry {
  kind: InstanceKind;
  target: string;
  name: string;
  map?: string | null;
  /** Frames at `rate`; null when unknown. */
  length: number | null;
  rate: number;
  lastRun: { runId: string; outcome: string; at: string } | null;
}

export type InstanceStatus = "pending" | "running" | "passed" | "failed" | "skipped" | "awaiting_verdict";

/** One instance's result in a run. `goalId` is its track. */
export interface InstanceResult {
  key: string;
  goalId: string;
  id: string;
  kind: InstanceKind;
  target: string;
  name: string;
  player: number;
  start: number;
  end: number;
  status: InstanceStatus;
  checks: { total: number; passed: number; failed: number; pending: number; awaiting: number };
  /** The manual checks waiting for a verdict now: `check` is what POST /hub/runs/:id/verdict takes. */
  awaiting?: InstanceAwaiting[];
  segmentRunId: string | null;
  reason?: string | null;
}

/** A manual check waiting for a verdict, and the question it asks. */
export interface InstanceAwaiting {
  check: string;
  instruction: string;
}
/** One segment of a run: a clip run or a script run, `offset` frames into the run's timeline. */
export interface ArrangementRunSegment {
  index: number;
  kind: InstanceKind;
  runId: string | null;
  offset: number;
  length: number;
  state: string;
}

/** RunRecord.arrangement and RunDetail.arrangement on a track, arrangement or scene run. */
export interface ArrangementRun {
  kind: "track" | "arrangement" | "scene";
  goalId?: string;
  rate: number;
  length: number;
  instances: InstanceResult[];
  tracks?: Array<{ goalId: string; title: string; player: number; status: string }>;
  segments: ArrangementRunSegment[];
}

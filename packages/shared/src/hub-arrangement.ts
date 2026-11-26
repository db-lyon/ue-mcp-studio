/**
 * The hub's set of tracks and scenes, as the Arrangement view reads it. The
 * wire types (Arrangement, Instance, InstanceLayout, ArrangementFinding,
 * ArrangementRun, InstanceResult and the rest) come from ue-mcp/hub, which
 * hub-contract re-exports; the names here are the views' own for the answers
 * of the daemon's /v1/hub set routes (db-lyon/ue-mcp issue 2113).
 *
 * Wire names keep "goal": a track is a goal of kind "goal" and a scene one of
 * kind "milestone".
 */
import { ARRANGEMENT_RATE, SET_COLORS } from "ue-mcp/hub";
import type { ArrangementFinding, ArrangementRun, ClipEntry, PlanScope, SetColor, SetView } from "ue-mcp/hub";

/** Listed in GET /v1/health features by a daemon that serves the set routes. */
export const ARRANGEMENT_FEATURE = "hub.arrangement";

/** Frames per second a timeline is laid out in when it says nothing else. */
export const ARRANGEMENT_DEFAULT_RATE = ARRANGEMENT_RATE;

/** The fixed palette tracks, scenes, slots and instances are colored from. */
export const HUB_COLORS = SET_COLORS;
export type HubColor = SetColor;

/** A track as GET /hub/set answers it: a row of the Arrangement, a timeline that drives one player. */
export type SetTrackView = SetView["tracks"][number];

/** A scene as GET /hub/set answers it: tracks whose timelines play together. */
export type SetSceneView = SetView["scenes"][number];

/** GET /hub/set, and POST /hub/set/edit with `changed`. */
export type SetAnswer = SetView & { changed?: string[] };

/** The 400 body of POST /hub/set/edit. */
export interface SetRefusal {
  error: string;
  finding?: ArrangementFinding;
  findings?: ArrangementFinding[];
}

/** What the Arrangement's play buttons send to POST /hub/run; `from` plays the timelines from that frame, at 60 per second. */
export type SetRunScope = Extract<PlanScope, { kind: "track" | "scene" | "arrangement" }>;

/** One entry of GET /hub/clips: a timeline clip or a step-list playtest. */
export type HubClipEntry = ClipEntry;

/** One segment of a run: a clip run or a script run, `offset` frames into the run's timeline. */
export type ArrangementRunSegment = ArrangementRun["segments"][number];

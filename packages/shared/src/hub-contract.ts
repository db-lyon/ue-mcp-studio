/**
 * The Playtest Hub's contract and the playtest run model: types, the rules
 * that work out health and status, the goal graph, the Needs attention list
 * and the QaRun functions. They live in ue-mcp beside the hub that serves
 * them, so every client gets them from one place. This file only hands them
 * to Studio's two clients through `@ue-mcp-studio/shared`.
 *
 * `ue-mcp/hub` loads only the contract, so the page and the phone app can
 * bundle it. ue-mcp installs once, at the workspace root, for every package
 * here. A name Studio declares itself in index.ts (its own BusyState, for
 * one) is Studio's and wins over the hub's of the same name.
 */
import type {
  HubOverview as BaseHubOverview,
  PlanOptions,
  PlanRequest as BasePlanRequest,
  PlanRun as BasePlanRun,
  PlanScope,
  QueueState as BaseQueueState,
} from "ue-mcp/hub";
import { DEFAULT_PLAN_OPTIONS } from "ue-mcp/hub";

export * from "ue-mcp/hub";

/*
 * The queue's schedules, plan moves and a Run's placement, as ue-mcp's hub
 * declares them from the release after 1.4.16-beta.2. Declared here until
 * Studio pins that release; a daemon that predates them answers without
 * `schedules` or `placement`, and 404 on their routes, which the clients
 * treat as not offered. Each name here wins over the hub's of the same name.
 */

export type PlanTrigger = "person" | "schedule" | "agent";

export type PlanRun = Omit<BasePlanRun, "trigger"> & {
  trigger: PlanTrigger;
  /** The schedule that queued it. */
  scheduleId?: string | null;
};

export type PlanRequest = BasePlanRequest & {
  /** Run next: ahead of every other queued plan, behind only the one on the editor. */
  next?: boolean;
};

/** The options a plan starts from by what queued it: a schedule's runs are unattended. */
export const planOptionsFor = (trigger: PlanTrigger): PlanOptions => ({ ...DEFAULT_PLAN_OPTIONS, attended: trigger !== "schedule" });

/**
 * Where a person's Run put its plan: started, waiting (it is next but the
 * editor is not free, `reason`), or queued (`position` among the queued
 * plans, 1 for next; `ahead` counts the running one too). A person's Run
 * resumes a paused queue (`resumed`).
 */
export interface PlanPlacement {
  state: "started" | "waiting" | "queued";
  position: number;
  ahead: number;
  reason?: string | null;
  resumed?: boolean;
}

/**
 * A plan run at a local time on chosen days. When due it waits while the
 * queue is paused or busy or anything holds the editor (the consent ledger
 * included), saying why in `waiting`, and gives up after an hour with the
 * reason in `lastSkipped`.
 */
export interface Schedule {
  id: string;
  title: string;
  scope: PlanScope;
  options: PlanOptions;
  /** Local time HH:MM. */
  at: string;
  /** Days of the week it runs, 0 Sunday to 6 Saturday. */
  days: number[];
  enabled: boolean;
  lastRunAt?: string | null;
  lastSkipped?: string | null;
  waiting?: string | null;
  nextRunAt?: string | null;
}
export type ScheduleDraft = Omit<Schedule, "id" | "lastRunAt" | "lastSkipped" | "waiting" | "nextRunAt">;

export type QueueState = Omit<BaseQueueState, "current" | "queued" | "recent"> & {
  current: PlanRun | null;
  queued: PlanRun[];
  recent: PlanRun[];
  /** Absent from a daemon that has no schedules. */
  schedules?: Schedule[];
};

export type HubOverview = Omit<BaseHubOverview, "queue"> & { queue: QueueState };

/*
 * Performers and a clip's actor lanes (db-lyon/ue-mcp issue 2137), as
 * ue-mcp's hub declares them from 1.4.16-beta.8. Declared here until Studio
 * pins that release; a daemon that predates them sends no `performer` and no
 * `lanes`, and does not list hub.performers in its health. Each name here
 * wins over the hub's of the same name.
 */

/** What a track drives: the editor's own player (client 0) or remote client N, or an actor in the level named by its label, object name or path. */
export type Performer = { kind: "player"; client: number } | { kind: "actor"; actor: string };
export type PerformerKind = Performer["kind"];

/** What a lane drives: Input Actions, moves through a controller, function calls, or a property or blackboard value over time. */
export type LaneCapability = "input" | "move" | "action" | "value";

/** The lanes each performer kind takes. A player's action and value lanes act on the pawn it possesses. */
export const PERFORMER_CAPABILITIES: { readonly [K in PerformerKind]: readonly LaneCapability[] } = {
  player: ["input", "action", "value"],
  actor: ["move", "action", "value"],
};

/** One performer a track can drive (GET /hub/performers). */
export interface PerformerCandidate {
  performer: Performer;
  label: string;
  /** Actors: the class, as the level reports it. */
  className?: string;
  /** Actors: whether it is a pawn, which move lanes need. */
  pawn?: boolean;
  capabilities: LaneCapability[];
}

/** GET /hub/performers?arrangement=: the players, then the open level's actors, pawns first. */
export interface PerformersView {
  level: string | null;
  performers: PerformerCandidate[];
  /** Why no actor is listed, when none is. */
  reason?: string;
}

/** A move lane's point: walk to `at` from frame `t`, through the actor's controller. */
export interface ClipMovePoint {
  id: string;
  t: number;
  at: [number, number, number];
  /** How close counts as there, in centimetres; the controller's own when absent. */
  radius?: number;
}

/** An action lane's call: the function, on the actor or `Component.Function`, at frame `t`. */
export interface ClipActionCall {
  id: string;
  t: number;
  fn: string;
  args?: unknown[];
}

/** A value lane's key. */
export interface ClipValueKey {
  id: string;
  t: number;
  v: number | boolean;
  interp?: string;
}

/** A clip lane that is not an Input Action lane: a move, action or value lane, as pie(clip_read) answers it. */
export type ClipLane =
  | { id: string; kind: "move"; performer?: Performer; points: ClipMovePoint[] }
  | { id: string; kind: "action"; performer?: Performer; calls: ClipActionCall[]; watch?: string[] }
  | { id: string; kind: "value"; performer?: Performer; target: string; type: "axis1d" | "bool"; keys: ClipValueKey[] };

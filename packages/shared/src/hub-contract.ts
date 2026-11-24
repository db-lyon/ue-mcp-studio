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

/**
 * The Playtest Hub: goals a game must meet, the checks that prove them, the
 * runs that are their evidence, and the queue that schedules runs on the
 * editor. Goals are files in the project (QA/Goals/<id>.json, checked in and
 * shared); run history, the queue and schedules are per machine, in the
 * extension's data directory. Status is always computed, never stored: these
 * rules are the one place it is worked out, for the agent and both clients.
 *
 * Routes are under /v1/ext/studio/hub (see HUB_ROUTES below); every change
 * publishes `studio.hub.changed` with a HubChanged body.
 */
import type { QaRun, QaStepStatus, QaSummary } from "./qa.js";

export const HUB_SCHEMA = 1 as const;
/** Where goal files live in the project unless the project sets another folder. */
export const HUB_GOALS_DIR = "QA/Goals";
/** Beside the goal files: the JSON Schema each goal file names in "$schema", and a short guide for people and agents. */
export const HUB_GOAL_SCHEMA_FILE = "goal.schema.json";
export const HUB_GOALS_README = "README.md";

// ---------- Goals and checks (checked in) ----------

/**
 * What a check is. Today only `script` runs (a ue-mcp PIE test script); the
 * others are modelled so goals can name them, and run as their runners land:
 * `uat` a pie.uat_run scenario, `repro` a pie.test_run reproduction test,
 * `automation` an Unreal automation test filter, `manual` a checklist item a
 * person signs off.
 */
export type CheckKind = "script" | "uat" | "repro" | "automation" | "manual";
export const RUNNABLE_KINDS: readonly CheckKind[] = ["script"];

// ---------- Tracker links ----------

/**
 * A link from a goal, a check or a run to an item elsewhere: an issue, a
 * ticket, a card, a document. Any tracker: Studio keeps the URL and never
 * contacts it, so there is no provider list.
 */
export interface TrackerLink {
  url: string;
  title?: string;
  /** How the item relates, free text. TRACKER_LINK_RELS are the usual ones, offered by clients and never enforced. */
  rel?: string;
}

/** Relationships clients suggest for a link. Any other text is as valid. */
export const TRACKER_LINK_RELS = ["counterpart", "related", "filed-from-run", "blocks"] as const;
/** The most links one goal, check or run keeps. */
export const TRACKER_LINKS_MAX = 20;
export const TRACKER_URL_MAX = 2048;
export const TRACKER_TITLE_MAX = 200;
export const TRACKER_REL_MAX = 40;
/** Schemes a link may never use: they run code or read local data where it opens. */
export const TRACKER_BLOCKED_SCHEMES: readonly string[] = ["javascript", "data", "vbscript", "file", "blob", "about"];
const URL_SCHEME = /^([a-z][a-z0-9+.-]*):/i;

/** Why a URL cannot be a link, or null when it can: http, https, mailto, or an app's own scheme such as jira://. */
export function trackerUrlProblem(url: unknown): string | null {
  if (typeof url !== "string" || !url.trim()) return "a link needs a url";
  const u = url.trim();
  if (u.length > TRACKER_URL_MAX) return `a link's url is at most ${TRACKER_URL_MAX} characters`;
  if (/\s/.test(u)) return "a link's url has no spaces";
  const scheme = URL_SCHEME.exec(u)?.[1]?.toLowerCase();
  if (!scheme) return "a link's url starts with its scheme, such as https://";
  if (TRACKER_BLOCKED_SCHEMES.includes(scheme)) return `${scheme}: links are not allowed`;
  if ((scheme === "http" || scheme === "https") && !/^https?:\/\/[^/?#\s]+/i.test(u)) return "a web link needs a host, such as https://example.com/issue/1";
  if (u.length <= scheme.length + 1) return "a link's url has nothing after its scheme";
  return null;
}

/** A link from a body or a file, normalized; or why it is not one. */
export function trackerLinkOf(v: unknown): { link: TrackerLink } | { problem: string } {
  if (!v || typeof v !== "object" || Array.isArray(v)) return { problem: "a link is { url, title?, rel? }" };
  const o = v as Record<string, unknown>;
  const problem = trackerUrlProblem(o.url);
  if (problem) return { problem };
  if (o.title !== undefined && o.title !== null && typeof o.title !== "string") return { problem: "a link's title is text" };
  if (o.rel !== undefined && o.rel !== null && typeof o.rel !== "string") return { problem: "a link's rel is text" };
  const title = typeof o.title === "string" ? o.title.trim().slice(0, TRACKER_TITLE_MAX) : "";
  const rel = typeof o.rel === "string" ? o.rel.trim().slice(0, TRACKER_REL_MAX) : "";
  return { link: { url: (o.url as string).trim(), ...(title ? { title } : {}), ...(rel ? { rel } : {}) } };
}

/** Links without a second one to the same URL, the first kept, at most TRACKER_LINKS_MAX. */
export function uniqueLinks(links: readonly TrackerLink[]): TrackerLink[] {
  const seen = new Set<string>();
  return links.filter((l) => {
    if (seen.has(l.url)) return false;
    seen.add(l.url);
    return true;
  }).slice(0, TRACKER_LINKS_MAX);
}

/**
 * What a link is shown as when it has no title: the host of a web link
 * (without www.), the address of a mail link, the scheme of an app link
 * ("jira"). Empty when the URL does not parse.
 */
export function linkHost(url: string): string {
  const u = url.trim();
  const scheme = URL_SCHEME.exec(u)?.[1]?.toLowerCase();
  if (!scheme) return "";
  if (scheme === "mailto") {
    const to = u.slice("mailto:".length).split("?")[0] ?? "";
    try {
      return decodeURIComponent(to);
    } catch {
      return to;
    }
  }
  if (scheme === "http" || scheme === "https") {
    const m = /^https?:\/\/(?:[^@/?#]*@)?(\[[^\]]+\]|[^:/?#]+)/i.exec(u);
    return m ? m[1].toLowerCase().replace(/^www\./, "") : "";
  }
  return scheme;
}

export interface CheckRef {
  kind: CheckKind;
  /** script: asset path without object name; uat/repro: file path; automation: test filter; manual: the item's text. */
  target: string;
  /** A display name; the script's own name otherwise. */
  title?: string;
  /** A goal is met only when its required checks pass. Default true. */
  required?: boolean;
  /** Tracker items this check refers to, kept in the goal that lists it. */
  links?: TrackerLink[];
}

/** PUT /hub/goals/:id/checks/:checkId. Given fields change; null clears title, an empty list clears links. */
export interface CheckUpdate {
  title?: string | null;
  required?: boolean;
  links?: TrackerLink[];
}

/** A check's identity across goals and runs: "<kind>:<target>". */
export const checkId = (c: Pick<CheckRef, "kind" | "target">): string => `${c.kind}:${c.target}`;
export function parseCheckId(id: string): Pick<CheckRef, "kind" | "target"> | null {
  const i = id.indexOf(":");
  if (i <= 0) return null;
  const kind = id.slice(0, i) as CheckKind;
  if (!["script", "uat", "repro", "automation", "manual"].includes(kind)) return null;
  const target = id.slice(i + 1);
  return target ? { kind, target } : null;
}

export interface AcceptanceRule {
  /** How many latest runs of each required check must all pass. 1 to 10, default 1. */
  stableRuns: number;
  /** A passing check not run for this many days counts as stale (at risk). Null: never stale. */
  staleAfterDays: number | null;
  /** A person signs the goal off before it is met. */
  signOff: boolean;
}
export const DEFAULT_ACCEPTANCE: AcceptanceRule = { stableRuns: 1, staleAfterDays: 14, signOff: false };

export type GoalPriority = "p0" | "p1" | "p2" | "p3";
export type GoalKind = "milestone" | "goal";

export interface SignOff {
  by: string;
  at: string;
  note?: string;
}

/** One goal file. Ids are slugs and name the file: QA/Goals/<id>.json. */
export interface Goal {
  schema: typeof HUB_SCHEMA;
  id: string;
  kind: GoalKind;
  title: string;
  /** What "done" means, in the team's words. Markdown. */
  description?: string;
  /** The milestone this goal belongs to; milestones have none. One level only. */
  parent?: string | null;
  owner?: string | null;
  priority?: GoalPriority;
  tags?: string[];
  /** ISO date (YYYY-MM-DD). */
  due?: string | null;
  /** Tracker items this goal refers to: its issue, a design document. */
  links?: TrackerLink[];
  acceptance: AcceptanceRule;
  checks: CheckRef[];
  signOff?: SignOff | null;
  archived?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** POST /hub/goals. The agent fills id (from the title, made unique), schema, timestamps and defaults. */
export type GoalDraft = Pick<Goal, "title"> & Partial<Omit<Goal, "schema" | "createdAt" | "updatedAt">>;
/** PUT /hub/goals/:id. Given fields change; checks, when given, replace the list. */
export type GoalUpdate = Partial<Omit<Goal, "schema" | "id" | "createdAt" | "updatedAt">>;

/** A goal id from a title: lowercase words joined by dashes, at most 64 characters. */
export function goalSlug(title: string): string {
  const s = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return s || "goal";
}
export const GOAL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

// ---------- Runs (per machine) ----------

export type RunOutcome = "passed" | "failed" | "needs_you" | "running" | "incomplete" | "stopped" | "error";
export type RunSource = "person" | "agent" | "plan" | "schedule" | "outside";

/** One run of one check, as the hub's run index keeps it. */
export interface RunRecord {
  runId: string;
  kind: CheckKind;
  target: string;
  name: string;
  outcome: RunOutcome;
  startedAt: string;
  endedAt?: string | null;
  durationMs?: number | null;
  summary?: QaSummary | null;
  /** Step indexes that failed, for comparing runs. */
  failedSteps?: number[];
  source: RunSource;
  sessionId?: string | null;
  planRunId?: string | null;
  replayOf?: string | null;
  recordingId?: string | null;
  map?: string | null;
  /** Tracker items this run refers to, such as the issue filed from it. Per machine, as the run is. */
  links?: TrackerLink[];
}

/** A run's outcome from its QaRun. */
export function outcomeOf(run: Pick<QaRun, "state" | "steps" | "summary">): RunOutcome {
  const steps = run.steps ?? [];
  const failed = run.summary?.failed ?? steps.filter((s) => s.status === "failed").length;
  if (run.state === "awaiting_verdict" || steps.some((s) => s.status === "awaiting_verdict")) return "needs_you";
  if (run.state === "armed" || run.state === "running") return failed > 0 ? "failed" : "running";
  if (failed > 0) return "failed";
  if (run.state === "stopped") return "stopped";
  const open: QaStepStatus[] = ["pending", "running"];
  if (steps.length === 0 || steps.some((s) => open.includes(s.status))) return "incomplete";
  return "passed";
}

/** Timeline of a run for the run screen: one bar per step on the run's clock. */
export interface RunStepSpan {
  index: number;
  instruction: string;
  status: QaStepStatus;
  judge: "auto" | "manual";
  startMs: number | null;
  endMs: number | null;
}

/** GET /hub/runs/:runId. Everything the run screen draws. */
export interface RunDetail {
  record: RunRecord;
  /** The live or last-known QaRun, when Studio has it. */
  run: QaRun | null;
  steps: RunStepSpan[];
  /** Values the observer tracked, sampled for charts: series name to [ms, value] points. */
  series?: Record<string, Array<[number, number]>>;
  /** Warnings and errors the PIE session logged during the run. */
  log?: Array<{ atMs: number; level: "warning" | "error"; text: string }>;
  /** The newest earlier passing run of the same check, to compare with. */
  lastPass?: RunRecord | null;
  /** Steps whose result differs from lastPass. */
  changedSteps?: number[];
  resultsUrl?: string | null;
}

// ---------- Health and status (computed) ----------

export type CheckHealth = "needs_you" | "failing" | "running" | "flaky" | "stale" | "passing" | "never_run" | "missing";
export type GoalStatus = "needs_you" | "failing" | "at_risk" | "running" | "met" | "not_started";

/** Worst first: what every list sorts by, and the order the status ladder is drawn in. */
export const CHECK_HEALTH_ORDER: readonly CheckHealth[] = ["needs_you", "failing", "missing", "running", "flaky", "stale", "never_run", "passing"];
export const GOAL_STATUS_ORDER: readonly GoalStatus[] = ["needs_you", "failing", "at_risk", "running", "not_started", "met"];

export interface CheckState {
  id: string;
  check: CheckRef;
  name: string;
  /** Goals that list this check. Empty for a script no goal names yet. */
  goalIds: string[];
  health: CheckHealth;
  last: RunRecord | null;
  /** Outcomes of the latest finished runs, newest first, at most 20. */
  recent: RunOutcome[];
  /** Passed share of `recent`, or null with no finished runs. */
  passRate: number | null;
  /** The script's map and step count, when known. */
  map?: string | null;
  steps?: number | null;
  /** The script no longer resolves in the project. */
  missing?: boolean;
}

export interface GoalState {
  goal: Goal;
  status: GoalStatus;
  checks: CheckState[];
  /** Required checks currently satisfying the acceptance rule, out of all required checks. */
  progress: { met: number; total: number };
  /** For a milestone: its goals' ids. */
  children: string[];
}

const FINISHED: readonly RunOutcome[] = ["passed", "failed", "incomplete", "stopped", "error"];
const DAY = 86_400_000;

export interface HealthInput {
  check: CheckRef;
  /** Runs of this check, newest first. */
  runs: RunRecord[];
  missing?: boolean;
  acceptance?: AcceptanceRule;
  now?: number;
}

/** A check's health from its runs. Flaky: mixed passes and failures within the last stableRuns+2 (at least 3) finished runs while the newest passed. */
export function checkHealth({ check, runs, missing, acceptance = DEFAULT_ACCEPTANCE, now = Date.now() }: HealthInput): CheckHealth {
  if (missing) return "missing";
  const live = runs[0];
  if (live?.outcome === "needs_you") return "needs_you";
  if (live?.outcome === "running") return "running";
  const done = runs.filter((r) => FINISHED.includes(r.outcome));
  if (check.kind === "manual" && done.length === 0) return "never_run";
  if (done.length === 0) return "never_run";
  const newest = done[0];
  if (newest.outcome !== "passed") return "failing";
  const window = done.slice(0, Math.max(3, acceptance.stableRuns + 2));
  if (window.some((r) => r.outcome === "failed")) return "flaky";
  if (acceptance.staleAfterDays !== null) {
    const at = Date.parse(newest.endedAt ?? newest.startedAt);
    if (Number.isFinite(at) && now - at > acceptance.staleAfterDays * DAY) return "stale";
  }
  return "passing";
}

/** Whether a check satisfies the acceptance rule: its latest stableRuns finished runs all passed. */
export function checkSatisfied(runs: RunRecord[], acceptance: AcceptanceRule): boolean {
  const done = runs.filter((r) => FINISHED.includes(r.outcome)).slice(0, Math.max(1, acceptance.stableRuns));
  return done.length >= Math.max(1, acceptance.stableRuns) && done.every((r) => r.outcome === "passed");
}

export function checkStateOf(input: HealthInput & { goalIds: string[]; name?: string; map?: string | null; steps?: number | null }): CheckState {
  const done = input.runs.filter((r) => FINISHED.includes(r.outcome)).slice(0, 20);
  return {
    id: checkId(input.check),
    check: input.check,
    name: input.check.title ?? input.name ?? leafName(input.check.target),
    goalIds: input.goalIds,
    health: checkHealth(input),
    last: input.runs[0] ?? null,
    recent: done.map((r) => r.outcome),
    passRate: done.length ? done.filter((r) => r.outcome === "passed").length / done.length : null,
    map: input.map ?? null,
    steps: input.steps ?? null,
    ...(input.missing ? { missing: true } : {}),
  };
}

/** Whether a goal is met only once a person signs it off: its rule asks for it, or a required manual check waits on it. */
export const needsSignOff = (goal: Pick<Goal, "acceptance" | "checks">): boolean =>
  goal.acceptance.signOff || goal.checks.some((c) => c.kind === "manual" && c.required !== false);

/**
 * A goal's status from its checks (each worked out with the goal's own
 * acceptance rule) and, for a milestone, its goals' statuses.
 */
export function goalStatus(goal: Goal, checks: Array<{ state: CheckState; runs: RunRecord[] }>, childStatuses: GoalStatus[] = []): { status: GoalStatus; progress: { met: number; total: number } } {
  const required = checks.filter((c) => c.state.check.required !== false);
  const met = required.filter((c) => c.state.check.kind !== "manual" && checkSatisfied(c.runs, goal.acceptance)).length;
  const manualRequired = required.filter((c) => c.state.check.kind === "manual").length;
  // A manual check is satisfied by the goal's sign-off.
  const metAll = met + (goal.signOff ? manualRequired : 0);
  const progress = { met: metAll, total: required.length };
  const hs = checks.map((c) => c.state.health);
  const reqHs = required.map((c) => c.state.health);
  if (hs.includes("needs_you") || childStatuses.includes("needs_you")) return { status: "needs_you", progress };
  if (reqHs.includes("failing") || reqHs.includes("missing") || childStatuses.includes("failing")) return { status: "failing", progress };
  if (hs.includes("running") || childStatuses.includes("running")) return { status: "running", progress };
  if (required.length === 0 && childStatuses.length === 0) return { status: "not_started", progress };
  const everyChildMet = childStatuses.every((s): boolean => s === "met");
  const allMet = metAll === required.length && everyChildMet && (!goal.acceptance.signOff || !!goal.signOff);
  if (allMet) {
    if (reqHs.some((h) => h === "flaky" || h === "stale") || childStatuses.includes("at_risk")) return { status: "at_risk", progress };
    return { status: "met", progress };
  }
  // Everything else is in and only a person's sign-off is missing: the rule asks for one, or required manual checks wait on it.
  if (!goal.signOff && (goal.acceptance.signOff || manualRequired > 0) && met + manualRequired === required.length && everyChildMet) return { status: "needs_you", progress };
  if (reqHs.every((h) => h === "never_run") && childStatuses.every((s) => s === "not_started")) return { status: "not_started", progress };
  // Some evidence, not all of it passing yet (a check never run, or too few stable runs).
  return { status: "at_risk", progress };
}

export const leafName = (path: string): string => {
  const last = path.split("/").filter(Boolean).pop() ?? path;
  return last.replace(/\.[^.]*$/, "");
};

// ---------- Plans, queue and schedules (per machine) ----------

export type PlanScope =
  | { kind: "goal"; goalId: string }
  | { kind: "checks"; checks: CheckRef[] }
  | { kind: "failing"; goalId?: string }
  | { kind: "stale"; goalId?: string }
  | { kind: "all" };

export interface PlanOptions {
  /** Manual steps go to the inbox while the plan moves on (defer), or hold the plan until judged (block). */
  manualSteps: "defer" | "block";
  stopOnFailure: boolean;
  /** Replay each check's last recording instead of a live run, where it has one. */
  replay: boolean;
}
export const DEFAULT_PLAN_OPTIONS: PlanOptions = { manualSteps: "defer", stopOnFailure: false, replay: false };

export type PlanItemState = "queued" | "running" | "passed" | "failed" | "needs_you" | "skipped" | "error" | "cancelled";
export interface PlanItem {
  check: CheckRef;
  name: string;
  state: PlanItemState;
  runId?: string | null;
  reason?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
}

export type PlanState = "queued" | "running" | "paused" | "done" | "cancelled" | "failed";
export type PlanTrigger = "person" | "schedule" | "agent";

export interface PlanRun {
  id: string;
  title: string;
  scope: PlanScope;
  options: PlanOptions;
  state: PlanState;
  items: PlanItem[];
  trigger: PlanTrigger;
  scheduleId?: string | null;
  createdAt: string;
  startedAt?: string | null;
  endedAt?: string | null;
}

/** POST /hub/plans. */
export interface PlanRequest {
  title?: string;
  scope: PlanScope;
  options?: Partial<PlanOptions>;
}

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
  /** Why the last due run did not start (editor closed, busy). */
  lastSkipped?: string | null;
  nextRunAt?: string | null;
}
export type ScheduleDraft = Omit<Schedule, "id" | "lastRunAt" | "lastSkipped" | "nextRunAt">;

export interface QueueState {
  paused: boolean;
  current: PlanRun | null;
  queued: PlanRun[];
  /** Finished plans, newest first, at most 20. */
  recent: PlanRun[];
  schedules: Schedule[];
  editor: { connected: boolean };
}

// ---------- Inbox (computed) ----------

export type InboxKind = "verdict" | "loop_blocked" | "regression" | "sign_off" | "missing_check" | "plan_failed";

export interface InboxItem {
  /** Stable while the thing it points at waits: "<kind>:<runId>:<step>" and the like. */
  id: string;
  kind: InboxKind;
  at: string;
  title: string;
  detail?: string;
  goalIds: string[];
  runId?: string;
  step?: number;
  /** For a verdict: what to check in PIE. */
  instruction?: string;
  checkId?: string;
  planRunId?: string;
}

export const INBOX_ORDER: readonly InboxKind[] = ["verdict", "loop_blocked", "sign_off", "regression", "missing_check", "plan_failed"];

// ---------- Overview ----------

/** GET /hub. Everything the overview, library and inbox draw, in one answer. */
export interface HubOverview {
  /** The folder goal files are read from, relative to the project. */
  goalsDir: string;
  goals: GoalState[];
  /** Every known check: those goals name and scripts in the project no goal names yet. */
  checks: CheckState[];
  inbox: InboxItem[];
  queue: QueueState;
  /** Newest runs across the project, at most 30. */
  recent: RunRecord[];
  editor: { connected: boolean };
  /** Goal files that did not parse, and the like. */
  warnings: string[];
}

/** GET /hub/checks/:checkId. */
export interface CheckDetail {
  state: CheckState;
  /** Runs newest first, a page. */
  runs: RunRecord[];
  more: boolean;
  /** The script's steps as ue-mcp has them, when it is a script. */
  script?: QaRun | null;
}

export type HubChangedWhat = "goals" | "runs" | "queue" | "inbox" | "checks";
/** The body of `studio.hub.changed`. */
export interface HubChanged {
  what: HubChangedWhat[];
  goalId?: string;
  runId?: string;
  planRunId?: string;
}
export const HUB_CHANGED = "studio.hub.changed";

/**
 * The hub's routes under /v1/ext/studio. Ids in paths are encodeURIComponent'd.
 * Verdicts, stop and the fix loop go through the existing /qa/runs/:id/* routes.
 */
export const HUB_ROUTES = {
  overview: "GET /hub",
  goal: "GET /hub/goals/:id -> GoalState",
  createGoal: "POST /hub/goals GoalDraft -> { goal: Goal }",
  updateGoal: "PUT /hub/goals/:id GoalUpdate -> { goal: Goal }",
  deleteGoal: "DELETE /hub/goals/:id -> 204",
  addChecks: "POST /hub/goals/:id/checks { checks: CheckRef[] } -> { goal }",
  removeCheck: "DELETE /hub/goals/:id/checks/:checkId -> { goal }",
  updateCheck: "PUT /hub/goals/:id/checks/:checkId CheckUpdate -> { goal }",
  signOff: "POST /hub/goals/:id/sign-off { note? } -> { goal }",
  clearSignOff: "DELETE /hub/goals/:id/sign-off -> { goal }",
  writePlaytests: "POST /hub/goals/:id/write-playtests { text? } -> 202 { sessionId }",
  check: "GET /hub/checks/:checkId?limit=&before= -> CheckDetail",
  runs: "GET /hub/runs?check=&limit=&before= -> { runs: RunRecord[], more: boolean }",
  run: "GET /hub/runs/:runId -> RunDetail",
  addRunLink: "POST /hub/runs/:runId/links { link: TrackerLink } -> { record: RunRecord }",
  removeRunLink: "DELETE /hub/runs/:runId/links?url= -> { record: RunRecord }",
  queue: "GET /hub/queue -> QueueState",
  plan: "POST /hub/plans PlanRequest -> { plan: PlanRun }",
  cancelPlan: "POST /hub/plans/:id/cancel -> { plan }",
  movePlan: "POST /hub/plans/:id/move { to: number } -> QueueState",
  pause: "PUT /hub/queue/paused { paused: boolean } -> QueueState",
  createSchedule: "POST /hub/schedules ScheduleDraft -> { schedule }",
  updateSchedule: "PUT /hub/schedules/:id Partial<ScheduleDraft> -> { schedule }",
  deleteSchedule: "DELETE /hub/schedules/:id -> 204",
  assignFailing: "POST /hub/assign-failing { goalId? } -> { queued: number }",
  runCheck: "POST /hub/checks/:checkId/run { replay? } -> { plan: PlanRun }",
} as const;

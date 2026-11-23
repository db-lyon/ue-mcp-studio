/**
 * The Playtest Hub's client logic, shared by the web client and (later) the
 * phone: the API over HUB_ROUTES, the hub's own routes inside #/playtests,
 * the status ladder's look, sorting, filters, view models, form validation,
 * the keyboard map, the command palette's search and every string the hub
 * shows. No React, no DOM: each client draws these its own way.
 */
import {
  CHECK_HEALTH_ORDER,
  DEFAULT_ACCEPTANCE,
  GOAL_STATUS_ORDER,
  ATTENTION_ORDER,
  HUB_CHANGED,
  TRACKER_LINKS_MAX,
  TRACKER_LINK_RELS,
  checkId as checkIdOf,
  goalChecksDeep,
  leafName,
  loopIfRequired,
  linkHost,
  planOptionsFor,
  trackerLinkOf,
  type CheckDetail,
  type CheckUpdate,
  type TrackerLink,
  type CheckHealth,
  type CheckKind,
  type CheckRef,
  type CheckState,
  type Goal,
  type GoalDraft,
  type GoalPriority,
  type GoalState,
  type GoalStatus,
  type GoalUpdate,
  type HubOverview,
  type AttentionItem,
  type AttentionKind,
  type PlanItemState,
  type PlanRequest,
  type PlanRun,
  type PlanScope,
  type PlanState,
  type QaRun,
  type QaVerdict,
  type QueueState,
  type RunDetail,
  type RunOutcome,
  type RunRecord,
  type RunSource,
  type RunStepSpan,
  type Schedule,
  type ScheduleDraft,
  type ViewportEditorState,
  type ViewportStatus,
} from "@ue-mcp-studio/shared";
import { requestJson, type Transport } from "./transport.js";
import type { ViewerPhase } from "./viewport.js";

// ---------- API ----------

/** One JSON request: the web client passes its fetch `call`, the phone `requestJson` over its sealed transport. */
export type HubRequest = <T>(method: string, path: string, body?: unknown) => Promise<T>;

export const HUB_BASE = "/v1/ext/studio/hub";
const QA_BASE = "/v1/ext/studio/qa";
const enc = encodeURIComponent;

const pageQuery = (q: Record<string, string | number | undefined | null>): string => {
  const parts = Object.entries(q).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => `${k}=${enc(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
};

/**
 * The hub's routes (HUB_ROUTES in shared), typed. Verdicts and the fix loop
 * go through the existing /qa/runs/:id routes, as HUB_ROUTES says.
 */
export function hubApi(request: HubRequest) {
  const goal = (id: string) => `${HUB_BASE}/goals/${enc(id)}`;
  return {
    overview: () => request<HubOverview>("GET", HUB_BASE),
    goal: (id: string) => request<GoalState>("GET", goal(id)),
    createGoal: (draft: GoalDraft) => request<{ goal: Goal }>("POST", `${HUB_BASE}/goals`, draft),
    updateGoal: (id: string, u: GoalUpdate) => request<{ goal: Goal }>("PUT", goal(id), u),
    deleteGoal: (id: string) => request<void>("DELETE", goal(id)),
    addChecks: (id: string, checks: CheckRef[]) => request<{ goal: Goal }>("POST", `${goal(id)}/checks`, { checks }),
    removeCheck: (id: string, checkId: string) => request<{ goal: Goal }>("DELETE", `${goal(id)}/checks/${enc(checkId)}`),
    updateCheck: (id: string, checkId: string, u: CheckUpdate) => request<{ goal: Goal }>("PUT", `${goal(id)}/checks/${enc(checkId)}`, u),
    orderChecks: (id: string, order: string[]) => request<{ goal: Goal }>("PUT", `${goal(id)}/checks/order`, { order }),
    /** Make a goal require another, or change whether it is required. */
    addRequire: (id: string, goalId: string, required?: boolean) => request<{ goal: Goal }>("POST", `${goal(id)}/requires`, required === undefined ? { goal: goalId } : { goal: goalId, required }),
    removeRequire: (id: string, goalId: string) => request<{ goal: Goal }>("DELETE", `${goal(id)}/requires/${enc(goalId)}`),
    orderRequires: (id: string, order: string[]) => request<{ goal: Goal }>("PUT", `${goal(id)}/requires`, { order }),
    signOff: (id: string, note?: string) => request<{ goal: Goal }>("POST", `${goal(id)}/sign-off`, note ? { note } : {}),
    clearSignOff: (id: string) => request<{ goal: Goal }>("DELETE", `${goal(id)}/sign-off`),
    writePlaytests: (id: string, text?: string) => request<{ sessionId: string }>("POST", `${goal(id)}/write-playtests`, text ? { text } : {}),
    check: (checkId: string, page: { limit?: number; before?: string } = {}) =>
      request<CheckDetail>("GET", `${HUB_BASE}/checks/${enc(checkId)}${pageQuery(page)}`),
    runs: (q: { check?: string; limit?: number; before?: string } = {}) => request<{ runs: RunRecord[]; more: boolean }>("GET", `${HUB_BASE}/runs${pageQuery(q)}`),
    run: (runId: string) => request<RunDetail>("GET", `${HUB_BASE}/runs/${enc(runId)}`),
    addRunLink: (runId: string, link: TrackerLink) => request<{ record: RunRecord }>("POST", `${HUB_BASE}/runs/${enc(runId)}/links`, { link }),
    removeRunLink: (runId: string, url: string) => request<{ record: RunRecord }>("DELETE", `${HUB_BASE}/runs/${enc(runId)}/links${pageQuery({ url })}`),
    queue: () => request<QueueState>("GET", `${HUB_BASE}/queue`),
    plan: (req: PlanRequest) => request<{ plan: PlanRun }>("POST", `${HUB_BASE}/plans`, req),
    cancelPlan: (id: string) => request<{ plan: PlanRun }>("POST", `${HUB_BASE}/plans/${enc(id)}/cancel`, {}),
    movePlan: (id: string, to: number) => request<QueueState>("POST", `${HUB_BASE}/plans/${enc(id)}/move`, { to }),
    pause: (paused: boolean) => request<QueueState>("PUT", `${HUB_BASE}/queue/paused`, { paused }),
    createSchedule: (s: ScheduleDraft) => request<{ schedule: Schedule }>("POST", `${HUB_BASE}/schedules`, s),
    updateSchedule: (id: string, s: Partial<ScheduleDraft>) => request<{ schedule: Schedule }>("PUT", `${HUB_BASE}/schedules/${enc(id)}`, s),
    deleteSchedule: (id: string) => request<void>("DELETE", `${HUB_BASE}/schedules/${enc(id)}`),
    assignFailing: (goalId?: string) => request<{ queued: number }>("POST", `${HUB_BASE}/assign-failing`, goalId ? { goalId } : {}),
    runCheck: (checkId: string, replay?: boolean) => request<{ plan: PlanRun }>("POST", `${HUB_BASE}/checks/${enc(checkId)}/run`, replay ? { replay } : {}),
    /** A manual step's verdict: the existing playtest route, so the card in chat settles too. */
    verdict: (runId: string, step: number, verdict: QaVerdict, note?: string) =>
      request<{ run: QaRun }>("POST", `${QA_BASE}/runs/${enc(runId)}/verdict`, note ? { step, verdict, note } : { step, verdict }),
    /** Hand a run's failure to a subagent: the existing fix loop. */
    assign: (runId: string) => request<{ run: QaRun }>("POST", `${QA_BASE}/runs/${enc(runId)}/assign`, {}),
    resultsUrl: (runId: string) => `${QA_BASE}/runs/${enc(runId)}/results`,
  };
}
export type HubApi = ReturnType<typeof hubApi>;

/** The hub API over a Transport, for a client that has one (the phone). */
export const hubApiOver = (transport: Transport): HubApi =>
  hubApi(<T>(method: string, path: string, body?: unknown) => requestJson<T>(transport, method, path, body === undefined ? undefined : { json: body }));

// ---------- Routes inside #/playtests ----------

export type HubScreen = "overview" | "goal" | "library" | "check" | "run" | "queue";
export type HubRoute =
  | { screen: "overview" }
  | { screen: "goal"; goalId: string }
  | { screen: "library" }
  | { screen: "check"; checkId: string }
  | { screen: "run"; runId: string }
  | { screen: "queue" };

const decode = (s: string): string | null => {
  try {
    const d = decodeURIComponent(s);
    return d ? d : null;
  } catch {
    return null;
  }
};

/**
 * The hub's screen from what follows #/playtests/ (still encoded):
 * goals/<id>, checks, checks/<checkId>, runs/<runId>, queue. Anything else is
 * the overview.
 */
export function parseHubPath(sub: string | null | undefined): HubRoute {
  const parts = (sub ?? "").split("/").filter(Boolean);
  const [head, id] = parts;
  const value = id ? decode(id) : null;
  switch (head) {
    case "queue": return { screen: "queue" };
    case "checks": return value ? { screen: "check", checkId: value } : { screen: "library" };
    case "goals": return value ? { screen: "goal", goalId: value } : { screen: "overview" };
    case "runs": return value ? { screen: "run", runId: value } : { screen: "overview" };
    default: return { screen: "overview" };
  }
}

/** What follows #/playtests/ for a screen; empty for the overview. */
export function hubPath(r: HubRoute): string {
  switch (r.screen) {
    case "overview": return "";
    case "queue": return "queue";
    case "library": return "checks";
    case "goal": return `goals/${enc(r.goalId)}`;
    case "check": return `checks/${enc(r.checkId)}`;
    case "run": return `runs/${enc(r.runId)}`;
  }
}

/** The full hash of a hub screen, the link every hub object carries. */
export const hubHash = (r: HubRoute): string => {
  const p = hubPath(r);
  return p ? `#/playtests/${p}` : "#/playtests";
};

/** Which rail entry a screen sits under. */
export function hubSection(r: HubRoute): "overview" | "library" | "queue" {
  if (r.screen === "queue") return "queue";
  if (r.screen === "library" || r.screen === "check") return "library";
  return "overview";
}

// ---------- The status ladder ----------

/** A mark's shape. Every status has its own, so none is told apart by colour alone. */
export type StatusGlyph = "needs" | "fail" | "missing" | "running" | "flaky" | "stale" | "never" | "check" | "risk" | "skip" | "stop" | "queued";
/** The colour token a status takes: attention and warn are the amber, bad the red, ok the green, run the accent, idle the grey. */
export type StatusTone = "attention" | "bad" | "warn" | "run" | "ok" | "idle";
export interface StatusLook {
  label: string;
  glyph: StatusGlyph;
  tone: StatusTone;
}

export const CHECK_HEALTH_LOOK: Record<CheckHealth, StatusLook> = {
  needs_you: { label: "Needs you", glyph: "needs", tone: "attention" },
  failing: { label: "Failing", glyph: "fail", tone: "bad" },
  missing: { label: "Missing", glyph: "missing", tone: "bad" },
  running: { label: "Running", glyph: "running", tone: "run" },
  flaky: { label: "Flaky", glyph: "flaky", tone: "warn" },
  stale: { label: "Stale", glyph: "stale", tone: "warn" },
  never_run: { label: "Never run", glyph: "never", tone: "idle" },
  passing: { label: "Passing", glyph: "check", tone: "ok" },
};

export const GOAL_STATUS_LOOK: Record<GoalStatus, StatusLook> = {
  needs_you: { label: "Needs you", glyph: "needs", tone: "attention" },
  failing: { label: "Failing", glyph: "fail", tone: "bad" },
  at_risk: { label: "At risk", glyph: "risk", tone: "warn" },
  running: { label: "Running", glyph: "running", tone: "run" },
  not_started: { label: "Not started", glyph: "never", tone: "idle" },
  met: { label: "Met", glyph: "check", tone: "ok" },
};

export const RUN_OUTCOME_LOOK: Record<RunOutcome, StatusLook> = {
  needs_you: { label: "Needs you", glyph: "needs", tone: "attention" },
  failed: { label: "Failed", glyph: "fail", tone: "bad" },
  error: { label: "Error", glyph: "fail", tone: "bad" },
  running: { label: "Running", glyph: "running", tone: "run" },
  incomplete: { label: "Incomplete", glyph: "risk", tone: "warn" },
  unjudged: { label: "Not judged", glyph: "skip", tone: "idle" },
  stopped: { label: "Stopped", glyph: "stop", tone: "idle" },
  passed: { label: "Passed", glyph: "check", tone: "ok" },
};

export const PLAN_ITEM_LOOK: Record<PlanItemState, StatusLook> = {
  needs_you: { label: "Needs you", glyph: "needs", tone: "attention" },
  failed: { label: "Failed", glyph: "fail", tone: "bad" },
  error: { label: "Error", glyph: "fail", tone: "bad" },
  unjudged: { label: "Not judged", glyph: "skip", tone: "idle" },
  running: { label: "Running", glyph: "running", tone: "run" },
  queued: { label: "Queued", glyph: "queued", tone: "idle" },
  skipped: { label: "Skipped", glyph: "skip", tone: "idle" },
  cancelled: { label: "Cancelled", glyph: "stop", tone: "idle" },
  passed: { label: "Passed", glyph: "check", tone: "ok" },
};

export const PLAN_STATE_LABEL: Record<PlanState, string> = {
  queued: "Queued", running: "Running", paused: "Paused", done: "Done", cancelled: "Cancelled", failed: "Failed",
};

/** A step's status in the hub's ladder, for the run timeline. */
export const STEP_LOOK: Record<RunStepSpan["status"], StatusLook> = {
  awaiting_verdict: { label: "Needs you", glyph: "needs", tone: "attention" },
  failed: { label: "Failed", glyph: "fail", tone: "bad" },
  running: { label: "Running", glyph: "running", tone: "run" },
  pending: { label: "Not run", glyph: "queued", tone: "idle" },
  skipped: { label: "Skipped", glyph: "skip", tone: "idle" },
  passed: { label: "Passed", glyph: "check", tone: "ok" },
};

const rank = <T>(order: readonly T[]) => (v: T): number => {
  const i = order.indexOf(v);
  return i < 0 ? order.length : i;
};
export const healthRank = rank(CHECK_HEALTH_ORDER);
export const goalStatusRank = rank(GOAL_STATUS_ORDER);
export const attentionRank = rank(ATTENTION_ORDER);

// ---------- Labels ----------

export const CHECK_KIND_LABEL: Record<CheckKind, string> = {
  script: "Test script",
  uat: "UAT scenario",
  repro: "Reproduction test",
  automation: "Automation filter",
  manual: "Manual item",
};

export const PRIORITIES: readonly GoalPriority[] = ["p0", "p1", "p2", "p3"];
export const PRIORITY_LABEL: Record<GoalPriority, string> = { p0: "P0 Urgent", p1: "P1 High", p2: "P2 Normal", p3: "P3 Low" };
export const PRIORITY_SHORT: Record<GoalPriority, string> = { p0: "P0", p1: "P1", p2: "P2", p3: "P3" };

export const ATTENTION_KIND_LABEL: Record<AttentionKind, string> = {
  loop_blocked: "Fix loop stopped",
  sign_off: "Sign-off",
  regression: "Regression",
  missing_check: "Missing check",
  plan_failed: "Plan failed",
};

export const RUN_SOURCE_LABEL: Record<RunSource, string> = {
  person: "Started by a person",
  agent: "Started by an agent",
  plan: "Part of a plan",
  schedule: "Scheduled",
  outside: "Started outside Studio",
};

/** Every string the hub shows that is not a status or a kind, in one place for both clients. */
export const HUB_COPY = {
  title: "Playtests",
  overview: "Overview",
  attention: "Needs attention",
  goals: "Goals",
  library: "Library",
  queue: "Queue",
  newGoal: "New goal",
  editGoal: "Edit goal",
  runGoal: "Run goal",
  runFailing: "Run failing",
  runAll: "Run all",
  runSelected: "Run selected",
  addToGoal: "Add to goal",
  addChecks: "Add checks",
  assignFailing: "Assign failing",
  writePlaytests: "Write playtests for this goal",
  signOff: "Sign off",
  clearSignOff: "Clear sign-off",
  otherGoals: "Other goals",
  partOf: "Part of",
  requiredGoals: "Required goals",
  addGoal: "Add goal",
  newGoalHere: "New goal here",
  optional: "optional",
  notInMilestone: "Not part of any milestone",
  notInGoal: "Not part of any goal",
  noRequiredGoals: "A goal can require other goals. It is met only when they are.",
  noGoalsInMilestone: "No goals in this milestone yet.",
  unusedChecks: (n: number) => `${n} ${n === 1 ? "check is" : "checks are"} not part of any goal`,
  attentionEmpty: "Nothing needs attention.",
  attended: "Someone is there to judge manual steps",
  attendedHelp: "Without someone there, checks with manual steps are skipped. With someone there, each run holds at its manual steps for a verdict.",
  noGoalsTitle: "No goals yet",
  noGoalsLead: "A goal is something the game must do, proven by the playtests linked to it. Its status follows their runs.",
  noChecksLead: "This project has no test scripts yet. Ask for one in Chat with /playtest.",
  scriptsFound: (n: number) => `${n} test ${n === 1 ? "script" : "scripts"} in this project`,
  libraryEmpty: "No checks match.",
  queueIdle: "Nothing is running.",
  queueEmpty: "Nothing queued.",
  paused: "Paused: runs wait until the queue resumes.",
  editorDown: "The editor is not connected. Queued runs start when it is back.",
  filterPlaceholder: "Filter by name, map or goal",
  palettePlaceholder: "Jump to a goal, check or run, or type a command",
  paletteEmpty: "No matches.",
  failNoteLabel: "What went wrong?",
  noSchedules: "No schedules.",
  shortcuts: "Keyboard shortcuts",
} as const;

// ---------- Time ----------

/** A short age: "now", "5m", "3h", "2d", "5w", or the date. */
export function shortAgo(iso: string | null | undefined, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "";
  const m = Math.floor((now - t) / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d`;
  if (d < 60) return `${Math.floor(d / 7)}w`;
  return new Date(t).toLocaleDateString();
}

/** A run's length: "850ms", "42s", "3m 05s". */
export function runLength(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** A due date against today: "Due today", "Due in 3 days", "3 days overdue", or the date itself past two weeks. */
export function dueText(due: string | null | undefined, now = Date.now()): { text: string; overdue: boolean } | null {
  if (!due || !DATE.test(due)) return null;
  const today = new Date(now);
  const start = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const [y, mo, d] = due.split("-").map(Number);
  const days = Math.round((Date.UTC(y, mo - 1, d) - start) / 86_400_000);
  if (days === 0) return { text: "Due today", overdue: false };
  if (days < 0) return { text: `${-days} ${days === -1 ? "day" : "days"} overdue`, overdue: true };
  if (days === 1) return { text: "Due tomorrow", overdue: false };
  if (days <= 14) return { text: `Due in ${days} days`, overdue: false };
  return { text: `Due ${due}`, overdue: false };
}

// ---------- Sorting and grouping ----------

const byText = (a: string, b: string): number => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
const dueKey = (g: Goal): string => g.due ?? "9999-99-99";
const prioKey = (g: Goal): number => (g.priority ? PRIORITIES.indexOf(g.priority) : 2);

/** Goals worst first, then by priority, then due date, then title. */
export function sortGoals(goals: readonly GoalState[]): GoalState[] {
  return [...goals].sort((a, b) =>
    goalStatusRank(a.status) - goalStatusRank(b.status)
    || prioKey(a.goal) - prioKey(b.goal)
    || byText(dueKey(a.goal), dueKey(b.goal))
    || byText(a.goal.title, b.goal.title));
}

/** Checks worst first, then the most recently run, then by name. */
export function sortChecks(checks: readonly CheckState[]): CheckState[] {
  return [...checks].sort((a, b) =>
    healthRank(a.health) - healthRank(b.health)
    || byText(b.last?.startedAt ?? "", a.last?.startedAt ?? "")
    || byText(a.name, b.name));
}

/** Needs attention in ATTENTION_ORDER, oldest first within a kind, so the longest wait comes first. */
export function sortAttention(items: readonly AttentionItem[]): AttentionItem[] {
  return [...items].sort((a, b) => attentionRank(a.kind) - attentionRank(b.kind) || byText(a.at, b.at) || byText(a.id, b.id));
}

export interface MilestoneGroup {
  /** null: goals nothing requires (Other goals). */
  milestone: GoalState | null;
  goals: GoalState[];
}

/**
 * Goals under their milestones, for the overview: milestones by due date then
 * worst status, each with the goals it requires in its own order. A goal two
 * milestones require is in both groups, as the same GoalState. Goals that
 * nothing requires come last; a goal required only by other goals shows on
 * their screens. Archived goals are left out.
 */
export function milestoneGroups(all: readonly GoalState[]): MilestoneGroup[] {
  const live = all.filter((g) => !g.goal.archived);
  const byId = new Map(live.map((g) => [g.goal.id, g]));
  const milestones = live.filter((g) => g.goal.kind === "milestone");
  const groups: MilestoneGroup[] = [...milestones]
    .sort((a, b) => byText(dueKey(a.goal), dueKey(b.goal)) || goalStatusRank(a.status) - goalStatusRank(b.status) || byText(a.goal.title, b.goal.title))
    .map((m) => ({ milestone: m, goals: requiredGoals(m, byId) }));
  const loose = live.filter((g) => g.goal.kind !== "milestone" && g.parents.length === 0);
  if (loose.length) groups.push({ milestone: null, goals: sortGoals(loose) });
  return groups;
}

/** The goals a goal requires, in its order, as states; goals not in the list are left out. */
function requiredGoals(g: GoalState, byId: ReadonlyMap<string, GoalState>): GoalState[] {
  return (g.requires ?? []).map((r) => byId.get(r.goal)).filter((x): x is GoalState => !!x);
}

/** A goal's required goals for its screen: each with whether it is required, in the goal's order. Unknown goals are left out. */
export function requiredRows(g: GoalState, all: readonly GoalState[]): Array<{ state: GoalState; required: boolean }> {
  const byId = new Map(all.map((x) => [x.goal.id, x]));
  return (g.requires ?? []).flatMap((r) => {
    const state = byId.get(r.goal);
    return state && !state.goal.archived ? [{ state, required: r.required }] : [];
  });
}

/** The goals that require this one, as states: milestones first, then goals, each by title. */
export function parentGoals(g: GoalState, all: readonly GoalState[]): GoalState[] {
  const ps = all.filter((x) => (g.parents ?? []).includes(x.goal.id));
  return ps.sort((a, b) => (a.goal.kind === b.goal.kind ? byText(a.goal.title, b.goal.title) : a.goal.kind === "milestone" ? -1 : 1));
}

/** Every check id running this goal runs: its required goals' at any depth, then its own. */
export function goalCheckIds(goalId: string, all: readonly GoalState[]): string[] {
  return goalChecksDeep(all.map((g) => g.goal), goalId).map(checkIdOf);
}

/** The goals this goal can be made to require: live, not itself, not required already, and none that would make a loop. */
export function requireCandidates(goalId: string, all: readonly GoalState[]): GoalState[] {
  const goals = all.map((g) => g.goal);
  const self = all.find((g) => g.goal.id === goalId);
  const have = new Set((self?.goal.requires ?? []).map((r) => r.goal));
  return sortGoals(all.filter((g) => !g.goal.archived && g.goal.id !== goalId && !have.has(g.goal.id) && !loopIfRequired(goals, goalId, g.goal.id)));
}

/** The goals a goal can be part of: live, not itself, and none it already requires at any depth (that would make a loop). Milestones first. */
export function parentCandidates(goalId: string | null, all: readonly GoalState[]): GoalState[] {
  const goals = all.map((g) => g.goal);
  const ok = all.filter((g) => !g.goal.archived && g.goal.id !== goalId && (!goalId || !loopIfRequired(goals, g.goal.id, goalId)));
  return ok.sort((a, b) => (a.goal.kind === b.goal.kind ? byText(a.goal.title, b.goal.title) : a.goal.kind === "milestone" ? -1 : 1));
}

/** Ids with one moved by `by` places (up is -1), kept inside the list; the same list when it cannot move. */
export function moveId(ids: readonly string[], id: string, by: number): string[] {
  const from = ids.indexOf(id);
  const to = Math.max(0, Math.min(ids.length - 1, from + by));
  if (from < 0 || to === from) return [...ids];
  const next = ids.slice();
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

/** How many goals (not milestones) are in each status. */
export function goalCounts(all: readonly GoalState[]): Record<GoalStatus, number> {
  const out = Object.fromEntries(GOAL_STATUS_ORDER.map((s) => [s, 0])) as Record<GoalStatus, number>;
  for (const g of all) if (!g.goal.archived && g.goal.kind !== "milestone") out[g.status]++;
  return out;
}

/** The overview's one-line summary: "8 goals: 2 failing, 1 needs you, 5 met". */
export function goalSummary(all: readonly GoalState[]): string {
  const counts = goalCounts(all);
  const total = GOAL_STATUS_ORDER.reduce((n, s) => n + counts[s], 0);
  if (total === 0) return "No goals";
  const parts = GOAL_STATUS_ORDER.filter((s) => counts[s] > 0).map((s) => `${counts[s]} ${GOAL_STATUS_LOOK[s].label.toLowerCase()}`);
  return `${total} ${total === 1 ? "goal" : "goals"}: ${parts.join(", ")}`;
}

/**
 * Checks that just broke: the newest finished run failed and the one before
 * it passed. Newest break first.
 */
export function regressions(checks: readonly CheckState[]): CheckState[] {
  return checks
    .filter((c) => c.recent[0] === "failed" && c.recent[1] === "passed")
    .sort((a, b) => byText(b.last?.startedAt ?? "", a.last?.startedAt ?? ""));
}

/** How often a check's result flipped between passed and failed across its recent runs. */
export function flips(recent: readonly RunOutcome[]): number {
  const pf = recent.filter((o) => o === "passed" || o === "failed");
  let n = 0;
  for (let i = 1; i < pf.length; i++) if (pf[i] !== pf[i - 1]) n++;
  return n;
}

/** Pass rate as text: "85%" or "No runs". */
export const passRateText = (rate: number | null): string => (rate === null ? "No runs" : `${Math.round(rate * 100)}%`);

/** The goal's progress as words, counting its required checks and required goals: "3 of 5 requirements met". */
export function progressText(p: { met: number; total: number }): string {
  if (p.total === 0) return "Nothing required yet";
  return `${p.met} of ${p.total} ${p.total === 1 ? "requirement" : "requirements"} met`;
}

/** A goal's acceptance rule in a sentence. */
export function acceptanceText(goal: Pick<Goal, "acceptance">): string {
  const a = goal.acceptance;
  const runs = a.stableRuns <= 1 ? "passes its latest run" : `passes its last ${a.stableRuns} runs`;
  const parts = [`Each required check ${runs}`];
  parts.push(a.staleAfterDays === null ? "never stale" : `stale after ${a.staleAfterDays} ${a.staleAfterDays === 1 ? "day" : "days"}`);
  if (a.signOff) parts.push("needs sign-off");
  return parts.join(", ") + ".";
}

// ---------- Sparklines and charts ----------

export interface SparkBar {
  outcome: RunOutcome;
  /** Up for a pass, down for a failure, a tick on the line for anything else: shape, not only colour. */
  dir: "up" | "down" | "mid";
  tone: StatusTone;
}

/** A win/loss sparkline of recent outcomes (newest first in), oldest first out. */
export function sparkBars(recent: readonly RunOutcome[], max = 20): SparkBar[] {
  return recent.slice(0, max).reverse().map((o) => ({
    outcome: o,
    dir: o === "passed" ? "up" : o === "failed" || o === "error" ? "down" : "mid",
    tone: RUN_OUTCOME_LOOK[o].tone,
  }));
}

/** Spoken form of a sparkline. */
export function sparkLabel(recent: readonly RunOutcome[]): string {
  const done = recent.filter((o) => o === "passed" || o === "failed");
  if (recent.length === 0) return "No runs yet";
  const passed = done.filter((o) => o === "passed").length;
  return `Last ${recent.length} ${recent.length === 1 ? "run" : "runs"}: ${passed} passed, ${done.length - passed} failed`;
}

/** An SVG path for a series of [ms, value] points scaled into w by h, and its range for the axis labels. */
export function seriesPath(points: ReadonlyArray<readonly [number, number]>, w: number, h: number, span?: { from: number; to: number }): { d: string; min: number; max: number } | null {
  const pts = points.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (pts.length === 0) return null;
  const x0 = span?.from ?? pts[0][0];
  const x1 = span?.to ?? pts[pts.length - 1][0];
  let min = Infinity;
  let max = -Infinity;
  for (const [, y] of pts) {
    if (y < min) min = y;
    if (y > max) max = y;
  }
  const dy = max - min || 1;
  const dx = x1 - x0 || 1;
  const pad = 2;
  const sx = (x: number) => ((x - x0) / dx) * w;
  const sy = (y: number) => pad + (1 - (y - min) / dy) * (h - pad * 2);
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${sx(x).toFixed(1)} ${sy(y).toFixed(1)}`).join(" ");
  return { d, min, max };
}

export interface TimelineBar {
  span: RunStepSpan;
  /** Percent of the run's length. */
  left: number;
  width: number;
}

/**
 * The run timeline: each step's bar on the run's clock, as percent of its
 * length. A step with no timing sits after the last timed one, with a sliver
 * of width, so it still shows and can be picked.
 */
export function runTimeline(steps: readonly RunStepSpan[]): { bars: TimelineBar[]; totalMs: number } {
  const ends = steps.map((s) => s.endMs ?? s.startMs ?? 0);
  const totalMs = Math.max(1, ...ends);
  let cursor = 0;
  const bars = steps.map((s) => {
    if (s.startMs === null) {
      const left = Math.min(99, (cursor / totalMs) * 100);
      return { span: s, left, width: 1 };
    }
    const end = s.endMs ?? s.startMs;
    cursor = Math.max(cursor, end);
    const left = (s.startMs / totalMs) * 100;
    return { span: s, left, width: Math.max(0.8, ((end - s.startMs) / totalMs) * 100) };
  });
  return { bars, totalMs };
}

// ---------- Library filters ----------

export type HealthFilter = "all" | "attention" | "failing" | "at_risk" | "never_run" | "passing" | "unlinked";
export const HEALTH_FILTERS: ReadonlyArray<{ id: HealthFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "attention", label: "Needs you" },
  { id: "failing", label: "Failing" },
  { id: "at_risk", label: "Flaky or stale" },
  { id: "never_run", label: "Never run" },
  { id: "passing", label: "Passing" },
  { id: "unlinked", label: "Not part of any goal" },
];

export function matchesHealth(c: CheckState, f: HealthFilter): boolean {
  switch (f) {
    case "all": return true;
    case "attention": return c.health === "needs_you";
    case "failing": return c.health === "failing" || c.health === "missing";
    case "at_risk": return c.health === "flaky" || c.health === "stale";
    case "never_run": return c.health === "never_run";
    case "passing": return c.health === "passing";
    case "unlinked": return c.goalIds.length === 0;
  }
}

export interface CheckQuery {
  health?: HealthFilter;
  /** A goal id, "none" for checks in no goal, or empty for any. */
  goalId?: string;
  kind?: CheckKind | "";
  text?: string;
}

/** The library's rows for a query, worst first. `goals` names goals for the text match. */
export function filterChecks(checks: readonly CheckState[], q: CheckQuery, goals: readonly GoalState[] = []): CheckState[] {
  const words = (q.text ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const title = new Map(goals.map((g) => [g.goal.id, g.goal.title.toLowerCase()]));
  return sortChecks(checks.filter((c) => {
    if (q.health && !matchesHealth(c, q.health)) return false;
    if (q.goalId === "none" ? c.goalIds.length > 0 : q.goalId && !c.goalIds.includes(q.goalId)) return false;
    if (q.kind && c.check.kind !== q.kind) return false;
    if (words.length) {
      const hay = [c.name, c.check.target, c.map ?? "", ...c.goalIds.map((id) => title.get(id) ?? id)].join(" ").toLowerCase();
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  }));
}

export const healthCounts = (checks: readonly CheckState[]): Record<HealthFilter, number> =>
  Object.fromEntries(HEALTH_FILTERS.map((f) => [f.id, checks.filter((c) => matchesHealth(c, f.id)).length])) as Record<HealthFilter, number>;

// ---------- Getting started ----------

export interface GoalProposal {
  title: string;
  checks: CheckRef[];
}

/**
 * Goals a project with scripts but no goals could start from: the scripts in
 * no goal, one goal per map they play in, and the rest together. A solo
 * developer gets a working overview in one click and renames later.
 */
export function proposeGoals(checks: readonly CheckState[]): GoalProposal[] {
  const loose = checks.filter((c) => c.goalIds.length === 0 && !c.missing && c.check.kind === "script");
  const byMap = new Map<string, CheckState[]>();
  for (const c of loose) {
    const key = c.map ? leafName(c.map) : "";
    byMap.set(key, [...(byMap.get(key) ?? []), c]);
  }
  const named = [...byMap.entries()].filter(([k]) => k).sort(([a], [b]) => byText(a, b));
  const out: GoalProposal[] = named.map(([map, cs]) => ({ title: `${map} plays through`, checks: cs.map((c) => c.check) }));
  const rest = byMap.get("");
  if (rest?.length) out.push({ title: named.length ? "Other playtests" : "Playtests pass", checks: rest.map((c) => c.check) });
  return out;
}

// ---------- Plans and the queue ----------

export interface PlanProgress {
  done: number;
  total: number;
  failed: number;
  waiting: number;
  current: PlanRun["items"][number] | null;
}

const SETTLED: readonly PlanItemState[] = ["passed", "failed", "unjudged", "skipped", "error", "cancelled"];

export function planProgress(p: Pick<PlanRun, "items">): PlanProgress {
  return {
    done: p.items.filter((i) => SETTLED.includes(i.state)).length,
    total: p.items.length,
    failed: p.items.filter((i) => i.state === "failed" || i.state === "error").length,
    waiting: p.items.filter((i) => i.state === "needs_you").length,
    current: p.items.find((i) => i.state === "running" || i.state === "needs_you") ?? null,
  };
}

/** What a plan covers, in words. */
export function scopeText(scope: PlanScope, goals: readonly GoalState[] = []): string {
  const goalTitle = (id?: string) => (id ? goals.find((g) => g.goal.id === id)?.goal.title ?? id : null);
  switch (scope.kind) {
    case "goal": return `Goal: ${goalTitle(scope.goalId)}`;
    case "checks": return `${scope.checks.length} ${scope.checks.length === 1 ? "check" : "checks"}`;
    case "failing": return scope.goalId ? `Failing in ${goalTitle(scope.goalId)}` : "Every failing check";
    case "stale": return scope.goalId ? `Stale in ${goalTitle(scope.goalId)}` : "Every stale check";
    case "all": return "Every check";
  }
}

/** The queue with a plan moved, as the server will order it, for an optimistic reorder. */
export function moveQueued(q: QueueState, id: string, to: number): QueueState {
  const from = q.queued.findIndex((p) => p.id === id);
  if (from < 0) return q;
  const next = q.queued.slice();
  const [p] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, p);
  return { ...q, queued: next };
}

// ---------- Schedules ----------

export const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const WEEKDAYS = [1, 2, 3, 4, 5];

/** When a schedule runs: "Every day at 02:00", "Weekdays at 02:00", "Mon, Thu at 18:30". */
export function scheduleText(s: Pick<Schedule, "days" | "at">): string {
  const days = [...new Set(s.days)].filter((d) => d >= 0 && d <= 6).sort();
  const when = days.length === 7 ? "Every day"
    : days.length === 5 && WEEKDAYS.every((d) => days.includes(d)) ? "Weekdays"
    : days.length === 2 && days.includes(0) && days.includes(6) ? "Weekends"
    : days.length === 0 ? "Never"
    : days.map((d) => DAY_SHORT[d]).join(", ");
  return `${when} at ${s.at}`;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function scheduleErrors(s: Pick<ScheduleDraft, "title" | "at" | "days" | "scope">): Partial<Record<"title" | "at" | "days" | "scope", string>> {
  const e: Partial<Record<"title" | "at" | "days" | "scope", string>> = {};
  if (!s.title.trim()) e.title = "Give the schedule a name.";
  if (!TIME.test(s.at)) e.at = "Use a 24-hour time, such as 02:00.";
  if (s.days.length === 0) e.days = "Pick at least one day.";
  if (s.scope.kind === "goal" && !s.scope.goalId) e.scope = "Pick a goal.";
  return e;
}

export const blankSchedule = (): ScheduleDraft => ({
  title: "Nightly",
  scope: { kind: "all" },
  options: planOptionsFor("schedule"),
  at: "02:00",
  days: [0, 1, 2, 3, 4, 5, 6],
  enabled: true,
});

// ---------- The goal form ----------

/** The goal form as its inputs hold it: strings, so a half-typed number is kept as typed. */
export interface GoalForm {
  title: string;
  description: string;
  kind: Goal["kind"];
  /** The goals and milestones this goal is part of: saving writes their files. */
  parents: string[];
  owner: string;
  priority: GoalPriority | "";
  due: string;
  tags: string;
  stableRuns: string;
  /** Empty: never stale. */
  staleAfterDays: string;
  signOff: boolean;
  /** The goal's links as typed, one row each; a row with no URL is left out. */
  links: LinkRow[];
}

export type GoalFormErrors = Partial<Record<keyof GoalForm, string>>;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TAG = /^[\p{Letter}\p{Number}][\p{Letter}\p{Number}._-]{0,31}$/u;
export const GOAL_TITLE_MAX = 120;

/** The form for a goal, or a blank one; `parents` from its GoalState, since the goal's own file does not hold them. */
export function goalFormOf(g?: Partial<Goal> | null, parents: readonly string[] = []): GoalForm {
  const a = g?.acceptance ?? DEFAULT_ACCEPTANCE;
  return {
    title: g?.title ?? "",
    description: g?.description ?? "",
    kind: g?.kind ?? "goal",
    parents: [...parents],
    owner: g?.owner ?? "",
    priority: g?.priority ?? "",
    due: g?.due ?? "",
    tags: (g?.tags ?? []).join(", "),
    stableRuns: String(a.stableRuns),
    staleAfterDays: a.staleAfterDays === null ? "" : String(a.staleAfterDays),
    signOff: a.signOff,
    links: (g?.links ?? []).map(linkRowOf),
  };
}

/** Tags from what was typed: split on commas and spaces, a leading # dropped, duplicates removed. */
export function parseTags(text: string): string[] {
  const out: string[] = [];
  for (const t of text.split(/[,\s]+/)) {
    const tag = t.replace(/^#/, "").trim();
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

function validDate(s: string): boolean {
  if (!DATE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** What is wrong with the form, field by field; empty when it can be saved. */
export function goalFormErrors(f: GoalForm, ctx: { selfId?: string; goals?: readonly GoalState[] } = {}): GoalFormErrors {
  const e: GoalFormErrors = {};
  const title = f.title.trim();
  if (!title) e.title = "A goal needs a title.";
  else if (title.length > GOAL_TITLE_MAX) e.title = `Keep the title under ${GOAL_TITLE_MAX} characters.`;
  if (f.due && !validDate(f.due)) e.due = "Use a date, such as 2026-12-31.";
  const runs = Number(f.stableRuns);
  if (!/^\d+$/.test(f.stableRuns.trim()) || runs < 1 || runs > 10) e.stableRuns = "From 1 to 10 runs.";
  if (f.staleAfterDays.trim()) {
    const days = Number(f.staleAfterDays);
    if (!/^\d+$/.test(f.staleAfterDays.trim()) || days < 1 || days > 365) e.staleAfterDays = "From 1 to 365 days, or empty for never.";
  }
  const bad = parseTags(f.tags).find((t) => !TAG.test(t));
  if (bad) e.tags = `"${bad}" is not a tag: letters, numbers, dots, dashes and underscores, up to 32.`;
  if (f.parents.length) {
    const goals = ctx.goals?.map((g) => g.goal);
    const self = f.parents.find((p) => p === ctx.selfId);
    const unknown = goals && f.parents.find((p) => !goals.some((g) => g.id === p));
    const loop = goals && ctx.selfId && f.parents.find((p) => loopIfRequired(goals, p, ctx.selfId!));
    if (self) e.parents = "A goal cannot be part of itself.";
    else if (unknown) e.parents = "Pick goals from the list.";
    else if (loop) e.parents = `This goal already requires ${goals!.find((g) => g.id === loop)?.title ?? loop}, so it cannot also be part of it.`;
  }
  const rows = f.links.filter((r) => r.url.trim());
  const badLink = rows.map(linkFromRow).find((r): r is { error: string } => "error" in r);
  if (badLink) e.links = badLink.error;
  else if (rows.length > TRACKER_LINKS_MAX) e.links = `Keep it to ${TRACKER_LINKS_MAX} links.`;
  return e;
}

/** The draft to create a goal from a valid form. */
export function goalDraftOf(f: GoalForm): GoalDraft {
  return {
    title: f.title.trim(),
    kind: f.kind,
    ...(f.description.trim() ? { description: f.description.trim() } : {}),
    parents: [...f.parents],
    owner: f.owner.trim() || null,
    ...(f.priority ? { priority: f.priority } : {}),
    due: f.due || null,
    tags: parseTags(f.tags),
    acceptance: {
      stableRuns: Number(f.stableRuns),
      staleAfterDays: f.staleAfterDays.trim() ? Number(f.staleAfterDays) : null,
      signOff: f.signOff,
    },
    links: f.links.filter((r) => r.url.trim()).map(linkFromRow).flatMap((r) => ("link" in r ? [r.link] : [])),
  };
}

/** The update for an existing goal from a valid form: every field the form holds, so clearing one clears it. */
export function goalUpdateOf(f: GoalForm): GoalUpdate {
  const d = goalDraftOf(f);
  return { ...d, description: d.description ?? "", priority: d.priority };
}

// ---------- Tracker links ----------

/** A link as a form holds it: strings, as typed. */
export interface LinkRow {
  url: string;
  title: string;
  rel: string;
}

export const linkRowOf = (l?: Partial<TrackerLink> | null): LinkRow => ({ url: l?.url ?? "", title: l?.title ?? "", rel: l?.rel ?? "" });

/** The relationships a link form suggests, with their labels. Any other text is as valid. */
export const LINK_REL_LABEL: Record<(typeof TRACKER_LINK_RELS)[number], string> = {
  counterpart: "Counterpart",
  related: "Related",
  "filed-from-run": "Filed from a run",
  blocks: "Blocks",
};
export const LINK_RELS: ReadonlyArray<{ id: string; label: string }> = TRACKER_LINK_RELS.map((id) => ({ id, label: LINK_REL_LABEL[id] }));

/** What a typed URL most likely means: a bare host and path ("git.example.com/x/issues/4") is taken as https. */
export function typedUrl(text: string): string {
  const t = text.trim();
  if (!t || /^[a-z][a-z0-9+.-]*:/i.test(t)) return t;
  return /^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(t) ? `https://${t}` : t;
}

/** A link from a form row, or what is wrong with it in words a person reads. */
export function linkFromRow(r: { url: string; title?: string; rel?: string }): { link: TrackerLink } | { error: string } {
  const out = trackerLinkOf({ url: typedUrl(r.url), title: r.title ?? "", rel: r.rel ?? "" });
  if ("link" in out) return out;
  if (!r.url.trim()) return { error: "Paste the link's URL." };
  if (/not allowed/.test(out.problem)) return { error: "That kind of link cannot be opened safely. Use a web address or an app's own link." };
  return { error: "Use a full URL, such as https://tracker.example.com/issue/42." };
}

/** Links with one added, replacing a link to the same URL, at most TRACKER_LINKS_MAX. */
export function withLink(links: readonly TrackerLink[] | undefined, link: TrackerLink): TrackerLink[] {
  return [...(links ?? []).filter((l) => l.url !== link.url), link].slice(-TRACKER_LINKS_MAX);
}

export const withoutLink = (links: readonly TrackerLink[] | undefined, url: string): TrackerLink[] => (links ?? []).filter((l) => l.url !== url);

/**
 * A link as a chip shows it: the host (or the address, or the app's scheme)
 * and its title; without a title, the last part of the address, such as
 * "issues/42" or "HOL-118".
 */
export function linkChip(l: TrackerLink): { host: string; label: string; tip: string } {
  const host = linkHost(l.url);
  let label = l.title?.trim() ?? "";
  if (!label) {
    const rest = l.url.replace(/^[a-z][a-z0-9+.-]*:(\/\/)?/i, "").replace(/[?#].*$/, "");
    const parts = rest.split("/").filter(Boolean);
    const path = /^https?:/i.test(l.url) ? parts.slice(1) : parts;
    label = path.slice(-2).join("/");
    if (label === host) label = "";
  }
  const rel = l.rel ? (LINK_REL_LABEL as Record<string, string>)[l.rel] ?? l.rel : "";
  return { host, label, tip: [rel, l.title?.trim(), l.url].filter(Boolean).join("\n") };
}

/** Every link the goals that list a check give it, each URL once, with the goals that have it. */
export function checkLinks(checkId: string, goals: readonly GoalState[]): Array<{ link: TrackerLink; goalIds: string[] }> {
  const out = new Map<string, { link: TrackerLink; goalIds: string[] }>();
  for (const g of goals) {
    const ref = g.goal.checks.find((c) => `${c.kind}:${c.target}` === checkId);
    for (const l of ref?.links ?? []) {
      const had = out.get(l.url);
      if (had) had.goalIds.push(g.goal.id);
      else out.set(l.url, { link: l, goalIds: [g.goal.id] });
    }
  }
  return [...out.values()];
}

export const HUB_LINK_COPY = {
  links: "Links",
  addLink: "Add link",
  add: "Add",
  cancel: "Cancel",
  urlLabel: "Link URL",
  urlPlaceholder: "https://tracker.example.com/issue/42",
  titleLabel: "Link title",
  titlePlaceholder: "Title (optional)",
  relLabel: "Relationship",
  relPlaceholder: "Relationship (optional)",
  remove: (label: string) => `Remove link ${label}`,
  opens: "Opens in your browser",
  /** A check's links live in the goals that list it. */
  checkNeedsGoal: "Add this check to a goal to link it.",
} as const;

// ---------- Needs attention ----------

/** Where an item that needs attention leads when opened. */
export function attentionTarget(item: AttentionItem): HubRoute {
  if (item.kind === "sign_off" && item.goalIds[0]) return { screen: "goal", goalId: item.goalIds[0] };
  if (item.kind === "missing_check" && item.checkId) return { screen: "check", checkId: item.checkId };
  if (item.kind === "plan_failed") return { screen: "queue" };
  if (item.runId) return { screen: "run", runId: item.runId };
  if (item.checkId) return { screen: "check", checkId: item.checkId };
  if (item.goalIds[0]) return { screen: "goal", goalId: item.goalIds[0] };
  return { screen: "overview" };
}

// ---------- Keyboard ----------

export type HubKeyAction =
  | { type: "go"; to: "overview" | "library" | "queue" }
  | { type: "next" } | { type: "prev" } | { type: "open" }
  | { type: "run" } | { type: "assign" } | { type: "select" }
  | { type: "filter" } | { type: "help" } | { type: "palette" } | { type: "newGoal" };

export interface HubKey {
  key: string;
  ctrl?: boolean;
  meta?: boolean;
  alt?: boolean;
  shift?: boolean;
}

/** The shortcuts sheet, in the order it lists them. */
export const HUB_SHORTCUTS: ReadonlyArray<{ keys: string[]; label: string; group: "Move" | "Act" | "Go to" }> = [
  { keys: ["Ctrl K"], label: "Command palette", group: "Go to" },
  { keys: ["g", "o"], label: "Overview", group: "Go to" },
  { keys: ["g", "l"], label: "Library", group: "Go to" },
  { keys: ["g", "q"], label: "Queue", group: "Go to" },
  { keys: ["j"], label: "Next row", group: "Move" },
  { keys: ["k"], label: "Previous row", group: "Move" },
  { keys: ["Enter"], label: "Open the row", group: "Move" },
  { keys: ["/"], label: "Filter", group: "Move" },
  { keys: ["r"], label: "Run the row, or the goal or check on screen", group: "Act" },
  { keys: ["a"], label: "Assign a failing check to a subagent", group: "Act" },
  { keys: ["x"], label: "Select the row", group: "Act" },
  { keys: ["c"], label: "New goal", group: "Act" },
  { keys: ["?"], label: "This list", group: "Act" },
];

const SINGLE: Record<string, HubKeyAction> = {
  j: { type: "next" }, ArrowDown: { type: "next" },
  k: { type: "prev" }, ArrowUp: { type: "prev" },
  Enter: { type: "open" }, o: { type: "open" },
  r: { type: "run" }, a: { type: "assign" }, x: { type: "select" },
  "/": { type: "filter" }, "?": { type: "help" }, c: { type: "newGoal" },
};
const AFTER_G: Record<string, HubKeyAction> = {
  o: { type: "go", to: "overview" }, g: { type: "go", to: "overview" },
  l: { type: "go", to: "library" }, q: { type: "go", to: "queue" },
};
/** A `g` waits this long for its second key. */
export const CHORD_MS = 1200;

/**
 * The hub's keys as a small state machine: `press` takes one key and returns
 * what it means, or null. `g` then a letter jumps between screens. Keys with
 * Ctrl, Alt or Meta are left to the page, except Ctrl or Cmd with K.
 */
export function hubKeymap(now: () => number = Date.now) {
  let gAt = -Infinity;
  return {
    press(k: HubKey): HubKeyAction | null {
      if ((k.ctrl || k.meta) && !k.alt && k.key.toLowerCase() === "k") {
        gAt = -Infinity;
        return { type: "palette" };
      }
      if (k.ctrl || k.meta || k.alt) return null;
      if (now() - gAt < CHORD_MS) {
        gAt = -Infinity;
        return AFTER_G[k.key] ?? null;
      }
      if (k.key === "g") {
        gAt = now();
        return null;
      }
      return SINGLE[k.key] ?? null;
    },
    /** Whether a `g` waits for its second key. */
    pending: () => now() - gAt < CHORD_MS,
  };
}

/** Whether a key event's target takes text, where the hub's single keys must not fire. */
export function typingTarget(t: { tagName?: string; isContentEditable?: boolean; type?: string } | null | undefined): boolean {
  if (!t) return false;
  if (t.isContentEditable) return true;
  const tag = (t.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  return !["checkbox", "radio", "button", "submit", "range", "color"].includes((t.type ?? "text").toLowerCase());
}

// ---------- Command palette ----------

export type PaletteCommand = "newGoal" | "runFailing" | "runAll" | "shortcuts" | { runGoal: string } | { runCheck: string };

export interface PaletteEntry {
  id: string;
  kind: "goal" | "check" | "run" | "command" | "screen";
  label: string;
  hint?: string;
  /** Opens this route, or runs `command`. */
  route?: HubRoute;
  command?: PaletteCommand;
  look?: StatusLook;
}

/** Everything the palette can reach, from the overview. */
export function paletteEntries(o: Pick<HubOverview, "goals" | "checks" | "recent">): PaletteEntry[] {
  const out: PaletteEntry[] = [
    { id: "cmd:new-goal", kind: "command", label: HUB_COPY.newGoal, command: "newGoal", hint: "c" },
    { id: "cmd:run-failing", kind: "command", label: HUB_COPY.runFailing, command: "runFailing" },
    { id: "cmd:run-all", kind: "command", label: "Run every check", command: "runAll" },
    { id: "screen:overview", kind: "screen", label: "Go to Overview", route: { screen: "overview" }, hint: "g o" },
    { id: "screen:library", kind: "screen", label: "Go to Library", route: { screen: "library" }, hint: "g l" },
    { id: "screen:queue", kind: "screen", label: "Go to Queue", route: { screen: "queue" }, hint: "g q" },
    { id: "cmd:shortcuts", kind: "command", label: HUB_COPY.shortcuts, command: "shortcuts", hint: "?" },
  ];
  for (const g of sortGoals(o.goals.filter((g) => !g.goal.archived))) {
    const look = GOAL_STATUS_LOOK[g.status];
    out.push({ id: `goal:${g.goal.id}`, kind: "goal", label: g.goal.title, hint: g.goal.kind === "milestone" ? "Milestone" : "Goal", route: { screen: "goal", goalId: g.goal.id }, look });
    out.push({ id: `run-goal:${g.goal.id}`, kind: "command", label: `Run ${g.goal.title}`, hint: "Run goal", command: { runGoal: g.goal.id }, look });
  }
  for (const c of sortChecks(o.checks)) {
    const look = CHECK_HEALTH_LOOK[c.health];
    out.push({ id: `check:${c.id}`, kind: "check", label: c.name, hint: CHECK_KIND_LABEL[c.check.kind], route: { screen: "check", checkId: c.id }, look });
    out.push({ id: `run-check:${c.id}`, kind: "command", label: `Run ${c.name}`, hint: "Run check", command: { runCheck: c.id }, look });
  }
  for (const r of o.recent.slice(0, 15)) {
    out.push({ id: `run:${r.runId}`, kind: "run", label: `${r.name} run`, hint: `${RUN_OUTCOME_LOOK[r.outcome].label}, ${shortAgo(r.startedAt)}`, route: { screen: "run", runId: r.runId }, look: RUN_OUTCOME_LOOK[r.outcome] });
  }
  return out;
}

/** How well `query` matches `text`: higher is better, null for no match. Whole-word and prefix hits beat scattered letters. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  const at = t.indexOf(q);
  if (at === 0) return 1000 - t.length;
  if (at > 0) return (/[\s/_:-]/.test(t[at - 1]) ? 800 : 600) - at - t.length / 10;
  let ti = 0;
  let score = 300;
  let last = -1;
  for (const ch of q) {
    if (ch === " ") continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    score -= last >= 0 ? found - last - 1 : found;
    last = found;
    ti = found + 1;
  }
  return score - t.length / 10;
}

/** The palette's list for a query: with none, commands and screens first, then goals; otherwise best match first. */
export function searchPalette(entries: readonly PaletteEntry[], query: string, max = 30): PaletteEntry[] {
  if (!query.trim()) return entries.filter((e) => e.kind !== "run" && !(e.kind === "command" && typeof e.command === "object" && "runCheck" in e.command)).slice(0, max);
  return entries
    .map((e) => ({ e, s: fuzzyScore(query, `${e.label} ${e.hint ?? ""}`) }))
    .filter((x): x is { e: PaletteEntry; s: number } => x.s !== null)
    .sort((a, b) => b.s - a.s)
    .slice(0, max)
    .map((x) => x.e);
}

// ---------- Live updates ----------

/** The events that make the hub read again. */
export const hubReloadsOn = (type: string): boolean =>
  type === HUB_CHANGED || type === "studio.qa.changed" || type.startsWith("script.");
/** Bursts of script.* events during a run are folded into one read at most this often. */
export const HUB_RELOAD_MS = 500;

// ---------- Small helpers both clients need ----------

/** A check's display path: the asset path for a script, the target otherwise. */
export const checkPath = (c: CheckRef): string => c.target;

/** The checks in `all` that a goal does not list yet, for Add checks. */
export function checksNotIn(goal: Goal, all: readonly CheckState[]): CheckState[] {
  const have = new Set(goal.checks.map((c) => `${c.kind}:${c.target}`));
  return sortChecks(all.filter((c) => !have.has(c.id)));
}

// ---------- The live viewport ----------

/**
 * The Goal (and Milestone), Check and Run screens each carry a Viewport
 * card. It never connects on its own: collapsed, it says in one line
 * what the editor and Play In Editor are doing, and that one of the screen's
 * checks is running now; expanded, it joins the hub's one viewer and draws the
 * picture, or the viewer's notice with its ways forward. These rules say what
 * plays, what the line says and what an expanded card draws.
 */

/** A run playing on the editor now. */
export interface PlayingRun {
  runId: string;
  checkId: string;
  name: string;
}

/** A run still playing: not ended, and running or holding for a person's verdict. */
export const runPlaying = (r: Pick<RunRecord, "outcome" | "endedAt">): boolean => !r.endedAt && (r.outcome === "running" || r.outcome === "needs_you");

/**
 * Every run playing now: from the newest runs, then the queue's current plan
 * for one the run list does not know yet. A run record, when there is one,
 * decides. Nothing plays while the editor is away.
 */
export function playingRuns(o: Pick<HubOverview, "recent" | "queue" | "editor">): PlayingRun[] {
  if (!o.editor.connected) return [];
  const out: PlayingRun[] = [];
  const known = new Set<string>();
  for (const r of o.recent) {
    known.add(r.runId);
    if (runPlaying(r)) out.push({ runId: r.runId, checkId: `${r.kind}:${r.target}`, name: r.name });
  }
  for (const it of o.queue.current?.items ?? []) {
    if (!it.runId || known.has(it.runId) || it.endedAt) continue;
    if (it.state === "running" || it.state === "needs_you") out.push({ runId: it.runId, checkId: `${it.check.kind}:${it.check.target}`, name: it.name });
  }
  return out;
}

/** The run playing now that one of these checks made, or null. */
export function playingFor(o: Pick<HubOverview, "recent" | "queue" | "editor">, checkIds: Iterable<string>): PlayingRun | null {
  const ids = new Set(checkIds);
  return playingRuns(o).find((r) => ids.has(r.checkId)) ?? null;
}

/**
 * What a Viewport card draws: collapsed (its line only), a notice (the gate or
 * the viewer's state, with its ways forward), the video, the last frame held
 * while the stream reconnects mid-run, or the last frame after the run ended.
 */
export type HubLiveView = "collapsed" | "notice" | "video" | "held" | "ended";

export interface HubLiveInput {
  /** The card is expanded: the person asked to watch. */
  open: boolean;
  /** One of the screen's checks is running now. */
  playing: boolean;
  /** A last frame is held from the run that just ended. */
  endedFrame: boolean;
  /** This run was already live here and a frame of it is kept. */
  seenFrame?: boolean;
  /** Something stops watching (viewportGate). */
  gated: boolean;
  phase: ViewerPhase["phase"];
}

/**
 * What a card draws. Nothing but its line until it is expanded; then the
 * video while it is live, and otherwise the notice that says why not, never
 * an empty black box. A stream that drops back to waiting or connecting
 * during a run it already showed (PIE restarting, or stopping a moment before
 * the run reports its end) keeps its last frame instead of flashing a notice,
 * and the end of a run it showed keeps the last frame for a moment.
 */
export function hubLiveView(i: HubLiveInput): HubLiveView {
  if (!i.open) return "collapsed";
  if (i.gated) return "notice";
  if (i.phase === "live") return "video";
  if (i.playing && i.seenFrame && (i.phase === "waiting" || i.phase === "connecting" || i.phase === "joining")) return "held";
  if (!i.playing && i.endedFrame) return "ended";
  return "notice";
}

/** What a collapsed card's line says: the editor and Play In Editor, or the screen's check that is running now. */
export interface HubViewerLine {
  /** off: nothing to watch; on: Play In Editor runs; run: one of the screen's checks runs; warn: the editor cannot stream. */
  tone: "off" | "on" | "run" | "warn";
  text: string;
  /** The screen's check that is running now, named after the text. */
  run: PlayingRun | null;
}

/** Why the editor cannot stream, short enough for the line; the expanded card says the rest (viewportGate). */
const CANNOT_STREAM: Partial<Record<ViewportEditorState, string>> = {
  "no-actions": "ue-mcp needs an update",
  "plugin-off": "Pixel Streaming 2 is off",
  "plugin-restart": "the editor needs a restart",
  unavailable: "this editor cannot stream",
};

/**
 * The collapsed card's line. The editor being away comes first, then the
 * screen's run, then what stops streaming, then whether Play In Editor runs.
 * `editorConnected` is the hub's own view of the editor; `status` is
 * GET /viewport, null until it answers.
 */
export function hubViewerLine(i: { editorConnected: boolean; status: ViewportStatus | null; running: PlayingRun | null }): HubViewerLine {
  const s = i.status;
  if (!i.editorConnected || s?.editor === "no-editor") return { tone: "off", text: HUB_VIEWER_COPY.offline, run: null };
  if (i.running) return { tone: "run", text: HUB_VIEWER_COPY.runningNow, run: i.running };
  const why = s ? CANNOT_STREAM[s.editor] : undefined;
  if (why) return { tone: "warn", text: HUB_VIEWER_COPY.cannotStream(why), run: null };
  return s?.pie ? { tone: "on", text: HUB_VIEWER_COPY.pieOn, run: null } : { tone: "off", text: HUB_VIEWER_COPY.pieOff, run: null };
}

export const HUB_VIEWER_COPY = {
  title: "Viewport",
  /** Expands the card and joins the stream. */
  watch: "Watch",
  /** Collapses it; the stream stops a little later. */
  hide: "Hide",
  offline: "Editor offline",
  runningNow: "Running now",
  cannotStream: (why: string) => `Streaming unavailable: ${why}`,
  pieOn: "Play In Editor is running",
  pieOff: "Play In Editor is not running",
} as const;

/** The step a playing run is on: the running one, else the first waiting for a person, else the next to start. */
export function playingStep<T extends Pick<RunStepSpan, "status">>(steps: readonly T[]): T | null {
  return steps.find((s) => s.status === "running") ?? steps.find((s) => s.status === "awaiting_verdict") ?? steps.find((s) => s.status === "pending") ?? null;
}

/** How long the hub keeps its viewer after the last card collapses or leaves the screen, so moving between screens does not reconnect. */
export const HUB_LIVE_LINGER_MS = 15_000;
/** How long the last frame stays, dimmed, after a run ends. */
export const HUB_LIVE_ENDED_MS = 4_000;

export const HUB_LIVE_COPY = {
  live: "Live",
  ended: "Run ended",
  /** Names the dialog it opens, titled "Play In Editor". */
  expand: "Open Play In Editor",
  stepOf: (n: number, total: number) => `Step ${n} of ${total}`,
  /** A step that has not started, while the run plays. */
  next: "Up next",
  starting: "Starting Play In Editor",
} as const;

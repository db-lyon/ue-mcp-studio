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
  FAILING_ITEM_STATES,
  GOAL_DUE,
  GOAL_PRIORITIES,
  GOAL_STATUS_ORDER,
  HUB_EXPORT_FORMAT,
  HUB_CHANGED,
  TRACKER_LINKS_MAX,
  TRACKER_LINK_RELS,
  checkId as checkIdOf,
  goalChecksDeep,
  leafName,
  loopIfRequired,
  linkHost,
  ranDirty,
  trackerLinkOf,
  triggerOf,
  type CheckChange,
  type CheckDetail,
  type CheckMeta,
  type CheckMetaUpdate,
  type CurrentProvenance,
  type EvidenceScope,
  type FixRequest,
  type GoalCheckUpdate,
  type HealthRule,
  type RunProvenance,
  type RunTrigger,
  type RunVcs,
  type TrackerLink,
  type CheckHealth,
  type CheckRef,
  type CheckState,
  type Goal,
  type GoalDraft,
  type GoalImport,
  type GoalPriority,
  type GoalState,
  type GoalStatus,
  type GoalUpdate,
  type HubExport,
  type HubImportReport,
  type HubOverview,
  type AttentionItem,
  type AttentionKind,
  type PlanItemState,
  type PlanRequest,
  type PlanRun,
  type PlanScope,
  type PlanState,
  type QaVerdict,
  type QaRun,
  type QueueState,
  type RunDetail,
  type RunOutcome,
  type RunRecord,
  type RunSource,
  type RunStepSpan,
  type SignOff,
  type SignOffLapse,
  type SignOffState,
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
    /** What one goal says of a check: whether it is required. */
    updateGoalCheck: (id: string, checkId: string, u: GoalCheckUpdate) => request<{ goal: Goal }>("PUT", `${goal(id)}/checks/${enc(checkId)}`, u),
    orderChecks: (id: string, order: string[]) => request<{ goal: Goal }>("PUT", `${goal(id)}/checks/order`, { order }),
    /** Make a goal require another, or change whether it is required. */
    addRequire: (id: string, goalId: string, required?: boolean) => request<{ goal: Goal }>("POST", `${goal(id)}/requires`, required === undefined ? { goal: goalId } : { goal: goalId, required }),
    removeRequire: (id: string, goalId: string) => request<{ goal: Goal }>("DELETE", `${goal(id)}/requires/${enc(goalId)}`),
    orderRequires: (id: string, order: string[]) => request<{ goal: Goal }>("PUT", `${goal(id)}/requires`, { order }),
    signOff: (id: string, note?: string) => request<{ signOff: SignOff }>("POST", `${goal(id)}/sign-off`, note ? { note } : {}),
    clearSignOff: (id: string) => request<void>("DELETE", `${goal(id)}/sign-off`),
    writePlaytests: (id: string, text?: string) => request<{ sessionId: string }>("POST", `${goal(id)}/write-playtests`, text ? { text } : {}),
    check: (checkId: string, page: { limit?: number; before?: string } = {}) =>
      request<CheckDetail>("GET", `${HUB_BASE}/checks/${enc(checkId)}${pageQuery(page)}`),
    /** What a check says about itself (title, links), its one record. */
    updateCheck: (checkId: string, u: CheckMetaUpdate) => request<{ meta: CheckMeta }>("PUT", `${HUB_BASE}/checks/${enc(checkId)}`, u),
    rules: (r: Partial<HealthRule>) => request<{ rules: HealthRule }>("PUT", `${HUB_BASE}/rules`, r),
    /** The whole goal store as one file, to move it to another computer. */
    exportStore: () => request<HubExport>("GET", `${HUB_BASE}/store`),
    /** A goals file merged in by id (HubImportReport). */
    importStore: (file: unknown) => request<HubImportReport>("POST", `${HUB_BASE}/store`, file),
    runs: (q: { check?: string; limit?: number; before?: string } = {}) => request<{ runs: RunRecord[]; more: boolean }>("GET", `${HUB_BASE}/runs${pageQuery(q)}`),
    run: (runId: string) => request<RunDetail>("GET", `${HUB_BASE}/runs/${enc(runId)}`),
    addRunLink: (runId: string, link: TrackerLink) => request<{ record: RunRecord }>("POST", `${HUB_BASE}/runs/${enc(runId)}/links`, { link }),
    removeRunLink: (runId: string, url: string) => request<{ record: RunRecord }>("DELETE", `${HUB_BASE}/runs/${enc(runId)}/links${pageQuery({ url })}`),
    queue: () => request<QueueState>("GET", `${HUB_BASE}/queue`),
    plan: (req: PlanRequest) => request<{ plan: PlanRun }>("POST", `${HUB_BASE}/plans`, req),
    cancelPlan: (id: string) => request<{ plan: PlanRun }>("POST", `${HUB_BASE}/plans/${enc(id)}/cancel`, {}),
    pause: (paused: boolean) => request<QueueState>("PUT", `${HUB_BASE}/queue/paused`, { paused }),
    /** Fix with an agent: a fix plan, each check in a chat session of its own. */
    fix: (req: FixRequest = {}) => request<{ queued: number; plan: PlanRun | null }>("POST", `${HUB_BASE}/fix`, req),
    runCheck: (checkId: string, replay?: boolean) => request<{ plan: PlanRun }>("POST", `${HUB_BASE}/checks/${enc(checkId)}/run`, replay ? { replay } : {}),
    /** A manual step's verdict: the existing playtest route, so the card in chat settles too. */
    verdict: (runId: string, step: number, verdict: QaVerdict, note?: string) =>
      request<{ run: QaRun }>("POST", `${QA_BASE}/runs/${enc(runId)}/verdict`, note ? { step, verdict, note } : { step, verdict }),
    resultsUrl: (runId: string) => `${QA_BASE}/runs/${enc(runId)}/results`,
  };
}
export type HubApi = ReturnType<typeof hubApi>;

/** The hub API over a Transport, for a client that has one (the phone). */
export const hubApiOver = (transport: Transport): HubApi =>
  hubApi(<T>(method: string, path: string, body?: unknown) => requestJson<T>(transport, method, path, body === undefined ? undefined : { json: body }));

// ---------- Routes inside #/playtests ----------

export type HubScreen = "overview" | "goal" | "library" | "check" | "run";
export type HubRoute =
  | { screen: "overview" }
  | { screen: "goal"; goalId: string }
  | { screen: "library" }
  | { screen: "check"; checkId: string }
  | { screen: "run"; runId: string };

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
 * goals/<id>, checks, checks/<checkId>, runs/<runId>. Anything else is the
 * overview.
 */
export function parseHubPath(sub: string | null | undefined): HubRoute {
  const parts = (sub ?? "").split("/").filter(Boolean);
  const [head, id] = parts;
  const value = id ? decode(id) : null;
  switch (head) {
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
export function hubSection(r: HubRoute): "overview" | "library" {
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
  failing: { label: "Failing", glyph: "fail", tone: "bad" },
  missing: { label: "Not on this checkout", glyph: "missing", tone: "idle" },
  running: { label: "Running", glyph: "running", tone: "run" },
  flaky: { label: "Flaky", glyph: "flaky", tone: "warn" },
  stale: { label: "Stale", glyph: "stale", tone: "warn" },
  never_run: { label: "Never run", glyph: "never", tone: "idle" },
  passing: { label: "Passing", glyph: "check", tone: "ok" },
};

export const GOAL_STATUS_LOOK: Record<GoalStatus, StatusLook> = {
  failing: { label: "Failing", glyph: "fail", tone: "bad" },
  ready_to_sign_off: { label: "Ready to sign off", glyph: "needs", tone: "attention" },
  at_risk: { label: "At risk", glyph: "risk", tone: "warn" },
  running: { label: "Running", glyph: "running", tone: "run" },
  in_progress: { label: "In progress", glyph: "queued", tone: "idle" },
  not_started: { label: "Not started", glyph: "never", tone: "idle" },
  met: { label: "Met", glyph: "check", tone: "ok" },
};

/** "Needs you" is a run holding for a live verdict, on the Run screen and in the app bar; an error reads as Failed. */
export const RUN_OUTCOME_LOOK: Record<RunOutcome, StatusLook> = {
  needs_you: { label: "Needs you", glyph: "needs", tone: "attention" },
  failed: { label: "Failed", glyph: "fail", tone: "bad" },
  error: { label: "Failed", glyph: "fail", tone: "bad" },
  running: { label: "Running", glyph: "running", tone: "run" },
  incomplete: { label: "Incomplete", glyph: "risk", tone: "warn" },
  unjudged: { label: "Not judged", glyph: "skip", tone: "idle" },
  stopped: { label: "Stopped", glyph: "stop", tone: "idle" },
  passed: { label: "Passed", glyph: "check", tone: "ok" },
};

/** An error reads as Failed and a cancelled item as Stopped, as runs do. */
export const PLAN_ITEM_LOOK: Record<PlanItemState, StatusLook> = {
  needs_you: { label: "Needs you", glyph: "needs", tone: "attention" },
  failed: { label: "Failed", glyph: "fail", tone: "bad" },
  error: { label: "Failed", glyph: "fail", tone: "bad" },
  unjudged: { label: "Not judged", glyph: "skip", tone: "idle" },
  running: { label: "Running", glyph: "running", tone: "run" },
  queued: { label: "Queued", glyph: "queued", tone: "idle" },
  skipped: { label: "Skipped", glyph: "skip", tone: "idle" },
  crashed: { label: "Crashed", glyph: "fail", tone: "bad" },
  cancelled: { label: "Stopped", glyph: "stop", tone: "idle" },
  passed: { label: "Passed", glyph: "check", tone: "ok" },
};

export const PLAN_STATE_LABEL: Record<PlanState, string> = {
  queued: "Queued", running: "Running", paused: "Paused", done: "Done", cancelled: "Stopped", failed: "Failed",
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

// ---------- Labels ----------

export const PRIORITY_LABEL: Record<GoalPriority, string> = { p0: "P0 Urgent", p1: "P1 High", p2: "P2 Normal", p3: "P3 Low" };
export const PRIORITY_SHORT: Record<GoalPriority, string> = { p0: "P0", p1: "P1", p2: "P2", p3: "P3" };

export const ATTENTION_KIND_LABEL: Record<AttentionKind, string> = {
  loop_blocked: "Fix stopped",
  sign_off: "Ready to sign off",
  regression: "Regression",
  plan_failed: "Run failed",
};

export const RUN_SOURCE_LABEL: Record<RunSource, string> = {
  person: "Started by a person",
  agent: "Started by an agent",
  plan: "Started from the hub",
  outside: "Started outside Studio",
};

/** The runs that never count toward health, by why they ran. */
export const RUN_TRIGGER_LABEL: Record<Exclude<RunTrigger, "run">, string> = {
  replay: "Replay",
  loop: "Fix loop attempt",
};

export const CHECK_CHANGE_LOOK: Record<CheckChange["kind"], StatusLook> = {
  fixed: { label: "Fixed", glyph: "check", tone: "ok" },
  regressed: { label: "Regressed", glyph: "fail", tone: "bad" },
};

// ---------- Provenance ----------

/** A revision as its source control names it: a short commit, or "changelist 1234" and the like. */
export function revisionText(vcs: RunVcs | null, revision: string | null): string | null {
  if (!revision) return null;
  switch (vcs) {
    case "git": return revision.slice(0, 7);
    case "perforce": return `changelist ${revision}`;
    case "svn": return `revision ${revision}`;
    case "plastic": return `changeset ${revision}`;
    default: return revision;
  }
}

const changedFiles = (n: number): string => `${n} changed ${n === 1 ? "file" : "files"}`;

/**
 * Whose view every status is: "On this computer at a1b2c3d", with the
 * workspace's changed files when it has some, since runs over them do not
 * count toward acceptance.
 */
export function evidenceLabel(e: EvidenceScope): string {
  const c: CurrentProvenance = e.current;
  const where = "On this computer";
  if (c.vcs === "none") return where;
  const rev = revisionText(c.vcs, c.revision);
  const base = rev ? `${where} at ${rev}` : `${where}, revision unknown`;
  return c.dirty ? `${base} with ${changedFiles(c.dirty)}` : base;
}

/** What tells a run apart in a list: why it does not count, and what it tested when that is not the plain case. */
export interface RunMark {
  label: string;
  title: string;
}

/** A run's marks: a replay or a fix loop attempt, uncommitted changes, or an unknown revision. */
export function runMarks(r: Pick<RunRecord, "trigger" | "replayOf" | "provenance">): RunMark[] {
  const marks: RunMark[] = [];
  const trigger = triggerOf(r);
  if (trigger !== "run") marks.push({ label: RUN_TRIGGER_LABEL[trigger], title: "Not counted toward health or pass rate" });
  if (!r.provenance) marks.push({ label: "Revision unknown", title: "Studio did not see this run start, so what it tested is unknown. It never counts toward acceptance." });
  else if (ranDirty(r)) marks.push({ label: "Uncommitted changes", title: `Ran with ${changedFiles(r.provenance.dirty!)}, so it does not count toward acceptance` });
  return marks;
}

/** What a run tested, as short parts: "At a1b2c3d", "2 changed files", "Script 3f2a9c1", "UE 5.5", "2 players, listen server". */
export function provenanceParts(p: RunProvenance | undefined): string[] {
  if (!p) return ["Revision unknown"];
  const parts: string[] = [];
  const rev = revisionText(p.vcs, p.revision);
  if (p.vcs === "none") parts.push("No source control");
  else parts.push(rev ? `At ${rev}` : "Revision unknown");
  if (p.dirty) parts.push(changedFiles(p.dirty));
  if (p.scriptHash) parts.push(`Script ${p.scriptHash.split(":").pop()!.slice(0, 7)}`);
  if (p.engine) parts.push(`UE ${p.engine}`);
  if (p.players) {
    const mode = p.players.netMode === "listen" ? ", listen server" : p.players.netMode === "client" ? ", dedicated server" : "";
    parts.push(`${p.players.count} ${p.players.count === 1 ? "player" : "players"}${mode}`);
  }
  return parts;
}

/** Every string the hub shows that is not a status or a kind, in one place for both clients. */
export const HUB_COPY = {
  title: "Playtests",
  overview: "Overview",
  attention: "Needs attention",
  goals: "Goals",
  playtests: "Playtests",
  /** What a check is called wherever a person reads it. */
  playtest: "Playtest",
  library: "Library",
  nowRunning: "Now running",
  finished: "Finished",
  newGoal: "New goal",
  editGoal: "Edit goal",
  groupIntoGoal: "Group into a goal",
  runGoal: "Run goal",
  runFailing: "Run failing",
  runAll: "Run all",
  runSelected: "Run selected",
  addToGoal: "Add to goal",
  addPlaytests: "Add playtests",
  fixFailing: "Fix failing with an agent",
  fix: "Fix with an agent",
  /** After a fix is asked for: what was queued, and where the work happens. */
  fixesQueued: (n: number) => (n ? `Queued ${n === 1 ? "a fix" : `${n} fixes`}. Each runs in its own chat session.` : "Nothing is failing to fix."),
  /** A fix item's line: the chat session its agent works in. */
  fixChat: "Open chat",
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
  noPlaytestsInGoal: "A goal is met when its required playtests pass. Add playtests the project has, or ask an agent to write them.",
  unusedChecks: (n: number) => `${n} ${n === 1 ? "playtest is" : "playtests are"} not part of any goal`,
  attentionEmpty: "Nothing needs attention.",
  /** The overview without goals: goals are an opt-in layer over the playtests. */
  goalsLead: "Select playtests and group them into a goal to track something the game must do. A goal's status follows its playtests' runs.",
  noChecksTitle: "No playtests yet",
  noChecksLead: "Ask for one in Chat with /playtest.",
  libraryEmpty: "No playtests match.",
  justBroke: "Just broke",
  queueIdle: "Nothing is running.",
  pause: "Pause",
  resume: "Resume",
  paused: "Paused: runs wait until you resume.",
  pausedByRelease: "Paused because you released the editor. Resume when Studio may use it again.",
  pausedByReconnect: "Paused because the editor reconnected. Resume when Studio may use it again.",
  waiting: (why: string) => `Waiting: ${why}`,
  editorDown: "The editor is not connected. When it is back, resume to go on.",
  filterPlaceholder: "Filter by name, map or goal",
  palettePlaceholder: "Jump to a goal, playtest or run, or type a command",
  paletteEmpty: "No matches.",
  failNoteLabel: "What went wrong?",
  shortcuts: "Keyboard shortcuts",
  evidenceLocal: "Status comes from the runs on this computer only, so a teammate may see another status for the same goal.",
  /** Beside the "Not on this checkout" status: why that is no failure. */
  notOnCheckout: "Goals keep it listed, since another branch may have it.",
  /** A goal names a script by the path it had before it moved. */
  movedFrom: (path: string) => `Moved from ${path}`,
  unsupported: "Can't run here",
  unsupportedLead: "These were imported with the goal. Studio can't run them, so they don't count toward it.",
  owner: "Owner",
  priority: "Priority",
  due: "Due",
  runFailingNone: "Nothing is failing.",
  plans: "Runs",
} as const;

/** How far a batch of runs is, "3 of 6 done". People never read the word plan. */
export const runsDone = (done: number, total: number): string => `${done} of ${total} done`;

/** Why the queue is paused, in the words of whoever paused it. */
export const queuePausedText = (q: Pick<QueueState, "pausedBy">): string =>
  q.pausedBy === "release" ? HUB_COPY.pausedByRelease : q.pausedBy === "reconnect" ? HUB_COPY.pausedByReconnect : HUB_COPY.paused;

// ---------- Sign-off ----------

const LAPSE_TEXT: Record<SignOffLapse, string> = {
  failed: "A required playtest failed after it.",
  requirements: "The goal's requirements changed after it.",
  revision: "The project moved to another revision, and a required playtest's script or map changed or has not run there yet.",
};

/** A sign-off in words: who gave it and from where, or, once it lapsed, why it no longer counts. */
export function signOffText(s: SignOffState): { title: string; detail?: string } {
  if (s.lapsed) return { title: "Signed off on an earlier revision", detail: LAPSE_TEXT[s.lapsed] };
  return { title: `Signed off by ${s.record.by}${s.record.via ? ` from ${s.record.via}` : ""}` };
}

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
  if (!due || !GOAL_DUE.test(due)) return null;
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
const prioKey = (g: Goal): number => (g.priority ? GOAL_PRIORITIES.indexOf(g.priority) : 2);

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

export interface MilestoneGroup {
  /** null: goals nothing requires (Other goals). */
  milestone: GoalState | null;
  goals: GoalState[];
}

/**
 * Goals under their milestones, for the overview: milestones worst first
 * (then by priority and due date), each with the goals it requires in its
 * own order. A goal two
 * milestones require is in both groups, as the same GoalState. Goals that
 * nothing requires come last; a goal required only by other goals shows on
 * their screens. Archived goals are left out.
 */
export function milestoneGroups(all: readonly GoalState[]): MilestoneGroup[] {
  const live = all.filter((g) => !g.goal.archived);
  const byId = new Map(live.map((g) => [g.goal.id, g]));
  const milestones = live.filter((g) => g.goal.kind === "milestone");
  const groups: MilestoneGroup[] = sortGoals(milestones).map((m) => ({ milestone: m, goals: requiredGoals(m, byId) }));
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

/** The overview's one-line summary: "8 goals: 2 failing, 1 ready to sign off, 5 met". */
export function goalSummary(all: readonly GoalState[]): string {
  const counts = goalCounts(all);
  const total = GOAL_STATUS_ORDER.reduce((n, s) => n + counts[s], 0);
  if (total === 0) return "No goals";
  const parts = GOAL_STATUS_ORDER.filter((s) => counts[s] > 0).map((s) => `${counts[s]} ${GOAL_STATUS_LOOK[s].label.toLowerCase()}`);
  return `${total} ${total === 1 ? "goal" : "goals"}: ${parts.join(", ")}`;
}

/**
 * Checks that just broke: the newest result failed where the one before it
 * passed on something else (CheckState.change). Newest break first.
 */
export function regressions(checks: readonly CheckState[]): CheckState[] {
  return checks
    .filter((c) => c.change?.kind === "regressed")
    .sort((a, b) => byText(b.change!.at, a.change!.at));
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
  return `Each required playtest ${runs}${a.signOff ? ", then a person signs it off" : ""}.`;
}

// ---------- Moving goals between computers ----------

export const HUB_STORE_COPY = {
  menu: "Goals",
  export: "Export goals",
  import: "Import goals",
  /** What the export's file is called: the day it was made. */
  fileName: (iso: string) => `goals-${iso.slice(0, 10)}.json`,
  exported: "Saved the goals file.",
  notAFile: "That file isn't a goals file exported from Studio.",
  /** Where goals are kept, said once near the export, so nobody looks for them in the repo. */
  where: "Goals are kept by Studio on this computer, not in the project. Export them to move them to another computer.",
} as const;

/** What an import did, in a sentence: "Added 4. 2 were already here. 1 differs here and was kept as it is: Jump." */
export function importReportText(r: HubImportReport): string {
  const parts = [r.added ? `Added ${r.added}.` : "Added nothing."];
  if (r.unchanged) parts.push(`${r.unchanged} ${r.unchanged === 1 ? "was" : "were"} already here.`);
  if (r.conflicts.length) parts.push(`${r.conflicts.length} ${r.conflicts.length === 1 ? "differs here and was" : "differ here and were"} kept as ${r.conflicts.length === 1 ? "it is" : "they are"}: ${r.conflicts.map((c) => c.title).join(", ")}.`);
  return parts.join(" ");
}

/** Whether a parsed file looks like an export, before it is sent; the agent checks every record. */
export const isGoalsFile = (v: unknown): v is HubExport => !!v && typeof v === "object" && (v as { format?: unknown }).format === HUB_EXPORT_FORMAT;

/** The one-time import of QA/Goals in a sentence, or null when it never happened. */
export function importedText(i: GoalImport | null): string | null {
  if (!i) return null;
  const n = i.goals.length;
  return `${n} ${n === 1 ? "goal was" : "goals were"} brought in from ${i.from} on ${i.at.slice(0, 10)}. Studio no longer reads that folder, and it was left as it was.`;
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

export type HealthFilter = "all" | "failing" | "at_risk" | "never_run" | "passing" | "missing" | "unlinked";
export const HEALTH_FILTERS: ReadonlyArray<{ id: HealthFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "failing", label: "Failing" },
  { id: "at_risk", label: "Flaky or stale" },
  { id: "never_run", label: "Never run" },
  { id: "passing", label: "Passing" },
  { id: "missing", label: "Not on this checkout" },
  { id: "unlinked", label: "Not part of any goal" },
];

export function matchesHealth(c: CheckState, f: HealthFilter): boolean {
  switch (f) {
    case "all": return true;
    case "missing": return c.health === "missing";
    case "failing": return c.health === "failing";
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
  text?: string;
}

/** The library's rows for a query, worst first. `goals` names goals for the text match. */
export function filterChecks(checks: readonly CheckState[], q: CheckQuery, goals: readonly GoalState[] = []): CheckState[] {
  const words = (q.text ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const title = new Map(goals.map((g) => [g.goal.id, g.goal.title.toLowerCase()]));
  return sortChecks(checks.filter((c) => {
    if (q.health && !matchesHealth(c, q.health)) return false;
    if (q.goalId === "none" ? c.goalIds.length > 0 : q.goalId && !c.goalIds.includes(q.goalId)) return false;
    if (words.length) {
      const hay = [c.name, c.check.target, c.map ?? "", ...c.goalIds.map((id) => title.get(id) ?? id)].join(" ").toLowerCase();
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  }));
}

export const healthCounts = (checks: readonly CheckState[]): Record<HealthFilter, number> =>
  Object.fromEntries(HEALTH_FILTERS.map((f) => [f.id, checks.filter((c) => matchesHealth(c, f.id)).length])) as Record<HealthFilter, number>;

// ---------- Plans and the queue ----------

export interface PlanProgress {
  done: number;
  total: number;
  failed: number;
  waiting: number;
  current: PlanRun["items"][number] | null;
}

const SETTLED: readonly PlanItemState[] = ["passed", "failed", "unjudged", "skipped", "error", "crashed", "cancelled"];

export function planProgress(p: Pick<PlanRun, "items">): PlanProgress {
  return {
    done: p.items.filter((i) => SETTLED.includes(i.state)).length,
    total: p.items.length,
    failed: p.items.filter((i) => FAILING_ITEM_STATES.includes(i.state)).length,
    waiting: p.items.filter((i) => i.state === "needs_you").length,
    current: p.items.find((i) => i.state === "running" || i.state === "needs_you") ?? null,
  };
}

/** What a plan covers, in words. */
export function scopeText(scope: PlanScope, goals: readonly GoalState[] = []): string {
  const goalTitle = (id?: string) => (id ? goals.find((g) => g.goal.id === id)?.goal.title ?? id : null);
  switch (scope.kind) {
    case "goal": return `Goal: ${goalTitle(scope.goalId)}`;
    case "checks": return `${scope.checks.length} ${scope.checks.length === 1 ? "playtest" : "playtests"}`;
    case "failing": return scope.goalId ? `Failing in ${goalTitle(scope.goalId)}` : "Every failing playtest";
    case "stale": return scope.goalId ? `Stale in ${goalTitle(scope.goalId)}` : "Every stale playtest";
    case "all": return "Every playtest";
  }
}

// ---------- The goal form ----------

/** The goal form as its inputs hold it: strings, so a half-typed number is kept as typed. */
export interface GoalForm {
  title: string;
  description: string;
  kind: Goal["kind"];
  /** The goals and milestones this goal is part of: saving changes them too. */
  parents: string[];
  /** The checks a new goal starts with (Group into a goal); an edit leaves the goal's checks alone. */
  checks: CheckRef[];
  owner: string;
  priority: GoalPriority | "";
  /** YYYY-MM-DD, or empty. */
  due: string;
  stableRuns: string;
  signOff: boolean;
  /** The goal's links as typed, one row each; a row with no URL is left out. */
  links: LinkRow[];
}

export type GoalFormErrors = Partial<Record<keyof GoalForm, string>>;

export const GOAL_TITLE_MAX = 120;

function validDate(s: string): boolean {
  if (!GOAL_DUE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** The form for a goal, or a blank one; `parents` from its GoalState, since the goal itself does not hold them. */
export function goalFormOf(g?: Partial<Goal> | null, parents: readonly string[] = []): GoalForm {
  const a = g?.acceptance ?? DEFAULT_ACCEPTANCE;
  return {
    title: g?.title ?? "",
    description: g?.description ?? "",
    kind: g?.kind ?? "goal",
    parents: [...parents],
    checks: [],
    owner: g?.owner ?? "",
    priority: g?.priority ?? "",
    due: g?.due ?? "",
    stableRuns: String(a.stableRuns),
    signOff: a.signOff,
    links: (g?.links ?? []).map(linkRowOf),
  };
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
    ...(f.checks.length ? { checks: f.checks.map((c) => ({ kind: c.kind, target: c.target })) } : {}),
    owner: f.owner.trim() || null,
    ...(f.priority ? { priority: f.priority } : {}),
    due: f.due || null,
    acceptance: { stableRuns: Number(f.stableRuns), signOff: f.signOff },
    links: f.links.filter((r) => r.url.trim()).map(linkFromRow).flatMap((r) => ("link" in r ? [r.link] : [])),
  };
}

/** The update for an existing goal from a valid form: every field the form holds, so clearing one clears it. Its checks are left alone. */
export function goalUpdateOf(f: GoalForm): GoalUpdate {
  const { checks: _checks, ...d } = goalDraftOf(f);
  return { ...d, description: d.description ?? "", priority: d.priority ?? null };
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
} as const;

// ---------- Needs attention ----------

/** Where an item that needs attention leads when opened in the hub. A blocked fix opens its chat session instead (AttentionItem.sessionId). */
export function attentionTarget(item: AttentionItem): HubRoute {
  if (item.kind === "sign_off" && item.goalIds[0]) return { screen: "goal", goalId: item.goalIds[0] };
  if (item.kind === "plan_failed") return item.runId ? { screen: "run", runId: item.runId } : { screen: "overview" };
  if (item.runId) return { screen: "run", runId: item.runId };
  if (item.checkId) return { screen: "check", checkId: item.checkId };
  if (item.goalIds[0]) return { screen: "goal", goalId: item.goalIds[0] };
  return { screen: "overview" };
}

// ---------- Keyboard ----------

export type HubKeyAction =
  | { type: "go"; to: "overview" | "library" }
  | { type: "next" } | { type: "prev" } | { type: "open" }
  | { type: "run" } | { type: "fix" } | { type: "select" }
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
  { keys: ["j"], label: "Next row", group: "Move" },
  { keys: ["k"], label: "Previous row", group: "Move" },
  { keys: ["Enter"], label: "Open the row", group: "Move" },
  { keys: ["/"], label: "Filter", group: "Move" },
  { keys: ["r"], label: "Run the row, or the goal or playtest on screen", group: "Act" },
  { keys: ["a"], label: "Fix the goal's failing playtests with an agent", group: "Act" },
  { keys: ["x"], label: "Select the row", group: "Act" },
  { keys: ["c"], label: "New goal", group: "Act" },
  { keys: ["?"], label: "This list", group: "Act" },
];

const SINGLE: Record<string, HubKeyAction> = {
  j: { type: "next" }, ArrowDown: { type: "next" },
  k: { type: "prev" }, ArrowUp: { type: "prev" },
  Enter: { type: "open" }, o: { type: "open" },
  r: { type: "run" }, a: { type: "fix" }, x: { type: "select" },
  "/": { type: "filter" }, "?": { type: "help" }, c: { type: "newGoal" },
};
const AFTER_G: Record<string, HubKeyAction> = {
  o: { type: "go", to: "overview" }, g: { type: "go", to: "overview" },
  l: { type: "go", to: "library" },
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
    { id: "cmd:run-all", kind: "command", label: HUB_COPY.runAll, command: "runAll" },
    { id: "screen:overview", kind: "screen", label: "Go to Overview", route: { screen: "overview" }, hint: "g o" },
    { id: "screen:library", kind: "screen", label: "Go to Library", route: { screen: "library" }, hint: "g l" },
    { id: "cmd:shortcuts", kind: "command", label: HUB_COPY.shortcuts, command: "shortcuts", hint: "?" },
  ];
  for (const g of sortGoals(o.goals.filter((g) => !g.goal.archived))) {
    const look = GOAL_STATUS_LOOK[g.status];
    out.push({ id: `goal:${g.goal.id}`, kind: "goal", label: g.goal.title, hint: g.goal.kind === "milestone" ? "Milestone" : "Goal", route: { screen: "goal", goalId: g.goal.id }, look });
    out.push({ id: `run-goal:${g.goal.id}`, kind: "command", label: `Run ${g.goal.title}`, hint: "Run goal", command: { runGoal: g.goal.id }, look });
  }
  for (const c of sortChecks(o.checks)) {
    const look = CHECK_HEALTH_LOOK[c.health];
    out.push({ id: `check:${c.id}`, kind: "check", label: c.name, hint: HUB_COPY.playtest, route: { screen: "check", checkId: c.id }, look });
    out.push({ id: `run-check:${c.id}`, kind: "command", label: `Run ${c.name}`, hint: "Run playtest", command: { runCheck: c.id }, look });
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
 * The Run screen carries a Viewport card (on remote clients only). It never
 * connects on its own: collapsed, it says in one line what the editor and
 * Play In Editor are doing, and that the run is playing now; expanded, it
 * joins the hub's one viewer and draws the picture, or the viewer's notice
 * with its ways forward. These rules say what plays, what the line says and
 * what an expanded card draws. The Now running strip uses playingRuns too.
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

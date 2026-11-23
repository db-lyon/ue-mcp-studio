/**
 * The Playtest Hub's service: goals (goals.ts), the runs and what each
 * tested (an EvidenceStore, kept on this computer by run-index.ts),
 * the plan queue and schedules (queue.ts, schedules.ts) and the Needs
 * attention list (shared buildAttention), put together into the answers
 * HUB_ROUTES name. Status is worked
 * out on every read with the shared rules (checkHealth, goalStatus), never
 * stored.
 *
 * Checks are every check a goal names, and every script the editor lists
 * that no goal names yet. A script check whose asset the editor no longer
 * lists is missing, but only while the editor is connected and its list is
 * fresh: offline, nothing is flagged.
 *
 * Runs go through the existing machinery, so cards, players and verdict
 * routing keep working: a plan item runs on its script's card (the newest
 * one a session holds, else a draft card in one session made for the plan)
 * with QaBroker.runScript.
 */
import type { ActionResult } from "ue-mcp/daemon";
import {
  DEFAULT_ACCEPTANCE,
  NEEDS_PERSON,
  RUNNABLE_KINDS,
  buildAttention,
  needsPerson,
  planOptionsFor,
  TRACKER_LINKS_MAX,
  checkId,
  checkStateOf,
  goalChecksDeep,
  isResult,
  leafName,
  qaEnded,
  qaIsDraft,
  qaScriptKey,
  requirementsKey,
  rollUpGoals,
  uniqueLinks,
  type AcceptanceRule,
  type CheckDetail,
  type CheckRef,
  type CheckState,
  type CurrentProvenance,
  type Goal,
  type GoalState,
  type HubChanged,
  type HubChangedWhat,
  type HubOverview,
  type PlanItem,
  type PlanRun,
  type PlanScope,
  type PlanTrigger,
  type PlaytestRunsMode,
  type QaRun,
  type QueueState,
  type EditorLease as EditorLeaseView,
  type OccupancyReason,
  type RunDetail,
  type RunRecord,
  type RunStepSpan,
  type Schedule,
  type SignOff,
} from "@ue-mcp-studio/shared";
import type { QaBroker } from "../qa.js";
import type { ListedScript, PlaytestIndex } from "../playtest-index.js";
import type { SessionStore } from "../sessions.js";
import { GoalStore } from "./goals.js";
import { SignOffStore } from "./sign-offs.js";
import type { EvidenceStore } from "./evidence-store.js";
import { RunIndex } from "./run-index.js";
import { PlanQueue, newId, type ItemStart } from "./queue.js";
import { EditorLease, ON_EDITOR, WORKSPACE, occupancyOf, type OccupancySignals } from "./lease.js";
import { ProjectWatch } from "./project-watch.js";
import { readResults, readResultsFile, readSeries } from "./evidence.js";
import { provenanceAtStart, scriptHashOf, ueMcpProvenance, withUeMcp, workspaceNow } from "./provenance.js";
import { scheduleDraftOf, scheduleTurn, scheduleUpdated, withNext } from "./schedules.js";
import { planOptionsOf, scopeOf } from "./scope.js";
import { answerOf, bad, checkOfId, conflict, failureOf, isObject, linkOf, notFound } from "./util.js";

/** How often the queue, the schedules and the goals folder are looked at. */
export const TICK_MS = 30_000;
/** How long hub.changed waits to gather the changes that come together, such as a run's steps. */
const PUBLISH_MS = 200;
/** How many runs the first backfill reads, and how many each one after. */
const FIRST_BACKFILL = 5000;
const BACKFILL = 300;
/** How long a backfill stands before an overview asks for another. */
const BACKFILL_MS = 60_000;
/** The most runs a page answers. */
const MAX_PAGE = 200;
/** How long a reading of the workspace stands for the overview; a run's start always reads it afresh. */
const WORKSPACE_MS = 10_000;

export interface HubHost {
  projectDir: string;
  dataDir: string;
  callAction(category: string, action: string, args?: Record<string, unknown>): Promise<ActionResult>;
  editors(): Array<{ connected: boolean }>;
  events: {
    publish(type: string, data?: Record<string, unknown>): unknown;
    subscribe(listener: (e: { type: string; data: Record<string, unknown> }) => void): () => void;
  };
  log: { warn(message: string, detail?: unknown): void };
}

export interface HubOptions {
  host: HubHost;
  broker: Pick<QaBroker, "all" | "get" | "onSaved" | "runScript" | "status" | "assign" | "cancel" | "stopRun" | "readScriptAt" | "drafted" | "setPlanWait">;
  /**
   * What Studio knows of the editor beside its runs, for the occupancy
   * answer: PIE (PieWatch), open dialogs, calls in flight and editor
   * operations, and how long since someone used this computer. Without it,
   * only the runs Studio knows count.
   */
  editor?: Omit<OccupancySignals, "connected" | "runs"> & {
    /** Hear when PIE starts or stops. Returns the unsubscribe. */
    onPie?(listener: (running: boolean) => void): () => void;
  };
  /** Watches project files during runs, for tainted runs; one of the project's own otherwise. */
  watch?: ProjectWatch;
  index: Pick<PlaytestIndex, "listScripts" | "recorded">;
  store: Pick<SessionStore, "create" | "get" | "all">;
  /** The Playtest runs setting: an agent's plan runs only under Automatic. */
  playtestRuns: () => PlaytestRunsMode;
  /** A replay through the session's own calls, so the run gets the card: pie(script_replay) with these args. */
  replay?: (sessionId: string, args: Record<string, unknown>) => Promise<ActionResult>;
  /** The /playtest flow in a session; resolves when it ends. */
  writePlaytests?: (sessionId: string, text: string) => Promise<void>;
  /** The signed-in ue-mcp account's login, who a sign-off is from; null when none is signed in. */
  signer: () => string | null;
  /** The experiment is on: schedules fire only then. */
  enabled: () => boolean;
  /** The project's engine version, major.minor, for what a run tested. */
  engine?: () => string | null;
  /** The workspace's source control state now; read from the project's source control otherwise. */
  workspace?: () => Promise<CurrentProvenance>;
  goalsDir?: string;
  now?: () => number;
  /** Start the timers and the folder watch; tests drive tick() themselves. */
  timers?: boolean;
}

interface Catalog {
  checks: Map<string, { ref: CheckRef; goalIds: string[]; name?: string; map?: string | null }>;
  listed: Map<string, ListedScript> | null;
  connected: boolean;
  /** The workspace runs are compared with. */
  current: CurrentProvenance;
}

/** What the editor is told while the hub holds it. */
export const LEASE_NOTICE = "Studio is running a playtest";

const KIND_NAMES: Record<CheckRef["kind"], string> = { script: "Test script", uat: "UAT scenario", repro: "Reproduction test", automation: "Automation test", manual: "Manual check" };

export class Hub {
  readonly goals: GoalStore;
  readonly signOffs: SignOffStore;
  /** The runs behind every status: this computer's own (RunIndex), the one store built so far. */
  readonly runs: EvidenceStore;
  readonly queue: PlanQueue;
  private readonly now: () => number;
  private readonly unsubscribe: Array<() => void> = [];
  private timer: NodeJS.Timeout | null = null;
  private pending: { what: Set<HubChangedWhat>; goalIds: Set<string>; runIds: Set<string>; planIds: Set<string> } | null = null;
  private publishTimer: NodeJS.Timeout | null = null;
  private backfilled = -Infinity;
  private backfilling: Promise<void> | null = null;
  private firstBackfill = true;
  /** One session per plan for scripts no session has a card of yet. */
  private readonly planSessions = new Map<string, string>();
  /** The developer's editor's lease: the hub's hold on it while an item runs (lease.ts). */
  readonly lease: EditorLease;
  /** Project files changed during a run: the run is tainted. */
  private readonly watch: ProjectWatch;
  /** Runs the editor no longer knows (a status read answered idle): they hold nothing. */
  private readonly gone = new Set<string>();
  /** The plan the editor was last told about, so a plan's items do not each show a notification. */
  private toldPlan: string | null = null;
  /** Sessions writing playtests for a goal: each script drafted there joins the goal. */
  private readonly linking = new Map<string, string>();
  /** What went wrong in the background, newest last, shown with the overview's warnings. */
  private readonly notes: string[] = [];
  /** The last reading of the workspace, for the overview. */
  private workspaceRead: { at: number; value: Promise<CurrentProvenance> } | null = null;
  /** Runs whose start provenance is being read; the read at their end waits for it. */
  private readonly capturing = new Map<string, Promise<void>>();

  constructor(private readonly o: HubOptions) {
    this.now = o.now ?? Date.now;
    const iso = () => new Date(this.now()).toISOString();
    this.goals = new GoalStore({ projectDir: o.host.projectDir, dir: o.goalsDir, changed: (goalId) => this.changed(["goals", "checks", "attention"], { goalId }), log: o.host.log });
    this.signOffs = new SignOffStore(o.host.dataDir);
    this.runs = new RunIndex({ dataDir: o.host.dataDir, now: iso, changed: (runId) => this.changed(["runs", "checks", "goals", "attention"], { runId }), log: o.host.log });
    this.watch = o.watch ?? new ProjectWatch(o.host.projectDir, o.host.log);
    this.lease = new EditorLease(WORKSPACE, (lease) => this.leaseChanged(lease));
    this.queue = new PlanQueue({
      dataDir: o.host.dataDir,
      now: iso,
      lease: this.lease,
      runner: {
        connected: () => this.connected(),
        occupied: (plan) => this.occupancy(!plan.options.attended)[0]?.text ?? null,
        start: (item, plan) => (plan.work === "fix" ? this.startFix(item, plan) : this.startItem(item, plan)),
        run: (runId) => o.broker.get(runId),
        stop: (runId, reason) => this.stopRun(runId, reason),
        refresh: async (runId) => void (await o.broker.status(runId)),
        stopFix: async (item) => this.stopFix(item),
        endPie: () => this.endPie(),
      },
      changed: (planRunId) => this.changed(["queue"], { planRunId }),
      finished: (plan) => {
        this.planSessions.delete(plan.id);
        if (plan.state === "failed") this.changed(["attention"], { planRunId: plan.id });
      },
      enabled: () => this.o.enabled(),
      log: o.host.log,
    });
    // A plan's own verdict wait applies to the runs it starts.
    o.broker.setPlanWait((run) => this.queue.planOf(run.runId)?.options.verdictWaitMinutes);
    // Every run Studio holds now, so history starts with what the cards show.
    for (const run of o.broker.all()) this.runs.record(run);
    this.unsubscribe.push(o.broker.onSaved((run) => this.saw(run)));
    this.unsubscribe.push(o.host.events.subscribe((e) => {
      // With the experiment off the hub asks the editor for nothing.
      if (!this.o.enabled()) return;
      if (e.type === "editor.connected") {
        // Back after a restart or a crash: queued work waits for a person to resume it.
        this.queue.reconnected();
        void this.backfill(true);
      } else if (e.type === "editor.disconnected") {
        const cause = typeof e.data.cause === "string" ? e.data.cause : undefined;
        // Every run on a crashed editor ended with it, though no event will say so.
        if (cause === "crashed") for (const r of o.broker.all()) if (ON_EDITOR.has(r.state)) this.gone.add(r.runId);
        this.queue.editorLost(cause);
      } else if (e.type === "studio.busy.changed" || e.type === "studio.dialog.changed") {
        // An operation, a call or a dialog ended: the queue may be free to go on.
        void this.queue.pump();
      }
    }));
    const offPie = o.editor?.onPie?.((running) => {
      // The hub's PIE ended: a session started from now on is the developer's.
      if (!running) this.lease.update({ pie: false });
      if (this.o.enabled()) void this.queue.pump();
    });
    if (offPie) this.unsubscribe.push(offPie);
    this.refreshSchedules();
    if (o.timers !== false) {
      this.goals.watch();
      this.timer = setInterval(() => void this.tick(), TICK_MS);
      this.timer.unref?.();
      if (o.enabled()) {
        this.watch.start();
        void this.backfill(true);
        void this.queue.pump();
      }
    }
  }

  dispose(): void {
    for (const u of this.unsubscribe) u();
    this.unsubscribe.length = 0;
    if (this.timer) clearInterval(this.timer);
    if (this.publishTimer) clearTimeout(this.publishTimer);
    this.timer = null;
    this.publishTimer = null;
    this.goals.dispose();
    this.watch.stop();
  }

  private connected(): boolean {
    try {
      return this.o.host.editors().some((e) => e.connected);
    } catch {
      return false;
    }
  }

  /**
   * Why the editor is not free for the hub now, most decisive first (lease.ts
   * occupancyOf); empty when it is. What the lease holds never counts. Runs
   * the editor said it no longer knows hold nothing.
   */
  occupancy(unattended = false): OccupancyReason[] {
    const e = this.o.editor;
    const signals: OccupancySignals = {
      connected: () => this.connected(),
      pie: () => e?.pie() ?? false,
      dialogs: () => e?.dialogs() ?? 0,
      busy: () => e?.busy() ?? { now: this.now(), calls: [] },
      runs: () => this.o.broker.all().filter((r) => !this.gone.has(r.runId)),
      inputAgeMs: () => e?.inputAgeMs() ?? null,
    };
    return occupancyOf(signals, this.lease.held(), { unattended });
  }

  /**
   * Read again every run Studio thinks is on the editor and the hub did not
   * start, so a run whose end was missed does not hold the queue for ever:
   * one the editor answers idle for is gone.
   */
  private async refreshOthers(): Promise<void> {
    const mine = this.lease.held().runId;
    for (const r of this.o.broker.all()) {
      if (r.runId === mine || this.gone.has(r.runId) || r.manual || !ON_EDITOR.has(r.state)) continue;
      const read = await this.o.broker.status(r.runId).catch(() => null);
      if (read && "answer" in read && read.answer.state === "idle") this.gone.add(r.runId);
    }
  }

  /** The lease changed: clients hear of it, and the editor is told once per plan that Studio holds it. */
  private leaseChanged(lease: EditorLeaseView | null): void {
    // The daemon names an extension's events after it: this reaches clients as studio.hub.lease (HUB_LEASE).
    this.o.host.events.publish("hub.lease", { lease } as unknown as Record<string, unknown>);
    this.changed(["queue"], lease ? { planRunId: lease.planRunId } : {});
    if (!lease || lease.planRunId === this.toldPlan) return;
    this.toldPlan = lease.planRunId;
    // Best effort: the bar in Studio is the signal; a bridge without show_notification changes nothing.
    void Promise.resolve()
      .then(() => this.o.host.callAction("editor", "show_notification", { text: LEASE_NOTICE, subText: lease.purpose, severity: "info" }))
      .catch(() => undefined);
  }

  /** GET /hub/lease. */
  leaseView(): { lease: EditorLeaseView | null } {
    return { lease: this.lease.get() };
  }

  /**
   * Release the editor: the queue pauses, the run or fix loop the hub has on
   * the editor stops, Play In Editor that run started ends, and the lease is
   * released. Everything else on the editor is left alone.
   */
  async release(): Promise<QueueState> {
    await this.queue.release();
    return this.queueState();
  }

  /** End Play In Editor, only while the hub's run started the session running now. */
  private async endPie(): Promise<void> {
    if (!this.lease.held().pie || !(this.o.editor?.pie() ?? true)) return;
    const r = await this.o.host.callAction("editor", "play_in_editor", { pieAction: "stop" });
    const error = failureOf(r);
    if (error && !/already/i.test(error)) throw new Error(error);
    this.lease.update({ pie: false });
  }

  private note(text: string): void {
    this.notes.push(text);
    if (this.notes.length > 10) this.notes.shift();
    this.o.host.log.warn(`hub: ${text}`);
  }

  // ── Events ────────────────────────────────────────────────────────

  /** Gather a change into the next studio.hub.changed. */
  private changed(what: HubChangedWhat[], ids: { goalId?: string; runId?: string; planRunId?: string } = {}): void {
    const p = this.pending ?? (this.pending = { what: new Set(), goalIds: new Set(), runIds: new Set(), planIds: new Set() });
    for (const w of what) p.what.add(w);
    if (ids.goalId) p.goalIds.add(ids.goalId);
    if (ids.runId) p.runIds.add(ids.runId);
    if (ids.planRunId) p.planIds.add(ids.planRunId);
    if (this.publishTimer) return;
    this.publishTimer = setTimeout(() => this.flush(), PUBLISH_MS);
    this.publishTimer.unref?.();
  }

  /** Publish what was gathered; an id is named only when the change was about that one thing. */
  flush(): void {
    if (this.publishTimer) clearTimeout(this.publishTimer);
    this.publishTimer = null;
    const p = this.pending;
    this.pending = null;
    if (!p || p.what.size === 0) return;
    const body: HubChanged = {
      what: [...p.what],
      ...(p.goalIds.size === 1 ? { goalId: [...p.goalIds][0] } : {}),
      ...(p.runIds.size === 1 ? { runId: [...p.runIds][0] } : {}),
      ...(p.planIds.size === 1 ? { planRunId: [...p.planIds][0] } : {}),
    };
    // The daemon names an extension's events after it: this reaches clients as studio.hub.changed (HUB_CHANGED).
    this.o.host.events.publish("hub.changed", body as unknown as Record<string, unknown>);
  }

  /** A run the broker saved: its history and what it tested, the queue's item, the fix-loop line, and links to a goal. */
  private saw(run: QaRun): void {
    const had = this.runs.get(run.runId);
    const rec = this.runs.record(run);
    if (rec && !had && !qaEnded(run.state)) this.captureStart(run);
    if (rec && had && !had.endedAt && rec.endedAt) this.captureEnd(run.runId);
    this.queue.observe(run);
    const goalId = run.sessionId ? this.linking.get(run.sessionId) : undefined;
    if (goalId && qaIsDraft(run) && !run.deleted && run.script !== "inline") {
      const goal = this.goals.get(goalId);
      if (goal && !goal.checks.some((c) => c.kind === "script" && c.target === qaScriptKey(run.script))) {
        this.goals.addChecks(goalId, [{ kind: "script", target: qaScriptKey(run.script) }]).catch((e: unknown) =>
          this.note(`the playtest written for ${goalId} could not be added to it: ${e instanceof Error ? e.message : String(e)}`));
      }
    }
    this.taint(run);
    // Drafts and loops change the list without a run record changing.
    if (qaIsDraft(run) || run.assignment) this.changed(["attention", "checks"], { runId: run.runId });
    // Something that held the editor let it go: the queue may go on.
    if ((run.assignment && run.assignment.state !== "running") || qaEnded(run.state)) void this.queue.pump();
  }

  /** A run seen starting is followed for project file changes; when it ends having seen one, it is tainted. */
  private taint(run: QaRun): void {
    if (qaIsDraft(run) || run.manual || run.script === "inline") return;
    if (!qaEnded(run.state)) {
      if (run.state !== "idle") this.watch.runStarted(run.runId);
      return;
    }
    if (this.watch.runEnded(run.runId)) this.runs.setTainted(run.runId);
  }

  /** The periodic look: goals folder, queue, schedules, runs Studio may have missed the end of, backfill. */
  async tick(): Promise<void> {
    try {
      // Off: no plan starts and the editor is not asked; due schedules are only recorded as skipped.
      if (!this.o.enabled()) {
        this.watch.stop();
        return await this.runSchedules();
      }
      this.watch.start();
      this.goals.refresh();
      if (this.connected()) await this.refreshOthers();
      await this.queue.tick();
      await this.runSchedules();
      if (this.now() - this.backfilled > 5 * BACKFILL_MS) void this.backfill();
    } catch (e) {
      this.o.host.log.warn("hub: a tick failed", e);
    }
  }

  // ── History ───────────────────────────────────────────────────────

  /** The workspace now: read afresh, or the last reading while it is recent. */
  private workspace(fresh = false): Promise<CurrentProvenance> {
    if (!fresh && this.workspaceRead && this.now() - this.workspaceRead.at < WORKSPACE_MS) return this.workspaceRead.value;
    const read = this.o.workspace ?? (() => workspaceNow(this.o.host.projectDir));
    const value = read().catch((): CurrentProvenance => ({ vcs: null, revision: null, dirty: null }));
    this.workspaceRead = { at: this.now(), value };
    return value;
  }

  /**
   * What a run tests, read as Studio first sees it running: the workspace,
   * the script's version as pie(script_read) gives it, the engine and the
   * players Studio set. A run first seen after it ended gets none, since
   * nothing here knows what it tested.
   */
  private captureStart(run: QaRun): void {
    const job = (async () => {
      const [workspace, read] = await Promise.all([
        this.workspace(true),
        this.o.host.callAction("pie", "script_read", { path: qaScriptKey(run.script) }).catch(() => null),
      ]);
      // The run as it is now: the call that started it may have landed after its first events, with the PIE setup.
      const provenance = provenanceAtStart({ workspace, scriptHash: scriptHashOf(read ? answerOf(read) : null), engine: this.o.engine?.() ?? null, run: this.o.broker.get(run.runId) ?? run });
      this.runs.setProvenance(run.runId, provenance);
    })()
      .catch((e: unknown) => this.o.host.log.warn("hub: what a run tested could not be read", e))
      .finally(() => this.capturing.delete(run.runId));
    this.capturing.set(run.runId, job);
  }

  /** A run that ended: the fields ue-mcp records itself in its results.json, where present, laid over Studio's. */
  private captureEnd(runId: string): void {
    void (this.capturing.get(runId) ?? Promise.resolve()).then(() => {
      const provenance = withUeMcp(this.runs.get(runId)?.provenance, ueMcpProvenance(readResultsFile(this.o.host.projectDir, runId)));
      if (provenance) this.runs.setProvenance(runId, provenance);
    });
  }

  /** Read ue-mcp's record of runs into the history. At most one at a time. */
  backfill(force = false): Promise<void> {
    if (this.backfilling) return this.backfilling;
    if (!force && this.now() - this.backfilled < BACKFILL_MS) return Promise.resolve();
    const limit = this.firstBackfill ? FIRST_BACKFILL : BACKFILL;
    this.backfilling = (async () => {
      try {
        const recorded = await this.o.index.recorded(limit);
        for (const { run, times } of recorded) {
          // A run Studio holds is recorded as the broker saves it.
          if (this.o.broker.get(run.runId)) continue;
          this.runs.backfill(run, times);
        }
        this.firstBackfill = false;
      } catch (e) {
        this.o.host.log.warn("hub: the run history could not be backfilled", e);
      } finally {
        this.backfilled = this.now();
        this.backfilling = null;
      }
    })();
    return this.backfilling;
  }

  // ── Checks and goals ──────────────────────────────────────────────

  private async catalog(fresh = false): Promise<Catalog> {
    const connected = this.connected();
    const current = await this.workspace();
    let list: ListedScript[] | null = null;
    try {
      list = await this.o.index.listScripts(fresh);
    } catch {
      list = null;
    }
    const listed = list ? new Map(list.map((s) => [s.path, s])) : null;
    const checks: Catalog["checks"] = new Map();
    for (const goal of this.goals.list()) {
      for (const ref of goal.checks) {
        const id = checkId(ref);
        const had = checks.get(id);
        if (had) {
          if (!goal.archived) had.goalIds.push(goal.id);
          // A check outside any one goal shows every goal's links to it.
          if (ref.links?.length) had.ref = { ...had.ref, links: uniqueLinks([...(had.ref.links ?? []), ...ref.links]) };
        } else {
          checks.set(id, { ref, goalIds: goal.archived ? [] : [goal.id] });
        }
      }
    }
    for (const s of listed?.values() ?? []) {
      const id = checkId({ kind: "script", target: s.path });
      if (!checks.has(id)) checks.set(id, { ref: { kind: "script", target: s.path }, goalIds: [] });
    }
    // Without the editor's list, the scripts the history knows stand in for it.
    if (!listed) {
      for (const id of this.runs.checkIds()) {
        const r = this.runs.byCheck(id)[0];
        if (r && !checks.has(id)) checks.set(id, { ref: { kind: r.kind, target: r.target }, goalIds: [] });
      }
    }
    for (const c of checks.values()) {
      const s = c.ref.kind === "script" ? listed?.get(c.ref.target) : undefined;
      if (s) Object.assign(c, { name: s.name, map: s.map ?? null });
    }
    return { checks, listed, connected, current };
  }

  /** The script no longer resolves: only said while the editor is connected and has listed its scripts. */
  private missing(ref: CheckRef, cat: Catalog): boolean {
    return ref.kind === "script" && cat.connected && cat.listed !== null && !cat.listed.has(ref.target);
  }

  private stateOf(ref: CheckRef, cat: Catalog, acceptance: AcceptanceRule, goalIds?: string[]): { state: CheckState; runs: RunRecord[] } {
    const id = checkId(ref);
    const entry = cat.checks.get(id);
    const runs = this.runs.byCheck(id);
    const last = runs[0];
    const state = checkStateOf({
      check: ref,
      runs,
      missing: this.missing(ref, cat),
      acceptance,
      current: cat.current,
      now: this.now(),
      goalIds: goalIds ?? entry?.goalIds ?? [],
      name: entry?.name ?? last?.name ?? leafName(ref.target),
      map: entry?.map ?? last?.map ?? null,
      steps: last?.summary?.total ?? null,
    });
    return { state, runs };
  }

  /** The acceptance a check outside any one goal is judged by: the first goal's that names it. */
  private acceptanceFor(goalIds: string[]): AcceptanceRule {
    const g = goalIds.map((id) => this.goals.get(id)).find((x): x is Goal => !!x);
    return g?.acceptance ?? DEFAULT_ACCEPTANCE;
  }

  /** Every goal's state, rolled up through the goals each requires (shared rollUpGoals), with this computer's sign-offs. */
  private goalStates(cat: Catalog): GoalState[] {
    return rollUpGoals(this.goals.list(), (goal) => goal.checks.map((ref) => this.stateOf(ref, cat, goal.acceptance)), cat.current, this.signOffs.all());
  }

  async overview(): Promise<HubOverview> {
    if (this.now() - this.backfilled > BACKFILL_MS) void this.backfill();
    const cat = await this.catalog();
    const goals = this.goalStates(cat);
    const checks = [...cat.checks.values()].map((c) => this.stateOf(c.ref, cat, this.acceptanceFor(c.goalIds)).state);
    return {
      goalsDir: this.goals.relDir,
      goals,
      checks,
      attention: buildAttention({ runs: this.o.broker.all(), goals, checks, plans: this.queue.state().recent, now: this.now() }),
      queue: this.queueState(),
      recent: this.runs.all().slice(0, 30),
      evidence: { store: this.runs.scope, current: cat.current },
      editor: { connected: cat.connected },
      warnings: [...this.goals.warnings(), ...this.notes],
    };
  }

  async goal(id: string): Promise<GoalState> {
    if (!this.goals.get(id)) throw notFound(`no goal ${id}`);
    const cat = await this.catalog();
    return this.goalStates(cat).find((g) => g.goal.id === id)!;
  }

  async check(id: string, q: { limit?: unknown; before?: unknown }): Promise<CheckDetail> {
    const ref = checkOfId(id);
    if (!ref) throw bad("a check id is <kind>:<target>");
    const cat = await this.catalog();
    const known = cat.checks.get(checkId(ref));
    if (!known && this.runs.byCheck(checkId(ref)).length === 0) throw notFound(`no check ${id}`);
    const goalIds = known?.goalIds ?? [];
    const { state } = this.stateOf(known?.ref ?? ref, cat, this.acceptanceFor(goalIds));
    const page = this.runs.page({ check: checkId(ref), limit: limitOf(q.limit, 50), before: typeof q.before === "string" ? q.before : null });
    let script: QaRun | null = null;
    if (ref.kind === "script") {
      const r = cat.connected && !state.missing ? await this.o.broker.readScriptAt(ref.target).catch(() => null) : null;
      script = r && "run" in r ? r.run : this.o.broker.all().filter((x) => qaScriptKey(x.script) === ref.target).sort((a, b) => (a.seenAt < b.seenAt ? 1 : -1))[0] ?? null;
    }
    return { state, runs: page.runs, more: page.more, script };
  }

  runsPage(q: { check?: unknown; limit?: unknown; before?: unknown }): { runs: RunRecord[]; more: boolean } {
    let check: string | null = null;
    if (q.check !== undefined && q.check !== "") {
      const ref = typeof q.check === "string" ? checkOfId(q.check) : null;
      if (!ref) throw bad("check is a check id, <kind>:<target>");
      check = checkId(ref);
    }
    return this.runs.page({ check, limit: limitOf(q.limit, 50), before: typeof q.before === "string" ? q.before : null });
  }

  run(runId: string): RunDetail {
    const live = this.o.broker.get(runId);
    const run = live && !qaIsDraft(live) ? live : readResults(this.o.host.projectDir, runId);
    const record = this.runs.get(runId) ?? (run ? this.runs.record(run) : null);
    if (!record) throw notFound(`no run ${runId}`);
    const steps: RunStepSpan[] = (run?.steps ?? []).map((s) => ({ index: s.index, instruction: s.instruction, status: s.status, judge: s.judge, startMs: s.startedAtMs ?? null, endMs: s.endedAtMs ?? null }));
    const history = this.runs.byCheck(checkId(record));
    // Only a pass of the same script version compares step by step: across versions, step 3 may be another step.
    const version = record.provenance?.scriptHash;
    const lastPass = version ? history.find((r) => r.runId !== runId && isResult(r) && r.outcome === "passed" && r.startedAt < record.startedAt && r.provenance?.scriptHash === version) ?? null : null;
    const series = readSeries(this.o.host.projectDir, runId);
    let changedSteps: number[] | undefined;
    if (lastPass) {
      const now = new Set(record.failedSteps ?? []);
      const then = new Set(lastPass.failedSteps ?? []);
      changedSteps = [...new Set([...now, ...then])].filter((i) => now.has(i) !== then.has(i)).sort((a, b) => a - b);
    }
    return {
      record,
      run: run ?? null,
      steps,
      ...(series ? { series } : {}),
      lastPass,
      ...(changedSteps ? { changedSteps } : {}),
      resultsUrl: `/v1/ext/studio/qa/runs/${encodeURIComponent(runId)}/results`,
    };
  }

  /** A run's record: from the history, else from its results.json, kept from then on. */
  private recordFor(runId: string): RunRecord {
    const had = this.runs.get(runId);
    if (had) return had;
    const live = this.o.broker.get(runId);
    const run = live && !qaIsDraft(live) ? live : readResults(this.o.host.projectDir, runId);
    const record = run ? this.runs.record(run) : null;
    if (!record) throw notFound(`no run ${runId}`);
    return record;
  }

  /** Link a run to a tracker item. A link to a URL the run already has replaces it. */
  addRunLink(runId: string, body: unknown): RunRecord {
    const link = linkOf(isObject(body) && body.link !== undefined ? body.link : body);
    const had = this.recordFor(runId);
    const rest = (had.links ?? []).filter((l) => l.url !== link.url);
    if (rest.length >= TRACKER_LINKS_MAX) throw bad(`a run holds at most ${TRACKER_LINKS_MAX} links`);
    return this.runs.setLinks(runId, [...rest, link])!;
  }

  /** Remove a run's link to this URL. */
  removeRunLink(runId: string, url: unknown): RunRecord {
    if (typeof url !== "string" || !url) throw bad("url is the link to remove");
    const had = this.recordFor(runId);
    const links = had.links ?? [];
    if (!links.some((l) => l.url === url)) throw notFound(`run ${runId} has no link to ${url}`);
    return this.runs.setLinks(runId, links.filter((l) => l.url !== url))!;
  }

  // ── Goals ─────────────────────────────────────────────────────────

  /**
   * Sign a goal off as the signed-in account, from this computer or from the
   * paired browser named by `via`. It records the revision, the results of
   * each required check the acceptance rule looks at, and the goal's
   * requirements, so it lapses once those no longer hold (signOffLapse).
   */
  async signOff(id: string, body: unknown, via?: string): Promise<SignOff> {
    const goal = this.goals.get(id);
    if (!goal) throw notFound(`no goal ${id}`);
    if (body !== undefined && body !== null && !isObject(body)) throw bad("body must be { note? }");
    const note = isObject(body) ? body.note : undefined;
    if (note !== undefined && typeof note !== "string") throw bad("note must be a string");
    const by = this.o.signer();
    if (!by) throw conflict("Sign in to your ue-mcp account to sign off a goal: a sign-off records who gave it.");
    const current = await this.workspace(true);
    const need = Math.max(1, goal.acceptance.stableRuns);
    const runIds = goal.checks
      .filter((c) => c.required !== false && c.kind !== "manual")
      .flatMap((c) => this.runs.byCheck(checkId(c)).filter(isResult).slice(0, need).map((r) => r.runId));
    const s: SignOff = {
      goalId: id,
      by,
      ...(via ? { via } : {}),
      at: new Date(this.now()).toISOString(),
      ...(note?.trim() ? { note: note.trim().slice(0, 2000) } : {}),
      revision: current.revision,
      runIds,
      requirements: requirementsKey(goal),
    };
    this.signOffs.set(s);
    this.changed(["goals", "attention"], { goalId: id });
    return s;
  }

  clearSignOff(id: string): void {
    if (!this.goals.get(id)) throw notFound(`no goal ${id}`);
    if (this.signOffs.clear(id)) this.changed(["goals", "attention"], { goalId: id });
  }

  /**
   * Write playtests for this goal: a session of its own runs the /playtest
   * flow, seeded with the goal's words and the checks it has, and each script
   * drafted in that session joins the goal.
   */
  writePlaytests(id: string, body: unknown): { sessionId: string } {
    const goal = this.goals.get(id);
    if (!goal) throw notFound(`no goal ${id}`);
    if (body !== undefined && body !== null && !isObject(body)) throw bad("body must be { text? }");
    const asked = isObject(body) ? body.text : undefined;
    if (asked !== undefined && typeof asked !== "string") throw bad("text must be a string");
    const write = this.o.writePlaytests;
    if (!write) throw conflict("this Studio has no playtest flow to run");
    const session = this.o.store.create(`Playtests for ${goal.title}`.slice(0, 80));
    this.o.host.events.publish("session.changed", { sessionId: session.id, status: session.status, waitingCause: session.waitingCause });
    this.linking.set(session.id, goal.id);
    const text = (asked as string | undefined)?.trim() || playtestBrief(goal);
    void write(session.id, text).catch((e: unknown) => this.note(`writing playtests for ${goal.id} failed: ${e instanceof Error ? e.message : String(e)}`));
    return { sessionId: session.id };
  }

  // ── Plans ─────────────────────────────────────────────────────────

  private queueState(): QueueState {
    return this.queue.state();
  }

  queueView(): QueueState {
    return this.queueState();
  }

  /** The checks a scope stands for, in order, each once. */
  private async expand(scope: PlanScope): Promise<CheckRef[]> {
    const cat = await this.catalog();
    // A goal stands for its required goals' checks, at any depth, then its own.
    const goalChecks = (goalId: string): CheckRef[] => {
      if (!this.goals.get(goalId)) throw notFound(`no goal ${goalId}`);
      return goalChecksDeep(this.goals.list(), goalId);
    };
    let refs: CheckRef[];
    switch (scope.kind) {
      case "goal":
        refs = goalChecks(scope.goalId);
        break;
      case "checks":
        refs = scope.checks;
        break;
      case "all":
        refs = [...cat.checks.values()].map((c) => c.ref).filter((r) => !this.missing(r, cat));
        break;
      case "failing":
      case "stale": {
        const pool = scope.goalId ? goalChecks(scope.goalId) : [...cat.checks.values()].map((c) => c.ref);
        const acceptance = scope.goalId ? this.goals.get(scope.goalId)!.acceptance : null;
        // Stale takes the never run too: both lack recent evidence.
        const wanted = scope.kind === "failing" ? ["failing"] : ["stale", "never_run"];
        refs = pool.filter((r) => wanted.includes(this.stateOf(r, cat, acceptance ?? this.acceptanceFor(cat.checks.get(checkId(r))?.goalIds ?? [])).state.health));
        break;
      }
    }
    const seen = new Set<string>();
    return refs.filter((r) => {
      const id = checkId(r);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  private async titleOf(scope: PlanScope, refs: CheckRef[]): Promise<string> {
    const goal = "goalId" in scope && scope.goalId ? this.goals.get(scope.goalId)?.title : undefined;
    switch (scope.kind) {
      case "goal":
        return `Run ${goal ?? scope.goalId}`;
      case "failing":
        return goal ? `Run what is failing in ${goal}` : "Run what is failing";
      case "stale":
        return goal ? `Run what is stale in ${goal}` : "Run what is stale";
      case "all":
        return "Run every check";
      case "checks":
        return refs.length === 1 ? `Run ${refs[0].title ?? leafName(refs[0].target)}` : `Run ${refs.length} checks`;
    }
  }

  /** A plan run queued: its scope expanded to items now, so what it runs does not change under it. */
  async plan(body: unknown, trigger: PlanTrigger = "person", scheduleId?: string): Promise<PlanRun> {
    if (!isObject(body)) throw bad("body must be { title?, scope, options? }");
    if (body.title !== undefined && (typeof body.title !== "string" || !body.title.trim())) throw bad("title must be a non-empty string");
    // A person's plan, and a schedule a person set, are the user's runs; an agent's only under Automatic.
    if (trigger === "agent" && this.o.playtestRuns() === "manual") throw conflict("Playtest runs are set to Manual: an agent cannot start a plan");
    const scope = scopeOf(body.scope);
    const options = planOptionsOf(body.options, planOptionsFor(trigger));
    const refs = await this.expand(scope);
    if (refs.length === 0) throw conflict("nothing to run: the plan's scope has no checks");
    const cat = await this.catalog();
    const items: PlanItem[] = refs.map((ref) => ({ check: ref, name: ref.title ?? cat.checks.get(checkId(ref))?.name ?? leafName(ref.target), state: "queued" as const }));
    const plan: PlanRun = {
      id: newId("plan"),
      title: typeof body.title === "string" ? body.title.trim().slice(0, 200) : await this.titleOf(scope, refs),
      scope,
      options,
      state: "queued",
      items,
      trigger,
      ...(scheduleId ? { scheduleId } : {}),
      createdAt: new Date(this.now()).toISOString(),
    };
    return this.queue.enqueue(plan);
  }

  async runCheck(id: string, body: unknown): Promise<PlanRun> {
    const ref = checkOfId(id);
    if (!ref) throw bad("a check id is <kind>:<target>");
    if (body !== undefined && body !== null && !isObject(body)) throw bad("body must be { replay? }");
    const replay = isObject(body) ? body.replay : undefined;
    if (replay !== undefined && typeof replay !== "boolean") throw bad("replay must be a boolean");
    return this.plan({ scope: { kind: "checks", checks: [ref] }, options: { replay: replay === true } });
  }

  async cancelPlan(id: string): Promise<PlanRun> {
    return this.queue.cancel(id);
  }

  movePlan(id: string, body: unknown): QueueState {
    const to = isObject(body) ? body.to : undefined;
    if (!Number.isInteger(to) || (to as number) < 0) throw bad("body must be { to: a position from 0 }");
    this.queue.move(id, to as number);
    return this.queueState();
  }

  setPaused(body: unknown): QueueState {
    const paused = isObject(body) ? body.paused : undefined;
    if (typeof paused !== "boolean") throw bad("body must be { paused: boolean }");
    this.queue.setPaused(paused);
    return this.queueState();
  }

  /** Start one plan item on the editor: its script's card run, or a replay of its last recording. */
  private async startItem(item: PlanItem, plan: PlanRun): Promise<ItemStart> {
    if (!RUNNABLE_KINDS.includes(item.check.kind)) return { skipped: `${KIND_NAMES[item.check.kind]} checks cannot run yet` };
    const script = item.check.target;
    const listed = this.connected() ? await this.o.index.listScripts().catch(() => null) : null;
    if (listed && !listed.some((s) => s.path === script)) return { skipped: "the script no longer exists in the project" };
    // A manual step needs someone watching it play. A replay is no way around that: it would copy an old run's verdict.
    if (!plan.options.attended) {
      const read = await this.o.broker.readScriptAt(script);
      if ("error" in read) return { error: `the script could not be read: ${read.error}` };
      if (needsPerson(read.run.steps)) return { skipped: NEEDS_PERSON };
    }
    const card = await this.cardFor(script, plan.id, `Plan: ${plan.title}`);
    if ("error" in card) return card;
    const tag = { source: plan.trigger === "schedule" ? "schedule" as const : "plan" as const, planRunId: plan.id };
    const src = plan.options.replay && this.o.replay ? this.runs.byCheck(checkId(item.check)).find((r) => r.recordingId && r.outcome !== "running" && r.outcome !== "needs_you") : undefined;
    if (src && this.o.replay && card.sessionId) {
      const r = await this.o.replay(card.sessionId, { run_id: src.recordingId ?? src.runId });
      const body = answerOf(r);
      if (!body || typeof body.run_id !== "string") return { error: `the replay did not start: ${failureOf(r) ?? "ue-mcp started no run"}` };
      this.runs.tag(body.run_id, tag);
      return { runId: body.run_id };
    }
    const r = await this.o.broker.runScript(card.runId, { startPie: true });
    if ("error" in r) return { error: r.error };
    this.runs.tag(r.run.runId, tag);
    return { runId: r.run.runId };
  }

  /**
   * The card a plan runs a script on: the newest run or draft of it a session
   * holds, else a draft card in the plan's own session (`key`), made once per plan.
   */
  private async cardFor(script: string, key: string, title: string): Promise<QaRun | { error: string }> {
    const runs = this.o.broker.all().filter((r) => qaScriptKey(r.script) === script).sort((a, b) => (a.seenAt < b.seenAt ? 1 : -1));
    const had = runs.find((r) => r.sessionId && this.o.store.get(r.sessionId) && !r.deleted);
    if (had) return had;
    const read = await this.o.host.callAction("pie", "script_read", { path: script }).catch((e: Error) => ({ isError: true, content: [{ type: "text", text: e.message }] }) as ActionResult);
    const body = answerOf(read);
    if (!body) return { error: `the script could not be read: ${failureOf(read) ?? "no answer"}` };
    let sid = this.planSessions.get(key);
    if (!sid || !this.o.store.get(sid)) {
      const s = this.o.store.create(title.slice(0, 80));
      sid = s.id;
      this.planSessions.set(key, sid);
      this.o.host.events.publish("session.changed", { sessionId: s.id, status: s.status, waitingCause: s.waitingCause });
    }
    const draft = await this.o.broker.drafted(sid, body);
    return draft ?? { error: "the script's card could not be made" };
  }

  /** Stop a run the hub started through the broker, so a verdict hold is released with it (and PIE, when the run started it). */
  private async stopRun(runId: string, reason: string): Promise<void> {
    const r = await this.o.broker.stopRun(runId, reason);
    if ("error" in r && !/already|only a run that is going/i.test(r.error)) throw new Error(r.error);
  }

  // ── Schedules ─────────────────────────────────────────────────────

  private refreshSchedules(): void {
    const now = new Date(this.now());
    for (const s of this.queue.schedules()) {
      if (s.nextRunAt && Date.parse(s.nextRunAt) <= now.getTime()) continue;
      const next = withNext(s, now);
      if (next.nextRunAt !== s.nextRunAt) this.queue.putSchedule(next);
    }
  }

  createSchedule(body: unknown): Schedule {
    const d = scheduleDraftOf(body);
    if (d.scope.kind === "goal" && !this.goals.get(d.scope.goalId)) throw bad(`no goal ${d.scope.goalId}`);
    const s = withNext({ id: newId("schedule"), ...d, lastRunAt: null, lastSkipped: null, nextRunAt: null }, new Date(this.now()));
    this.queue.putSchedule(s);
    return s;
  }

  updateSchedule(id: string, body: unknown): Schedule {
    const had = this.queue.schedules().find((s) => s.id === id);
    if (!had) throw notFound(`no schedule ${id}`);
    const s = withNext(scheduleUpdated(had, body), new Date(this.now()));
    this.queue.putSchedule(s);
    return s;
  }

  deleteSchedule(id: string): void {
    if (!this.queue.deleteSchedule(id)) throw notFound(`no schedule ${id}`);
  }

  /** Each due schedule runs its plan when the queue is idle and the editor free (occupancy); otherwise it records why not. */
  private async runSchedules(): Promise<void> {
    const now = new Date(this.now());
    for (const s of [...this.queue.schedules()]) {
      const turn = scheduleTurn(s, now, () => {
        if (!this.o.enabled()) return "the Playtest Hub is off";
        if (this.queue.paused()) return "the queue was paused";
        if (!this.queue.idle()) return "other plans were queued";
        return this.occupancy(!s.options.attended)[0]?.text ?? null;
      });
      if (!turn) continue;
      let next: Schedule = { ...s };
      if ("skip" in turn) {
        next.lastSkipped = turn.skip;
      } else {
        try {
          await this.plan({ title: s.title, scope: s.scope, options: s.options }, "schedule", s.id);
          next = { ...next, lastRunAt: now.toISOString(), lastSkipped: null };
        } catch (e) {
          next.lastSkipped = e instanceof Error ? e.message : String(e);
        }
      }
      this.queue.putSchedule(withNext(next, now));
    }
  }

  // ── Fix loops ─────────────────────────────────────────────────────

  /**
   * Fix failing with an agent: a fix plan in the queue, one item per failing
   * script check, each a fix loop in a chat session of its own, run one at a
   * time under the editor's lease like any plan. A script already queued for
   * a fix, or whose loop runs, is left out. Returns how many were queued.
   */
  async assignFailing(body: unknown): Promise<{ queued: number; plan: PlanRun | null }> {
    if (body !== undefined && body !== null && !isObject(body)) throw bad("body must be { goalId? }");
    const goalId = isObject(body) ? body.goalId : undefined;
    if (goalId !== undefined && typeof goalId !== "string") throw bad("goalId must be a goal's id");
    const refs = await this.expand(goalId ? { kind: "failing", goalId } : { kind: "failing" });
    const q = this.queue.state();
    const queued = new Set([q.current, ...q.queued].filter((p): p is PlanRun => p?.work === "fix").flatMap((p) => p.items.filter((i) => i.state === "queued" || i.state === "running").map((i) => i.check.target)));
    const running = new Set(this.o.broker.all().filter((r) => r.assignment?.state === "running").map((r) => qaScriptKey(r.script)));
    const fresh = refs.filter((r) => r.kind === "script" && !queued.has(r.target) && !running.has(r.target));
    if (fresh.length === 0) return { queued: 0, plan: null };
    const cat = await this.catalog();
    const goal = typeof goalId === "string" ? this.goals.get(goalId)?.title : undefined;
    const plan: PlanRun = {
      id: newId("plan"),
      title: goal ? `Fix what is failing in ${goal}` : "Fix what is failing",
      work: "fix",
      scope: goalId ? { kind: "failing", goalId } : { kind: "failing" },
      options: planOptionsFor("person"),
      state: "queued",
      items: fresh.map((ref) => ({ check: ref, name: ref.title ?? cat.checks.get(checkId(ref))?.name ?? leafName(ref.target), state: "queued" as const })),
      trigger: "person",
      createdAt: new Date(this.now()).toISOString(),
    };
    this.changed(["attention"]);
    return { queued: fresh.length, plan: this.queue.enqueue(plan) };
  }

  /**
   * Start one fix item: the script's card in a chat session (the session that
   * already holds its card, else one named for the fix), and the loop on it.
   * The item follows the loop until it passes, stops for the person, or ends.
   */
  private async startFix(item: PlanItem, plan: PlanRun): Promise<ItemStart> {
    if (item.check.kind !== "script") return { skipped: `${KIND_NAMES[item.check.kind]} checks cannot be fixed by an agent yet` };
    const card = item.sessionId && this.o.store.get(item.sessionId)
      ? this.o.broker.all().find((r) => r.sessionId === item.sessionId && qaScriptKey(r.script) === item.check.target && !r.deleted) ?? await this.cardFor(item.check.target, `${plan.id}:${item.check.target}`, `Fix ${item.name}`)
      : await this.cardFor(item.check.target, `${plan.id}:${item.check.target}`, `Fix ${item.name}`);
    if ("error" in card) return card;
    if (!card.sessionId) return { error: "the playtest's card has no chat session" };
    const r = await this.o.broker.assign(card.runId, {});
    if ("error" in r) return { error: r.error };
    return { runId: r.run.runId, sessionId: card.sessionId };
  }

  /** Stop a fix item's loop: its running attempt stops, and is checkpointed so it can be reverted. */
  private stopFix(item: PlanItem): void {
    const holder = this.o.broker.all().find((r) => r.assignment?.state === "running" && r.assignment.sessionId === item.sessionId && qaScriptKey(r.script) === item.check.target);
    if (!holder) return;
    const r = this.o.broker.cancel(holder.runId);
    if ("error" in r) this.note(`the fix loop for ${item.name} could not be stopped: ${r.error}`);
  }
}

/** A page size from a query: a whole number up to MAX_PAGE, else the default. */
function limitOf(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? Math.min(MAX_PAGE, n) : fallback;
}

/** What the /playtest flow is told for Write playtests: the goal's words and the playtests it already has, by name. */
export function playtestBrief(goal: Goal): string {
  const have = goal.checks.filter((c) => c.kind === "script").map((c) => c.title ?? leafName(c.target));
  return [
    `Write a playtest for the goal "${goal.title}".`,
    goal.description ? `What the goal means: ${goal.description}` : "",
    have.length ? `It already has these playtests: ${have.join(", ")}. Check something they do not.` : "",
  ].filter(Boolean).join("\n\n");
}

/**
 * The plan queue: plan runs waiting for the editor, run one item at a time
 * (ue-mcp runs one script at a time per editor). Kept in
 * <dataDir>/hub/queue.json with the schedules, so a daemon restart finds it as
 * it was: the plan that was running carries on, its current item followed
 * again when Studio still has the run, otherwise queued again for when the
 * editor is back.
 *
 * Manual steps in a plan:
 *  - defer (the default): the run starts with block_on_manual false, so
 *    manual steps start and the run moves on. Once every auto step has
 *    settled and only manual steps wait, the run is stopped: the auto
 *    evidence is kept, the item is needs_you (failed when an auto step
 *    failed), the verdicts wait in the inbox, and the plan moves on. A late
 *    verdict is taken by a manual run of the script (QaBroker.verdict).
 *  - block: the run holds at manual steps until they are judged, and the plan
 *    waits with it; the item shows needs_you while it waits.
 *
 * What runs an item (a card, QaBroker.runScript) is the hub's, given as a
 * QueueRunner, so this file only keeps order and state.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  outcomeOf,
  qaEnded,
  type PlanItem,
  type PlanItemState,
  type PlanRun,
  type QaRun,
  type QueueState,
  type Schedule,
} from "@ue-mcp-studio/shared";
import { writeFileAtomic } from "../atomic-write.js";
import { conflict, notFound } from "./util.js";

/** The most finished plans kept. */
const MAX_RECENT = 20;

/** What starting one item came to. */
export type ItemStart = { runId: string } | { skipped: string } | { error: string };

export interface QueueRunner {
  connected(): boolean;
  /** Something else holds the editor (a subagent loop running a playtest): why, or null. */
  busy(): string | null;
  start(item: PlanItem, plan: PlanRun): Promise<ItemStart>;
  /** The run as Studio has it now. */
  run(runId: string): QaRun | undefined;
  /** End a run: pie(script_stop). */
  stop(runId: string, reason: string): Promise<void>;
  /** Read a run again, for when its events were missed. */
  refresh(runId: string): Promise<void>;
}

interface Stored {
  schema: 1;
  paused: boolean;
  current: PlanRun | null;
  queued: PlanRun[];
  recent: PlanRun[];
  schedules: Schedule[];
}

export interface QueueOptions {
  dataDir: string;
  runner: QueueRunner;
  now?: () => string;
  changed?: (planRunId?: string) => void;
  /** A plan finished: done, failed or cancelled. */
  finished?: (plan: PlanRun) => void;
  /** The Playtest Hub is on: nothing new starts while it is off. Default on. */
  enabled?: () => boolean;
  log?: { warn(message: string, detail?: unknown): void };
}

export const newId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;

/** An item whose run is on the editor: running, or held at a manual step under block (needs_you with no end yet). */
const live = (i: PlanItem): boolean => i.state === "running" || (i.state === "needs_you" && !i.endedAt);
/** An item that has its result. */
const settled = (i: PlanItem): boolean => i.state !== "queued" && !live(i);

export class PlanQueue {
  private s: Stored = { schema: 1, paused: false, current: null, queued: [], recent: [], schedules: [] };
  private readonly file: string;
  private readonly now: () => string;
  private pumping = false;
  /** Runs this queue stopped to defer their manual steps, so they are stopped once. */
  private readonly deferring = new Set<string>();

  constructor(private readonly o: QueueOptions) {
    this.file = path.join(o.dataDir, "hub", "queue.json");
    this.now = o.now ?? (() => new Date().toISOString());
    this.load();
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf-8")) as Partial<Stored>;
      this.s = {
        schema: 1,
        paused: raw.paused === true,
        current: raw.current && typeof raw.current === "object" ? raw.current : null,
        queued: Array.isArray(raw.queued) ? raw.queued : [],
        recent: Array.isArray(raw.recent) ? raw.recent.slice(0, MAX_RECENT) : [],
        schedules: Array.isArray(raw.schedules) ? raw.schedules : [],
      };
    } catch {
      // None yet, or unreadable: an empty queue.
    }
    const cur = this.s.current;
    if (!cur) return;
    // The item that was running when the daemon stopped: followed again while Studio has its run, else run again.
    for (const item of cur.items) {
      if (!live(item)) continue;
      const run = item.runId ? this.o.runner.run(item.runId) : undefined;
      if (!run) Object.assign(item, { state: "queued", runId: null, startedAt: null, reason: "queued again after Studio restarted" });
    }
  }

  private save(planRunId?: string): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileAtomic(this.file, `${JSON.stringify(this.s, null, 2)}\n`);
    } catch (e) {
      this.o.log?.warn("hub: the queue could not be saved", e);
    }
    this.o.changed?.(planRunId);
  }

  state(): QueueState {
    const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
    return { paused: this.s.paused, current: copy(this.s.current), queued: copy(this.s.queued), recent: copy(this.s.recent), schedules: copy(this.s.schedules), editor: { connected: this.o.runner.connected() } };
  }

  /** Nothing running or waiting. */
  idle(): boolean {
    return !this.s.current && this.s.queued.length === 0;
  }

  paused(): boolean {
    return this.s.paused;
  }

  /** The run a plan has on the editor now, if any. */
  currentRun(): string | null {
    const item = this.s.current?.items.find(live);
    return item?.runId ?? null;
  }

  /** A plan item holds the editor: its run is on it, or is being started (no run id yet). */
  holding(): boolean {
    return !!this.s.current?.items.some(live);
  }

  find(id: string): PlanRun | undefined {
    return [this.s.current, ...this.s.queued, ...this.s.recent].find((p): p is PlanRun => p?.id === id);
  }

  enqueue(plan: PlanRun): PlanRun {
    this.s.queued.push(plan);
    this.save(plan.id);
    void this.pump();
    return plan;
  }

  setPaused(paused: boolean): void {
    if (this.s.paused === paused) return;
    this.s.paused = paused;
    this.save();
    if (!paused) void this.pump();
  }

  /** Move a queued plan to position `to` among the queued ones. */
  move(id: string, to: number): void {
    const at = this.s.queued.findIndex((p) => p.id === id);
    if (at < 0) throw this.find(id) ? conflict("only a queued plan can be moved") : notFound(`no plan ${id}`);
    const [plan] = this.s.queued.splice(at, 1);
    this.s.queued.splice(Math.max(0, Math.min(this.s.queued.length, Math.floor(to))), 0, plan);
    this.save(id);
  }

  /** Cancel a plan: a queued one leaves the queue, the running one stops its run. */
  async cancel(id: string): Promise<PlanRun> {
    const at = this.s.queued.findIndex((p) => p.id === id);
    if (at >= 0) {
      const [plan] = this.s.queued.splice(at, 1);
      this.close(plan, "cancelled", "cancelled");
      this.save(id);
      return plan;
    }
    const cur = this.s.current;
    if (!cur || cur.id !== id) throw this.find(id) ? conflict("the plan has already finished") : notFound(`no plan ${id}`);
    const onEditor = cur.items.find((i) => live(i) && i.runId);
    this.close(cur, "cancelled", "cancelled");
    this.s.current = null;
    this.save(id);
    if (onEditor?.runId) {
      const run = this.o.runner.run(onEditor.runId);
      if (run && !qaEnded(run.state)) await this.o.runner.stop(onEditor.runId, "The plan was cancelled").catch(() => undefined);
    }
    void this.pump();
    return cur;
  }

  /** End a plan: every item not finished takes `rest`, and the plan goes to the recent list. */
  private close(plan: PlanRun, state: PlanRun["state"], rest: PlanItemState, reason?: string): void {
    const at = this.now();
    for (const item of plan.items) {
      if (settled(item)) continue;
      Object.assign(item, { state: rest, endedAt: at, ...(reason ? { reason } : {}) });
    }
    plan.state = state;
    plan.endedAt = at;
    this.s.recent.unshift(plan);
    this.s.recent.length = Math.min(this.s.recent.length, MAX_RECENT);
    this.o.finished?.(plan);
  }

  // ── Schedules (kept here, worked by schedules.ts) ─────────────────

  schedules(): Schedule[] {
    return this.s.schedules;
  }

  putSchedule(s: Schedule): void {
    const at = this.s.schedules.findIndex((x) => x.id === s.id);
    if (at >= 0) this.s.schedules[at] = s;
    else this.s.schedules.push(s);
    this.save();
  }

  deleteSchedule(id: string): boolean {
    const before = this.s.schedules.length;
    this.s.schedules = this.s.schedules.filter((s) => s.id !== id);
    if (this.s.schedules.length === before) return false;
    this.save();
    return true;
  }

  // ── Running ───────────────────────────────────────────────────────

  /** A run changed: the current item's run moves the plan on. */
  observe(run: QaRun): void {
    const cur = this.s.current;
    const item = cur?.items.find((i) => i.runId === run.runId && live(i));
    if (!cur || !item) return;
    this.evaluate(cur, item, run);
  }

  private evaluate(plan: PlanRun, item: PlanItem, run: QaRun): void {
    if (!qaEnded(run.state)) {
      const open = run.steps.some((s) => s.status === "pending" || s.status === "running");
      const waiting = run.steps.some((s) => s.status === "awaiting_verdict");
      if (plan.options.manualSteps === "defer" && waiting && !open && !this.deferring.has(run.runId)) {
        // Only manual steps are left: they wait in the inbox while the plan moves on.
        this.deferring.add(run.runId);
        void this.o.runner.stop(run.runId, `Manual steps left for later by the plan "${plan.title}"`).catch((e: unknown) => {
          // Tried again on the next look, or the plan would wait on the run forever.
          this.deferring.delete(run.runId);
          this.o.log?.warn("hub: a deferred run could not be stopped", e);
        });
      } else if (plan.options.manualSteps === "block" && waiting && item.state !== "needs_you") {
        item.state = "needs_you";
        item.reason = "waiting for a verdict";
        this.save(plan.id);
      } else if (!waiting && item.state === "needs_you") {
        // Judged: the run goes on.
        item.state = "running";
        item.reason = null;
        this.save(plan.id);
      }
      return;
    }
    this.deferring.delete(run.runId);
    const outcome = outcomeOf(run);
    const failedAuto = run.steps.some((s) => s.status === "failed");
    let state: PlanItemState;
    let reason: string | null = null;
    if (outcome === "passed") state = "passed";
    else if (outcome === "failed") state = "failed";
    else if (outcome === "needs_you") {
      state = failedAuto ? "failed" : "needs_you";
      reason = "manual steps wait for a verdict in the inbox";
    } else {
      state = "error";
      reason = "the run ended before every step settled";
    }
    Object.assign(item, { state, reason, endedAt: this.now() });
    if (plan.options.stopOnFailure && (state === "failed" || state === "error")) {
      this.close(plan, "failed", "cancelled", "the plan stopped at a failure");
      this.s.current = null;
    }
    this.save(plan.id);
    void this.pump();
  }

  /**
   * The periodic look: a plan item whose editor went away is queued again,
   * and a running item's run is read again in case its events were missed.
   */
  async tick(): Promise<void> {
    const cur = this.s.current;
    const item = cur?.items.find(live);
    if (cur && item) {
      if (!this.o.runner.connected()) {
        Object.assign(item, { state: "queued", runId: null, startedAt: null, reason: "queued again: the editor disconnected" });
        this.save(cur.id);
      } else if (item.runId) {
        const run = this.o.runner.run(item.runId);
        if (run && !qaEnded(run.state)) await this.o.runner.refresh(item.runId).catch(() => undefined);
        const again = this.o.runner.run(item.runId);
        if (again && this.s.current === cur) this.evaluate(cur, item, again);
      }
    }
    await this.pump();
  }

  /** Start what is next, while nothing holds the editor. */
  async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        if (this.s.paused || this.o.enabled?.() === false || !this.o.runner.connected()) return;
        let cur = this.s.current;
        if (cur?.items.some(live)) return;
        if (this.o.runner.busy()) return;
        if (!cur) {
          cur = this.s.queued.shift() ?? null;
          if (!cur) return;
          cur.state = "running";
          cur.startedAt = this.now();
          this.s.current = cur;
          this.save(cur.id);
        }
        const item = cur.items.find((i) => i.state === "queued");
        if (!item) {
          const all = cur.items.length > 0 && cur.items.every((i) => i.state === "error");
          this.close(cur, all ? "failed" : "done", "cancelled");
          this.s.current = null;
          this.save(cur.id);
          continue;
        }
        Object.assign(item, { state: "running", startedAt: this.now(), reason: null, runId: null });
        this.save(cur.id);
        let r: ItemStart;
        try {
          r = await this.o.runner.start(item, cur);
        } catch (e) {
          r = { error: e instanceof Error ? e.message : String(e) };
        }
        // Cancelled while it started: the run it started is stopped.
        if (this.s.current !== cur) {
          if ("runId" in r) await this.o.runner.stop(r.runId, "The plan was cancelled").catch(() => undefined);
          continue;
        }
        if ("skipped" in r) {
          Object.assign(item, { state: "skipped", reason: r.skipped, endedAt: this.now() });
        } else if ("error" in r) {
          Object.assign(item, { state: "error", reason: r.error, endedAt: this.now() });
          if (cur.options.stopOnFailure) {
            this.close(cur, "failed", "cancelled", "the plan stopped at a failure");
            this.s.current = null;
          }
        } else {
          item.runId = r.runId;
          this.save(cur.id);
          const run = this.o.runner.run(r.runId);
          if (run) this.evaluate(cur, item, run);
          // A run that ended at once moves the plan on here; one still going does so from its events.
          if (live(item)) return;
          continue;
        }
        this.save(cur.id);
      }
    } catch (e) {
      // Called with void from events and timers: a throw here must not become an unhandled rejection.
      this.o.log?.warn("hub: the queue could not start its next run", e);
    } finally {
      this.pumping = false;
    }
  }
}

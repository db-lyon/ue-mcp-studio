/**
 * Updates that wait for the turns to finish. Updating Studio or restarting
 * ue-mcp restarts the daemon. A turn running in its own host process outlives
 * that, so those two steps wait only for turns that run inside the daemon
 * (pinned); updating Studio also waits for turns in a turn host (hosted),
 * since the Studio it installs has no turn hosts. Updating the editor plugin closes the editor, so it waits while
 * any session is running or waiting. A waiting step is kept here and runs once
 * nothing holds it. Restart now runs it at once, ending the turns first with
 * that said in each.
 *
 * The queue is kept in the data folder, and the panel's update run (the run
 * file) is told when a step starts, so the page that loads after a restart
 * settles it like any other.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { DisruptionView } from "./consent.js";
import type { HoldDecision, UpdateConsent } from "./update-hold.js";

export type DeferredStep = "plugin" | "studio" | "restart";
export const DEFERRED_STEPS: readonly DeferredStep[] = ["plugin", "studio", "restart"];

/** What a step's route answers: started (studio, restart), finished (plugin), or failed. */
export interface StepResult {
  ok: boolean;
  started?: boolean;
  version?: string;
  error?: string;
  /** ue-mcp's editor consent gate held the step: other sessions are using the editor it would close. */
  request?: DisruptionView;
}

/** Why a held update stopped when nobody answered its request in time. */
export const HOLD_EXPIRED = "The request to close the editor expired before anyone approved it, so the update stopped before closing the editor.";

/** The queue as kept on disk. */
interface QueueFile {
  steps: DeferredStep[];
  /** The person chose Update anyway: the steps go ahead whatever the other sessions answer. */
  force?: boolean;
  /** The id of the consent request a step is held on; nothing runs until it is decided. */
  held?: string;
}

export interface UpdateQueueOptions {
  dataDir: string;
  /** True while any session is running or waiting. The plugin step waits on this. */
  busy: () => boolean;
  /**
   * True while a turn runs that a daemon restart would end: one inside the
   * daemon rather than in a host process. The studio and restart steps wait on
   * this; busy when not given.
   */
  pinned?: () => boolean;
  /**
   * True while a conversation runs in a turn host. The studio step also waits
   * on this: a later Studio has no turn hosts to take it over, so the turn
   * finishes before the install. The restart keeps the same Studio and does
   * not wait on it. Nothing waits on it when not given.
   */
  hosted?: () => boolean;
  /** Run one step now, with the person's override when they gave it. */
  run: (step: DeferredStep, consent: UpdateConsent) => Promise<StepResult>;
  /** A waiting step the consent gate held: the person is asked, and `decide` goes on from their answer. */
  held?: (request: DisruptionView) => void;
  /** End every turn in progress before a Restart now. */
  interruptTurns: () => void;
  publish?: (type: string, data: Record<string, unknown>) => void;
  /** How often to look for idle while something waits. */
  pollMs?: number;
}

const QUEUE_FILE = "update-deferred.json";
const RUN_FILE = "update-run.json";

export class UpdateQueue {
  private timer: ReturnType<typeof setInterval> | null = null;
  private draining = false;

  constructor(private readonly o: UpdateQueueOptions) {
    if (this.steps().length) this.watch();
  }

  private read(): QueueFile {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.o.dataDir, QUEUE_FILE), "utf-8")) as { steps?: unknown; force?: unknown; held?: unknown };
      const steps = Array.isArray(raw.steps) ? raw.steps.filter((s): s is DeferredStep => (DEFERRED_STEPS as readonly string[]).includes(s)) : [];
      return { steps, ...(raw.force === true ? { force: true } : {}), ...(typeof raw.held === "string" ? { held: raw.held } : {}) };
    } catch {
      return { steps: [] };
    }
  }

  /** The steps waiting, in the order they run. */
  steps(): DeferredStep[] {
    return this.read().steps;
  }

  /** The consent request the waiting steps are held on, if any. */
  heldOn(): string | null {
    return this.read().held ?? null;
  }

  private save(steps: DeferredStep[], extra: Omit<QueueFile, "steps"> = {}): void {
    const file = path.join(this.o.dataDir, QUEUE_FILE);
    if (steps.length === 0) fs.rmSync(file, { force: true });
    else {
      fs.mkdirSync(this.o.dataDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ steps, ...extra }));
    }
    this.o.publish?.("update.deferred", { steps });
  }

  /**
   * A step the panel asked for, and the steps meant to follow it. While a turn
   * is in progress they wait; otherwise the step runs now and the panel goes on
   * to the next itself. `now` runs it regardless, ending the turns first.
   * `force` is the person's Update anyway, kept with the steps that wait.
   */
  async request(step: DeferredStep, opts: { now?: boolean; then?: DeferredStep[]; force?: boolean } = {}): Promise<StepResult & { deferred?: DeferredStep[] }> {
    if (!opts.now && this.held(step)) {
      const prior = this.read();
      const steps = [...new Set([...prior.steps, step, ...(opts.then ?? [])])].filter((s) => (DEFERRED_STEPS as readonly string[]).includes(s));
      this.save(steps, { ...(opts.force || prior.force ? { force: true } : {}) });
      this.watch();
      return { ok: true, deferred: steps };
    }
    // Only Restart now ends turns: a step that runs because nothing holds it leaves hosted turns running.
    if (opts.now && this.o.busy()) this.o.interruptTurns();
    return this.o.run(step, opts.force ? { force: true } : {});
  }

  /**
   * The person answered the request a waiting step is held on: approved, the
   * steps run now with the override; denied, they are dropped with the run;
   * expired, the run stops and says so.
   */
  async decide(decision: HoldDecision): Promise<void> {
    const q = this.read();
    if (!q.held || q.steps.length === 0) return;
    if (decision === "approve") {
      this.save(q.steps, { force: true });
      await this.drain(true);
      return;
    }
    this.save([]);
    this.stop();
    if (decision === "deny") this.finishRun();
    else this.markRun(q.steps[0], "failed", HOLD_EXPIRED);
  }

  /**
   * Whether a step has to wait: the plugin for every turn, Studio and the
   * restart for turns a daemon restart would end, and Studio also for turns in
   * a turn host, which the next Studio cannot take over.
   */
  private held(step: DeferredStep): boolean {
    if (step === "plugin") return this.o.busy();
    if (step === "studio" && this.o.hosted?.()) return true;
    return (this.o.pinned ?? this.o.busy)();
  }

  /** Restart now: end the turns in progress and run every waiting step. */
  async runNow(): Promise<StepResult> {
    if (this.o.busy()) this.o.interruptTurns();
    return this.drain(true);
  }

  /** Look for idle every few seconds while a step waits. */
  private watch(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.o.pollMs ?? 3000);
    this.timer.unref?.();
  }

  /** Run what waits once nothing is in progress. */
  async tick(): Promise<void> {
    if (this.draining) return;
    const q = this.read();
    const [first] = q.steps;
    if (!first) {
      this.stop();
      return;
    }
    // Waiting for the person's answer to the consent request, not for turns.
    if (q.held) return;
    if (this.held(first)) return;
    await this.drain();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async drain(force = false): Promise<StepResult> {
    if (this.draining) return { ok: true };
    this.draining = true;
    let last: StepResult = { ok: true };
    let ran = false;
    try {
      for (let q = this.read(); q.steps.length; q = this.read()) {
        const [step, ...rest] = q.steps;
        // A turn that started while the plugin updated: the rest waits for it.
        if (!force && this.held(step)) return last;
        const consent = q.force ? { force: true } : {};
        this.save(rest, consent);
        this.markRun(step, "active");
        ran = true;
        last = await this.o.run(step, consent);
        if (!last.ok && last.request) {
          // Other sessions are using the editor: the steps wait, held on the request, for the person's answer.
          this.save([step, ...rest], { ...consent, held: last.request.id });
          this.markRun(step, "deferred");
          this.stop();
          this.o.held?.(last.request);
          return last;
        }
        if (!last.ok) {
          this.markRun(step, "failed", last.error);
          this.save([]);
          break;
        }
        // Studio and the restart take this daemon down; the next one's panel settles them.
        if (step !== "plugin") return last;
        this.markRun(step, "done");
      }
      // Everything ran and this daemon stays: the panel's run is over.
      if (ran && last.ok) this.finishRun();
      if (this.steps().length === 0) this.stop();
      return last;
    } finally {
      this.draining = false;
    }
  }

  /** A step that started in the background and failed later: the panel's run stops on it, with the error. */
  fail(step: DeferredStep, error: string): void {
    this.markRun(step, "failed", error);
  }

  private finishRun(): void {
    fs.rmSync(path.join(this.o.dataDir, RUN_FILE), { force: true });
    this.o.publish?.("update.run", { run: null });
  }

  /** Tell the panel's update run what a waiting step is doing now. */
  private markRun(step: DeferredStep, state: "active" | "done" | "failed" | "deferred", error?: string): void {
    const file = path.join(this.o.dataDir, RUN_FILE);
    try {
      const run = JSON.parse(fs.readFileSync(file, "utf-8")) as { steps?: Array<{ key: string; state: string }>; error?: string };
      if (!Array.isArray(run.steps)) return;
      run.steps = run.steps.map((s) => (s.key === step ? { ...s, state } : s));
      if (error) run.error = error;
      fs.writeFileSync(file, JSON.stringify(run));
      this.o.publish?.("update.run", { run });
    } catch {
      // No panel run to tell: an update the plugin asked for, say.
    }
  }
}

/**
 * Updates that wait for the turns to finish. Updating Studio or restarting
 * ue-mcp restarts the daemon every turn runs in, and updating the editor
 * plugin closes the editor, so while any session is running or waiting the
 * step is kept here and runs once every session is idle. Restart now runs it
 * at once, ending the turns first with that said in each.
 *
 * The queue is kept in the data folder, and the panel's update run (the run
 * file) is told when a step starts, so the page that loads after a restart
 * settles it like any other.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export type DeferredStep = "plugin" | "studio" | "restart";
export const DEFERRED_STEPS: readonly DeferredStep[] = ["plugin", "studio", "restart"];

/** What a step's route answers: started (studio, restart), finished (plugin), or failed. */
export interface StepResult {
  ok: boolean;
  started?: boolean;
  version?: string;
  error?: string;
}

export interface UpdateQueueOptions {
  dataDir: string;
  /** True while any session is running or waiting. */
  busy: () => boolean;
  /** Run one step now. */
  run: (step: DeferredStep) => Promise<StepResult>;
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

  /** The steps waiting, in the order they run. */
  steps(): DeferredStep[] {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.o.dataDir, QUEUE_FILE), "utf-8")) as { steps?: unknown };
      return Array.isArray(raw.steps) ? raw.steps.filter((s): s is DeferredStep => (DEFERRED_STEPS as readonly string[]).includes(s)) : [];
    } catch {
      return [];
    }
  }

  private save(steps: DeferredStep[]): void {
    const file = path.join(this.o.dataDir, QUEUE_FILE);
    if (steps.length === 0) fs.rmSync(file, { force: true });
    else {
      fs.mkdirSync(this.o.dataDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ steps }));
    }
    this.o.publish?.("update.deferred", { steps });
  }

  /**
   * A step the panel asked for, and the steps meant to follow it. While a turn
   * is in progress they wait; otherwise the step runs now and the panel goes on
   * to the next itself. `now` runs it regardless, ending the turns first.
   */
  async request(step: DeferredStep, opts: { now?: boolean; then?: DeferredStep[] } = {}): Promise<StepResult & { deferred?: DeferredStep[] }> {
    if (!opts.now && this.o.busy()) {
      const steps = [...new Set([...this.steps(), step, ...(opts.then ?? [])])].filter((s) => (DEFERRED_STEPS as readonly string[]).includes(s));
      this.save(steps);
      this.watch();
      return { ok: true, deferred: steps };
    }
    if (this.o.busy()) this.o.interruptTurns();
    return this.o.run(step);
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
    if (this.draining || this.o.busy()) return;
    if (this.steps().length === 0) {
      this.stop();
      return;
    }
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
      for (let steps = this.steps(); steps.length; steps = this.steps()) {
        // A turn that started while the plugin updated: the rest waits for it.
        if (!force && this.o.busy()) return last;
        const [step, ...rest] = steps;
        this.save(rest);
        this.markRun(step, "active");
        ran = true;
        last = await this.o.run(step);
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
  private markRun(step: DeferredStep, state: "active" | "done" | "failed", error?: string): void {
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

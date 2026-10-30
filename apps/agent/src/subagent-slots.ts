/**
 * How many subagents a turn runs at once, from Settings > Agents > Worker, on
 * every route. One started past the limit waits here and starts when a running
 * one finishes, so the model's call takes longer and returns the subagent's
 * own result. Stopping the turn cancels the ones still waiting. A limit of -1
 * (no limit) starts every subagent at once and queues none.
 */
export class SubagentSlots {
  private readonly running = new Set<string>();
  private readonly waiting: Array<{ id: string; go: (started: boolean) => void }> = [];
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit === -1 ? Infinity : Math.max(1, Math.floor(limit) || 1);
  }

  /**
   * Resolves true once the subagent may start, false when it was cancelled
   * while it waited. `onWait` runs only when it has to wait.
   */
  acquire(id: string, onWait?: () => void): Promise<boolean> {
    if (this.running.has(id)) return Promise.resolve(true);
    if (this.running.size < this.limit && this.waiting.length === 0) {
      this.running.add(id);
      return Promise.resolve(true);
    }
    const started = new Promise<boolean>((resolve) => this.waiting.push({ id, go: resolve }));
    onWait?.();
    return started;
  }

  /** A running subagent finished: the next waiting one starts. Safe to call more than once. */
  release(id: string): void {
    if (!this.running.delete(id)) return;
    while (this.running.size < this.limit && this.waiting.length > 0) {
      const next = this.waiting.shift()!;
      this.running.add(next.id);
      next.go(true);
    }
  }

  /** Take one waiting subagent out of the queue. False when it was not waiting. */
  cancel(id: string): boolean {
    const i = this.waiting.findIndex((w) => w.id === id);
    if (i < 0) return false;
    const [w] = this.waiting.splice(i, 1);
    w.go(false);
    return true;
  }

  /** Cancel every waiting subagent, as Stop does. */
  cancelAll(): void {
    for (const w of this.waiting.splice(0)) w.go(false);
  }

  get counts(): { running: number; waiting: number } {
    return { running: this.running.size, waiting: this.waiting.length };
  }
}

/** The result of a subagent the user stopped while it waited to start. */
export const QUEUED_STOP = "The user stopped this subagent before it started. Do not do its task unless the user asks.";

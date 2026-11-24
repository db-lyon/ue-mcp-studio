/**
 * The runner editor (decision 15, docs/plans/playtest-hub/runner-editor.md):
 * a second editor of the project, offscreen and saving nothing, that plays
 * the hub's unattended plans. The developer's editor is never touched by
 * them, and the runner waits on nothing the developer does.
 *
 * - Only unattended run plans play here (takes). An attended plan needs a
 *   person at the workspace editor, and a fix plan edits the project, which
 *   the runner never does.
 * - It starts on demand, when the queue reaches an item for it (prepare), and
 *   stops after RUNNER_IDLE_MS with nothing to run, or when a person stops it.
 * - It plays only what it loaded from disk. When project files changed since
 *   it started, it restarts before the next item, so a run never tests
 *   content older than the files its provenance names.
 * - It holds a lease of its own (lease.ts), so it waits only on itself.
 *
 * ue-mcp cannot run a second editor of one project yet: the daemon keeps one
 * session per project root, start_editor refuses while that project's editor
 * runs, and a second editor would take over port.json. runnerHostOf answers
 * null until the daemon offers asks 13 and 14 (ue-mcp-asks.md); until then
 * there is no runner and unattended plans run under the workspace lease.
 */
import type { HubRunnerEvent, PlanRun, RunnerView } from "@ue-mcp-studio/shared";
import { EditorLease } from "./lease.js";

/** The runner's lease names its editor this. */
export const RUNNER = "runner";
/** The editor instance Studio asks ue-mcp for, and names in calls routed to it (the `editor` parameter). */
export const RUNNER_INSTANCE = "studio-runner";
/** What the daemon must offer: a second editor of the project as a named instance (ask 13), started read-only (ask 14). */
export const RUNNER_FEATURES = ["editors.instances", "editors.readOnly"] as const;
/** The runner stops after this long with nothing to run. */
export const RUNNER_IDLE_MS = 10 * 60_000;
/** A runner that failed to start is tried again no sooner than this. */
export const RUNNER_RETRY_MS = 5 * 60_000;

/** Why the next unattended item waits on the runner, as the queue says it. */
export const RUNNER_WAIT = {
  starting: "The runner editor is starting",
  stopping: "The runner editor is stopping",
  reloading: "The runner editor is reloading saved changes",
  failed: (why: string) => `The runner editor did not start: ${why}`,
} as const;

/** Starting, stopping and reading the runner editor, through the daemon. */
export interface RunnerHost {
  /** Start it and resolve once its bridge answers; throws with ue-mcp's reason. */
  start(): Promise<void>;
  stop(): Promise<void>;
  connected(): boolean;
}

/**
 * The part of the daemon's extension API that asks 13 and 14 propose. It is
 * not in ue-mcp/daemon yet, so it is read only behind the feature check.
 */
export interface InstancesApi {
  features?: readonly string[];
  instances?: {
    list(): Array<{ name: string; connected: boolean }>;
    start(name: string, opts: { window: "offscreen"; readOnly: true }): Promise<{ ok: boolean; reason?: string }>;
    stop(name: string): Promise<{ ok: boolean; reason?: string }>;
  };
}

/** The runner host over the daemon, or null when this ue-mcp cannot run a read-only second editor of the project. */
export function runnerHostOf(api: InstancesApi): RunnerHost | null {
  const instances = api.instances;
  if (!instances || !RUNNER_FEATURES.every((f) => api.features?.includes(f))) return null;
  return {
    start: async () => {
      const r = await instances.start(RUNNER_INSTANCE, { window: "offscreen", readOnly: true });
      if (!r.ok) throw new Error(r.reason ?? "ue-mcp did not start it");
    },
    stop: async () => {
      const r = await instances.stop(RUNNER_INSTANCE);
      if (!r.ok) throw new Error(r.reason ?? "ue-mcp did not stop it");
    },
    connected: () => instances.list().some((e) => e.name === RUNNER_INSTANCE && e.connected),
  };
}

export interface RunnerOptions {
  /** Null: this ue-mcp cannot run one. */
  host: RunnerHost | null;
  /** The runnerEditor setting is on, and so is the hub. */
  enabled: () => boolean;
  /** Project file changes (ProjectWatch), to know when what the runner loaded is out of date. */
  watch: { mark(): number; changedSince(mark: number): boolean };
  /** The runner's state changed: clients hear of it, and the queue may go on. */
  changed: (event: HubRunnerEvent) => void;
  idleMs?: number;
  retryMs?: number;
  now?: () => number;
  log?: { warn(message: string, detail?: unknown): void };
}

type Phase = "stopped" | "starting" | "ready" | "stopping";

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class RunnerEditor {
  readonly lease: EditorLease;
  private phase: Phase = "stopped";
  /** The project files it loaded, as ProjectWatch counted them when it started. */
  private loaded: number | null = null;
  private error: string | null = null;
  private failedAt = -Infinity;
  private idle: NodeJS.Timeout | null = null;
  /** The start or stop under way. */
  private going: Promise<void> | null = null;
  private readonly now: () => number;

  constructor(private readonly o: RunnerOptions) {
    this.now = o.now ?? Date.now;
    this.lease = new EditorLease(RUNNER, (held) => {
      if (held) this.clearIdle();
      else this.armIdle();
      this.publish();
    });
  }

  /** ue-mcp can run one and the setting is on. */
  available(): boolean {
    return this.o.host !== null && this.o.enabled();
  }

  /** Whether a plan plays here: an unattended run plan, while there is a runner. */
  takes(plan: PlanRun): boolean {
    return this.available() && !plan.options.attended && (plan.work ?? "run") === "run";
  }

  connected(): boolean {
    return this.phase === "ready" && !!this.o.host?.connected();
  }

  /**
   * Get ready for the next item: why it cannot take one yet, or null when it
   * can. A stopped runner is started, and one whose project files changed
   * since it started is restarted.
   */
  prepare(): string | null {
    const host = this.o.host;
    if (!host) return null;
    if (this.phase === "starting") return RUNNER_WAIT.starting;
    if (this.phase === "stopping") return RUNNER_WAIT.stopping;
    if (this.phase === "ready") {
      if (!host.connected()) this.lost();
      else if (this.loaded !== null && this.o.watch.changedSince(this.loaded)) {
        void this.stop().then(() => this.start());
        return RUNNER_WAIT.reloading;
      } else return null;
    }
    if (this.error && this.now() - this.failedAt < (this.o.retryMs ?? RUNNER_RETRY_MS)) return RUNNER_WAIT.failed(this.error);
    void this.start();
    return RUNNER_WAIT.starting;
  }

  private start(): Promise<void> {
    if (this.going) return this.going;
    const host = this.o.host;
    if (!host || this.phase !== "stopped") return Promise.resolve();
    this.phase = "starting";
    this.publish();
    // Taken before the start: a change while it loads may not be in what it loaded.
    const mark = this.o.watch.mark();
    this.going = host.start().then(
      () => {
        this.phase = "ready";
        this.loaded = mark;
        this.error = null;
        this.armIdle();
      },
      (e: unknown) => {
        this.phase = "stopped";
        this.error = messageOf(e);
        this.failedAt = this.now();
        this.o.log?.warn("hub: the runner editor did not start", e);
      },
    ).finally(() => {
      this.going = null;
      this.publish();
    });
    return this.going;
  }

  /** Stop the runner editor. The queue lets go of an item playing there first (Hub.stopRunner). */
  stop(): Promise<void> {
    if (this.going) return this.going.then(() => this.stop());
    const host = this.o.host;
    if (!host || this.phase === "stopped") return Promise.resolve();
    this.clearIdle();
    this.phase = "stopping";
    this.publish();
    this.going = host.stop().then(
      () => {
        this.phase = "stopped";
        this.loaded = null;
      },
      (e: unknown) => {
        this.phase = host.connected() ? "ready" : "stopped";
        this.o.log?.warn("hub: the runner editor did not stop", e);
      },
    ).finally(() => {
      this.going = null;
      this.publish();
    });
    return this.going;
  }

  /** Its editor went away: the daemon said so, or it stopped answering. */
  lost(): void {
    if (this.phase === "stopped") return;
    this.clearIdle();
    this.phase = "stopped";
    this.loaded = null;
    this.publish();
  }

  /**
   * The periodic look. An editor that went away without a word is lost, and
   * one no longer wanted (the setting turned off) is stopped once it holds
   * nothing. Returns whether its editor was lost.
   */
  tick(): boolean {
    if (this.phase !== "ready") return false;
    if (!this.o.host?.connected()) {
      this.lost();
      return true;
    }
    if (!this.o.enabled() && !this.lease.get()) void this.stop();
    return false;
  }

  /** What clients show; `runner` is null while there is no runner and none is running. */
  event(): HubRunnerEvent {
    const supported = this.o.host !== null;
    if (!this.available() && this.phase === "stopped") return { supported, runner: null };
    const lease = this.lease.get();
    const state: RunnerView["state"] = this.phase === "ready" && lease ? "running" : this.phase;
    return { supported, runner: { state, purpose: lease && state === "running" ? lease.purpose : null, error: this.phase === "stopped" ? this.error : null } };
  }

  dispose(): void {
    this.clearIdle();
    if (this.phase !== "stopped") void this.stop();
  }

  private armIdle(): void {
    this.clearIdle();
    if (this.phase !== "ready" || this.lease.get()) return;
    this.idle = setTimeout(() => {
      this.idle = null;
      if (this.phase === "ready" && !this.lease.get()) void this.stop();
    }, this.o.idleMs ?? RUNNER_IDLE_MS);
    this.idle.unref?.();
  }

  private clearIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
  }

  private publish(): void {
    this.o.changed(this.event());
  }
}

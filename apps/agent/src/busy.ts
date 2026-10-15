/**
 * What the editor is working on right now, from what the daemon already
 * knows: the ue-mcp calls Studio's agent has in flight, and the calls other
 * MCP clients have in flight (the daemon's call.started and call.finished
 * events). The editor is never asked, so this answers while its game thread
 * is blocked. The window shows the oldest call as "Editor busy" with a timer,
 * and Stop ends the turns waiting on them. An editor restart, rebuild, start
 * or stop the daemon runs (its editor.operation events) shows step by step
 * until the editor is back, and an operation that did not bring it back says
 * why until the next one starts or the editor connects.
 */
import type { ActionResult } from "ue-mcp/daemon";
import type { BusyCall, BusyState, EditorOperation, EditorOperationFailure } from "@ue-mcp-studio/shared";
import type { AgentHost } from "./tools.js";
import { firstFailedStep, stepReason, type OperationStep } from "./operation-result.js";

/** Lookups that the daemon answers itself; they never wait on the editor. */
const LOCAL = new Set(["project.search_tools", "project.describe_action"]);

/** The last step of each editor operation: when it is done, the operation waits only for the editor to attach. */
const LAST_STEP: Record<EditorOperation["op"], string> = {
  start: "editor.start_editor",
  stop: "editor.stop_editor",
  restart: "editor.restart_editor",
  rebuild: "editor.start_editor",
};
const OPS = new Set(Object.keys(LAST_STEP));

/**
 * How long a started editor may take to attach once its start step is done.
 * The daemon's start step already waits for the bridge, so the editor attaches
 * within seconds; past this the wait is over and the banner says so (#1384).
 */
export const CONNECT_MS = 90_000;

export class BusyTracker {
  private next = 1;
  private readonly calls = new Map<number, BusyCall>();
  private operation: EditorOperation | null = null;
  private failure: EditorOperationFailure | null = null;
  private connectTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly publish: (type: string, data: Record<string, unknown>) => void = () => {},
    private readonly now: () => number = Date.now,
    private readonly editorConnected: () => boolean = () => false,
    private readonly connectMs: number = CONNECT_MS,
  ) {}

  state(): BusyState {
    return {
      now: this.now(),
      calls: [...this.calls.values()].sort((a, b) => a.startedAt - b.startedAt),
      ...(this.operation ? { operation: { ...this.operation } } : {}),
      ...(this.failure ? { failure: { ...this.failure } } : {}),
    };
  }

  /** Set the operation, arming the bound on the wait for the editor to attach. */
  private setOperation(next: EditorOperation | null): void {
    this.operation = next;
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
    if (next?.step !== "connect") return;
    const waiting = next;
    this.connectTimer = setTimeout(() => {
      if (this.operation !== waiting) return;
      this.fail(waiting.op, "connect", `The editor started but did not connect within ${Math.round(this.connectMs / 1000)} seconds. It may be stopped at a prompt in its own window; check it, or start it again.`);
    }, this.connectMs);
    this.connectTimer.unref?.();
  }

  /** End the operation as failed, keeping why for the banner. */
  private fail(op: EditorOperation["op"], step: string, reason: string): void {
    this.setOperation(null);
    this.failure = { op, step, reason, at: this.now() };
    this.changed();
  }

  /** One editor.operation event: a step started, finished or failed. */
  private stepOf(data: Record<string, unknown>): void {
    const op = data.op as EditorOperation["op"];
    const step = typeof data.step === "string" ? data.step : "";
    if (!OPS.has(op) || !step) return;
    const at = this.now();
    if (data.phase === "started") {
      // A new operation, or the next step of the one running.
      this.failure = null;
      this.setOperation(this.operation?.op === op && this.operation.step !== "connect"
        ? { ...this.operation, step, stepStartedAt: at }
        : { op, step, startedAt: at, stepStartedAt: at });
    } else if (data.phase === "failed") {
      const reason = typeof data.reason === "string" && data.reason ? data.reason : `${step} failed.`;
      this.fail(op, step, reason);
      return;
    } else if (data.phase === "done" && this.operation?.op === op && step === LAST_STEP[op]) {
      this.setOperation(op === "stop" || this.editorConnected() ? null : { ...this.operation, step: "connect", stepStartedAt: at });
    } else {
      return;
    }
    this.changed();
  }

  private changed(): void {
    this.publish("busy.changed", { ...this.state() });
  }

  start(call: Omit<BusyCall, "id" | "startedAt" | "stopped">): number {
    const id = this.next++;
    this.calls.set(id, { ...call, id, startedAt: this.now(), stopped: false });
    this.changed();
    return id;
  }

  finish(id: number): void {
    if (this.calls.delete(id)) this.changed();
  }

  /** The host a session's turn runs on: the same, with each editor call it makes tracked. */
  wrap(host: AgentHost, sessionId: string): AgentHost {
    const callAction = async (category: string, action: string, args?: Record<string, unknown>): Promise<ActionResult> => {
      if (LOCAL.has(`${category}.${action}`)) return host.callAction(category, action, args);
      const id = this.start({ category, action, source: "studio", sessionId });
      try {
        return await host.callAction(category, action, args);
      } finally {
        this.finish(id);
      }
    };
    return {
      get projectDir() { return host.projectDir; },
      get dataDir() { return host.dataDir; },
      callAction,
      editors: () => host.editors(),
      editorOperation: async (op) => {
        const result = await host.editorOperation(op);
        this.settle(op, result);
        return result;
      },
      events: host.events,
      setBusy: (busy) => host.setBusy(busy),
      log: host.log,
    };
  }

  /**
   * An operation Studio ran has returned. A failed step ends it with its reason,
   * also when the daemon reported that step done: a daemon up to ue-mcp 1.4.3
   * does so for a handler that returned success: false.
   */
  private settle(op: EditorOperation["op"], result: Record<string, unknown>): void {
    const steps = (result.steps as OperationStep[] | undefined) ?? [];
    const failed = firstFailedStep(steps);
    if (failed) this.fail(op, failed.step, stepReason(failed));
  }

  /**
   * The user's Stop: nothing waits on the editor attaching any more, so the
   * wait for it ends. A step the daemon is still running stays: it is real.
   */
  endWait(): void {
    if (this.operation?.step !== "connect") return;
    this.setOperation(null);
    this.changed();
  }

  /** Calls other MCP clients make, from the daemon's activity events. */
  observe(e: { type: string; data: Record<string, unknown> }): void {
    const category = typeof e.data.category === "string" ? e.data.category : "";
    const action = typeof e.data.action === "string" ? e.data.action : "";
    const client = typeof e.data.client === "string" ? e.data.client : "a client";
    if (e.type === "call.started") {
      if (!category || !action || LOCAL.has(`${category}.${action}`)) return;
      this.start({ category, action, source: "client", client });
    } else if (e.type === "call.finished") {
      // Events carry no call id: the oldest matching call is the one that finished.
      const match = this.state().calls.find((c) => c.source === "client" && c.client === client && c.category === category && c.action === action);
      if (match) this.finish(match.id);
    } else if (e.type === "editor.operation") {
      this.stepOf(e.data);
    } else if (e.type === "editor.connected") {
      if (this.operation?.step === "connect" || this.failure) {
        if (this.operation?.step === "connect") this.setOperation(null);
        this.failure = null;
        this.changed();
      }
    } else if (e.type === "daemon.stopping") {
      this.calls.clear();
      this.setOperation(null);
      this.changed();
    }
  }

  /**
   * Stop every turn waiting on an editor call. The call itself runs on in the
   * editor until it returns; the turn does not wait for it. Returns the
   * sessions stopped.
   */
  stop(stopSession: (sessionId: string) => void): string[] {
    const sessions = new Set<string>();
    for (const c of this.calls.values()) {
      if (c.source !== "studio" || c.stopped || !c.sessionId) continue;
      sessions.add(c.sessionId);
      c.stopped = true;
    }
    for (const id of sessions) {
      try {
        stopSession(id);
      } catch {
        // A session deleted meanwhile has nothing left to stop.
      }
    }
    if (sessions.size) this.changed();
    this.endWait();
    return [...sessions];
  }
}

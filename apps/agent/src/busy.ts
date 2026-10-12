/**
 * What the editor is working on right now, from what the daemon already
 * knows: the ue-mcp calls Studio's agent has in flight, and the calls other
 * MCP clients have in flight (the daemon's call.started and call.finished
 * events). The editor is never asked, so this answers while its game thread
 * is blocked. The window shows the oldest call as "Editor busy" with a timer,
 * and Stop ends the turns waiting on them. An editor restart, rebuild, start
 * or stop the daemon runs (its editor.operation events) shows step by step
 * until the editor is back.
 */
import type { ActionResult } from "ue-mcp/daemon";
import type { BusyCall, BusyState, EditorOperation } from "@ue-mcp-studio/shared";
import type { AgentHost } from "./tools.js";

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

export class BusyTracker {
  private next = 1;
  private readonly calls = new Map<number, BusyCall>();
  private operation: EditorOperation | null = null;

  constructor(
    private readonly publish: (type: string, data: Record<string, unknown>) => void = () => {},
    private readonly now: () => number = Date.now,
    private readonly editorConnected: () => boolean = () => false,
  ) {}

  state(): BusyState {
    return {
      now: this.now(),
      calls: [...this.calls.values()].sort((a, b) => a.startedAt - b.startedAt),
      ...(this.operation ? { operation: { ...this.operation } } : {}),
    };
  }

  /** One editor.operation event: a step started, finished or failed. */
  private stepOf(data: Record<string, unknown>): void {
    const op = data.op as EditorOperation["op"];
    const step = typeof data.step === "string" ? data.step : "";
    if (!OPS.has(op) || !step) return;
    const at = this.now();
    if (data.phase === "started") {
      // A new operation, or the next step of the one running.
      this.operation = this.operation?.op === op && this.operation.step !== "connect"
        ? { ...this.operation, step, stepStartedAt: at }
        : { op, step, startedAt: at, stepStartedAt: at };
    } else if (data.phase === "failed") {
      this.operation = null;
    } else if (data.phase === "done" && this.operation?.op === op && step === LAST_STEP[op]) {
      this.operation = op === "stop" || this.editorConnected() ? null : { ...this.operation, step: "connect", stepStartedAt: at };
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
      editorOperation: (op) => host.editorOperation(op),
      events: host.events,
      setBusy: (busy) => host.setBusy(busy),
      log: host.log,
    };
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
      if (this.operation?.step === "connect") {
        this.operation = null;
        this.changed();
      }
    } else if (e.type === "daemon.stopping") {
      this.calls.clear();
      this.operation = null;
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
    return [...sessions];
  }
}

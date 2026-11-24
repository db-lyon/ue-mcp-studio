/**
 * Whether Play In Editor is running, as Studio knows it without polling the
 * editor: the daemon's pie.* events, pushed by the editor for every session
 * however it started, and the calls Studio makes (a turn's, a playtest's, a
 * flow's). A daemon without those events is read the older way: the calls
 * other MCP clients make (the daemon's call.finished events) and the editor's
 * own answer when it connects. The viewport's streamer coming and going counts
 * too. The
 * chat's PIE indicator and card read it through GET /viewport, and every
 * change is published so a client asks again.
 *
 * It also keeps Studio's agent off the stream the Viewport tab owns: the tab
 * starts pie(stream_start) with Studio's own signalling, so an agent's
 * stream_start or stream_stop would replace or end the user's stream.
 */
import type { ActionResult } from "ue-mcp/daemon";
import { pieFromEvent } from "@ue-mcp-studio/shared";

/** The stream actions the Viewport tab owns. stream_status stays open: it changes nothing. */
export const VIEWPORT_OWNED = new Set(["stream_start", "stream_stop"]);

/** What the agent is answered when it calls one of them. */
export const VIEWPORT_OWNED_REFUSAL =
  "Studio's Viewport tab runs the live PIE stream: it calls stream_start itself, with Studio's own signalling, when the user opens it or presses Watch live on the Play In Editor card in the chat, and stops it when they close it. "
  + "Do not call stream_start or stream_stop, and never ask the user for a signalling URL. To let the user watch, start PIE and tell them to press Watch live on the card, or open Viewport from the menu. "
  + "Watching is free on every plan. Watching from another network goes through Studio's relay server, which needs the Pro plan.";

/** The PIE test and acceptance actions that start PIE when they run. */
const STARTS_PIE = new Set(["script_run", "script_replay", "replay_run", "uat_run"]);

function textOf(r: ActionResult): string {
  return r.content.map((c) => c.text ?? "").join("\n").trim();
}

function bodyOf(r: ActionResult): Record<string, unknown> {
  try {
    const v = JSON.parse(textOf(r)) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * What one answered call says about PIE: running (true), not running (false),
 * or nothing (null). A start is a deferred request in the editor, so its
 * answer says the session was requested, not that it plays yet; it counts as
 * running.
 */
export function pieAfter(category: string, action: string, args: Record<string, unknown> | undefined, r: ActionResult): boolean | null {
  const a = args ?? {};
  const body = bodyOf(r);
  if (category === "editor" && action === "play_in_editor") {
    const op = typeof a.pieAction === "string" ? a.pieAction : "status";
    if (body.alreadyRunning === true || body.isPlaying === true || body.playSessionRequested === true) return true;
    if (op === "stop" && (!r.isError || body.alreadyStopped === true)) return false;
    if (op === "status" && body.isPlaying === false) return false;
    return null;
  }
  if (category === "editor" && action === "play_in_editor_ignore_blueprint_errors") return r.isError ? null : true;
  if (category === "pie" && STARTS_PIE.has(action)) {
    if (r.isError || a.mode === "manual" || a.start_pie === false) return null;
    return true;
  }
  if (category === "pie" && action === "uat_abort") return r.isError ? null : false;
  return null;
}

/** The calls other clients make that may start or stop PIE; their arguments are not in the event, so the editor is asked. */
const MAY_CHANGE = new Set(["editor.play_in_editor", "editor.play_in_editor_ignore_blueprint_errors", "pie.script_run", "pie.script_replay", "pie.replay_run", "pie.uat_run", "pie.uat_abort"]);

export interface PieWatchOptions {
  /** editor(play_in_editor, status), as the raw host makes it. */
  callAction: (category: string, action: string, args?: Record<string, unknown>) => Promise<ActionResult>;
  connected: () => boolean;
  /** PIE started or stopped. */
  changed: () => void;
  /**
   * The daemon publishes pie.* events (extension feature "events.pie"): every
   * session change however it started, and the state on each editor attach.
   * Then the guesses from other clients' calls and the ask on connect are not
   * needed. An older daemon leaves this false.
   */
  pushed?: () => boolean;
}

export class PieWatch {
  private running = false;
  private asking: Promise<void> | null = null;
  private readonly listeners = new Set<(running: boolean) => void>();

  constructor(private readonly o: PieWatchOptions) {}

  get(): boolean {
    return this.running;
  }

  /** Hear each start and stop, beside `changed`. Returns the unsubscribe. */
  listen(listener: (running: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  set(v: boolean): void {
    if (v === this.running) return;
    this.running = v;
    this.o.changed();
    for (const l of this.listeners) l(v);
  }

  /** Ask the editor once (calls that land together share it). An editor that does not answer leaves what was known. */
  refresh(): Promise<void> {
    if (!this.o.connected()) {
      this.set(false);
      return Promise.resolve();
    }
    this.asking ??= this.o
      .callAction("editor", "play_in_editor", { pieAction: "status" })
      .then((r) => {
        const body = bodyOf(r);
        if (!r.isError && typeof body.isPlaying === "boolean") this.set(body.isPlaying);
      }, () => undefined)
      .finally(() => {
        this.asking = null;
      });
    return this.asking;
  }

  /** A call Studio made, with its answer. */
  saw(category: string, action: string, args: Record<string, unknown> | undefined, r: ActionResult): void {
    const v = pieAfter(category, action, args, r);
    if (v !== null) this.set(v);
  }

  /**
   * The daemon's events: its pie.* events where it has them, which see a
   * session the user started with the editor's Play button; otherwise the
   * editor coming, other clients' calls and PIE test scripts, each a reason to
   * ask the editor. The editor going always means no PIE. An event from
   * another editor instance of the project (ask 13's `instance`, the hub's
   * runner) says nothing about this one.
   */
  observe(e: { type: string; data: Record<string, unknown> }): void {
    if (e.data?.instance !== undefined) return;
    const pushed = pieFromEvent(e.type);
    if (pushed !== null) this.set(pushed);
    else if (e.type === "editor.disconnected") this.set(false);
    else if (this.o.pushed?.()) return;
    else if (e.type === "editor.connected") void this.refresh();
    else if (e.type === "script.run_started" || e.type === "script.run_finished") void this.refresh();
    else if (e.type === "call.finished" && MAY_CHANGE.has(`${String(e.data.category)}.${String(e.data.action)}`)) void this.refresh();
  }

  /**
   * The host Studio's chat runs on: every call it makes is watched for PIE,
   * and the stream actions the Viewport tab owns are answered with why not.
   */
  wrap<H extends { callAction(category: string, action: string, args?: Record<string, unknown>, opts?: any): Promise<ActionResult> }>(host: H): H {
    const callAction = async (category: string, action: string, args?: Record<string, unknown>, opts?: unknown): Promise<ActionResult> => {
      if (category === "pie" && VIEWPORT_OWNED.has(action)) return { isError: true, content: [{ type: "text", text: VIEWPORT_OWNED_REFUSAL }] };
      const r = await host.callAction(category, action, args, opts);
      this.saw(category, action, args, r);
      return r;
    };
    return new Proxy(host, { get: (target, prop, receiver) => (prop === "callAction" ? callAction : Reflect.get(target, prop, receiver)) });
  }
}

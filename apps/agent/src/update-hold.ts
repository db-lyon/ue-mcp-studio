/**
 * Studio's Update against ue-mcp's editor consent gate (feature
 * "editor.consent"). Installing the editor plugin closes the editor, and a
 * source bridge is rebuilt, so with other sessions using the editor the step
 * is held. A person clicked Update, so it is their decision: every client
 * shows who holds the editor and why, with Update anyway and Cancel.
 *
 * The hold is kept here, in one place, and published as `update.consent`, so
 * the computer's Studio and a paired phone show the same ask. Approving goes
 * through ue-mcp's own override route (POST /v1/disruptions/<id>/approve),
 * from whichever client; this watches the daemon's `disruption.updated`
 * events and says how the request was decided, and the side that runs the
 * held step (the computer's panel, or the waiting-step queue) goes on with
 * `force`, or stops.
 *
 * On a daemon without the feature nothing here runs and Update behaves as
 * before.
 */
import type { DisruptionView, DisruptiveOp } from "./consent.js";

/** Who an Update is, to the other sessions. The same words as client-core's STUDIO_REQUESTER, so the clients know the request is the person's own. */
export const UPDATE_REQUESTER = "the user in Studio";
/** Why, as the other sessions are told. */
export const UPDATE_REASON = "installing an update";

/** Who runs the held step once the request is decided: the computer's panel, or the queue of steps waiting for turns. */
export type HoldSource = "panel" | "queue";
export type HoldDecision = "approve" | "deny" | "expired";

export interface UpdateHoldState {
  request: DisruptionView;
  source: HoldSource;
  /** Studio's own subagents the request waits for the person to stop. */
  subagents?: Array<{ sessionId: string; callId: string; description: string }>;
}

/** What an Update step carries for the gate: the person's override. */
export interface UpdateConsent {
  force?: boolean;
}

/** The consent body of an Update step's request. */
export function consentOf(body: unknown): UpdateConsent {
  return (body as { force?: unknown } | undefined)?.force === true ? { force: true } : {};
}

/** Whether an editor operation's result is the gate's refusal, and its request. */
export function refusalOf(result: Record<string, unknown>): { reason: string; request: DisruptionView } | null {
  const steps = result.steps as Array<{ step?: string; reason?: string; result?: string }> | undefined;
  const first = steps?.[0];
  const request = result.request as DisruptionView | undefined;
  if (first?.step !== "consent" || !request || typeof request.id !== "string") return null;
  return { reason: first.reason ?? first.result ?? "other sessions are using the editor", request };
}

/** The operation an Update's steps ask for first, or null when none of them closes the editor. */
export function updateOp(steps: readonly string[], sourceBridge: boolean): DisruptiveOp | null {
  // The bridge runs first; a source bridge is rebuilt, which closes the editor. A binary one is staged without closing it.
  if (steps.includes("ueMcp") && sourceBridge) return "rebuild";
  if (steps.includes("plugin")) return "stop";
  return null;
}

const DECIDED: Partial<Record<DisruptionView["state"], HoldDecision>> = { approved: "approve", done: "approve", denied: "deny", expired: "expired" };

export class UpdateHold {
  private hold: UpdateHoldState | null = null;

  constructor(private readonly o: {
    publish: (type: string, data: Record<string, unknown>) => void;
    /** The request was decided: the side that runs the held step goes on or stops. */
    decided?: (source: HoldSource, decision: HoldDecision) => void;
  }) {}

  current(): UpdateHoldState | null {
    return this.hold;
  }

  /** Hold the Update on a request the gate has not approved. */
  set(request: DisruptionView, source: HoldSource, subagents?: UpdateHoldState["subagents"]): void {
    this.hold = { request, source, ...(subagents?.length && request.state === "confirm" ? { subagents } : {}) };
    this.o.publish("update.consent", { hold: this.hold });
  }

  /** Let go of the hold without a decision (the step ran, or the run was dropped). */
  clear(): void {
    if (!this.hold) return;
    this.hold = null;
    this.o.publish("update.consent", { hold: null });
  }

  /** A daemon event: a change to the held request is shown, and its decision ends the hold. */
  onEvent(e: { type: string; data?: unknown }): void {
    if (!this.hold || (e.type !== "disruption.updated" && e.type !== "disruption.requested")) return;
    const r = e.data as DisruptionView | undefined;
    if (!r || r.id !== this.hold.request.id) return;
    const decision = DECIDED[r.state];
    if (!decision) {
      this.set(r, this.hold.source, this.hold.subagents);
      return;
    }
    const { source } = this.hold;
    this.hold = null;
    this.o.publish("update.consent", { hold: null, decided: decision });
    this.o.decided?.(source, decision);
  }
}

/** Studio's own running subagents a refused editor operation says it waits on, or undefined. */
export function subagentsOf(result: Record<string, unknown>): UpdateHoldState["subagents"] {
  const list = result.subagents;
  return Array.isArray(list) && list.length > 0 ? (list as NonNullable<UpdateHoldState["subagents"]>) : undefined;
}

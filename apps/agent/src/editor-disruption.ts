/**
 * Every editor operation a person starts in Studio (Update's bridge and
 * plugin steps, a restart button) goes through here, so ue-mcp's consent
 * protocol (feature "editor.consent") is answered in one place.
 *
 * The person's click owes no subagent attestation, so the daemon's HTTP route
 * is used where there is one. When a request still asks for it (state
 * "confirm"), Studio answers for itself: it knows its own subagents. With none
 * running it confirms "none". With some running it asks the person to stop
 * them (`stopOwnSubagents` runs on their answer) and confirms "paused".
 * The other sessions' answers are theirs to give; a request they have not
 * agreed to is returned as the gate's refusal, and the person's override stays
 * ue-mcp's own (`force`).
 */
import type { ConsentLedger, DisruptionView } from "./consent.js";
import { UPDATE_REASON, UPDATE_REQUESTER, refusalOf } from "./update-hold.js";

/** A subagent of one of Studio's conversations that is running now. */
export interface OwnSubagent {
  sessionId: string;
  callId: string;
  description: string;
}

export interface DisruptionDeps {
  /** The daemon advertises "editor.consent". */
  consentOn(): boolean;
  ledger: Pick<ConsentLedger, "editorOperation" | "confirm" | "find">;
  /** The extension API's editor operation, for a daemon without the ledger routes. */
  api(op: "stop" | "restart" | "rebuild", opts: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Studio's subagents running now, in every conversation. */
  subagents(): OwnSubagent[];
  /** Stop one of them. */
  stop(s: OwnSubagent): boolean;
}

export interface PersonOpOptions {
  /** The person's override: ue-mcp runs it whatever the sessions answered. */
  force?: boolean;
  requester?: string;
  reason?: string;
}

/** The ids ue-mcp's refusal text names ("request r-4e3171 to ..."). */
const REQUEST_IN_TEXT = /\brequest (r-[0-9a-f]+)\b/;

type Result = Record<string, unknown>;

/** The consent refusal of a result and its request, finding the request when the result names only its id. */
async function refusal(d: DisruptionDeps, result: Result): Promise<{ reason: string; request: DisruptionView } | null> {
  const found = refusalOf(result);
  if (found) return found;
  const first = (result.steps as Array<{ step?: string; reason?: string; result?: string }> | undefined)?.[0];
  if (first?.step !== "consent") return null;
  const reason = first.reason ?? first.result ?? "other sessions are using the editor";
  const named = typeof result.request === "string" ? result.request : REQUEST_IN_TEXT.exec(reason)?.[1];
  const request = named && d.consentOn() ? await d.ledger.find(named).catch(() => null) : null;
  return request ? { reason, request } : null;
}

/** What to tell the person about subagents Studio will not stop without them. */
export function subagentsHeldText(list: readonly OwnSubagent[]): string {
  const names = list.map((s) => `"${s.description}"`).join(", ");
  return `${list.length === 1 ? "A subagent is" : `${list.length} subagents are`} still working in Studio (${names}). Stop ${list.length === 1 ? "it" : "them"} to go on, or wait until ${list.length === 1 ? "it finishes" : "they finish"}.`;
}

/**
 * Run `op` as the person. The result is the daemon's: a refusal by the gate
 * carries `request`, and `subagents` when Studio's own running subagents are
 * what it waits for and the person has not agreed to stop them.
 */
export async function runPersonOperation(d: DisruptionDeps, op: "stop" | "restart" | "rebuild", o: PersonOpOptions = {}): Promise<Result> {
  const own = () => d.subagents();
  const requester = o.requester ?? UPDATE_REQUESTER;
  const reason = o.reason ?? UPDATE_REASON;
  const attempt = (requestId?: string, subagents?: "none" | "paused"): Promise<Result> =>
    d.consentOn()
      ? d.ledger.editorOperation(op, { requester, reason, ...(o.force ? { force: true } : {}), ...(requestId ? { requestId } : {}) })
      : d.api(op, { person: true, reason, ...(subagents ? { subagents } : {}) });
  // Up front where the API allows it: with none running, say so on the first call.
  let result = await attempt(undefined, own().length === 0 ? "none" : undefined);
  for (let round = 0; round < 3; round++) {
    const held = await refusal(d, result);
    if (!held || held.request.state !== "confirm") return held ? { ...result, request: held.request } : result;
    const running = own();
    if (running.length > 0) {
      return { ...result, request: held.request, subagents: running };
    }
    if (d.consentOn()) {
      const confirmed = await d.ledger.confirm(held.request.id, held.request.requester.id, "none").catch(() => null);
      if (!confirmed) return { ...result, request: held.request };
      result = await attempt(held.request.id);
    } else {
      result = await attempt(undefined, "none");
    }
  }
  return result;
}

/**
 * The person agreed to stop Studio's running subagents for the request that
 * waits on them: they are stopped through the runner, then the request is
 * confirmed "paused". Returns the request as the daemon now holds it.
 */
export async function stopOwnSubagents(d: DisruptionDeps, request: DisruptionView): Promise<DisruptionView> {
  for (const s of d.subagents()) d.stop(s);
  return d.ledger.confirm(request.id, request.requester.id, "paused");
}

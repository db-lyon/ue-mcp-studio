/**
 * The editor consent gate as a client meets it (ue-mcp daemon feature
 * "editor.consent"). POST /v1/editor/{stop,restart,rebuild} answers 409 with
 * a disruption request while other sessions using the editor have not agreed.
 * The person sees who is holding it and why, and either overrides at once
 * (the same op again with `force`, which ue-mcp counts as a person's
 * approval of the same request) or cancels (the request is denied, so the
 * sessions it was put to stop waiting on it).
 *
 * An older daemon never answers 409 with a request, so `consentRequestOf`
 * returns null and every caller behaves exactly as before.
 */

/** A request to stop, restart, rebuild, build under or patch the editor, as the daemon serves it (ue-mcp's EditorDisruptionRequest). */
export interface EditorDisruptionRequest {
  id: string;
  op: "stop" | "restart" | "rebuild" | "build" | "live_coding";
  action: string;
  requester: { id: string; label: string; parent?: string };
  reason?: string;
  state: "pending" | "confirm" | "blocked" | "approved" | "done" | "denied" | "expired";
  createdAt: string;
  expiresAt: string;
  answers: EditorDisruptionAnswer[];
  self: { attestationRequired: boolean; attested: "none" | "paused" | null; inflight: string[] };
  override?: { decision: "approve" | "deny"; by: string; at: string };
}

/** One session's answer to a request. `unanswered` counts as a wait. */
export interface EditorDisruptionAnswer {
  session: string;
  label: string;
  parent?: string;
  answer: "go" | "wait_until_released" | "block" | "unanswered";
  reason: string;
  auto: boolean;
  touched?: string[];
}

/** The operations a person starts from a button that the gate can hold. */
export type ConsentOp = "stop" | "restart" | "rebuild";

/** What a person's request to an editor operation carries. */
export interface EditorOpBody {
  /** Run it now, whatever the sessions answered: a person's override. */
  force?: boolean;
  /** Who asks, as the other sessions are told. */
  requester?: string;
  reason?: string;
  /** An approved request to run under. */
  requestId?: string;
}

/** Who a button press in Studio is, to the other sessions. */
export const STUDIO_REQUESTER = "the user in Studio";

/** A held operation the person is asked about. */
export interface ConsentAsk {
  op: ConsentOp;
  request: EditorDisruptionRequest;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function isRequest(v: unknown): v is EditorDisruptionRequest {
  return isObj(v) && typeof v.id === "string" && v.id !== "" && Array.isArray(v.answers) && isObj(v.requester);
}

/**
 * The disruption request a refused editor operation carries: an error with
 * status 409 and `body.request` (client-core's HttpError, the web client's
 * ApiError). Null for any other error, and for every error from a daemon
 * without the gate.
 */
export function consentRequestOf(e: unknown): EditorDisruptionRequest | null {
  if (!isObj(e) || e.status !== 409) return null;
  const request = isObj(e.body) ? e.body.request : undefined;
  return isRequest(request) ? request : null;
}

/** The ask for an operation refused by the gate, or null when the error is anything else. */
export function consentAskOf(op: ConsentOp, e: unknown): ConsentAsk | null {
  const request = consentRequestOf(e);
  return request ? { op, request } : null;
}

/** Whether an operation is one the gate can hold. */
export const isConsentOp = (op: string): op is ConsentOp => op === "stop" || op === "restart" || op === "rebuild";

export interface ConsentHolder {
  session: string;
  label: string;
  state: string;
  reason: string;
  blocked: boolean;
}

const STATE: Record<Exclude<EditorDisruptionAnswer["answer"], "go">, string> = {
  wait_until_released: "Waiting",
  block: "Blocked",
  unanswered: "No answer yet",
};

/** The sessions holding a request: every answer that is not go, blocks first. */
export function consentHolders(r: EditorDisruptionRequest): ConsentHolder[] {
  return r.answers
    .filter((a): a is EditorDisruptionAnswer & { answer: Exclude<EditorDisruptionAnswer["answer"], "go"> } => a.answer !== "go" && a.answer in STATE)
    .map((a) => ({ session: a.session, label: a.label || a.session, state: STATE[a.answer], reason: a.reason, blocked: a.answer === "block" }))
    .sort((a, b) => Number(b.blocked) - Number(a.blocked));
}

const LEAD: Record<ConsentOp, string> = {
  stop: "Stopping the editor now ends their work in it, including anything unsaved.",
  restart: "Restarting the editor now ends their work in it, including anything unsaved.",
  rebuild: "Rebuilding now closes the editor and ends their work in it, including anything unsaved.",
};

const VERB: Record<ConsentOp, string> = { stop: "Stop", restart: "Restart", rebuild: "Rebuild" };

/** The words of the ask, the same on every client. */
export function consentCopy(op: ConsentOp): { title: string; lead: string; approve: string; cancel: string } {
  return { title: "Other sessions are using the editor", lead: LEAD[op], approve: `${VERB[op]} anyway`, cancel: "Cancel" };
}

/** One holder as a single line: "Claude Code: Waiting, busy (blueprint.add_variable)". */
export const holderLine = (h: ConsentHolder): string => `${h.label}: ${h.state}${h.reason ? `, ${h.reason}` : ""}`;

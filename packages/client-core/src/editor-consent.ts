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

/** What a person is asked about: a button's operation, or an Update that closes the editor. */
export type AskKind = ConsentOp | "update";

const LEAD: Record<AskKind, string> = {
  stop: "Stopping the editor now interrupts those sessions' work in it.",
  restart: "Restarting the editor now interrupts those sessions' work in it.",
  rebuild: "Rebuilding now closes the editor and interrupts those sessions' work in it.",
  update: "Updating now closes the editor and interrupts those sessions' work in it.",
};

const VERB: Record<AskKind, string> = { stop: "Stop", restart: "Restart", rebuild: "Rebuild", update: "Update" };

/** The words of the ask, the same on every client. */
export function consentCopy(op: AskKind): { title: string; lead: string; approve: string; cancel: string } {
  return { title: "Other sessions are using the editor", lead: LEAD[op], approve: `${VERB[op]} anyway`, cancel: "Cancel" };
}

// ── Requests waiting for a person ─────────────────────────────────

/** The daemon feature (GET /v1/health) that says it has the gate and its routes. */
export const CONSENT_FEATURE = "editor.consent";

/** A request still being decided, which a person can approve or deny. */
export const isOpenRequest = (r: EditorDisruptionRequest): boolean => r.state === "pending" || r.state === "confirm" || r.state === "blocked";

/**
 * A request that belongs on the pending list: open, and not one the person in
 * Studio made, since the button or Update that made it is already asking them.
 */
export const isPendingForPerson = (r: EditorDisruptionRequest): boolean => isOpenRequest(r) && r.requester.label !== STUDIO_REQUESTER;

/** The requests GET /v1/disruptions lists, or none when the body is anything else. */
export function requestsOf(body: unknown): EditorDisruptionRequest[] {
  const list = isObj(body) && Array.isArray(body.requests) ? body.requests : [];
  return list.filter(isRequest);
}

/**
 * The pending list after one event from the daemon's stream: a request opened
 * or changed is put in (or replaced), one decided is taken out. Any other
 * event leaves the list as it was, and returns the same array.
 */
export function applyDisruptionEvent(list: EditorDisruptionRequest[], event: { type: string; data?: unknown }): EditorDisruptionRequest[] {
  if (event.type !== "disruption.requested" && event.type !== "disruption.updated") return list;
  if (!isRequest(event.data)) return list;
  const r = event.data;
  const rest = list.filter((x) => x.id !== r.id);
  return isPendingForPerson(r) ? [...rest, r] : rest.length === list.length ? list : rest;
}

const OP_PHRASE: Record<EditorDisruptionRequest["op"], string> = {
  stop: "stop the editor",
  restart: "restart the editor",
  rebuild: "rebuild the editor",
  build: "build the project while the editor is open",
  live_coding: "patch the running editor with Live Coding",
};

/** "Claude Code asks to rebuild the editor". */
export const requestTitle = (r: EditorDisruptionRequest): string => `${r.requester.label || r.requester.id} asks to ${OP_PHRASE[r.op] ?? r.op}`;

const ANSWER: Record<EditorDisruptionAnswer["answer"], string> = { go: "Agreed", ...STATE };

/** One session's answer to a request, every answer including those that agreed. */
export interface AnswerLine {
  session: string;
  label: string;
  state: string;
  reason: string;
  tone: "ok" | "warn" | "bad";
}

/** Every session's answer, blocks first, then waits, then those that agreed. */
export function answerLines(r: EditorDisruptionRequest): AnswerLine[] {
  const rank = (a: EditorDisruptionAnswer["answer"]) => (a === "block" ? 0 : a === "go" ? 2 : 1);
  return [...r.answers]
    .filter((a) => a.answer in ANSWER)
    .sort((a, b) => rank(a.answer) - rank(b.answer))
    .map((a) => ({ session: a.session, label: a.label || a.session, state: ANSWER[a.answer], reason: a.reason, tone: a.answer === "go" ? "ok" : a.answer === "block" ? "bad" : "warn" }));
}

/** The words of the pending list, the same on every client. */
export const PENDING_COPY = { approve: "Approve", deny: "Deny", region: "Editor requests needing your answer", notSent: "Your answer was not sent. Try again." };

/** One holder as a single line: "Claude Code: Waiting, busy (blueprint.add_variable)". */
export const holderLine = (h: ConsentHolder): string => `${h.label}: ${h.state}${h.reason ? `, ${h.reason}` : ""}`;

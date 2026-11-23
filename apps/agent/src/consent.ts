/**
 * Studio's agent in ue-mcp's editor consent ledger (ue-mcp feature
 * "editor.consent", db-lyon/ue-mcp#2075).
 *
 * Stopping, restarting, rebuilding, building under or Live Coding patching a
 * shared editor takes every other session's editor state away, so ue-mcp asks
 * every active session first. Studio drives its own agent, so it takes part
 * through the daemon's ledger routes rather than as an MCP connection:
 *
 * - Each conversation is a participant (`studio:<session id>`), and reports
 *   what it is busy with from its run state: its reply, and each subagent it
 *   is running. An idle conversation reports nothing and is let go after a while.
 * - A disruptive call is gated before it runs (the durable runtime's
 *   beforeTool hook, `gateCall`): the conversation's own reply and the calling
 *   subagent are taken off its busy list, its other running subagents stay on
 *   it, and the request is opened with an accurate `subagents` attestation.
 * - A request from another session is steered into a running conversation
 *   (`steerText`), which answers it with editor(disruption_vote). Its answer
 *   "go after my subagents stop" (`go_after_subagents`) is a wait vote plus a
 *   hold, released by a durable wait once those subagents end.
 *
 * Everything here is optional: on a daemon without the feature none of it runs,
 * and ue-mcp's own gate still answers every disruptive call it dispatches.
 */

/** The daemon feature that advertises the ledger, and the extension feature that attributes calls to a session. */
export const CONSENT_FEATURE = "editor.consent";
export const SESSION_FEATURE = "callAction.session";

export type DisruptiveOp = "stop" | "restart" | "rebuild" | "build" | "live_coding";

export interface DisruptiveCall {
  op: DisruptiveOp;
  /** Disruptive only while an editor of the project runs (a build). */
  whileRunning?: boolean;
  /** Why, when the call says. */
  reason?: string;
}

/** A request as the daemon serves it (ue-mcp's EditorDisruptionRequest), restated so Studio builds against the ue-mcp it pins. */
export interface DisruptionView {
  id: string;
  op: DisruptiveOp;
  action: string;
  requester: { id: string; label: string; parent?: string };
  reason?: string;
  state: "pending" | "confirm" | "blocked" | "approved" | "done" | "denied" | "expired";
  createdAt: string;
  expiresAt: string;
  answers: Array<{ session: string; label: string; parent?: string; answer: "go" | "wait_until_released" | "block" | "unanswered"; reason: string; auto: boolean; touched?: string[] }>;
  self: { attestationRequired: boolean; attested: "none" | "paused" | null; inflight: string[] };
  override?: { decision: "approve" | "deny"; by: string; at: string };
}

/** A subagent of a conversation, as its run state or the harness's task graph lists it. */
export interface SubagentRef {
  callId: string;
  description: string;
}

/** Studio's own answer to a request: wait until this conversation's running subagents end, then go. */
export const GO_AFTER_SUBAGENTS = "go_after_subagents";

/** The participant id a conversation reports under. */
export const participantId = (sessionId: string): string => `studio:${sessionId}`;

/** How a conversation is named to the other sessions. */
export function participantLabel(title: string | undefined): string {
  const t = (title ?? "").replace(/\s+/g, " ").trim();
  return t ? `Studio: ${t.length > 60 ? `${t.slice(0, 59)}…` : t}` : "Studio";
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A console command that closes the editor, as ue-mcp reads one. */
const isQuitCommand = (command: unknown): boolean => typeof command === "string" && /^\s*(quit|exit|quit_editor)\b/i.test(command);

/** The operation `category.method` performs, as ue-mcp's dispatch gate classifies it. */
function opOfTask(task: string, params: Record<string, unknown>): DisruptiveCall | null {
  switch (task) {
    case "editor.stop_editor":
    case "editor.request_editor_shutdown":
      return { op: "stop" };
    case "editor.restart_editor":
      return { op: "restart" };
    case "editor.build_project":
    case "project.build":
      return { op: "build", whileRunning: true };
    case "editor.hot_reload":
    case "project.live_coding_compile":
      return { op: "live_coding" };
    case "editor.execute_command":
      return isQuitCommand(params.command) ? { op: "stop" } : null;
    default:
      return null;
  }
}

/**
 * A Studio tool call as the ue-mcp call it makes: `ue_mcp` (Micro), or a
 * projected category tool (`editor`, `project`) with its method in `action`
 * and its parameters flat or in `args`. Null for anything else.
 */
export function ueMcpCallOf(name: string, input: Record<string, unknown>): { category: string; method: string; params: Record<string, unknown> } | null {
  if (name === "ue_mcp") {
    if (input.action !== "call" || typeof input.category !== "string" || typeof input.method !== "string") return null;
    return { category: input.category, method: input.method, params: isObj(input.args) ? input.args : {} };
  }
  if ((name === "editor" || name === "project") && typeof input.action === "string") {
    const { action, args, ...rest } = input;
    return { category: name, method: action as string, params: isObj(args) ? { ...args, ...rest } : rest };
  }
  return null;
}

/** The disruptive operation a Studio tool call would perform, or null. */
export function disruptiveCallOf(name: string, input: Record<string, unknown>): DisruptiveCall | null {
  if (name === "editor_restart") {
    const op = input.operation === "rebuild" ? "rebuild" : input.operation === "restart" ? "restart" : null;
    return op ? { op, ...(typeof input.reason === "string" && input.reason ? { reason: input.reason } : {}) } : null;
  }
  const call = ueMcpCallOf(name, input);
  return call ? opOfTask(`${call.category}.${call.method}`, call.params) : null;
}

/** A vote the call casts on a request (editor(disruption_vote)), or null. */
export function voteCallOf(name: string, input: Record<string, unknown>): { requestId: string; vote: string; reason: string } | null {
  const call = ueMcpCallOf(name, input);
  if (!call || call.category !== "editor" || call.method !== "disruption_vote") return null;
  const { requestId, vote, reason } = call.params;
  if (typeof requestId !== "string" || typeof vote !== "string") return null;
  return { requestId, vote, reason: typeof reason === "string" ? reason : "" };
}

/** The same ue-mcp call with these parameters set, in the shape the model sent it. */
export function withParams(name: string, input: Record<string, unknown>, params: Record<string, unknown>): Record<string, unknown> {
  if (name === "ue_mcp") return { ...input, args: { ...(isObj(input.args) ? input.args : {}), ...params } };
  if (isObj(input.args)) return { ...input, args: { ...input.args, ...params } };
  return { ...input, ...params };
}

/** The same vote call with another vote and reason. */
export const withVote = (name: string, input: Record<string, unknown>, vote: string, reason: string): Record<string, unknown> => withParams(name, input, { vote, reason });

/** Whether a call goes through the consent gate at all: cheap, so the harness asks the daemon only for these. */
export const needsConsent = (name: string, input: Record<string, unknown>): boolean => disruptiveCallOf(name, input) !== null || voteCallOf(name, input) !== null;

const OP_WORDS: Record<DisruptiveOp, string> = {
  stop: "stop the editor",
  restart: "restart the editor",
  rebuild: "rebuild the editor (stop it, build, start it again)",
  build: "build the project's C++ while the editor runs",
  live_coding: "patch the running editor with Live Coding",
};

const ANSWER_WORDS: Record<DisruptionView["answers"][number]["answer"], string> = {
  go: "go",
  wait_until_released: "wait",
  block: "block",
  unanswered: "no answer yet",
};

const quoteList = (subs: readonly SubagentRef[]): string => subs.map((s) => `"${s.description}" (${s.callId})`).join(", ");

/** What the model is told when its disruptive call is not run (yet). */
export function refusalText(view: DisruptionView, subagents: readonly SubagentRef[]): string {
  const what = `request ${view.id} to ${OP_WORDS[view.op]}`;
  const others = view.answers.filter((a) => a.answer !== "go");
  const lines: string[] = [];
  if (subagents.length > 0) {
    lines.push(
      `Not run yet: your own subagents are still running (${quoteList(subagents)}), and ${what} waits for them.`,
      "Wait for them to finish, or stop the ones using the editor with agent_stop, then make this call again.",
    );
  } else if (view.state === "blocked") lines.push(`Not run: another session blocked ${what}.`);
  else if (view.state === "denied") lines.push(`Not run: a person denied ${what}.`);
  else lines.push(`Not run yet: ${what} is waiting on the other sessions using this editor.`);
  if (others.length > 0) {
    lines.push("Their answers:");
    for (const a of others) lines.push(`- '${a.label}': ${ANSWER_WORDS[a.answer]}, ${a.reason}`);
  }
  if (view.state === "denied") {
    lines.push("Tell the user. Making the call again later opens a new request.");
  } else {
    lines.push(
      "Tell the user who is holding it and why. Only they can override it, with `ue-mcp editor approve " + view.id + "`. "
        + `Making the same call again checks the same request; it expires at ${view.expiresAt}.`,
    );
  }
  return lines.join("\n");
}

/** What a running conversation is told about another session's request, steered into its reply. */
export function steerText(view: DisruptionView, subagents: readonly SubagentRef[]): string {
  const reason = view.reason ? `: "${view.reason}"` : "";
  const lines = [
    `[Studio] Editor disruption request ${view.id}: '${view.requester.label}' asks to ${OP_WORDS[view.op]}${reason}. `
      + "That ends every session's editor state, PIE session and unsaved work in this editor.",
    `Save what you need first, then answer with ue_mcp call editor.disruption_vote { requestId: "${view.id}", vote, reason }: `
      + "go lets it run, wait_until_released holds it until you call editor.release, block refuses it.",
  ];
  if (subagents.length > 0) {
    lines.push(`Your subagents ${quoteList(subagents)} are still running: vote ${GO_AFTER_SUBAGENTS} to let it run once they finish. Studio holds the editor until then.`);
  }
  return lines.join("\n");
}

// ── The daemon's ledger routes ─────────────────────────────────────

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;

export class LedgerError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "LedgerError";
  }
}

/** The ledger routes of the daemon this extension runs in, over its own HTTP API. */
export class ConsentLedger {
  constructor(
    private readonly endpoint: () => { port: number; token: string } | null,
    private readonly fetchFn: Fetch = fetch as unknown as Fetch,
  ) {}

  private async send<T>(method: string, path: string, body?: unknown, opts: { timeoutMs?: number; accept?: number[] } = {}): Promise<T> {
    const at = this.endpoint();
    if (!at) throw new LedgerError(0, "the daemon's address is not published");
    const res = await this.fetchFn(`http://127.0.0.1:${at.port}${path}`, {
      method,
      headers: { authorization: `Bearer ${at.token}`, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if ((res.status < 200 || res.status >= 300) && !opts.accept?.includes(res.status)) {
      throw new LedgerError(res.status, typeof parsed.error === "string" ? parsed.error : `${method} ${path} answered ${res.status}`);
    }
    return parsed as T;
  }

  /** A person's request to stop, restart or rebuild (Studio's Update), opened or re-read without running anything. */
  ask(op: DisruptiveOp, requester: string, reason?: string): Promise<DisruptionView> {
    return this.send("POST", "/v1/disruptions", { op, requester, ...(reason ? { reason } : {}) });
  }

  /**
   * A person's editor operation through the daemon's HTTP route, which takes
   * the override (`force`) and an approved `requestId` that the extension API
   * does not. A 409 is answered like a result: its first step is "consent" and
   * it carries the request. A rebuild can take as long as the project's build.
   */
  editorOperation(op: "stop" | "restart" | "rebuild", body: { requester: string; reason?: string; force?: boolean; requestId?: string }): Promise<Record<string, unknown>> {
    return this.send("POST", `/v1/editor/${op}`, body, { timeoutMs: 3_600_000, accept: [409] });
  }

  report(id: string, state: { label: string; busy: string[]; parent?: string }): Promise<unknown> {
    return this.send("PUT", `/v1/disruptions/participants/${encodeURIComponent(id)}`, state);
  }

  remove(id: string): Promise<unknown> {
    return this.send("DELETE", `/v1/disruptions/participants/${encodeURIComponent(id)}`);
  }

  request(participant: string, op: DisruptiveOp, opts: { reason?: string; subagents?: "none" | "paused" } = {}): Promise<DisruptionView> {
    return this.send("POST", "/v1/disruptions", { participant, op, ...opts });
  }

  vote(requestId: string, participant: string, vote: "go" | "wait_until_released" | "block", reason: string): Promise<DisruptionView> {
    return this.send("POST", `/v1/disruptions/${encodeURIComponent(requestId)}/vote`, { participant, vote, reason });
  }

  hold(participant: string, reason: string, ttlSeconds?: number): Promise<unknown> {
    return this.send("POST", `/v1/disruptions/participants/${encodeURIComponent(participant)}/hold`, { reason, ...(ttlSeconds ? { ttlSeconds } : {}) });
  }

  release(participant: string): Promise<unknown> {
    return this.send("POST", `/v1/disruptions/participants/${encodeURIComponent(participant)}/release`);
  }
}

// ── Participants ───────────────────────────────────────────────────

/** A conversation's run state, as the runner knows it. */
export interface RunState {
  title: string;
  /** Its main agent is replying. */
  replying: boolean;
  /** Its subagents still running, in the background ones too. */
  subagents: SubagentRef[];
}

/** How often participants' state is compared with what was reported. */
const SYNC_MS = 2000;
/** An idle participant is removed after this long: an idle one answers go anyway. */
const FORGET_IDLE_MS = 10 * 60_000;
/** A gated call that never ran stops being exempt after this long. */
const EXEMPT_MS = 10 * 60_000;

/** What a conversation's main reply is called on its busy list. */
export const REPLY_BUSY = "a Studio reply";
export const subagentBusy = (s: SubagentRef): string => `subagent "${s.description}"`;

interface Exemption {
  /** The subagent making the call, or null for the main agent. */
  parent: string | null;
  /** The running subagents the harness's task graph listed when the call was gated, which stand for the run state's while it runs. */
  subagents?: SubagentRef[];
  until: number;
}

/**
 * Every conversation as a participant: registered once it is busy, its busy
 * list reported whenever it changes, and removed once it has been idle a
 * while. A disruptive call in flight exempts its own caller (the main reply,
 * or the subagent making it), so a conversation's own request waits only on
 * its other subagents.
 */
export class ConsentParticipants {
  private readonly sent = new Map<string, { key: string; idleSince: number | null }>();
  private readonly exempt = new Map<string, Map<string, Exemption>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private syncing: Promise<void> | null = null;

  constructor(
    private readonly o: {
      ledger: ConsentLedger;
      /** A conversation's run state; null for one that is gone. */
      state(sessionId: string): RunState | null;
      /** The conversations to look at: every one with work, and every one reported. */
      sessions(): string[];
      now?: () => number;
      log?: (message: string) => void;
    },
  ) {}

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.syncAll(), SYNC_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private exemptions(sessionId: string): Exemption[] {
    const m = this.exempt.get(sessionId);
    if (!m) return [];
    const t = this.now();
    for (const [k, e] of m) if (e.until <= t) m.delete(k);
    return [...m.values()];
  }

  /** The running subagents that count against a request of this conversation: all of them but the callers exempt now. */
  subagentsOf(sessionId: string): SubagentRef[] {
    const ex = this.exemptions(sessionId);
    const listed = ex.find((e) => e.subagents)?.subagents ?? this.o.state(sessionId)?.subagents ?? [];
    const callers = new Set(ex.map((e) => e.parent).filter((p): p is string => !!p));
    return listed.filter((s) => !callers.has(s.callId));
  }

  /** What a conversation reports: its reply unless a call of the main agent is exempt, and its subagents but exempt callers. */
  busyOf(sessionId: string): string[] {
    const st = this.o.state(sessionId);
    if (!st) return [];
    const ex = this.exemptions(sessionId);
    const busy: string[] = [];
    // A call in flight for the conversation exempts its reply: a subagent's call is made while the main agent waits on it.
    if (st.replying && ex.length === 0) busy.push(REPLY_BUSY);
    for (const s of this.subagentsOf(sessionId)) busy.push(subagentBusy(s));
    return busy;
  }

  /** The attestation a request of this conversation carries: none, when no other subagent of its runs. */
  attestation(sessionId: string): "none" | undefined {
    return this.subagentsOf(sessionId).length === 0 ? "none" : undefined;
  }

  /** A disruptive call `callId` is being made: its caller stops counting against it until `end`. */
  begin(sessionId: string, callId: string, parent: string | null, subagents?: SubagentRef[]): void {
    let m = this.exempt.get(sessionId);
    if (!m) this.exempt.set(sessionId, (m = new Map()));
    const had = m.get(callId);
    m.set(callId, { parent, ...(subagents ?? had?.subagents ? { subagents: subagents ?? had!.subagents } : {}), until: this.now() + EXEMPT_MS });
  }

  end(sessionId: string, callId: string): void {
    const m = this.exempt.get(sessionId);
    if (!m?.delete(callId)) return;
    if (m.size === 0) this.exempt.delete(sessionId);
    void this.sync(sessionId);
  }

  /** Report one conversation now, when its state changed since it was last reported. `register`: report it even when idle, so it is known by its name. */
  async sync(sessionId: string, register = false): Promise<void> {
    const st = this.o.state(sessionId);
    const id = participantId(sessionId);
    const prev = this.sent.get(sessionId);
    if (!st) {
      if (prev) {
        this.sent.delete(sessionId);
        await this.o.ledger.remove(id).catch(() => undefined);
      }
      return;
    }
    const busy = this.busyOf(sessionId);
    const label = participantLabel(st.title);
    const key = JSON.stringify([label, busy]);
    if (!prev && busy.length === 0 && !register) return;
    if (prev && busy.length === 0 && !register && prev.idleSince !== null && this.now() - prev.idleSince >= FORGET_IDLE_MS) {
      this.sent.delete(sessionId);
      await this.o.ledger.remove(id).catch(() => undefined);
      return;
    }
    if (prev?.key === key) return;
    this.sent.set(sessionId, { key, idleSince: busy.length === 0 ? this.now() : null });
    try {
      await this.o.ledger.report(id, { label, busy });
    } catch (e) {
      // Reported again on the next change; an old daemon without the routes never gets here.
      this.sent.delete(sessionId);
      this.o.log?.(`could not report ${id} to the editor consent ledger: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Report every conversation whose state changed. One pass at a time. */
  syncAll(): Promise<void> {
    if (this.syncing) return this.syncing;
    const ids = new Set([...this.o.sessions(), ...this.sent.keys()]);
    this.syncing = (async () => {
      for (const id of ids) await this.sync(id);
    })().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  /** Whether a conversation is reported now. */
  reported(sessionId: string): boolean {
    return this.sent.has(sessionId);
  }
}

// ── The gate ───────────────────────────────────────────────────────

/**
 * The gate's answer to one call: it may run (with its arguments replaced,
 * and the subagents to wait for before a hold is released), or it is not
 * run, with the text the model is given.
 */
export type ConsentGate =
  | { allow: true; arguments?: Record<string, unknown>; waitFor?: string[] }
  | { allow: false; text: string };

/** How long a hold waiting on subagents is taken for: the durable wait releases it sooner. */
const SUBAGENT_HOLD_SECONDS = 6 * 60 * 60;

export interface GateDeps {
  ledger: ConsentLedger;
  participants: ConsentParticipants;
  /** Whether an editor of the project runs now. */
  editorRunning(): boolean;
}

export interface GateCall {
  sessionId: string;
  callId: string;
  /** The subagent making the call, or null for the main agent. */
  parent: string | null;
  name: string;
  input: Record<string, unknown>;
  /** The conversation's running subagents, from the harness's task graph; the run state's when absent. */
  subagents?: SubagentRef[];
  /** The caller can wait durably for subagents to end and release a hold then. */
  canWait: boolean;
}

/**
 * Whether one call may run now. A disruptive call opens (or re-reads) the
 * conversation's request, with its caller exempt and its other running
 * subagents still counted; it runs once the request is approved, and the
 * exemption lasts until the call ends (`participants.end`). A vote of go while
 * the conversation's own subagents run, or go_after_subagents, becomes a wait
 * vote and a hold that a durable wait releases when they end.
 *
 * Any failure to reach the ledger lets the call go on: ue-mcp's own gate still
 * answers it.
 */
export async function gateCall(d: GateDeps, c: GateCall): Promise<ConsentGate> {
  const pid = participantId(c.sessionId);
  const others = (c.subagents ?? d.participants.subagentsOf(c.sessionId)).filter((s) => s.callId !== c.parent);
  const vote = voteCallOf(c.name, c.input);
  if (vote) {
    const later = vote.vote === GO_AFTER_SUBAGENTS || vote.vote === "go";
    if (!later) return { allow: true };
    if (others.length === 0) return vote.vote === "go" ? { allow: true } : { allow: true, arguments: withVote(c.name, c.input, "go", vote.reason) };
    if (!c.canWait) {
      return { allow: false, text: `Your subagents ${quoteList(others)} are still running, so go would let the editor stop under them. Vote wait_until_released and call editor.release once they have finished, or stop them first.` };
    }
    const why = `once its subagents finish (${others.map((s) => s.description).join(", ")})`;
    try {
      await d.ledger.hold(pid, `waiting for its subagents to finish: ${others.map((s) => s.description).join(", ")}`, SUBAGENT_HOLD_SECONDS);
    } catch {
      return { allow: false, text: `Studio could not hold the editor for your subagents, so it did not vote go. Vote wait_until_released and call editor.release once they have finished.` };
    }
    return {
      allow: true,
      arguments: withVote(c.name, c.input, "wait_until_released", vote.reason ? `${vote.reason} (it goes ${why})` : `it goes ${why}`),
      waitFor: others.map((s) => s.callId),
    };
  }
  const call = disruptiveCallOf(c.name, c.input);
  if (!call) return { allow: true };
  if (call.whileRunning && !d.editorRunning()) return { allow: true };
  d.participants.begin(c.sessionId, c.callId, c.parent, c.subagents?.filter((s) => s.callId !== c.parent));
  let view: DisruptionView;
  try {
    await d.participants.sync(c.sessionId, true);
    view = await d.ledger.request(pid, call.op, {
      ...(call.reason ? { reason: call.reason } : {}),
      ...(others.length === 0 ? { subagents: "none" as const } : {}),
    });
  } catch {
    return { allow: true };
  }
  if (view.state === "approved") return { allow: true };
  d.participants.end(c.sessionId, c.callId);
  return { allow: false, text: refusalText(view, others) };
}

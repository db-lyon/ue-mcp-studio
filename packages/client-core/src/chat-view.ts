/**
 * What the chat view says and decides that is not drawing: the session list's
 * lines, which pane a narrow chat shows, the context meter's words, attachment
 * sizes, and a session's live playtest runs. The web client and the app draw
 * these the same way.
 */
import type { ContextUsage, ContextView, QaRun, SessionSummary, TranscriptEntry } from "@ue-mcp-studio/shared";
import { tokenCount } from "./chat-model.js";

const STATUS_LABEL: Record<string, string> = {
  idle: "",
  running: "Working",
  waiting: "Waiting for editor",
  stopped: "Stopped",
  error: "Stopped on an error",
};

/**
 * The state the session list shows: a call waiting for approval, from the main
 * agent or any subagent, puts the session on the user whatever its turn is
 * doing, since a subagent the user assigned runs while the session is idle (#149).
 */
export const listState = (s: Pick<SessionSummary, "status" | "awaiting">): string => (s.awaiting ? "needs-you" : s.status);

/** The empty chat's line under Start a session. */
export const CHAT_INTRO = "Builds Blueprints, materials, levels, Niagara and more through ue-mcp. Also runs commands, edits files and reads the web. Approvals in Settings set what it asks first.";
/** The session list while the daemon has not answered for a while. */
export const SESSIONS_SLOW = "Studio is not answering yet. Your sessions are safe.";
/** The Queue button's tooltip or hint. */
export const QUEUE_HINT = "Send when the turn ends";

/** The line under a session's title: what it is doing, its running subagents, or when it last changed. */
export function sessionLine(s: SessionSummary): string {
  const status = s.awaiting
    ? s.awaiting === 1 ? "Waiting on your approval" : `Waiting on your approval of ${s.awaiting} calls`
    : STATUS_LABEL[s.status] ?? "";
  const n = s.agents?.running ?? 0;
  const agents = n ? `${n} ${n === 1 ? "subagent" : "subagents"} running` : "";
  const line = [status, agents].filter(Boolean).join(", ") || new Date(s.updatedAt).toLocaleString();
  // The model of its last turn, and how it was reached.
  const where = s.model ? `${s.model}${s.route ? ` via ${s.route}` : ""}` : "";
  return [where, line].filter(Boolean).join(". ");
}

/**
 * Which half of the chat a narrow panel shows: the session list and the
 * conversation take turns at the full width. An open session shows the
 * conversation; so does a project with no sessions yet, whose empty
 * conversation is where one starts. Otherwise the list.
 */
export type ChatPane = "list" | "conversation";

export function chatPane(selected: string | null, listed: boolean, sessions: number): ChatPane {
  if (selected) return "conversation";
  if (listed && sessions === 0) return "conversation";
  return "list";
}

/** A fraction as a whole percentage. */
export const pct = (f: number): string => `${Math.round(f * 100)}%`;

/** A dollar amount: cents under ten dollars, whole dollars past it. */
export function dollars(n: number): string {
  if (n > 0 && n < 0.01) return "under $0.01";
  return n < 100 ? `$${n.toFixed(2)}` : `$${Math.round(n).toLocaleString("en-US")}`;
}

/** Where the runtime or Studio compacts, in words. */
export function compactLine(view: ContextView, runtime: boolean): string {
  const at = tokenCount(Math.round(view.window * view.compactAt));
  if (view.fraction >= view.compactAt) {
    return runtime
      ? `It is past where Claude's runtime compacts (${at}): it compacts at the start of the next turn.`
      : `It is past where Studio compacts (${at}): Studio compacts it before the next request goes.`;
  }
  return runtime
    ? `Claude's runtime compacts this session on its own at about ${at} tokens (${pct(view.compactAt)}).`
    : `Studio compacts it on its own at ${at} tokens (${pct(view.compactAt)}).`;
}

/** The context meter's name for a screen reader. */
export function contextLabel(view: ContextView | null, owner?: string, compacting = false): string {
  return view
    ? `${owner ? `${owner} agent's context` : "Context"} ${pct(view.fraction)} full: ${tokenCount(view.used)} of ${tokenCount(view.window)} tokens${view.estimated ? ", estimated" : ""}${compacting ? ", compacting" : ""}`
    : "Context not measured yet";
}

/** The meter's numeral beside the ring. */
export const contextPct = (view: ContextView | null): string => (view ? `${view.estimated ? "~" : ""}${pct(view.fraction)}` : "ctx");

/** The hover card's lines: tokens of the window, the model it was measured on, where it compacts. */
export function tipLines(view: ContextView, context: ContextUsage | undefined, opts: { nameOf: (id: string) => string; modelName: string; runtime: boolean; compacting: boolean; owner?: string }): string[] {
  const lines: string[] = [];
  if (opts.owner) lines.push(`${opts.owner} agent's context`);
  lines.push(`${view.estimated ? "About " : ""}${tokenCount(view.used)} of ${tokenCount(view.window)} tokens${view.estimated ? ", estimated" : ""}`);
  const on = view.measuredOn ?? (context?.model || null);
  if (view.estimated && !on) lines.push("Estimated from the conversation's text");
  else if (on) lines.push(view.measuredOn ? `Measured on ${opts.nameOf(on)}, next turn on ${opts.modelName}` : `Measured on ${opts.nameOf(on)}`);
  const at = tokenCount(Math.round(view.window * view.compactAt));
  const who = opts.runtime ? "Claude's runtime compacts" : "Studio compacts";
  if (opts.compacting) lines.push("Compacting now");
  else if (view.fraction >= 1) lines.push(`Over the window: ${opts.runtime ? "the runtime compacts it next turn" : "Studio compacts it before the next request"}`);
  else if (view.fraction >= view.compactAt) lines.push(`Past where it compacts (${at}): ${opts.runtime ? "compacts next turn" : "compacts before the next request"}`);
  else lines.push(`${who} at ${opts.runtime ? "about " : ""}${at} (${pct(view.compactAt)})`);
  return lines;
}

/**
 * The context ring's geometry in a 16 unit box: a circle of radius 6 whose
 * fill is a dash from the top, clockwise (a sliver once anything is
 * measured), and a tick from radius 4 to 8 where it compacts.
 */
export function contextRing(view: ContextView): { r: number; circumference: number; dash: number; tick: { x1: number; y1: number; x2: number; y2: number } } {
  const r = 6;
  const circumference = 2 * Math.PI * r;
  const f = Math.min(1, Math.max(0, view.fraction));
  const dash = view.used > 0 ? Math.max(f * circumference, 0.6) : 0;
  const a = view.compactAt * 2 * Math.PI;
  const tx = (rad: number) => 8 + rad * Math.sin(a);
  const ty = (rad: number) => 8 - rad * Math.cos(a);
  return { r, circumference, dash, tick: { x1: tx(4), y1: ty(4), x2: tx(8), y2: ty(8) } };
}

/** The context warning's sentence, beside its Compact now button. */
export function contextWarningText(view: ContextView, runtime: boolean): string {
  return view.fraction >= 1
    ? `Context is over the window (${tokenCount(view.used)} of ${tokenCount(view.window)}). It compacts ${runtime ? "next turn" : "before the next request"}.`
    : `Context is ${pct(view.fraction)} full. It compacts at ${pct(view.compactAt)}.`;
}

// attachmentUrl, isImage, formatBytes and MAX_BYTES are in composer.ts.


/** The newer of two views of a run: the higher seq, and the server's on a tie. */
export function newerRun(server: QaRun, local: QaRun): QaRun {
  if (server.runId !== local.runId) return server;
  if (server.lastSeq >= local.lastSeq) return server;
  // The steps from the newer events, the subagent as the agent last saved it.
  return server.assignment ? { ...local, assignment: server.assignment } : local;
}

/** The session's runs as they are now: its transcript's, with every studio.qa.changed since the transcript was read. */
export interface SessionRuns {
  runs: QaRun[];
  /** A run id the transcript may still hold (a draft's, before its run took the card) to the run that holds it now. */
  alias: ReadonlyMap<string, string>;
}

/**
 * The runs of a session from its transcript and the studio.qa.changed events after `after` (the last event id the transcript already holds).
 * `live`: the daemon's live runs (SessionDetail.liveRuns), so a run whose card is before the page a client holds is still pinned.
 */
export function sessionRunsOf(sessionId: string | null, transcript: TranscriptEntry[] | undefined, events: ReadonlyArray<{ id: number; type: string; data: Record<string, unknown> }>, after: number, live: readonly QaRun[] = []): SessionRuns {
  const byId = new Map<string, QaRun>();
  const alias = new Map<string, string>();
  for (const r of live) byId.set(r.runId, r);
  for (const t of transcript ?? []) if (t.kind === "qa") byId.set(t.run.runId, t.run);
  for (const e of events) {
    if (e.id <= after || e.type !== "studio.qa.changed") continue;
    const run = e.data.run as QaRun | undefined;
    if (!run?.runId) continue;
    const replaces = typeof e.data.replaces === "string" ? e.data.replaces : null;
    if (replaces && byId.has(replaces)) {
      byId.delete(replaces);
      alias.set(replaces, run.runId);
      byId.set(run.runId, run);
    } else if (byId.has(run.runId)) {
      byId.set(run.runId, newerRun(run, byId.get(run.runId)!));
    } else if (sessionId && run.sessionId === sessionId) {
      byId.set(run.runId, run);
    }
  }
  // An alias chain (draft, manual run, full run) resolves to the run at its end.
  for (const [from, to] of alias) {
    let end = to;
    for (let i = 0; i < 8 && alias.has(end); i++) end = alias.get(end)!;
    alias.set(from, end);
  }
  return { runs: [...byId.values()], alias };
}

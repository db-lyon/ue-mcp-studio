/**
 * What the chat view says and decides that is not drawing: the session list's
 * lines, which pane a narrow chat shows, the context meter's words, attachment
 * sizes, and a session's live playtest runs. The web client and the app draw
 * these the same way.
 */
import type { ContextView, QaRun, SessionSummary, TranscriptEntry } from "@ue-mcp-studio/shared";
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

/** The line under a session's title: what it is doing, its subagents, or when it last changed. */
export function sessionLine(s: SessionSummary): string {
  const status = s.awaiting
    ? s.awaiting === 1 ? "Waiting on your approval" : `Waiting on your approval of ${s.awaiting} calls`
    : STATUS_LABEL[s.status] ?? "";
  const agents = s.agents?.running ? `${s.agents.running} of ${s.agents.total} subagents running` : "";
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

/** The context meter's name for a screen reader and its tooltip. */
export function contextLabel(view: ContextView | null, owner?: string): string {
  return view
    ? `${owner ? `${owner} agent's context` : "Context"} ${pct(view.fraction)} full: ${tokenCount(view.used)} of ${tokenCount(view.window)} tokens${view.estimated ? ", estimated" : ""}`
    : "Context not measured yet";
}

/** The context warning's sentence. */
export function contextWarningText(view: ContextView, runtime: boolean): string {
  return view.fraction >= 1
    ? `Context is past this model's window: ${tokenCount(view.used)} of ${tokenCount(view.window)}. ${runtime ? "Claude's runtime compacts it" : "Studio compacts it before the next request"}, or compact now.`
    : `Context is ${pct(view.fraction)} full. ${runtime ? "Claude's runtime" : "Studio"} compacts it at ${pct(view.compactAt)}; compact now to choose the moment.`;
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

/** The runs of a session from its transcript and the studio.qa.changed events after `after` (the last event id the transcript already holds). */
export function sessionRunsOf(sessionId: string | null, transcript: TranscriptEntry[] | undefined, events: ReadonlyArray<{ id: number; type: string; data: Record<string, unknown> }>, after: number): SessionRuns {
  const byId = new Map<string, QaRun>();
  const alias = new Map<string, string>();
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

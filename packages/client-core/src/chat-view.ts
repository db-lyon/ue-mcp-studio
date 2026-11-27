/**
 * What the chat view says and decides that is not drawing: the session list's
 * lines, which pane a narrow chat shows, the context meter's words, attachment
 * sizes. The web client and the app draw these the same way.
 */
import type { ContextUsage, ContextView, SessionSummary } from "@ue-mcp-studio/shared";
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
/** A session that could not be read, in place of its transcript; Try again reads it again. */
export const sessionLoadFailed = (error: string): string => `This session could not be loaded: ${error}`;
export const SESSION_TRY_AGAIN = "Try again";
export const SESSION_TRY_AGAIN_LABEL = "Load the session again";
/**
 * The Queue button's tooltip or hint. On the durable runtime the message goes
 * into the running reply at once; elsewhere, and for a /command, it waits for
 * the turn's end. Either way the turn goes on, which is what the hint says.
 */
export const QUEUE_HINT = "Send without stopping the turn";

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

/** The plan a sign-in route charges, by route. */
const PLAN_OF: Record<string, string> = { chatgpt: "ChatGPT", claude: "Claude", studio: "Studio" };

/**
 * Under the session's cost, on a route a plan pays for (any sign-in): that the
 * plan covers it and what the figure means. Null on a key or an endpoint, where
 * the cost is what is charged.
 */
export function planCoversLine(route: string | null | undefined): string | null {
  const plan = route ? PLAN_OF[route] : undefined;
  return plan ? `Your ${plan} plan covers it; the cost is what the same requests would cost on a key.` : null;
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

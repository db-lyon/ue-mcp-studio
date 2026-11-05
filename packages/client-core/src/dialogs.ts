/**
 * Editor dialogs as a client shows them: the one line the card, the banner and
 * the transcript say about who decides right now, and when the card may be
 * answered.
 */
import type { EditorDialog } from "@ue-mcp-studio/shared";

/** m:ss, for a countdown. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Milliseconds until the card's buttons may be pressed; 0 when they may. */
export function readyIn(d: EditorDialog, now: number): number {
  return d.asking ? Math.max(0, d.asking.since + d.asking.minHumanMs - now) : 0;
}

/** Who is deciding: the user, the agent, or the editor. */
export type Decider = "you" | "agent" | "editor" | "done";

export function decider(d: EditorDialog): Decider {
  if (d.held || d.outcome?.kind === "delegated") return "agent";
  if (d.outcome) return "done";
  if (d.asking) return "you";
  return d.mode === "auto" ? "agent" : "editor";
}

/**
 * The truth about who decides, right now, and what happens next. "Waiting for
 * you" only while nothing else will answer, and then with the deadline when one
 * applies.
 */
export function statusLine(d: EditorDialog, now: number): string {
  if (d.held) return `The agent chose ${d.held.button}, pressing in ${clock(d.held.until - now)} (Override).`;
  const o = d.outcome;
  if (o?.kind === "delegated") {
    return o.by === "policy" ? "Nobody answered in time, so the agent is deciding." : "Handed to the agent. The agent is deciding.";
  }
  if (o) return outcomeLine(d);
  const a = d.asking;
  if (a) {
    if (a.deadline === null) {
      return a.policy.kind === "safe" ? "Waiting for you. It has no Cancel or Keep, so nothing is pressed for you." : "Waiting for you.";
    }
    const left = clock(a.deadline - now);
    return a.policy.kind === "agent" ? `Waiting for you. The agent decides in ${left}.` : `Waiting for you. ${a.safeButton} is pressed in ${left}.`;
  }
  if (d.mode === "auto") return "The agent is deciding.";
  if (d.mode === "defer") return "Waiting for an answer in the editor.";
  return "Not put to Studio yet. Answer it in the editor, or here once Studio asks.";
}

/** Which call met it: "editor(stop_editor)", with the subagent when one did. */
export function whoLine(d: EditorDialog): string | null {
  if (!d.call) return null;
  const [category, action] = d.call.split(".");
  return `${category}(${action})${d.subagent ? ` in subagent ${d.subagent}` : ""}`;
}

/** How it ended; empty while it has not. */
export function outcomeLine(d: EditorDialog): string {
  const o = d.outcome;
  if (!o || o.kind === "delegated") return "";
  if (o.kind === "closed") return "Closed in the editor.";
  if (o.by === "policy") return `Nobody answered in time, so ${o.button} was pressed.`;
  if (o.by === "you") return `You pressed ${o.button}.`;
  return `The agent pressed ${o.button}.`;
}

/**
 * What a running turn shows before it lands in the transcript, besides the
 * streamed answer: the model's thinking so far, and what the running call
 * has printed (a long build or cook). Neither is kept in the transcript; both
 * clients follow it from the event stream through this one reducer.
 */

import { formatDuration } from "./chat-model.js";

export interface LiveParts {
  /** The main agent's thinking so far, while it answers. */
  thinking: string;
  /** When the thinking shown began (ms since the epoch), so a long think shows how long it has run. */
  thinkingSince: number | null;
  /** The running call's output so far, its newest part. */
  output: { callId: string; text: string } | null;
}

export const NO_LIVE: LiveParts = { thinking: "", thinkingSince: null, output: null };

/** The most of a running call's output kept and shown: its newest part. */
export const LIVE_OUTPUT_KEEP = 4000;

export const THINKING_LABEL = "Thinking";
export const LIVE_OUTPUT_LABEL = "Output so far";

/** The thinking block's header: "Thinking", then how long it has run once that reaches a second, "Thinking 3m 12s". */
export function thinkingLabel(since: number | null, now: number): string {
  const secs = since === null ? 0 : Math.floor((now - since) / 1000);
  return secs >= 1 ? `${THINKING_LABEL} ${formatDuration(secs)}` : THINKING_LABEL;
}

/** The newest `max` characters, from the start of a line where one falls inside them. */
export function liveTail(text: string, max = LIVE_OUTPUT_KEEP): string {
  if (text.length <= max) return text;
  const cut = text.slice(-max);
  const nl = cut.indexOf("\n");
  return nl >= 0 && nl < cut.length - 1 ? cut.slice(nl + 1) : cut;
}

/**
 * The live parts after one event of the open session, or null when the event
 * does not touch them. A new transcript line ends the thinking it came from;
 * a finished call ends its output. `at`: when the event was sent (ms), which
 * starts the clock of a new think: one after none was shown, or a reset.
 */
export function applyLive(prev: LiveParts, type: string, data: Record<string, unknown>, at: number = Date.now()): LiveParts | null {
  const text = typeof data.text === "string" ? data.text : "";
  switch (type) {
    case "studio.turn.thinking": {
      const thinking = data.reset ? text : prev.thinking + text;
      const fresh = !!data.reset || !prev.thinking || prev.thinkingSince === null;
      return { ...prev, thinking, thinkingSince: thinking ? (fresh ? at : prev.thinkingSince) : null };
    }
    case "studio.tool.output": {
      const callId = String(data.callId ?? "");
      const before = prev.output && prev.output.callId === callId ? prev.output.text : "";
      return { ...prev, output: { callId, text: liveTail(before + text) } };
    }
    case "studio.transcript.added":
      return prev.thinking ? { ...prev, thinking: "", thinkingSince: null } : null;
    case "studio.tool.finished":
      return prev.output && prev.output.callId === data.toolUseId ? { ...prev, output: null } : null;
    case "studio.session.changed":
      // A turn that ended, however it ended, shows nothing live any more.
      return data.status !== "running" && data.status !== "waiting" && (prev.thinking || prev.output) ? NO_LIVE : null;
    default:
      return null;
  }
}

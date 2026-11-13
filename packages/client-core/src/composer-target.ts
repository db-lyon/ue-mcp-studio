/**
 * Where the composer's message goes, by the thread that is open: the main
 * agent from the main thread; from a subagent's thread, that subagent while it
 * runs (it reads the message at its next step, and nothing is stopped), or the
 * main agent, told whose thread it was written in, once the subagent has
 * finished. Web and phone draw the same placeholder and pick the same route.
 */
import type { SessionDetail, ToolCallRecord } from "@ue-mcp-studio/shared";
import { describe } from "./chat-model.js";
import { composerBusy } from "./working.js";

export type ComposerTarget =
  | { to: "main" }
  /** A running subagent: the message goes to it, and the composer sends rather than queues. */
  | { to: "subagent"; call: ToolCallRecord }
  /** A subagent that has finished: the message goes to the main agent, naming the subagent. */
  | { to: "finished"; call: ToolCallRecord };

/** The target for the open subagent thread, or the main agent with none open. */
export function composerTarget(openThread: ToolCallRecord | null | undefined): ComposerTarget {
  if (!openThread) return { to: "main" };
  return openThread.outcome === "pending" ? { to: "subagent", call: openThread } : { to: "finished", call: openThread };
}

type Detail = Pick<SessionDetail, "status"> & { mainFree?: boolean };

/** Whether the composer queues: the main agent is working, and the message is for it. A running subagent takes one at once. */
export const composerQueues = (detail: Detail | null | undefined, target: ComposerTarget): boolean =>
  target.to !== "subagent" && composerBusy(detail);

/** The error for files sent in a running subagent's thread. */
export const SUBAGENT_TEXT_ONLY = "Subagents take text only. Remove the files, or send them from the main thread.";

/** What the empty message box says: who the message goes to, and whether it queues. */
export function composerPlaceholder(detail: Detail, target: ComposerTarget): string {
  if (target.to === "subagent") return `Message "${describe(target.call)}"`;
  const busy = composerBusy(detail);
  if (target.to === "finished") return `"${describe(target.call)}" finished. ${busy ? "Queue a message for the main agent" : "Message the main agent"}`;
  if (busy) return "Queue a message";
  if (detail.mainFree) return "Message the main agent";
  return "Ask for something";
}

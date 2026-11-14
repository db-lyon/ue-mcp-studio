/**
 * Where the composer's message goes, by the thread that is open: the main
 * agent from the main thread; from a subagent's thread, that subagent while it
 * runs (it reads the message at its next step and answers in its thread, and
 * nothing is stopped), or the main agent, told whose thread it was written
 * in, once the subagent has finished or when the daemon says it cannot take a
 * message. Web and phone draw the same placeholder and pick the same route.
 */
import type { MessageDelivery, SessionAgent, SessionDetail, ToolCallRecord } from "@ue-mcp-studio/shared";
import { describe } from "./chat-model.js";
import { composerBusy } from "./working.js";

export type ComposerTarget =
  | { to: "main" }
  /** A running subagent: the message goes to it, and the composer sends rather than queues. */
  | { to: "subagent"; call: ToolCallRecord }
  /** A subagent that has finished: the message goes to the main agent, naming the subagent. */
  | { to: "finished"; call: ToolCallRecord }
  /** A running subagent the daemon says cannot take a message: it goes to the main agent, naming the subagent. */
  | { to: "unreachable"; call: ToolCallRecord };

/**
 * The target for the open subagent thread, or the main agent with none open.
 * `agent` is that subagent as the daemon describes it: one it says cannot
 * take a message sends to the main agent before the user types, never into a
 * thread nobody reads.
 */
export function composerTarget(openThread: ToolCallRecord | null | undefined, agent?: Pick<SessionAgent, "messageable"> | null): ComposerTarget {
  if (!openThread) return { to: "main" };
  if (openThread.outcome !== "pending") return { to: "finished", call: openThread };
  return agent?.messageable === false ? { to: "unreachable", call: openThread } : { to: "subagent", call: openThread };
}

/** The message goes to the main agent from a subagent's thread, which then opens the main thread for the reply. */
export const toMainFromThread = (target: ComposerTarget): boolean => target.to === "finished" || target.to === "unreachable";

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
  const main = busy ? "Queue a message for the main agent" : "Message the main agent";
  if (target.to === "finished") return `"${describe(target.call)}" finished. ${main}`;
  if (target.to === "unreachable") return `"${describe(target.call)}" can't read messages. ${main}`;
  if (busy) return "Queue a message";
  if (detail.mainFree) return "Message the main agent";
  return "Ask for something";
}

/**
 * The line under a message the user wrote in a subagent's thread, saying what
 * became of it; null when there is nothing to say (it was read, or the daemon
 * did not track it).
 */
export function messageDeliveryNote(delivery: MessageDelivery | undefined): string | null {
  if (delivery === "waiting") return "Waiting for its next step";
  if (delivery === "main") return "Not delivered: it ended first, so the main agent has it";
  return null;
}

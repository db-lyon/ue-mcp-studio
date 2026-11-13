/**
 * Messages the user sends a running subagent from its thread. A subagent is a
 * conversation of its own on every route, so the message goes into that
 * conversation as a user message, read at the subagent's next step: Studio's
 * own loop adds it before the subagent's next model call (it waits here until
 * then), and a subagent on the Claude sign-in has it streamed into its own
 * session's input. Nothing interrupts the subagent, the main agent or any
 * other subagent.
 */

/** What a subagent is told about the user's messages to it, in its system prompt. */
export const SUBAGENT_MESSAGES_LINE = "While you work, the user can open your thread in Studio and write to you. Such a message comes as a user message beginning \"The user writes to you from your thread\": "
  + "act on it as the user's instruction, within your task, and say in your report what you did about it.";

/** The user's messages as a subagent's conversation is given them. */
export function toSubagent(texts: string[]): string {
  return `The user writes to you from your thread (the agent that gave you your task does not see this):\n\n${texts.map((t) => t.trim()).filter(Boolean).join("\n\n")}`;
}

/** What the main agent is told, with a subagent's result, of what the user wrote to that subagent from its thread. */
export function heardNote(texts: string[]): string {
  return `While it worked, the user wrote to this subagent from its thread in Studio, so these are the user's own instructions:\n\n${texts.join("\n\n")}`;
}

/** What the main agent is told when a subagent ended before it read the user's message to it. */
export function unreadNote(description: string, texts: string[]): string {
  return `The user sent a message to the subagent "${description}", which ended before it read it, so it comes to you instead. The user's message:\n\n${texts.join("\n\n")}`;
}

/** What the main agent is told with a message the user wrote while looking at a subagent that could not take it. */
export function aboutNote(description: string): string {
  return `The user wrote the message below while looking at the thread of the subagent "${description}", which could no longer take a message, so it comes to you. Read it with that subagent's work in mind.`;
}

/** Messages waiting for each subagent, by agent call id, as they are to be handed over. */
export class SubagentInbox {
  private readonly waiting = new Map<string, string[]>();

  /** Keep a message for the subagent of this agent call. */
  push(callId: string, text: string): void {
    this.waiting.set(callId, [...(this.waiting.get(callId) ?? []), text]);
  }

  /** The subagent's waiting messages joined, taken once; null when none wait. */
  take(callId: string): string | null {
    const texts = this.drain(callId);
    return texts.length ? texts.join("\n\n") : null;
  }

  /** The messages still waiting, taken once: for a subagent that ended before reading them. */
  drain(callId: string): string[] {
    const texts = this.waiting.get(callId) ?? [];
    this.waiting.delete(callId);
    return texts;
  }

  /** Take back the last message kept for this subagent, when it could not be handed on after all. */
  unpush(callId: string): void {
    const texts = this.waiting.get(callId);
    if (!texts) return;
    texts.pop();
    if (!texts.length) this.waiting.delete(callId);
  }

  has(callId: string): boolean {
    return (this.waiting.get(callId)?.length ?? 0) > 0;
  }
}

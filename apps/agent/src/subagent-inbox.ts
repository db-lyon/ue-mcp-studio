/**
 * Messages the user sends a running subagent from its thread, waiting for it
 * to read them. Each subagent takes its messages at its next step, on either
 * loop: Studio's own loop adds them to the subagent's conversation before its
 * next model call, and the Agent SDK route hands them over in hooks
 * (subscription.ts) on the subagent's next tool result or as it tries to end.
 * Nothing here interrupts the subagent, the main agent or any other subagent.
 */

/** What a subagent is told with the user's messages, so it reads them as the user's and acts on them. */
export function forSubagent(texts: string[]): string {
  const said = texts.map((t) => t.trim()).filter(Boolean).join("\n\n");
  return "[Studio] The user opened your thread and sent you this message while you work. It comes from the user, not from a tool or another agent. "
    + "Take it into account for the rest of your task, and say in your report what you did about it.\n\n"
    + said;
}

/** What the main agent is told when a subagent ended before it read the user's message to it. */
export function unreadNote(description: string, texts: string[]): string {
  return `The user sent a message to the subagent "${description}", which ended before it read it, so it comes to you instead. The user's message:\n\n${texts.join("\n\n")}`;
}

/** What the main agent is told with a message the user wrote while looking at a subagent that had already finished. */
export function aboutNote(description: string): string {
  return `The user wrote the message below while looking at the thread of the subagent "${description}", which could no longer take a message, so it comes to you. Read it with that subagent's work in mind.`;
}

export class SubagentInbox {
  private readonly waiting = new Map<string, string[]>();

  /** Keep a message for the subagent of this agent call. */
  push(callId: string, text: string): void {
    this.waiting.set(callId, [...(this.waiting.get(callId) ?? []), text]);
  }

  /** The subagent's waiting messages as it is told them, taken once; null when none wait. */
  take(callId: string): string | null {
    const texts = this.drain(callId);
    return texts.length ? forSubagent(texts) : null;
  }

  /** The messages still waiting, as the user wrote them, taken once: for a subagent that ended before reading them. */
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

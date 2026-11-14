/**
 * Messages the user sends a running subagent from its thread. A subagent is a
 * conversation of its own on every route, so the message goes into that
 * conversation as a user message, read at the subagent's next step: Studio's
 * own loop adds it before the subagent's next model call (it waits here until
 * then), and a subagent on the Claude sign-in has it streamed into its own
 * session's input. Nothing interrupts the subagent, the main agent or any
 * other subagent.
 *
 * The subagent answers with the reply tool, which shows its words in its
 * thread at once. Told only to "act on it", a subagent acts and answers in
 * its thinking, which the user never sees, so the user is left talking to
 * nobody; even told to answer in text, it often answers in thinking between
 * tool calls. A tool call it makes reliably, and it never ends its work.
 */

/** How every message the user sends a subagent begins in its conversation; the runtime's prompt hook counts them by it. */
export const SUBAGENT_MESSAGE_PREFIX = "The user writes to you from your thread";

/** Studio's reply tool: a subagent's answer to the user's message, shown in its thread. Only subagents have it. */
export const REPLY_TOOL_NAME = "reply";
export const REPLY_DESCRIPTION = "Answer the user, who wrote to you from your thread in Studio: they see this text in your thread at once. "
  + "Use it for every message the user sends you, before any other tool call. Never use it for your report.";
export const REPLY_TOOL = {
  name: REPLY_TOOL_NAME,
  description: REPLY_DESCRIPTION,
  input_schema: { type: "object" as const, properties: { text: { type: "string", description: "Your answer, as the user reads it" } }, required: ["text"] },
};

/** What the reply tool answers the subagent. */
export const REPLY_SHOWN = "Shown to the user in your thread. Now do what they asked: carry on, change course, or stop.";

/** What a subagent is told about the user's messages to it, in its system prompt. */
export const SUBAGENT_MESSAGES_LINE = `While you work, the user can open your thread in Studio and write to you. Such a message comes as a user message beginning "${SUBAGENT_MESSAGE_PREFIX}": it is the user talking to you, so treat it as the user's own turn in a conversation. `
  + "The user cannot see your thinking, nor your text until you finish, so answer every such message at once with the reply tool, before any other tool call: answer a question, say what you will change, or say you are stopping. "
  + "Then do what it says. When the user tells you to stop, stop: call no more tools and end with a short note of where you left off. Otherwise go on with your task after replying.";

/**
 * The user's messages as a subagent's conversation is given them. `reply`:
 * it has the reply tool. A subagent in a turn host from before
 * REPLY_PROTOCOL has not, and is told to answer in text instead.
 */
export function toSubagent(texts: string[], reply = true): string {
  const words = texts.map((t) => t.trim()).filter(Boolean).join("\n\n");
  if (reply) return `${SUBAGENT_MESSAGE_PREFIX} (the agent that gave you your task does not see this). Answer them with the reply tool before anything else. The user's words:\n\n${words}`;
  return `${SUBAGENT_MESSAGE_PREFIX} (the agent that gave you your task does not see this):\n\n${words}\n\n`
    + "[Studio] Write your answer to the user as visible text now: your next message must begin with a text block addressed to them, before any tool call. They cannot see your thinking, so an answer in thinking never reaches them.";
}

/** How many of the user's messages a prompt the runtime took in holds. */
export function messagesIn(prompt: string): number {
  return prompt.split(SUBAGENT_MESSAGE_PREFIX).length - 1;
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

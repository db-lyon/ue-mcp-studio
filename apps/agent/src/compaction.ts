/**
 * Compaction on the routes Studio runs the loop for (API keys, the Studio
 * plan, ChatGPT, Google and custom endpoints): when a conversation nears the
 * model's window, or the user asks, the model summarises it and the agent
 * continues from that summary. The transcript the user sees is never cut;
 * only what the model is sent changes. The Claude sign-in's runtime compacts
 * on its own, and Studio shows where it did.
 */
import { COMPACTED_PREFIX, estimateTokens } from "@ue-mcp-studio/shared";
import type { MessageParam } from "./providers.js";

type Block = { type: string; text?: string; name?: string; input?: unknown; content?: unknown; source?: { data?: string } };

const blocksOf = (m: MessageParam): Block[] => (typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as Block[]));

/** Tokens an image or a document is counted as before a provider measures it. */
const IMAGE_TOKENS = 1600;

function blockTokens(b: Block): number {
  if (b.type === "text") return estimateTokens(b.text ?? "");
  if (b.type === "tool_use") return estimateTokens(`${b.name ?? ""}${JSON.stringify(b.input ?? {})}`);
  if (b.type === "tool_result") {
    const c = b.content;
    if (typeof c === "string") return estimateTokens(c);
    return Array.isArray(c) ? (c as Block[]).reduce((n, x) => n + blockTokens(x), 0) : 0;
  }
  if (b.type === "image") return IMAGE_TOKENS;
  // A PDF's base64: about one token per eight characters of it, the pages read as text and image.
  if (b.type === "document") return Math.max(IMAGE_TOKENS, Math.ceil((b.source?.data?.length ?? 0) / 8));
  if (b.type === "thinking" || b.type === "redacted_thinking") return 0;
  return estimateTokens(JSON.stringify(b));
}

/** A rough count of what these messages take in a prompt, for a conversation no provider has measured. */
export function estimateMessagesTokens(messages: readonly MessageParam[]): number {
  let n = 0;
  for (const m of messages) for (const b of blocksOf(m)) n += blockTokens(b);
  return n;
}

/** Whether a user message answers tool calls. */
export const isToolResults = (m: MessageParam): boolean =>
  Array.isArray(m.content) && (m.content as Block[]).some((b) => b.type === "tool_result");

/** Whether a message is the summary a compaction left. */
export const isCompactedSummary = (m: MessageParam | undefined): boolean =>
  !!m && m.role === "user" && blocksOf(m).some((b) => b.type === "text" && (b.text ?? "").startsWith(COMPACTED_PREFIX));

/** What the model is asked when it summarises a conversation. */
export function summaryInstruction(instructions?: string): string {
  return [
    "[Studio] The conversation is about to be compacted to free context: everything above will be replaced by your summary of it, and you will continue the work from that summary alone.",
    "Write that summary now. Do not call any tool; answer with the summary only. Keep what you need to carry on without asking the user again:",
    "1. What the user asked for, in their words where it matters, and every constraint or preference they gave.",
    "2. What has been done: assets, actors, levels, Blueprints, files and settings created or changed, with their exact paths and names.",
    "3. Decisions made and why, and approaches that failed and why, so they are not tried again.",
    "4. The current state, including errors still open.",
    "5. What is left to do, and the very next step if the work was in progress.",
    "Be specific and complete, but write no more than the work needs.",
    instructions?.trim() ? `The user asked that the summary keep: ${instructions.trim()}` : null,
  ].filter(Boolean).join("\n");
}

/**
 * The messages that ask for the summary: the conversation as it is, so the
 * provider's prompt cache still applies, then the request. A conversation
 * that ends with the user's turn gets the request added to that turn.
 */
export function summaryRequest(messages: readonly MessageParam[], instructions?: string): MessageParam[] {
  const ask = { type: "text", text: summaryInstruction(instructions) };
  const last = messages[messages.length - 1];
  if (!last || last.role === "assistant") return [...messages, { role: "user", content: [ask] } as MessageParam];
  return [...messages.slice(0, -1), { role: "user", content: [...blocksOf(last), ask] } as MessageParam];
}

/** The conversation as plain text, the most recent part kept when it is longer than `max` characters. */
export function conversationText(messages: readonly MessageParam[], max: number): string {
  const lines: string[] = [];
  for (const m of messages) {
    for (const b of blocksOf(m)) {
      if (b.type === "text" && b.text?.trim()) lines.push(`${m.role === "user" ? "User" : "Assistant"}: ${b.text.trim()}`);
      else if (b.type === "tool_use") lines.push(`Assistant called ${b.name} ${JSON.stringify(b.input ?? {}).slice(0, 2000)}`);
      else if (b.type === "tool_result") {
        const c = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? (b.content as Block[]).map((x) => x.text ?? "").join("\n") : "";
        if (c.trim()) lines.push(`Result: ${c.trim().slice(0, 4000)}`);
      }
    }
  }
  const text = lines.join("\n\n");
  return text.length > max ? `(the earliest part is left out)\n\n${text.slice(text.length - max)}` : text;
}

/**
 * The conversation after compaction: one message with the summary, then what
 * the work needs to go on. After an answer, the model acknowledges the summary
 * so the user's next message follows in turn. In the middle of a turn (the
 * last message is tool results) it is told to carry on. A message from the
 * user that was waiting for an answer is kept after the summary, as it was.
 */
export function compactedMessages(original: readonly MessageParam[], summary: string, before: number): MessageParam[] {
  const head = `${COMPACTED_PREFIX} to free context (it had reached about ${before.toLocaleString("en-US")} tokens). `
    + "This summary replaces everything said before this point; the user still sees the whole transcript, so refer to earlier work as usual.\n\n"
    + summary.trim();
  const last = original[original.length - 1];
  if (!last || last.role === "assistant") {
    return [
      { role: "user", content: [{ type: "text", text: head }] } as MessageParam,
      { role: "assistant", content: [{ type: "text", text: "I have the summary and will continue from it." }] } as MessageParam,
    ];
  }
  if (isToolResults(last)) {
    return [{ role: "user", content: [{ type: "text", text: `${head}\n\n[Studio] You were in the middle of the work above, and the summary covers its latest results. Continue the task where it stopped, without asking the user to repeat anything.` }] } as MessageParam];
  }
  return [{ role: "user", content: [{ type: "text", text: head }, ...blocksOf(last).filter((b) => !(b.type === "text" && (b.text ?? "").startsWith("[Studio] The conversation is about to be compacted")))] } as MessageParam];
}

/** A provider's answer that a request was longer than the model's window. */
export function isContextOverflow(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /prompt is too long|context[ _-]?length|context window|maximum context|too many (input )?tokens|input is too long|exceeds the (model's )?(maximum|context)|context_length_exceeded|request too large for model/i.test(msg);
}

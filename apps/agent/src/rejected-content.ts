/**
 * A file the model's API refuses (a PDF over its page limit, an image it cannot
 * decode) must not poison the session: the user's message stays in the
 * conversation, so every later turn would fail the same way. The refused
 * blocks are replaced with a note that the file was not sent, and the turn is
 * sent again. The note beside the file ("[Attached file] name, saved at path")
 * is already in the message, so the model knows where to read the file from.
 */
import { isContextOverflow } from "./compaction.js";
import type { MessageParam } from "./providers.js";

/** Whether an API error is about a file's content, as opposed to the conversation's length or a transient fault. */
export function isRejectedContent(e: unknown): boolean {
  if (isContextOverflow(e)) return false;
  const text = e instanceof Error ? e.message : String(e ?? "");
  return /could not process (image|pdf)|invalid (image|pdf|base64)|image (does not match|exceeds|too large|dimensions)|(pdf|document)s? .*(page|password|encrypted|too large|invalid|exceed)|maximum of \d+ pages|messages\.\d+\.content\.\d+\.(image|document)/i.test(text);
}

const noteFor = (why: string): string =>
  `[Not sent: the model's API refused this file (${why.replace(/\s+/g, " ").trim().slice(0, 200)}). It is saved on this computer at the path in the note above. Read it from there, or convert it first: for a PDF, extract its text or split it; for an image, make a smaller copy.]`;

const isFileBlock = (b: unknown): boolean => !!b && typeof b === "object" && ["image", "document"].includes((b as { type?: string }).type ?? "");

/** Replaces the file blocks in a content array; true when it changed any. */
function swap(content: unknown[], note: string): boolean {
  let changed = false;
  for (let i = 0; i < content.length; i++) {
    const b = content[i] as { type?: string; content?: unknown };
    if (isFileBlock(b)) {
      content[i] = { type: "text", text: note };
      changed = true;
    } else if (b?.type === "tool_result" && Array.isArray(b.content) && swap(b.content, note)) changed = true;
  }
  return changed;
}

/**
 * The file blocks of the messages after the last answer, which are the ones the
 * refused request carried, replaced by a note. How many messages changed.
 */
export function dropRejectedBlocks(messages: MessageParam[], why: string): number {
  const note = noteFor(why);
  let changed = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant") break;
    if (Array.isArray(m.content) && swap(m.content as unknown[], note)) changed++;
  }
  return changed;
}

/**
 * Swapping a file's content in a user message for its saved path. Every
 * attachment reaches the model as a note naming the file and where it is
 * saved (attachments.ts `contentFor`), followed by the content itself when the
 * model can read it. When that content is what stops a request (too large
 * for the window, refused by the API), the content goes and the note stays,
 * now saying how to read the file instead.
 */

type Block = { type: string; text?: string; source?: { data?: string } };

const NOTE = /^\[Attached file\] .+?, saved at .+?\. (The document follows\.|The image follows|It follows as |Its text follows\.)/s;
const FOLLOWS = /(The document follows\.|The image follows[^.]*\.|It follows as [^;]*; import the file with ue-mcp if the task needs it in the project\.|Its text follows\.)$/s;

/** A document or an image: what an API may refuse. */
export const isMedia = (b: Block): boolean => b.type === "document" || b.type === "image";

/** The size of a block's content in characters. */
const sizeOf = (b: Block): number => (b.type === "text" ? (b.text ?? "").length : (b.source?.data?.length ?? 0));

/** Documents above this many base64 characters, and inlined text above this many characters, are swapped when a kept message must shrink. */
export const LARGE_DOCUMENT_CHARS = 400_000;
export const LARGE_TEXT_CHARS = 200_000;

/** The note that replaces an attachment's content: the saved path stays, with how to read it. */
function swapped(note: string, why: string): Block {
  const head = note.replace(FOLLOWS, "").trimEnd();
  return { type: "text", text: `${head} ${why}` };
}

/**
 * Replace the content blocks `which` picks, each following its attachment
 * note, with the note alone (with `why` appended). Blocks that follow no note
 * (a pasted screenshot, tool results) are left as they are.
 */
export function swapAttachedForPath<T extends Block>(blocks: readonly T[], which: (b: Block) => boolean, why: string): { blocks: T[]; swapped: number } {
  const out: T[] = [];
  let n = 0;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const next = blocks[i + 1];
    if (b.type === "text" && NOTE.test(b.text ?? "") && next && which(next)) {
      out.push(swapped(b.text ?? "", why) as T);
      i++;
      n++;
      continue;
    }
    out.push(b);
  }
  return { blocks: out, swapped: n };
}

/** The large documents, images and inlined text of a message, swapped for their saved paths. */
export function swapLargeForPath<T extends Block>(blocks: readonly T[]): { blocks: T[]; swapped: number } {
  return swapAttachedForPath(
    blocks,
    (b) => (isMedia(b) && sizeOf(b) > LARGE_DOCUMENT_CHARS) || (b.type === "text" && sizeOf(b) > LARGE_TEXT_CHARS),
    "It was left out of the conversation to free space; read it from that path with read_file, or extract its text or pages with the shell.",
  );
}

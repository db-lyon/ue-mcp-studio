import { describe, expect, it } from "vitest";
import type { MessageParam } from "../src/providers.js";
import { compactedMessages } from "../src/compaction.js";
import { LARGE_DOCUMENT_CHARS, swapAttachedForPath, swapLargeForPath } from "../src/attached-swap.js";

const note = (how: string) => ({ type: "text", text: `[Attached file] spec.pdf (application/pdf, 40 MB), saved at C:\\data\\spec.pdf. ${how}` });
const doc = (n: number) => ({ type: "document", source: { type: "base64", media_type: "application/pdf", data: "A".repeat(n) } });

describe("swapping attached content for the saved path", () => {
  it("keeps the note with its path and drops the content after it", () => {
    const r = swapAttachedForPath([note("The document follows."), doc(10), { type: "text", text: "summarise it" }], (b) => b.type === "document", "The API refused it.");
    expect(r.swapped).toBe(1);
    expect(r.blocks).toHaveLength(2);
    expect((r.blocks[0] as { text: string }).text).toBe("[Attached file] spec.pdf (application/pdf, 40 MB), saved at C:\\data\\spec.pdf. The API refused it.");
    expect((r.blocks[1] as { text: string }).text).toBe("summarise it");
  });

  it("leaves content that follows no attachment note", () => {
    const r = swapAttachedForPath([{ type: "text", text: "look" }, doc(10)], () => true, "x");
    expect(r.swapped).toBe(0);
    expect(r.blocks).toHaveLength(2);
  });

  it("swaps only large content", () => {
    expect(swapLargeForPath([note("The document follows."), doc(100)]).swapped).toBe(0);
    expect(swapLargeForPath([note("The document follows."), doc(LARGE_DOCUMENT_CHARS + 1)]).swapped).toBe(1);
  });

  it("compaction keeps the last user message without its large document, but with its path", () => {
    const last = { role: "user", content: [note("The document follows."), doc(LARGE_DOCUMENT_CHARS + 1), { type: "text", text: "what does it say" }] } as MessageParam;
    const out = compactedMessages([last], "summary", 1000);
    const blocks = out[0].content as Array<{ type: string; text?: string }>;
    expect(blocks.some((b) => b.type === "document")).toBe(false);
    expect(blocks.some((b) => b.text?.includes("saved at C:\\data\\spec.pdf"))).toBe(true);
    expect(blocks.some((b) => b.text === "what does it say")).toBe(true);
  });
});

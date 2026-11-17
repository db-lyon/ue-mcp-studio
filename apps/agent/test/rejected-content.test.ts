import { describe, expect, it } from "vitest";
import { dropRejectedBlocks, isRejectedContent } from "../src/rejected-content.js";
import type { MessageParam } from "../src/providers.js";

describe("what the API refuses about a file", () => {
  it("tells a refused file from a conversation that is too long or a transient fault", () => {
    expect(isRejectedContent(new Error("messages.0.content.1.document: PDF has too many pages (maximum of 100 pages)"))).toBe(true);
    expect(isRejectedContent(new Error("Could not process image"))).toBe(true);
    expect(isRejectedContent(new Error("prompt is too long: 230000 tokens > 200000 maximum"))).toBe(false);
    expect(isRejectedContent(new Error("529 overloaded"))).toBe(false);
  });

  it("replaces the file blocks after the last answer, in tool results too, and nothing before it", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "old" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AA" } }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [{ type: "text", text: "[Attached file] a.pdf, saved at C:/x/a.pdf" }, { type: "document", source: { type: "base64", media_type: "application/pdf", data: "AA" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA" } }] }] },
    ] as unknown as MessageParam[];
    expect(dropRejectedBlocks(messages, "PDF has too many pages")).toBe(2);
    expect(JSON.stringify(messages[0])).toContain('"type":"image"');
    expect(JSON.stringify(messages[2])).not.toContain("document");
    expect(JSON.stringify(messages[2])).toContain("saved at C:/x/a.pdf");
    expect(JSON.stringify(messages[3])).not.toContain('"type":"image"');
    expect(dropRejectedBlocks(messages, "again")).toBe(0);
  });
});

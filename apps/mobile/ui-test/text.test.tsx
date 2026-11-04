import { describe, expect, it } from "vitest";
import { baseFont, font, inlineCode, labelFont, lineBox, monoNormal, THEMES } from "../src/ui";

describe("text metrics", () => {
  it("lays a line-height multiple out as Chrome does: the product cut down to 1/64 px", () => {
    // 12px/1.6 is 19.2, which a browser lays out at 1228/64 px; 19.2px as written rounds up to 1229/64.
    expect(lineBox(12, 1.6)).toBe(19.1875);
    expect(lineBox(13.5, 1.55)).toBe(20.921875);
    expect(lineBox(10.5, 1.3)).toBe(13.640625);
    // Exact products stay exact.
    expect(lineBox(12.5, 1.5)).toBe(18.75);
    expect(lineBox(12, 1.5)).toBe(18);
  });

  it("gives font(), baseFont() and labelFont() those line heights", () => {
    const t = THEMES["ue-mcp"];
    expect(font(t, "mono", 400, 12, 1.6).lineHeight).toBe(19.1875);
    expect(baseFont(t).lineHeight).toBe(20.921875);
    expect(labelFont(t).lineHeight).toBe(13.640625);
    expect(baseFont(THEMES.editor).lineHeight).toBe(18.75);
  });

  it("gives inline code the mono font's normal line height, as Chrome measures it, not the paragraph's", () => {
    expect([11, 11.5, 12, 13.5].map((s) => monoNormal(THEMES["ue-mcp"], s))).toEqual([14, 15, 16, 18]);
    expect([11, 11.5, 12, 13.5].map((s) => monoNormal(THEMES.editor, s))).toEqual([13, 14, 14, 15]);
    expect(inlineCode(THEMES["ue-mcp"]).lineHeight).toBe(16);
  });
});

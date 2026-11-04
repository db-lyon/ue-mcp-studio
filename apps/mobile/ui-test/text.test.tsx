import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { baseFont, bulletBox, font, inlineCode, labelFont, lineBox, Markdown, monoNormal, ThemeProvider, THEMES } from "../src/ui";

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

describe("list markers", () => {
  it("places a bullet where Chrome paints an outside disc: 2/3 ascent + 7 px before the text, 3/2 of the rest below the ascent line", () => {
    // 13.5px Plus Jakarta Sans (ascent 14) at 1.55: a 5px disc 16px left of the text, 7.95px down the first line.
    expect(bulletBox(THEMES["ue-mcp"], 13.5, lineBox(13.5, 1.55))).toEqual({ left: -16, top: 7.953125, size: 5 });
    // 12.5px Roboto (ascent 12) at 1.5: a 4px disc 15px left, 6.875px down.
    expect(bulletBox(THEMES.editor, 12.5, lineBox(12.5, 1.5))).toEqual({ left: -15, top: 6.875, size: 4 });
  });

  it("draws a disc, a circle one level in and a square below that, not a font glyph", () => {
    render(
      <ThemeProvider name="ue-mcp">
        <Markdown text={"- one\n  - two\n    - three"} />
      </ThemeProvider>,
    );
    const [disc, circle, square] = screen.getAllByTestId("md-bullet").map((el) => el.style);
    expect(screen.queryByText("\u2022")).toBeNull();
    expect([disc.left, disc.top, disc.width, disc.height]).toEqual(["-16px", "7.953125px", "5px", "5px"]);
    expect(disc.borderTopLeftRadius || disc.borderRadius).toBe("2.5px");
    expect(circle.borderTopWidth || circle.borderWidth).toBe("1px");
    expect(square.borderTopLeftRadius || square.borderRadius || "0px").toBe("0px");
  });
});

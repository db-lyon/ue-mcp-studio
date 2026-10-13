import { describe, expect, it } from "vitest";
import { inline, richText } from "../src/rich-text.js";

describe("markdown as the pill's rich text", () => {
  it("marks bold and code, and drops link targets", () => {
    expect(inline("**Two calls:** a `search`, then [the docs](https://x.y/z).")).toBe("<b>Two calls:</> a <c>search</>, then the docs.");
  });

  it("escapes what would read as markup, inside code too", () => {
    expect(inline("a <b> tag & `x < y`")).toBe("a &lt;b&gt; tag &amp; <c>x &lt; y</>");
  });

  it("reads nothing inside a code span as markdown", () => {
    expect(inline("`**not bold**`")).toBe("<c>**not bold**</>");
  });

  it("drops single-mark emphasis but leaves identifiers with underscores alone", () => {
    expect(inline("this is *really* it, see BP_Chest_C and snake_case_name")).toBe("this is really it, see BP_Chest_C and snake_case_name");
  });

  it("lays out headings, lists, numbered steps and code blocks", () => {
    const md = [
      "## Result",
      "",
      "Either:",
      "",
      "1. **Two calls:** search first.",
      "2. One more call.",
      "- a bullet",
      "  - nested",
      "",
      "```",
      "unreal.log(1)",
      "```",
      "---",
      "> quoted",
    ].join("\n");
    expect(richText(md)).toBe([
      "<b>Result</>",
      "",
      "Either:",
      "",
      "1.  <b>Two calls:</> search first.",
      "2.  One more call.",
      "•  a bullet",
      "    •  nested",
      "",
      "<c>unreal.log(1)</>",
      "quoted",
    ].join("\n"));
  });

  it("keeps at most one blank line between blocks", () => {
    expect(richText("a\n\n\n\nb")).toBe("a\n\nb");
  });
});

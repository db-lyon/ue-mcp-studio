// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { applyTheme, themeColor } from "./theme";

beforeEach(() => {
  document.head.innerHTML = '<meta name="theme-color" content="#000000" />';
});

describe("the browser's toolbar color", () => {
  it("follows the top bar of each theme", () => {
    expect(themeColor("ue-mcp")).toBe("#0c0c0b");
    expect(themeColor("editor")).toBe("#1a1a1a");
    expect(themeColor("editor-orange", { recessed: "#202020" })).toBe("#202020");
  });

  it("is written to the theme-color meta when a theme applies", async () => {
    await applyTheme("ue-mcp");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#0c0c0b");
    await applyTheme("editor");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#1a1a1a");
  });
});

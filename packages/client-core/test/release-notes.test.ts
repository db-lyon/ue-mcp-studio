/** The release-notes sanitiser both clients render through, on ue-mcp's real 1.4.14-beta.5 notes and on hostile HTML. */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import { RELEASE_NOTES_REHYPE, releaseNoteText } from "../src/index.js";

interface H {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: H[];
}

/** The tree a client draws, as both clients build it. */
function tree(md: string): H {
  let u = unified().use(remarkParse).use(remarkGfm).use(remarkRehype, { allowDangerousHtml: true }) as never as { use(p: unknown, o?: unknown): typeof u; parse(t: string): unknown; runSync(t: unknown): H };
  for (const p of RELEASE_NOTES_REHYPE) u = Array.isArray(p) ? u.use(p[0], p[1]) : u.use(p);
  return u.runSync(u.parse(md));
}

const all = (n: H): H[] => [n, ...(n.children ?? []).flatMap(all)];
const tags = (n: H) => new Set(all(n).filter((x) => x.type === "element").map((x) => x.tagName));
const textOf = (n: H): string => (n.type === "text" ? n.value ?? "" : (n.children ?? []).map(textOf).join(""));

describe("release notes", () => {
  const real = fs.readFileSync(path.join(__dirname, "fixtures", "ue-mcp-1.4.14-beta.5.md"), "utf-8");

  it("renders ue-mcp 1.4.14-beta.5's folds as details with their markdown parsed inside", () => {
    const t = tree(releaseNoteText("1.4.14-beta.5", real));
    const details = all(t).filter((n) => n.tagName === "details");
    expect(details).toHaveLength(2);
    const [first] = details;
    const summary = first.children!.find((c) => c.tagName === "summary")!;
    expect(textOf(summary)).toBe("Editor dialogs");
    // <b> is drawn as strong, the list inside is a real list with code spans.
    expect(summary.children!.some((c) => c.tagName === "strong")).toBe(true);
    const list = all(first).find((n) => n.tagName === "ul")!;
    expect(list.children!.filter((c) => c.tagName === "li")).toHaveLength(3);
    expect(all(list).some((n) => n.tagName === "code" && textOf(n) === "editor(list_dialogs)")).toBe(true);
    // No tag text is left over as literal text.
    expect(textOf(t)).not.toMatch(/<\/?(details|summary|b)>/);
  });

  it("drops the leading heading that only restates the version, keeping the others", () => {
    const t = tree(releaseNoteText("1.4.14-beta.5", real));
    const headings = all(t).filter((n) => /^h\d$/.test(n.tagName ?? "")).map(textOf);
    expect(headings).toEqual(["Features"]);
  });

  it("strips scripts, styles, frames, event handlers, inline styles and non-web links", () => {
    const hostile = [
      "<script>window.hacked = 1</script>",
      "<style>body { display: none }</style>",
      '<iframe src="https://evil.test"></iframe>',
      '<img src="x" onerror="window.hacked = 1">',
      '<img src="https://ue-mcp.com/a.png" alt="ok" onload="x()">',
      '<a href="javascript:alert(1)">js</a> <a href="data:text/html,x">data</a> <a href="https://ue-mcp.com" onclick="x()" style="color:red">web</a>',
      '<div onmouseover="x()">div text</div> <span style="position:fixed">span</span>',
      "[md js](javascript:alert(1)) <kbd>Ctrl</kbd> <i>it</i> <sub>2</sub> <sup>3</sup><br>",
      '<details open ontoggle="x()"><summary onclick="x()">S</summary>\n\nInside\n\n</details>',
    ].join("\n\n");
    const t = tree(hostile);
    const nodes = all(t);
    expect(tags(t).has("script")).toBe(false);
    expect(tags(t).has("style")).toBe(false);
    expect(tags(t).has("iframe")).toBe(false);
    expect(tags(t).has("div")).toBe(false);
    expect(textOf(t)).not.toContain("window.hacked");
    expect(textOf(t)).not.toContain("display: none");
    for (const n of nodes) {
      for (const k of Object.keys(n.properties ?? {})) expect(k).not.toMatch(/^on|^style$/i);
    }
    const hrefs = nodes.filter((n) => n.tagName === "a").map((n) => n.properties?.href);
    expect(hrefs.filter(Boolean)).toEqual(["https://ue-mcp.com"]);
    const srcs = nodes.filter((n) => n.tagName === "img").map((n) => n.properties?.src);
    expect(srcs.filter(Boolean)).toEqual(["https://ue-mcp.com/a.png"]);
    // The text of a removed tag stays; the allowed inline tags survive, kbd and i in their one spelling.
    expect(textOf(t)).toContain("div text");
    for (const tag of ["code", "em", "sub", "sup", "br", "details", "summary"]) expect(tags(t).has(tag)).toBe(true);
    expect(tags(t).has("kbd")).toBe(false);
    expect(tags(t).has("i")).toBe(false);
  });
});

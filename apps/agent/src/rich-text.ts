/**
 * Markdown as Unreal's rich text markup, for the editor's pill: <b> for bold
 * and headings, <c> for code, lists with their bullets or numbers, links as
 * their text. Everything else is escaped, so a reply can never close a tag.
 */

const escape = (t: string): string => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** One line's inline marks: code spans first, so nothing inside them is read as markdown. */
export function inline(text: string): string {
  return text
    .split(/(`[^`]+`)/)
    .map((part) => {
      if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) return `<c>${escape(part.slice(1, -1))}</>`;
      return escape(part)
        .replace(/!?\[([^\]]+)\]\([^)\s]+\)/g, "$1")
        .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_m, a: string | undefined, b: string | undefined) => `<b>${a ?? b}</>`)
        .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,;:!?]|$)/g, "$1$2")
        .replace(/(^|[\s(])_([^_\s][^_]*?)_(?=[\s).,;:!?]|$)/g, "$1$2");
    })
    .join("");
}

export function richText(markdown: string): string {
  const out: string[] = [];
  let fence = false;
  for (const raw of markdown.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*```/.test(raw)) {
      fence = !fence;
      continue;
    }
    if (fence) {
      out.push(raw.trim() ? `<c>${escape(raw)}</>` : "");
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(raw);
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(raw);
    const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(raw);
    const indent = (lead: string) => "    ".repeat(Math.floor(lead.length / 2));
    if (heading) out.push(`<b>${inline(heading[1])}</>`);
    else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) continue;
    else if (bullet) out.push(`${indent(bullet[1])}•  ${inline(bullet[2])}`);
    else if (numbered) out.push(`${indent(numbered[1])}${numbered[2]}.  ${inline(numbered[3])}`);
    else out.push(inline(raw.replace(/^\s*>\s?/, "")));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

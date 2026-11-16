/**
 * Release notes as both clients render them: markdown with a small, safe
 * subset of HTML (release bodies fold sections into <details>), sanitised by
 * rehype-sanitize against an allowlist. Everything else is dropped: scripts
 * and styles with their content, every other tag (its text kept), every event
 * handler and style attribute, and any link or image that is not http(s).
 */
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from "rehype-sanitize";

/** The HTML a release body may use, beside what markdown itself makes. */
export const RELEASE_NOTES_HTML = ["details", "summary", "b", "strong", "em", "i", "code", "kbd", "br", "sub", "sup", "a", "img"] as const;

/** What markdown (with GFM) produces, so sanitising never removes the markdown's own structure. */
const MARKDOWN_TAGS = ["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "pre", "hr", "table", "thead", "tbody", "tr", "th", "td", "del", "input", "section", "span"];

export const RELEASE_NOTES_SCHEMA: SanitizeSchema = {
  ...defaultSchema,
  tagNames: [...MARKDOWN_TAGS, ...RELEASE_NOTES_HTML],
  attributes: {
    a: ["href", "title"],
    img: ["src", "alt", "title", "width", "height"],
    code: [["className", /^language-[\w-]+$/]],
    input: [["type", "checkbox"], ["disabled", true], "checked"],
    details: ["open"],
    th: ["align"],
    td: ["align"],
  },
  protocols: { href: ["http", "https"], src: ["http", "https"] },
  strip: ["script", "style", "iframe", "object", "embed", "noscript", "template", "textarea", "select", "title"],
  required: { input: { type: "checkbox", disabled: true } },
};

interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** One spelling per meaning, so a renderer draws fewer tags: b is strong, i is em, kbd is code. */
const SAME: Record<string, string> = { b: "strong", i: "em", kbd: "code" };
const WEB = /^https?:\/\//i;

function tidy(node: HastNode): void {
  if (node.type === "element" && node.tagName && SAME[node.tagName]) node.tagName = SAME[node.tagName];
  // The schema lets a relative URL through; in Studio's page that would point at the daemon, so only absolute web URLs stay.
  for (const key of ["href", "src"]) {
    const v = node.properties?.[key];
    if (v !== undefined && !(typeof v === "string" && WEB.test(v))) delete node.properties![key];
  }
  for (const c of node.children ?? []) tidy(c);
}

/** The rehype plugin after sanitising. */
export function rehypeNotesTidy() {
  return (tree: HastNode) => tidy(tree);
}

/**
 * The rehype plugins for release notes, after remark-rehype with
 * allowDangerousHtml: parse the HTML in place, sanitise, tidy. Order matters:
 * nothing reaches a renderer before sanitising.
 */
export const RELEASE_NOTES_REHYPE: ReadonlyArray<unknown> = [rehypeRaw, [rehypeSanitize, RELEASE_NOTES_SCHEMA], rehypeNotesTidy];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A release body without a leading heading that only restates its version ("## v1.4.14-beta.5"). */
export function releaseNoteText(version: string, body: string): string {
  const head = new RegExp(`^\\s*#{1,6}[ \\t]*\\[?v?${escape(version)}\\]?[ \\t]*#*[ \\t]*(\\r?\\n|$)`, "i");
  return body.replace(head, "").replace(/^\s+/, "");
}

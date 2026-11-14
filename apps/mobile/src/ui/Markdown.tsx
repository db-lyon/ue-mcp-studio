/**
 * Markdown as the web client's `.md` draws it. The text goes through the same
 * pipeline react-markdown runs there (remark-parse, remark-gfm, remark-breaks
 * where the web passes it, the reply link plugin, remark-rehype), and the HTML tree
 * that comes out is drawn as native views with the browser's defaults and the
 * `.md` rules of styles.css: 8px under paragraphs, lists and code, lists
 * indented 20px with their markers outside, inline code in 12px mono on
 * panel-2, fenced code on panel-2 scrolling sideways, hairline table cells with
 * a panel-2 header, links in the bright accent, and `##` in the label style
 * (the web's global h2 rule). Vertical margins collapse as CSS collapses them.
 */
import { memo, useMemo, type ReactNode } from "react";
import { Linking, ScrollView, Text, View, type TextStyle, type ViewStyle } from "react-native";
import { unified, type Processor } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import remarkRehype from "remark-rehype";
import { classifyLink, remarkReplyLinks } from "@ue-mcp-studio/client-core";
import { baseFont, font, italic, labelFont, monoNormal } from "./Text";
import { useTheme } from "./ThemeProvider";
import type { Theme } from "./theme";

/** What remarkReplyLinks marked: an exact asset link from the model, a token to resolve, or a project file. */
export type LinkMark = { kind: "exact"; path: string; label: string } | { kind: "token"; token: string; code: boolean } | { kind: "file"; path: string; line?: number };

export interface MarkdownProps {
  text: string;
  /** Overrides the body text style (colour, size). */
  tone?: TextStyle;
  /** A single line break stays a line break (remark-breaks). On by default, as a reply renders. */
  breaks?: boolean;
  /** Mark a reply's links and asset names with remarkReplyLinks and draw them with `renderMark`. */
  links?: boolean;
  /** children: the link's own text, which a file link shows. */
  renderMark?: (mark: LinkMark, children: ReactNode, key: number) => ReactNode;
  /** Inline code that names no asset: its text, for a caller that allows breaks inside it. */
  renderCode?: (text: string) => ReactNode;
  /** An image: the caller loads it (a reply's project images come through Studio). Without it, its alt text. */
  renderImage?: (src: string, alt: string, key: number) => ReactNode;
  /**
   * A document rather than a chat message (a plugin's readme): the first and
   * last blocks keep their margins, as `.md` outside `.msg` keeps them.
   */
  page?: boolean;
  /** The margin under a paragraph: 8, or what the page sets (a plugin card's p is 0). */
  paragraphMargin?: number;
}

interface HNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HNode[];
}

const processors = new Map<string, Processor<never, never, never, never, never>>();
function processor(breaks: boolean, links: boolean) {
  const key = `${breaks}:${links}`;
  let p = processors.get(key);
  if (!p) {
    let u = unified().use(remarkParse).use(remarkGfm) as never as Processor;
    if (breaks) u = u.use(remarkBreaks) as never;
    if (links) u = u.use(remarkReplyLinks as never) as never;
    p = u.use(remarkRehype) as never;
    processors.set(key, p!);
  }
  return p!;
}

/** The HTML tree react-markdown would render for `text`. */
export function markdownTree(text: string, breaks = true, links = false): HNode {
  const p = processor(breaks, links) as never as { parse(t: string): unknown; runSync(t: unknown): HNode };
  return p.runSync(p.parse(text));
}

export const Markdown = memo(function Markdown({ text, tone, breaks = true, links = false, renderMark, renderCode, renderImage, page, paragraphMargin = 8 }: MarkdownProps) {
  const t = useTheme();
  const tree = useMemo(() => {
    try {
      return markdownTree(text, breaks, links);
    } catch {
      return null;
    }
  }, [text, breaks, links]);
  const body: TextStyle = { ...baseFont(t), ...tone };
  if (!tree) return <Text style={body}>{text}</Text>;
  const ctx: Ctx = { t, body, renderMark, renderCode, renderImage, depth: 0, paragraphMargin };
  const blocks = flow(ctx, tree.children ?? []);
  const edges = page && blocks.length ? { marginTop: blocks[0].mt, marginBottom: blocks[blocks.length - 1].mb } : null;
  return <View style={edges}>{place(blocks, true)}</View>;
});

/**
 * A long reply is drawn as pieces on rows of their own, cut where a block
 * ends: Android draws nothing in a scroller holding a row thousands of dp
 * tall. A list is cut between items, fenced code between runs of lines and a
 * paragraph at its line breaks, and the pieces stack back into the same layout.
 * The budget is in characters, about 500 dp of prose at phone width.
 */
export const PIECE_CHARS = 1000;
/** Lines of fenced code a piece holds, about the height of PIECE_CHARS of prose. */
export const PIECE_CODE_LINES = 24;
const BLOCK_WEIGHT = 40;
const CODE_LINE_WEIGHT = PIECE_CHARS / PIECE_CODE_LINES;

type Unit =
  | { kind: "node"; node: HNode; weight: number }
  | { kind: "inline"; nodes: HNode[]; weight: number }
  | { kind: "item"; list: HNode; index: number; count: number; weight: number }
  | { kind: "code"; text: string; lang: string; first: boolean; last: boolean; weight: number }
  | { kind: "lines"; node: HNode; from: number; to: number; last: boolean; weight: number };

interface Plan {
  units: Unit[];
  /** Each piece's units, [from, to). */
  pieces: [number, number][];
}

const codeOf = (pre: HNode) => (pre.children ?? []).find((k) => k.tagName === "code") ?? pre;
const codeText = (pre: HNode) => textOf(codeOf(pre)).replace(/\n$/, "");
const textWeight = (nodes: HNode[]) => nodes.reduce((a, c) => a + textOf(c).length, 0);
function weightOf(n: HNode): number {
  if (n.tagName === "pre") return codeText(n).split("\n").length * CODE_LINE_WEIGHT + BLOCK_WEIGHT;
  return textOf(n).length + BLOCK_WEIGHT;
}

/** Runs of consecutive items, each within the budget unless one item alone is over it. */
function group<T>(items: T[], weight: (x: T) => number, budget: number): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let sum = 0;
  for (const x of items) {
    const w = weight(x);
    if (cur.length && sum + w > budget) {
      out.push(cur);
      cur = [];
      sum = 0;
    }
    cur.push(x);
    sum += w;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** A top-level block as units: itself, or cut where it can be when it is over the budget. */
function unitsOf(n: HNode): Unit[] {
  const weight = weightOf(n);
  if (weight <= PIECE_CHARS) return [{ kind: "node", node: n, weight }];
  if (n.tagName === "ul" || n.tagName === "ol") {
    const items = (n.children ?? []).filter((k) => k.type === "element" && k.tagName === "li");
    return items.map((li, index) => ({ kind: "item", list: n, index, count: items.length, weight: weightOf(li) }));
  }
  if (n.tagName === "pre") {
    const lines = codeText(n).split("\n");
    const lang = langOf(codeOf(n));
    const runs: string[][] = [];
    for (let i = 0; i < lines.length; i += PIECE_CODE_LINES) runs.push(lines.slice(i, i + PIECE_CODE_LINES));
    return runs.map((run, i) => ({ kind: "code", text: run.join("\n"), lang, first: i === 0, last: i === runs.length - 1, weight: run.length * CODE_LINE_WEIGHT }));
  }
  if (n.tagName === "p") {
    // Its lines between breaks, grouped; the break at a cut is where one piece ends and the next starts.
    const kids = n.children ?? [];
    const lines: { from: number; to: number; weight: number }[] = [];
    let from = 0;
    kids.forEach((k, i) => {
      if (k.tagName !== "br") return;
      lines.push({ from, to: i, weight: textWeight(kids.slice(from, i)) });
      from = i + 1;
    });
    lines.push({ from, to: kids.length, weight: textWeight(kids.slice(from)) });
    if (lines.length < 2) return [{ kind: "node", node: n, weight }];
    const runs = group(lines, (l) => l.weight, PIECE_CHARS);
    return runs.map((run, i) => ({ kind: "lines", node: n, from: run[0].from, to: run[run.length - 1].to, last: i === runs.length - 1, weight: run.reduce((a, l) => a + l.weight, 0) }));
  }
  return [{ kind: "node", node: n, weight }];
}

const plans = new Map<string, Plan | null>();
function planOf(text: string, breaks: boolean, links: boolean): Plan | null {
  const key = `${breaks}:${links}:${text}`;
  if (plans.has(key)) {
    const hit = plans.get(key)!;
    plans.delete(key);
    plans.set(key, hit);
    return hit;
  }
  let plan: Plan | null = null;
  try {
    const tree = markdownTree(text, breaks, links);
    const units: Unit[] = [];
    let run: HNode[] = [];
    const flush = () => {
      if (run.some((n) => !blank(n))) units.push({ kind: "inline", nodes: run, weight: textWeight(run) });
      run = [];
    };
    for (const n of tree.children ?? []) {
      if (!isBlock(n)) {
        run.push(n);
        continue;
      }
      flush();
      units.push(...unitsOf(n));
    }
    flush();
    const pieces: [number, number][] = [];
    let at = 0;
    for (const g of group(units, (u) => u.weight, PIECE_CHARS)) {
      pieces.push([at, at + g.length]);
      at += g.length;
    }
    plan = { units, pieces };
  } catch {
    plan = null;
  }
  plans.set(key, plan);
  if (plans.size > 64) plans.delete(plans.keys().next().value!);
  return plan;
}

/** How many pieces `text` is drawn in: 1 when it fits one row. */
export function markdownPieces(text: string, breaks = true, links = false): number {
  return Math.max(1, planOf(text, breaks, links)?.pieces.length ?? 1);
}

function unitBlock(ctx: Ctx, u: Unit, lists: Map<HNode, Block[]>): Block {
  switch (u.kind) {
    case "node":
      return block(ctx, u.node) ?? { el: () => null, mt: 0, mb: 0 };
    case "inline":
      return { el: (s) => textRun(ctx, u.nodes, s), mt: 0, mb: 0 };
    case "item": {
      let lis = lists.get(u.list);
      if (!lis) lists.set(u.list, (lis = listItems(ctx, u.list)));
      const li = lis[u.index];
      return {
        mt: u.index === 0 ? Math.max(0, li.mt) : li.mt,
        mb: u.index === u.count - 1 ? Math.max(8, li.mb) : li.mb,
        el: (s) => <View accessibilityRole="list" style={[{ paddingLeft: 20 }, s as ViewStyle]}>{place([li], false)}</View>,
      };
    }
    case "code":
      return codeBlock(ctx, u.text, u.lang, u.first, u.last);
    case "lines": {
      const kids = (u.node.children ?? []).slice(u.from, u.to);
      return { el: (s) => textRun(ctx, kids, s), mt: 0, mb: u.last ? (ctx.paragraphMargin ?? 8) : 0 };
    }
  }
}

/**
 * Piece `piece` of `text` (see markdownPieces), with the space above it that
 * the block before it leaves, so the pieces drawn one under another look as
 * the whole reply does.
 */
export const MarkdownPiece = memo(function MarkdownPiece({ text, piece, tone, breaks = true, links = false, renderMark, renderCode, renderImage, paragraphMargin = 8 }: MarkdownProps & { piece: number }) {
  const t = useTheme();
  const plan = planOf(text, breaks, links);
  if (!plan?.pieces[piece]) return piece === 0 ? <Markdown text={text} tone={tone} breaks={breaks} links={links} renderMark={renderMark} renderCode={renderCode} renderImage={renderImage} paragraphMargin={paragraphMargin} /> : null;
  const body: TextStyle = { ...baseFont(t), ...tone };
  const ctx: Ctx = { t, body, renderMark, renderCode, renderImage, depth: 0, paragraphMargin };
  const lists = new Map<HNode, Block[]>();
  const [from, to] = plan.pieces[piece];
  const blocks = plan.units.slice(from, to).map((u) => unitBlock(ctx, u, lists));
  const gap = from > 0 ? Math.max(unitBlock(ctx, plan.units[from - 1], lists).mb, blocks[0].mt) : 0;
  return <View style={gap ? { marginTop: gap } : null}>{place(blocks, true)}</View>;
});

interface Ctx {
  t: Theme;
  body: TextStyle;
  renderMark?: MarkdownProps["renderMark"];
  renderCode?: MarkdownProps["renderCode"];
  renderImage?: MarkdownProps["renderImage"];
  /** List nesting, for the marker: disc, circle, square. */
  depth: number;
  paragraphMargin?: number;
}

/** A block and the margins CSS gives it above and below, before collapsing. */
interface Block {
  el: (style: ViewStyle | TextStyle) => ReactNode;
  mt: number;
  mb: number;
}

const BLOCK = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "pre", "blockquote", "table", "hr", "div", "section"]);
const isBlock = (n: HNode) => n.type === "element" && BLOCK.has(n.tagName ?? "");
const blank = (n: HNode) => n.type === "text" && !/\S/.test(n.value ?? "");

const isImg = (n: HNode) => n.type === "element" && n.tagName === "img";
const spacer = (n: HNode) => blank(n) || (n.type === "element" && n.tagName === "br");

/**
 * Inline content as one Text, or, when it holds images the caller draws, its
 * runs of text with each image on a line of its own between them. `.md-image`
 * is a block on the web, and an Image inside a Text is an inline attachment,
 * which Android sizes and clips as a glyph.
 */
function textRun(ctx: Ctx, nodes: HNode[], style: TextStyle | ViewStyle, body: TextStyle = ctx.body, key?: number): ReactNode {
  if (!ctx.renderImage || !nodes.some(isImg)) return <Text key={key} style={[body, style as TextStyle]} selectable>{inlines(ctx, nodes, true)}</Text>;
  const parts: ReactNode[] = [];
  let run: HNode[] = [];
  const flush = () => {
    let from = 0;
    let to = run.length;
    while (from < to && spacer(run[from])) from++;
    while (to > from && spacer(run[to - 1])) to--;
    if (from < to) parts.push(<Text key={parts.length} style={body} selectable>{inlines(ctx, run.slice(from, to), true)}</Text>);
    run = [];
  };
  nodes.forEach((n, i) => {
    if (!isImg(n)) return run.push(n);
    flush();
    parts.push(<View key={parts.length}>{inline(ctx, n, i, true)}</View>);
  });
  flush();
  return <View key={key} style={style as ViewStyle}>{parts}</View>;
}

/** Children as blocks: runs of inline content become one paragraph-less line of text. */
function flow(ctx: Ctx, nodes: HNode[]): Block[] {
  const out: Block[] = [];
  let run: HNode[] = [];
  const flush = () => {
    if (run.some((n) => !blank(n))) {
      const nodes = run;
      const key = out.length;
      out.push({ el: (style) => textRun(ctx, nodes, style, ctx.body, key), mt: 0, mb: 0 });
    }
    run = [];
  };
  for (const n of nodes) {
    if (isBlock(n)) {
      flush();
      const b = block(ctx, n);
      if (b) out.push(b);
    } else run.push(n);
  }
  flush();
  return out;
}

/** Blocks stacked with collapsed margins. `top`: the first and last lose theirs (`.msg.md > :first-child` and `:last-child`). */
function place(blocks: Block[], top: boolean): ReactNode[] {
  return blocks.map((b, i) => {
    const mt = i === 0 ? 0 : Math.max(blocks[i - 1].mb, b.mt);
    const mb = i === blocks.length - 1 && !top ? 0 : 0;
    return <View key={i} style={{ marginTop: mt, marginBottom: mb }}>{b.el({})}</View>;
  });
}

/** A container's margins: its own, collapsed with its first child's top and last child's bottom. */
function through(own: { mt: number; mb: number }, kids: Block[]) {
  return { mt: Math.max(own.mt, kids[0]?.mt ?? 0), mb: Math.max(own.mb, kids[kids.length - 1]?.mb ?? 0) };
}

const HEADING = { h1: [2, 0.67], h3: [1.17, 1], h4: [1, 1.33], h5: [0.83, 1.67], h6: [0.67, 2.33] } as Record<string, [number, number]>;

function block(ctx: Ctx, n: HNode): Block | null {
  const { t, body } = ctx;
  const size = (body.fontSize as number) ?? t.base.size;
  const lh = ((body.lineHeight as number) ?? t.base.lineHeight) / size;
  const tag = n.tagName ?? "";
  const kids = n.children ?? [];
  switch (tag) {
    case "p":
      return { el: (s) => textRun(ctx, kids, s), mt: 0, mb: ctx.paragraphMargin ?? 8 };
    case "h2":
      return { el: (s) => <Text accessibilityRole="header" style={[labelFont(t), s as TextStyle]} selectable>{inlines({ ...ctx, body: labelFont(t) }, kids, true)}</Text>, mt: 0, mb: 12 };
    case "h1":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const [em, margin] = HEADING[tag];
      const hs = { ...body, ...font(t, "sans", 700, size * em, lh) };
      return { el: (s) => <Text accessibilityRole="header" style={[hs, s as TextStyle]} selectable>{inlines({ ...ctx, body: hs }, kids, true)}</Text>, mt: size * em * margin, mb: size * em * margin };
    }
    case "ul":
    case "ol": {
      const lis = listItems(ctx, n);
      const m = through({ mt: 0, mb: 8 }, lis);
      return { ...m, el: (s) => <View accessibilityRole="list" style={[{ paddingLeft: 20 }, s as ViewStyle]}>{place(lis, false)}</View> };
    }
    case "pre": {
      return codeBlock(ctx, codeText(n), langOf(codeOf(n)), true, true);
    }
    case "blockquote": {
      const content = flow(ctx, kids);
      const m = through({ mt: size, mb: size }, content);
      return { ...m, el: (s) => <View style={[{ marginHorizontal: 40 }, s as ViewStyle]}>{place(content, false)}</View> };
    }
    case "hr":
      return { mt: size / 2, mb: size / 2, el: (s) => <View style={[{ borderTopWidth: 1, borderBottomWidth: 1, borderTopColor: "rgb(128, 128, 128)", borderBottomColor: "rgb(192, 192, 192)" }, s as ViewStyle]} /> };
    case "table":
      return { mt: 0, mb: 8, el: (s) => <Table ctx={ctx} node={n} style={s as ViewStyle} /> };
    default: {
      const content = flow(ctx, kids);
      const m = through({ mt: 0, mb: 0 }, content);
      return { ...m, el: (s) => <View style={s as ViewStyle}>{place(content, false)}</View> };
    }
  }
}


/** A list's items as blocks, each numbered or bulleted as it is in the whole list. */
function listItems(ctx: Ctx, n: HNode): Block[] {
  const { body } = ctx;
  const ordered = n.tagName === "ol";
  const start = Number(n.properties?.start ?? 1) || 1;
  const items = (n.children ?? []).filter((k) => k.type === "element" && k.tagName === "li");
  const inner = { ...ctx, depth: ctx.depth + 1 };
  return items.map((li, i) => {
    const content = flow(inner, li.children ?? []);
    const m = through({ mt: 0, mb: 0 }, content);
    return {
      mt: m.mt,
      mb: m.mb,
      el: (s) => (
        <View style={s as ViewStyle}>
          {ordered ? (
            <Text style={[body, { position: "absolute", right: "100%", paddingRight: 4 }]} numberOfLines={1} importantForAccessibility="no">{`${start + i}.`}</Text>
          ) : (
            <ListBullet ctx={ctx} />
          )}
          {place(content, false)}
        </View>
      ),
    };
  });
}

const langOf = (code: HNode) => String((code.properties?.className as string[] | undefined)?.find((c) => c.startsWith("language-"))?.slice(9) ?? "");

/** Fenced code, or a run of its lines: `first` and `last` say which ends of the box this run draws. */
function codeBlock(ctx: Ctx, text: string, lang: string, first: boolean, last: boolean): Block {
  const { t, body } = ctx;
  const r = 6;
  return {
    mt: 0,
    mb: last ? 8 : 0,
    el: (s) => (
      <View accessibilityLabel={lang ? `${lang} code` : "Code"} style={[{ backgroundColor: t.c.panel2, borderTopLeftRadius: first ? r : 0, borderTopRightRadius: first ? r : 0, borderBottomLeftRadius: last ? r : 0, borderBottomRightRadius: last ? r : 0 }, s as ViewStyle]}>
        <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={{ paddingTop: first ? 8 : 0, paddingBottom: last ? 8 : 0, paddingHorizontal: 10 }}>
          <Text style={[font(t, "mono", 400, 12), { lineHeight: monoNormal(t, 12), color: body.color }]} selectable>{text}</Text>
        </ScrollView>
      </View>
    ),
  };
}

/** The sans faces' ascent and descent per em, as Chrome reads them (Plus Jakarta Sans's typo metrics, Roboto's hhea). */
const SANS_METRICS: Partial<Record<Theme["sans"], [number, number]>> = { jakarta: [1.038, 0.222], roboto: [1900 / 2048, 500 / 2048] };

/**
 * Where Chrome paints an outside `disc`, `circle` or `square` marker, relative
 * to the list item's content box: a square of (2/3 ascent + 1) / 2 px, its
 * left edge 2/3 ascent + 7 px before the content, its top 3/2 of the ascent
 * left over below the first line's ascent line, less 1 px (blink's ListMarker
 * symbol rect, with ascent rounded to whole px; the 1 px is measured against
 * Chrome's shots in both sans faces).
 */
export function bulletBox(t: Theme, size: number, lineHeight: number): { left: number; top: number; size: number } {
  const [asc, desc] = SANS_METRICS[t.sans] ?? SANS_METRICS.jakarta!;
  const a = Math.round(size * asc);
  const d = Math.round(size * desc);
  const offset = Math.floor((a * 2) / 3);
  const half = Math.floor(((lineHeight - a - d) / 2) * 64) / 64;
  return { left: -(offset + 7), top: half + Math.floor((3 * (a - offset)) / 2) - 1, size: Math.floor((offset + 1) / 2) };
}

/** A bullet list's marker: a disc, a circle one level in, a square below that. */
function ListBullet({ ctx }: { ctx: Ctx }) {
  const { t, body } = ctx;
  const size = (body.fontSize as number) ?? t.base.size;
  const box = bulletBox(t, size, (body.lineHeight as number) ?? t.base.lineHeight);
  const kind = Math.min(ctx.depth, 2);
  const color = (body.color as string) ?? t.c.text;
  return (
    <View
      testID="md-bullet"
      importantForAccessibility="no"
      style={{
        position: "absolute",
        left: box.left,
        top: box.top,
        width: box.size,
        height: box.size,
        borderRadius: kind === 2 ? 0 : box.size / 2,
        ...(kind === 1 ? { borderWidth: 1, borderColor: color } : { backgroundColor: color }),
      }}
    />
  );
}

/**
 * `.md table` in `.md-table`: border-collapse, 1px cells padded 3px 10px, the
 * header on panel-2 in 600, the table scrolling sideways when wider than the
 * reply. Columns are laid out as columns so each takes its widest cell.
 */
function Table({ ctx, node, style }: { ctx: Ctx; node: HNode; style: ViewStyle }) {
  const { t, body } = ctx;
  const rows: Array<{ head: boolean; cells: HNode[] }> = [];
  const visit = (n: HNode, head: boolean) => {
    for (const k of n.children ?? []) {
      if (k.type !== "element") continue;
      if (k.tagName === "thead") visit(k, true);
      else if (k.tagName === "tbody") visit(k, false);
      else if (k.tagName === "tr") rows.push({ head, cells: (k.children ?? []).filter((c) => c.type === "element") });
    }
  };
  visit(node, false);
  const cols = Math.max(0, ...rows.map((r) => r.cells.length));
  const head = { ...body, ...font(t, "sans", 600, (body.fontSize as number) ?? t.base.size), lineHeight: body.lineHeight };
  return (
    <ScrollView horizontal style={style} contentContainerStyle={{ paddingLeft: 1, paddingTop: 1 }}>
      {Array.from({ length: cols }, (_, c) => (
        <View key={c}>
          {rows.map((r, i) => {
            const cell = r.cells[c];
            const align = (cell?.properties?.align as string | undefined) ?? undefined;
            return (
              <View key={i} style={{ borderWidth: 1, borderColor: t.c.line, marginLeft: -1, marginTop: -1, paddingVertical: 3, paddingHorizontal: 10, backgroundColor: r.head ? t.c.panel2 : undefined }}>
                <Text style={[r.head ? head : body, align ? { textAlign: align as TextStyle["textAlign"] } : null]} selectable>
                  {cell ? inlines({ ...ctx, body: r.head ? head : body }, cell.children ?? [], true) : ""}
                </Text>
              </View>
            );
          })}
        </View>
      ))}
    </ScrollView>
  );
}

function textOf(n: HNode): string {
  return n.value ?? (n.children ?? []).map(textOf).join("");
}

/**
 * Inline content, with white space collapsed as `white-space: normal` collapses
 * it: runs to one space, none at the start of a line or after a break.
 */
function inlines(ctx: Ctx, nodes: HNode[], edge: boolean): ReactNode[] {
  const out: ReactNode[] = [];
  let lineStart = edge;
  const push = (s: string) => {
    let v = s.replace(/[ \t\n\r\f]+/g, " ");
    if (lineStart) v = v.replace(/^ /, "");
    if (!v) return;
    lineStart = v.endsWith(" ") ? true : false;
    out.push(v);
  };
  nodes.forEach((n, i) => {
    if (n.type === "text") return push(n.value ?? "");
    if (n.type !== "element") return;
    if (n.tagName === "br") {
      // A space before a break is dropped.
      const last = out[out.length - 1];
      if (typeof last === "string") out[out.length - 1] = last.replace(/ $/, "");
      out.push("\n");
      lineStart = true;
      return;
    }
    out.push(inline(ctx, n, i, lineStart));
    lineStart = false;
  });
  if (edge) {
    const last = out[out.length - 1];
    if (typeof last === "string") out[out.length - 1] = last.replace(/ $/, "");
  }
  return out;
}

function inline(ctx: Ctx, n: HNode, key: number, lineStart: boolean): ReactNode {
  const { t, body } = ctx;
  const kids = n.children ?? [];
  const p = n.properties ?? {};
  switch (n.tagName) {
    case "strong":
    case "b":
      return <Text key={key} style={font(t, "sans", 700, (body.fontSize as number) ?? t.base.size)}>{inlines(ctx, kids, lineStart)}</Text>;
    case "em":
    case "i":
      return <Text key={key} style={italic(t, "sans")}>{inlines(ctx, kids, lineStart)}</Text>;
    case "del":
      return <Text key={key} style={{ textDecorationLine: "line-through" }}>{inlines(ctx, kids, lineStart)}</Text>;
    case "code": {
      const token = p["data-asset"] as string | undefined;
      if (token && ctx.renderMark) return <Text key={key}>{ctx.renderMark({ kind: "token", token, code: true }, null, key)}</Text>;
      const text = textOf(n);
      return <Text key={key} style={inlineCode(t)}>{ctx.renderCode ? ctx.renderCode(text) : text}</Text>;
    }
    case "span": {
      const children = inlines(ctx, kids, lineStart);
      const mark: LinkMark | null = p["data-asset-path"]
        ? { kind: "exact", path: String(p["data-asset-path"]), label: String(p["data-asset-label"] ?? "") }
        : p["data-asset"]
          ? { kind: "token", token: String(p["data-asset"]), code: false }
          : p["data-file-path"]
            ? { kind: "file", path: String(p["data-file-path"]), ...(p["data-file-line"] ? { line: Number(p["data-file-line"]) } : {}) }
            : null;
      return <Text key={key}>{mark && ctx.renderMark ? ctx.renderMark(mark, children, key) : children}</Text>;
    }
    case "a": {
      // Only web links reach here as links; a reference link to anything else is its text.
      const href = String(p.href ?? "");
      const children = inlines(ctx, kids, lineStart);
      if (classifyLink(href).kind !== "web") return <Text key={key}>{children}</Text>;
      return (
        <Text key={key} style={{ color: t.c.accentHi }} accessibilityRole="link" onPress={() => void Linking.openURL(href).catch(() => undefined)}>
          {children}
        </Text>
      );
    }
    case "input":
      // A task list item's box: a disabled checkbox, 20px on a touch screen, 3px 3px 3px 4px around it.
      return (
        <View key={key} accessibilityRole="checkbox" accessibilityState={{ checked: !!p.checked, disabled: true }} style={{ width: 20, height: 20, marginTop: 3, marginRight: 3, marginBottom: -4, marginLeft: 4, borderRadius: 3, borderWidth: p.checked ? 0 : 1, borderColor: t.c.dim, backgroundColor: p.checked ? t.c.disabledLine : "transparent", alignItems: "center", justifyContent: "center" }}>
          {p.checked ? <Text style={{ color: t.c.onAccent, fontSize: 13, lineHeight: 15, fontWeight: "700" }}>{"✓"}</Text> : null}
        </View>
      );
    case "img": {
      const drawn = typeof p.src === "string" && ctx.renderImage ? ctx.renderImage(p.src, String(p.alt ?? ""), key) : null;
      return drawn ?? <Text key={key} style={{ color: t.c.accentHi }} accessibilityRole="image">{String(p.alt ?? "")}</Text>;
    }
    case "sup":
    case "sub":
      return <Text key={key} style={{ fontSize: ((body.fontSize as number) ?? t.base.size) * 0.83 }}>{inlines(ctx, kids, lineStart)}</Text>;
    default:
      return <Text key={key}>{inlines(ctx, kids, lineStart)}</Text>;
  }
}

/** `.md code`: 12px mono at its normal line height (the font shorthand resets it), on panel-2, 1px 4px, a 4px radius. */
export function inlineCode(t: Theme): TextStyle {
  return { ...font(t, "mono", 400, 12), lineHeight: monoNormal(t, 12), backgroundColor: t.c.panel2, paddingVertical: 1, paddingHorizontal: 4, borderRadius: 4 };
}

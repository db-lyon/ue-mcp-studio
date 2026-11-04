/**
 * Markdown as the web client's `.md` draws it. The text goes through the same
 * pipeline react-markdown runs there (remark-parse, remark-gfm, remark-breaks
 * where the web passes it, the asset plugin, remark-rehype), and the HTML tree
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
import { remarkAssets } from "@ue-mcp-studio/client-core";
import { baseFont, font, labelFont } from "./Text";
import { useTheme } from "./ThemeProvider";
import type { Theme } from "./theme";

/** An asset the asset plugin marked: an exact link from the model, or a token to resolve. */
export type AssetMark = { kind: "exact"; path: string; label: string } | { kind: "token"; token: string; code: boolean };

export interface MarkdownProps {
  text: string;
  /** Overrides the body text style (colour, size). */
  tone?: TextStyle;
  /** A single line break stays a line break (remark-breaks). On by default, as a reply renders. */
  breaks?: boolean;
  /** Mark asset names with the asset plugin and draw them with `renderAsset`. */
  assets?: boolean;
  renderAsset?: (mark: AssetMark, key: number) => ReactNode;
  /** Inline code that names no asset: its text, for a caller that allows breaks inside it. */
  renderCode?: (text: string) => ReactNode;
  renderLink?: (href: string, children: ReactNode, key: number) => ReactNode | null;
}

interface HNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HNode[];
}

const processors = new Map<string, Processor<never, never, never, never, never>>();
function processor(breaks: boolean, assets: boolean) {
  const key = `${breaks}:${assets}`;
  let p = processors.get(key);
  if (!p) {
    let u = unified().use(remarkParse).use(remarkGfm) as never as Processor;
    if (breaks) u = u.use(remarkBreaks) as never;
    if (assets) u = u.use(remarkAssets as never) as never;
    p = u.use(remarkRehype) as never;
    processors.set(key, p!);
  }
  return p!;
}

/** The HTML tree react-markdown would render for `text`. */
export function markdownTree(text: string, breaks = true, assets = false): HNode {
  const p = processor(breaks, assets) as never as { parse(t: string): unknown; runSync(t: unknown): HNode };
  return p.runSync(p.parse(text));
}

export const Markdown = memo(function Markdown({ text, tone, breaks = true, assets = false, renderAsset, renderCode, renderLink }: MarkdownProps) {
  const t = useTheme();
  const tree = useMemo(() => {
    try {
      return markdownTree(text, breaks, assets);
    } catch {
      return null;
    }
  }, [text, breaks, assets]);
  const body: TextStyle = { ...baseFont(t), ...tone };
  if (!tree) return <Text style={body}>{text}</Text>;
  const ctx: Ctx = { t, body, renderAsset, renderCode, renderLink, depth: 0 };
  return <View>{place(flow(ctx, tree.children ?? []), true)}</View>;
});

interface Ctx {
  t: Theme;
  body: TextStyle;
  renderAsset?: MarkdownProps["renderAsset"];
  renderCode?: MarkdownProps["renderCode"];
  renderLink?: MarkdownProps["renderLink"];
  /** List nesting, for the marker: disc, circle, square. */
  depth: number;
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

/** Children as blocks: runs of inline content become one paragraph-less line of text. */
function flow(ctx: Ctx, nodes: HNode[]): Block[] {
  const out: Block[] = [];
  let run: HNode[] = [];
  const flush = () => {
    if (run.some((n) => !blank(n))) {
      const nodes = run;
      out.push({ el: (style) => <Text key={out.length} style={[ctx.body, style as TextStyle]} selectable>{inlines(ctx, nodes, true)}</Text>, mt: 0, mb: 0 });
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
      return { el: (s) => <Text style={[body, s as TextStyle]} selectable>{inlines(ctx, kids, true)}</Text>, mt: 0, mb: 8 };
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
      const ordered = tag === "ol";
      const start = Number(n.properties?.start ?? 1) || 1;
      const items = kids.filter((k) => k.type === "element" && k.tagName === "li");
      const inner = { ...ctx, depth: ctx.depth + 1 };
      const lis: Block[] = items.map((li, i) => {
        const content = flow(inner, li.children ?? []);
        const m = through({ mt: 0, mb: 0 }, content);
        const marker = ordered ? `${start + i}.` : ["•", "◦", "▪"][Math.min(ctx.depth, 2)];
        return {
          mt: m.mt,
          mb: m.mb,
          el: (s) => (
            <View style={s as ViewStyle}>
              <Text style={[body, { position: "absolute", left: -20, width: 20, paddingRight: ordered ? 4 : 5, textAlign: "right" }]} importantForAccessibility="no">{marker}</Text>
              {place(content, false)}
            </View>
          ),
        };
      });
      const m = through({ mt: 0, mb: 8 }, lis);
      return { ...m, el: (s) => <View accessibilityRole="list" style={[{ paddingLeft: 20 }, s as ViewStyle]}>{place(lis, false)}</View> };
    }
    case "pre": {
      const code = kids.find((k) => k.tagName === "code") ?? n;
      const text = textOf(code).replace(/\n$/, "");
      const lang = String((code.properties?.className as string[] | undefined)?.find((c) => c.startsWith("language-"))?.slice(9) ?? "");
      return {
        mt: 0,
        mb: 8,
        el: (s) => (
          <View accessibilityLabel={lang ? `${lang} code` : "Code"} style={[{ backgroundColor: t.c.panel2, borderRadius: 6 }, s as ViewStyle]}>
            <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={{ paddingVertical: 8, paddingHorizontal: 10 }}>
              <Text style={[font(t, "mono", 400, 12), { lineHeight: monoNormal(t, 12), color: body.color }]} selectable>{text}</Text>
            </ScrollView>
          </View>
        ),
      };
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

/** A font's `line-height: normal` at a size: JetBrains Mono's ascent and descent; Consolas's for the editor themes. */
function monoNormal(t: Theme, size: number): number {
  return Math.round(size * (t.mono === "jetbrains" ? 1.32 : 1.17) * 100) / 100;
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
      return <Text key={key} style={{ fontStyle: "italic" }}>{inlines(ctx, kids, lineStart)}</Text>;
    case "del":
      return <Text key={key} style={{ textDecorationLine: "line-through" }}>{inlines(ctx, kids, lineStart)}</Text>;
    case "code": {
      const token = p["data-asset"] as string | undefined;
      if (token && ctx.renderAsset) return <Text key={key}>{ctx.renderAsset({ kind: "token", token, code: true }, key)}</Text>;
      const text = textOf(n);
      return <Text key={key} style={inlineCode(t)}>{ctx.renderCode ? ctx.renderCode(text) : text}</Text>;
    }
    case "span": {
      if (p["data-asset-path"] && ctx.renderAsset) return <Text key={key}>{ctx.renderAsset({ kind: "exact", path: String(p["data-asset-path"]), label: String(p["data-asset-label"] ?? "") }, key)}</Text>;
      if (p["data-asset"] && ctx.renderAsset) return <Text key={key}>{ctx.renderAsset({ kind: "token", token: String(p["data-asset"]), code: false }, key)}</Text>;
      return <Text key={key}>{inlines(ctx, kids, lineStart)}</Text>;
    }
    case "a": {
      const href = String(p.href ?? "");
      const children = inlines(ctx, kids, lineStart);
      const custom = ctx.renderLink?.(href, children, key);
      if (custom) return custom;
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
    case "img":
      return <Text key={key} style={{ color: t.c.accentHi }} accessibilityRole="image">{String(p.alt ?? "")}</Text>;
    case "sup":
    case "sub":
      return <Text key={key} style={{ fontSize: ((body.fontSize as number) ?? t.base.size) * 0.83 }}>{inlines(ctx, kids, lineStart)}</Text>;
    default:
      return <Text key={key}>{inlines(ctx, kids, lineStart)}</Text>;
  }
}

/**
 * `.md code`: 12px mono on panel-2, 1px 4px, a 4px radius. The `font` shorthand sets its line-height to
 * normal (the mono face's own, 1.32 for JetBrains Mono), so it never stretches the line it sits in.
 */
export function inlineCode(t: Theme): TextStyle {
  return { ...font(t, "mono", 400, 12), lineHeight: monoNormal(t, 12), backgroundColor: t.c.panel2, paddingVertical: 1, paddingHorizontal: 4, borderRadius: 4 };
}

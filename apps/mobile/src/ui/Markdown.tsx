/**
 * An agent's reply as the web client's `.md` draws it (react-markdown with
 * GFM and line breaks): 8px between blocks, lists indented 20px, inline code
 * in 12px mono on panel-2, fenced code on panel-2 scrolling sideways, tables
 * with hairline cells and a panel-2 header, links in the bright accent.
 * `renderLink` lets the transcript draw asset links its own way.
 */
import { memo, type ReactNode } from "react";
import { Linking, ScrollView, Text, View, type TextStyle } from "react-native";
import { lexer, type Token, type Tokens } from "marked";
import { baseFont, font } from "./Text";
import { useTheme } from "./ThemeProvider";
import type { Theme } from "./theme";

export interface MarkdownProps {
  text: string;
  /** Overrides the body text style (colour, size). */
  tone?: TextStyle;
  renderLink?: (href: string, children: ReactNode, key: number) => ReactNode | null;
  /**
   * A document rather than a chat message (a plugin's readme): headings keep the
   * browser's em margins and the body's line-height ratio, and the last block
   * keeps its 8px, as `.md` outside `.msg` draws them.
   */
  page?: boolean;
  /** The space under a paragraph: 8, or 0 where the page sets it (a plugin card's readme). */
  paragraphGap?: number;
}

export const Markdown = memo(function Markdown({ text, tone, renderLink, page, paragraphGap = 8 }: MarkdownProps) {
  const t = useTheme();
  let tokens: Token[];
  try {
    tokens = lexer(text, { gfm: true, breaks: true });
  } catch {
    return <Text style={[baseFont(t), tone]}>{text}</Text>;
  }
  const ctx: Ctx = { t, body: { ...baseFont(t), ...tone }, renderLink, page, paragraphGap };
  const out = blocks(ctx, tokens.filter((x) => x.type !== "space"));
  return <View>{out}</View>;
});

interface Ctx {
  t: Theme;
  body: TextStyle;
  renderLink?: MarkdownProps["renderLink"];
  page?: boolean;
  paragraphGap?: number;
}

function blocks(ctx: Ctx, tokens: Token[]): ReactNode[] {
  return tokens.filter((x) => x.type !== "space").map((tok, i, all) => block(ctx, tok, i, i === all.length - 1));
}

function block(ctx: Ctx, tok: Token, key: number, last: boolean): ReactNode {
  const { t, body } = ctx;
  const gap = { marginBottom: last && !ctx.page ? 0 : 8 };
  switch (tok.type) {
    case "heading": {
      const h = tok as Tokens.Heading;
      const size = [0, 2, 1.5, 1.17, 1, 0.83, 0.67][h.depth] * (body.fontSize ?? t.base.size);
      // A page's heading: the browser's em margins (collapsing with the 8px above) and the body's line-height ratio.
      const em = [0, 0.67, 0.83, 1, 1.33, 1.67, 2.33][h.depth] * size;
      const pageStyle = ctx.page ? { lineHeight: size * (t.base.lineHeight / t.base.size), marginTop: key === 0 ? em : Math.max(0, em - 8), marginBottom: em } : null;
      return (
        <Text key={key} accessibilityRole="header" style={[body, font(t, "sans", 700, size, 1.25), { color: body.color, marginTop: 0 }, gap, pageStyle]} selectable>
          {inline(ctx, h.tokens)}
        </Text>
      );
    }
    case "paragraph":
      return (
        <Text key={key} style={[body, gap, { marginBottom: last && !ctx.page ? 0 : ctx.paragraphGap ?? 8 }]} selectable>
          {inline(ctx, (tok as Tokens.Paragraph).tokens)}
        </Text>
      );
    case "text": {
      const x = tok as Tokens.Text;
      return (
        <Text key={key} style={[body, gap]} selectable>
          {x.tokens ? inline(ctx, x.tokens) : decode(x.text)}
        </Text>
      );
    }
    case "code": {
      const c = tok as Tokens.Code;
      return (
        <View key={key} style={[{ backgroundColor: t.c.panel2, borderRadius: 6 }, gap]} accessibilityLabel={c.lang ? `${c.lang} code` : "Code"}>
          <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={{ paddingVertical: 8, paddingHorizontal: 10 }}>
            {/* A page's pre keeps the browser's 13px monospace strut, so each line is 13px times the body's ratio. */}
            <Text style={[font(t, "mono", 400, 12, 1.55), { color: body.color }, ctx.page ? { lineHeight: 13 * (t.base.lineHeight / t.base.size) } : null]} selectable>
              {c.text}
            </Text>
          </ScrollView>
        </View>
      );
    }
    case "blockquote":
      return (
        <View key={key} style={[{ borderLeftWidth: 3, borderLeftColor: t.c.lineStrong, paddingLeft: 12 }, gap]}>
          {blocks({ ...ctx, body: { ...body, color: t.c.muted } }, (tok as Tokens.Blockquote).tokens)}
        </View>
      );
    case "list": {
      const l = tok as Tokens.List;
      const start = typeof l.start === "number" ? l.start : 1;
      return (
        <View key={key} style={gap}>
          {l.items.map((item, i) => (
            <View key={i} style={{ flexDirection: "row" }}>
              {/* The browser's outside marker: the bullet or number and a space, ending where the item's text starts. */}
              <Text style={[body, { width: 20 }, l.ordered || item.task ? { textAlign: "right" } : { paddingLeft: 4 }]}>{item.task ? (item.checked ? "☑ " : "☐ ") : l.ordered ? `${start + i}. ` : "•"}</Text>
              <View style={{ flex: 1, minWidth: 0 }}>{blocks({ ...ctx, page: false }, item.tokens)}</View>
            </View>
          ))}
        </View>
      );
    }
    case "table": {
      const tb = tok as Tokens.Table;
      const cell = { borderWidth: 1, borderColor: t.c.line, paddingVertical: 3, paddingHorizontal: 10, marginLeft: -1, marginTop: -1 };
      return (
        <ScrollView key={key} horizontal style={gap}>
          <View style={{ paddingLeft: 1, paddingTop: 1 }}>
            <View style={{ flexDirection: "row" }}>
              {tb.header.map((c, i) => (
                <Text key={i} style={[body, cell, { backgroundColor: t.c.panel2 }, font(t, "sans", 600, body.fontSize ?? t.base.size), { lineHeight: body.lineHeight, color: body.color }]}>
                  {inline(ctx, c.tokens)}
                </Text>
              ))}
            </View>
            {tb.rows.map((r, ri) => (
              <View key={ri} style={{ flexDirection: "row" }}>
                {r.map((c, i) => (
                  <Text key={i} style={[body, cell]} selectable>
                    {inline(ctx, c.tokens)}
                  </Text>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      );
    }
    case "hr":
      return <View key={key} style={[{ height: 1, backgroundColor: t.c.line, marginVertical: 8 }, gap]} />;
    case "html":
      return (
        <Text key={key} style={[body, gap]} selectable>
          {(tok as Tokens.HTML).text}
        </Text>
      );
    default:
      return "raw" in tok ? (
        <Text key={key} style={[body, gap]} selectable>
          {String(tok.raw)}
        </Text>
      ) : null;
  }
}

function inline(ctx: Ctx, tokens: Token[] | undefined): ReactNode[] {
  const { t } = ctx;
  return (tokens ?? []).map((tok, i) => {
    switch (tok.type) {
      case "strong":
        return (
          <Text key={i} style={font(t, "sans", 700, ctx.body.fontSize ?? t.base.size)}>
            {inline(ctx, (tok as Tokens.Strong).tokens)}
          </Text>
        );
      case "em":
        return (
          <Text key={i} style={{ fontStyle: "italic" }}>
            {inline(ctx, (tok as Tokens.Em).tokens)}
          </Text>
        );
      case "del":
        return (
          <Text key={i} style={{ textDecorationLine: "line-through" }}>
            {inline(ctx, (tok as Tokens.Del).tokens)}
          </Text>
        );
      case "codespan":
        return (
          <Text key={i} style={[font(t, "mono", 400, 12), { backgroundColor: t.c.panel2, borderRadius: 4, paddingHorizontal: 4 }]}>
            {decode((tok as Tokens.Codespan).text)}
          </Text>
        );
      case "link": {
        const l = tok as Tokens.Link;
        const kids = inline(ctx, l.tokens);
        const custom = ctx.renderLink?.(l.href, kids, i);
        if (custom) return custom;
        return (
          <Text key={i} style={{ color: t.c.accentHi }} accessibilityRole="link" onPress={() => void Linking.openURL(l.href).catch(() => undefined)}>
            {kids}
          </Text>
        );
      }
      case "br":
        return "\n";
      case "escape":
        return (tok as Tokens.Escape).text;
      case "text": {
        const x = tok as Tokens.Text;
        return x.tokens ? <Text key={i}>{inline(ctx, x.tokens)}</Text> : decode(x.text);
      }
      default:
        return "text" in tok ? decode(String(tok.text)) : "raw" in tok ? String(tok.raw) : null;
    }
  });
}

/** marked escapes these for HTML; native text wants them back. */
function decode(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39);/g, (m, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[e] ?? m);
}

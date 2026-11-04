/**
 * An agent's reply as formatted text: marked's tokens drawn with native views.
 * Headings, paragraphs, emphasis, inline code, fenced code (scrolls sideways,
 * never wraps), lists, quotes, tables and links. Raw HTML is shown as text.
 */
import { memo, type ReactNode } from "react";
import { Linking, ScrollView, StyleSheet, Text, View, type TextStyle } from "react-native";
import { lexer, type Token, type Tokens } from "marked";
import { colors, mono } from "./theme";

export const Markdown = memo(function Markdown({ text, dim }: { text: string; dim?: boolean }) {
  let tokens: Token[];
  try {
    tokens = lexer(text, { gfm: true, breaks: true });
  } catch {
    return <Text style={[m.p, dim && m.dim]}>{text}</Text>;
  }
  return <View>{blocks(tokens, dim ? m.dim : undefined)}</View>;
});

function blocks(tokens: Token[], tone?: TextStyle): ReactNode[] {
  return tokens.map((t, i) => block(t, i, tone));
}

function block(t: Token, key: number, tone?: TextStyle): ReactNode {
  switch (t.type) {
    case "space":
      return null;
    case "heading": {
      const h = t as Tokens.Heading;
      return (
        <Text key={key} style={[m.p, h.depth <= 2 ? m.h1 : m.h3, tone]} accessibilityRole="header">
          {inline(h.tokens, tone)}
        </Text>
      );
    }
    case "paragraph":
      return (
        <Text key={key} style={[m.p, tone]} selectable>
          {inline((t as Tokens.Paragraph).tokens, tone)}
        </Text>
      );
    case "text": {
      const x = t as Tokens.Text;
      return (
        <Text key={key} style={[m.p, tone]} selectable>
          {x.tokens ? inline(x.tokens, tone) : x.text}
        </Text>
      );
    }
    case "code": {
      const c = t as Tokens.Code;
      return (
        <View key={key} style={m.codeBlock} accessibilityLabel={c.lang ? `${c.lang} code` : "Code"}>
          {c.lang ? <Text style={m.lang}>{c.lang}</Text> : null}
          <ScrollView horizontal showsHorizontalScrollIndicator>
            <Text style={m.code} selectable>
              {c.text}
            </Text>
          </ScrollView>
        </View>
      );
    }
    case "blockquote":
      return (
        <View key={key} style={m.quote}>
          {blocks((t as Tokens.Blockquote).tokens, m.dim)}
        </View>
      );
    case "list": {
      const l = t as Tokens.List;
      const start = typeof l.start === "number" ? l.start : 1;
      return (
        <View key={key} style={m.list}>
          {l.items.map((item, i) => (
            <View key={i} style={m.item}>
              <Text style={[m.p, m.bullet, tone]}>{item.task ? (item.checked ? "☑" : "☐") : l.ordered ? `${start + i}.` : "•"}</Text>
              <View style={{ flex: 1 }}>{blocks(item.tokens, tone)}</View>
            </View>
          ))}
        </View>
      );
    }
    case "table": {
      const tb = t as Tokens.Table;
      return (
        <ScrollView key={key} horizontal style={m.tableWrap}>
          <View>
            <View style={m.tr}>
              {tb.header.map((c, i) => (
                <Text key={i} style={[m.td, m.th]}>
                  {inline(c.tokens, tone)}
                </Text>
              ))}
            </View>
            {tb.rows.map((r, ri) => (
              <View key={ri} style={m.tr}>
                {r.map((c, i) => (
                  <Text key={i} style={[m.td, tone]} selectable>
                    {inline(c.tokens, tone)}
                  </Text>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      );
    }
    case "hr":
      return <View key={key} style={m.hr} />;
    case "html":
      return (
        <Text key={key} style={[m.p, tone]} selectable>
          {(t as Tokens.HTML).text}
        </Text>
      );
    default:
      return "raw" in t ? (
        <Text key={key} style={[m.p, tone]} selectable>
          {String(t.raw)}
        </Text>
      ) : null;
  }
}

function inline(tokens: Token[] | undefined, tone?: TextStyle): ReactNode[] {
  return (tokens ?? []).map((t, i) => {
    switch (t.type) {
      case "strong":
        return (
          <Text key={i} style={m.strong}>
            {inline((t as Tokens.Strong).tokens, tone)}
          </Text>
        );
      case "em":
        return (
          <Text key={i} style={m.em}>
            {inline((t as Tokens.Em).tokens, tone)}
          </Text>
        );
      case "del":
        return (
          <Text key={i} style={m.del}>
            {inline((t as Tokens.Del).tokens, tone)}
          </Text>
        );
      case "codespan":
        return (
          <Text key={i} style={m.codespan}>
            {(t as Tokens.Codespan).text}
          </Text>
        );
      case "link": {
        const l = t as Tokens.Link;
        return (
          <Text key={i} style={m.link} accessibilityRole="link" onPress={() => void Linking.openURL(l.href).catch(() => undefined)}>
            {inline(l.tokens, tone)}
          </Text>
        );
      }
      case "br":
        return "\n";
      case "escape":
        return (t as Tokens.Escape).text;
      case "text": {
        const x = t as Tokens.Text;
        return x.tokens ? <Text key={i}>{inline(x.tokens, tone)}</Text> : decode(x.text);
      }
      default:
        return "text" in t ? decode(String(t.text)) : "raw" in t ? String(t.raw) : null;
    }
  });
}

/** marked escapes these for HTML; native text wants them back. */
function decode(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[e] ?? _);
}

const m = StyleSheet.create({
  p: { color: colors.text, fontSize: 15, lineHeight: 22, marginVertical: 4 },
  dim: { color: colors.muted },
  h1: { fontSize: 18, fontWeight: "700", marginTop: 10 },
  h3: { fontSize: 16, fontWeight: "700", marginTop: 8 },
  strong: { fontWeight: "700" },
  em: { fontStyle: "italic" },
  del: { textDecorationLine: "line-through" },
  codespan: { fontFamily: mono, fontSize: 13, backgroundColor: colors.code, color: colors.codeText },
  link: { color: colors.accent, textDecorationLine: "underline" },
  codeBlock: { backgroundColor: colors.code, borderColor: colors.border, borderWidth: 1, borderRadius: 8, padding: 10, marginVertical: 6 },
  lang: { color: colors.faint, fontSize: 11, marginBottom: 4, fontFamily: mono },
  code: { fontFamily: mono, fontSize: 13, lineHeight: 19, color: colors.codeText },
  quote: { borderLeftWidth: 3, borderLeftColor: colors.border, paddingLeft: 10, marginVertical: 4 },
  list: { marginVertical: 2 },
  item: { flexDirection: "row", gap: 6 },
  bullet: { minWidth: 18, color: colors.muted },
  tableWrap: { marginVertical: 6 },
  tr: { flexDirection: "row" },
  td: { color: colors.text, fontSize: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, paddingHorizontal: 8, paddingVertical: 6, minWidth: 80, maxWidth: 260 },
  th: { fontWeight: "700", backgroundColor: colors.panel },
  hr: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: 10 },
});

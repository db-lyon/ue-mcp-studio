/**
 * Inline type the web client sets inside body text: `.small` (12 px on the
 * theme's line ratio) and `.mono` (the theme's mono at 0.92 of the text it
 * sits in).
 */
import type { TextStyle } from "react-native";
import { font } from "./Text";
import type { Theme, Weight } from "./theme";

/** `.small`: 12 px on the body's line ratio (1.55 in ue-mcp, 1.5 in the editor themes). */
export function smallFont(t: Theme, weight: Weight = 400): TextStyle {
  return { ...font(t, "sans", weight, 12), lineHeight: 12 * (t.base.lineHeight / t.base.size) };
}

/** `.mono` inside text of `size` (the body's by default). */
export function monoFont(t: Theme, size = t.base.size, weight: Weight = 400): TextStyle {
  const s = size * 0.92;
  return { ...font(t, "mono", weight, s), lineHeight: s * (t.base.lineHeight / t.base.size) };
}

/** `.banner.warn`: the warn wash in ue-mcp; the editor themes draw it on panel-2 with a full warn border and plain text. */
export function warnBanner(t: Theme): { box: { backgroundColor: string; borderColor: string }; color: string } {
  return t.editor ? { box: { backgroundColor: t.c.panel2, borderColor: t.c.warn }, color: t.c.text } : { box: { backgroundColor: t.c.warnWash, borderColor: t.c.warnLine }, color: t.c.warnText };
}

/** `.card`'s frame: the hairline, faint top tint and drop shadow in ue-mcp; no border, tint or shadow in the editor themes. */
export function cardFrame(t: Theme): object {
  return t.editor
    ? { backgroundColor: t.c.panel, borderColor: "transparent", borderWidth: 1, borderRadius: t.radiusLg }
    : { backgroundColor: t.c.panel, borderColor: t.c.line, borderWidth: 1, borderRadius: t.radiusLg, backgroundImage: `linear-gradient(180deg, ${t.c.tint}, transparent 120px)`, boxShadow: "0px 20px 40px -24px rgba(0, 0, 0, 0.6)" };
}

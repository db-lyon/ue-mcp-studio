/**
 * Text in the web client's type styles. `font` picks the family the theme
 * gives that role (sans, mono, serif) and `weight` the face, since React
 * Native chooses a custom font's weight by its name.
 */
import { Text, type TextProps, type TextStyle } from "react-native";
import { fontName, lineBox, type Theme, type Weight } from "./theme";
import { useTheme } from "./ThemeProvider";

export type Role = "sans" | "mono" | "serif";

/** A text style in a theme's family for `role` at `weight`, `size` px, `lh` line-height multiple (as CSS writes it, laid out as `lineBox` says). */
export function font(t: Theme, role: Role, weight: Weight, size: number, lh?: number, italic = false): TextStyle {
  const family = role === "sans" ? t.sans : role === "mono" ? t.mono : t.serif;
  return {
    fontFamily: fontName(family, weight, italic),
    fontSize: size,
    ...(lh ? { lineHeight: lineBox(size, lh) } : {}),
    ...(family === "system-mono" && weight >= 600 ? { fontWeight: "700" } : {}),
  };
}

/** --base-font in the text colour. */
export function baseFont(t: Theme): TextStyle {
  return { ...font(t, "sans", 400, t.base.size), lineHeight: t.base.lineHeight, color: t.c.text };
}

/** The eyebrow / h2 label: --label-font, its case and spacing, in --label-color unless given another. */
export function labelFont(t: Theme, color?: string): TextStyle {
  const l = t.label;
  return {
    fontFamily: fontName(l.family, l.weight),
    fontSize: l.size,
    lineHeight: l.lineHeight,
    letterSpacing: l.spacing,
    textTransform: l.upper ? "uppercase" : "none",
    color: color ?? l.color,
  };
}

type Tone = "text" | "muted" | "dim" | "accent" | "ok" | "warn" | "bad" | "badText" | "warnText" | "onAccent";

export interface TProps extends Omit<TextProps, "role"> {
  /** The font role: sans, mono or serif (not the accessibility role). */
  role?: Role;
  weight?: Weight;
  size?: number;
  /** Line height as a multiple of the size, as CSS writes it. */
  lh?: number;
  tone?: Tone;
  italic?: boolean;
  /** The eyebrow label style. */
  label?: boolean;
}

/** Body text by default (--base-font, --text). */
export function T({ role = "sans", weight = 400, size, lh, tone, italic, label, style, ...rest }: TProps) {
  const t = useTheme();
  const base: TextStyle = label ? labelFont(t) : size === undefined && role === "sans" && weight === 400 && !lh ? baseFont(t) : { ...font(t, role, weight, size ?? t.base.size, lh ?? 1.55, italic), color: t.c.text };
  const color = tone ? { color: t.c[tone] } : null;
  return <Text {...rest} style={[base, color, style]} />;
}

/**
 * Studio's web look as React Native values: the ue-mcp theme's tokens from
 * apps/client-web/src/styles.css, its fonts, and the type it sets text in, so
 * a screen ported from the web client measures as the web client does at
 * phone width. color-mix() values are worked out here.
 */
import { Platform, type TextStyle, type ViewStyle } from "react-native";

export const css = {
  bg: "#0c0c0b",
  panel: "#131312",
  panel2: "#1a1a18",
  panel3: "#222220",
  line: "rgba(255, 255, 255, 0.07)",
  lineStrong: "rgba(255, 255, 255, 0.12)",
  text: "#ece9e3",
  muted: "#b3b0a8",
  dim: "#8a8985",
  disabledLine: "#6a6762",
  accent: "#e8720c",
  accentHi: "#f28a2e",
  accentWash: "rgba(232, 114, 12, 0.08)",
  accentLine: "rgba(232, 114, 12, 0.35)",
  onAccent: "#140a02",
  ok: "#6cc08b",
  warn: "#e0a43a",
  bad: "#e5604f",
  badText: "#f2b3aa",
  warnText: "#efd09a",
  tint: "rgba(255, 255, 255, 0.018)",
  codeBg: "#0f0f0e",
  codeText: "#d6d3cc",
  /** color-mix(in srgb, <tone> 45%, transparent): a pill's border. */
  ok45: "rgba(108, 192, 139, 0.45)",
  warn45: "rgba(224, 164, 58, 0.45)",
  bad45: "rgba(229, 96, 79, 0.45)",
  /** A banner's wash and border. */
  bad10: "rgba(229, 96, 79, 0.10)",
  bad30: "rgba(229, 96, 79, 0.30)",
  warn9: "rgba(224, 164, 58, 0.09)",
  warn30: "rgba(224, 164, 58, 0.30)",
  warn40: "rgba(224, 164, 58, 0.40)",
  ok10: "rgba(108, 192, 139, 0.10)",
  ok30: "rgba(108, 192, 139, 0.30)",
  radius: 6,
  radiusLg: 10,
} as const;

/** The web client's faces: Plus Jakarta Sans for text, JetBrains Mono for labels and controls. */
export const fonts = {
  sans: Platform.select({ web: '"Plus Jakarta Sans Variable", "Plus Jakarta Sans", system-ui, "Segoe UI", sans-serif', default: "PlusJakartaSans" }),
  mono: Platform.select({ web: '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, Consolas, monospace', default: "JetBrainsMono" }),
} as const;

/** Text at the web client's base size: 13.5 px on a 1.55 line. */
export const base: TextStyle = { fontFamily: fonts.sans, fontSize: 13.5, lineHeight: 20.925, color: css.text };
/** `.small` inside base text: 12 px on the same 1.55 line. */
export const small: TextStyle = { fontSize: 12, lineHeight: 18.6 };
/** `.mono` inside text of a size: the mono face at 0.92 of it. */
export const monoOf = (size: number, line = size * 1.55): TextStyle => ({ fontFamily: fonts.mono, fontSize: size * 0.92, lineHeight: line });

/** A CSS gradient as a background, on the web and on the phone. */
export function gradient(value: string): ViewStyle {
  return (Platform.OS === "web" ? { backgroundImage: value } : { experimental_backgroundImage: value }) as ViewStyle;
}

/** A CSS box-shadow, as both renderers take it. */
export const shadow = (value: string): ViewStyle => ({ boxShadow: value }) as ViewStyle;

/** `.card`: the panel with its faint top tint, a hairline border and the drop shadow. */
export const card: ViewStyle = {
  backgroundColor: css.panel,
  borderWidth: 1,
  borderColor: css.line,
  borderRadius: css.radiusLg,
  ...gradient(`linear-gradient(180deg, ${css.tint}, transparent 120px)`),
  ...shadow("0 20px 40px -24px rgba(0, 0, 0, 0.6)"),
};

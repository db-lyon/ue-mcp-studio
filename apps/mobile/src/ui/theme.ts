/**
 * Studio's three themes as the web client draws them on a phone
 * (apps/client-web/src/styles.css): `ue-mcp`, the fixed ue-mcp.com palette;
 * `editor`, Unreal's default dark Slate theme (a phone cannot read the
 * editor's own); `editor-orange`, `editor` with the ue-mcp orange. Every value
 * is the CSS variable of the same name, color-mix() worked out to rgba.
 */
import { Platform } from "react-native";
import type { StudioTheme } from "@ue-mcp-studio/shared";

export type ThemeName = StudioTheme;

export interface Tokens {
  bg: string;
  panel: string;
  panel2: string;
  panel3: string;
  line: string;
  lineStrong: string;
  text: string;
  muted: string;
  dim: string;
  disabledLine: string;
  accent: string;
  accentHi: string;
  accentDeep: string;
  accentWash: string;
  accentLine: string;
  onAccent: string;
  ok: string;
  warn: string;
  bad: string;
  badText: string;
  warnText: string;
  diffBefore: string;
  diffAfter: string;
  glow: string;
  selection: string;
  barBg: string;
  tint: string;
  codeBg: string;
  codeText: string;
  composerBg: string;
  /** color-mix(var(--x) N%, transparent), for banners, pills and diff rows. */
  okWash: string;
  okLine: string;
  warnWash: string;
  warnLine: string;
  badWash: string;
  badLine: string;
  okPill: string;
  warnPill: string;
  badPill: string;
}

export interface Theme {
  name: ThemeName;
  c: Tokens;
  radius: number;
  radiusLg: number;
  /** Font families: sans, mono, serif, each by weight. */
  sans: FontFamily;
  mono: FontFamily;
  serif: FontFamily;
  /** --label-font and friends: the eyebrow/h2 style. */
  label: { family: FontFamily; weight: Weight; size: number; lineHeight: number; upper: boolean; spacing: number; color: string };
  /** --base-font: body text. */
  base: { size: number; lineHeight: number };
  /** The editor themes draw flat controls in the sans font; ue-mcp's are mono. */
  editor: boolean;
  shadow: boolean;
  markGlow: boolean;
}

export type Weight = 400 | 500 | 600 | 700;
export type FontFamily = "jakarta" | "jetbrains" | "instrument" | "roboto" | "system-mono";

/**
 * A CSS line-height written as a multiple (`13.5px/1.55`), in the px a browser
 * lays it out at: the product cut down to Chrome's 1/64 px layout unit. A px
 * line-height is rounded to that unit instead, so passing the raw product
 * (19.2 for 12px/1.6) puts each line 1/64 px lower than the web client's and
 * a long transcript drifts by a pixel. Write px line-heights from the CSS as is.
 */
export function lineBox(size: number, multiple: number): number {
  return Math.floor(size * multiple * 64 + 1e-6) / 64;
}

/** The loaded font's name for a family at a weight: React Native picks faces by name, not by weight. */
export function fontName(family: FontFamily, weight: Weight = 400, italic = false): string | undefined {
  switch (family) {
    case "jakarta":
      return { 400: "PlusJakartaSans_400Regular", 500: "PlusJakartaSans_500Medium", 600: "PlusJakartaSans_600SemiBold", 700: "PlusJakartaSans_700Bold" }[weight];
    case "jetbrains":
      return { 400: "JetBrainsMono_400Regular", 500: "JetBrainsMono_500Medium", 600: "JetBrainsMono_600SemiBold", 700: "JetBrainsMono_700Bold" }[weight];
    case "instrument":
      return italic ? "InstrumentSerif_400Regular_Italic" : "InstrumentSerif_400Regular";
    case "roboto":
      // The web client loads Roboto 400 and 700 only, so 500 and 600 draw as the browser's synthesis of those.
      return weight >= 600 ? "Roboto_700Bold" : "Roboto_400Regular";
    case "system-mono":
      // The editor themes' --mono stack, as the web build draws it; on a device the system monospace, which is where
      // a phone's browser lands on that stack too (no Consolas there).
      return Platform.select({ web: "Consolas, ui-monospace, monospace", ios: "Menlo", default: "monospace" });
  }
}

const mix = (hex: string, pct: number): string => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${pct / 100})`;
};

function washes(ok: string, warn: string, bad: string) {
  return {
    okWash: mix(ok, 10),
    okLine: mix(ok, 30),
    warnWash: mix(warn, 9),
    warnLine: mix(warn, 30),
    badWash: mix(bad, 10),
    badLine: mix(bad, 30),
    okPill: mix(ok, 45),
    warnPill: mix(warn, 45),
    badPill: mix(bad, 45),
  };
}

const UE_MCP: Tokens = {
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
  accentDeep: "#8f4507",
  accentWash: "rgba(232, 114, 12, 0.08)",
  accentLine: "rgba(232, 114, 12, 0.35)",
  onAccent: "#140a02",
  ok: "#6cc08b",
  warn: "#e0a43a",
  bad: "#e5604f",
  badText: "#f2b3aa",
  warnText: "#efd09a",
  diffBefore: "rgba(229, 96, 79, 0.05)",
  diffAfter: "rgba(108, 192, 139, 0.05)",
  glow: "rgba(232, 114, 12, 0.07)",
  selection: "rgba(232, 114, 12, 0.35)",
  barBg: "rgba(12, 12, 11, 0.8)",
  tint: "rgba(255, 255, 255, 0.018)",
  codeBg: "#0f0f0e",
  codeText: "#d6d3cc",
  composerBg: "rgba(0, 0, 0, 0.15)",
  ...washes("#6cc08b", "#e0a43a", "#e5604f"),
};

/** Unreal's default dark Slate theme (theme.ts EDITOR_DEFAULT). */
const UE = {
  background: "#151515",
  recessed: "#1a1a1a",
  panel: "#242424",
  header: "#2f2f2f",
  input: "#0f0f0f",
  dropdown: "#383838",
  dropdownOutline: "#4c4c4c",
  hover: "#575757",
  foreground: "#c0c0c0",
  foregroundHeader: "#c8c8c8",
  primary: "#0070e0",
  primaryHover: "#0e86ff",
  select: "#0070e0",
  warning: "#ffb800",
  error: "#ef3535",
  success: "#1fe44b",
};

/** color-mix(in srgb, foreground 75%, panel): the editor themes' muted and dim. */
const EDITOR_MUTED = "#999999";

const EDITOR: Tokens = {
  bg: UE.background,
  panel: UE.panel,
  panel2: UE.dropdown,
  panel3: UE.hover,
  line: UE.header,
  lineStrong: UE.dropdownOutline,
  text: UE.foreground,
  muted: EDITOR_MUTED,
  dim: EDITOR_MUTED,
  disabledLine: "#767676",
  accent: UE.primary,
  accentHi: UE.primaryHover,
  accentDeep: "#8f4507",
  accentWash: mix(UE.select, 18),
  accentLine: UE.select,
  onAccent: "#ffffff",
  ok: UE.success,
  warn: UE.warning,
  bad: UE.error,
  badText: UE.foreground,
  warnText: UE.foreground,
  diffBefore: "rgba(239, 53, 53, 0.07)",
  diffAfter: "rgba(31, 228, 75, 0.05)",
  glow: "transparent",
  selection: mix(UE.select, 45),
  barBg: UE.recessed,
  tint: "transparent",
  codeBg: UE.input,
  codeText: UE.foreground,
  composerBg: UE.recessed,
  ...washes(UE.success, UE.warning, UE.error),
};

const EDITOR_ORANGE: Tokens = {
  ...EDITOR,
  accent: "#e8720c",
  accentHi: "#f28a2e",
  accentWash: "rgba(232, 114, 12, 0.18)",
  accentLine: "#e8720c",
  onAccent: "#140a02",
  selection: "rgba(232, 114, 12, 0.45)",
};

const ueMcp: Theme = {
  name: "ue-mcp",
  c: UE_MCP,
  radius: 6,
  radiusLg: 10,
  sans: "jakarta",
  mono: "jetbrains",
  serif: "instrument",
  label: { family: "jetbrains", weight: 600, size: 10.5, lineHeight: lineBox(10.5, 1.3), upper: true, spacing: 0.16 * 10.5, color: UE_MCP.accent },
  base: { size: 13.5, lineHeight: lineBox(13.5, 1.55) },
  editor: false,
  shadow: true,
  markGlow: true,
};

const editorBase = (c: Tokens, name: ThemeName): Theme => ({
  name,
  c,
  radius: 4,
  radiusLg: 4,
  sans: "roboto",
  mono: "system-mono",
  serif: "roboto",
  label: { family: "roboto", weight: 700, size: 12, lineHeight: lineBox(12, 1.3), upper: false, spacing: 0, color: UE.foregroundHeader },
  base: { size: 12.5, lineHeight: lineBox(12.5, 1.5) },
  editor: true,
  shadow: false,
  markGlow: false,
});

export const THEMES: Record<ThemeName, Theme> = {
  "ue-mcp": ueMcp,
  editor: editorBase(EDITOR, "editor"),
  "editor-orange": editorBase(EDITOR_ORANGE, "editor-orange"),
};

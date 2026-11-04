/**
 * Studio's three themes as tokens, value for value from client-web's
 * styles.css (`:root`, `[data-theme="editor"]`, `[data-theme="editor-orange"]`),
 * with each color-mix() worked out, and the theme in effect for the screens
 * under a StudioThemeProvider. The editor themes use Unreal's default dark
 * palette, as a browser does when the editor cannot say.
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { STUDIO_THEMES, type StudioTheme } from "@ue-mcp-studio/shared";

export interface Font {
  family: string;
  weight: "400" | "500" | "600" | "700";
  size: number;
  /** In pixels, as the web works it out from a unitless line-height. */
  lineHeight: number;
}

export interface StudioTokens {
  theme: StudioTheme;
  /** ue-mcp, or one of the editor themes, which share Unreal's type and flat controls. */
  editor: boolean;
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
  accentWash: string;
  accentLine: string;
  onAccent: string;
  ok: string;
  warn: string;
  bad: string;
  badText: string;
  warnText: string;
  glow: string;
  tint: string;
  codeBg: string;
  codeText: string;
  barBg: string;
  radius: number;
  radiusLg: number;
  sans: string;
  mono: string;
  /** --label-font, --label-case, --label-spacing, --label-color: card titles and eyebrows. */
  label: Font & { upper: boolean; spacing: number; color: string };
  /** --base-font: body text. */
  base: Font;
  /** A button's type: mono on ue-mcp, the editor's sans on the editor themes. */
  button: Font & { spacing: number };
  /** color-mix(in srgb, <c> p%, transparent). */
  mix(color: string, percent: number): string;
}

/** A #rrggbb colour at an alpha, as color-mix with transparent gives. */
export function mix(color: string, percent: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!m) return color;
  const a = Math.round(percent * 100) / 10000;
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${a})`;
}

const SANS = '"Plus Jakarta Sans Variable", "Plus Jakarta Sans", system-ui, "Segoe UI", sans-serif';
const MONO = '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, Consolas, monospace';
const ROBOTO = '"Roboto", "Segoe UI", system-ui, sans-serif';
const CONSOLAS = "Consolas, ui-monospace, monospace";

const UE_MCP: StudioTokens = {
  theme: "ue-mcp",
  editor: false,
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
  glow: "rgba(232, 114, 12, 0.07)",
  tint: "rgba(255, 255, 255, 0.018)",
  codeBg: "#0f0f0e",
  codeText: "#d6d3cc",
  barBg: "rgba(12, 12, 11, 0.8)",
  radius: 6,
  radiusLg: 10,
  sans: SANS,
  mono: MONO,
  label: { family: MONO, weight: "600", size: 10.5, lineHeight: 13.65, upper: true, spacing: 1.68, color: "#e8720c" },
  base: { family: SANS, weight: "400", size: 13.5, lineHeight: 20.925 },
  button: { family: MONO, weight: "500", size: 11.5, lineHeight: 13.8, spacing: 0.23 },
  mix,
};

/** Unreal's default dark palette; muted and dim are the foreground 75% over the panel. */
const EDITOR: StudioTokens = {
  ...UE_MCP,
  theme: "editor",
  editor: true,
  bg: "#151515",
  panel: "#242424",
  panel2: "#383838",
  panel3: "#575757",
  line: "#2f2f2f",
  lineStrong: "#4c4c4c",
  text: "#c0c0c0",
  muted: "#999999",
  dim: "#999999",
  disabledLine: "#767676",
  accent: "#0070e0",
  accentHi: "#0e86ff",
  accentWash: "rgba(0, 112, 224, 0.18)",
  accentLine: "#0070e0",
  onAccent: "#ffffff",
  ok: "#1fe44b",
  warn: "#ffb800",
  bad: "#ef3535",
  badText: "#c0c0c0",
  warnText: "#c0c0c0",
  glow: "transparent",
  tint: "transparent",
  codeBg: "#0f0f0f",
  codeText: "#c0c0c0",
  barBg: "#1a1a1a",
  radius: 4,
  radiusLg: 4,
  sans: ROBOTO,
  mono: CONSOLAS,
  label: { family: ROBOTO, weight: "700", size: 12, lineHeight: 15.6, upper: false, spacing: 0, color: "#c8c8c8" },
  base: { family: ROBOTO, weight: "400", size: 12.5, lineHeight: 18.75 },
  button: { family: ROBOTO, weight: "400", size: 12, lineHeight: 14.4, spacing: 0 },
};

const EDITOR_ORANGE: StudioTokens = {
  ...EDITOR,
  theme: "editor-orange",
  accent: "#e8720c",
  accentHi: "#f28a2e",
  accentWash: "rgba(232, 114, 12, 0.18)",
  accentLine: "#e8720c",
  onAccent: "#140a02",
};

export const STUDIO_TOKENS: Record<StudioTheme, StudioTokens> = { "ue-mcp": UE_MCP, editor: EDITOR, "editor-orange": EDITOR_ORANGE };

export const tokensOf = (theme: string | null | undefined): StudioTokens => STUDIO_TOKENS[(STUDIO_THEMES as readonly string[]).includes(theme ?? "") ? (theme as StudioTheme) : "ue-mcp"];

interface ThemeState {
  t: StudioTokens;
  /** Switch the app's theme now; Settings saves it on the computer too. */
  setTheme(theme: StudioTheme): void;
}

const ThemeContext = createContext<ThemeState>({ t: UE_MCP, setTheme: () => undefined });

export function StudioThemeProvider({ theme, onTheme, children }: { theme: StudioTheme; onTheme: (t: StudioTheme) => void; children: ReactNode }) {
  const value = useMemo(() => ({ t: tokensOf(theme), setTheme: onTheme }), [theme, onTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export const useStudioTheme = (): ThemeState => useContext(ThemeContext);
export const useTokens = (): StudioTokens => useContext(ThemeContext).t;

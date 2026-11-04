/**
 * The card glyphs on the web build (Expo web, the visual QA pages and the
 * component tests): the same paths as glyphs.tsx, drawn as plain SVG, since
 * react-native-svg's web build needs the native asset registry.
 */
import { useTheme } from "./ThemeProvider";

const PATHS = {
  play: "M5 3.5v9l7.5-4.5z",
  stop: "M4.5 4.5h7v7h-7z",
  assign: "M8 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM3 13.5c.8-2.2 2.7-3.5 5-3.5s4.2 1.3 5 3.5",
  cancel: "M4 4l8 8M12 4l-8 8",
  edit: "M10.5 2.5l3 3L6 13H3v-3z",
  trash: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5",
} as const;
const FILLED = new Set(["play", "stop"]);

export type GlyphName = keyof typeof PATHS;

export function Glyph({ name, color, size = 14 }: { name: GlyphName; color?: string; size?: number }) {
  const t = useTheme();
  color ??= t.c.muted;
  const fill = FILLED.has(name);
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill={fill ? color : "none"} stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: "block" }}>
      <path d={PATHS[name]} />
    </svg>
  );
}

export function OptionsGlyph({ color, knob }: { color?: string; knob?: string }) {
  const t = useTheme();
  color ??= t.c.muted;
  knob ??= t.c.panel2;
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" aria-hidden="true" style={{ display: "block" }}>
      <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
      <circle cx={5.5} cy={4} r={1.6} fill={knob} />
      <circle cx={10.5} cy={8} r={1.6} fill={knob} />
      <circle cx={7} cy={12} r={1.6} fill={knob} />
    </svg>
  );
}

export function Chevron({ open, color, size = 12 }: { open: boolean; color?: string; size?: number }) {
  const t = useTheme();
  color ??= t.c.muted;
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: "block", transform: open ? "rotate(90deg)" : undefined, opacity: 0.85 }}>
      <path d="M4.5 2.5 8 6l-3.5 3.5" />
    </svg>
  );
}

/**
 * The web client's line glyphs, drawn with react-native-svg from the same
 * paths: a card's play, stop, assign, cancel, edit and delete, the options
 * sliders, and the disclosure chevron.
 */
import Svg, { Circle, Path } from "react-native-svg";
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

/** A 14 point card glyph in the given colour. */
export function Glyph({ name, color, size = 14 }: { name: GlyphName; color?: string; size?: number }) {
  const t = useTheme();
  color ??= t.c.muted;
  const fill = FILLED.has(name);
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16" fill={fill ? color : "none"} stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <Path d={PATHS[name]} />
    </Svg>
  );
}

/** Start playtest's options: three sliders. `knob` is the panel the knobs sit on. */
export function OptionsGlyph({ color, knob }: { color?: string; knob?: string }) {
  const t = useTheme();
  color ??= t.c.muted;
  knob ??= t.c.panel2;
  return (
    <Svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" aria-hidden>
      <Path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
      <Circle cx={5.5} cy={4} r={1.6} fill={knob} />
      <Circle cx={10.5} cy={8} r={1.6} fill={knob} />
      <Circle cx={7} cy={12} r={1.6} fill={knob} />
    </Svg>
  );
}

/** The disclosure mark: a chevron that points right, or down when open. */
export function Chevron({ open, color, size = 12 }: { open: boolean; color?: string; size?: number }) {
  const t = useTheme();
  color ??= t.c.muted;
  return (
    <Svg width={size} height={size} viewBox="0 0 12 12" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" style={{ transform: [{ rotate: open ? "90deg" : "0deg" }], opacity: 0.85 }} aria-hidden>
      <Path d="M4.5 2.5 8 6l-3.5 3.5" />
    </Svg>
  );
}

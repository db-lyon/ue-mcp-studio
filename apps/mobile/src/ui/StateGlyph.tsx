/**
 * The 40 point line glyphs a whole-page state leads with (the relay's
 * pairing pages and Studio's lock screen): a phone, the padlock, a tick, a
 * clock, a camera (struck through when refused); and the 18 point warning sign an error panel's
 * head carries. Drawn from the relay's own paths, in the accent unless said.
 * The space under a glyph is the relay's: the line box its inline svg sits in.
 */
import Svg, { Circle, Path, Rect } from "react-native-svg";
import { useTheme } from "./ThemeProvider";

export type StateGlyphName = "phone" | "lock" | "done" | "expired" | "camera" | "camera-off";

export function StateGlyph({ name, color }: { name: StateGlyphName; color?: string }) {
  const t = useTheme();
  const stroke = color ?? (name === "done" ? t.c.ok : t.c.accent);
  return (
    <Svg width={40} height={40} viewBox="0 0 40 40" fill="none" stroke={stroke} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 10 }} aria-hidden>
      {name === "phone" ? (
        <>
          <Rect x={12} y={5} width={16} height={30} rx={3} />
          <Path d="M18 30h4" />
        </>
      ) : name === "lock" ? (
        <>
          <Rect x={9} y={18} width={22} height={16} rx={3} />
          <Path d="M14 18v-5a6 6 0 0 1 12 0v5" />
        </>
      ) : name === "done" ? (
        <>
          <Circle cx={20} cy={20} r={14} />
          <Path d="M13.5 20.5l4.5 4.5 8.5-9" />
        </>
      ) : name === "expired" ? (
        <>
          <Circle cx={20} cy={20} r={14} />
          <Path d="M20 12v8l5 3" />
        </>
      ) : (
        <>
          <Path d="M6 15a3 3 0 0 1 3-3h4l2.5-4h9l2.5 4h4a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3z" />
          <Circle cx={20} cy={21.5} r={5.5} />
          {name === "camera-off" ? <Path d="M5 5l30 30" /> : null}
        </>
      )}
    </Svg>
  );
}

/** The warning sign at the head of an error panel, in the bad colour. */
export function WarnGlyph({ color, size = 18 }: { color?: string; size?: number }) {
  const t = useTheme();
  return (
    <Svg width={size} height={size} viewBox="0 0 40 40" fill="none" stroke={color ?? t.c.bad} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden>
      <Path d="M20 6L35 32H5z" />
      <Path d="M20 16v7M20 27.5v.5" />
    </Svg>
  );
}

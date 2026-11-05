/**
 * The page's glow, as the web client's body paints it under everything:
 * radial-gradient(900px 420px at 50% -120px, var(--glow), transparent 70%)
 * over --bg, fixed to the viewport. `top` is where the viewport starts (the
 * safe area's top on a phone). Nothing is drawn where --glow is transparent.
 */
import { StyleSheet, View } from "react-native";
import Svg, { Defs, RadialGradient, Rect, Stop } from "react-native-svg";
import { useTheme } from "./ThemeProvider";
import { stopOf } from "./gradient";

/** The ellipse's radii and centre above the viewport, and where it has faded out. */
export const GLOW = { rx: 900, ry: 420, y: -120, fade: 0.7 };


export function PageGlow({ top = 0 }: { top?: number }) {
  const t = useTheme();
  if (!t.c.glow || t.c.glow === "transparent") return null;
  const stop = stopOf(t.c.glow);
  const height = top + GLOW.y + GLOW.ry * GLOW.fade;
  if (height <= 0) return null;
  return (
    <View testID="page-glow" pointerEvents="none" style={[StyleSheet.absoluteFill, { bottom: undefined, height }]}>
      <Svg width="100%" height={height}>
        <Defs>
          {/* A circle of the ellipse's width squashed to its height about its centre; userSpaceOnUse keeps the radii in px. */}
          <RadialGradient
            id="pageGlow"
            gradientUnits="userSpaceOnUse"
            cx="50%"
            cy={0}
            r={GLOW.rx}
            gradientTransform={`translate(0 ${top + GLOW.y}) scale(1 ${GLOW.ry / GLOW.rx})`}
          >
            <Stop offset="0" stopColor={stop.color} stopOpacity={stop.opacity} />
            <Stop offset={String(GLOW.fade)} stopColor={stop.color} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height={height} fill="url(#pageGlow)" />
      </Svg>
    </View>
  );
}

/**
 * <details>: a summary line that opens what is under it, with the browser's
 * disclosure triangle before it. On a touch screen the summary is 44px tall.
 */
import { useState, type ReactNode } from "react";
import { Pressable, View, type StyleProp, type ViewStyle } from "react-native";
import Svg, { Path } from "react-native-svg";
import { useTheme } from "../../ui";

export function Details({ summary, children, startOpen, marker = true, style, summaryStyle, label, testID, onToggle }: {
  summary: ReactNode | ((open: boolean) => ReactNode);
  children: ReactNode;
  startOpen?: boolean;
  /** The disclosure triangle; off where the page hides it (list-style: none). */
  marker?: boolean;
  style?: StyleProp<ViewStyle>;
  summaryStyle?: StyleProp<ViewStyle>;
  label?: string;
  testID?: string;
  onToggle?: (open: boolean) => void;
}) {
  const t = useTheme();
  const [open, setOpen] = useState(!!startOpen);
  return (
    <View testID={testID} style={style}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ expanded: open }}
        onPress={() => {
          setOpen(!open);
          onToggle?.(!open);
        }}
        // A summary on a touch screen is 44px tall with its line at the top, as a browser lays one out.
        style={[{ flexDirection: "row", alignItems: "flex-start", minHeight: 44 }, summaryStyle]}
      >
        {marker ? <Triangle open={open} color={t.c.dim} lineHeight={12 * (t.base.lineHeight / t.base.size)} /> : null}
        {typeof summary === "function" ? summary(open) : summary}
      </Pressable>
      {open ? children : null}
    </View>
  );
}

/**
 * The browser's disclosure marker for a 12px summary: a filled triangle about
 * half an em wide, right when closed and down when open, in a box 1.06em wide,
 * centred on the summary's first line.
 */
export function Triangle({ open, color, size = 12, lineHeight = 18.6 }: { open: boolean; color: string; size?: number; lineHeight?: number }) {
  const w = size * 0.5;
  const h = size * 0.58;
  return (
    <View style={{ width: size * 1.06, height: lineHeight, justifyContent: "center" }}>
      <Svg width={open ? h : w} height={open ? w : h} viewBox={open ? `0 0 ${h} ${w}` : `0 0 ${w} ${h}`}>
        <Path d={open ? `M0 0H${h}L${h / 2} ${w}Z` : `M0 0L${w} ${h / 2}L0 ${h}Z`} fill={color} />
      </Svg>
    </View>
  );
}

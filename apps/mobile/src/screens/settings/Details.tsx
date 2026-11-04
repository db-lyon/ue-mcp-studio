/**
 * <details>: a summary line that opens what is under it, with the browser's
 * disclosure triangle before it. On a touch screen the summary is 44px tall.
 */
import { useState, type ReactNode } from "react";
import { Pressable, View, type StyleProp, type ViewStyle } from "react-native";
import { T, useTheme } from "../../ui";

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
        style={[{ flexDirection: "row", alignItems: "center", minHeight: 44 }, summaryStyle]}
      >
        {marker ? <Triangle open={open} color={t.c.dim} /> : null}
        {typeof summary === "function" ? summary(open) : summary}
      </Pressable>
      {open ? children : null}
    </View>
  );
}

/** The browser's disclosure marker: a small filled triangle, right when closed, down when open. */
export function Triangle({ open, color, size = 12 }: { open: boolean; color: string; size?: number }) {
  return <T style={{ color, fontSize: size * 0.75, lineHeight: size * 1.55, width: size * 0.92, marginRight: 0 }}>{open ? "▾" : "▸"}</T>;
}

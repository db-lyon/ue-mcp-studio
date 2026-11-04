/**
 * chat/Diff.tsx and .output.diff: removed lines red, added green, left-out
 * runs one dim italic line; each line its sign in a 2ch gutter and its text
 * wrapping beside it, behind a hairline in its own colour.
 */
import { ScrollView, View, type StyleProp, type ViewStyle } from "react-native";
import type { DiffLine } from "@ue-mcp-studio/shared";
import { font, T } from "./Text";
import { useTheme } from "./ThemeProvider";

const withAlpha = (rgb: string, a: number) => {
  if (rgb.startsWith("#")) {
    const n = parseInt(rgb.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  return rgb;
};

/** .output: code-bg, hairline, 8px radius, 12px/1.6 mono in --code-text, scrolling past `maxHeight`. */
export function Output({ children, maxHeight, style, label }: { children: React.ReactNode; maxHeight?: number; style?: StyleProp<ViewStyle>; label?: string }) {
  const t = useTheme();
  return (
    <View accessibilityLabel={label} style={[{ backgroundColor: t.c.codeBg, borderColor: t.c.line, borderWidth: 1, borderRadius: 8, maxHeight, overflow: "hidden" }, style]}>
      <ScrollView nestedScrollEnabled style={{ maxHeight }} contentContainerStyle={{ paddingVertical: 10, paddingHorizontal: 12 }}>
        {typeof children === "string" ? <T style={{ ...font(t, "mono", 400, 12, 1.6), color: t.c.codeText }} selectable>{children}</T> : children}
      </ScrollView>
    </View>
  );
}

export function DiffView({ lines, label, maxHeight }: { lines: DiffLine[]; label?: string; maxHeight?: number }) {
  const t = useTheme();
  const mono = font(t, "mono", 400, 12, 1.6);
  if (lines.length === 0)
    return (
      <Output maxHeight={maxHeight} label={label}>
        <T style={{ ...mono, color: t.c.dim }}>No change.</T>
      </Output>
    );
  return (
    <View accessibilityLabel={label} style={{ backgroundColor: t.c.codeBg, borderColor: t.c.line, borderWidth: 1, borderRadius: 8, maxHeight, overflow: "hidden" }}>
      <ScrollView nestedScrollEnabled style={{ maxHeight }} contentContainerStyle={{ paddingVertical: 8 }}>
        {lines.map((l, i) => {
          if (l.op === "gap")
            return (
              <T key={i} style={{ ...mono, color: t.c.dim, fontStyle: "italic", paddingHorizontal: 12 }}>
                {`  ${l.count} unchanged ${l.count === 1 ? "line" : "lines"}`}
              </T>
            );
          const color = l.op === "+" ? t.c.ok : l.op === "-" ? t.c.badText : t.c.muted;
          const bg = l.op === "+" ? "rgba(108, 192, 139, 0.12)" : l.op === "-" ? "rgba(229, 96, 79, 0.12)" : "transparent";
          return (
            <View key={i} style={{ flexDirection: "row", backgroundColor: bg, paddingHorizontal: 12 }}>
              <T style={{ ...mono, color, width: 14.4 }} importantForAccessibility={l.op === " " ? "no" : "auto"}>
                {l.op}
              </T>
              <T style={{ ...mono, color, flex: 1, minWidth: 0, paddingLeft: 6, borderLeftWidth: 1, borderLeftColor: withAlpha(color, 0.3) }} selectable>
                {l.text}
              </T>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

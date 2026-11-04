/**
 * .output and chat/Diff.tsx's .output.diff: removed lines red, added green,
 * left-out runs one dim italic line; each line its sign in a 2ch gutter and its
 * text wrapping beside it, behind a hairline in its own colour at 30%.
 */
import type { ReactNode } from "react";
import { ScrollView, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import type { DiffLine } from "@ue-mcp-studio/shared";
import { font, T } from "./Text";
import { useTheme } from "./ThemeProvider";
import type { Theme } from "./theme";

/** A colour at `a` opacity: color-mix(in srgb, c a, transparent). */
export function withAlpha(c: string, a: number): string {
  if (c.startsWith("#")) {
    const n = parseInt(c.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  const m = /^rgba?\(([^,]+),([^,]+),([^,)]+)(?:,([^)]+))?\)$/.exec(c.replace(/\s/g, ""));
  return m ? `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${(m[4] ? Number(m[4]) : 1) * a})` : c;
}

/** 12px/1.6 mono: the type of every .output. */
export const outputFont = (t: Theme): TextStyle => font(t, "mono", 400, 12, 1.6);

/** One character of the theme's mono at 12px: JetBrains Mono's 0.6em, Consolas's 0.55em. */
export const monoCh = (t: Theme): number => (t.mono === "jetbrains" ? 7.2 : 6.6);

/**
 * .output: code-bg, hairline, 8px radius, 10px 12px inside, 12px/1.6 mono in
 * --code-text (`color` overrides, as .output.command's --text), scrolling past
 * `maxHeight`. `padding` replaces the inner padding (.output.diff's 8px 0).
 */
export function Output({ children, maxHeight, style, label, color, padding, raw }: { children: ReactNode; maxHeight?: number; style?: StyleProp<ViewStyle>; label?: string; color?: string; padding?: ViewStyle; /** Children are views of their own (a diff's lines), not text. */ raw?: boolean }) {
  const t = useTheme();
  return (
    <View accessibilityLabel={label} style={[{ backgroundColor: t.c.codeBg, borderColor: t.c.line, borderWidth: 1, borderRadius: 8, maxHeight, overflow: "hidden" }, style]}>
      {/* The scroller paints the code background itself: a scroller Chrome puts on a layer keeps subpixel text only over an opaque one. */}
      <ScrollView nestedScrollEnabled style={{ maxHeight: maxHeight !== undefined ? maxHeight - 2 : undefined, backgroundColor: t.c.codeBg }} contentContainerStyle={padding ?? { paddingVertical: 10, paddingHorizontal: 12 }}>
        {raw ? children : <T style={{ ...outputFont(t), color: color ?? t.c.codeText }} selectable>{children}</T>}
      </ScrollView>
    </View>
  );
}

/** A line diff, as the web's DiffView. */
export function DiffView({ lines, label, maxHeight, style }: { lines: DiffLine[]; label?: string; maxHeight?: number; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  // pre.diff outranks .output: 12px/1.5, not 1.6.
  const mono = font(t, "mono", 400, 12, 1.5);
  if (lines.length === 0)
    return (
      <Output maxHeight={maxHeight} style={style} padding={{ paddingVertical: 8 }} color={t.c.dim}>
        No change.
      </Output>
    );
  const ch = monoCh(t);
  return (
    <Output raw maxHeight={maxHeight} style={style} label={label} padding={{ paddingVertical: 8 }}>
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
            <T style={{ ...mono, color, width: 2 * ch }} importantForAccessibility={l.op === " " ? "no" : "auto"}>
              {`${l.op} `}
            </T>
            <View style={{ flex: 1, minWidth: 0, paddingLeft: 6, borderLeftWidth: 1, borderLeftColor: withAlpha(color, 0.3) }}>
              <T style={{ ...mono, color }} selectable>
                {l.text}
              </T>
            </View>
          </View>
        );
      })}
    </Output>
  );
}

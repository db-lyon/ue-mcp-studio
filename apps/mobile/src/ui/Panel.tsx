/**
 * The relay's .panel, Studio's connection panel: a head, what happened, a
 * note on what to do, and the actions at its foot, right-aligned. `bad` is
 * the error tint (the bad wash over the panel, its line, the warning sign).
 */
import type { ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { Spinner } from "./Spinner";
import { WarnGlyph } from "./StateGlyph";
import { font, T } from "./Text";
import { useTheme } from "./ThemeProvider";

export function Panel({ head, text, note, bad, spinner, children, actions, style }: { head: string; text?: ReactNode; note?: ReactNode; bad?: boolean; spinner?: boolean; children?: ReactNode; actions?: ReactNode; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  const shadow: ViewStyle | null = t.shadow && !bad ? { shadowColor: "#000", shadowOpacity: 0.45, shadowRadius: 25, shadowOffset: { width: 0, height: 18 }, elevation: 8 } : null;
  return (
    <View
      accessibilityRole={bad ? "alert" : undefined}
      accessibilityLiveRegion="polite"
      style={[{ width: "100%", maxWidth: 460, gap: 12, padding: 16, borderWidth: 1, borderRadius: t.radiusLg, backgroundColor: t.c.panel, borderColor: bad ? t.c.badLine : t.c.line }, shadow, style]}
    >
      {bad ? <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, borderRadius: t.radiusLg - 1, backgroundColor: t.c.badWash }} /> : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        {spinner ? <Spinner /> : bad ? <WarnGlyph /> : null}
        <T accessibilityRole="header" style={{ ...font(t, "sans", 600, 15, 1.3), color: t.c.text, flexShrink: 1 }}>
          {head}
        </T>
      </View>
      {text ? typeof text === "string" ? <T style={{ color: bad ? (t.editor ? t.c.bad : t.c.badText) : t.c.muted }}>{text}</T> : text : null}
      {children}
      {note ? typeof note === "string" ? <T style={{ ...font(t, "sans", 400, 12.5, t.base.lineHeight / t.base.size), color: t.c.muted }}>{note}</T> : note : null}
      {actions ? <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 8 }}>{actions}</View> : null}
    </View>
  );
}

/** .waiting: a small spinner and what is being waited for. */
export function Waiting({ children }: { children: string }) {
  const t = useTheme();
  return (
    <View accessibilityRole="text" accessibilityLiveRegion="polite" accessibilityLabel={children} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Spinner small />
      <T style={{ ...font(t, "sans", 400, 12.5, t.base.lineHeight / t.base.size), color: t.c.muted }}>{children}</T>
    </View>
  );
}

/** .loading: the spinner and one line, while something is under way. */
export function Loading({ children }: { children: string }) {
  const t = useTheme();
  return (
    <View accessibilityRole="text" accessibilityLiveRegion="polite" accessibilityLabel={children} style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
      <Spinner />
      <T style={{ ...font(t, "sans", 500, 13.5, 1.3), color: t.c.muted }}>{children}</T>
    </View>
  );
}

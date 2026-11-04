/**
 * The app's own pages outside a project (pairing, projects, paired devices)
 * in Studio's design language: the page on the theme's background, a Settings
 * style head (title and one sentence), and cards of rows as Studio's lists
 * draw them.
 */
import type { ReactElement, ReactNode } from "react";
import { Pressable, ScrollView, View, type RefreshControlProps, type StyleProp, type ViewStyle } from "react-native";
import Svg, { Path } from "react-native-svg";
import { Card, font, Label, T, useSheetInsets, useTheme } from "../ui";

export function Page({ children, scroll = true, footer, refreshControl }: { children: ReactNode; scroll?: boolean; footer?: ReactNode; refreshControl?: ReactElement<RefreshControlProps> }) {
  const t = useTheme();
  // The page's end (or its footer's buttons) clear of the navigation bar, or of the keyboard while a field has it up.
  const insets = useSheetInsets();
  const pad = { paddingTop: Math.max(16, insets.top + 8), paddingLeft: 16 + insets.left, paddingRight: 16 + insets.right };
  const end = 16 + insets.bottom;
  return (
    <View style={{ flex: 1, backgroundColor: t.c.bg }}>
      {scroll ? (
        <ScrollView testID="page" style={{ flex: 1 }} refreshControl={refreshControl} keyboardShouldPersistTaps="handled" contentContainerStyle={[pad, { paddingBottom: footer ? 16 : end, gap: 14 }]}>
          {children}
        </ScrollView>
      ) : (
        <View style={[{ flex: 1, gap: 14 }, pad, { paddingBottom: footer ? 0 : end }]}>{children}</View>
      )}
      {footer ? <View testID="page-footer" style={{ paddingLeft: 16 + insets.left, paddingRight: 16 + insets.right, paddingTop: 10, paddingBottom: end, gap: 8, borderTopWidth: 1, borderTopColor: t.c.line }}>{footer}</View> : null}
    </View>
  );
}

/** .cfg-head: the page's title and the sentence that says what it is for; a back link above when it has one. */
export function PageHead({ title, lead, back, onBack, actions, eyebrow }: { title: string; lead?: ReactNode; back?: string; onBack?: () => void; actions?: ReactNode; eyebrow?: string }) {
  const t = useTheme();
  return (
    <View style={{ gap: 4 }}>
      {onBack ? (
        <Pressable accessibilityRole="button" accessibilityLabel={back ?? "Back"} onPress={onBack} hitSlop={8} style={{ flexDirection: "row", alignItems: "center", gap: 4, minHeight: 44, alignSelf: "flex-start" }}>
          <Svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke={t.c.muted} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
            <Path d="M10 3L5 8l5 5" />
          </Svg>
          <T style={{ ...font(t, "mono", 500, 12, 1), color: t.c.muted }}>{back ?? "Back"}</T>
        </Pressable>
      ) : null}
      {eyebrow ? <Label>{eyebrow}</Label> : null}
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 12, flexWrap: "wrap" }}>
        <T accessibilityRole="header" style={{ ...font(t, "sans", 700, 21, 1.15), letterSpacing: t.editor ? 0 : -0.42, color: t.c.text, flexShrink: 1 }}>
          {title}
        </T>
        {actions ? <View style={{ marginLeft: "auto", flexDirection: "row", gap: 8 }}>{actions}</View> : null}
      </View>
      {lead ? typeof lead === "string" ? <T style={{ color: t.c.muted, marginTop: 4 }}>{lead}</T> : lead : null}
    </View>
  );
}

/** h2: a section's label above its card. */
export function SectionLabel({ children }: { children: ReactNode }) {
  return <Label style={{ marginTop: 10, marginBottom: -4 }}>{children}</Label>;
}

/** A card of rows, a hairline between each. */
export function ListCard({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <Card padded={false} style={[{ overflow: "hidden" }, style]}>
      {children}
    </Card>
  );
}

/** One row of a ListCard: a lead (a dot), the name and its line, and what it offers. */
export function ListRow({ first, lead, title, sub, right, onPress, disabled, label }: { first?: boolean; lead?: ReactNode; title: string; sub?: ReactNode; right?: ReactNode; onPress?: () => void; disabled?: boolean; label?: string }) {
  const t = useTheme();
  const body = (
    <>
      {lead}
      <View style={{ flex: 1, minWidth: 0 }}>
        <T weight={600} numberOfLines={1} style={{ color: disabled ? t.c.muted : t.c.text }}>
          {title}
        </T>
        {sub ? typeof sub === "string" ? <T style={{ ...font(t, "sans", 400, 12, 1.45), color: t.c.dim, marginTop: 2 }}>{sub}</T> : sub : null}
      </View>
      {right}
    </>
  );
  const style = { flexDirection: "row" as const, alignItems: "center" as const, gap: 12, paddingVertical: 12, paddingHorizontal: 14, minHeight: 56, borderTopWidth: first ? 0 : 1, borderTopColor: t.c.line };
  if (!onPress) return <View style={style}>{body}</View>;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label ?? title} accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => [style, pressed && { backgroundColor: t.c.panel2 }]}>
      {body}
    </Pressable>
  );
}

/** The chevron a row that opens something ends with. */
export function Chevron() {
  const t = useTheme();
  return (
    <Svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke={t.c.dim} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M6 3l5 5-5 5" />
    </Svg>
  );
}

/**
 * The web client's controls as native views, at its phone sizes (coarse
 * pointer: 44px buttons and fields, 20px checkboxes). Each names the CSS it
 * mirrors so a change there has an obvious place to land here.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { Animated, Modal, Pressable, ScrollView, StyleSheet, TextInput, View, type StyleProp, type TextInputProps, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { font, labelFont, T } from "./Text";
import { useStyles, useTheme } from "./ThemeProvider";
import type { Theme } from "./theme";

/** button, button.primary, button.ghost, button.small-button, button.large. */
export function Button({
  title,
  onPress,
  variant = "default",
  size = "normal",
  disabled,
  label,
  style,
  children,
}: {
  title?: string;
  onPress?: () => void;
  variant?: "default" | "primary" | "ghost";
  size?: "normal" | "small" | "large";
  disabled?: boolean;
  label?: string;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}) {
  const t = useTheme();
  const s = useStyles(buttonStyles);
  const primary = variant === "primary";
  const ghost = variant === "ghost";
  const box = [s.button, size === "small" && s.small, size === "large" && s.large, primary && s.primary, ghost && s.ghost, disabled && s.disabled, disabled && primary && s.primaryDisabled];
  const color = disabled ? t.c.dim : primary ? t.c.onAccent : ghost ? t.c.muted : t.c.text;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label ?? title} accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => [box, pressed && !disabled && (primary ? s.primaryPressed : s.pressed), style]}>
      {children ?? <T style={[s.text, primary && !disabled && s.primaryText, size === "large" && s.largeText, { color }]}>{title}</T>}
    </Pressable>
  );
}

const buttonStyles = (t: Theme) => ({
  button: { backgroundColor: t.c.panel2, borderColor: t.c.lineStrong, borderWidth: 1, borderRadius: t.radius, paddingVertical: 6, paddingHorizontal: 12, minHeight: 44, alignItems: "center" as const, justifyContent: "center" as const, flexDirection: "row" as const, gap: 6 },
  small: { paddingVertical: 0, paddingHorizontal: 10 },
  large: { paddingVertical: 10, paddingHorizontal: 20 },
  primary: { backgroundColor: t.c.accent, borderColor: t.c.accent },
  primaryPressed: { backgroundColor: t.c.accentHi, borderColor: t.c.accentHi },
  pressed: { borderColor: t.c.accentLine, backgroundColor: t.c.panel3 },
  ghost: { backgroundColor: "transparent", borderColor: "transparent" },
  disabled: { borderColor: t.c.disabledLine },
  primaryDisabled: { backgroundColor: "transparent" },
  text: t.editor ? { ...font(t, "sans", 400, 12, 1.2) } : { ...font(t, "mono", 500, 11.5, 1.2), letterSpacing: 0.23 },
  primaryText: t.editor ? {} : font(t, "mono", 600, 11.5, 1.2),
  largeText: { fontSize: 12.5 },
});

/** .card: the panel, its hairline, the large radius; 12px padding at phone width. */
export function Card({ children, style, padded = true }: { children: ReactNode; style?: StyleProp<ViewStyle>; padded?: boolean }) {
  const t = useTheme();
  return <View style={[{ backgroundColor: t.c.panel, borderColor: t.c.line, borderWidth: 1, borderRadius: t.radiusLg, padding: padded ? 12 : 0, minWidth: 0 }, style]}>{children}</View>;
}

/** .banner, .banner.warn, .banner.bad, .banner.ok. */
export function Banner({ kind, children, style, role }: { kind?: "warn" | "bad" | "ok"; children: ReactNode; style?: StyleProp<ViewStyle>; role?: "alert" | "status" }) {
  const t = useTheme();
  // The editor themes draw a warning on panel-2 inside a full --warn outline.
  const bg = kind === "warn" ? (t.editor ? t.c.panel2 : t.c.warnWash) : kind === "bad" ? t.c.badWash : kind === "ok" ? t.c.okWash : "transparent";
  const line = kind === "warn" ? (t.editor ? t.c.warn : t.c.warnLine) : kind === "bad" ? t.c.badLine : kind === "ok" ? t.c.okLine : "transparent";
  const color = kind === "warn" ? t.c.warnText : kind === "bad" ? t.c.badText : t.c.text;
  return (
    <View accessibilityRole={role === "alert" ? "alert" : undefined} accessibilityLiveRegion={role ? "polite" : undefined} style={[{ paddingVertical: 9, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, backgroundColor: bg, borderColor: line, marginBottom: 10 }, style]}>
      {typeof children === "string" ? <T style={{ color }}>{children}</T> : children}
    </View>
  );
}

/** The colour a banner's own text takes. */
export function bannerText(t: Theme, kind?: "warn" | "bad" | "ok"): string {
  return kind === "warn" ? t.c.warnText : kind === "bad" ? t.c.badText : t.c.text;
}

/** .eyebrow and h2: the label style. */
export function Label({ children, color, style }: { children: ReactNode; color?: string; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  return (
    <T style={[labelFont(t, color), style as never]} accessibilityRole="header">
      {children}
    </T>
  );
}

/** .chip, .chip.ok/.warn/.bad: a rounded mono tag with its dot. */
export function Chip({ kind, children, dot = true }: { kind?: "ok" | "warn" | "bad"; children: ReactNode; dot?: boolean }) {
  const t = useTheme();
  const dotColor = kind === "ok" ? t.c.ok : kind === "warn" ? t.c.warn : kind === "bad" ? t.c.bad : t.c.dim;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 3, paddingHorizontal: 9, borderWidth: 1, borderColor: t.c.lineStrong, borderRadius: 999, alignSelf: "flex-start" }}>
      {dot ? <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: dotColor }} /> : null}
      <T style={t.editor ? { ...font(t, "sans", 400, 11, 1.4), color: t.c.muted } : { ...font(t, "mono", 500, 10.5, 1.4), letterSpacing: 0.63, textTransform: "uppercase", color: t.c.muted }}>{children}</T>
    </View>
  );
}

/** .pill, .pill.ok/.warn/.bad. */
export function Pill({ kind, children }: { kind?: "ok" | "warn" | "bad"; children: ReactNode }) {
  const t = useTheme();
  const color = kind ? t.c[kind] : t.c.muted;
  const line = kind === "ok" ? t.c.okPill : kind === "warn" ? t.c.warnPill : kind === "bad" ? t.c.badPill : t.c.lineStrong;
  return (
    <View style={{ borderRadius: 999, paddingVertical: 1, paddingHorizontal: 9, borderWidth: 1, borderColor: line, alignSelf: "flex-start" }}>
      <T style={{ ...font(t, "mono", 500, 11, 1.6), color }}>{children}</T>
    </View>
  );
}

/** .dot, .dot.ok/.warn/.bad. */
export function Dot({ kind, size = 8 }: { kind?: "ok" | "warn" | "bad"; size?: number }) {
  const t = useTheme();
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: kind ? t.c[kind] : t.c.dim }} />;
}

/** input, textarea: panel-2, strong hairline, 16px text at phone width (no zoom on focus), accent ring on focus. */
export function Input({ style, multiline, ...rest }: TextInputProps) {
  const t = useTheme();
  return (
    <TextInput
      placeholderTextColor={t.c.dim}
      selectionColor={t.c.selection}
      cursorColor={t.c.accent}
      multiline={multiline}
      {...rest}
      style={[{ backgroundColor: t.c.panel2, color: t.c.text, borderColor: t.c.lineStrong, borderWidth: 1, borderRadius: t.radius, paddingVertical: 6, paddingHorizontal: 10, minHeight: 44, ...font(t, "sans", 400, 16) }, style]}
    />
  );
}

/** .segmented: buttons joined in one outline, the chosen one on the accent wash. */
export function Seg<K extends string>({ value, options, onChange, label }: { value: K; options: Array<{ key: K; title: string }>; onChange: (k: K) => void; label?: string }) {
  const t = useTheme();
  return (
    <View accessibilityRole="tablist" accessibilityLabel={label} style={{ flexDirection: "row", borderWidth: 1, borderColor: t.c.lineStrong, borderRadius: t.radius, overflow: "hidden", alignSelf: "flex-start" }}>
      {options.map((o, i) => (
        <Pressable key={o.key} accessibilityRole="tab" accessibilityState={{ selected: o.key === value }} onPress={() => onChange(o.key)} style={{ paddingVertical: 5, paddingHorizontal: 12, minHeight: 44, justifyContent: "center", backgroundColor: o.key === value ? t.c.accentWash : "transparent", borderLeftWidth: i ? 1 : 0, borderLeftColor: t.c.lineStrong }}>
          <T style={[t.editor ? font(t, "sans", 400, 12, 1.2) : { ...font(t, "mono", 500, 11.5, 1.2), letterSpacing: 0.23 }, { color: o.key === value ? t.c.text : t.c.muted }]}>{o.title}</T>
        </Pressable>
      ))}
    </View>
  );
}

/** label.toggle with its checkbox: a 20px accent box, 44px row, the label beside it. */
export function Check({ checked, onChange, disabled, children, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; children?: ReactNode; label?: string }) {
  const t = useTheme();
  return (
    <Pressable accessibilityRole="checkbox" accessibilityLabel={label} accessibilityState={{ checked, disabled: !!disabled }} disabled={disabled} onPress={() => onChange(!checked)} style={{ flexDirection: "row", alignItems: "flex-start", gap: 10, minHeight: 44, paddingVertical: 10 }}>
      <View style={{ width: 20, height: 20, marginTop: 1, borderRadius: 3, borderWidth: checked ? 0 : 1.5, borderColor: disabled ? t.c.disabledLine : t.c.muted, backgroundColor: checked ? (disabled ? t.c.disabledLine : t.c.accent) : "transparent", alignItems: "center", justifyContent: "center" }}>
        {checked ? <T style={{ color: t.c.onAccent, fontSize: 14, lineHeight: 16, fontWeight: "700" }}>{"✓"}</T> : null}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>{typeof children === "string" ? <T tone="muted">{children}</T> : children}</View>
    </Pressable>
  );
}

/** .row: a wrapping line of items, 10px apart. */
export function Row({ children, style, wrap = true, gap = 10 }: { children: ReactNode; style?: StyleProp<ViewStyle>; wrap?: boolean; gap?: number }) {
  return <View style={[{ flexDirection: "row", alignItems: "center", gap, flexWrap: wrap ? "wrap" : "nowrap" }, style]}>{children}</View>;
}

export const Spacer = () => <View style={{ flex: 1 }} />;

/**
 * Sheet.tsx: slides up over a 55% scrim, a grip, the title, Close; at most 70%
 * of the screen, its body scrolling.
 */
export function Sheet({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const slide = useRef(new Animated.Value(open ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(slide, { toValue: open ? 1 : 0, duration: 240, useNativeDriver: true }).start();
  }, [open, slide]);
  return (
    <Modal visible={open} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(0,0,0,0.55)", opacity: slide }]}>
        <Pressable accessibilityLabel="Close" style={StyleSheet.absoluteFill} onPress={onClose} />
      </Animated.View>
      <Animated.View
        accessibilityViewIsModal
        accessibilityLabel={title}
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          maxHeight: "70%",
          paddingTop: 6,
          paddingHorizontal: Math.max(10, insets.left),
          paddingBottom: Math.max(12, insets.bottom),
          backgroundColor: t.c.panel,
          borderTopWidth: 1,
          borderTopColor: t.c.lineStrong,
          borderTopLeftRadius: 14,
          borderTopRightRadius: 14,
          transform: [{ translateY: slide.interpolate({ inputRange: [0, 1], outputRange: [600, 0] }) }],
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingTop: 12, paddingHorizontal: 4, paddingBottom: 8 }}>
          <View style={{ position: "absolute", top: 0, left: "50%", width: 36, height: 4, marginLeft: -18, borderRadius: 2, backgroundColor: t.c.lineStrong }} />
          <T weight={700} size={t.base.size}>
            {title}
          </T>
          <Spacer />
          <Button title="Close" variant="ghost" onPress={onClose} />
        </View>
        <ScrollView style={{ minHeight: 0 }}>{children}</ScrollView>
      </Animated.View>
    </Modal>
  );
}

/**
 * The web client's controls as native views, at its phone sizes (coarse
 * pointer: 44px buttons and fields, 20px checkboxes). Each names the CSS it
 * mirrors so a change there has an obvious place to land here.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import Svg, { Defs, LinearGradient, Polyline, Rect, Stop } from "react-native-svg";
import { Animated, Modal, Pressable, ScrollView, StyleSheet, TextInput, View, type StyleProp, type TextInputProps, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { font, labelFont, T } from "./Text";
import { useStyles, useTheme } from "./ThemeProvider";
import { lineBox, type Theme } from "./theme";

/** button, button.primary, button.ghost, button.small-button, button.large. */
export function Button({
  fontSize,
  testID,
  title,
  onPress,
  variant = "default",
  size = "normal",
  disabled,
  label,
  hint,
  style,
  children,
}: {
  title?: string;
  onPress?: () => void;
  variant?: "default" | "primary" | "ghost";
  size?: "normal" | "small" | "large";
  disabled?: boolean;
  label?: string;
  /** The web button's title (its tooltip), for a screen reader. */
  hint?: string;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
  /** button.small-button takes the font size of the text around it (the editor themes keep 12px). */
  fontSize?: number;
  testID?: string;
}) {
  const t = useTheme();
  const s = useStyles(buttonStyles);
  const primary = variant === "primary";
  const ghost = variant === "ghost";
  const box = [s.button, size === "small" && s.small, size === "large" && s.large, primary && s.primary, ghost && s.ghost, disabled && s.disabled, disabled && primary && s.primaryDisabled];
  // editor-orange's primary button is black and bold on the orange (styles.css, after the editor themes' 400).
  const orangePrimary = primary && !disabled && t.name === "editor-orange";
  const color = disabled ? t.c.dim : orangePrimary ? "#000" : primary ? t.c.onAccent : ghost ? t.c.muted : t.c.text;
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label ?? title} accessibilityHint={hint} accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => [box, pressed && !disabled && (primary ? s.primaryPressed : s.pressed), style]}>
      {children ?? <T style={[s.text, primary && !disabled && s.primaryText, orangePrimary && font(t, "sans", 700, 12, 1.2), size === "large" && s.largeText, fontSize && !t.editor ? { fontSize, lineHeight: fontSize * 1.2, letterSpacing: fontSize * 0.02 } : null, { color }]}>{title}</T>}
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
  // button.large's 12.5px keeps the button's 1.2 and 0.02em; the editor themes' button rule outranks it, so 12px stays.
  largeText: t.editor ? {} : { fontSize: 12.5, lineHeight: lineBox(12.5, 1.2), letterSpacing: 0.25 },
});

/** .card: the panel, its hairline, the large radius; 12px padding at phone width. */
export function Card({ children, style, padded = true, testID }: { children: ReactNode; style?: StyleProp<ViewStyle>; padded?: boolean; testID?: string }) {
  const t = useTheme();
  // The editor themes draw cards flat: no outline (styles.css :root[data-theme="editor"] .card). ue-mcp's panel has a faint tint at its top.
  return (
    <View testID={testID} style={[{ backgroundColor: t.c.panel, borderColor: t.editor ? "transparent" : t.c.line, borderWidth: 1, borderRadius: t.radiusLg, padding: padded ? 12 : 0, minWidth: 0 }, style]}>
      {t.c.tint !== "transparent" ? <CardTint color={t.c.tint} radius={t.radiusLg} /> : null}
      {children}
    </View>
  );
}

/** linear-gradient(180deg, tint, transparent 120px) over a card's top, drawn with svg so it shows on every platform. */
function CardTint({ color, radius }: { color: string; radius: number }) {
  return (
    <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, top: 0, height: 120, borderTopLeftRadius: radius, borderTopRightRadius: radius, overflow: "hidden" }}>
      <Svg width="100%" height="100%" preserveAspectRatio="none" viewBox="0 0 1 1">
        <Defs>
          <LinearGradient id="cardTint" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={color} />
            <Stop offset="1" stopColor={color} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="1" height="1" fill="url(#cardTint)" />
      </Svg>
    </View>
  );
}

/** .banner, .banner.warn, .banner.bad, .banner.ok. */
export function Banner({ kind, children, style, role }: { kind?: "warn" | "bad" | "ok"; children: ReactNode; style?: StyleProp<ViewStyle>; role?: "alert" | "status" }) {
  const t = useTheme();
  // The editor themes draw a warn banner on panel-2 with a full warn outline.
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
export function Pill({ kind, children, style }: { kind?: "ok" | "warn" | "bad"; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  const color = kind ? t.c[kind] : t.c.muted;
  const line = kind === "ok" ? t.c.okPill : kind === "warn" ? t.c.warnPill : kind === "bad" ? t.c.badPill : t.c.lineStrong;
  return (
    <View style={[{ borderRadius: 999, paddingVertical: 1, paddingHorizontal: 9, borderWidth: 1, borderColor: line, alignSelf: "flex-start" }, style]}>
      <T style={{ ...font(t, "mono", 500, 11, 1.6), color }}>{children}</T>
    </View>
  );
}

/** .dot, .dot.ok/.warn/.bad. */
export function Dot({ kind, size = 8, style }: { kind?: "ok" | "warn" | "bad"; size?: number; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  // .dot.ok glows on ue-mcp (--ok-glow: 0 0 8px of the ok green at 60%); the editor themes draw it flat.
  const glow: ViewStyle | null = kind === "ok" && !t.editor ? { shadowColor: t.c.ok, shadowOpacity: 0.6, shadowRadius: 8, shadowOffset: { width: 0, height: 0 } } : null;
  return <View style={[{ width: size, height: size, borderRadius: size / 2, backgroundColor: kind ? t.c[kind] : t.c.dim }, glow, style]} />;
}

/** input, textarea: panel-2, strong hairline, 16px text at phone width (no zoom on focus), accent ring on focus. */
export function Input({ style, multiline, onFocus, onBlur, ...rest }: TextInputProps) {
  const t = useTheme();
  // input:focus: the accent line and a 3px wash around it, not the browser's own outline.
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      placeholderTextColor={t.c.dim}
      selectionColor={t.c.selection}
      cursorColor={t.c.accent}
      multiline={multiline}
      {...rest}
      onFocus={(e) => (setFocused(true), onFocus?.(e))}
      onBlur={(e) => (setFocused(false), onBlur?.(e))}
      style={[{ backgroundColor: t.c.panel2, color: t.c.text, borderColor: focused ? t.c.accentLine : t.c.lineStrong, borderWidth: 1, borderRadius: t.radius, paddingVertical: 6, paddingHorizontal: 10, minHeight: 44, ...font(t, "sans", 400, 16) }, focused ? ({ outlineStyle: "none", boxShadow: `0 0 0 3px ${t.c.accentWash}` } as object) : null, style]}
    />
  );
}

/** .segmented: buttons joined in one outline, the chosen one on the accent wash. */
export function Seg<K extends string>({ value, options, onChange, label }: { value: K; options: Array<{ key: K; title: string }>; onChange: (k: K) => void; label?: string }) {
  const t = useTheme();
  return (
    <View accessibilityRole="tablist" accessibilityLabel={label} style={{ flexDirection: "row", borderWidth: 1, borderColor: t.c.lineStrong, borderRadius: t.radius, overflow: "hidden", alignSelf: "flex-start" }}>
      {options.map((o, i) => (
        // .seg button: 6px 11px; .seg button.on: the accent wash with a 2 px accent line along its foot (box-shadow inset 0 -2px 0).
        <Pressable key={o.key} accessibilityRole="tab" accessibilityState={{ selected: o.key === value }} onPress={() => onChange(o.key)} style={{ paddingVertical: 6, paddingHorizontal: 11, minHeight: 44, justifyContent: "center", backgroundColor: o.key === value ? t.c.accentWash : "transparent", borderLeftWidth: i ? 1 : 0, borderLeftColor: t.c.lineStrong, ...(o.key === value ? { boxShadow: `inset 0 -2px 0 ${t.c.accent}` } : {}) }}>
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
      <View style={{ width: 20, height: 20, marginTop: 1, borderRadius: 2, borderWidth: checked ? 0 : 1.5, borderColor: disabled ? t.c.disabledLine : t.c.muted, backgroundColor: checked ? (disabled ? t.c.disabledLine : t.c.accent) : "transparent", alignItems: "center", justifyContent: "center" }}>
        {/* The browser's own tick on an accent-coloured checkbox: a stroked check in the accent's contrast colour. */}
        {checked ? (
          <Svg width={20} height={20} viewBox="0 0 20 20" style={{ position: "absolute", left: 0, top: 0 }}>
            <Polyline points="4.6,10.6 7.6,13.6 15.2,5.2" fill="none" stroke={t.c.onAccent} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
          </Svg>
        ) : null}
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

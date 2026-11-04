/**
 * The web client's controls at phone width, as React Native: its buttons
 * (plain, primary, ghost, small, danger, icon), pills, banners and the
 * spinner, each sized and set as the web client draws it under a finger
 * (44 point targets).
 */
import { useEffect, useRef, type ReactNode } from "react";
import { Animated, Easing, Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { base, css, fonts, small } from "./css";

export type ButtonKind = "default" | "primary" | "ghost" | "danger";

/**
 * A web button. `small` is `.small-button` (11 px, 10 px sides), otherwise the
 * plain button (11.5 px, 12 px sides). A ghost button in content draws its
 * outline on a phone, as the web client's coarse-pointer pass does; `bare`
 * keeps it borderless (the top bar's and a sheet header's).
 */
export function WebButton({
  title,
  onPress,
  kind = "default",
  small: isSmall,
  bare,
  disabled,
  label,
  pressed: picked,
  expanded,
  style,
  textStyle,
  children,
  testID,
}: {
  title?: string;
  onPress?: () => void;
  kind?: ButtonKind;
  small?: boolean;
  bare?: boolean;
  disabled?: boolean;
  label?: string;
  /** aria-pressed. */
  pressed?: boolean;
  expanded?: boolean;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  children?: ReactNode;
  testID?: string;
}) {
  const ghost = kind === "ghost";
  const frame = [
    b.button,
    isSmall && b.small,
    kind === "primary" && b.primary,
    ghost && (bare ? b.ghostBare : b.ghostOutlined),
    kind === "danger" && b.danger,
    disabled && (kind === "primary" ? b.primaryOff : b.off),
    style,
  ];
  const text = [b.text, isSmall && b.smallText, kind === "primary" && b.primaryText, ghost && (bare ? b.ghostBareText : null), kind === "danger" && { color: css.bad }, disabled && { color: css.dim }, textStyle];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label ?? title}
      accessibilityState={{ disabled: !!disabled, selected: picked, expanded }}
      aria-pressed={picked}
      disabled={disabled}
      onPress={onPress}
      style={frame}
      testID={testID}
    >
      {children ?? <Text style={text} numberOfLines={1}>{title}</Text>}
    </Pressable>
  );
}

/** `.icon-button`: a 44 point square with a glyph, its name as the label. */
export function IconButton({ label, glyph, onPress, disabled, expanded, primary }: { label: string; glyph: ReactNode; onPress: () => void; disabled?: boolean; expanded?: boolean; primary?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled, expanded }}
      disabled={disabled}
      onPress={onPress}
      style={[b.icon, primary && b.iconPrimary, disabled && (primary ? b.primaryOff : b.off)]}
    >
      {glyph}
    </Pressable>
  );
}

export type Tone = "" | "ok" | "warn" | "bad" | "run";

/** `.pill`: a state in a rounded outline, 11 px mono. */
export function Pill({ tone = "", text, label }: { tone?: Tone; text: string; label?: string }) {
  const color = tone === "ok" ? css.ok : tone === "warn" ? css.warn : tone === "bad" ? css.bad : css.muted;
  const border = tone === "ok" ? css.ok45 : tone === "warn" ? css.warn45 : tone === "bad" ? css.bad45 : css.lineStrong;
  return (
    <View style={[b.pill, { borderColor: border }]} accessibilityRole="text" accessibilityLabel={label ?? text}>
      <Text style={[b.pillText, { color }]} numberOfLines={1}>{text}</Text>
    </View>
  );
}

/** `.banner`: a notice in the page, bad or warn. */
export function Banner({ tone, children, smallText = true, style, role }: { tone: "bad" | "warn" | "ok"; children: ReactNode; smallText?: boolean; style?: StyleProp<ViewStyle>; role?: "alert" | "status" }) {
  const box = tone === "bad" ? { backgroundColor: css.bad10, borderColor: css.bad30 } : tone === "warn" ? { backgroundColor: css.warn9, borderColor: css.warn30 } : { backgroundColor: css.ok10, borderColor: css.ok30 };
  const color = tone === "bad" ? css.badText : tone === "warn" ? css.warnText : css.text;
  return (
    <View style={[b.banner, box, style]} accessibilityRole={role === "alert" ? "alert" : undefined} accessibilityLiveRegion={role ? "polite" : undefined}>
      {typeof children === "string" ? <Text style={[base, smallText && small, { color }]}>{children}</Text> : children}
    </View>
  );
}

/** `.spinner`: a ring with the accent at its top, turning. */
export function Spinner({ size = 16 }: { size?: number }) {
  const turn = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(turn, { toValue: 1, duration: 800, easing: Easing.linear, useNativeDriver: false }));
    loop.start();
    return () => loop.stop();
  }, [turn]);
  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  return <Animated.View aria-hidden style={{ width: size, height: size, borderRadius: size / 2, borderWidth: 2, borderColor: css.line, borderTopColor: css.accent, transform: [{ rotate }] }} />;
}

export const b = StyleSheet.create({
  button: {
    minHeight: 44,
    minWidth: 44,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: css.lineStrong,
    borderRadius: css.radius,
    backgroundColor: css.panel2,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
  },
  small: { paddingHorizontal: 10 },
  primary: { backgroundColor: css.accent, borderColor: css.accent },
  primaryOff: { backgroundColor: "transparent", borderColor: css.disabledLine },
  off: { borderColor: css.disabledLine },
  ghostOutlined: { backgroundColor: css.panel2, borderColor: css.lineStrong },
  ghostBare: { backgroundColor: "transparent", borderColor: "transparent" },
  danger: { borderColor: css.bad },
  text: { fontFamily: fonts.mono, fontSize: 11.5, lineHeight: 13.8, fontWeight: "500", letterSpacing: 0.23, color: css.text },
  smallText: { fontSize: 11, lineHeight: 13.2, letterSpacing: 0 },
  primaryText: { color: css.onAccent, fontWeight: "600" },
  ghostBareText: { color: css.muted },
  icon: { width: 44, height: 44, borderWidth: 1, borderColor: css.line, borderRadius: css.radius, backgroundColor: css.panel2, alignItems: "center", justifyContent: "center" },
  iconPrimary: { backgroundColor: css.accent, borderColor: css.accent },
  pill: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 1, alignSelf: "flex-start" },
  pillText: { fontFamily: fonts.mono, fontSize: 11, lineHeight: 17.6, fontWeight: "500" },
  banner: { paddingVertical: 9, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1 },
});

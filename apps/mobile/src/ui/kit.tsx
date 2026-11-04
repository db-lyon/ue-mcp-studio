/**
 * The pieces client-web's pages are built from, drawn the same way at phone
 * width: text in the theme's type, cards, banners, buttons, pills, tags, dots,
 * fields and a disclosure. Each one matches its CSS rule in client-web's
 * styles.css and settings.css (the narrow, touch-screen values), so a screen
 * made of them lines up with the web page pixel for pixel.
 */
import { createContext, useContext, useState, type ReactNode } from "react";
import { Pressable, Text, TextInput, View, type StyleProp, type TextInputProps, type TextStyle, type ViewStyle } from "react-native";
import { useTokens, type Font, type StudioTokens } from "./studio-theme";

/** A font as a text style. `size` alone keeps the family's line-height ratio, as a CSS font-size change does. */
export function fontStyle(f: Font, size?: number): TextStyle {
  const s = size ?? f.size;
  return { fontFamily: f.family, fontWeight: f.weight, fontSize: s, lineHeight: size === undefined ? f.lineHeight : (f.lineHeight / f.size) * s };
}

/** Body text at the base font, scaled: CSS line-height stays the base ratio. */
export function baseText(t: StudioTokens, size?: number, weight?: Font["weight"]): TextStyle {
  return { ...fontStyle(t.base, size), ...(weight ? { fontWeight: weight } : {}), color: t.text };
}

/** The mono family at a size and line-height, as `font: <w> <size>/<lh> var(--mono)` gives. */
export function monoText(t: StudioTokens, size: number, lineHeight: number, weight: Font["weight"] = "400"): TextStyle {
  return { fontFamily: t.mono, fontWeight: weight, fontSize: size, lineHeight: size * lineHeight };
}

export function sansText(t: StudioTokens, size: number, lineHeight: number, weight: Font["weight"] = "400"): TextStyle {
  return { fontFamily: t.sans, fontWeight: weight, fontSize: size, lineHeight: size * lineHeight };
}

type Tone = "text" | "muted" | "dim" | "accent" | "accentHi" | "ok" | "warn" | "bad" | "badText" | "warnText";

/** Text in the base font: `small` is 12px, `mono` the .mono class (0.92em). */
export function T({ children, tone = "text", small, size, weight, mono, style, numberOfLines, testID, selectable }: {
  children: ReactNode;
  tone?: Tone;
  small?: boolean;
  size?: number;
  weight?: Font["weight"];
  mono?: boolean;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
  testID?: string;
  selectable?: boolean;
}) {
  const t = useTokens();
  const s = size ?? (small ? 12 : t.base.size);
  const base = baseText(t, s, weight);
  return (
    <Text testID={testID} numberOfLines={numberOfLines} selectable={selectable} style={[base, { color: t[tone] }, mono && { fontFamily: t.mono, fontSize: s * 0.92 }, style]}>
      {children}
    </Text>
  );
}

/** h2 and .eyebrow: the label font in the label colour (the accent on ue-mcp). */
export function Label({ children, style, color, testID }: { children: ReactNode; style?: StyleProp<TextStyle>; color?: string; testID?: string }) {
  const t = useTokens();
  return (
    <Text testID={testID} accessibilityRole="header" style={[fontStyle(t.label), { textTransform: t.label.upper ? "uppercase" : "none", letterSpacing: t.label.spacing, color: color ?? t.label.color }, style]}>
      {children}
    </Text>
  );
}

/** .card at phone width: 12px padding, the panel with its faint top tint, and the theme's outline. */
export function Card({ children, style, testID }: { children: ReactNode; style?: StyleProp<ViewStyle>; testID?: string }) {
  const t = useTokens();
  return (
    <View testID={testID} style={[{ backgroundColor: t.panel, borderWidth: 1, borderColor: t.editor ? "transparent" : t.line, borderRadius: t.radiusLg, padding: 12, minWidth: 0, overflow: "hidden" }, style]}>
      {t.tint !== "transparent" ? <Tint color={t.tint} /> : null}
      {children}
    </View>
  );
}

/** linear-gradient(180deg, tint, transparent 120px) laid over the card's top. */
function Tint({ color }: { color: string }) {
  return <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, top: 0, height: 120, experimental_backgroundImage: `linear-gradient(180deg, ${color}, transparent)` } as ViewStyle} />;
}

/** .cfg h2.cfg-label: a card's title, with optional actions at its end. */
export function CardLabel({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", columnGap: 10, marginBottom: 12 }}>
      <Label>{children}</Label>
      {actions ? <><View style={{ flex: 1 }} />{actions}</> : null}
    </View>
  );
}

export type BannerKind = "plain" | "ok" | "warn" | "bad";

/** .banner: 9px 12px, 8px corners, 10px under it, tinted by its kind. */
export function Banner({ kind = "plain", children, style, onPress, testID, role }: { kind?: BannerKind; children: ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void; testID?: string; role?: "alert" | "status" }) {
  const t = useTokens();
  const tone = kind === "bad" ? t.bad : kind === "warn" ? t.warn : kind === "ok" ? t.ok : null;
  const box: ViewStyle = {
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderRadius: 8,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: tone ? t.mix(tone, 30) : "transparent",
    backgroundColor: tone ? t.mix(tone, kind === "warn" ? 9 : 10) : "transparent",
  };
  const content = <BannerTone.Provider value={kind}>{children}</BannerTone.Provider>;
  if (onPress) return <Pressable testID={testID} accessibilityRole={role === "alert" ? "alert" : undefined} onPress={onPress} style={[box, style]}>{content}</Pressable>;
  return <View testID={testID} accessibilityRole={role === "alert" ? "alert" : undefined} style={[box, style]}>{content}</View>;
}

const BannerTone = createContext<BannerKind | null>(null);

/** The text colour inside a banner: bad-text, warn-text, or the page's text. */
export function useBannerColor(): string {
  const t = useTokens();
  const kind = useContext(BannerTone);
  return kind === "bad" ? t.badText : kind === "warn" ? t.warnText : t.text;
}

/** Text inside a banner, in its colour. */
export function BannerText({ children, small, style }: { children: ReactNode; small?: boolean; style?: StyleProp<TextStyle> }) {
  const t = useTokens();
  const color = useBannerColor();
  return <Text style={[baseText(t, small ? 12 : undefined), { color }, style]}>{children}</Text>;
}

export type ButtonKind = "default" | "primary" | "ghost" | "danger";

/**
 * A button as client-web draws one on a touch screen: at least 44 by 44, the
 * theme's button type, and the disabled look (dim text, the disabled outline).
 */
export function Btn({ title, onPress, kind = "default", disabled, style, textStyle, label, testID, small, sans, large, size }: {
  title: ReactNode;
  onPress?: () => void;
  kind?: ButtonKind;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  /** The accessible name, when it differs from the title. */
  label?: string;
  testID?: string;
  /** button.small-button on a touch screen: padding 0 10px, the font size of the text around it. */
  small?: boolean;
  /** The button font at this size: button.small-button inherits the size around it. */
  size?: number;
  /** .cfg .ifiles button.small-button: the sans at 12px, 500. */
  sans?: boolean;
  /** button.large: 10px 20px, 12.5px. */
  large?: boolean;
}) {
  const t = useTokens();
  const primary = kind === "primary";
  const ghost = kind === "ghost";
  const box: ViewStyle = {
    minHeight: 44,
    minWidth: 44,
    paddingVertical: large ? 10 : small ? 0 : 6,
    paddingHorizontal: large ? 20 : small ? 10 : 12,
    borderWidth: 1,
    borderRadius: t.radius,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: primary ? t.accent : ghost ? "transparent" : t.panel2,
    borderColor: primary ? t.accent : ghost ? "transparent" : t.lineStrong,
  };
  if (disabled) Object.assign(box, { borderColor: ghost ? "transparent" : t.disabledLine, ...(primary ? { backgroundColor: "transparent" } : {}) });
  const font: TextStyle = sans
    ? sansText(t, 12, 1.4, "500")
    : (() => {
        // The editor themes set every button to 12px, over small-button and large alike.
        const fs = t.editor ? 12 : size ?? (large ? 12.5 : t.button.size);
        return { fontFamily: t.button.family, fontWeight: primary && !t.editor ? "600" : t.button.weight, fontSize: fs, lineHeight: fs * 1.2, letterSpacing: t.editor ? 0 : fs * 0.02 } as TextStyle;
      })();
  const color = disabled ? t.dim : primary ? t.onAccent : ghost ? t.muted : kind === "danger" ? t.bad : t.text;
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress} style={[box, style]}>
      <Text style={[font, { color, textAlign: "center" }, textStyle]}>{title}</Text>
    </Pressable>
  );
}

/** .cfg button.link: copy that reads as a link, 44px tall to a finger without moving the line. */
export function LinkText({ children, onPress, style }: { children: ReactNode; onPress: () => void; style?: StyleProp<TextStyle> }) {
  const t = useTokens();
  return (
    <Text accessibilityRole="link" onPress={onPress} style={[{ color: t.accentHi }, style]}>
      {children}
    </Text>
  );
}

/** .pill: 1px 9px, mono 11px/1.6, coloured by its kind. */
export function Pill({ children, kind, testID }: { children: ReactNode; kind?: "ok" | "warn" | "bad"; testID?: string }) {
  const t = useTokens();
  const tone = kind === "ok" ? t.ok : kind === "warn" ? t.warn : kind === "bad" ? t.bad : null;
  return (
    <View testID={testID} style={{ borderRadius: 999, paddingVertical: 1, paddingHorizontal: 9, borderWidth: 1, borderColor: tone ? t.mix(tone, 45) : t.lineStrong, alignSelf: "center" }}>
      <Text style={[monoText(t, 11, 1.6, "500"), { color: tone ?? t.muted }]}>{children}</Text>
    </View>
  );
}

/** .cfg .tag: 0 8px, mono 10.5px/1.7. */
export function Tag({ children, kind }: { children: ReactNode; kind?: "ok" | "warn" | "bad" | "acc" }) {
  const t = useTokens();
  const tone = kind === "ok" ? t.ok : kind === "warn" ? t.warn : kind === "bad" ? t.bad : kind === "acc" ? t.accentHi : null;
  return (
    <View style={{ borderRadius: 999, paddingHorizontal: 8, borderWidth: 1, borderColor: kind === "acc" ? t.accentLine : tone ? t.mix(tone, 45) : t.lineStrong, alignSelf: "center" }}>
      <Text numberOfLines={1} style={[monoText(t, 10.5, 1.7, "500"), { color: tone ?? t.muted }]}>{children}</Text>
    </View>
  );
}

/** .dot: 8px, dim, or the state's colour. */
export function Dot({ kind, style }: { kind?: "ok" | "warn" | "bad" | ""; style?: StyleProp<ViewStyle> }) {
  const t = useTokens();
  const bg = kind === "ok" ? t.ok : kind === "warn" ? t.warn : kind === "bad" ? t.bad : t.dim;
  return <View style={[{ width: 8, height: 8, borderRadius: 4, backgroundColor: bg }, style]} />;
}

/** input on a touch screen: 44px tall, 16px type so a phone never zooms, the panel-2 field. */
export function Field({ style, mono, ...props }: TextInputProps & { mono?: boolean }) {
  const t = useTokens();
  const [focus, setFocus] = useState(false);
  return (
    <TextInput
      placeholderTextColor={t.dim}
      {...props}
      onFocus={(e) => {
        setFocus(true);
        props.onFocus?.(e);
      }}
      onBlur={(e) => {
        setFocus(false);
        props.onBlur?.(e);
      }}
      style={[
        { minHeight: 44, backgroundColor: t.panel2, color: t.text, borderWidth: 1, borderColor: focus ? t.accentLine : t.lineStrong, borderRadius: t.radius, paddingVertical: 6, paddingHorizontal: 10, fontFamily: mono ? t.mono : t.sans, fontSize: 16, lineHeight: 16 * (t.base.lineHeight / t.base.size) },
        props.editable === false && { opacity: 1 },
        style,
      ]}
    />
  );
}

/**
 * <details>: a summary that opens what is under it. `open` makes it start open;
 * `summary` is drawn as given, after the disclosure marker unless `marker` is off.
 */
export function Details({ summary, children, startOpen, marker = true, style, summaryStyle, testID, onToggle }: {
  summary: (open: boolean) => ReactNode;
  children: ReactNode;
  startOpen?: boolean;
  marker?: boolean;
  style?: StyleProp<ViewStyle>;
  summaryStyle?: StyleProp<ViewStyle>;
  testID?: string;
  onToggle?: (open: boolean) => void;
}) {
  const t = useTokens();
  const [open, setOpen] = useState(!!startOpen);
  return (
    <View testID={testID} style={style}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => {
          setOpen(!open);
          onToggle?.(!open);
        }}
        style={[{ flexDirection: "row", alignItems: "center", minHeight: 44 }, summaryStyle]}
      >
        {marker ? <Text style={[baseText(t, 9.5), { color: t.text, marginRight: 4, width: 10 }]}>{open ? "▼" : "▶"}</Text> : null}
        {summary(open)}
      </Pressable>
      {open ? children : null}
    </View>
  );
}

/** A flex row, as .row: centred, 10px apart, wrapping, 6px above and below. */
export function Row({ children, style, gap = 10, wrap = true }: { children: ReactNode; style?: StyleProp<ViewStyle>; gap?: number; wrap?: boolean }) {
  return <View style={[{ flexDirection: "row", alignItems: "center", flexWrap: wrap ? "wrap" : "nowrap", gap, marginVertical: 6 }, style]}>{children}</View>;
}

export const Spacer = () => <View style={{ flex: 1 }} />;

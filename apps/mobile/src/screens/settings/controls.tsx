/**
 * What Settings, Plugins, Diagnostics and Feedback are built from beyond the
 * shared library: client-web's settings controls (views/settings/controls.tsx
 * and settings.css) at their narrow, touch-screen sizes. Text keeps the base
 * font's line-height ratio at every size, as a CSS font-size change does.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Platform, Pressable, Text, TextInput, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import Svg, { Path } from "react-native-svg";
import { segStacks } from "@ue-mcp-studio/client-core";
import { T, font, labelFont, useTheme, type Theme } from "../../ui";

type Tone = "text" | "muted" | "dim" | "accent" | "accentHi" | "ok" | "warn" | "bad" | "badText" | "warnText" | "onAccent";
type Weight = 400 | 500 | 600 | 700;

/** The body font's line-height as a multiple of its size, in this theme (1.55 ue-mcp, 1.5 editor): base.lineHeight is cut to 1/64 px, so the CSS multiple is rounded back out of it. */
export const ratio = (t: Theme): number => Math.round((t.base.lineHeight / t.base.size) * 100) / 100;

/** Body text at a size (default the base), keeping the theme's line-height ratio: .small is 12. */
export function Txt({ children, size, weight = 400, tone = "text", mono, style, numberOfLines, testID, onPress, label }: {
  children: ReactNode;
  size?: number;
  weight?: Weight;
  tone?: Tone;
  /** .mono: the mono family at 0.92em. */
  mono?: boolean;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
  testID?: string;
  onPress?: () => void;
  label?: string;
}) {
  const t = useTheme();
  const s = size ?? t.base.size;
  const f = mono ? font(t, "mono", weight, s * 0.92, (ratio(t) * s) / (s * 0.92)) : font(t, "sans", weight, s, ratio(t));
  return (
    <T testID={testID} onPress={onPress} accessibilityLabel={label} numberOfLines={numberOfLines} style={[f, { color: t.c[tone] }, style]}>
      {children}
    </T>
  );
}

/** Nested text in another weight, tone or the mono family; a size brings its own line-height, as CSS works it out from the unitless ratio. */
export function Span({ children, weight = 400, tone, mono, size, style }: { children: ReactNode; weight?: Weight; tone?: Tone; mono?: boolean; size?: number; style?: StyleProp<TextStyle> }) {
  const t = useTheme();
  const f = font(t, mono ? "mono" : "sans", weight, size ?? 12);
  return <Text style={[{ fontFamily: f.fontFamily, ...(f.fontWeight ? { fontWeight: f.fontWeight } : {}) }, size ? { fontSize: size, lineHeight: size * ratio(t) } : null, tone ? { color: t.c[tone] } : null, style]}>{children}</Text>;
}

/** h2.cfg-label: a card's title, 12px above what follows, with optional actions at its end. */
export function CardLabel({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", columnGap: 10, marginBottom: 12 }}>
      <T accessibilityRole="header" style={labelFont(t)}>
        {children}
      </T>
      {actions ? (
        <>
          <View style={{ flex: 1 }} />
          {actions}
        </>
      ) : null}
    </View>
  );
}

/** .cfg .tag: a quiet rounded label, mono 10.5px. */
export function Tag({ children, kind }: { children: ReactNode; kind?: "ok" | "warn" | "bad" | "acc" }) {
  const t = useTheme();
  const color = kind === "acc" ? t.c.accentHi : kind ? t.c[kind] : t.c.muted;
  const line = kind === "acc" ? t.c.accentLine : kind === "ok" ? t.c.okPill : kind === "warn" ? t.c.warnPill : kind === "bad" ? t.c.badPill : t.c.lineStrong;
  return (
    // In a line of text it sits on the line's middle, as vertical-align: middle sets it.
    <View style={{ borderWidth: 1, borderColor: line, borderRadius: 999, paddingHorizontal: 8, alignSelf: "center", verticalAlign: "middle" } as ViewStyle}>
      <T numberOfLines={1} style={[font(t, "mono", 500, 10.5, 1.7), { color }]}>
        {children}
      </T>
    </View>
  );
}

/** .cfg-head: a section's title (21px at phone width) and the sentence under it. */
export function Head({ title, lead }: { title: string; lead: ReactNode }) {
  const t = useTheme();
  return (
    <View>
      <T accessibilityRole="header" style={[font(t, "sans", 700, 21, 1.15), { color: t.c.text, letterSpacing: -0.42 }]}>
        {title}
      </T>
      <Txt tone="muted" style={{ marginTop: 4 }}>
        {lead}
      </Txt>
    </View>
  );
}

/**
 * .cfg .seg at phone width: the panel's width in segments that share it by
 * their names' length, or one per line when the names are long. `compact`
 * keeps short names side by side at their own width.
 */
export function Seg<K extends string>({ value, options, onChange, label, disabled, compact }: {
  value: K | null;
  options: ReadonlyArray<{ id: K; name: string; disabled?: boolean }>;
  onChange: (v: K) => void;
  label: string;
  disabled?: boolean;
  compact?: boolean;
}) {
  const t = useTheme();
  const stack = !compact && segStacks(options.map((o) => o.name));
  const text: TextStyle = t.editor ? font(t, "sans", 400, 12, 1.2) : { ...font(t, "mono", 500, 11.5, 1.2), letterSpacing: 0.23 };
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={{ flexDirection: stack ? "column" : "row", flexWrap: compact ? "wrap" : "nowrap", alignSelf: compact ? "flex-start" : "stretch", borderWidth: 1, borderColor: t.c.lineStrong, borderRadius: t.radius, overflow: "hidden", maxWidth: "100%" }}>
      {options.map((o, i) => {
        const on = value === o.id;
        const off = disabled || o.disabled;
        return (
          <Pressable
            key={o.id}
            accessibilityRole="radio"
            accessibilityLabel={o.name}
            accessibilityState={{ checked: on, disabled: !!off }}
            disabled={off}
            onPress={() => !on && onChange(o.id)}
            style={[
              { minHeight: 44, minWidth: 44, paddingVertical: 6, paddingHorizontal: 11, justifyContent: "center", backgroundColor: on ? t.c.accentWash : "transparent", opacity: off ? 0.45 : 1 },
              // Stacked, the choices touch, each after the first under its own line.
              stack ? { borderTopWidth: i ? 1 : 0, borderTopColor: t.c.lineStrong } :{ borderLeftWidth: i ? 1 : 0, borderLeftColor: t.c.lineStrong, flexGrow: compact ? 0 : 1, flexShrink: 1, flexBasis: "auto" },
            ]}
          >
            {on ? <View pointerEvents="none" style={stack ? { position: "absolute", left: 0, top: 0, bottom: 0, width: 3, backgroundColor: t.c.accent } : { position: "absolute", left: 0, right: 0, bottom: 0, height: 2, backgroundColor: t.c.accent }} /> : null}
            <T style={[text, { color: on ? t.c.text : t.c.muted, textAlign: stack ? "left" : "center" }]}>{o.name}</T>
          </Pressable>
        );
      })}
    </View>
  );
}

/** .cfg button.switch: 34 by 20, its knob sliding right when on, with a 44px reach around it. */
export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  const t = useTheme();
  return (
    <Pressable accessibilityRole="switch" accessibilityLabel={label} accessibilityState={{ checked: on, disabled: !!disabled }} disabled={disabled} hitSlop={{ top: 13, bottom: 13, left: 6, right: 6 }} onPress={() => onChange(!on)} style={{ width: 34, height: 20, borderRadius: 999, borderWidth: 1, borderColor: disabled ? t.c.disabledLine : on ? t.c.accent : t.c.lineStrong, backgroundColor: on ? t.c.accent : t.c.panel3, flexShrink: 0 }}>
      <View style={{ position: "absolute", top: 2, left: on ? 16 : 2, width: 14, height: 14, borderRadius: 7, backgroundColor: on ? t.c.onAccent : t.c.muted }} />
    </Pressable>
  );
}

/**
 * .cfg .toggle-row: what a setting is and does, with its control. `inline`
 * keeps the control at the end of the line; otherwise, at phone width, it goes
 * under the words, the panel's width. `first` drops the line above it.
 */
export function SettingRow({ title, help, children, inline: asked, first, badge, style, field }: { title: ReactNode; help?: ReactNode; children?: ReactNode; inline?: boolean; first?: boolean; badge?: ReactNode; style?: StyleProp<ViewStyle>; field?: boolean }) {
  const t = useTheme();
  // A row whose control is a text field puts the field under its words at phone width, inline or not.
  const inline = asked && !field;
  return (
    <View style={[{ flexDirection: inline ? "row" : "column", alignItems: inline ? "flex-start" : "stretch", gap: inline ? 14 : 8, paddingVertical: 11, borderTopWidth: first ? 0 : 1, borderTopColor: t.c.line }, style]}>
      <View style={inline ? { flex: 1, minWidth: 0 } : undefined}>
        <Txt weight={500}>
          {title}
          {badge}
        </Txt>
        {help ? (
          <Txt size={12} tone="dim" style={{ marginTop: 2 }}>
            {help}
          </Txt>
        ) : null}
      </View>
      {children}
    </View>
  );
}

/**
 * .cfg .opt: a choice with a sentence beside it, its radio at the start. On a
 * touch screen the row centres its radio, and the browser shrinks the radio
 * with the text as flex items share the row: the radio keeps 20px of its own
 * width scaled by the room left over the text's one-line width.
 */
export function Opt({ on, onPick, title, desc, disabled, overridden, label }: { on: boolean; onPick: () => void; title: ReactNode; desc?: ReactNode; disabled?: boolean; overridden?: boolean; label?: string }) {
  const t = useTheme();
  const [row, setRow] = useState<number | null>(null);
  const [line, setLine] = useState<number | null>(null);
  const text = (
    <Txt>
      <Span weight={600}>{title}</Span>
      {desc ? <Txt size={12} tone="muted"> {desc}</Txt> : null}
    </Txt>
  );
  // Room for the radio and the text: the row less its border, padding, gap and the radio's margins.
  const room = row === null ? null : row - 2 - 24 - 10 - 8;
  // Never under 13px, the narrowest a browser draws a radio.
  const radio = room !== null && line !== null && 20 + line > room ? Math.max(13, (20 * room) / (20 + line)) : 20;
  return (
    <Pressable accessibilityRole="radio" accessibilityLabel={label} accessibilityState={{ checked: on, disabled: !!disabled }} disabled={disabled} onPress={onPick} onLayout={(e) => setRow(e.nativeEvent.layout.width)} style={{ flexDirection: "row", gap: 10, alignItems: "center", minHeight: 44, paddingVertical: 10, paddingHorizontal: 12, borderWidth: 1, borderRadius: t.radius, borderColor: on ? t.c.accentLine : t.c.line, backgroundColor: on ? t.c.accentWash : t.c.panel2, opacity: overridden ? 0.6 : 1 }}>
      <Radio on={on} disabled={disabled} width={radio} />
      <View style={{ flex: 1, minWidth: 0 }}>{text}</View>
      {/* The text on one line, off the screen, to know how wide it would be. */}
      <View pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={{ position: "absolute", left: -10000, top: 0, width: 9000, flexDirection: "row" }}>
        <View onLayout={(e) => setLine(e.nativeEvent.layout.width)}>{text}</View>
      </View>
    </Pressable>
  );
}

/**
 * input[type=radio], as Chrome draws one in a dark page: a #3b3b3b disc in a
 * 1px ring, grey when off, the accent when chosen, with a dot 60% across. A
 * radio narrowed by its row draws its disc at the narrower size. Disabled,
 * ring and dot are grey.
 */
export function Radio({ on, disabled, style, width = 20 }: { on: boolean; disabled?: boolean; style?: StyleProp<ViewStyle>; width?: number }) {
  const t = useTheme();
  const d = Math.min(width, 20);
  const ring = disabled ? (on ? "#757575" : "#626262") : on ? t.c.accent : "#838383";
  return (
    // The browser's own margin around a radio: 3px above and right, 5px left.
    <View style={[{ width, height: 20, marginTop: 3, marginRight: 3, marginLeft: 5, alignItems: "center", justifyContent: "center", flexShrink: 0 }, style]}>
      <View style={{ width: d, height: d, borderRadius: d / 2, borderWidth: 1, borderColor: ring, backgroundColor: "#3b3b3b", alignItems: "center", justifyContent: "center" }}>
        {on ? <View style={{ width: d * 0.6, height: d * 0.6, borderRadius: d * 0.3, backgroundColor: disabled ? "#757575" : t.c.accent }} /> : null}
      </View>
    </View>
  );
}

/** input[type=checkbox] at 20px. */
export function Box({ on, disabled, style }: { on: boolean; disabled?: boolean; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  // The browser's own margin around a checkbox: 3px, 4px on the left.
  style = [{ margin: 3, marginLeft: 4 }, style];
  const color = disabled ? t.c.disabledLine : t.c.accent;
  return (
    <View style={[{ width: 20, height: 20, borderRadius: 3, borderWidth: on ? 0 : 1.5, borderColor: disabled ? t.c.disabledLine : t.c.muted, backgroundColor: on ? color : "transparent", alignItems: "center", justifyContent: "center", flexShrink: 0 }, style]}>
      {/* The browser's check, in the colour that reads on the accent (dark on orange, white on blue). */}
      {on ? (
        <Svg width={14} height={14} viewBox="0 0 14 14" fill="none" stroke={disabled ? "#ffffff" : t.c.onAccent} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
          <Path d="M3 7.2l2.8 2.8L11 4.6" />
        </Svg>
      ) : null}
    </View>
  );
}

/** A whole number typed into a box, saved on blur or Enter (NumberField). */
export function NumberField({ value, onSave, min, max, extra, nullable, label, placeholder = "none", width = 120, disabled }: {
  value: number | null;
  onSave: (v: number | null) => void;
  min: number;
  max: number;
  extra?: number;
  nullable?: boolean;
  label: string;
  placeholder?: string;
  width?: number;
  disabled?: boolean;
}) {
  const t = useTheme();
  const [text, setText] = useState(value === null ? "" : value.toLocaleString("en-US"));
  useEffect(() => setText(value === null ? "" : value.toLocaleString("en-US")), [value]);
  const raw = text.replace(/[,\s_]/g, "");
  const n = Number(raw);
  const valid = raw === "" ? !!nullable : Number.isInteger(n) && ((n >= min && n <= max) || n === extra);
  const save = () => {
    const next = raw === "" ? null : n;
    if (valid && next !== value) onSave(next);
  };
  return (
    <TextInput
      accessibilityLabel={label}
      keyboardType="number-pad"
      editable={!disabled}
      placeholder={placeholder}
      placeholderTextColor={t.c.dim}
      value={text}
      onChangeText={setText}
      onBlur={save}
      onSubmitEditing={save}
      style={[{ width, minHeight: 44, backgroundColor: t.c.panel2, color: disabled ? t.c.dim : t.c.text, borderWidth: 1, borderColor: valid ? t.c.lineStrong : t.c.bad, borderRadius: t.radius, paddingVertical: 6, paddingHorizontal: 10, fontVariant: ["tabular-nums"] }, font(t, "sans", 400, 16, ratio(t))]}
    />
  );
}

/** A message under a section: saved, or what went wrong (useMessage). */
export function useMessage() {
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  return {
    message,
    ok: (text: string) => setMessage({ ok: true, text }),
    fail: (e: Error | string) => setMessage({ ok: false, text: typeof e === "string" ? e : e.message }),
    clear: () => setMessage(null),
  };
}

/**
 * A page's scroller style: react-native-web puts every ScrollView on its own
 * compositing layer (translateZ), where Chrome stops snapping text to whole
 * pixels and each line lands up to a pixel off the web page's. The page's own
 * scroller has no such layer, so the browser build drops it; native ignores this.
 */
export const pageScroll = Platform.OS === "web" ? ({ transform: "none" } as unknown as ViewStyle) : null;

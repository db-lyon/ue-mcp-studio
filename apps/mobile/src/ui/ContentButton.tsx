/**
 * A button inside the conversation, as styles.css draws it on a phone: button,
 * .primary, .ghost, .danger-button and .small-button, at least 44px each way,
 * and a ghost one outlined like the rest (`.transcript button.ghost` and its
 * siblings under a coarse pointer). A small button's text takes the size of
 * the text around it (`font-size: inherit`); pass it as `fontSize`.
 */
import type { ReactNode } from "react";
import { Pressable, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { font, T } from "./Text";
import { useTheme } from "./ThemeProvider";
import type { Theme } from "./theme";

export type ContentButtonKind = "default" | "primary" | "ghost" | "danger";

/** A button's text: 500 11.5px/1.2 mono with 0.02em in ue-mcp, 400 12px/1.2 sans in the editor themes. */
export function buttonFont(t: Theme, primary = false, fontSize?: number): TextStyle {
  if (t.editor) return font(t, "sans", 400, 12, 1.2);
  const size = fontSize ?? 11.5;
  return { ...font(t, "mono", primary ? 600 : 500, size, 1.2), letterSpacing: size * 0.02 };
}

export function ContentButton({ title, onPress, kind = "default", small, fontSize, disabled, label, style, textStyle, children, accessibilityState }: {
  title?: string;
  onPress?: () => void;
  kind?: ContentButtonKind;
  small?: boolean;
  /** The inherited size of a small button's text (ue-mcp only: the editor themes fix it at 12px). */
  fontSize?: number;
  disabled?: boolean;
  label?: string;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  children?: ReactNode;
  accessibilityState?: { expanded?: boolean };
}) {
  const t = useTheme();
  const primary = kind === "primary";
  const bg = primary ? (disabled ? "transparent" : t.c.accent) : t.c.panel2;
  const border = disabled ? t.c.disabledLine : primary ? t.c.accent : kind === "danger" ? t.c.bad : t.c.lineStrong;
  const color = disabled ? t.c.dim : primary ? t.c.onAccent : kind === "danger" ? t.c.bad : t.c.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label ?? title}
      accessibilityState={{ disabled: !!disabled, ...accessibilityState }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        { backgroundColor: bg, borderColor: border, borderWidth: 1, borderRadius: t.radius, paddingVertical: small ? 0 : 6, paddingHorizontal: small ? 10 : 12, minHeight: 44, minWidth: 44, alignItems: "center", justifyContent: "center", flexDirection: "row" },
        pressed && !disabled && (primary ? { backgroundColor: t.c.accentHi, borderColor: t.c.accentHi } : { borderColor: t.c.accentLine, backgroundColor: t.c.panel3 }),
        style,
      ]}
    >
      {children ?? <T style={[buttonFont(t, primary, small ? fontSize : undefined), { color }, textStyle]}>{title}</T>}
    </Pressable>
  );
}

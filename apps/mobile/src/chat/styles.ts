/** Type styles the chat's own pieces share, each named for the CSS it mirrors. */
import type { TextStyle } from "react-native";
import { font, type Theme } from "../ui";

/** button: mono 500 11.5px, 0.02em (the editor themes: sans 400 12px). */
export const buttonText = (t: Theme, weight: 500 | 600 = 500): TextStyle =>
  t.editor ? font(t, "sans", 400, 12, 1.2) : { ...font(t, "mono", weight, 11.5, 1.2), letterSpacing: 0.23 };

/** .small: 12px at the body's 1.55 line height. */
export const small = (t: Theme): TextStyle => ({ ...font(t, "sans", 400, 12), lineHeight: Math.round(12 * (t.editor ? 1.5 : 1.55) * 100) / 100 });

/** .mono inside text of `size`: 0.92em of it. */
export const mono = (t: Theme, size: number, weight: 400 | 500 | 600 | 700 = 400): TextStyle => font(t, "mono", weight, Math.round(size * 0.92 * 100) / 100);

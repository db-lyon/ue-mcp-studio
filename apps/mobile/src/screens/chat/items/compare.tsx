/**
 * The width tiers every change card lays out by (the web client's
 * chat/compare.tsx). The layout follows the card's own width, measured as it
 * lays out, as the web client's tiers do (client-core's compareTier).
 */
import { useState } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import { compareTier, COMPARE_TIERS, type CompareTier } from "@ue-mcp-studio/client-core";
import { colorOf } from "@ue-mcp-studio/shared";
import { useTheme } from "../../../ui";

export { colorOf, compareTier, COMPARE_TIERS, type CompareTier };

/** The tier and width of a view, kept as it lays out: spread `onLayout` on it. */
export function useCardSize(em: number): { tier: CompareTier; width: number; onLayout: (e: LayoutChangeEvent) => void } {
  const [width, setWidth] = useState(0);
  return { tier: compareTier(width, em), width, onLayout: (e) => setWidth(e.nativeEvent.layout.width) };
}

/** The tier of a view, kept as it lays out: spread `onLayout` on it. */
export function useCompareTier(em: number): { tier: CompareTier; onLayout: (e: LayoutChangeEvent) => void } {
  const { tier, onLayout } = useCardSize(em);
  return { tier, onLayout };
}

/**
 * .cmp-swatch: a small swatch of a colour value, inline before its text, which
 * stays as the engine wrote it. 10 pixels square, 5 before the text, its
 * bottom a pixel under the baseline.
 */
export function Swatch({ text, color }: { text?: string; color?: string | null }) {
  const t = useTheme();
  const c = color ?? (text !== undefined ? colorOf(text) : null);
  return c ? <View testID="swatch" style={{ width: 10, height: 10, marginRight: 5, marginBottom: -1, borderRadius: 2, borderWidth: 1, borderColor: t.c.lineStrong, backgroundColor: c }} /> : null;
}

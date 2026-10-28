import { createContext, useContext } from "react";

/**
 * How much of the composer bar fits, widest first. Send and Stop never change;
 * the rest gives way in this order as the bar narrows:
 *
 * - full: every control with its words, the model's route badge and the key hint.
 * - compact: the route badge, the "Effort" word and the key hint go.
 * - icons: Checkpoints and Attach become icon buttons.
 * - merged: the model and the effort become one chip with one menu.
 * - narrowest: that menu opens across the whole bar.
 */
export type BarTier = "full" | "compact" | "icons" | "merged" | "narrowest";

/** Each tier's least bar width, in ems of the bar's font, so a larger UI font steps down sooner. */
export const BAR_TIERS: readonly [BarTier, number][] = [["full", 54], ["compact", 44], ["icons", 34], ["merged", 26]];

/** The tier for a bar this wide. An unmeasured bar (no layout yet) is full. */
export function barTier(width: number, em: number): BarTier {
  if (!(width > 0)) return "full";
  const ems = width / (em > 0 ? em : 13.5);
  return BAR_TIERS.find(([, min]) => ems >= min)?.[0] ?? "narrowest";
}

/** At or below a tier: `atMost("icons", t)` is true for icons, merged and narrowest. */
export function atMost(tier: BarTier, t: BarTier): boolean {
  const order: BarTier[] = ["full", "compact", "icons", "merged", "narrowest"];
  return order.indexOf(t) >= order.indexOf(tier);
}

export const BarTierContext = createContext<BarTier>("full");

/** The composer bar's tier, for a control inside it; full anywhere else. */
export const useBarTier = (): BarTier => useContext(BarTierContext);

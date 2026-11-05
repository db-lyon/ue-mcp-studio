/**
 * The width tiers every change card lays out by: the asset diff's tree grid
 * keeps Before and After in columns on a wide card and puts them under the
 * property's name on a narrow one. The layout follows the card's own width,
 * never the window's, since a wide window often holds a narrow chat. The UI
 * targets Chrome 90, which has no container queries, so the card is measured
 * with a ResizeObserver and the tier set as an attribute the stylesheet reads.
 */
import { useLayoutEffect, useState, type RefObject } from "react";
import { COMPARE_TIERS, compareTier, type CompareTier } from "@ue-mcp-studio/client-core";
import { colorOf } from "@ue-mcp-studio/shared";

export { COMPARE_TIERS, colorOf, compareTier, type CompareTier };

/** The tier and width of the element the ref holds, kept as it resizes. */
export function useCardSize(ref: RefObject<HTMLElement>): { tier: CompareTier; width: number; em: number } {
  const [size, setSize] = useState<{ tier: CompareTier; width: number; em: number }>({ tier: "wide", width: 0, em: 13.5 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const width = el.clientWidth;
      const em = parseFloat(getComputedStyle(el).fontSize) || 13.5;
      const tier = compareTier(width, em);
      setSize((o) => (o.tier === tier && o.width === width && o.em === em ? o : { tier, width, em }));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/** The tier of the element the ref holds, kept as it resizes. */
export const useCompareTier = (ref: RefObject<HTMLElement>): CompareTier => useCardSize(ref).tier;

/** A small swatch of a colour value, beside its text, which stays as the engine wrote it. */
export function Swatch({ text }: { text: string }) {
  const c = colorOf(text);
  return c ? <span className="cmp-swatch" style={{ background: c }} aria-hidden="true" /> : null;
}

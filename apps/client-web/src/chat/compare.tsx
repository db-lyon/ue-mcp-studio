/**
 * The Change | Before | After comparison every change card uses: Blueprint
 * graphs, a level's actors, material parameters, a version's facts. Its layout
 * follows the card's own width, never the window's, since a wide window often
 * holds a narrow chat. The UI targets Chrome 90, which has no container
 * queries, so the card is measured with a ResizeObserver and the tier set as
 * an attribute the stylesheet reads. The markup is the same in every tier.
 *
 * - wide: the three-column table, Change 40% and Before and After halves of the rest.
 * - medium: the change across the card, then Before and After side by side, each labelled.
 * - narrow: the change, then a labelled Before, then a labelled After; an empty side is left out.
 * - tiny: narrow, with each key above its value in a pin list.
 */
import { useLayoutEffect, useState, type ReactNode, type RefObject } from "react";
import { COMPARE_TIERS, colorOf, compareTier, type CompareTier } from "@ue-mcp-studio/client-core";
import { EngineText } from "./breakable";

export { COMPARE_TIERS, compareTier, type CompareTier };

/** The tier of the element `ref` holds, kept as it resizes. */
export function useCompareTier(ref: RefObject<HTMLElement>): CompareTier {
  const [tier, setTier] = useState<CompareTier>("wide");
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setTier(compareTier(el.clientWidth, parseFloat(getComputedStyle(el).fontSize)));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return tier;
}

export { colorOf };

/** A small swatch of a colour value, beside its text, which stays as the engine wrote it. */
export function Swatch({ text }: { text: string }) {
  const c = colorOf(text);
  return c ? <span className="cmp-swatch" style={{ background: c }} aria-hidden="true" /> : null;
}

/** Pin or fact values as a grid: muted labels in one column, monospace values in the other, one per line. */
export function KeyValues({ values }: { values: Array<{ name: string; value: string }> }) {
  return (
    <dl className="cmp-kv">
      {values.map((v) => (
        <div key={v.name}>
          <dt><EngineText text={v.name} /></dt>
          <dd className="mono"><Swatch text={v.value} /><EngineText text={v.value} /></dd>
        </div>
      ))}
    </dl>
  );
}

/** One side of a row: content, absent on that side (`absent`, shown dimmed and left out when stacked), or nothing (left out when stacked). */
export type CompareSide = { content: ReactNode } | "absent" | null;

/** A row of the comparison, always three cells, each in its column. */
export function CompareRow({ tone, change, before, after, sub }: {
  tone: string;
  change: ReactNode;
  before: CompareSide;
  after: CompareSide;
  /** A property under the row above it. */
  sub?: boolean;
}) {
  const cell = (side: CompareSide, label: "Before" | "After") => {
    if (side === null) return <td data-label={label} className="cmp-side cmp-empty" />;
    if (side === "absent") return <td data-label={label} className="cmp-side cmp-absent"><span className="dim">{label === "Before" ? "not there" : "gone"}</span></td>;
    return <td data-label={label} className="cmp-side">{side.content}</td>;
  };
  return (
    <tr className={`diff-row ${tone}${sub ? " sub" : ""}${before === null && after === null ? " bare" : ""}`}>
      <td className="cmp-change">{change}</td>
      {cell(before, "Before")}
      {cell(after, "After")}
    </tr>
  );
}

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
import { EngineText } from "./breakable";

export type CompareTier = "wide" | "medium" | "narrow" | "tiny";

/** Each tier's least card width in ems of the card's font, so a larger UI font steps down sooner. */
export const COMPARE_TIERS: readonly [CompareTier, number][] = [["wide", 47], ["medium", 31], ["narrow", 20]];

/** The tier for a card this wide. An unmeasured card (no layout yet) is wide. */
export function compareTier(width: number, em: number): CompareTier {
  if (!(width > 0)) return "wide";
  const ems = width / (em > 0 ? em : 13.5);
  return COMPARE_TIERS.find(([, min]) => ems >= min)?.[0] ?? "tiny";
}

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

const toSrgb = (c: number): number => {
  const v = Math.min(1, Math.max(0, c));
  return Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
};

/**
 * The CSS colour of a colour value as ExportText writes it: an FLinearColor,
 * (R=0.5,G=0.1,B=0,A=1), converted from linear, or an FColor, (B=0,G=0,R=255,A=255).
 * Null for any other text.
 */
export function colorOf(text: string): string | null {
  const m = /^\(([^()]*)\)$/.exec(text.trim());
  if (!m) return null;
  const f = new Map<string, number>();
  for (const part of m[1].split(",")) {
    const kv = /^\s*([RGBA])=(-?\d+(?:\.\d+)?)\s*$/.exec(part);
    if (!kv) return null;
    f.set(kv[1], Number(kv[2]));
  }
  if (!["R", "G", "B"].every((k) => f.has(k)) || f.size !== m[1].split(",").length) return null;
  const linear = /\./.test(m[1]);
  const [r, g, b] = ["R", "G", "B"].map((k) => (linear ? toSrgb(f.get(k)!) : Math.min(255, Math.max(0, Math.round(f.get(k)!)))));
  const a = f.has("A") ? Math.min(1, Math.max(0, linear ? f.get("A")! : f.get("A")! / 255)) : 1;
  return `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(3))})`;
}

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

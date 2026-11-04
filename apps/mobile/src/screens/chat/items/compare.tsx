/**
 * The Change | Before | After comparison every change card uses: Blueprint
 * graphs, a level's actors, material parameters, a version's facts. Its
 * layout follows the card's own width, measured as it lays out, as the web
 * client's tiers do (client-core's compareTier).
 *
 * - wide: three columns, Change 40% and Before and After halves of the rest.
 * - medium: the change across the card, then Before and After side by side, each labelled.
 * - narrow: the change, then a labelled Before, then a labelled After; an empty side is left out.
 * - tiny: narrow, with each key above its value.
 */
import { createContext, useContext, useState, type ReactNode } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import { colorOf, compareTier, COMPARE_TIERS, type CompareTier } from "@ue-mcp-studio/client-core";
import { font, T, useTheme } from "./ui";
import { engineText } from "./breakable";

export { colorOf, compareTier, COMPARE_TIERS, type CompareTier };

export const CompareTierContext = createContext<CompareTier>("wide");
export const useTier = (): CompareTier => useContext(CompareTierContext);

/** The tier of a view this wide, kept as it lays out: spread `onLayout` on it. */
export function useCompareTier(em: number): { tier: CompareTier; onLayout: (e: LayoutChangeEvent) => void } {
  const [tier, setTier] = useState<CompareTier>("wide");
  return { tier, onLayout: (e) => setTier(compareTier(e.nativeEvent.layout.width, em)) };
}

/** A small swatch of a colour value, beside its text, which stays as the engine wrote it. */
export function Swatch({ text }: { text: string }) {
  const t = useTheme();
  const c = colorOf(text);
  return c ? <View style={{ width: 10, height: 10, marginRight: 5, marginTop: 3, borderRadius: 2, borderWidth: 1, borderColor: t.c.lineStrong, backgroundColor: c }} /> : null;
}

/** Pin or fact values: muted labels in one column, monospace values in the other, one per line; tiny stacks them. */
export function KeyValues({ values }: { values: Array<{ name: string; value: string }> }) {
  const t = useTheme();
  const tiny = useTier() === "tiny";
  const size = 12;
  const lh = t.editor ? 1.5 : 1.55;
  // grid-template-columns: minmax(0, max-content) 1fr: the names' column is as wide as the widest name, at most half.
  const [box, setBox] = useState(0);
  const [widest, setWidest] = useState(0);
  const nameWidth = widest > 0 && box > 0 ? Math.min(widest, (box - 10) / 2) : undefined;
  return (
    <View style={{ gap: tiny ? 0 : 2 }} onLayout={(e) => setBox(e.nativeEvent.layout.width)}>
      {values.map((v) => (
        <View key={v.name} style={{ flexDirection: tiny ? "column" : "row", columnGap: 10, marginBottom: tiny ? 3 : 0 }}>
          <T
            onLayout={nameWidth === undefined ? (e) => { const w = Math.ceil(e.nativeEvent.layout.width) + 1;setWidest((cur) => Math.max(cur, w)); } : undefined}
            style={{ fontSize: size, lineHeight: size * lh, color: t.c.muted, ...(tiny ? {} : nameWidth === undefined ? { flexShrink: 0 } : { width: nameWidth }) }}
          >
            {engineText(v.name)}
          </T>
          <View style={{ flexDirection: "row", flex: tiny ? undefined : 1, minWidth: 0 }}>
            <Swatch text={v.value} />
            <T style={[font(t, "mono", 400, size * 0.92), { lineHeight: size * lh, color: t.c.text, flexShrink: 1 }]}>{engineText(v.value)}</T>
          </View>
        </View>
      ))}
    </View>
  );
}

/** One side of a row: content, absent on that side (`absent`, dimmed, left out when stacked), or nothing (left out when stacked). */
export type CompareSide = { content: ReactNode } | "absent" | null;

/** .diff-table-wrap: the comparison's frame, with its tier for the rows inside. */
export function CompareTable({ tier, head, children }: { tier: CompareTier; head?: [string, string?, string?]; children: ReactNode }) {
  const t = useTheme();
  return (
    <CompareTierContext.Provider value={tier}>
      <View style={{ borderWidth: 1, borderColor: t.c.line, borderRadius: 4, overflow: "hidden" }}>
        {head && tier === "wide" ? (
          <View style={{ flexDirection: "row", backgroundColor: t.c.panel2, borderBottomWidth: 1, borderBottomColor: t.c.line }}>
            {head.map((h, i) =>
              h === undefined ? null : (
                <View key={i} style={{ width: i === 0 ? "40%" : undefined, flex: i === 0 ? undefined : 1, paddingVertical: 5, paddingHorizontal: 8, borderLeftWidth: i ? 1 : 0, borderLeftColor: t.c.lineStrong, backgroundColor: i === 1 ? t.c.diffBefore : i === 2 ? t.c.diffAfter : undefined }}>
                  <T weight={600} size={12} style={{ color: t.c.muted }}>{h}</T>
                </View>
              ),
            )}
          </View>
        ) : null}
        <View style={{ marginBottom: -1 }}>{children}</View>
      </View>
    </CompareTierContext.Provider>
  );
}

/** A group's heading row: the actor, component, variable or row its records belong to. */
export function CompareGroup({ children }: { children: string }) {
  const t = useTheme();
  return (
    <View style={{ backgroundColor: t.c.panel2, paddingVertical: 5, paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: t.c.line }}>
      <T weight={600} size={12} lh={t.editor ? 1.5 : 1.55}>{engineText(children)}</T>
    </View>
  );
}

/** A row of the comparison: the change, and each side in its column or stacked under it by tier. */
export function CompareRow({ tone, change, before, after, sub, index = 0 }: {
  tone: string;
  change: ReactNode;
  before: CompareSide;
  after: CompareSide;
  /** A property under the row above it. */
  sub?: boolean;
  /** Its place among its rows, for the wide table's banding. */
  index?: number;
}) {
  const t = useTheme();
  const tier = useTier();
  const minor = tone === "minor";
  const stacked = tier === "narrow" || tier === "tiny";
  const bare = before === null && after === null;
  const cell = (side: CompareSide, label: "Before" | "After", first: boolean) => {
    if (stacked && (side === null || side === "absent")) return null;
    if (tier === "medium" && bare) return null;
    const bg = label === "Before" ? t.c.diffBefore : t.c.diffAfter;
    return (
      <View key={label} style={{ flex: stacked ? undefined : 1, minWidth: 0, paddingVertical: 5, paddingHorizontal: 8, backgroundColor: bg, opacity: minor ? 0.75 : 1, ...(stacked ? { borderTopWidth: 1, borderTopColor: t.c.line, borderStyle: "dashed" as const } : { borderLeftWidth: first && tier === "medium" ? 0 : 1, borderLeftColor: t.c.lineStrong }) }}>
        {tier !== "wide" ? <T style={{ fontSize: 10, lineHeight: 15.5, letterSpacing: 0.5, textTransform: "uppercase", color: t.c.dim }}>{label}</T> : null}
        {side === null ? null : side === "absent" ? <T size={12} tone="dim">{label === "Before" ? "not there" : "gone"}</T> : side.content}
      </View>
    );
  };
  const changeCell = (
    <View style={{ width: tier === "wide" ? "40%" : undefined, paddingVertical: 5, paddingRight: 8, paddingLeft: sub ? 22 : 8, backgroundColor: tier === "wide" && index % 2 === 1 ? t.c.tint : undefined }}>
      {change}
    </View>
  );
  return (
    <View style={{ borderBottomWidth: 1, borderBottomColor: t.c.line, flexDirection: tier === "wide" ? "row" : "column" }}>
      {changeCell}
      {tier === "wide" ? (
        <>
          {cell(before, "Before", false)}
          {cell(after, "After", false)}
        </>
      ) : tier === "medium" ? (
        bare ? null : (
          <View style={{ flexDirection: "row" }}>
            {cell(before, "Before", true)}
            {cell(after, "After", false)}
          </View>
        )
      ) : (
        <>
          {cell(before, "Before", true)}
          {cell(after, "After", false)}
        </>
      )}
    </View>
  );
}

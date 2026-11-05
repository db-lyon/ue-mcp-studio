/**
 * A card's step path: a bar per step, coloured as the step's border is in the
 * full card, a dot inside the bar of a step a person judges. Each bar is a
 * 44 point target that opens the card on its step; a bar with keyboard focus
 * names its step under the path. The legend says what the marks on screen mean.
 */
import { lhOf } from "./live";
import { useState } from "react";
import { Platform, Pressable, View, type ViewStyle } from "react-native";
import { PATH_MARKS, markOf, marksOf, statusLabel, stepBarLabel, stepPlain, type PathMark } from "@ue-mcp-studio/client-core";
import type { QaRun, QaStep } from "@ue-mcp-studio/shared";
import { T, font, useStyles, useTheme, type Theme } from "../../ui";

const bg = (css: string): ViewStyle => (Platform.OS === "web" ? { backgroundImage: css } : { experimental_backgroundImage: css }) as ViewStyle;
const shadow = (css: string): ViewStyle => ({ boxShadow: css }) as ViewStyle;

/** The running bar: color-mix(in srgb, --text, #fff 35%). */
function runFill(t: Theme): string {
  const n = parseInt(t.c.text.slice(1), 16);
  const m = (c: number) => Math.round(c * 0.65 + 255 * 0.35);
  return `rgb(${m((n >> 16) & 255)}, ${m((n >> 8) & 255)}, ${m(n & 255)})`;
}

/** A mark's bar: its fill, its outline, and where it sits in the 44 point target (a 24 point row). */
export function markStyle(t: Theme, mark: PathMark, legend = false): ViewStyle {
  switch (mark) {
    case "ok":
      return { backgroundColor: t.c.ok };
    case "bad":
      return { ...bg(`repeating-linear-gradient(135deg, ${t.c.bad} 0 3px, transparent 3px 5px)`), ...shadow(`inset 0 0 0 1.5px ${t.c.bad}`) };
    case "warn":
      return { backgroundColor: t.c.warn, top: 20, height: 12 };
    case "run":
      return { backgroundColor: runFill(t), top: 20, height: 12, ...shadow(`0 0 0 ${legend ? 1.5 : 2}px ${t.c.accent}`) };
    case "skipped":
      return shadow(`inset 0 0 0 1.5px ${t.c.muted}`);
    case "unrun":
      return { borderWidth: 1.5, borderStyle: "dashed", borderColor: t.c.muted };
    default:
      return { backgroundColor: t.c.lineStrong };
  }
}

/** Only keyboard focus names a step, as the web's :focus-visible: a tap focuses a bar on the web build too, and opens the card instead. */
export const keyboardFocus = (e: { target?: unknown; nativeEvent?: { target?: unknown } }): boolean => {
  if (Platform.OS !== "web") return true;
  const el = (e.target ?? e.nativeEvent?.target) as { matches?: (q: string) => boolean } | undefined;
  return !!el?.matches?.(":focus-visible");
};

export function StepPath({ steps, onStep, ended = false }: { steps: QaStep[]; onStep?: (index: number) => void; ended?: boolean }) {
  const t = useTheme();
  const s = useStyles(styles);
  const [focused, setFocused] = useState<number | null>(null);
  const on = focused === null ? null : steps.find((x) => x.index === focused) ?? null;
  return (
    <View style={s.wrap}>
      <View style={s.path} accessibilityLabel="Steps">
        {steps.map((step) => {
          const mark = markOf(step, ended);
          const tinted = mark === "ok" || mark === "warn" || mark === "run" || mark === "bad";
          const bar = (
            <>
              <View style={[s.bar, markStyle(t, mark), focused === step.index && s.barFocused]} />
              {step.judge === "manual" ? <View style={[s.dot, tinted && { backgroundColor: t.c.bg, opacity: 1 }, mark === "bad" && shadow(`0 0 0 1.5px ${t.c.bg}`)]} /> : null}
            </>
          );
          return (
            <View key={step.index} style={s.step} testID={`qa-path-step-${step.index}`}>
              {onStep ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={stepBarLabel(step, ended)}
                  onPress={() => onStep(step.index)}
                  onFocus={(e) => setFocused(keyboardFocus(e) ? step.index : null)}
                  onBlur={() => setFocused(null)}
                  style={[s.hit, s.noOutline]}
                >
                  {bar}
                </Pressable>
              ) : (
                <View accessibilityRole="image" accessibilityLabel={stepBarLabel(step, ended)} style={s.hit}>
                  {bar}
                </View>
              )}
            </View>
          );
        })}
      </View>
      {on ? (
        <View style={s.caption} aria-hidden>
          <T style={s.captionNum}>{on.index + 1}</T>
          <T style={s.captionText}>{stepPlain(on.instruction)}</T>
          <T style={s.captionState}>
            {on.judge === "auto" ? "Checked by the observer" : "Judged by a person"}: {statusLabel(on, ended)}
          </T>
        </View>
      ) : null}
    </View>
  );
}

/** What the step path's marks mean: only the ones on screen. */
export function PathLegend({ runs }: { runs: QaRun[] }) {
  const t = useTheme();
  const s = useStyles(styles);
  const { marks, person } = marksOf(runs);
  if (marks.size === 0) return null;
  return (
    <View style={s.legend} accessibilityLabel="What the step marks mean">
      {PATH_MARKS.filter(([m]) => marks.has(m)).map(([m, label]) => (
        <View key={m} style={s.legendItem}>
          <View style={[s.legendMark, markStyle(t, m, true), { top: 0, height: 8 }]} />
          <T style={s.legendText}>{label}</T>
        </View>
      ))}
      {person ? (
        <View style={s.legendItem}>
          <View style={[s.legendMark, { backgroundColor: t.c.lineStrong }]}>
            <View style={s.legendPip} />
          </View>
          <T style={s.legendText}>Judged by a person</T>
        </View>
      ) : null}
    </View>
  );
}

const styles = (t: Theme) => ({
  wrap: { position: "relative" as const, minWidth: 0 },
  path: { flexDirection: "row" as const, gap: 4, width: "100%" as const },
  step: { flex: 1, minWidth: 6, height: 24 },
  hit: { position: "relative" as const, height: 44, marginTop: -10, marginBottom: -10, borderRadius: 3 },
  bar: { position: "absolute" as const, left: 0, right: 0, top: 22, height: 8, borderRadius: 3 },
  // Keyboard focus: the bar grows and takes a ring with a gap of the page colour.
  barFocused: { top: 19, height: 14, boxShadow: `0 0 0 2px ${t.c.bg}, 0 0 0 4px ${t.c.text}` } as ViewStyle,
  noOutline: { outlineStyle: "none" } as unknown as ViewStyle,
  dot: { position: "absolute" as const, left: "50%" as const, top: 24, width: 4, height: 4, marginLeft: -2, borderRadius: 2, backgroundColor: t.c.text, opacity: 0.85, zIndex: 1 },
  caption: { marginTop: 4, flexDirection: "row" as const, alignItems: "baseline" as const, gap: 8, paddingVertical: 4, paddingHorizontal: 8, borderWidth: 1, borderColor: t.c.lineStrong, borderRadius: t.radius, backgroundColor: t.c.panel3 },
  captionNum: { ...font(t, "mono", 400, 12 * 0.92, lhOf(t)), color: t.c.text, width: 12 * 0.92 * 1.6, textAlign: "right" as const },
  captionText: { ...font(t, "sans", 400, 12, lhOf(t)), flex: 1, minWidth: 0, color: t.c.text },
  captionState: { ...font(t, "sans", 400, 12, lhOf(t)), flexShrink: 0, color: t.c.muted },
  legend: { flexDirection: "row" as const, flexWrap: "wrap" as const, rowGap: 4, columnGap: 12 },
  legendItem: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
  legendMark: { width: 18, height: 8, borderRadius: 3, position: "relative" as const },
  legendPip: { position: "absolute" as const, left: "50%" as const, top: 2, width: 4, height: 4, marginLeft: -2, borderRadius: 2, backgroundColor: t.c.text, opacity: 0.85 },
  legendText: { ...font(t, "sans", 400, 12, lhOf(t)), color: t.c.muted },
});

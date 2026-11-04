/**
 * The composer's context meter: how much of the model's window the
 * conversation takes now, as a small ring and a percentage that turn amber and
 * then red near the point it compacts. A phone has no hover, so the web's
 * hover card is the meter's accessibility hint here; a tap opens the numbers
 * behind it, Compact now, and the session's totals, which are spend, not
 * context, across the whole composer bar.
 */
import { useRef, useState, type ReactNode } from "react";
import { Modal, Platform, Pressable, ScrollView, StyleSheet, View, useWindowDimensions, type HostInstance } from "react-native";
import Svg, { Circle, Line } from "react-native-svg";
import { contextView, type ContextUsage, type ContextView, type SessionSpend } from "@ue-mcp-studio/shared";
import { compactLine, contextLabel, contextPct, contextRing, contextWarningText, dollars, pct, tipLines, tokenCount } from "@ue-mcp-studio/client-core";
import { atMost, useBarTier } from "./barTier";
import { Button, Pulse, font, labelFont, lineBox, T, useInsets, useTheme, type Theme } from "../../../ui";
import { buttonText, small } from "../../../chat/styles";

export { dollars };

const levelColor = (t: Theme, level: ContextView["level"]): string => (level === "high" ? t.c.bad : level === "warn" ? t.c.warn : t.c.ok);

/**
 * The context bar of the opened details: how full, and a tick where it compacts, across the width.
 * .context-bar draws its outline as an inset shadow, so the fill and the tick are placed against the full width.
 */
export function ContextBar({ view }: { view: ContextView }) {
  const t = useTheme();
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: "100%", height: 6, borderRadius: 3, backgroundColor: t.c.panel3, boxShadow: `inset 0 0 0 1px ${t.c.line}`, flexShrink: 0 }}>
      <View style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${Math.min(100, view.fraction * 100)}%`, minWidth: view.used > 0 ? 2 : 0, borderRadius: 3, backgroundColor: levelColor(t, view.level) }} />
      {view.fraction > 1 ? <View style={{ position: "absolute", right: -3, top: -2, bottom: -2, width: 3, borderRadius: 1, backgroundColor: t.c.bad, boxShadow: `0 0 6px ${t.c.bad}` }} /> : null}
      <View style={{ position: "absolute", top: -2, bottom: -2, width: 1, marginLeft: -0.5, left: `${view.compactAt * 100}%`, backgroundColor: t.c.muted, opacity: 0.7 }} />
    </View>
  );
}

const RING = 16;
const ringBox = { position: "absolute", left: 0, top: 0, width: RING, height: RING, overflow: "visible" } as const;

/**
 * The context ring: how full, as an arc from the top, clockwise, with a tick
 * where it compacts. Past the window the ring is closed and glows. Track, fill
 * and tick are three layers so the fill alone pulses while compacting.
 */
export function ContextRing({ view, pulsing = false }: { view: ContextView; pulsing?: boolean }) {
  const t = useTheme();
  const { r, circumference, dash, tick } = contextRing(view);
  const over = view.fraction > 1;
  // .context-ring.over { filter: drop-shadow(0 0 2.5px var(--bad)) }. iOS draws no drop-shadow filter, so a glow round the ring stands in.
  const glow = over ? (Platform.OS === "ios" ? { boxShadow: `0 0 2.5px ${t.c.bad}`, borderRadius: RING / 2 } : { filter: `drop-shadow(0 0 2.5px ${t.c.bad})` }) : null;
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[{ width: RING, height: RING, flexShrink: 0 }, glow]}>
      <Svg width={RING} height={RING} viewBox="0 0 16 16" style={ringBox}>
        <Circle cx={8} cy={8} r={r} fill="none" stroke={t.c.muted} strokeWidth={2.5} strokeOpacity={0.32} />
      </Svg>
      <Pulse on={pulsing} period={1600} style={ringBox}>
        <Svg width={RING} height={RING} viewBox="0 0 16 16" style={{ overflow: "visible" }}>
          <Circle cx={8} cy={8} r={r} fill="none" stroke={levelColor(t, view.level)} strokeWidth={2.5} strokeLinecap="butt" strokeDasharray={`${dash} ${circumference}`} transform="rotate(-90 8 8)" />
        </Svg>
      </Pulse>
      <Svg width={RING} height={RING} viewBox="0 0 16 16" style={ringBox}>
        <Line x1={tick.x1} y1={tick.y1} x2={tick.x2} y2={tick.y2} stroke={t.c.text} strokeWidth={1.25} strokeOpacity={0.75} />
      </Svg>
    </View>
  );
}

/** .context-ring-empty: the ring's track alone, before anything is measured. */
function EmptyRing() {
  const t = useTheme();
  return <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: RING, height: RING, borderRadius: RING / 2, borderWidth: 2.5, borderColor: t.c.muted, opacity: 0.32, flexShrink: 0 }} />;
}

/** button.icon-button: a 44 px square on panel-2. */
export function IconButton({ label, glyph, onPress }: { label: string; glyph: string; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => ({ width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: t.radius, borderWidth: 1, borderColor: pressed ? t.c.lineStrong : t.c.line, backgroundColor: t.c.panel2 })}>
      <T style={[buttonText(t), { color: t.c.muted }]}>{glyph}</T>
    </Pressable>
  );
}

export function ContextMeter({ context, totals, model, modelName, nameOf = (id) => id, listedWindow, busy, compacting, runtime, onCompact, owner }: {
  context: ContextUsage | undefined;
  totals: SessionSpend | undefined;
  /** The model the next turn runs on, by id, and as the picker names it. */
  model: string;
  modelName?: string;
  /** A model's name by its id, for the models a measurement was made on. */
  nameOf?: (id: string) => string;
  /** Its window as the vendor's list gave it. */
  listedWindow?: number;
  busy: boolean;
  compacting: boolean;
  /** The Claude sign-in: its runtime compacts on its own. */
  runtime: boolean;
  onCompact: () => void;
  /** Whose context it is, shown before the bar when that is not obvious (a subagent's thread is open). */
  owner?: string;
}) {
  const t = useTheme();
  const win = useWindowDimensions();
  const insets = useInsets();
  const [open, setOpen] = useState(false);
  const [bottom, setBottom] = useState(0);
  const button = useRef<HostInstance>(null);
  const tight = atMost("merged", useBarTier());
  const view = contextView(context, model, listedWindow);
  if (!view && !totals?.requests) return null;
  const runtimeNow = runtime && !view?.measuredOn && !!context?.window;
  const label = contextLabel(view, owner, compacting);
  // The web's hover card, which describes the button (aria-describedby) while the details are closed.
  const tip = view ? tipLines(view, context, { nameOf, modelName: modelName ?? model, runtime: runtimeNow, compacting, owner }) : ["Context is measured after the next reply"];
  const pctColor = view?.level === "warn" ? t.c.warn : view?.level === "high" ? t.c.bad : t.c.muted;
  const toggle = () => {
    if (open) return setOpen(false);
    // The details open over the conversation, 6 px above the composer bar, across its width.
    setOpen(true);
    button.current?.measureInWindow((_x, y) => setBottom(win.height - y + 6));
  };
  // .context-pop p { margin: 4px 0 }: the web's margins collapse, so each paragraph keeps only its top margin here and the box adds the last one's bottom.
  const p = (children: ReactNode, extra?: object) => <T style={[small(t), { color: t.c.dim, marginTop: 4 }, extra]}>{children}</T>;
  return (
    <View>
      <Pressable
        ref={button}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ expanded: open }}
        accessibilityHint={open ? undefined : tip.join(". ")}
        onPress={toggle}
        style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: tight ? 4 : 5, minHeight: 44, paddingHorizontal: tight ? 5 : 7, borderRadius: t.radius, borderWidth: 1, borderColor: pressed ? t.c.line : "transparent", backgroundColor: pressed ? t.c.panel2 : "transparent" })}
      >
        {view ? <ContextRing view={view} pulsing={compacting} /> : <EmptyRing />}
        {/* .compacting: the ring's fill and the percentage pulse while the conversation is compacted. */}
        <Pulse on={compacting} period={1600}>
          {/* The editor themes' button rule (400 12px/1.2 sans) outranks button.context-button's mono. */}
          <T style={[t.editor ? font(t, "sans", 400, 12, 1.2) : font(t, "mono", 500, 12, 1), { color: pctColor }]}>{contextPct(view)}</T>
        </Pulse>
      </Pressable>
      {/* Edge to edge as the app is, so the button's window position is the popover's and the bars' insets apply. */}
      <Modal visible={open} transparent animationType="none" onRequestClose={() => setOpen(false)} statusBarTranslucent navigationBarTranslucent>
        <Pressable accessibilityLabel="Close" style={StyleSheet.absoluteFill} onPress={() => setOpen(false)} />
        <View
          accessibilityRole="none"
          accessibilityLabel="Context and session totals"
          accessibilityViewIsModal
          style={{ position: "absolute", left: 10 + insets.left, right: 10 + insets.right, bottom, maxHeight: Math.min(win.height * 0.6, win.height - bottom - insets.top), backgroundColor: t.c.panel, borderWidth: 1, borderColor: t.c.lineStrong, borderRadius: t.radiusLg, ...(t.shadow ? { boxShadow: "0 20px 40px -24px rgba(0, 0, 0, 0.6)" } : {}) }}
        >
          <ScrollView contentContainerStyle={{ paddingTop: 10, paddingBottom: 14, paddingHorizontal: 12 }}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
              <T style={labelFont(t)}>{owner ? `${owner} agent's context` : "Context"}</T>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <SmallButtonWide
                  title="Compact now"
                  hint={busy ? "Available when the turn ends" : "Summarize the conversation to free context; the transcript stays"}
                  disabled={busy || compacting || !view}
                  onPress={() => {
                    setOpen(false);
                    onCompact();
                  }}
                />
                <IconButton label="Close" glyph={"×"} onPress={() => setOpen(false)} />
              </View>
            </View>
            {view ? (
              <>
                {/* .context-pop-bar { padding: 4px 0 2px }: the bar is inline-block on the baseline of a line of body text, 9 px down its line box (7 in the editor themes' smaller line). */}
                <View style={{ paddingTop: t.editor ? 11 : 13, paddingBottom: 4 + t.base.lineHeight + 2 - (t.editor ? 11 : 13) - 6 }}>
                  <ContextBar view={view} />
                </View>
                <T style={{ fontSize: 13, lineHeight: lineBox(13, t.editor ? 1.5 : 1.55), marginTop: 4 }}>
                  <T weight={700} size={13} lh={t.editor ? 1.5 : 1.55}>{`${view.estimated ? "about " : ""}${view.used.toLocaleString("en-US")}`}</T>
                  {` of ${view.window.toLocaleString("en-US")} tokens `}
                  {/* .context-big .context-pct { margin-left: 4px }, after the sentence's own space. */}
                  <T style={[font(t, "mono", 600, 12, 1), { marginLeft: 4, color: levelColor(t, view.level) === t.c.ok ? t.c.text : levelColor(t, view.level) }]}>{`${view.estimated ? "~" : ""}${pct(view.fraction)}`}</T>
                </T>
                {context && !view.estimated
                  ? p(`Last request: ${tokenCount(context.input)} prompt${context.cached ? ` (${tokenCount(context.cached)} from the cache)` : ""} and ${tokenCount(context.output)} answer, on ${nameOf(context.model)} at ${new Date(context.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`)
                  : null}
                {p(compactLine(view, runtimeNow))}
                {view.estimated ? p("Estimated from the conversation's text. The next reply measures it.") : null}
                {view.measuredOn ? p(`Measured on ${nameOf(view.measuredOn)}. The next turn runs on ${modelName ?? model}, whose window is ${tokenCount(view.window)}.`, { color: t.c.warnText }) : null}
                {view.windowAssumed ? p(`Studio does not know ${modelName ?? model}'s window, so ${tokenCount(view.window)} is assumed.`, { color: t.c.warnText }) : null}
              </>
            ) : (
              p("Measured after the next reply.")
            )}
            {totals && totals.requests > 0 ? (
              <>
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 6, marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: t.c.line }}>
                  <T style={labelFont(t)}>Session totals</T>
                  <T style={[small(t), { color: t.c.dim }]}>every agent, every request</T>
                </View>
                <View style={{ marginBottom: 2, gap: 3 }}>
                  <Total name="Input" value={tokenCount(totals.input)} />
                  <Total name="Cache reads" value={tokenCount(totals.cacheRead)} />
                  {totals.cacheWrite > 0 ? <Total name="Cache writes" value={tokenCount(totals.cacheWrite)} /> : null}
                  <Total name="Output" value={tokenCount(totals.output)} note={totals.reasoning > 0 ? ` (${tokenCount(totals.reasoning)} reasoning)` : undefined} />
                  <Total name="Requests" value={totals.requests.toLocaleString("en-US")} />
                  {totals.costUsd !== undefined ? <Total name="Cost" value={`${dollars(totals.costUsd)} `} note="at API prices" /> : null}
                </View>
                {totals.costUsd !== undefined && runtime ? p("Your Claude plan covers it; the cost is what the same requests would cost on a key.") : null}
                {p("Spend adds up every request. Context is only what the next request starts from.")}
              </>
            ) : null}
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

function SmallButtonWide({ title, hint, onPress, disabled }: { title: string; hint?: string; onPress: () => void; disabled?: boolean }) {
  const t = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityHint={hint} accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => ({ minHeight: 44, paddingVertical: 6, paddingHorizontal: 12, justifyContent: "center", borderRadius: t.radius, borderWidth: 1, borderColor: disabled ? t.c.disabledLine : pressed ? t.c.accentLine : t.c.lineStrong, backgroundColor: pressed && !disabled ? t.c.panel3 : t.c.panel2 })}>
      <T style={[buttonText(t), { color: disabled ? t.c.dim : t.c.text }]}>{title}</T>
    </Pressable>
  );
}

/** One row of the totals: the name muted, the number right-aligned in mono. */
function Total({ name, value, note }: { name: string; value: string; note?: string }) {
  const t = useTheme();
  return (
    // dl.context-totals is a grid: each cell's text from the top of its row, no baseline alignment.
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 14 }}>
      <T style={{ fontSize: 12.5, lineHeight: 12.5 * (t.editor ? 1.5 : 1.55), color: t.c.muted }}>{name}</T>
      <T style={[font(t, "mono", 400, 12, t.editor ? 1.5 : 1.55), { flex: 1, textAlign: "right", color: t.c.text }]}>
        {value}
        {note ? <T style={{ ...font(t, "sans", 400, 12, t.editor ? 1.5 : 1.55), color: t.c.dim }}>{note}</T> : null}
      </T>
    </View>
  );
}

/**
 * Above the composer once the context nears the point it compacts: how full
 * it is and Compact now, so a long turn does not start with the summary
 * moments away. Dismissed per session until the level rises again.
 */
export function ContextWarning({ view, runtime, busy, onCompact, onDismiss }: { view: ContextView; runtime: boolean; busy: boolean; onCompact: () => void; onDismiss: () => void }) {
  const t = useTheme();
  // .context-warning-text { flex: 1; flex-basis: calc(100% - 90px) }: the text grows across the line beside the ring, the buttons take the next.
  const [inner, setInner] = useState(0);
  return (
    <View
      accessibilityRole="summary"
      accessibilityLiveRegion="polite"
      onLayout={(e) => setInner(e.nativeEvent.layout.width - 1 - 3 - 12 - 8)}
      style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10, marginHorizontal: 10, marginBottom: 6, paddingVertical: 6, paddingRight: 8, paddingLeft: 12, borderWidth: 1, borderColor: t.c.lineStrong, borderLeftWidth: 3, borderLeftColor: view.level === "high" ? t.c.bad : t.c.warn, borderRadius: t.radius, backgroundColor: t.c.panel2 }}
    >
      <ContextRing view={view} />
      <T style={{ ...(inner > 0 ? { flexBasis: inner - 90, flexGrow: 1, flexShrink: 1 } : { flex: 1 }), minWidth: 0, fontSize: 12.5, lineHeight: 12.5 * (t.editor ? 1.5 : 1.55), color: t.c.text }}>{contextWarningText(view, runtime)}</T>
      <SmallButtonPrimary title="Compact now" hint={busy ? "Available when the turn ends" : undefined} disabled={busy} onPress={onCompact} />
      <IconButton label="Dismiss" glyph={"×"} onPress={onDismiss} />
    </View>
  );
}

/** button.primary: the ui Button, which draws editor-orange's black bold words on the orange. */
function SmallButtonPrimary({ title, hint, onPress, disabled }: { title: string; hint?: string; onPress: () => void; disabled?: boolean }) {
  return <Button title={title} hint={hint} variant="primary" disabled={disabled} onPress={onPress} />;
}


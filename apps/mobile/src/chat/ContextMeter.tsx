// HANDED OVER: owned by area-d from here; ported on mobile/chat-core as a starting point.
/**
 * The composer's context meter: how much of the model's window the
 * conversation takes now, as a percentage and a thin bar that turns amber and
 * then red near the point it compacts. Opened, it has the numbers behind it,
 * Compact now, and the session's totals, which are spend, not context. On a
 * phone the bar is at its merged tier, so the meter is the bar and the
 * percentage, and its details open across the whole composer bar.
 */
import { useRef, useState, type ReactNode } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View, useWindowDimensions, type DimensionValue, type HostInstance } from "react-native";
import { contextView, type ContextUsage, type ContextView, type SessionSpend } from "@ue-mcp-studio/shared";
import { compactLine, contextLabel, contextWarningText, dollars, pct, tokenCount } from "@ue-mcp-studio/client-core";
import { font, labelFont, T, useTheme, type Theme } from "../ui";
import { SmallButton } from "./Queue";
import { buttonText, small } from "./styles";

export { dollars };

const levelColor = (t: Theme, level: ContextView["level"]): string => (level === "high" ? t.c.bad : level === "warn" ? t.c.warn : t.c.ok);

/** The context bar: how full, and a tick where it compacts. `width` 34 in the bar, 44 in the warning, "100%" wide. */
export function ContextBar({ view, width = 34, wide = false }: { view: ContextView; width?: DimensionValue; wide?: boolean }) {
  const t = useTheme();
  const height = wide ? 6 : 4;
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: wide ? "100%" : width, height, borderRadius: height / 2, backgroundColor: t.c.panel3, borderWidth: 1, borderColor: t.c.line, flexShrink: 0 }}>
      <View style={{ position: "absolute", left: -1, top: -1, bottom: -1, width: `${Math.min(100, view.fraction * 100)}%`, minWidth: view.used > 0 ? 2 : 0, borderRadius: height / 2, backgroundColor: levelColor(t, view.level) }} />
      {view.fraction > 1 ? <View style={{ position: "absolute", right: -4, top: -3, bottom: -3, width: 3, borderRadius: 1, backgroundColor: t.c.bad, shadowColor: t.c.bad, shadowOpacity: 1, shadowRadius: 6, shadowOffset: { width: 0, height: 0 } }} /> : null}
      <View style={{ position: "absolute", top: -3, bottom: -3, width: 1, marginLeft: -0.5, left: `${view.compactAt * 100}%`, backgroundColor: t.c.muted, opacity: 0.7 }} />
    </View>
  );
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
  const [open, setOpen] = useState(false);
  const [bottom, setBottom] = useState(0);
  const button = useRef<HostInstance>(null);
  const view = contextView(context, model, listedWindow);
  if (!view && !totals?.requests) return null;
  const label = contextLabel(view, owner);
  const pctColor = view?.level === "warn" ? t.c.warn : view?.level === "high" ? t.c.bad : t.c.muted;
  const toggle = () => {
    if (open) return setOpen(false);
    // The details open over the conversation, 6 px above the composer bar, across its width.
    setOpen(true);
    button.current?.measureInWindow((_x, y) => setBottom(win.height - y + 6));
  };
  const p = (children: ReactNode, extra?: object) => <T style={[small(t), { color: t.c.dim, marginVertical: 4 }, extra]}>{children}</T>;
  return (
    <View>
      <Pressable
        ref={button}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ expanded: open }}
        accessibilityHint="Session totals inside."
        onPress={toggle}
        style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 5, minHeight: 44, paddingHorizontal: 6, borderRadius: t.radius, borderWidth: 1, borderColor: pressed ? t.c.line : "transparent", backgroundColor: pressed ? t.c.panel2 : "transparent" })}
      >
        {owner ? <T style={[font(t, "mono", 600, 10.5, 1), { color: t.c.dim, textTransform: "uppercase", letterSpacing: 0.84 }]}>{owner}</T> : null}
        {view ? <ContextBar view={view} /> : null}
        <T style={[font(t, "mono", 500, 12, 1), { color: pctColor, opacity: compacting ? 0.6 : 1 }]}>{view ? `${view.estimated ? "~" : ""}${pct(view.fraction)}` : "ctx"}</T>
      </Pressable>
      <Modal visible={open} transparent animationType="none" onRequestClose={() => setOpen(false)}>
        <Pressable accessibilityLabel="Close" style={StyleSheet.absoluteFill} onPress={() => setOpen(false)} />
        <View
          accessibilityRole="none"
          accessibilityLabel="Context and session totals"
          accessibilityViewIsModal
          style={{ position: "absolute", left: 10, right: 10, bottom, maxHeight: win.height * 0.6, backgroundColor: t.c.panel, borderWidth: 1, borderColor: t.c.lineStrong, borderRadius: t.radiusLg, shadowColor: "#000", shadowOpacity: t.shadow ? 0.6 : 0, shadowRadius: 20, shadowOffset: { width: 0, height: 20 }, elevation: 12 }}
        >
          <ScrollView contentContainerStyle={{ paddingVertical: 10, paddingHorizontal: 12 }}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
              <T style={labelFont(t)}>{owner ? `${owner} agent's context` : "Context"}</T>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <SmallButtonWide
                  title="Compact now"
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
                <View style={{ paddingTop: 4, paddingBottom: 2 }}>
                  <ContextBar view={view} wide />
                </View>
                <T style={{ fontSize: 13, lineHeight: 13 * (t.editor ? 1.5 : 1.55), marginVertical: 4 }}>
                  <T weight={700} size={13} lh={t.editor ? 1.5 : 1.55}>{`${view.estimated ? "about " : ""}${view.used.toLocaleString("en-US")}`}</T>
                  {` of ${view.window.toLocaleString("en-US")} tokens `}
                  <T style={[font(t, "mono", 600, 12, 1), { color: levelColor(t, view.level) === t.c.ok ? t.c.text : levelColor(t, view.level) }]}>{` ${view.estimated ? "~" : ""}${pct(view.fraction)}`}</T>
                </T>
                {context && !view.estimated
                  ? p(`Last request: ${tokenCount(context.input)} prompt${context.cached ? ` (${tokenCount(context.cached)} from the cache)` : ""} and ${tokenCount(context.output)} answer, on ${nameOf(context.model)} at ${new Date(context.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`)
                  : null}
                {p(compactLine(view, runtime && !view.measuredOn && !!context?.window))}
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
                <View style={{ marginTop: 4, marginBottom: 6, gap: 3 }}>
                  <Total name="Input" value={tokenCount(totals.input)} />
                  <Total name="Cache reads" value={tokenCount(totals.cacheRead)} />
                  {totals.cacheWrite > 0 ? <Total name="Cache writes" value={tokenCount(totals.cacheWrite)} /> : null}
                  <Total name="Output" value={tokenCount(totals.output)} note={totals.reasoning > 0 ? ` (${tokenCount(totals.reasoning)} reasoning)` : undefined} />
                  <Total name="Requests" value={totals.requests.toLocaleString("en-US")} />
                  {totals.costUsd !== undefined ? <Total name="Cost" value={dollars(totals.costUsd)} note=" at API prices" /> : null}
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

function SmallButtonWide({ title, onPress, disabled }: { title: string; onPress: () => void; disabled?: boolean }) {
  const t = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => ({ minHeight: 44, paddingVertical: 6, paddingHorizontal: 12, justifyContent: "center", borderRadius: t.radius, borderWidth: 1, borderColor: disabled ? t.c.disabledLine : pressed ? t.c.accentLine : t.c.lineStrong, backgroundColor: pressed && !disabled ? t.c.panel3 : t.c.panel2 })}>
      <T style={[buttonText(t), { color: disabled ? t.c.dim : t.c.text }]}>{title}</T>
    </Pressable>
  );
}

/** One row of the totals: the name muted, the number right-aligned in mono. */
function Total({ name, value, note }: { name: string; value: string; note?: string }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "baseline", gap: 14 }}>
      <T style={{ fontSize: 12.5, lineHeight: 12.5 * (t.editor ? 1.5 : 1.55), color: t.c.muted }}>{name}</T>
      <T style={[font(t, "mono", 400, 12, t.editor ? 1.5 : 1.55), { flex: 1, textAlign: "right", color: t.c.text }]}>
        {value}
        {note ? <T style={{ fontSize: 12, color: t.c.dim }}>{note}</T> : null}
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
  // .context-warning-text { flex-basis: calc(100% - 90px) }: the text takes the line beside the bar, the buttons the next.
  const [inner, setInner] = useState(0);
  return (
    <View
      accessibilityRole="summary"
      accessibilityLiveRegion="polite"
      onLayout={(e) => setInner(e.nativeEvent.layout.width - 1 - 3 - 12 - 8)}
      style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10, marginHorizontal: 10, marginBottom: 6, paddingVertical: 6, paddingRight: 8, paddingLeft: 12, borderWidth: 1, borderColor: t.c.lineStrong, borderLeftWidth: 3, borderLeftColor: view.level === "high" ? t.c.bad : t.c.warn, borderRadius: t.radius, backgroundColor: t.c.panel2 }}
    >
      <ContextBar view={view} width={44} />
      <T style={{ ...(inner > 0 ? { width: inner - 90 } : { flex: 1 }), fontSize: 12.5, lineHeight: 12.5 * (t.editor ? 1.5 : 1.55), color: t.c.text }}>{contextWarningText(view, runtime)}</T>
      <SmallButtonPrimary title="Compact now" disabled={busy} onPress={onCompact} />
      <IconButton label="Dismiss" glyph={"×"} onPress={onDismiss} />
    </View>
  );
}

function SmallButtonPrimary({ title, onPress, disabled }: { title: string; onPress: () => void; disabled?: boolean }) {
  const t = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => ({ minHeight: 44, paddingVertical: 6, paddingHorizontal: 12, justifyContent: "center", borderRadius: t.radius, borderWidth: 1, borderColor: disabled ? t.c.disabledLine : pressed ? t.c.accentHi : t.c.accent, backgroundColor: disabled ? "transparent" : pressed ? t.c.accentHi : t.c.accent })}>
      <T style={[buttonText(t, 600), { color: disabled ? t.c.dim : t.c.onAccent }]}>{title}</T>
    </Pressable>
  );
}

export { SmallButton };

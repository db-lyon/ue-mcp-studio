/**
 * The editor's state above every screen: stopping, building or starting for a
 * restart or rebuild, step by step with a timer; busy with a ue-mcp call, with
 * a timer and Stop for the turns waiting on it; or not running, with Start.
 * EditorChip is the narrow top bar's form: a dot and a word or two whose
 * press opens the full banner under the bar.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { editorBanner, editorSteps, stepFailed, type EditorBannerState } from "@ue-mcp-studio/client-core";
import { Button, T, font, useTheme } from "../../ui";
import { Spinner } from "../../ui/Spinner";
import { monoFont, warnBanner } from "../../ui/type";
import { useProjectNav } from "../../nav";
import { useBusy, useHealth } from "./state";

/** The banner's state, its Start and Stop, and their errors. */
function useEditorBanner() {
  const { api, project } = useProjectNav();
  const { busy, now } = useBusy();
  const health = useHealth();
  const [stopping, setStopping] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = editorBanner(busy, { now: now(), streaming: project.live === "live", healthKnown: !!health.raw, connected: !!health.editors[0]?.connected });
  const stop = () => {
    setStopping(true);
    api.stopBusy().then(() => setError(null), (e: Error) => setError(e.message)).finally(() => setStopping(false));
  };
  const start = () => {
    setStarting(true);
    setError(null);
    api.editor("start").then(
      (r) => {
        const failed = editorSteps(r).find(stepFailed);
        if (failed) setError(failed.result ?? "The editor did not start.");
      },
      (e: Error) => setError(e.message),
    ).finally(() => setStarting(false));
  };
  return { state, stopping, starting, error, stop, start };
}

type Banner = ReturnType<typeof useEditorBanner>;

/** The banner itself: `.banner.warn.editor-banner`. */
function BannerView({ b, still }: { b: Banner & { state: EditorBannerState }; still?: boolean }) {
  const t = useTheme();
  const { state } = b;
  const warn = warnBanner(t);
  const text = { ...font(t, "sans", 400, t.base.size), lineHeight: t.base.lineHeight, color: warn.color };
  const strong = font(t, "sans", 700, t.base.size);
  const dim = { color: t.c.dim };
  const elapsed = (v: string) => <Text style={[monoFont(t), { fontVariant: ["tabular-nums"] }, Platform.OS === "web" ? ({ marginLeft: 10 } as object) : null]}>{Platform.OS === "web" ? v : `  ${v}`}</Text>;
  let body: ReactNode;
  let action: ReactNode = null;
  if (state.kind === "operation") {
    body = (
      <Text style={text}>
        <Text style={strong}>{state.title}:</Text> {state.step}
        {elapsed(state.elapsed)}
      </Text>
    );
  } else if (state.kind === "busy") {
    body = (
      <Text style={text}>
        <Text style={strong}>{state.stopped ? "Stopped." : "Editor busy:"}</Text> {state.stopped ? `The editor is finishing ${state.call}.` : state.call}
        {state.more > 0 ? <Text style={dim}> and {state.more} more</Text> : null}
        {state.client ? <Text style={dim}> from {state.client}</Text> : null}
        {elapsed(state.elapsed)}
      </Text>
    );
    if (state.stoppable) action = <Button title={b.stopping ? "Stopping" : "Stop"} disabled={b.stopping} onPress={b.stop} />;
  } else {
    body = (
      <Text style={text}>
        <Text style={strong}>{state.title}</Text>
        {state.failure && !b.error ? <Text style={dim}> {state.failure.reason}</Text> : null}
        {b.error ? <Text style={dim}> {b.error}</Text> : null}
      </Text>
    );
    action = <Button variant="primary" title={b.starting ? "Starting" : "Start"} disabled={b.starting} onPress={b.start} />;
  }
  return (
    <View testID="editor-banner" accessibilityRole="summary" accessibilityLiveRegion="polite" style={[s.banner, warn.box]}>
      {state.kind === "operation" ? <Spinner small still={still} /> : null}
      <View style={s.text}>{body}</View>
      {action}
      {state.kind === "busy" && b.error ? <T tone="dim">{b.error}</T> : null}
    </View>
  );
}

/** The full banner, for a layout wide enough to show it under the top bar. */
export function EditorBanner() {
  const b = useEditorBanner();
  if (!b.state) return null;
  return <BannerView b={b as Banner & { state: EditorBannerState }} />;
}

/** The busy chip's dot pulses, as the web client's does. */
function Pulse({ color, animate }: { color: string; animate: boolean }) {
  const o = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!animate) return;
    const loop = Animated.loop(Animated.sequence([Animated.timing(o, { toValue: 0.35, duration: 600, useNativeDriver: true }), Animated.timing(o, { toValue: 1, duration: 600, useNativeDriver: true })]));
    loop.start();
    return () => loop.stop();
  }, [o, animate]);
  return <Animated.View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color, opacity: o }} />;
}

/**
 * The narrow top bar's chip, and the banner it opens under the bar. `top`
 * is where the bar ends on screen; the banner opens 4 points below it, 6 in
 * from each side. `animate` off holds the busy dot still.
 */
export function EditorChip({ top, animate = true }: { top?: number; animate?: boolean }) {
  const t = useTheme();
  const b = useEditorBanner();
  const [open, setOpen] = useState(false);
  const [below, setBelow] = useState(top ?? 53);
  const chip = useRef<{ measureInWindow: (cb: (x: number, y: number, w: number, h: number) => void) => void } | null>(null);
  const state = b.state;
  useEffect(() => {
    if (!state) setOpen(false);
  }, [state]);
  if (!state) return null;
  const tone = state.kind === "off" ? "warn" : "busy";
  const words = state.kind === "off" ? (b.starting ? "Starting" : "Editor off") : state.chip;
  const press = () => {
    if (top === undefined) chip.current?.measureInWindow((_x, y, _w, h) => setBelow(y + h + 6.5));
    setOpen(!open);
  };
  return (
    <View style={s.wrap}>
      <Pressable
        ref={chip as never}
        testID="editor-chip"
        accessibilityRole="button"
        accessibilityLabel="Editor state"
        accessibilityValue={{ text: words }}
        accessibilityState={{ expanded: open }}
        onPress={press}
        style={[s.chip, { borderRadius: t.editor ? 4 : 999, borderColor: tone === "warn" ? t.c.warnPill.replace(/[\d.]+\)$/, "0.4)") : t.c.lineStrong }]}
      >
        {tone === "busy" ? <Pulse color={t.c.warn} animate={animate} /> : <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: t.c.warn }} />}
        <Text numberOfLines={1} style={[t.editor ? font(t, "sans", 400, 11, 1.4) : { ...font(t, "mono", 500, 10.5, 1.4), letterSpacing: 0.63, textTransform: "uppercase" }, { color: tone === "warn" ? t.c.warnText : t.c.muted }]}>
          {words}
        </Text>
      </Pressable>
      <Modal visible={open} transparent animationType="none" onRequestClose={() => setOpen(false)}>
        <Pressable accessibilityLabel="Close the editor state" style={StyleSheet.absoluteFill} onPress={() => setOpen(false)} />
        <View testID="editor-pop" style={[s.pop, { top: below, backgroundColor: t.c.panel }]}>
          <BannerView b={b as Banner & { state: EditorBannerState }} still={!animate} />
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { flexDirection: "row", flexShrink: 0 },
  chip: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 3, paddingHorizontal: 9, borderWidth: 1, borderRadius: 999, minHeight: 44, backgroundColor: "transparent" },
  pop: { position: "absolute", left: 6, right: 6, borderRadius: 8, boxShadow: "0px 12px 32px rgba(0, 0, 0, 0.45)" } as object,
  banner: { flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap", paddingVertical: 9, paddingHorizontal: 12, borderWidth: 1, borderRadius: 8 },
  text: { flexGrow: 1, flexShrink: 1, flexBasis: 220, minWidth: 0 },
});

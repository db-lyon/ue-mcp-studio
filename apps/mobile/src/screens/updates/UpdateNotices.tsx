/**
 * What a paired client shows of an update the computer runs (client-web
 * UpdateRunner, UpdateWaiting and UpdateScreen): the banner while a step waits
 * for the current turn, and the update's steps over the page while it runs,
 * with what it installed or why it stopped. The shell mounts UpdateNotices
 * once per open project, at the top of the page, so it hears every run.
 */
import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Modal, Platform, View, type ViewStyle } from "react-native";
import { STEP_NAME, STEP_NOTE, waitingSteps, type UpdateRun } from "@ue-mcp-studio/client-core";
import { Banner, Button, Spacer, bannerText, font, T, useTheme } from "../../ui";
import { Span, Txt } from "../settings/controls";
import { useProjectEvents, useSettingsApi } from "../settings/hooks";
import { followUpdateEvent, setUpdateRun, useFinishedRunClears, useUpdateRun } from "./run";

/** How long a restart may take before the screen says what to do if it never comes back. */
const SLOW_MS = 90_000;

/** .spinner: a ring with its top in the accent, turning. */
export function Spinner({ size = 16 }: { size?: number }) {
  const t = useTheme();
  const turn = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (Platform.OS === "web") return;
    const loop = Animated.loop(Animated.timing(turn, { toValue: 1, duration: 800, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [turn]);
  const ring: ViewStyle = { width: size, height: size, borderRadius: size / 2, borderWidth: 2, borderColor: t.c.line, borderTopColor: t.c.accent };
  // On the web build a CSS animation turns it, as client-web's does (and a still picture stops it at its start).
  if (Platform.OS === "web") return <View accessibilityElementsHidden style={[ring, { animationKeyframes: [{ to: { transform: [{ rotate: "360deg" }] } }], animationDuration: "800ms", animationIterationCount: "infinite", animationTimingFunction: "linear" } as ViewStyle]} />;
  return <Animated.View accessibilityElementsHidden style={[ring, { transform: [{ rotate: turn.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] }) }] }]} />;
}

/** Follows the computer's update runs for as long as the project is open, and shows them. */
export function UpdateNotices() {
  useProjectEvents(followUpdateEvent);
  const run = useUpdateRun();
  useFinishedRunClears(run);
  const [slow, setSlow] = useState(false);
  const waitingOnRestart = !!run?.steps.some((s) => s.state === "active" && (s.key === "studio" || s.key === "restart"));
  useEffect(() => {
    setSlow(false);
    if (!waitingOnRestart) return;
    const timer = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(timer);
  }, [waitingOnRestart]);
  if (run && waitingSteps(run).length > 0) return <UpdateWaiting run={run} />;
  if (run) return <UpdateScreen run={run} slow={slow} onClose={() => setUpdateRun(null)} />;
  return null;
}

/** An update kept until the turn in progress finishes, with a way to ask for it now. */
export function UpdateWaiting({ run }: { run: UpdateRun }) {
  const api = useSettingsApi();
  const t = useTheme();
  const [sure, setSure] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const restarts = waitingSteps(run).some((k) => k === "studio" || k === "restart");
  const now = () => {
    setError(null);
    // The computer refuses a paired client this, as it refuses the web page: what it says is shown.
    api.updateNow().catch((e: Error) => setError(e.message));
  };
  return (
    <Banner kind="warn" role="status" style={{ marginTop: 0, marginBottom: 6, marginHorizontal: 6, flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
      <Txt style={{ color: bannerText(t, "warn"), flexGrow: 1, flexShrink: 1, flexBasis: 220, minWidth: 0 }}>
        <Span weight={700}>Update ready,</Span> {restarts ? "restarts" : "the editor restarts for it"} when the current turn finishes.
        {sure ? <Span tone="dim"> Restarting now stops the turn in progress.</Span> : null}
        {error ? <Span tone="dim"> {error}</Span> : null}
      </Txt>
      {sure ? <Button variant="ghost" title="Cancel" onPress={() => setSure(false)} /> : null}
      <Button variant={sure ? "primary" : "default"} title={sure ? "Restart and stop the turn" : "Restart now"} onPress={() => (sure ? now() : setSure(true))} />
    </Banner>
  );
}

/** The update's steps over the page: running, finished, or stopped. */
export function UpdateScreen({ run, slow, onClose }: { run: UpdateRun; slow: boolean; onClose: () => void }) {
  const t = useTheme();
  const finished = run.summary !== undefined;
  const failed = !!run.error;
  const title = failed ? "Update stopped" : finished ? "Updated" : "Updating";
  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <View accessibilityViewIsModal accessibilityLabel={title} style={{ flex: 1, padding: 8, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0, 0, 0, 0.55)" }}>
        <View style={{ width: "100%", maxWidth: 460, gap: 12, padding: 16, borderWidth: 1, borderColor: t.c.line, borderRadius: 10, backgroundColor: t.c.panel, shadowColor: "#000", shadowOpacity: 0.45, shadowRadius: 25, shadowOffset: { width: 0, height: 18 } }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            {!finished && !failed ? <Spinner /> : null}
            <T style={[font(t, "sans", 600, 15, 1.2), { color: t.c.text }]}>{title}</T>
          </View>
          <View style={{ gap: 8 }}>
            {run.steps.map((s) => {
              const lit = s.state === "active" || s.state === "done";
              const color = s.state === "failed" ? t.c.bad : lit ? t.c.text : t.c.dim;
              return (
                <View key={s.key} style={{ flexDirection: "row", columnGap: 10 }}>
                  <View style={{ width: 16, alignItems: "center", justifyContent: "center", height: t.base.lineHeight }}>
                    {s.state === "active" ? <Spinner size={12} /> : <Txt size={12} style={{ color: s.state === "done" ? t.c.ok : color, textAlign: "center" }}>{s.state === "done" ? "✓" : s.state === "failed" ? "✕" : "○"}</Txt>}
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Txt style={{ color }}>
                      {STEP_NAME[s.key]}
                      {s.key === "ueMcp" && run.target ? ` ${run.target}` : ""}
                    </Txt>
                    {s.state === "active" ? (
                      <Txt size={12} tone="dim">
                        {run.detail ?? STEP_NOTE[s.key] ?? ""}
                      </Txt>
                    ) : null}
                  </View>
                </View>
              );
            })}
          </View>
          {slow && !failed ? <Txt size={12} tone="dim">Taking longer than it should. If Studio does not come back, close the app and open it again.</Txt> : null}
          {failed ? (
            <Banner kind="bad" style={{ marginBottom: 0 }}>
              <Txt size={12} style={{ color: bannerText(t, "bad") }}>
                {run.error}
              </Txt>
            </Banner>
          ) : null}
          {finished && run.summary ? (
            <Txt size={12} tone="muted">
              {run.summary}
            </Txt>
          ) : null}
          {finished || failed ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <Spacer />
              <Button variant={failed ? "default" : "primary"} title={failed ? "Close" : "Done"} onPress={onClose} />
            </View>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

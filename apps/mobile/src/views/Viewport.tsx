/**
 * The live viewport on the phone (client-web views/Viewport.tsx): Play In
 * Editor, or the level viewport, streamed from the editor over WebRTC while
 * the tab is open, with each gate and its way forward drawn in the stage in
 * place of the video. A phone is always a paired device.
 */
import { useEffect, useState } from "react";
import { Linking, Pressable, ScrollView, View } from "react-native";
import type { ViewportSource, ViewportStatus } from "@ue-mcp-studio/shared";
import {
  VIEWPORT_PLANS_URL,
  VIEWPORT_SOURCE_CHOICES,
  VIEWPORT_VIEW_ONLY,
  ViewportSession,
  viewerNotice,
  viewportGate,
  type PeerFactory,
  type ViewerPhase,
  type ViewportAction,
  type ViewportNotice,
} from "@ue-mcp-studio/client-core";
import { useProjectNav } from "../nav";
import type { DaemonState } from "../state";
import type { SettingsSection } from "./settings/sections";
import { Button, Spinner, T, font, useStyles, useTheme, type Theme } from "../ui";
import { VideoView, peerFactory } from "../native/webrtc";

const REMOTE = { remote: true };

export function ViewportView({ daemon, onSettings, peer = peerFactory }: { daemon: DaemonState; onSettings: (s: SettingsSection) => void; peer?: PeerFactory }) {
  const t = useTheme();
  const s = useStyles(styles);
  const { api } = useProjectNav();
  const [status, setStatus] = useState<ViewportStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [source, setSource] = useState<ViewportSource>("pie");
  const [phase, setPhase] = useState<ViewerPhase>({ phase: "joining" });
  const [watch, setWatch] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [muted, setMuted] = useState(true);

  const check = (fresh = false) =>
    api.viewport(fresh).then(
      (x) => {
        setStatus(x);
        setStatusError(null);
        return x;
      },
      (e: Error) => {
        setStatusError(e.message);
        return null;
      },
    );

  useEffect(() => {
    void check();
  }, [api]);

  const gate = status ? viewportGate(status, REMOTE) : null;
  const editorEvents = daemon.events.filter((e) => e.type.startsWith("editor.")).length;
  useEffect(() => {
    if (gate) void check();
  }, [editorEvents]);

  const open = status !== null && gate === null;
  useEffect(() => {
    if (!open) return;
    const session = new ViewportSession({ api, peer, source, onPhase: setPhase });
    session.start();
    return () => session.stop();
  }, [open, source, watch, api]);

  useEffect(() => {
    if (phase.phase === "refused" && phase.status) setStatus(phase.status);
  }, [phase]);

  const live = phase.phase === "live" ? phase.stream : null;
  const notice: ViewportNotice | null = statusError
    ? { tone: "bad", title: "Could not check the viewport", body: statusError, actions: [{ id: "check", label: "Check again", primary: true }] }
    : !status
      ? { tone: "info", title: "Checking the viewport", body: "", actions: [], busy: true }
      : (gate ?? viewerNotice(phase, source, REMOTE));

  const act = async (a: ViewportAction) => {
    setActionError(null);
    setBusy(a.id);
    try {
      switch (a.id) {
        case "check": {
          const x = await check(true);
          if (x && !viewportGate(x, REMOTE)) setWatch((n) => n + 1);
          break;
        }
        case "plans":
          await Linking.openURL(VIEWPORT_PLANS_URL);
          break;
        case "upgrade":
          await Linking.openURL((await api.billingCheckout({ plan: "pro", interval: "month" })).url);
          break;
        case "settings":
          onSettings("general");
          break;
        case "start-editor":
        case "restart-editor":
          await api.editor(a.id === "start-editor" ? "start" : "restart");
          await check();
          break;
        case "enable-plugin":
          setStatus(await api.enableStreamPlugin());
          break;
        case "level-viewport":
          setSource("level_viewport");
          break;
        case "pie":
          setSource("pie");
          break;
        case "watch":
          setWatch((n) => n + 1);
          break;
      }
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={s.page}>
      <View style={s.head}>
        <T style={s.title} accessibilityRole="header">Viewport</T>
      </View>
      {open ? (
        <View style={s.sources} accessibilityLabel="Show">
          {VIEWPORT_SOURCE_CHOICES.map((c) => {
            const on = source === c.id;
            return (
              <Pressable key={c.id} accessibilityRole="button" accessibilityState={{ selected: on }} aria-pressed={on} accessibilityLabel={c.name} onPress={() => setSource(c.id)} style={[s.chip, on && s.chipOn]}>
                <T style={[s.chipText, on && { color: t.c.text }]}>{c.name}</T>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      <View style={[s.stage, live ? s.stageLive : null]}>
        {live ? <VideoView stream={live} muted={muted} style={s.video} /> : null}
        {notice ? (
          <View style={[s.notice, notice.tone === "warn" && s.noticeWarn, notice.tone === "bad" && s.noticeBad]} accessibilityRole={notice.tone === "bad" ? "alert" : undefined} accessibilityLiveRegion="polite">
            <View style={s.noticeTitle}>
              {notice.busy ? <Spinner small /> : null}
              <T weight={700} style={{ flexShrink: 1 }}>{notice.title}</T>
            </View>
            {notice.body ? <T tone="muted">{notice.body}</T> : null}
            {notice.actions.length > 0 ? (
              <View style={s.actions}>
                {notice.actions.map((a) => (
                  <Button key={a.id} title={busy === a.id ? "Working" : a.label} label={a.label} variant={a.primary ? "primary" : "default"} size="small" disabled={busy !== null} onPress={() => void act(a)} />
                ))}
              </View>
            ) : null}
            {actionError ? <T style={{ color: t.c.badText }}>{actionError}</T> : null}
          </View>
        ) : null}
      </View>
      {live ? (
        <View style={s.tools}>
          <Button title={muted ? "Sound on" : "Sound off"} label={muted ? "Sound on" : "Sound off"} size="small" onPress={() => setMuted((m) => !m)} />
          <T tone="dim" style={{ flexShrink: 1, fontSize: 12 }}>{VIEWPORT_VIEW_ONLY}</T>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = (t: Theme) => ({
  page: { paddingTop: 4, paddingHorizontal: 4, paddingBottom: 18, gap: 10 },
  head: { flexDirection: "row" as const, alignItems: "center" as const, gap: 10 },
  title: { ...font(t, "sans", 600, 20, 1.2), color: t.c.text },
  sources: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
  chip: { minHeight: 44, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: t.c.lineStrong, justifyContent: "center" as const },
  chipOn: { backgroundColor: t.c.accentWash, borderColor: t.c.accent },
  chipText: { ...font(t, "sans", 500, 12, 1), color: t.c.muted },
  stage: { width: "100%" as const, minHeight: 200, backgroundColor: "#000", borderWidth: 1, borderColor: t.c.line, borderRadius: t.radiusLg, alignItems: "center" as const, justifyContent: "center" as const },
  stageLive: { aspectRatio: 16 / 9, minHeight: 0, overflow: "hidden" as const },
  video: { position: "absolute" as const, top: 0, left: 0, right: 0, bottom: 0 },
  notice: { margin: 10, paddingVertical: 12, paddingHorizontal: 14, borderRadius: t.radiusLg, backgroundColor: t.c.panel, borderWidth: 1, borderColor: t.c.line, gap: 8, alignSelf: "stretch" as const },
  noticeWarn: { borderColor: t.c.warnLine },
  noticeBad: { borderColor: t.c.badLine },
  noticeTitle: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
  actions: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8, marginTop: 4 },
  tools: { flexDirection: "row" as const, alignItems: "center" as const, flexWrap: "wrap" as const, gap: 8 },
});

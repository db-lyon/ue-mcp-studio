/**
 * The way into the live PIE viewport from the chat (client-web chat/PieLive.tsx):
 * the composer bar's PIE indicator, the Play In Editor card after what started
 * PIE, and the full-screen sheet both open, which draws the Viewport tab's own
 * player, gate and states. The card never streams in the thread; the sheet
 * joins as a viewer while it is open, and closing it leaves, so the stream
 * stops once nobody watches.
 *
 * The status is GET /viewport, asked on mount and again after the events
 * client-core's asksViewportAgain names, and a pie.* event from the daemon
 * applies at once (pieFromEvent). Nothing polls.
 */
import { createContext, useContext, useEffect, useState } from "react";
import { Modal, View } from "react-native";
import type { ViewportStatus } from "@ue-mcp-studio/shared";
import { VIEWPORT_MODAL_TITLE, WATCH_LIVE, asksViewportAgain, pieCard, pieFromEvent, withPie } from "@ue-mcp-studio/client-core";
import { useProjectNav } from "../nav";
import { useBack } from "../back";
import type { DaemonState } from "../state";
import { ViewportView } from "../views/Viewport";
import type { SettingsSection } from "../views/settings/sections";
import { Button, T, Spacer, useInsets, useTheme } from "../ui";

/** GET /viewport for the chat, asked again after an event that may change it. */
export function usePieStatus(enabled = true): { status: ViewportStatus | null; check: (fresh?: boolean) => Promise<void> } {
  const { project, api } = useProjectNav();
  const [status, setStatus] = useState<ViewportStatus | null>(null);
  const check = (fresh = false) => Promise.resolve().then(() => api.viewport(fresh)).then(setStatus, () => undefined);
  useEffect(() => {
    if (!enabled) return;
    void check();
    return project.onEvent((e) => {
      // A Play session the daemon pushed, however it started: shown at once.
      const pie = pieFromEvent(e.type);
      if (pie !== null) setStatus((s) => withPie(s, pie));
      if (asksViewportAgain(e.type)) void check();
    });
  }, [api, project, enabled]);
  return { status, check };
}

/** What the chat's PIE card and indicator read: the status, and the ways out of the thread. */
export interface PieLiveValue {
  status: ViewportStatus | null;
  /** Open the viewport over the chat. */
  watch: () => void;
  check: (fresh?: boolean) => Promise<void>;
  onSettings: (s: string) => void;
}

export const PieLiveContext = createContext<PieLiveValue | null>(null);

/** The Play In Editor card: a compact line with a live dot while PIE runs, and Watch live. */
export function PieCard({ current }: { current: boolean }) {
  const t = useTheme();
  const v = useContext(PieLiveContext);
  if (!v) return null;
  const card = pieCard(v.status, { current });
  return (
    <View accessibilityLabel={card.title} style={{ marginVertical: 6, paddingVertical: 8, paddingHorizontal: 12, borderWidth: 1, borderColor: t.c.line, borderRadius: 8, backgroundColor: t.c.panel2, gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 32 }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: card.live ? t.c.bad : t.c.dim }} />
        <T weight={card.live ? 600 : 500} tone={card.live ? undefined : "muted"} numberOfLines={1} style={{ flexShrink: 1 }}>{card.title}</T>
        <Spacer />
        <Button title={WATCH_LIVE} label={WATCH_LIVE} variant={card.live ? "primary" : "default"} size="small" onPress={v.watch} />
      </View>
    </View>
  );
}

/**
 * The viewport in a full-screen sheet over the chat. Mounted only while open,
 * so its viewer joins on open and leaves on close; Close or Back closes it.
 */
export function ViewportSheet({ daemon, onClose, onSettings }: { daemon: DaemonState; onClose: () => void; onSettings: (s: SettingsSection) => void }) {
  const t = useTheme();
  const insets = useInsets();
  useBack(onClose, { overlay: true });
  return (
    <Modal visible transparent={false} animationType="slide" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <View accessibilityViewIsModal accessibilityLabel={VIEWPORT_MODAL_TITLE} style={{ flex: 1, backgroundColor: t.c.bg, paddingTop: insets.top, paddingBottom: insets.bottom, paddingLeft: insets.left + 10, paddingRight: insets.right + 10 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 48 }}>
          <T weight={700} size={t.base.size} accessibilityRole="header" numberOfLines={1} style={{ flexShrink: 1 }}>{VIEWPORT_MODAL_TITLE}</T>
          <Spacer />
          <Button title="Close" label="Close the viewport" variant="ghost" onPress={onClose} />
        </View>
        <ViewportView daemon={daemon} embedded onSettings={(s) => { onClose(); onSettings(s); }} />
      </View>
    </Modal>
  );
}

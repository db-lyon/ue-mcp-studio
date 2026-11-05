/**
 * App shortcuts: a long press on the app's icon lists the project's recent
 * sessions (four at most, as Android and iOS advise), and picking one opens
 * Studio straight into that session.
 */
import { useEffect } from "react";
import { Platform } from "react-native";
import * as QuickActions from "expo-quick-actions";
import { useQuickActionCallback } from "expo-quick-actions/hooks";

export interface ShortcutTarget {
  deviceId: string;
  sessionId: string;
}

/** Lists a project's most recent sessions as the icon's shortcuts. */
export function publishRecentSessions(deviceId: string, sessions: Array<{ id: string; title: string; updatedAt: string; archived?: boolean }>): void {
  if (Platform.OS === "web") return;
  const recent = sessions
    .filter((s) => !s.archived)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 4);
  void QuickActions.setItems(
    recent.map((s) => ({
      id: `session:${s.id}`,
      title: (s.title || "New session").slice(0, 25),
      subtitle: "Open in Studio",
      icon: Platform.OS === "android" ? undefined : "symbol:bubble.left",
      params: { deviceId, sessionId: s.id },
    })),
  ).catch(() => undefined);
}

/** Calls back with the session a shortcut asked for, at launch or while running. */
export function useShortcutTarget(open: (t: ShortcutTarget) => void): void {
  useQuickActionCallback((action) => {
    const p = action.params as Partial<ShortcutTarget> | undefined;
    if (p?.deviceId && p.sessionId) open({ deviceId: p.deviceId, sessionId: p.sessionId });
  });
  useEffect(() => {
    const initial = QuickActions.initial as { params?: Partial<ShortcutTarget> } | undefined;
    if (initial?.params?.deviceId && initial.params.sessionId) open({ deviceId: initial.params.deviceId, sessionId: initial.params.sessionId });
    // Once, at launch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

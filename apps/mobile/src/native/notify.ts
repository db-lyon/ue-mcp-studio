/**
 * The phone's notifications, through expo-notifications: local ones the app
 * shows from the event stream while it runs, the channels that carry each
 * sound and vibration choice, taps, and the FCM token the relay pushes to.
 */
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import type { NotifySound, NotifyVibrate } from "@ue-mcp-studio/shared";
import { notifyChannel } from "@ue-mcp-studio/client-core";

/** What a notification carries for its tap: the project, and the session (when the app showed it itself). */
export interface NotifyData {
  deviceId: string;
  kind: string;
  sessionId?: string;
  runId?: string;
}

export interface NotifyRequest {
  title: string;
  body: string;
  sound: NotifySound;
  vibrate: NotifyVibrate;
  tag: string;
  data: NotifyData;
}

// Shown while the app is in front too: the caller already decided whether it should be.
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

const VIBRATION: Record<NotifyVibrate, number[] | null> = { default: [0, 250, 250, 250], short: [0, 120], none: null };
const made = new Set<string>();

async function channel(sound: NotifySound, vibrate: NotifyVibrate): Promise<string> {
  const id = notifyChannel({ sound, vibrate });
  if (Platform.OS !== "android" || made.has(id)) return id;
  await Notifications.setNotificationChannelAsync(id, {
    name: `Studio (${sound === "none" ? "silent" : sound === "soft" ? "soft sound" : "sound"}, ${vibrate === "none" ? "no vibration" : vibrate === "short" ? "short vibration" : "vibration"})`,
    importance: sound === "none" ? Notifications.AndroidImportance.DEFAULT : Notifications.AndroidImportance.HIGH,
    sound: sound === "none" ? null : "default",
    enableVibrate: vibrate !== "none",
    ...(VIBRATION[vibrate] ? { vibrationPattern: VIBRATION[vibrate]! } : {}),
  });
  made.add(id);
  return id;
}

/** Make the channel the relay's pushes name, before a token goes to the relay. */
export const prepareChannel = (sound: NotifySound, vibrate: NotifyVibrate): Promise<string> => channel(sound, vibrate).catch(() => notifyChannel({ sound, vibrate }));

export type NotifyPermission = "granted" | "denied" | "undetermined";

export async function permission(): Promise<NotifyPermission> {
  const p = await Notifications.getPermissionsAsync().catch(() => null);
  return p?.granted ? "granted" : p?.canAskAgain === false ? "denied" : (p?.status as NotifyPermission | undefined) ?? "undetermined";
}

export async function askPermission(): Promise<NotifyPermission> {
  await Notifications.requestPermissionsAsync().catch(() => null);
  return permission();
}

/** Show one now. */
export async function present(r: NotifyRequest): Promise<void> {
  const channelId = await channel(r.sound, r.vibrate).catch(() => undefined);
  await Notifications.scheduleNotificationAsync({
    identifier: r.tag,
    content: { title: r.title, body: r.body, data: r.data as unknown as Record<string, unknown>, sound: r.sound !== "none" },
    trigger: channelId ? { channelId } : null,
  });
}

const dataOf = (raw: unknown): NotifyData | null => {
  const d = (raw ?? {}) as Record<string, unknown>;
  if (typeof d.deviceId !== "string") return null;
  return {
    deviceId: d.deviceId,
    kind: typeof d.kind === "string" ? d.kind : "",
    ...(typeof d.sessionId === "string" ? { sessionId: d.sessionId } : {}),
    ...(typeof d.runId === "string" ? { runId: d.runId } : {}),
  };
};

/** Taps, including the one that opened the app. Returns the unsubscribe. */
export function onTap(cb: (d: NotifyData) => void): () => void {
  const last = Notifications.getLastNotificationResponse?.();
  const first = last ? dataOf(last.notification.request.content.data) : null;
  if (first) setTimeout(() => cb(first), 0);
  const sub = Notifications.addNotificationResponseReceivedListener((r) => {
    const d = dataOf(r.notification.request.content.data);
    if (d) cb(d);
  });
  return () => sub.remove();
}

/** The FCM token the relay pushes to; null without Firebase in the build (google-services.json) or on iOS without APNs. */
export async function pushToken(): Promise<{ platform: "android" | "ios"; token: string } | null> {
  if (Platform.OS !== "android") return null;
  const t = await Notifications.getDevicePushTokenAsync().catch(() => null);
  return t && typeof t.data === "string" ? { platform: "android", token: t.data } : null;
}

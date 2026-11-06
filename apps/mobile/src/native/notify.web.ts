/**
 * notify.ts on the web harness and in tests: every request is kept on
 * globalThis.__studioNotifications (what the e2e reads), and shown with the
 * browser's notification when it allows one. A tap is dispatched back the way
 * the native listener would.
 */
import type { NotifySound, NotifyVibrate } from "@ue-mcp-studio/shared";
import { notifyChannel } from "@ue-mcp-studio/client-core";

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

export type NotifyPermission = "granted" | "denied" | "undetermined";

const g = globalThis as {
  __studioNotifications?: NotifyRequest[];
  __studioNotifyTap?: (d: NotifyData) => void;
  __studioNotifyPermission?: NotifyPermission;
  /** Tests: what the system answers when the app asks, and how many times it asked. */
  __studioNotifyAnswer?: NotifyPermission;
  __studioNotifyAsks?: number;
};
const taps = new Set<(d: NotifyData) => void>();
/** Tap a shown notification, as the system would: the harness and tests call this. */
g.__studioNotifyTap = (d) => taps.forEach((cb) => cb(d));

export const prepareChannel = async (sound: NotifySound, vibrate: NotifyVibrate): Promise<string> => notifyChannel({ sound, vibrate });

export async function permission(): Promise<NotifyPermission> {
  if (g.__studioNotifyPermission) return g.__studioNotifyPermission;
  if (typeof Notification === "undefined") return "granted";
  return Notification.permission === "default" ? "undetermined" : Notification.permission;
}

/** The harness and tests record the request: globalThis.__studioNotifySettingsOpened. */
export async function openNotificationSettings(): Promise<void> {
  (globalThis as { __studioNotifySettingsOpened?: number }).__studioNotifySettingsOpened = ((globalThis as { __studioNotifySettingsOpened?: number }).__studioNotifySettingsOpened ?? 0) + 1;
}

export async function askPermission(): Promise<NotifyPermission> {
  g.__studioNotifyAsks = (g.__studioNotifyAsks ?? 0) + 1;
  if (g.__studioNotifyAnswer) return (g.__studioNotifyPermission = g.__studioNotifyAnswer);
  if (typeof Notification !== "undefined" && Notification.permission === "default") await Notification.requestPermission().catch(() => undefined);
  g.__studioNotifyPermission = undefined;
  return permission();
}

export async function present(r: NotifyRequest): Promise<void> {
  (g.__studioNotifications ??= []).push(r);
  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    const n = new Notification(r.title, { body: r.body, tag: r.tag, silent: r.sound === "none" });
    n.onclick = () => g.__studioNotifyTap?.(r.data);
  }
}

export function onTap(cb: (d: NotifyData) => void): () => void {
  taps.add(cb);
  return () => void taps.delete(cb);
}

export async function pushToken(): Promise<{ platform: "android" | "ios"; token: string } | null> {
  return null;
}

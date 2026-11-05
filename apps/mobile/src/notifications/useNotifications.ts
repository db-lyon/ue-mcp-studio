/**
 * Notifications on the phone while a project is open: each studio.notify the
 * computer publishes is decided against the project's events and this phone's
 * settings and shown as a local notification; presence tells the computer when
 * the app is in front, so "only when I'm away" holds on every device; and the
 * FCM token goes to the relay with this phone's filter, for the time the app
 * is closed. The project going offline and coming back is noticed here too.
 */
import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import type { DaemonEvent } from "ue-mcp/daemon";
import { latestTarget, noticeTag, pushPrefsFor, type SettingsApi } from "@ue-mcp-studio/client-core";
import { DEFAULT_PROJECT_NOTIFY, NOTIFY_EVENT, decideNotice, noticeContent, noticeOf, type Notice, type NotifyKind, type NotifyTarget } from "@ue-mcp-studio/shared";
import type { Device } from "../relay";
import { registerPush } from "../relay";
import { present, prepareChannel, pushToken, permission } from "../native/notify";
import { devicePrefsNow, loadProjectNotify, pendingLatest, projectNotifyNow, readDevicePrefs, useDevicePrefs, useProjectNotify } from "./state";

const SETTINGS_EVENT = "studio.notify.settings";
/** A stream down this long, with the app in front, is the project going offline. */
export const OFFLINE_AFTER_MS = 60_000;
export const PRESENCE_EVERY_MS = 20_000;

const appActive = (): boolean => AppState.currentState === "active";

/** The name a project shows by: the relay's "<project> on <computer>" without the computer. */
export const projectName = (d: Pick<Device, "name">): string => d.name.replace(/ on [^ ]+$/, "") || d.name;

/** Decide and show one notice on this phone. Resolves with whether it was shown. */
export async function showNotice(n: Notice, device: Pick<Device, "id">, api: SettingsApi): Promise<boolean> {
  const prefs = await readDevicePrefs();
  const project = projectNotifyNow(api)?.prefs ?? DEFAULT_PROJECT_NOTIFY;
  const d = decideNotice(n, project, prefs, { now: new Date(), projectKey: device.id, device: "phone", deviceActive: appActive() });
  if (!d.show) return false;
  const { title, body } = noticeContent(n, prefs.privacy);
  await present({
    title,
    body,
    sound: prefs.sound,
    vibrate: prefs.vibrate,
    tag: noticeTag(n),
    data: { deviceId: device.id, kind: n.kind, ...(n.target.sessionId ? { sessionId: n.target.sessionId } : {}), ...(n.target.runId ? { runId: n.target.runId } : {}) },
  });
  return true;
}

/** A notice the phone makes itself (the project going offline or coming back). */
const localNotice = (kind: NotifyKind, project: string, text: string): Notice => ({ id: `${kind}-${Date.now()}`, kind, project, at: new Date().toISOString(), title: kind === "project.offline" ? "Project went offline" : "Project came back", text, target: {} });

export function useNotifications({ events, device, api, streaming, onOpen }: { events: DaemonEvent[]; device: Device; api: SettingsApi; streaming: boolean; onOpen: (t: NotifyTarget) => void }): void {
  const seen = useRef<number | null>(null);
  if (seen.current === null) seen.current = events.length ? events[events.length - 1].id : 0;
  const open = useRef(onOpen);
  open.current = onOpen;
  const [prefs] = useDevicePrefs();
  const project = useProjectNotify(api);

  // A push tap that named only this project: go to the latest notice's session.
  useEffect(() => {
    const kind = pendingLatest.get(device.id);
    if (kind === undefined) return;
    pendingLatest.delete(device.id);
    void api.notifications().then((s) => {
      const t = latestTarget(s.recent, kind || undefined);
      if (t) open.current(t);
    }, () => undefined);
  }, [api, device.id]);

  useEffect(() => {
    const after = seen.current ?? 0;
    const fresh = events.filter((e) => e.id > after);
    if (fresh.length === 0) return;
    seen.current = fresh[fresh.length - 1].id;
    for (const e of fresh) {
      if (e.type === SETTINGS_EVENT) void loadProjectNotify(api, true);
      if (e.type !== NOTIFY_EVENT) continue;
      const n = noticeOf(e.data);
      if (n) void showNotice(n, device, api).catch(() => false);
    }
  }, [events, api, device]);

  // The project's stream: down for a minute is offline, back after that is back.
  const wentOffline = useRef(false);
  useEffect(() => {
    if (streaming) {
      if (wentOffline.current) {
        wentOffline.current = false;
        void showNotice(localNotice("project.online", projectName(device), "Answers again."), device, api).catch(() => false);
      }
      return;
    }
    const t = setTimeout(() => {
      if (!appActive()) return;
      wentOffline.current = true;
      void showNotice(localNotice("project.offline", projectName(device), "Stopped answering."), device, api).catch(() => false);
    }, OFFLINE_AFTER_MS);
    return () => clearTimeout(t);
  }, [streaming, device, api]);

  // Presence: the app in front is this phone in use.
  useEffect(() => {
    const id = `phone-${device.id.slice(0, 8)}-${Math.random().toString(36).slice(2, 8)}`;
    const report = () => api.notifyPresence({ id, device: "phone", active: appActive() }).catch(() => undefined);
    void report();
    const sub = AppState.addEventListener("change", () => void report());
    const timer = setInterval(() => appActive() && void report(), PRESENCE_EVERY_MS);
    return () => {
      sub.remove();
      clearInterval(timer);
    };
  }, [api, device.id]);

  // The relay's push, for the time the app is closed: this phone's token and filter.
  useEffect(() => {
    let gone = false;
    void (async () => {
      if ((await permission()) !== "granted") return;
      const token = await pushToken();
      if (!token || gone) return;
      const channel = await prepareChannel(prefs.sound, prefs.vibrate);
      await registerPush(token, pushPrefsFor(devicePrefsNow(), project?.prefs ?? DEFAULT_PROJECT_NOTIFY, undefined, channel)).catch(() => undefined);
    })();
    return () => {
      gone = true;
    };
  }, [prefs, project]);
}

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
import { DEFAULT_PROJECT_NOTIFY, NOTIFY_EVENT, decideNotice, noticeContent, noticeOf, testIsFor, type Notice, type NotifyDelivery, type NotifyKind, type NotifyTarget } from "@ue-mcp-studio/shared";
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

/** This run of the app: a phone's presence and test id is per project and per run. */
const RUN = Math.random().toString(36).slice(2, 8);
export const phoneIdFor = (deviceId: string): string => `phone-${deviceId.slice(0, 8)}-${RUN}`;

const reports = new Map<string, NotifyDelivery>();
const waiters = new Map<string, (d: NotifyDelivery) => void>();

function reported(api: SettingsApi, d: NotifyDelivery): void {
  reports.set(d.noticeId, d);
  if (reports.size > 50) reports.delete(reports.keys().next().value as string);
  waiters.get(d.noticeId)?.(d);
  waiters.delete(d.noticeId);
  // A notice the phone made itself is not the agent's to log.
  if (!d.noticeId.startsWith("project.")) api.notifyDelivery(d).catch(() => undefined);
}

/** Decide and show one notice on this phone, and report both to the computer. Resolves with the report, or null for another device's test. */
export async function showNotice(n: Notice, device: Pick<Device, "id">, api: SettingsApi): Promise<NotifyDelivery | null> {
  if (n.test && !testIsFor(n.test, phoneIdFor(device.id), "phone")) return null;
  const prefs = await readDevicePrefs();
  const project = projectNotifyNow(api)?.prefs ?? DEFAULT_PROJECT_NOTIFY;
  const base = { noticeId: n.id, kind: n.kind, ...(n.test ? { test: true } : {}), device: "phone" as const };
  const d = decideNotice(n, project, prefs, { now: new Date(), projectKey: device.id, device: "phone", deviceActive: appActive() });
  if (!d.show) {
    const r: NotifyDelivery = { ...base, shown: false, why: d.why };
    reported(api, r);
    return r;
  }
  const { title, body } = noticeContent(n, prefs.privacy);
  const allowed = await permission().catch(() => "unknown");
  let r: NotifyDelivery;
  try {
    await present({
      title,
      body,
      sound: prefs.sound,
      vibrate: prefs.vibrate,
      tag: noticeTag(n),
      data: { deviceId: device.id, kind: n.kind, ...(n.target.sessionId ? { sessionId: n.target.sessionId } : {}), ...(n.target.runId ? { runId: n.target.runId } : {}) },
    });
    r = { ...base, shown: true, via: "phone", ok: allowed === "granted", detail: `permission ${allowed}` };
  } catch (e) {
    r = { ...base, shown: true, via: "phone", ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
  reported(api, r);
  return r;
}

/** Settings > Notifications > Send test notification: the computer sends a test only this phone shows; resolves with what happened, or null. */
export async function sendTestNotification(api: SettingsApi, device: Pick<Device, "id">, timeoutMs = 10_000): Promise<NotifyDelivery | null> {
  const { notice } = await api.testNotification({ id: phoneIdFor(device.id) });
  const done = reports.get(notice.id);
  if (done) return done;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(notice.id);
      resolve(null);
    }, timeoutMs);
    waiters.set(notice.id, (d) => {
      clearTimeout(timer);
      resolve(d);
    });
  });
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
      if (n) void showNotice(n, device, api).catch(() => null);
    }
  }, [events, api, device]);

  // The project's stream: down for a minute is offline, back after that is back.
  const wentOffline = useRef(false);
  useEffect(() => {
    if (streaming) {
      if (wentOffline.current) {
        wentOffline.current = false;
        void showNotice(localNotice("project.online", projectName(device), "Answers again."), device, api).catch(() => null);
      }
      return;
    }
    const t = setTimeout(() => {
      if (!appActive()) return;
      wentOffline.current = true;
      void showNotice(localNotice("project.offline", projectName(device), "Stopped answering."), device, api).catch(() => null);
    }, OFFLINE_AFTER_MS);
    return () => clearTimeout(t);
  }, [streaming, device, api]);

  // Presence: the app in front is this phone in use.
  useEffect(() => {
    const id = phoneIdFor(device.id);
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

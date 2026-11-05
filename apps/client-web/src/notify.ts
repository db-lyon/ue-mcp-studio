/**
 * Notifications on this device: the agent's `studio.notify` notices, decided
 * against the project's shared settings and this device's own, then shown as
 * a Windows notification from Studio's window, a flash of the editor where
 * there is no window, or the browser's notification on a paired or local
 * browser. Clicking one opens its session. Only notices that arrive after the
 * page mounts are shown, so a reload does not repeat one.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { DaemonEvent } from "ue-mcp/daemon";
import {
  DEFAULT_PROJECT_NOTIFY,
  NOTIFY_EVENT,
  decideNotice,
  deviceNotifyOf,
  noticeContent,
  noticeOf,
  testIsFor,
  type DeviceNotifyPrefs,
  type Notice,
  type NotificationsState,
  type NotifyDelivery,
  type NotifyVia,
  type NotifyDevice,
  type NotifyTarget,
  type ProjectNotifyUpdate,
} from "@ue-mcp-studio/shared";
import { api } from "./api";
import { latestTarget, noticeTag } from "@ue-mcp-studio/client-core";
import { native } from "./native";
import { onRemotePage } from "./connection";
import { syncWebPush } from "./web-push";

/** The DOM event Studio's window dispatches when its notification is clicked. */
export const NOTIFICATION_CLICK = "studio-notification";
export const DEVICE_PREFS_KEY = "studio.notify.device";
const PREFS_CHANGED = "studio-notify-prefs";
const SETTINGS_EVENT = "studio.notify.settings";

// ── This device's settings, in its own storage ─────────────────────

export function readDevicePrefs(): DeviceNotifyPrefs {
  try {
    return deviceNotifyOf(JSON.parse(localStorage.getItem(DEVICE_PREFS_KEY) ?? "{}"));
  } catch {
    return deviceNotifyOf({});
  }
}

let devicePrefs: DeviceNotifyPrefs | null = null;
const deviceListeners = new Set<() => void>();

const subscribeDevice = (l: () => void) => {
  deviceListeners.add(l);
  return () => void deviceListeners.delete(l);
};
const deviceSnapshot = () => (devicePrefs ??= readDevicePrefs());

export function saveDevicePrefs(next: DeviceNotifyPrefs): void {
  devicePrefs = deviceNotifyOf(next);
  try {
    localStorage.setItem(DEVICE_PREFS_KEY, JSON.stringify(devicePrefs));
  } catch {
    // Storage blocked: the change holds for this page only.
  }
  for (const l of deviceListeners) l();
  window.dispatchEvent(new Event(PREFS_CHANGED));
}

export function useDevicePrefs(): [DeviceNotifyPrefs, (p: DeviceNotifyPrefs) => void] {
  const prefs = useSyncExternalStore(subscribeDevice, deviceSnapshot);
  return [prefs, saveDevicePrefs];
}

// ── The project's shared settings, read once and kept current ───────

let projectState: NotificationsState | null = null;
let loading: Promise<void> | null = null;
const projectListeners = new Set<() => void>();
const setProject = (s: NotificationsState | null) => {
  projectState = s;
  for (const l of [...projectListeners]) l();
};
const subscribeProject = (l: () => void) => {
  projectListeners.add(l);
  return () => void projectListeners.delete(l);
};
const projectSnapshot = () => projectState;

export function loadProjectNotify(force = false): Promise<void> {
  if (loading && !force) return loading;
  // An older agent, or a test double without the route, leaves notifications at their defaults.
  loading = Promise.resolve().then(() => api.notifications()).then(setProject, () => undefined);
  return loading;
}

export async function saveProjectNotify(u: ProjectNotifyUpdate): Promise<NotificationsState> {
  const next = await api.saveNotifications(u);
  setProject(next);
  return next;
}

/** The project's notification settings; null until read (or on an agent without them). */
export function useProjectNotify(load = true): NotificationsState | null {
  const state = useSyncExternalStore(subscribeProject, projectSnapshot);
  useEffect(() => {
    if (load && !projectState) void loadProjectNotify();
  }, [load]);
  return state;
}

/** For tests: forget what was read. */
export function resetNotifyState(): void {
  projectState = null;
  loading = null;
  devicePrefs = null;
}

// ── Where this page runs ──────────────────────────────────────────

export const deviceKind = (): NotifyDevice => (onRemotePage() ? "browser" : "desktop");
/** This page's id for presence and for its own test notifications, kept for the page's life. */
export const presenceId = `${deviceKind()}-${Math.random().toString(36).slice(2, 10)}`;
export const pageActive = (): boolean => typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus();

/** What the browser allows: "unsupported" where there is no Notification API. */
export function browserPermission(): NotificationPermission | "unsupported" {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}


// ── Showing one ───────────────────────────────────────────────────

export type Delivery = NotifyVia;

/** How a notice went out on this device, and what the system answered. */
export interface DeliveryResult {
  via: NotifyVia;
  ok: boolean;
  detail?: string;
}

/**
 * What the host's notify call answered. Studio's window answers
 * { ok, via, hr?, setting?, error? }; an older window or the editor answers true or false.
 */
export function hostAnswer(v: unknown): { ok: boolean; detail?: string } {
  if (typeof v === "boolean") return { ok: v };
  if (typeof v === "string") {
    try {
      return hostAnswer(JSON.parse(v));
    } catch {
      return { ok: false, detail: v.slice(0, 200) };
    }
  }
  const r = v as { ok?: unknown; via?: unknown; hr?: unknown; setting?: unknown; error?: unknown } | null;
  if (!r || typeof r !== "object") return { ok: false };
  const parts = [r.via, r.setting && `setting ${String(r.setting)}`, r.hr && `HRESULT ${String(r.hr)}`, r.error].filter((p): p is string => typeof p === "string" && p.length > 0);
  return { ok: r.ok === true, ...(parts.length ? { detail: parts.join(", ") } : {}) };
}

/** Show a notice on this device by the best means it has. */
export async function deliver(n: Notice, prefs: DeviceNotifyPrefs, onOpen: (t: NotifyTarget) => void): Promise<DeliveryResult> {
  const { title, body } = noticeContent(n, prefs.privacy);
  const nat = native();
  if (nat.notify) {
    const answer = hostAnswer(await nat.notify(JSON.stringify({ title, text: body, target: n.target, group: n.project })).catch((e: unknown) => String(e)));
    if (answer.ok || window.ue?.studioWindow) return { via: "window", ...answer };
  }
  if (window.ue?.studio && nat.drawattention) {
    const flashed = await nat.drawattention(body).catch(() => false);
    return { via: "flash", ok: !!flashed };
  }
  const permission = browserPermission();
  if (permission !== "granted") return { via: "none", ok: false, detail: `browser permission ${permission}` };
  const options: NotificationOptions = { body, tag: noticeTag(n), data: { target: n.target, at: Date.now() }, silent: prefs.sound === "none" };
  try {
    // A paired browser's page sits under the relay's service worker, which also shows pushes and handles their clicks.
    const reg = await navigator.serviceWorker?.getRegistration?.().catch(() => undefined);
    if (reg?.showNotification) {
      await reg.showNotification(title, options);
      return { via: "browser", ok: true, detail: "service worker" };
    }
    const shown = new Notification(title, options);
    shown.onclick = () => {
      window.focus();
      onOpen(n.target);
      shown.close();
    };
    return { via: "browser", ok: true };
  } catch (e) {
    return { via: "browser", ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

// ── Reporting what happened, and the test from Settings ───────────

const reports = new Map<string, NotifyDelivery>();
const waiters = new Map<string, (d: NotifyDelivery) => void>();

function reported(d: NotifyDelivery): void {
  reports.set(d.noticeId, d);
  if (reports.size > 50) reports.delete(reports.keys().next().value as string);
  waiters.get(d.noticeId)?.(d);
  waiters.delete(d.noticeId);
  api.notifyDelivery(d).catch(() => undefined);
}

/** Decide one notice on this page, show it, and report both to the agent. */
export async function handleNotice(n: Notice, onOpen: (t: NotifyTarget) => void): Promise<NotifyDelivery | null> {
  // Another device's test.
  if (n.test && !testIsFor(n.test, presenceId, deviceKind())) return null;
  const prefs = devicePrefs ?? (devicePrefs = readDevicePrefs());
  const device = deviceKind();
  const base = { noticeId: n.id, kind: n.kind, ...(n.test ? { test: true } : {}), device };
  const d = decideNotice(n, projectState?.prefs ?? DEFAULT_PROJECT_NOTIFY, prefs, { now: new Date(), projectKey: projectKeyOf(n), device, deviceActive: pageActive() });
  if (!d.show) {
    const r: NotifyDelivery = { ...base, shown: false, why: d.why };
    reported(r);
    return r;
  }
  const result = await deliver(n, prefs, onOpen).catch((e: unknown): DeliveryResult => ({ via: "none", ok: false, detail: e instanceof Error ? e.message : String(e) }));
  const r: NotifyDelivery = { ...base, shown: true, via: result.via, ok: result.ok, ...(result.detail ? { detail: result.detail } : {}) };
  reported(r);
  return r;
}

/**
 * Settings > Notifications > Send test notification: the agent publishes a
 * test notice, this page decides and shows it like any other, and this
 * resolves with what happened, or null when nothing came back in time.
 */
export async function sendTestNotification(timeoutMs = 10_000): Promise<NotifyDelivery | null> {
  const { notice } = await api.testNotification({ id: presenceId });
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

const targetOf = (v: unknown): NotifyTarget | null => {
  const t = v as Record<string, unknown> | null;
  if (!t || typeof t !== "object") return null;
  const out: NotifyTarget = {};
  for (const k of ["sessionId", "runId", "approvalId", "dialogId"] as const) if (typeof t[k] === "string") out[k] = t[k] as string;
  return Object.keys(out).length ? out : null;
};

/** The project key this page mutes by: the project's name. */
export const projectKeyOf = (n: Pick<Notice, "project">): string => n.project;

/**
 * Show the notices that arrive while the page is open, and open the session
 * when one is clicked (Studio's window, the browser, or the relay's worker).
 */
export function useNotifications(events: DaemonEvent[], onOpen: (t: NotifyTarget) => void): void {
  const seen = useRef<number | null>(null);
  if (seen.current === null) seen.current = events.length ? events[events.length - 1].id : 0;
  const open = useRef(onOpen);
  open.current = onOpen;
  useEffect(() => void loadProjectNotify(), []);
  useEffect(() => {
    const after = seen.current ?? 0;
    const fresh = events.filter((e) => e.id > after);
    if (fresh.length === 0) return;
    seen.current = fresh[fresh.length - 1].id;
    for (const e of fresh) {
      if (e.type === SETTINGS_EVENT) void loadProjectNotify(true);
      if (e.type !== NOTIFY_EVENT) continue;
      const n = noticeOf(e.data);
      if (n) void handleNotice(n, (t) => open.current(t));
    }
  }, [events]);
  useEffect(() => {
    const click = (e: Event) => {
      const t = targetOf((e as CustomEvent).detail);
      if (t) open.current(t);
    };
    const fromWorker = (e: MessageEvent) => {
      const m = e.data as { type?: unknown; target?: unknown; latest?: unknown } | null;
      if (m?.type !== "studio-notification-click") return;
      if (m.latest === true) return void openLatest((t) => open.current(t));
      const t = targetOf(m.target);
      if (t) open.current(t);
    };
    // Opened from a push, which names only the project: go to the session the latest notice was about.
    if (new URLSearchParams(window.location.search).get("from") === "push") {
      const url = new URL(window.location.href);
      url.searchParams.delete("from");
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
      void openLatest((t) => open.current(t));
    }
    window.addEventListener(NOTIFICATION_CLICK, click);
    navigator.serviceWorker?.addEventListener?.("message", fromWorker);
    return () => {
      window.removeEventListener(NOTIFICATION_CLICK, click);
      navigator.serviceWorker?.removeEventListener?.("message", fromWorker);
    };
  }, []);
}

/** Open the session of the newest notice the agent kept. */
export async function openLatest(onOpen: (t: NotifyTarget) => void): Promise<void> {
  const state = await api.notifications().catch(() => null);
  const t = latestTarget(state?.recent ?? []);
  if (t) onOpen(t);
}

export const PRESENCE_EVERY_MS = 20_000;



/**
 * Tell the agent when this page is in use, so a phone set to "only when I'm
 * away" stays quiet while the owner sits at Studio.
 */
export function usePresence(): void {
  useEffect(() => {
    let last: boolean | null = null;
    const report = (force = false) => {
      const active = pageActive();
      if (!force && active === last) return;
      last = active;
      api.notifyPresence({ id: presenceId, device: deviceKind(), active }).catch(() => undefined);
    };
    const change = () => report();
    report(true);
    const timer = setInterval(() => last && report(true), PRESENCE_EVERY_MS);
    window.addEventListener("focus", change);
    window.addEventListener("blur", change);
    document.addEventListener("visibilitychange", change);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", change);
      window.removeEventListener("blur", change);
      document.removeEventListener("visibilitychange", change);
    };
  }, []);
}

/** Keep this browser's push registration in step with its settings and the project's. */
export function useWebPush(): void {
  const [prefs] = useDevicePrefs();
  const project = useProjectNotify();
  useEffect(() => {
    if (!onRemotePage() || browserPermission() !== "granted") return;
    void syncWebPush(prefs, project?.prefs ?? DEFAULT_PROJECT_NOTIFY).catch(() => undefined);
  }, [prefs, project]);
}

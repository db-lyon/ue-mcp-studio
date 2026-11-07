/**
 * Notifications on this device: the agent's `studio.notify` notices, decided
 * against the project's shared settings and this device's own, then shown as
 * a Windows notification from Studio's window, a flash of the editor where
 * there is no window, or the browser's notification on a paired or local
 * browser. Clicking one opens its session. Each notice is decided once per
 * page, and none from before the page loaded (createNoticeGate), so neither a
 * reload nor the backlog a new stream starts with repeats one.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { DaemonEvent } from "ue-mcp/daemon";
import {
  DEFAULT_PROJECT_NOTIFY,
  NOTIFY_EVENT,
  decideNotice,
  deviceNotifyOf,
  inUse,
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
import { createNoticeGate, latestTarget, newestEventId, noticeTag, presenceDue } from "@ue-mcp-studio/client-core";
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
  // The computer's page storage belongs to the daemon's port, which changes on every restart: the agent keeps the copy that lasts.
  if (deviceKind() === "desktop") api.saveDesktopNotify(devicePrefs).catch(() => undefined);
  for (const l of deviceListeners) l();
  window.dispatchEvent(new Event(PREFS_CHANGED));
}

export function useDevicePrefs(): [DeviceNotifyPrefs, (p: DeviceNotifyPrefs) => void] {
  const prefs = useSyncExternalStore(subscribeDevice, deviceSnapshot);
  return [prefs, saveDevicePrefs];
}

/**
 * On the computer, the settings the agent kept win over this page's storage,
 * which starts empty whenever the daemon comes back on another port. A page
 * with settings and no kept copy hands its own over.
 */
let desktopLoad: Promise<void> | null = null;
export function loadDesktopPrefs(force = false): Promise<void> {
  if (deviceKind() !== "desktop") return Promise.resolve();
  if (desktopLoad && !force) return desktopLoad;
  desktopLoad = Promise.resolve()
    .then(() => api.desktopNotify())
    .then(
      ({ prefs }) => {
        if (prefs) {
          devicePrefs = deviceNotifyOf(prefs);
          try {
            localStorage.setItem(DEVICE_PREFS_KEY, JSON.stringify(devicePrefs));
          } catch {
            // Storage blocked: the kept copy still holds for this page.
          }
          for (const l of deviceListeners) l();
        } else {
          let stored: string | null = null;
          try {
            stored = localStorage.getItem(DEVICE_PREFS_KEY);
          } catch {
            stored = null;
          }
          if (stored) api.saveDesktopNotify(readDevicePrefs()).catch(() => undefined);
        }
      },
      () => undefined,
    );
  return desktopLoad;
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

/** The notices this page has decided, kept for the page's life whatever remounts. */
let gate = createNoticeGate();

/** For tests: forget what was read. */
export function resetNotifyState(): void {
  projectState = null;
  loading = null;
  devicePrefs = null;
  desktopLoad = null;
  lastPageInput = null;
  gate = createNoticeGate();
}

// ── Where this page runs ──────────────────────────────────────────

export const deviceKind = (): NotifyDevice => (onRemotePage() ? "browser" : "desktop");
/** This page's id for presence and for its own test notifications, kept for the page's life. */
export const presenceId = `${deviceKind()}-${Math.random().toString(36).slice(2, 10)}`;
/** This page's window is in front and has the keyboard. */
export const pageFocused = (): boolean => typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus();

/** When the owner last gave this page input; null before any. */
let lastPageInput: number | null = null;
const INPUT_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;
if (typeof window !== "undefined") {
  for (const type of INPUT_EVENTS) window.addEventListener(type, () => void (lastPageInput = Date.now()), { capture: true, passive: true });
}

/**
 * Milliseconds since the owner's last input: Studio's window asks Windows
 * (any keyboard or mouse input on the computer); a browser knows only its own page.
 */
export async function inputAgeMs(): Promise<number | undefined> {
  const nat = native();
  if (window.ue?.studioWindow && nat.lastinput) {
    const ms = await nat.lastinput().catch(() => null);
    if (typeof ms === "number" && Number.isFinite(ms) && ms >= 0) return ms;
  }
  return lastPageInput === null ? undefined : Date.now() - lastPageInput;
}

/** The owner is using this page now: real input within two minutes, and its window focused. */
export async function pageInUse(): Promise<{ active: boolean; inputAgeMs?: number }> {
  const age = await inputAgeMs();
  return { active: inUse(age, pageFocused()), ...(age !== undefined ? { inputAgeMs: age } : {}) };
}


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
 * { ok, via, hr?, setting?, error?, duplicate? }; an older window or the editor answers true or false.
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
  const r = v as { ok?: unknown; via?: unknown; hr?: unknown; setting?: unknown; error?: unknown; duplicate?: unknown } | null;
  if (!r || typeof r !== "object") return { ok: false };
  const parts = [r.via, r.setting && `setting ${String(r.setting)}`, r.hr && `HRESULT ${String(r.hr)}`, r.error, r.duplicate === true && "already shown"].filter((p): p is string => typeof p === "string" && p.length > 0);
  return { ok: r.ok === true, ...(parts.length ? { detail: parts.join(", ") } : {}) };
}

/** Show a notice on this device by the best means it has. */
export async function deliver(n: Notice, prefs: DeviceNotifyPrefs, onOpen: (t: NotifyTarget) => void): Promise<DeliveryResult> {
  const { title, body } = noticeContent(n, prefs.privacy);
  const nat = native();
  if (nat.notify) {
    // The id lets Studio's window show one toast per notice, whichever page asks.
    const answer = hostAnswer(await nat.notify(JSON.stringify({ id: n.id, title, text: body, target: n.target, group: n.project })).catch((e: unknown) => String(e)));
    if (answer.ok || window.ue?.studioWindow) return { via: "window", ...answer };
  }
  if (window.ue?.studio && nat.drawattention) {
    // The editor's toast has one line: the subject and the state together.
    const flashed = await nat.drawattention(`${title} - ${body}`).catch(() => false);
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
  // Decided already, or from before this page loaded.
  if (!gate.admit(n)) return null;
  await loadDesktopPrefs();
  const prefs = devicePrefs ?? (devicePrefs = readDevicePrefs());
  const device = deviceKind();
  const use = await pageInUse();
  const base = { noticeId: n.id, kind: n.kind, ...(n.test ? { test: true } : {}), device, ...(use.inputAgeMs !== undefined ? { inputAgeMs: use.inputAgeMs } : {}) };
  const d = decideNotice(n, projectState?.prefs ?? DEFAULT_PROJECT_NOTIFY, prefs, { now: new Date(), projectKey: projectKeyOf(n), device });
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
  useEffect(() => {
    void loadProjectNotify();
    void loadDesktopPrefs();
  }, []);
  useEffect(() => {
    const after = seen.current ?? 0;
    const fresh = events.filter((e) => e.id > after);
    if (fresh.length === 0) return;
    seen.current = newestEventId(fresh, after);
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

/** How often the page checks whether the owner went idle or came back. */
export const PRESENCE_CHECK_MS = 10_000;

/**
 * Tell the agent when the owner is using this page (pageInUse), so a phone
 * set to "only when I'm away" stays quiet while the owner sits at Studio:
 * at once on a change, and every PRESENCE_EVERY_MS in either state, so the
 * agent keeps listing this page while it is open (presenceDue).
 */
export function usePresence(): void {
  useEffect(() => {
    let last: boolean | null = null;
    let sentAt = 0;
    let gone = false;
    const report = async (force = false) => {
      const use = await pageInUse();
      if (gone) return;
      if (!force && !presenceDue(use.active, last, sentAt, Date.now())) return;
      last = use.active;
      sentAt = Date.now();
      api.notifyPresence({ id: presenceId, device: deviceKind(), ...use }).catch(() => undefined);
    };
    const change = () => void report();
    void report(true);
    const timer = setInterval(change, PRESENCE_CHECK_MS);
    window.addEventListener("focus", change);
    window.addEventListener("blur", change);
    document.addEventListener("visibilitychange", change);
    return () => {
      gone = true;
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

/**
 * The phone's notification settings: its own (kept in its secure store, as
 * the web client keeps them in the browser's) and each project's shared ones
 * (read from the computer), with the hooks the screens read them through.
 */
import { useEffect, useSyncExternalStore } from "react";
import * as SecureStore from "expo-secure-store";
import { deviceNotifyOf, type DeviceNotifyPrefs, type NotificationsState, type ProjectNotifyUpdate } from "@ue-mcp-studio/shared";
import type { SettingsApi } from "@ue-mcp-studio/client-core";

/** The same key the web client stores its device settings under. */
export const DEVICE_PREFS_KEY = "studio.notify.device";

let device: DeviceNotifyPrefs = deviceNotifyOf({});
let deviceRead: Promise<DeviceNotifyPrefs> | null = null;
const deviceListeners = new Set<() => void>();
const emitDevice = () => [...deviceListeners].forEach((l) => l());

/** This phone's settings, read once from the secure store. */
export function readDevicePrefs(): Promise<DeviceNotifyPrefs> {
  deviceRead ??= SecureStore.getItemAsync(DEVICE_PREFS_KEY)
    .then((raw) => (device = deviceNotifyOf(raw ? JSON.parse(raw) : {})))
    .catch(() => device)
    .finally(emitDevice);
  return deviceRead;
}

export const devicePrefsNow = (): DeviceNotifyPrefs => device;

export function saveDevicePrefs(next: DeviceNotifyPrefs): void {
  device = deviceNotifyOf(next);
  deviceRead = Promise.resolve(device);
  void SecureStore.setItemAsync(DEVICE_PREFS_KEY, JSON.stringify(device)).catch(() => undefined);
  emitDevice();
}

const subscribeDevice = (l: () => void) => {
  deviceListeners.add(l);
  return () => void deviceListeners.delete(l);
};
const deviceSnapshot = () => device;

export function useDevicePrefs(): [DeviceNotifyPrefs, (p: DeviceNotifyPrefs) => void] {
  const prefs = useSyncExternalStore(subscribeDevice, deviceSnapshot);
  useEffect(() => void readDevicePrefs(), []);
  return [prefs, saveDevicePrefs];
}

// ── Each project's shared settings ──────────────────────────────────

const projects = new Map<SettingsApi, NotificationsState | null>();
const loads = new Map<SettingsApi, Promise<void>>();
const projectListeners = new Set<() => void>();
const emitProject = () => [...projectListeners].forEach((l) => l());

export function loadProjectNotify(api: SettingsApi, force = false): Promise<void> {
  const known = loads.get(api);
  if (known && !force) return known;
  // An older agent answers 404: notifications stay at their defaults.
  const p = Promise.resolve()
    .then(() => api.notifications())
    .then(
      (s) => {
        projects.set(api, s);
        emitProject();
      },
      () => undefined,
    );
  loads.set(api, p);
  return p;
}

export async function saveProjectNotify(api: SettingsApi, u: ProjectNotifyUpdate): Promise<NotificationsState> {
  const next = await api.saveNotifications(u);
  projects.set(api, next);
  emitProject();
  return next;
}

export const projectNotifyNow = (api: SettingsApi): NotificationsState | null => projects.get(api) ?? null;

const subscribeProject = (l: () => void) => {
  projectListeners.add(l);
  return () => void projectListeners.delete(l);
};

/** A project's notification settings; null until read. */
export function useProjectNotify(api: SettingsApi, load = true): NotificationsState | null {
  const state = useSyncExternalStore(subscribeProject, () => projects.get(api) ?? null);
  useEffect(() => {
    if (load && !projects.has(api)) void loadProjectNotify(api);
  }, [api, load]);
  return state;
}

/** For tests: forget everything read. */
export function resetNotifyState(): void {
  device = deviceNotifyOf({});
  deviceRead = null;
  projects.clear();
  loads.clear();
}

/** A push tap that named only the project: the project's screen opens the latest notice's session (by kind) once it mounts. */
export const pendingLatest = new Map<string, string>();

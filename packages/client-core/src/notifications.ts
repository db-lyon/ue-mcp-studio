/**
 * Notifications as both clients read them: the agent's settings answer made
 * whole, the filter a device sends the relay with its push address, the tag a
 * push and a page's own notification share, and where a tap goes.
 */
import {
  NOTIFY_KINDS,
  noticeOf,
  projectNotifyOf,
  type DeviceNotifyPrefs,
  type NotifyPrivacy,
  type NotifySound,
  type NotifyVibrate,
  type Notice,
  type NotificationsState,
  type NotifyKind,
  type NotifyTarget,
  type ProjectNotifyPrefs,
} from "@ue-mcp-studio/shared";

/** GET /v1/ext/studio/notifications, made whole: an older agent's missing fields at their defaults. */
export function notificationsOf(raw: unknown): NotificationsState {
  const r = (raw ?? {}) as { project?: unknown; prefs?: unknown; recent?: unknown; titles?: unknown };
  const titles = r.titles && typeof r.titles === "object" ? (Object.fromEntries(Object.entries(r.titles).filter(([, v]) => typeof v === "string")) as Record<string, string>) : {};
  return {
    project: typeof r.project === "string" ? r.project : "",
    prefs: projectNotifyOf(r.prefs),
    recent: Array.isArray(r.recent) ? r.recent.map(noticeOf).filter((n): n is Notice => n !== null) : [],
    titles,
  };
}

/** What the relay filters a push by. Nothing in it is content. */
export interface PushPrefs {
  enabled: boolean;
  kinds: NotifyKind[];
  /** Project names or relay project ids muted on this device. */
  muted: string[];
  quiet: DeviceNotifyPrefs["quiet"];
  /** IANA time zone, for quiet hours. */
  tz: string;
  onlyWhenAway: boolean;
  /** The app's notification channel (sound and vibration), Android only. */
  channel?: string;
}

export function pushPrefsFor(device: DeviceNotifyPrefs, project: ProjectNotifyPrefs, tz = Intl.DateTimeFormat().resolvedOptions().timeZone, channel?: string): PushPrefs {
  return {
    enabled: device.enabled,
    kinds: NOTIFY_KINDS.filter((k) => project.events[k.kind]).map((k) => k.kind),
    muted: device.mutedProjects,
    quiet: device.quiet,
    tz: tz || "UTC",
    onlyWhenAway: device.onlyWhenAway,
    ...(channel ? { channel } : {}),
  };
}

/** A tag per event and project: a push and a page's own notification for the same thing replace each other. */
export const noticeTag = (n: Pick<Notice, "kind" | "project">): string => `uemcp:${n.kind}:${n.project}`;

/** Where a tap on a push goes, which names only the project: the newest notice's session. */
export function latestTarget(recent: readonly Notice[], kind?: string): NotifyTarget | null {
  const withSession = [...recent].reverse().filter((n) => n.target.sessionId);
  return (withSession.find((n) => !kind || n.kind === kind) ?? withSession[0])?.target ?? null;
}

/** The Android notification channel for a device's sound and vibration. */
export const notifyChannel = (p: Pick<DeviceNotifyPrefs, "sound" | "vibrate">): string => `studio-${p.sound}-${p.vibrate}`;

/** What a notification shows, as Settings offers it. */
export const PRIVACY_CHOICES: ReadonlyArray<{ id: NotifyPrivacy; name: string }> = [
  { id: "full", name: "Full text" },
  { id: "minimal", name: "Event and project" },
];
export const SOUND_CHOICES: ReadonlyArray<{ id: NotifySound; name: string }> = [
  { id: "default", name: "Sound" },
  { id: "soft", name: "Soft" },
  { id: "none", name: "Silent" },
];
export const VIBRATE_CHOICES: ReadonlyArray<{ id: NotifyVibrate; name: string }> = [
  { id: "default", name: "Vibrate" },
  { id: "short", name: "Short" },
  { id: "none", name: "Off" },
];

/** Settings > Notifications, the same words in both clients. */
export const NOTIFY_COPY = {
  lead: "When Studio tells you something happened, and what it shows.",
  enabled: { title: "Notifications on this device", help: "Off: this device shows none, whatever the events below say." },
  away: { title: "Only when I'm away", help: "Not while you are using this device. Phones and other browsers also stay quiet while you use Studio on the computer." },
  privacy: { title: "What a notification shows", help: "Event and project keeps your messages and file names off the lock screen." },
  quiet: { title: "Quiet hours", help: "No notifications between these times, on this device's clock." },
  sound: { title: "Sound", help: "How a notification sounds on this phone." },
  vibrate: { title: "Vibration", help: "How this phone vibrates for one." },
  mute: (project: string) => ({ title: `Mute ${project} here`, help: "This project's notifications stay off on this device. Other devices keep theirs." }),
  events: (project: string) => `Shared by every device paired with ${project || "this project"}.`,
  noMuted: "None. Mute a session from its menu in the session list.",
  deletedSession: "A session that was deleted",
  permission: {
    title: "Notification permission",
    ask: "The system asks once before it shows any.",
    denied: "Notifications are blocked for Studio. Allow them in the system's settings.",
    unsupported: "This browser cannot show notifications.",
    button: "Allow notifications",
  },
} as const;

/**
 * Notifications as both clients read them: the agent's settings answer made
 * whole, the filter a device sends the relay with its push address, the tag a
 * push and a page's own notification share, and where a tap goes.
 */
import {
  NOTIFY_KINDS,
  REMOTE_PLANS,
  SKIP_NAMES,
  noticeOf,
  projectNotifyOf,
  type DeviceNotifyPrefs,
  type NotifyPrivacy,
  type NotifySound,
  type NotifyVibrate,
  type Notice,
  type NotificationsState,
  type NotifyDelivery,
  type NotifyKind,
  type NotifyTarget,
  type NotifyVia,
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

/**
 * How old a notice may be and still show when a client starts. A stream that
 * opens with no id to resume from gets the daemon's whole backlog first, and
 * a remounted view sees that again, so without this every kept notice showed
 * again. Wide enough for a phone's clock to differ from the computer's.
 */
export const NOTICE_FRESH_MS = 5 * 60_000;

/** Each notice once per run of a client: none it already decided, none from before it started (NOTICE_FRESH_MS). Tests are always new. */
export interface NoticeGate {
  admit(n: Pick<Notice, "id" | "at" | "test">): boolean;
}

export function createNoticeGate(startedAt: number = Date.now(), keep = 500): NoticeGate {
  const seen = new Set<string>();
  const order: string[] = [];
  return {
    admit(n) {
      if (seen.has(n.id)) return false;
      seen.add(n.id);
      order.push(n.id);
      if (order.length > keep) seen.delete(order.shift() as string);
      if (n.test) return true;
      const at = Date.parse(n.at);
      return !(Number.isFinite(at) && at < startedAt - NOTICE_FRESH_MS);
    },
  };
}

/** The newest event id among events, never less than `after`: a stream's events are not always in id order (a backlog replayed after live ones). */
export const newestEventId = (events: ReadonlyArray<{ id: number }>, after: number): number => events.reduce((m, e) => (e.id > m ? e.id : m), after);

/** How often a client tells the agent whether the owner is using it, idle included, so the agent's list of devices stays whole. */
export const PRESENCE_EVERY_MS = 20_000;

/** Whether a presence report is due: a change at once, else every PRESENCE_EVERY_MS whatever the state. */
export const presenceDue = (active: boolean, last: boolean | null, sentAt: number, now: number): boolean => active !== last || now - sentAt >= PRESENCE_EVERY_MS;

/** The Android notification channel for a device's sound and vibration. */
export const notifyChannel = (p: Pick<DeviceNotifyPrefs, "sound" | "vibrate">): string => `studio-${p.sound}-${p.vibrate}`;

/** Events only the app raises, from watching the project through the relay. */
export const RELAY_ONLY_KINDS: ReadonlySet<NotifyKind> = new Set<NotifyKind>(["project.offline", "project.online"]);

/** The events Settings lists: every one where remote control works, else the ones this computer raises. */
export const notifyKindsFor = (relay: boolean): typeof NOTIFY_KINDS => (relay ? NOTIFY_KINDS : NOTIFY_KINDS.filter((k) => !RELAY_ONLY_KINDS.has(k.kind)));

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
  away: {
    title: "Only when I'm away",
    help: "Not while you are using another device: Studio in front there, with your last input under two minutes ago. Whatever this says, none comes for a chat you have open in front of you, or for a turn you stopped.",
    /** Where remote control does not work: nothing is paired. */
    helpLocal: "None comes for a chat you have open in front of you, or for a turn you stopped. Other chats still notify while Studio is open.",
  },
  privacy: { title: "What a notification shows", help: "Event and project keeps your messages and file names off the lock screen." },
  quiet: { title: "Quiet hours", help: "No notifications between these times, on this device's clock." },
  sound: { title: "Sound", help: "How a notification sounds on this phone." },
  vibrate: { title: "Vibration", help: "How this phone vibrates for one." },
  mute: (project: string) => ({
    title: `Mute ${project} on this device`,
    help: "This project's notifications stay off on this device. Other devices keep theirs.",
    helpLocal: "This project's notifications stay off on this device.",
  }),
  events: (project: string) => `Shared by every device paired with ${project || "this project"}.`,
  eventsLocal: (project: string) => `Which events in ${project || "this project"} notify you.`,
  /** The one line a computer without a paid plan sees, while the plan is offered. */
  remotePlan: `Phone and browser notifications come with remote control, on ${REMOTE_PLANS}.`,
  noMuted: "None. Mute a session from its menu in the session list.",
  deletedSession: "A session that was deleted",
  permission: {
    title: "Notification permission",
    ask: "The system asks once before it shows any.",
    denied: "Notifications are blocked for Studio. Allow them in the system's settings.",
    unsupported: "This browser cannot show notifications.",
    button: "Allow notifications",
    /** The app, once Android has denied it: only Android's settings can allow it now. */
    openSettings: "Open notification settings",
  },
  test: {
    title: "Test notification",
    help: "Sends one to this device the way a real event does, and says what happened to it.",
    button: "Send test notification",
    sending: "Sending...",
  },
} as const;

/** What became of a test notification, said in Settings. */
export function testResultText(d: NotifyDelivery | null): { ok: boolean; text: string } {
  if (!d) return { ok: false, text: "No answer: the test did not reach this device. Settings > Diagnostics > Events shows how far it got." };
  if (!d.shown) return { ok: false, text: `Not shown: ${d.why ? SKIP_NAMES[d.why] : "a setting kept it off"}.` };
  const detail = d.detail ? ` (${d.detail})` : "";
  if (d.via === "none" || !d.via) return { ok: false, text: `Not shown: nothing on this device can show a notification${detail}.` };
  if (d.ok === false) return { ok: false, text: `Not shown: ${FAILED[d.via]}${detail}.` };
  return { ok: true, text: `${SHOWN[d.via]}${detail}.` };
}

const SHOWN: Record<Exclude<NotifyVia, "none">, string> = {
  window: "Sent to Windows. If no notification appeared, Windows' Do not disturb may be on, and it waits in the notification center",
  flash: "The editor's taskbar button flashed. Studio's own window shows Windows notifications",
  browser: "Sent to the browser",
  phone: "Shown on this phone",
};

const FAILED: Record<Exclude<NotifyVia, "none">, string> = {
  window: "Windows refused the notification",
  flash: "the editor could not flash its taskbar button",
  browser: "the browser refused the notification",
  phone: "the phone refused the notification",
};

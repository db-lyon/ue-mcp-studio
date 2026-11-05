/**
 * Notifications: what Studio tells the owner outside the panel, and the rules
 * every device applies before it shows one. The agent publishes a Notice as
 * the `studio.notify` event; the Studio window, a paired browser and the app
 * each decide with decideNotice against the project's shared settings (which
 * events) and their own (mutes, quiet hours, privacy, only when away).
 */

export type NotifyKind =
  | "turn.finished"
  | "turn.failed"
  | "approval.waiting"
  | "dialog.waiting"
  | "playtest.needs-you"
  | "playtest.finished"
  | "subagent.finished"
  | "context.limit"
  | "project.offline"
  | "project.online";

/** The daemon event a Notice arrives as. */
export const NOTIFY_EVENT = "studio.notify";

export const NOTIFY_KINDS: ReadonlyArray<{ kind: NotifyKind; name: string; help: string; on: boolean }> = [
  { kind: "turn.finished", name: "Turn finished", help: "The agent finished and is waiting for your next message.", on: true },
  { kind: "turn.failed", name: "Turn failed or stopped", help: "A turn ended with an error, or was stopped.", on: true },
  { kind: "approval.waiting", name: "Approval waiting", help: "A tool call waits for you to allow or deny it.", on: true },
  { kind: "dialog.waiting", name: "Editor dialog waiting", help: "An editor dialog waits for your answer.", on: true },
  { kind: "playtest.needs-you", name: "Playtest needs you", help: "A manual step waits for your verdict, or a playtest loop stopped for you.", on: true },
  { kind: "playtest.finished", name: "Playtest finished", help: "A playtest run ended, passed or failed.", on: true },
  { kind: "subagent.finished", name: "Subagent finished", help: "A subagent ended its task.", on: false },
  { kind: "context.limit", name: "Context near the limit", help: "A conversation is close to compaction, or a compaction failed.", on: false },
  { kind: "project.offline", name: "Project went offline", help: "The project stopped answering through remote control.", on: false },
  { kind: "project.online", name: "Project came back", help: "The project answers again after going offline.", on: false },
];

export const isNotifyKind = (v: unknown): v is NotifyKind => NOTIFY_KINDS.some((k) => k.kind === v);

/** Where tapping a notification goes: a session, and in it a playtest card, approval or dialog. */
export interface NotifyTarget {
  sessionId?: string;
  runId?: string;
  approvalId?: string;
  dialogId?: string;
}

/** The device classes presence is reported for. "desktop" is the Studio window or the editor's tab on the computer. */
export type NotifyDevice = "desktop" | "browser" | "phone";

/** One thing worth telling the owner, as the agent publishes it. */
export interface Notice {
  id: string;
  kind: NotifyKind;
  /** The project's name. */
  project: string;
  /** ISO 8601. */
  at: string;
  sessionId?: string;
  sessionTitle?: string;
  /** Full text. A device set to hide details shows only the event and project. */
  title: string;
  text: string;
  target: NotifyTarget;
  /** Device classes the owner was using when it was sent, for "only when I'm away". */
  active?: NotifyDevice[];
}

/** Per project, shared by every device: which events notify, and the sessions muted. */
export interface ProjectNotifyPrefs {
  events: Record<NotifyKind, boolean>;
  mutedSessions: string[];
}

export const defaultEvents = (): Record<NotifyKind, boolean> => Object.fromEntries(NOTIFY_KINDS.map((k) => [k.kind, k.on])) as Record<NotifyKind, boolean>;

export const DEFAULT_PROJECT_NOTIFY: ProjectNotifyPrefs = { events: defaultEvents(), mutedSessions: [] };

/** A stored or sent value made whole: unknown kinds dropped, missing ones at their defaults. */
export function projectNotifyOf(raw: unknown): ProjectNotifyPrefs {
  const r = (raw ?? {}) as { events?: Record<string, unknown>; mutedSessions?: unknown };
  const events = defaultEvents();
  for (const k of NOTIFY_KINDS) if (typeof r.events?.[k.kind] === "boolean") events[k.kind] = r.events[k.kind] as boolean;
  const muted = Array.isArray(r.mutedSessions) ? r.mutedSessions.filter((s): s is string => typeof s === "string" && s.length > 0 && s.length <= 200) : [];
  return { events, mutedSessions: [...new Set(muted)].slice(0, 500) };
}

/** A change to the project's settings: events to merge, and sessions to mute or unmute. */
export interface ProjectNotifyUpdate {
  events?: Partial<Record<NotifyKind, boolean>>;
  mute?: string[];
  unmute?: string[];
}

export function applyProjectNotify(p: ProjectNotifyPrefs, u: ProjectNotifyUpdate): ProjectNotifyPrefs {
  const events = { ...p.events };
  for (const [k, v] of Object.entries(u.events ?? {})) if (isNotifyKind(k) && typeof v === "boolean") events[k] = v;
  const unmute = new Set(u.unmute ?? []);
  const muted = [...p.mutedSessions.filter((s) => !unmute.has(s)), ...(u.mute ?? []).filter((s) => typeof s === "string")];
  return projectNotifyOf({ events, mutedSessions: muted });
}

/** Quiet hours, local time, "HH:MM". A range past midnight (22:00 to 07:00) wraps. */
export interface QuietHours {
  on: boolean;
  from: string;
  to: string;
}

export type NotifyPrivacy = "full" | "minimal";
export type NotifySound = "default" | "soft" | "none";
export type NotifyVibrate = "default" | "short" | "none";

/** Per device: kept by the device, never shared. */
export interface DeviceNotifyPrefs {
  enabled: boolean;
  /** Project keys muted on this device (the project's name on the computer, its relay id in the app). */
  mutedProjects: string[];
  quiet: QuietHours;
  privacy: NotifyPrivacy;
  sound: NotifySound;
  vibrate: NotifyVibrate;
  /** Skip a notification while this device is in use, and on a phone while the Studio window is. */
  onlyWhenAway: boolean;
}

export const DEFAULT_DEVICE_NOTIFY: DeviceNotifyPrefs = {
  enabled: true,
  mutedProjects: [],
  quiet: { on: false, from: "22:00", to: "07:00" },
  privacy: "full",
  sound: "default",
  vibrate: "default",
  onlyWhenAway: true,
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const pick = <T extends string>(v: unknown, allowed: readonly T[], d: T): T => (allowed.includes(v as T) ? (v as T) : d);

export function deviceNotifyOf(raw: unknown): DeviceNotifyPrefs {
  const r = (raw ?? {}) as Partial<Record<keyof DeviceNotifyPrefs, unknown>>;
  const d = DEFAULT_DEVICE_NOTIFY;
  const q = (r.quiet ?? {}) as Partial<Record<keyof QuietHours, unknown>>;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : d.enabled,
    mutedProjects: Array.isArray(r.mutedProjects) ? [...new Set(r.mutedProjects.filter((s): s is string => typeof s === "string" && s.length > 0))] : [],
    quiet: {
      on: typeof q.on === "boolean" ? q.on : d.quiet.on,
      from: typeof q.from === "string" && HHMM.test(q.from) ? q.from : d.quiet.from,
      to: typeof q.to === "string" && HHMM.test(q.to) ? q.to : d.quiet.to,
    },
    privacy: pick(r.privacy, ["full", "minimal"] as const, d.privacy),
    sound: pick(r.sound, ["default", "soft", "none"] as const, d.sound),
    vibrate: pick(r.vibrate, ["default", "short", "none"] as const, d.vibrate),
    onlyWhenAway: typeof r.onlyWhenAway === "boolean" ? r.onlyWhenAway : d.onlyWhenAway,
  };
}

const minutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Whether a local time falls in quiet hours. from == to is a whole day. */
export function inQuietHours(q: QuietHours, at: Date): boolean {
  if (!q.on) return false;
  const now = at.getHours() * 60 + at.getMinutes();
  const from = minutes(q.from);
  const to = minutes(q.to);
  if (from === to) return true;
  return from < to ? now >= from && now < to : now >= from || now < to;
}

export interface NotifyContext {
  now: Date;
  /** This device's key for the notice's project (see DeviceNotifyPrefs.mutedProjects). */
  projectKey: string;
  device: NotifyDevice;
  /** The owner is using this device right now: its Studio page is visible and focused, or the app is in front. */
  deviceActive: boolean;
}

export type NotifySkip = "off" | "event" | "project-muted" | "session-muted" | "quiet" | "active" | "desktop-active";
export type NotifyDecision = { show: true } | { show: false; why: NotifySkip };

/** Whether this device shows a notice, and why not. */
export function decideNotice(n: Pick<Notice, "kind" | "sessionId" | "active">, project: ProjectNotifyPrefs, device: DeviceNotifyPrefs, ctx: NotifyContext): NotifyDecision {
  if (!device.enabled) return { show: false, why: "off" };
  if (!project.events[n.kind]) return { show: false, why: "event" };
  if (device.mutedProjects.includes(ctx.projectKey)) return { show: false, why: "project-muted" };
  if (n.sessionId && project.mutedSessions.includes(n.sessionId)) return { show: false, why: "session-muted" };
  if (inQuietHours(device.quiet, ctx.now)) return { show: false, why: "quiet" };
  if (device.onlyWhenAway) {
    if (ctx.deviceActive) return { show: false, why: "active" };
    if (ctx.device !== "desktop" && n.active?.includes("desktop")) return { show: false, why: "desktop-active" };
  }
  return { show: true };
}

/** The event's own name, the text shown when details are hidden. */
export const notifyKindName = (kind: NotifyKind): string => NOTIFY_KINDS.find((k) => k.kind === kind)?.name ?? "Studio";

/** What the notification says on this device. */
export function noticeContent(n: Pick<Notice, "kind" | "project" | "title" | "text">, privacy: NotifyPrivacy): { title: string; body: string } {
  if (privacy === "minimal") return { title: notifyKindName(n.kind), body: n.project };
  return { title: n.title, body: n.project ? `${n.project}: ${n.text}` : n.text };
}

/** A Notice read from an event's data, or null when it is not one. */
export function noticeOf(data: unknown): Notice | null {
  const d = data as Partial<Notice> | null;
  if (!d || typeof d.id !== "string" || !isNotifyKind(d.kind) || typeof d.title !== "string" || typeof d.text !== "string") return null;
  const t = (d.target ?? {}) as Record<string, unknown>;
  const target: NotifyTarget = {};
  for (const k of ["sessionId", "runId", "approvalId", "dialogId"] as const) if (typeof t[k] === "string") target[k] = t[k] as string;
  return {
    id: d.id,
    kind: d.kind,
    project: typeof d.project === "string" ? d.project : "",
    at: typeof d.at === "string" ? d.at : new Date().toISOString(),
    ...(typeof d.sessionId === "string" ? { sessionId: d.sessionId } : {}),
    ...(typeof d.sessionTitle === "string" ? { sessionTitle: d.sessionTitle } : {}),
    title: d.title,
    text: d.text,
    target,
    ...(Array.isArray(d.active) ? { active: d.active.filter((a): a is NotifyDevice => a === "desktop" || a === "browser" || a === "phone") } : {}),
  };
}

/** GET /v1/ext/studio/notifications */
export interface NotificationsState {
  project: string;
  prefs: ProjectNotifyPrefs;
  /** The latest notices, newest last, so a device opened from a push can find what it was about. */
  recent: Notice[];
  /** The muted sessions' titles, by id. */
  titles: Record<string, string>;
}

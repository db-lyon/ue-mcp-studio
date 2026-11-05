/**
 * Web Push for a paired browser: the relay's service worker holds a push
 * subscription, and the relay sends it the kind and project of each notice
 * while this tab is closed. The relay signs with its own VAPID key; nothing
 * here needs an account. The rules the relay applies (which events, muted
 * projects, quiet hours) are this browser's settings, sent with the
 * subscription. Only on a paired browser, where the page is at the relay's origin.
 */
import { NOTIFY_KINDS, type DeviceNotifyPrefs, type NotifyKind, type ProjectNotifyPrefs } from "@ue-mcp-studio/shared";

/** What the relay filters a push by. Nothing in it is content. */
export interface PushPrefs {
  enabled: boolean;
  kinds: NotifyKind[];
  /** Project names (or relay project ids) muted on this device. */
  muted: string[];
  quiet: DeviceNotifyPrefs["quiet"];
  /** IANA time zone, for quiet hours. */
  tz: string;
  onlyWhenAway: boolean;
}

export function pushPrefs(device: DeviceNotifyPrefs, project: ProjectNotifyPrefs, tz = Intl.DateTimeFormat().resolvedOptions().timeZone): PushPrefs {
  return {
    enabled: device.enabled,
    kinds: NOTIFY_KINDS.filter((k) => project.events[k.kind]).map((k) => k.kind),
    muted: device.mutedProjects,
    quiet: device.quiet,
    tz: tz || "UTC",
    onlyWhenAway: device.onlyWhenAway,
  };
}

export function base64UrlBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export type WebPushResult = "registered" | "unsupported" | "off" | "failed";

/** Subscribe (once) and send the relay this browser's subscription and rules. */
export async function syncWebPush(device: DeviceNotifyPrefs, project: ProjectNotifyPrefs, f: typeof fetch = fetch): Promise<WebPushResult> {
  if (typeof navigator === "undefined" || !navigator.serviceWorker || typeof PushManager === "undefined") return "unsupported";
  const cfg = (await f("/api/push/config", { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null), () => null)) as { vapidPublicKey?: string | null } | null;
  if (!cfg?.vapidPublicKey) return "off";
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return "unsupported";
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlBytes(cfg.vapidPublicKey) as BufferSource }));
  const res = await f("/api/push/register", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ platform: "web", subscription: sub.toJSON(), prefs: pushPrefs(device, project) }),
  });
  return res.ok ? "registered" : "failed";
}

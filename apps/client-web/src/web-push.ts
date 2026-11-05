/**
 * Web Push for a paired browser: the relay's service worker holds a push
 * subscription, and the relay sends it the kind and project of each notice
 * while this tab is closed. The relay signs with its own VAPID key; nothing
 * here needs an account. The rules the relay applies (which events, muted
 * projects, quiet hours) are this browser's settings, sent with the
 * subscription. Only on a paired browser, where the page is at the relay's origin.
 */
import type { DeviceNotifyPrefs, ProjectNotifyPrefs } from "@ue-mcp-studio/shared";
import { pushPrefsFor } from "@ue-mcp-studio/client-core";

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
    body: JSON.stringify({ platform: "web", subscription: sub.toJSON(), prefs: pushPrefsFor(device, project) }),
  });
  return res.ok ? "registered" : "failed";
}

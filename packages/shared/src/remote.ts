/**
 * Remote control as the agent reports it at /v1/ext/studio/remote. It works
 * while the signed-in account has a paid plan; its routes answer 404
 * otherwise. With STUDIO_PLAN_AVAILABLE on, a free account is told it exists
 * (Settings and /remote); with it off, a free account never sees it.
 */

/** What Studio says when the account's plan does not include remote control. */
export const REMOTE_NO_PLAN = "Remote control needs a Pro or Studio plan on this account.";

/** GET /remote/available: whether this account may use remote control now (a paid plan). */
export interface RemoteAvailability {
  available: boolean;
}

/** Where a free account reads about the plans remote control needs. */
export const STUDIO_PLAN_URL = "https://ue-mcp.com/pricing";

/** The one line on what remote control does. */
export const REMOTE_SUMMARY = "Use this project from your phone or another computer.";

/** What /remote answers a free account in the chat, before the plan link. */
export const REMOTE_COMMAND_REPLY = "Remote control lets you use this project from your phone. It needs a Pro or Studio plan.";

/**
 * What remote control shows this account: the working thing on a paid plan,
 * the plan note to a free account while the plan is offered, nothing otherwise.
 * Null `paid` is not yet known: "pending" while the plan is offered (the
 * section is listed either way), "hidden" while it is not.
 */
export type RemoteSurface = "working" | "upsell" | "pending" | "hidden";
export function remoteSurface(planOffered: boolean, paid: boolean | null): RemoteSurface {
  if (paid) return "working";
  if (!planOffered) return "hidden";
  return paid === null ? "pending" : "upsell";
}

/**
 * Why the connector is not online, when the reason is one the UI words itself.
 * "no-plan": the relay refused the upgrade with 403 or dropped the socket with
 * close code 4003, so this account's plan does not include remote control.
 */
export type RemoteRefusal = "no-plan" | "signed-out" | "other-account";

export type RemoteConnection =
  | { state: "off" }
  | { state: "connecting"; attempt: number; reason?: string }
  | { state: "online"; login: string; since: string }
  | { state: "error"; reason: string; code?: RemoteRefusal };

/** GET /remote/status and PUT /remote/config. */
export type RemoteStatus = RemoteConnection & { enabled: boolean; relay: string };

/** A browser paired with this computer: GET /remote/browsers. */
export interface RemoteBrowser {
  id: string;
  label: string;
  addedAt: string;
}

/** POST /remote/pair: the link to open on the device, and the same link as a QR code. */
export interface RemotePairing {
  url: string;
  expiresAt?: string;
  svg: string;
}

/** A refused remote route: the message, and the refusal the UI words itself when there is one. */
export interface RemoteError {
  error: string;
  code?: RemoteRefusal;
}

/**
 * Remote control as the agent reports it at /v1/ext/studio/remote. Available
 * while STUDIO_PLAN_AVAILABLE is on or the signed-in account has a paid plan;
 * hidden, routes included, otherwise.
 */

/** What Studio says when the account's plan does not include remote control. */
export const REMOTE_NO_PLAN = "Remote control needs a Pro or Studio plan on this account.";

/** GET /remote/available: whether remote control is offered to this account now. */
export interface RemoteAvailability {
  available: boolean;
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

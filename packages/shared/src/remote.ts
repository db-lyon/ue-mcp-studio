/**
 * Remote control as the agent reports it at /v1/ext/studio/remote. Hidden,
 * routes included, while STUDIO_PLAN_AVAILABLE is off.
 */

/**
 * Why the connector is not online, when the reason is one the UI words itself.
 * "no-plan": the relay answered 403, so this account's plan does not include remote control.
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

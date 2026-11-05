/**
 * Remote control as the agent reports it at /v1/ext/studio/remote. It works
 * while the signed-in account has a paid plan; its routes answer 404
 * otherwise. With STUDIO_PLAN_AVAILABLE on, a signed-out or free account is
 * told it exists (Settings and /remote); with it off, neither ever sees it.
 */

/** What Studio says when the account's plan does not include remote control. */
export const REMOTE_NO_PLAN = "Remote control needs a Pro or Studio plan on this account.";

/** What the connector says when the relay no longer accepts the account's token. */
export const REMOTE_SIGN_IN_AGAIN = "The relay did not accept this account. Sign in to your ue-mcp account again in Settings > General.";

/**
 * GET /remote/available: whether this account may use remote control now (a
 * paid plan), and whether any ue-mcp account is signed in. An agent from
 * before 0.1.25-beta.6 leaves `signedIn` out.
 */
export interface RemoteAvailability {
  available: boolean;
  signedIn?: boolean;
}

/** Where a free account reads about the plans remote control needs. */
export const STUDIO_PLAN_URL = "https://ue-mcp.com/pricing";

/** The one line on what remote control does. */
export const REMOTE_SUMMARY = "Use this project from your phone or another computer.";

/** What /remote answers a signed-in account without a paid plan in the chat, above the Upgrade action. */
export const REMOTE_COMMAND_REPLY = "Remote control lets you use this project from your phone. It needs a Pro or Studio plan.";

/**
 * What remote control shows this account: the working thing on a paid plan;
 * while the plan is offered, a sign-in to a signed-out computer and the plan
 * note to a free account; nothing otherwise. Null `paid` is not yet known:
 * "pending" while the plan is offered (the section is listed either way),
 * "hidden" while it is not. `signedIn` left out reads as signed in.
 */
export type RemoteSurface = "working" | "signin" | "upsell" | "pending" | "hidden";
export function remoteSurface(planOffered: boolean, paid: boolean | null, signedIn = true): RemoteSurface {
  if (paid) return "working";
  if (!planOffered) return "hidden";
  if (paid === null) return "pending";
  return signedIn ? "upsell" : "signin";
}

/** Whether Settings lists remote control, and the slash menu lists /remote. */
export const remoteShown = (s: RemoteSurface): boolean => s === "working" || s === "signin" || s === "upsell";

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

/**
 * A browser that scanned a pairing code and waits for the owner to allow it:
 * GET /remote/approvals, answered with POST /remote/approvals/:id { allow }.
 * The browser shows the same six-digit code; one that does not match is not
 * the owner's. Event studio.remote.approval when one arrives, and
 * studio.remote.paired { label } once a browser is allowed.
 */
export interface RemoteApproval {
  id: string;
  label: string;
  code: string;
  expiresAt: string;
  /** This project's name, for "<label> wants to control <project>". */
  project: string;
}

/** Idle times, in minutes, after which a whole-client PIN lock closes a paired browser again. */
export const REMOTE_LOCK_IDLE_CHOICES: readonly number[] = [5, 15, 60];
export const REMOTE_LOCK_IDLE_DEFAULT = 15;
/** Wrong PINs in a row that remove a paired browser. */
export const REMOTE_PIN_ATTEMPTS = 10;

/**
 * The remote PIN lock as Settings on the computer shows it: GET /remote/lock,
 * PUT /remote/lock { whole?, sensitive?, idleMinutes?, current? }, PUT
 * /remote/lock/pin { pin, confirm?, current? }, DELETE /remote/lock/pin
 * { current }, POST /remote/lock/forget (unpairs every device). Weakening the
 * lock needs `current`, the PIN. Off until a PIN is set and a switch is on.
 */
export interface RemoteLockSettings {
  /** A PIN is set. */
  pin: boolean;
  /** A paired browser needs the PIN to open Studio, and again after it sits idle. */
  whole: boolean;
  /** A paired browser needs the PIN for sensitive actions. */
  sensitive: boolean;
  idleMinutes: number;
}

/**
 * The lock as a paired browser sees it: GET /v1/ext/studio/lock, answered by
 * the computer. POST .../lock/unlock { pin }, .../lock/touch, .../lock/lock.
 * A refused request answers 423 with `code` "locked" (the whole client) or
 * "pin-required" (a sensitive action).
 */
export interface RemoteLockState {
  whole: boolean;
  sensitive: boolean;
  /** The whole client is locked: only the lock screen works. */
  locked: boolean;
  /** Sensitive actions run without asking for the PIN right now. */
  sensitiveOpen: boolean;
  idleMinutes: number;
  /** Wrong PINs left before this browser is removed, once one was wrong. */
  remaining?: number;
  /** Wait this long before the next try. */
  retryAfterMs?: number;
  /** How many digits the PIN has, so the keypad submits on the last one. Unknown for a PIN set before this was kept, until it is next entered right. */
  pinLength?: number;
}

/** A 423 from the computer: why the PIN is asked for. */
export type RemoteLockCode = "locked" | "pin-required";

/** "123456" as "123 456", the way Studio and the paired device both show it. */
export function formatPairingCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
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

/**
 * What /remote does when typed: "open" opens Settings > Remote control (a
 * paid plan, or a signed-out computer while the plan is offered, whose
 * section holds the sign-in); "upgrade" answers in the chat with the Upgrade
 * action, for any signed-in account without a paid plan whatever the flag
 * says; null leaves it an ordinary message. Null `paid` is not yet known.
 */
export type RemoteCommandAction = "open" | "upgrade" | null;
export function remoteCommand(planOffered: boolean, paid: boolean | null, signedIn = true): RemoteCommandAction {
  if (paid) return "open";
  if (paid === null) return null;
  if (!signedIn) return planOffered ? "open" : null;
  return "upgrade";
}

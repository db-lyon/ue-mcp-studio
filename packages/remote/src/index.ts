/**
 * Remote control: a paired browser's requests reach one project's daemon over
 * the WebSocket that project's connector opened to the relay, sealed end to end
 * (see ./e2e.ts) so the relay carries only ciphertext. This is the wire between
 * the relay and the connector, and the rule for which daemon paths a remote
 * browser may reach.
 */

export * from "./e2e.js";

/**
 * Relay to connector. A call's body is opaque to the relay: a SealedRequest for
 * "sealed", an EnrollRequest for "enroll".
 */
export type RelayFrame =
  /**
   * `binary`: this relay reads chunks as binary frames (encodeChunk); an older relay leaves it out and gets base64 `chunk` frames.
   * `push`: this relay takes `notify` frames and pushes them to the account's devices.
   */
  | { t: "hello"; deviceId: string; login: string; binary?: boolean; acks?: boolean; push?: boolean }
  | { t: "call"; id: string; kind: "sealed" | "enroll"; body: string }
  | { t: "abort"; id: string }
  /** `acks`: bytes this relay has read from the connector so far, so it keeps only a small window unread on the way. */
  | { t: "ack"; n: number };

/** A browser presenting its public key, with proof it read the computer's pairing code. */
export interface EnrollRequest {
  phonePublic: string;
  mac: string;
  label: string;
}

/** A browser asking again how the owner answered its enrollment. */
export interface EnrollPoll {
  poll: string;
}

/**
 * The computer's answer to an enrollment the owner has not decided yet: HTTP
 * 202 with this. The browser asks again with EnrollPoll until a 200 (allowed)
 * or a refusal (denied, or no answer by expiresAt).
 */
export interface EnrollPending {
  approval: string;
  expiresAt: string;
}

/** Connector to relay. Chunk data is base64; for a sealed call it is response frames. */
export type ConnectorFrame =
  | { t: "head"; id: string; status: number; headers: Record<string, string> }
  | { t: "chunk"; id: string; data: string }
  | { t: "end"; id: string }
  | { t: "fail"; id: string; status: number; error: string }
  | NotifyFrame;

/**
 * A notification for the account's devices that are away (push). Phase A: the
 * relay sees only the event kind, and names the project itself from the
 * connection; `desktop` says the Studio window is in use, so a device set to
 * "only when I'm away" is skipped. The text stays on the computer.
 */
export interface NotifyFrame {
  t: "notify";
  kind: string;
  desktop?: boolean;
}

/** Headers the connector sends with every WebSocket upgrade. */
export const DEVICE_HEADER = "x-ue-mcp-device";
export const DEVICE_NAME_HEADER = "x-ue-mcp-device-name";
/** The computer's public key, which browsers check against the one their pairing code carried. */
export const COMPUTER_KEY_HEADER = "x-ue-mcp-computer-key";
export const CONNECTOR_PATH = "/connect";

/** The largest request body a remote browser may send, before sealing. */
export const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

/** Request headers a browser's request carries to the daemon. Credentials, cookies and origin never do. */
export const FORWARDED_REQUEST_HEADERS = ["accept", "content-type", "last-event-id"] as const;
/** Response headers the daemon's response carries back. */
export const FORWARDED_RESPONSE_HEADERS = ["content-type", "cache-control", "content-disposition", "etag", "last-modified"] as const;

const ALLOW: Array<{ methods: string[] | "any"; path: RegExp }> = [
  { methods: ["GET"], path: /^\/ui(\/.*)?$/ },
  { methods: ["GET"], path: /^\/v1\/(health|events|install|update)$/ },
  // The Plugins tab, read only: the installed list and the registry's catalog. Install, update and remove stay on the computer.
  { methods: ["GET"], path: /^\/v1\/plugins(\/catalog)?$/ },
  { methods: ["POST"], path: /^\/v1\/editor\/(start|stop|restart|rebuild)$/ },
  { methods: "any", path: /^\/v1\/flows(\/.*)?$/ },
  { methods: "any", path: /^\/v1\/ext\/studio(\/.*)?$/ },
];

/** Refused whatever ALLOW says: every method, or every method but those in `except`. */
const DENY: Array<{ path: RegExp; except?: string[] }> = [
  // Opens a window on the machine, which nobody remote can see.
  { path: /^\/v1\/ext\/studio\/window(\/.*)?$/i },
  // Remote control itself: a paired browser may not pair others, turn it off or revoke anyone.
  { path: /^\/v1\/ext\/studio\/remote(\/.*)?$/i },
  // Updates install and restart software on the computer. A paired browser may read their status (GET /updates, /updates/run), nothing else.
  { path: /^\/v1\/ext\/studio\/updates\/(?!run\/?$).+$/i },
  { path: /^\/v1\/ext\/studio\/updates(\/run)?\/?$/i, except: ["GET"] },
  // Installing ue-mcp when Studio refused an older one, and moving to a Studio another project installed.
  { path: /^\/v1\/ext\/studio\/refusal\/update\/?$/i },
  { path: /^\/v1\/ext\/studio\/version-notice\/update\/?$/i },
  // Where prompts go and what ue-mcp runs: model endpoints, vendor sign-ins, ue-mcp.yml and its context strategy. Reading them stays allowed.
  { path: /^\/v1\/ext\/studio\/endpoints(\/.*)?$/i, except: ["GET"] },
  { path: /^\/v1\/ext\/studio\/signin(\/.*)?$/i, except: ["GET"] },
  { path: /^\/v1\/ext\/studio\/config\/?$/i, except: ["GET"] },
  { path: /^\/v1\/ext\/studio\/context-strategy\/?$/i, except: ["GET"] },
  // The computer's own notification settings: a paired browser keeps its own.
  { path: /^\/v1\/ext\/studio\/notifications\/desktop\/?$/i },
];

/**
 * Settings fields a paired browser may not change through PUT /v1/ext/studio/settings:
 * where prompts and the account token go (the gateway), API keys, signing out, and
 * what runs without asking (approvals, the old ask switch, the editor dialog policy).
 * Model, effort, theme and the other everyday choices stay changeable.
 */
export const REMOTE_REFUSED_SETTINGS = ["gatewayUrl", "keys", "signOut", "approvals", "askBeforeChanges", "dialogPolicy"] as const;

/**
 * Whether a request remotePath allowed may carry this body from a paired browser.
 * Checks only PUT /v1/ext/studio/settings, the one route that mixes everyday and
 * guarded fields; a body that is not a JSON object there is refused.
 */
export function remoteBodyAllowed(method: string, pathname: string, body: Uint8Array | undefined): boolean {
  if (method.toUpperCase() !== "PUT" || !/^\/v1\/ext\/studio\/settings\/?$/i.test(pathname)) return true;
  let value: unknown;
  try {
    value = JSON.parse(body ? new TextDecoder().decode(body) : "{}");
  } catch {
    return false;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return !Object.keys(value).some((k) => (REMOTE_REFUSED_SETTINGS as readonly string[]).includes(k));
}

/**
 * The daemon path a remote browser may send `method rawPath` to, normalized the
 * way the daemon's URL parser will read it, or null when it is refused. Forward
 * the returned path, never the raw one. The connector enforces this on the
 * computer, after opening the sealed request. Never reachable: the MCP
 * endpoint, shutdown and handoff, applying or starting any update (ue-mcp, Studio, the editor plugin,
 * the update channel), installing, updating or removing plugins, changing model endpoints, sign-ins,
 * ue-mcp.yml or its context strategy, Studio's window and remote-control routes, and any extension
 * other than Studio. remoteBodyAllowed guards the settings fields a browser may not change.
 */
export function remotePath(method: string, rawPath: string): string | null {
  if (!rawPath.startsWith("/") || !encodedPartsSafe(rawPath)) return null;
  let url: URL;
  try {
    url = new URL(rawPath, "http://daemon.invalid");
  } catch {
    return null;
  }
  if (url.host !== "daemon.invalid") return null;
  const pathname = url.pathname;
  const m = method.toUpperCase();
  // Denied by the raw path and by the decoded one, so an encoded slash cannot spell a denied route.
  const decoded = safeDecode(pathname);
  if (decoded === null || pathname.includes("//") || DENY.some((d) => !d.except?.includes(m) && (d.path.test(pathname) || d.path.test(decoded)))) return null;
  if (!ALLOW.some((a) => (a.methods === "any" || a.methods.includes(m)) && a.path.test(pathname))) return null;
  return pathname + url.search;
}

/** decodeURIComponent, or null for a malformed escape. */
function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/** A `.` or `..` step in a decoded path. */
const DOT_STEP = /(^|\/)\.\.?(\/|$)/;

/**
 * Whether a request's encoded parts are data, not a way around the path rules.
 * Ids and paths travel as one encoded path segment or query value (a playtest
 * run id such as `draft:/Game/Scripts/TS_Door`, a changed file such as
 * `Content/Props/Door.uasset`), so an encoded slash is allowed there; the
 * daemon splits routes on raw slashes and decodes each parameter after.
 * Refused: a backslash or NUL anywhere, an encoded dot or backslash in the
 * path, and a segment or query value that decodes to a `.` or `..` step.
 */
function encodedPartsSafe(rawPath: string): boolean {
  const q = rawPath.indexOf("?");
  const rawPathname = q < 0 ? rawPath : rawPath.slice(0, q);
  const query = q < 0 ? "" : rawPath.slice(q + 1);
  if (/\\|%00|%5c/i.test(rawPath) || /%2e/i.test(rawPathname)) return false;
  for (const seg of rawPathname.split("/")) {
    if (!/%2f/i.test(seg)) continue;
    const d = safeDecode(seg);
    if (d === null || DOT_STEP.test(d)) return false;
  }
  for (const pair of query ? query.split("&") : []) {
    const d = safeDecode(pair.replace(/\+/g, " "));
    if (d === null || d.includes("\0") || d.includes("\\") || DOT_STEP.test(d.slice(d.indexOf("=") + 1))) return false;
  }
  return true;
}

/** A binary chunk frame: this tag byte, the call id's length, the id, then the bytes. */
const BINARY_CHUNK = 1;

/** One response chunk as a binary WebSocket frame, without base64's third more bytes. */
export function encodeChunk(id: string, bytes: Uint8Array): Uint8Array {
  const idBytes = new TextEncoder().encode(id);
  if (idBytes.byteLength > 255) throw new Error("call id too long");
  const out = new Uint8Array(2 + idBytes.byteLength + bytes.byteLength);
  out[0] = BINARY_CHUNK;
  out[1] = idBytes.byteLength;
  out.set(idBytes, 2);
  out.set(bytes, 2 + idBytes.byteLength);
  return out;
}

/** A binary frame back into its call id and bytes, or null when it is not one. */
export function decodeChunk(frame: Uint8Array): { id: string; data: Uint8Array } | null {
  if (frame.byteLength < 2 || frame[0] !== BINARY_CHUNK) return null;
  const n = frame[1];
  if (frame.byteLength < 2 + n) return null;
  return { id: new TextDecoder().decode(frame.subarray(2, 2 + n)), data: frame.subarray(2 + n) };
}

/** What a browser's request says it can open: `gzip` lets the computer compress the body before sealing it. */
export const ACCEPT_GZIP = "gzip";

export function parseFrame<T>(data: unknown): T | null {
  try {
    const parsed = JSON.parse(String(data)) as { t?: unknown };
    return parsed && typeof parsed.t === "string" ? (parsed as T) : null;
  } catch {
    return null;
  }
}

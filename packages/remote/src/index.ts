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
  /** `binary`: this relay reads chunks as binary frames (encodeChunk); an older relay leaves it out and gets base64 `chunk` frames. */
  | { t: "hello"; deviceId: string; login: string; binary?: boolean }
  | { t: "call"; id: string; kind: "sealed" | "enroll"; body: string }
  | { t: "abort"; id: string };

/** A browser presenting its public key, with proof it read the computer's pairing code. */
export interface EnrollRequest {
  phonePublic: string;
  mac: string;
  label: string;
}

/** Connector to relay. Chunk data is base64; for a sealed call it is response frames. */
export type ConnectorFrame =
  | { t: "head"; id: string; status: number; headers: Record<string, string> }
  | { t: "chunk"; id: string; data: string }
  | { t: "end"; id: string }
  | { t: "fail"; id: string; status: number; error: string };

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
  { methods: ["POST"], path: /^\/v1\/editor\/(start|stop|restart|rebuild)$/ },
  { methods: "any", path: /^\/v1\/flows(\/.*)?$/ },
  { methods: "any", path: /^\/v1\/ext\/studio(\/.*)?$/ },
];

const DENY: RegExp[] = [
  // Opens a window on the machine, which nobody remote can see.
  /^\/v1\/ext\/studio\/window(\/.*)?$/i,
  // Remote control itself: a paired browser may not pair others, turn it off or revoke anyone.
  /^\/v1\/ext\/studio\/remote(\/.*)?$/i,
];

/**
 * The daemon path a remote browser may send `method rawPath` to, normalized the
 * way the daemon's URL parser will read it, or null when it is refused. Forward
 * the returned path, never the raw one. The connector enforces this on the
 * computer, after opening the sealed request. Never reachable: the MCP
 * endpoint, shutdown and handoff, applying updates, plugin installs, Studio's
 * window and remote-control routes, and any extension other than Studio.
 */
export function remotePath(method: string, rawPath: string): string | null {
  if (!rawPath.startsWith("/") || /\\|%2e|%2f|%5c/i.test(rawPath)) return null;
  let url: URL;
  try {
    url = new URL(rawPath, "http://daemon.invalid");
  } catch {
    return null;
  }
  if (url.host !== "daemon.invalid") return null;
  const pathname = url.pathname;
  if (pathname.includes("//") || DENY.some((d) => d.test(pathname))) return null;
  const m = method.toUpperCase();
  if (!ALLOW.some((a) => (a.methods === "any" || a.methods.includes(m)) && a.path.test(pathname))) return null;
  return pathname + url.search;
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

/**
 * End-to-end encryption between a paired browser and a computer's remote
 * extension. The relay carries only what this module seals.
 *
 * Keys: each side holds a P-256 ECDH key pair. Their shared secret, with a
 * fresh random salt per request, goes through HKDF-SHA256 to one AES-256-GCM
 * key for the request and another for its response.
 *
 * Pairing authenticates both public keys outside the relay: the QR code (its
 * URL fragment, which browsers never send) carries the computer's public key
 * and a one-time secret, and the browser proves its own public key with an
 * HMAC under that secret.
 *
 * A response is a stream of frames, each [4-byte length][1-byte kind][ciphertext],
 * with the frame's sequence number in its nonce and, with the kind, in its
 * additional data, and a final frame
 * that closes it, so the relay cannot reorder, drop or cut a response short
 * without the browser noticing.
 *
 * Runs unchanged in browsers, service workers and Node 20+ (WebCrypto).
 */

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const E2E_VERSION = 1;
/** How far a request's timestamp may be from the computer's clock. */
export const MAX_SKEW_MS = 2 * 60_000;
/** How long a pairing code shown on the computer stays redeemable. */
export const PAIR_SECRET_TTL_MS = 10 * 60_000;

export type Bytes = Uint8Array<ArrayBuffer>;

export function b64u(bytes: Bytes): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64u(s: string): Bytes {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function randomBytes(n: number): Bytes {
  return globalThis.crypto.getRandomValues(new Uint8Array(new ArrayBuffer(n)));
}

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

/** A new key pair. The private key is not extractable unless asked, so a browser can keep it in IndexedDB as is. */
export async function generateKeyPair(extractable = false): Promise<CryptoKeyPair> {
  return (await subtle.generateKey(ECDH, extractable, ["deriveBits"])) as CryptoKeyPair;
}

export async function exportPublic(key: CryptoKey): Promise<string> {
  return b64u(new Uint8Array(await subtle.exportKey("raw", key)));
}

export async function importPublic(raw: string): Promise<CryptoKey> {
  const bytes = unb64u(raw);
  if (bytes.length !== 65 || bytes[0] !== 4) throw new Error("not a P-256 public key");
  return subtle.importKey("raw", bytes, ECDH, true, []);
}

export async function exportPrivateJwk(key: CryptoKey): Promise<JsonWebKey> {
  return subtle.exportKey("jwk", key);
}

export async function importPrivateJwk(jwk: JsonWebKey): Promise<CryptoKey> {
  return subtle.importKey("jwk", jwk, ECDH, false, ["deriveBits"]);
}

/** A short id for a public key: the first 16 bytes of its SHA-256, base64url. */
export async function keyId(publicRaw: string): Promise<string> {
  return b64u(new Uint8Array(await subtle.digest("SHA-256", unb64u(publicRaw))).slice(0, 16));
}

/** The ECDH secret two parties share, imported as HKDF input. Derive once per peer and reuse. */
export async function sharedSecret(own: CryptoKey, peerPublicRaw: string): Promise<CryptoKey> {
  const bits = await subtle.deriveBits({ name: "ECDH", public: await importPublic(peerPublicRaw) }, own, 256);
  return subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
}

async function aesKey(secret: CryptoKey, salt: Bytes, info: string): Promise<CryptoKey> {
  return subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: enc.encode(`uemcp-remote/v${E2E_VERSION}/${info}`) }, secret, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

// ── Pairing ─────────────────────────────────────────────────────

/** Proof that `phonePublic` came from whoever read the QR code holding `secret`. */
export async function pairingMac(secret: string, phonePublic: string, computerPublic: string): Promise<string> {
  const key = await subtle.importKey("raw", unb64u(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(new Uint8Array(await subtle.sign("HMAC", key, concat(enc.encode("uemcp-remote/pair/"), unb64u(phonePublic), unb64u(computerPublic)))));
}

export async function verifyPairingMac(secret: string, phonePublic: string, computerPublic: string, mac: string): Promise<boolean> {
  const key = await subtle.importKey("raw", unb64u(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  try {
    return await subtle.verify("HMAC", key, unb64u(mac), concat(enc.encode("uemcp-remote/pair/"), unb64u(phonePublic), unb64u(computerPublic)));
  } catch {
    return false;
  }
}

/** How long a browser waits for the owner to allow it on the computer. */
export const PAIR_APPROVAL_TTL_MS = 2 * 60_000;

/**
 * The six digits both screens show while the owner decides whether to allow a
 * browser: derived from the code's secret and the browser's key, so a browser
 * that is not the owner's shows a different number than the computer does.
 */
export async function pairingCode(secret: string, phonePublic: string): Promise<string> {
  const key = await subtle.importKey("raw", unb64u(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await subtle.sign("HMAC", key, concat(enc.encode("uemcp-remote/pair-code/"), unb64u(phonePublic))));
  const n = ((mac[0] << 24) | (mac[1] << 16) | (mac[2] << 8) | mac[3]) >>> 0;
  return String(n % 1_000_000).padStart(6, "0");
}

/** "123456" as "123 456", the way both screens show it. */
export function formatPairingCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

/** The pairing link's fragment: relay code, computer public key, one-time secret. */
export function pairingFragment(code: string, computerPublic: string, secret: string): string {
  return `${code}.${computerPublic}.${secret}`;
}

export function parsePairingFragment(fragment: string): { code: string; computerPublic: string; secret: string } | null {
  const [code, computerPublic, secret, extra] = fragment.replace(/^#/, "").split(".");
  if (!code || !computerPublic || !secret || extra !== undefined) return null;
  return { code, computerPublic, secret };
}

// ── Requests ────────────────────────────────────────────────────

export interface PlainRequest {
  /** Unique per request; the computer refuses one it has seen. */
  id: string;
  ts: number;
  /** The project the browser meant; the computer refuses a request routed to another. */
  device: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
  /** Encodings this browser opens itself (["gzip"]); a body sent compressed says so in its head's content-encoding. */
  accept?: string[];
}

/** What crosses the relay for one request. */
export interface SealedRequest {
  v: number;
  phone: string;
  salt: string;
  nonce: string;
  ct: string;
}

export async function sealRequest(secret: CryptoKey, phoneId: string, req: PlainRequest): Promise<{ sealed: SealedRequest; responseKey: CryptoKey }> {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = await aesKey(secret, salt, "req");
  const ct = await subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: enc.encode(`req/${phoneId}`) }, key, enc.encode(JSON.stringify(req)));
  return {
    sealed: { v: E2E_VERSION, phone: phoneId, salt: b64u(salt), nonce: b64u(nonce), ct: b64u(new Uint8Array(ct)) },
    responseKey: await aesKey(secret, salt, "res"),
  };
}

/** Null when it does not decrypt under this secret: tampered, or not from this phone. */
export async function openRequest(secret: CryptoKey, sealed: SealedRequest): Promise<{ req: PlainRequest; responseKey: CryptoKey } | null> {
  if (sealed.v !== E2E_VERSION) return null;
  try {
    const salt = unb64u(sealed.salt);
    const key = await aesKey(secret, salt, "req");
    const pt = await subtle.decrypt({ name: "AES-GCM", iv: unb64u(sealed.nonce), additionalData: enc.encode(`req/${sealed.phone}`) }, key, unb64u(sealed.ct));
    const req = JSON.parse(dec.decode(pt)) as PlainRequest;
    if (typeof req.id !== "string" || typeof req.ts !== "number" || typeof req.device !== "string" || typeof req.method !== "string" || typeof req.path !== "string") return null;
    return { req, responseKey: await aesKey(secret, salt, "res") };
  } catch {
    return null;
  }
}

/** Remembers request ids for the skew window, so a captured request cannot be sent again. */
export class ReplayGuard {
  private readonly seen = new Map<string, number>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** True the first time `id` is offered within the window with a fresh timestamp. */
  accept(id: string, ts: number): boolean {
    const now = this.now();
    if (Math.abs(now - ts) > MAX_SKEW_MS) return false;
    for (const [k, at] of this.seen) {
      if (now - at <= MAX_SKEW_MS * 2) break;
      this.seen.delete(k);
    }
    if (this.seen.has(id)) return false;
    this.seen.set(id, now);
    return true;
  }
}

// ── Responses ───────────────────────────────────────────────────

export interface ResponseHead {
  status: number;
  headers: Record<string, string>;
}

function frameNonce(seq: number): Bytes {
  const n = new Uint8Array(12);
  new DataView(n.buffer).setUint32(8, seq);
  new DataView(n.buffer).setUint32(4, Math.floor(seq / 2 ** 32));
  return n;
}

/** Seals a response as frames: the head, the body chunks, then the final frame. */
export class ResponseSealer {
  private seq = 0;

  constructor(private readonly key: CryptoKey) {}

  private async frame(kind: "h" | "d" | "f", payload: Bytes): Promise<Bytes> {
    const seq = this.seq++;
    const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: frameNonce(seq), additionalData: enc.encode(`res/${seq}/${kind}`) }, this.key, payload));
    const out = new Uint8Array(5 + ct.length);
    new DataView(out.buffer).setUint32(0, ct.length);
    out[4] = kind.charCodeAt(0);
    out.set(ct, 5);
    return out;
  }

  head(h: ResponseHead): Promise<Bytes> {
    return this.frame("h", enc.encode(JSON.stringify(h)));
  }

  data(chunk: Uint8Array): Promise<Bytes> {
    return this.frame("d", new Uint8Array(chunk));
  }

  final(): Promise<Bytes> {
    return this.frame("f", new Uint8Array(0));
  }
}

export type OpenedFrame = { kind: "head"; head: ResponseHead } | { kind: "data"; data: Bytes } | { kind: "final" };

/**
 * Reads frames back out of the byte stream the relay delivers, in order. Throws
 * on any frame that does not decrypt as the next one expected.
 */
export class ResponseOpener {
  private seq = 0;
  private buf: Bytes = new Uint8Array(0);
  private done = false;

  constructor(private readonly key: CryptoKey) {}

  get finished(): boolean {
    return this.done;
  }

  async push(bytes: Uint8Array): Promise<OpenedFrame[]> {
    this.buf = concat(this.buf, bytes);
    const out: OpenedFrame[] = [];
    while (this.buf.length >= 5) {
      const len = new DataView(this.buf.buffer, this.buf.byteOffset).getUint32(0);
      if (len > 32 * 1024 * 1024) throw new Error("response frame too large");
      if (this.buf.length < 5 + len) break;
      const kind = String.fromCharCode(this.buf[4]);
      const ct = this.buf.slice(5, 5 + len);
      this.buf = this.buf.slice(5 + len);
      if (this.done) throw new Error("data after the final response frame");
      const seq = this.seq++;
      let payload: Bytes;
      try {
        payload = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: frameNonce(seq), additionalData: enc.encode(`res/${seq}/${kind}`) }, this.key, ct));
      } catch {
        throw new Error("a response frame failed to decrypt");
      }
      if (seq === 0 && kind !== "h") throw new Error("response did not start with its head");
      if (kind === "h") {
        if (seq !== 0) throw new Error("a second response head");
        out.push({ kind: "head", head: JSON.parse(dec.decode(payload)) as ResponseHead });
      } else if (kind === "d") out.push({ kind: "data", data: payload });
      else {
        this.done = true;
        out.push({ kind: "final" });
      }
    }
    return out;
  }
}

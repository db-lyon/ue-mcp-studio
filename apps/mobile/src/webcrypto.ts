/**
 * The slice of WebCrypto that @ue-mcp-studio/remote uses, for Hermes, which has
 * no crypto.subtle: P-256 ECDH, SHA-256, HKDF-SHA256, HMAC-SHA256 and
 * AES-256-GCM, on the audited noble libraries. Installed on globalThis before
 * the remote package is imported, so the protocol code runs unchanged.
 */
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha256";
import { hmac } from "@noble/hashes/hmac";
import { hkdf } from "@noble/hashes/hkdf";
import { gcm } from "@noble/ciphers/aes";
import * as ExpoCrypto from "expo-crypto";

type Kind = "ecdh-private" | "ecdh-public" | "hkdf" | "hmac" | "aes-gcm";
interface Key {
  type: "private" | "public" | "secret";
  kind: Kind;
  bytes: Uint8Array;
  extractable: boolean;
  algorithm: unknown;
  usages: string[];
}

const algName = (a: unknown): string => (typeof a === "string" ? a : String((a as { name?: string })?.name ?? "")).toUpperCase();

function bytesOf(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return new Uint8Array(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  throw new TypeError("expected bytes");
}

const buf = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

function b64u(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64u(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const key = (k: Omit<Key, "usages"> & { usages?: string[] }): Key => ({ usages: [], ...k });

export const subtle = {
  async generateKey(algorithm: unknown, extractable: boolean, usages: string[]) {
    if (algName(algorithm) !== "ECDH") throw new Error("only ECDH P-256 is supported");
    const priv = p256.utils.randomPrivateKey();
    const pub = p256.getPublicKey(priv, false);
    return {
      privateKey: key({ type: "private", kind: "ecdh-private", bytes: priv, extractable, algorithm, usages }),
      publicKey: key({ type: "public", kind: "ecdh-public", bytes: pub, extractable: true, algorithm }),
    };
  },

  async exportKey(format: string, k: Key) {
    if (format === "raw" && k.kind === "ecdh-public") return buf(k.bytes);
    if (format === "jwk" && k.kind === "ecdh-private") {
      if (!k.extractable) throw new Error("key is not extractable");
      const pub = p256.getPublicKey(k.bytes, false);
      return { kty: "EC", crv: "P-256", d: b64u(k.bytes), x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33)), ext: true, key_ops: k.usages };
    }
    throw new Error(`exportKey ${format} is not supported for ${k.kind}`);
  },

  async importKey(format: string, data: unknown, algorithm: unknown, extractable: boolean, usages: string[]) {
    const name = algName(algorithm);
    if (format === "jwk") {
      const jwk = data as { d?: string; crv?: string };
      if (name !== "ECDH" || !jwk.d || jwk.crv !== "P-256") throw new Error("only P-256 private JWKs are supported");
      return key({ type: "private", kind: "ecdh-private", bytes: unb64u(jwk.d), extractable, algorithm, usages });
    }
    if (format !== "raw") throw new Error(`importKey ${format} is not supported`);
    const bytes = bytesOf(data);
    if (name === "ECDH") {
      p256.ProjectivePoint.fromHex(bytes).assertValidity();
      return key({ type: "public", kind: "ecdh-public", bytes, extractable: true, algorithm, usages });
    }
    if (name === "HKDF") return key({ type: "secret", kind: "hkdf", bytes, extractable: false, algorithm, usages });
    if (name === "HMAC") return key({ type: "secret", kind: "hmac", bytes, extractable, algorithm, usages });
    if (name === "AES-GCM") return key({ type: "secret", kind: "aes-gcm", bytes, extractable, algorithm, usages });
    throw new Error(`importKey ${name} is not supported`);
  },

  async deriveBits(algorithm: { name: string; public: Key }, k: Key, length: number) {
    if (algName(algorithm) !== "ECDH" || k.kind !== "ecdh-private") throw new Error("deriveBits supports ECDH only");
    const shared = p256.getSharedSecret(k.bytes, algorithm.public.bytes, true).slice(1);
    return buf(shared.slice(0, length / 8));
  },

  async deriveKey(algorithm: { name: string; salt: unknown; info: unknown }, k: Key, derived: { name: string; length: number }, extractable: boolean, usages: string[]) {
    if (algName(algorithm) !== "HKDF" || k.kind !== "hkdf") throw new Error("deriveKey supports HKDF only");
    if (algName(derived) !== "AES-GCM") throw new Error("deriveKey derives AES-GCM keys only");
    const bytes = hkdf(sha256, k.bytes, bytesOf(algorithm.salt), bytesOf(algorithm.info), derived.length / 8);
    return key({ type: "secret", kind: "aes-gcm", bytes, extractable, algorithm: derived, usages });
  },

  async digest(algorithm: unknown, data: unknown) {
    if (algName(algorithm) !== "SHA-256") throw new Error("digest supports SHA-256 only");
    return buf(sha256(bytesOf(data)));
  },

  async sign(_algorithm: unknown, k: Key, data: unknown) {
    if (k.kind !== "hmac") throw new Error("sign supports HMAC only");
    return buf(hmac(sha256, k.bytes, bytesOf(data)));
  },

  async verify(_algorithm: unknown, k: Key, signature: unknown, data: unknown) {
    if (k.kind !== "hmac") throw new Error("verify supports HMAC only");
    const want = hmac(sha256, k.bytes, bytesOf(data));
    const got = bytesOf(signature);
    if (got.length !== want.length) return false;
    let diff = 0;
    for (let i = 0; i < want.length; i++) diff |= want[i] ^ got[i];
    return diff === 0;
  },

  async encrypt(algorithm: { iv: unknown; additionalData?: unknown }, k: Key, data: unknown) {
    if (k.kind !== "aes-gcm") throw new Error("encrypt supports AES-GCM only");
    const aad = algorithm.additionalData === undefined ? undefined : bytesOf(algorithm.additionalData);
    return buf(gcm(k.bytes, bytesOf(algorithm.iv), aad).encrypt(bytesOf(data)));
  },

  async decrypt(algorithm: { iv: unknown; additionalData?: unknown }, k: Key, data: unknown) {
    if (k.kind !== "aes-gcm") throw new Error("decrypt supports AES-GCM only");
    const aad = algorithm.additionalData === undefined ? undefined : bytesOf(algorithm.additionalData);
    return buf(gcm(k.bytes, bytesOf(algorithm.iv), aad).decrypt(bytesOf(data)));
  },
};

const g = globalThis as unknown as { crypto?: Record<string, unknown> };
// Only where the platform has no WebCrypto of its own (Hermes); Node and browsers keep theirs.
if (!g.crypto?.subtle) {
  const existing = g.crypto ?? {};
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    enumerable: true,
    value: {
      getRandomValues: existing.getRandomValues ?? (<T extends ArrayBufferView>(a: T) => ExpoCrypto.getRandomValues(a as never) as T),
      randomUUID: existing.randomUUID ?? (() => ExpoCrypto.randomUUID()),
      subtle,
    },
  });
}

if (typeof globalThis.TextDecoder === "undefined") {
  class Utf8Decoder {
    decode(input?: ArrayBuffer | ArrayBufferView): string {
      if (!input) return "";
      const b = bytesOf(input);
      let out = "";
      for (let i = 0; i < b.length; ) {
        const c = b[i++];
        let cp: number;
        if (c < 0x80) cp = c;
        else if (c < 0xe0) cp = ((c & 0x1f) << 6) | (b[i++] & 0x3f);
        else if (c < 0xf0) cp = ((c & 0x0f) << 12) | ((b[i++] & 0x3f) << 6) | (b[i++] & 0x3f);
        else cp = ((c & 0x07) << 18) | ((b[i++] & 0x3f) << 12) | ((b[i++] & 0x3f) << 6) | (b[i++] & 0x3f);
        out += String.fromCodePoint(cp);
      }
      return out;
    }
  }
  (globalThis as unknown as { TextDecoder: unknown }).TextDecoder = Utf8Decoder;
}

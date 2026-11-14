/**
 * The app's WebCrypto shim against Node's real WebCrypto: a phone on the shim
 * pairs with and talks to a computer on the platform implementation, so the two
 * must agree byte for byte on every primitive the protocol uses.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-crypto", () => ({ getRandomValues: (a: Uint8Array<ArrayBuffer>) => globalThis.crypto.getRandomValues(a), randomUUID: () => globalThis.crypto.randomUUID() }));

const { subtle: shim, setNativeAes, NATIVE_AES_MIN_BYTES } = await import("../src/webcrypto");
type NativeAes = Parameters<typeof setNativeAes>[0] & object;
const real = globalThis.crypto.subtle;
const enc = new TextEncoder();

/** expo-crypto's AES-GCM as the platform does it (here Node's WebCrypto), counting the frames it opens; `wrong` flips a byte of what it opens. */
function platformAes(o: { wrong?: boolean; failAfter?: number } = {}) {
  let opened = 0;
  const aes: NativeAes = {
    AESEncryptionKey: { import: async (bytes) => real.importKey("raw", new Uint8Array(bytes), "AES-GCM", false, ["decrypt"]) },
    AESSealedData: { fromParts: (iv, data) => ({ iv: new Uint8Array(iv), data: new Uint8Array(data) }) },
    async aesDecryptAsync(sealed, key, options) {
      const s = sealed as { iv: Uint8Array<ArrayBuffer>; data: Uint8Array<ArrayBuffer> };
      if (o.failAfter !== undefined && opened >= o.failAfter) throw new Error("native AES failed");
      opened++;
      const out = new Uint8Array(await real.decrypt({ name: "AES-GCM", iv: s.iv, ...(options?.additionalData ? { additionalData: options.additionalData as Uint8Array<ArrayBuffer> } : {}) }, key as CryptoKey, s.data));
      if (o.wrong) out[0] ^= 1;
      return out;
    },
  };
  return { aes, opened: () => opened };
}

/** A frame the computer sealed with WebCrypto, and the shim's key for it. */
async function frame(size: number) {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const additionalData = enc.encode("res/1/d");
  const plain = crypto.getRandomValues(new Uint8Array(size));
  const ct = await real.encrypt({ name: "AES-GCM", iv, additionalData }, await real.importKey("raw", raw, "AES-GCM", false, ["encrypt"]), plain);
  const key = await shim.importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"]);
  return { plain, open: (data: ArrayBuffer = ct) => shim.decrypt({ iv, additionalData }, key, data) };
}

describe("opening response frames on the platform's AES-GCM", () => {
  afterEach(() => setNativeAes(null));

  it("opens a large frame there and a small one in noble, to the same bytes", async () => {
    const p = platformAes();
    setNativeAes(p.aes);
    const big = await frame(32 * 1024);
    expect(p.opened()).toBe(0);
    expect(new Uint8Array(await big.open())).toEqual(big.plain);
    const afterCheck = p.opened();
    expect(afterCheck).toBe(2);
    // With its 16-byte tag, still under the line.
    const small = await frame(NATIVE_AES_MIN_BYTES - 17);
    expect(new Uint8Array(await small.open())).toEqual(small.plain);
    expect(p.opened()).toBe(afterCheck);
  });

  it("keeps to noble when the platform's opens the self-check to other bytes", async () => {
    const p = platformAes({ wrong: true });
    setNativeAes(p.aes);
    const big = await frame(32 * 1024);
    expect(new Uint8Array(await big.open())).toEqual(big.plain);
    expect(p.opened()).toBe(1);
  });

  it("falls back to noble for good when the platform's fails on a frame noble opens", async () => {
    const p = platformAes({ failAfter: 1 });
    setNativeAes(p.aes);
    const a = await frame(32 * 1024);
    expect(new Uint8Array(await a.open())).toEqual(a.plain);
    const b = await frame(32 * 1024);
    expect(new Uint8Array(await b.open())).toEqual(b.plain);
    expect(p.opened()).toBe(1);
  });

  it("still refuses a frame that was tampered with", async () => {
    setNativeAes(platformAes().aes);
    const f = await frame(32 * 1024);
    const bad = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(1)));
    await expect(f.open(new Uint8Array([...bad, ...new Uint8Array(32 * 1024)]).buffer)).rejects.toThrow();
  });
});

describe("webcrypto shim", () => {
  it("agrees with WebCrypto on ECDH, HKDF and AES-GCM in both directions", async () => {
    const phone = await shim.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const computer = await real.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const phoneRaw = new Uint8Array((await shim.exportKey("raw", phone.publicKey)) as ArrayBuffer);
    const computerRaw = new Uint8Array(await real.exportKey("raw", computer.publicKey));

    const phoneBits = await shim.deriveBits({ name: "ECDH", public: await shim.importKey("raw", computerRaw, { name: "ECDH" }, true, []) } as never, phone.privateKey, 256);
    const realPhonePub = await real.importKey("raw", phoneRaw, { name: "ECDH", namedCurve: "P-256" }, true, []);
    const computerBits = await real.deriveBits({ name: "ECDH", public: realPhonePub }, computer.privateKey, 256);
    expect(new Uint8Array(phoneBits)).toEqual(new Uint8Array(computerBits));

    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const info = enc.encode("uemcp-remote/v1/req");
    const aad = enc.encode("req/x");
    const shimKey = await shim.deriveKey({ name: "HKDF", salt, info } as never, await shim.importKey("raw", phoneBits, "HKDF", false, ["deriveKey"]), { name: "AES-GCM", length: 256 }, false, []);
    const realKey = await real.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info }, await real.importKey("raw", computerBits, "HKDF", false, ["deriveKey"]), { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);

    const ct = await shim.encrypt({ iv, additionalData: aad }, shimKey, enc.encode("hello computer"));
    expect(new TextDecoder().decode(await real.decrypt({ name: "AES-GCM", iv, additionalData: aad }, realKey, ct))).toBe("hello computer");
    const back = await real.encrypt({ name: "AES-GCM", iv, additionalData: aad }, realKey, enc.encode("hello phone"));
    expect(new TextDecoder().decode(await shim.decrypt({ iv, additionalData: aad }, shimKey, back))).toBe("hello phone");
  });

  it("agrees on HMAC, SHA-256 and private JWK round trips", async () => {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const data = enc.encode("uemcp-remote/pair/");
    const a = await shim.sign("HMAC", await shim.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), data);
    const b = await real.sign("HMAC", await real.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), data);
    expect(new Uint8Array(a)).toEqual(new Uint8Array(b));
    expect(new Uint8Array(await shim.digest("SHA-256", data))).toEqual(new Uint8Array(await real.digest("SHA-256", data)));

    const pair = await shim.generateKey({ name: "ECDH" }, true, ["deriveBits"]);
    const jwk = await shim.exportKey("jwk", pair.privateKey);
    const realPriv = await real.importKey("jwk", jwk as JsonWebKey, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    expect(((await real.exportKey("jwk", realPriv)) as JsonWebKey).d).toBe((jwk as JsonWebKey).d);
  });
});

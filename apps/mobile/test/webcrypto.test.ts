/**
 * The app's WebCrypto shim against Node's real WebCrypto: a phone on the shim
 * pairs with and talks to a computer on the platform implementation, so the two
 * must agree byte for byte on every primitive the protocol uses.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("expo-crypto", () => ({ getRandomValues: (a: Uint8Array) => globalThis.crypto.getRandomValues(a), randomUUID: () => globalThis.crypto.randomUUID() }));

const { subtle: shim } = await import("../src/webcrypto");
const real = globalThis.crypto.subtle;
const enc = new TextEncoder();

describe("webcrypto shim", () => {
  it("agrees with WebCrypto on ECDH, HKDF and AES-GCM in both directions", async () => {
    const phone = await shim.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const computer = await real.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const phoneRaw = new Uint8Array(await shim.exportKey("raw", phone.publicKey));
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

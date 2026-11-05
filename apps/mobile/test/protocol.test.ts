/**
 * The remote protocol end to end with the phone's steps running on the app's
 * WebCrypto shim and the computer's on Node's WebCrypto: pairing proof, pairing
 * code, a sealed request, and a sealed response. @ue-mcp-studio/remote reads
 * crypto.subtle on each use, so swapping the global switches sides.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("expo-crypto", () => ({ getRandomValues: (a: Uint8Array<ArrayBuffer>) => nodeCrypto.getRandomValues(a), randomUUID: () => nodeCrypto.randomUUID() }));

const nodeCrypto = globalThis.crypto;
const { subtle: shim } = await import("../src/webcrypto");
const e2e = await import("../../../packages/remote/src/e2e");

let shimCalls = 0;
const counted = new Proxy(shim, {
  get(target, prop) {
    shimCalls++;
    return target[prop as keyof typeof target];
  },
});

/** Runs one step as the phone: every crypto.subtle call inside goes to the shim. */
async function asPhone<T>(step: () => Promise<T>): Promise<T> {
  vi.stubGlobal("crypto", { subtle: counted, getRandomValues: nodeCrypto.getRandomValues.bind(nodeCrypto), randomUUID: nodeCrypto.randomUUID.bind(nodeCrypto) });
  try {
    return await step();
  } finally {
    vi.unstubAllGlobals();
  }
}

describe("remote protocol, phone on the shim", () => {
  it("pairs, seals a request and opens the response", async () => {
    const c = await e2e.generateKeyPair(false);
    const cPub = await e2e.exportPublic(c.publicKey);
    const { pPub, pPriv, phoneId } = await asPhone(async () => {
      const p = await e2e.generateKeyPair(true);
      const pPub = await e2e.exportPublic(p.publicKey);
      return { pPub, pPriv: await e2e.importPrivateJwk(await e2e.exportPrivateJwk(p.privateKey)), phoneId: await e2e.keyId(pPub) };
    });
    expect(phoneId).toBe(await e2e.keyId(pPub));

    const secret = e2e.b64u(e2e.randomBytes(32));
    const mac = await asPhone(() => e2e.pairingMac(secret, pPub, cPub));
    expect(await e2e.verifyPairingMac(secret, pPub, cPub, mac)).toBe(true);
    expect(await asPhone(() => e2e.pairingCode(secret, pPub))).toBe(await e2e.pairingCode(secret, pPub));

    const { sealed, responseKey } = await asPhone(async () => e2e.sealRequest(await e2e.sharedSecret(pPriv, cPub), phoneId, { id: "r1", ts: Date.now(), device: "d1", method: "GET", path: "/v1/health", headers: {} }));
    const opened = await e2e.openRequest(await e2e.sharedSecret(c.privateKey, pPub), sealed);
    expect(opened?.req.path).toBe("/v1/health");

    const sealer = new e2e.ResponseSealer(opened!.responseKey);
    const frames = [await sealer.head({ status: 200, headers: { "content-type": "application/json" } }), await sealer.data(new TextEncoder().encode('{"ok":true}')), await sealer.final()];
    const all = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
    let at = 0;
    for (const f of frames) {
      all.set(f, at);
      at += f.length;
    }
    const opener = new e2e.ResponseOpener(responseKey);
    const out = await asPhone(() => opener.push(all));
    expect(opener.finished).toBe(true);
    expect(out[0]).toEqual({ kind: "head", head: { status: 200, headers: { "content-type": "application/json" } } });
    expect(new TextDecoder().decode((out[1] as { data: Uint8Array }).data)).toBe('{"ok":true}');
    expect(shimCalls).toBeGreaterThan(10);
  });
});

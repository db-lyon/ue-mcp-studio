/**
 * The remote protocol end to end with the phone's copy of @ue-mcp-studio/remote
 * running on the app's WebCrypto shim and the computer's on Node's WebCrypto:
 * pairing proof, pairing code, a sealed request, and a sealed response.
 */
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("expo-crypto", () => ({ getRandomValues: (a: Uint8Array<ArrayBuffer>) => nodeCrypto.getRandomValues(a), randomUUID: () => nodeCrypto.randomUUID() }));

const nodeCrypto = globalThis.crypto;
const { subtle: shim } = await import("../src/webcrypto");

vi.stubGlobal("crypto", { subtle: shim, getRandomValues: nodeCrypto.getRandomValues.bind(nodeCrypto), randomUUID: nodeCrypto.randomUUID.bind(nodeCrypto) });
const phone = await import("../../../packages/remote/src/e2e");
vi.unstubAllGlobals();
vi.resetModules();
const computer = await import("../../../packages/remote/src/e2e");

afterAll(() => vi.unstubAllGlobals());

describe("remote protocol, phone on the shim", () => {
  it("pairs, seals a request and opens the response", async () => {
    const c = await computer.generateKeyPair(false);
    const cPub = await computer.exportPublic(c.publicKey);
    const p = await phone.generateKeyPair(true);
    const pPub = await phone.exportPublic(p.publicKey);
    const pPriv = await phone.importPrivateJwk(await phone.exportPrivateJwk(p.privateKey));
    expect(await phone.keyId(pPub)).toBe(await computer.keyId(pPub));

    const secret = computer.b64u(computer.randomBytes(32));
    const mac = await phone.pairingMac(secret, pPub, cPub);
    expect(await computer.verifyPairingMac(secret, pPub, cPub, mac)).toBe(true);
    expect(await phone.pairingCode(secret, pPub)).toBe(await computer.pairingCode(secret, pPub));

    const phoneId = await phone.keyId(pPub);
    const { sealed, responseKey } = await phone.sealRequest(await phone.sharedSecret(pPriv, cPub), phoneId, { id: "r1", ts: Date.now(), device: "d1", method: "GET", path: "/v1/health", headers: {} });
    const opened = await computer.openRequest(await computer.sharedSecret(c.privateKey, pPub), sealed);
    expect(opened?.req.path).toBe("/v1/health");

    const sealer = new computer.ResponseSealer(opened!.responseKey);
    const frames = [await sealer.head({ status: 200, headers: { "content-type": "application/json" } }), await sealer.data(new TextEncoder().encode('{"ok":true}')), await sealer.final()];
    const all = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
    let at = 0;
    for (const f of frames) all.set(f, (at += f.length) - f.length);
    const opener = new phone.ResponseOpener(responseKey);
    const out = await opener.push(all);
    expect(opener.finished).toBe(true);
    expect(out[0]).toEqual({ kind: "head", head: { status: 200, headers: { "content-type": "application/json" } } });
    expect(new TextDecoder().decode((out[1] as { data: Uint8Array }).data)).toBe('{"ok":true}');
  });
});

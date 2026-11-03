/** The end-to-end sealing on its own: what opens, and everything that must not. */
import { describe, expect, it } from "vitest";
import {
  ReplayGuard,
  ResponseOpener,
  ResponseSealer,
  exportPublic,
  generateKeyPair,
  keyId,
  openRequest,
  pairingMac,
  parsePairingFragment,
  pairingFragment,
  sealRequest,
  sharedSecret,
  unb64u,
  b64u,
  verifyPairingMac,
  type PlainRequest,
} from "../src/index.js";

async function parties() {
  const phone = await generateKeyPair();
  const computer = await generateKeyPair();
  const stranger = await generateKeyPair();
  const phonePub = await exportPublic(phone.publicKey);
  const computerPub = await exportPublic(computer.publicKey);
  return {
    phoneId: await keyId(phonePub),
    phonePub,
    computerPub,
    phoneSecret: await sharedSecret(phone.privateKey, computerPub),
    computerSecret: await sharedSecret(computer.privateKey, phonePub),
    strangerSecret: await sharedSecret(stranger.privateKey, computerPub),
  };
}

const req = (over: Partial<PlainRequest> = {}): PlainRequest => ({ id: crypto.randomUUID(), ts: Date.now(), device: "d1", method: "GET", path: "/v1/health", headers: {}, ...over });

async function collect(opener: ResponseOpener, bytes: Uint8Array) {
  return opener.push(bytes);
}

describe("requests", () => {
  it("open on the computer and nowhere else", async () => {
    const p = await parties();
    const { sealed } = await sealRequest(p.phoneSecret, p.phoneId, req({ path: "/v1/ext/studio/x", body: "c2VjcmV0" }));
    expect(JSON.stringify(sealed)).not.toContain("/v1/ext/studio/x");
    const opened = await openRequest(p.computerSecret, sealed);
    expect(opened?.req.path).toBe("/v1/ext/studio/x");
    expect(await openRequest(p.strangerSecret, sealed)).toBeNull();
  });

  it("refuse any change in transit", async () => {
    const p = await parties();
    const { sealed } = await sealRequest(p.phoneSecret, p.phoneId, req());
    const ct = unb64u(sealed.ct);
    ct[3] ^= 1;
    expect(await openRequest(p.computerSecret, { ...sealed, ct: b64u(ct) })).toBeNull();
    expect(await openRequest(p.computerSecret, { ...sealed, phone: "someone-else" })).toBeNull();
    expect(await openRequest(p.computerSecret, { ...sealed, salt: b64u(new Uint8Array(16)) })).toBeNull();
    expect(await openRequest(p.computerSecret, { ...sealed, v: 2 })).toBeNull();
  });

  it("are accepted once, and only while fresh", () => {
    let now = 1_000_000;
    const g = new ReplayGuard(() => now);
    expect(g.accept("a", now)).toBe(true);
    expect(g.accept("a", now)).toBe(false);
    expect(g.accept("b", now - 3 * 60_000)).toBe(false);
    expect(g.accept("c", now + 3 * 60_000)).toBe(false);
    now += 10 * 60_000;
    expect(g.accept("d", now)).toBe(true);
  });
});

describe("responses", () => {
  async function sealed() {
    const p = await parties();
    const { sealed: s, responseKey: phoneKey } = await sealRequest(p.phoneSecret, p.phoneId, req());
    const { responseKey } = (await openRequest(p.computerSecret, s))!;
    const sealer = new ResponseSealer(responseKey);
    const frames = [await sealer.head({ status: 200, headers: { "content-type": "text/plain" } }), await sealer.data(new TextEncoder().encode("hello ")), await sealer.data(new TextEncoder().encode("world")), await sealer.final()];
    return { phoneKey, frames };
  }

  it("open in order, across arbitrary chunking", async () => {
    const { phoneKey, frames } = await sealed();
    const all = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
    let at = 0;
    for (const f of frames) all.set(f, (at += f.length) - f.length);
    const opener = new ResponseOpener(phoneKey);
    const out = [];
    for (let i = 0; i < all.length; i += 7) out.push(...(await collect(opener, all.subarray(i, i + 7))));
    expect(out[0]).toEqual({ kind: "head", head: { status: 200, headers: { "content-type": "text/plain" } } });
    expect(out.filter((f) => f.kind === "data").map((f) => new TextDecoder().decode((f as { data: Uint8Array }).data)).join("")).toBe("hello world");
    expect(opener.finished).toBe(true);
  });

  it("refuse reordering, a swapped kind, tampering and trailing data", async () => {
    const { phoneKey, frames } = await sealed();
    await expect(new ResponseOpener(phoneKey).push(frames[1])).rejects.toThrow();
    const o1 = new ResponseOpener(phoneKey);
    await o1.push(frames[0]);
    await expect(o1.push(frames[2])).rejects.toThrow();
    const swapped = new Uint8Array(frames[3]);
    swapped[4] = "d".charCodeAt(0);
    const o2 = new ResponseOpener(phoneKey);
    await o2.push(frames[0]);
    await o2.push(frames[1]);
    await o2.push(frames[2]);
    await expect(o2.push(swapped)).rejects.toThrow();
    const bent = new Uint8Array(frames[1]);
    bent[10] ^= 1;
    const o3 = new ResponseOpener(phoneKey);
    await o3.push(frames[0]);
    await expect(o3.push(bent)).rejects.toThrow();
    const o4 = new ResponseOpener(phoneKey);
    for (const f of frames) await o4.push(f);
    await expect(o4.push(frames[1])).rejects.toThrow();
  });

  it("a response cut short is never finished", async () => {
    const { phoneKey, frames } = await sealed();
    const o = new ResponseOpener(phoneKey);
    for (const f of frames.slice(0, 3)) await o.push(f);
    expect(o.finished).toBe(false);
  });
});

describe("pairing", () => {
  it("binds the browser's key to whoever read the code", async () => {
    const p = await parties();
    const secret = b64u(crypto.getRandomValues(new Uint8Array(32)));
    const mac = await pairingMac(secret, p.phonePub, p.computerPub);
    expect(await verifyPairingMac(secret, p.phonePub, p.computerPub, mac)).toBe(true);
    const other = await exportPublic((await generateKeyPair()).publicKey);
    expect(await verifyPairingMac(secret, other, p.computerPub, mac)).toBe(false);
    expect(await verifyPairingMac(b64u(new Uint8Array(32)), p.phonePub, p.computerPub, mac)).toBe(false);
    expect(parsePairingFragment(`#${pairingFragment("code", p.computerPub, secret)}`)).toEqual({ code: "code", computerPublic: p.computerPub, secret });
    expect(parsePairingFragment("#code")).toBeNull();
  });
});

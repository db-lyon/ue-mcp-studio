/**
 * The app's sealed transport against a fake relay whose computer side is the
 * real protocol code: requests open on the computer, responses stream back in
 * odd-sized chunks, gzip opens on the phone, and the lock guard and event
 * stream from client-core work over it.
 */
import { gzipSync } from "node:zlib";
import { beforeAll, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
vi.mock("expo-secure-store", () => ({
  getItemAsync: async (k: string) => store.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => void store.set(k, v),
  deleteItemAsync: async (k: string) => void store.delete(k),
}));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));

const remote = await import("../../../packages/remote/src/index");
const core = await import("../../../packages/client-core/src/index");
const relay = await import("../src/relay");

const device = { id: "dev1", name: "Project", online: true, computerKey: "", lastSeen: "" };
let computer: CryptoKeyPair;
let daemon: (method: string, path: string, body: unknown) => { status: number; headers: Record<string, string>; body: Uint8Array; gzip?: boolean };

function chunked(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(c) {
      if (at >= bytes.length) return c.close();
      c.enqueue(bytes.slice(at, at + size));
      at += size;
    },
  });
}

beforeAll(async () => {
  computer = await remote.generateKeyPair(false);
  device.computerKey = await remote.exportPublic(computer.publicKey);
  store.set("trusted", JSON.stringify({ [device.computerKey]: { pairedAt: "x" } }));
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    expect(url).toBe(`${relay.RELAY}/e2e/dev1`);
    expect((init.headers as Record<string, string>).origin).toBe(relay.RELAY);
    const sealed = JSON.parse(String(init.body));
    const phonePublic = JSON.parse(store.get("phone")!).publicKey;
    const opened = await remote.openRequest(await remote.sharedSecret(computer.privateKey, phonePublic), sealed);
    if (!opened) return new Response(JSON.stringify({ error: "bad seal" }), { status: 400 });
    const reqBody = opened.req.body ? JSON.parse(new TextDecoder().decode(remote.unb64u(opened.req.body))) : undefined;
    const answer = daemon(opened.req.method, opened.req.path, reqBody);
    const sealer = new remote.ResponseSealer(opened.responseKey);
    const payload = answer.gzip ? new Uint8Array(gzipSync(answer.body)) : answer.body;
    const frames = [await sealer.head({ status: answer.status, headers: { ...answer.headers, ...(answer.gzip ? { "content-encoding": "gzip" } : {}) } })];
    for (let i = 0; i < payload.length; i += 7) frames.push(await sealer.data(payload.slice(i, i + 7)));
    frames.push(await sealer.final());
    const all = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
    let at = 0;
    for (const f of frames) {
      all.set(f, at);
      at += f.length;
    }
    return new Response(chunked(all, 13), { status: 200 });
  });
});

const enc = new TextEncoder();

describe("transportFor", () => {
  it("seals a JSON request and opens a gzip response streamed in odd chunks", async () => {
    daemon = (method, path, body) => ({ status: 200, headers: { "content-type": "application/json" }, body: enc.encode(JSON.stringify({ method, path, body, pad: "x".repeat(500) })), gzip: true });
    const t = relay.transportFor(device);
    const got = await core.requestJson<{ method: string; path: string; body: unknown }>(t, "POST", "/v1/ext/studio/sessions", { json: { a: 1 } });
    expect(got).toMatchObject({ method: "POST", path: "/v1/ext/studio/sessions", body: { a: 1 } });
  });

  it("holds a locked request behind the PIN and streams events", async () => {
    let unlocked = false;
    daemon = (_m, path, body) => {
      const json = (status: number, v: unknown) => ({ status, headers: {}, body: enc.encode(JSON.stringify(v)) });
      if (path === "/v1/ext/studio/lock") return json(200, { whole: true, sensitive: false, locked: !unlocked, sensitiveOpen: false, idleMinutes: 5, pinLength: 4 });
      if (path === "/v1/ext/studio/lock/unlock") return (body as { pin: string }).pin === "2468" ? ((unlocked = true), json(200, { whole: true, locked: false })) : json(403, { error: "Wrong PIN." });
      if (!unlocked) return json(423, { code: "locked" });
      if (path === "/v1/health") return json(200, { startedAt: "s", lastEventId: 1 });
      if (path === "/v1/events") return { status: 200, headers: { "content-type": "text/event-stream" }, body: enc.encode('id: 1\nevent: studio.session.changed\ndata: {"id":"a"}\n\n') };
      return json(200, { sessions: [] });
    };
    const raw = relay.transportFor(device);
    const lock = core.createLock(raw);
    const t = lock.guard(raw);
    const pending = core.requestJson(t, "GET", "/v1/ext/studio/sessions");
    await vi.waitFor(() => expect(lock.view().screen).toBe(true));
    expect(await lock.unlock("2468")).toEqual({ ok: true });
    expect(await pending).toEqual({ sessions: [] });

    const events: unknown[] = [];
    const stream = core.subscribeEvents(t, (e) => events.push(e));
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0));
    stream.stop();
    expect(events[0]).toMatchObject({ id: 1, type: "studio.session.changed", data: { id: "a" } });
  });
});

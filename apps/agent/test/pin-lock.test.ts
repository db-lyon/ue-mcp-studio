/**
 * The remote PIN lock, enforced on the computer: the rules on their own, then
 * the connector's service carrying sealed requests from a real paired browser
 * key to a fake daemon, so a request without the PIN is shown never to reach
 * the daemon however the browser sends it.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ResponseOpener, exportPublic, generateKeyPair, remotePath, sealRequest, sharedSecret, type PlainRequest } from "@ue-mcp-studio/remote";
import { REMOTE_PIN_ATTEMPTS } from "@ue-mcp-studio/shared";
import { ComputerKeys, type PairedPhone } from "../src/remote/keys.js";
import { PinLock, SENSITIVE_GRANT_MS, attemptDelayMs, openWhileLocked, sensitiveRequest } from "../src/remote/pin-lock.js";
import { RemoteService, type CallSink } from "../src/remote/service.js";

const DEVICE = "11111111-2222-3333-4444-555555555555";
const TOKEN = "t".repeat(32);

// ── The daemon a forwarded request reaches ─────────────────────────
const hits: string[] = [];
const daemon = http.createServer((req, res) => {
  hits.push(`${req.method} ${req.url}`);
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
});
let port = 0;
beforeAll(async () => {
  await new Promise<void>((r) => daemon.listen(0, "127.0.0.1", () => r()));
  port = (daemon.address() as AddressInfo).port;
});
afterAll(() => daemon.close());

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pin-lock-"));
}

describe("which requests the PIN guards", () => {
  it("never a read", () => {
    expect(sensitiveRequest("GET", "/v1/ext/studio/sessions/s1/approvals/a1", true)).toBe(false);
    expect(sensitiveRequest("GET", "/v1/flows", true)).toBe(false);
  });

  it("always: approvals, dialogs, editor restarts, flows, settings, updates, undoing changes, deleting a session", () => {
    for (const [m, p] of [
      ["POST", "/v1/ext/studio/sessions/s1/approvals/a1"],
      ["POST", "/v1/ext/studio/dialogs/d1"],
      ["POST", "/v1/editor/restart"],
      ["POST", "/v1/editor/rebuild"],
      ["POST", "/v1/flows/run"],
      ["PUT", "/v1/ext/studio/settings"],
      ["PUT", "/v1/ext/studio/agent-settings"],
      ["POST", "/v1/ext/studio/updates/studio"],
      ["POST", "/v1/ext/studio/sessions/s1/reviews/r1/revert"],
      ["POST", "/v1/ext/studio/sessions/s1/timeline/restore"],
      ["POST", "/v1/ext/studio/qa/runs/r1/run"],
      ["DELETE", "/v1/ext/studio/sessions/s1"],
    ]) expect(sensitiveRequest(m, p, false), `${m} ${p}`).toBe(true);
  });

  it("a message starts a turn: guarded only while shell commands or file changes run without asking", () => {
    expect(sensitiveRequest("POST", "/v1/ext/studio/sessions/s1/messages", false)).toBe(false);
    expect(sensitiveRequest("POST", "/v1/ext/studio/sessions/s1/messages", true)).toBe(true);
    expect(sensitiveRequest("POST", "/v1/ext/studio/sessions/s1/queue", true)).toBe(true);
    expect(sensitiveRequest("POST", "/v1/ext/studio/quick", true)).toBe(true);
  });

  it("not: renaming a session, a new session, a verdict, the lock's own routes", () => {
    expect(sensitiveRequest("PUT", "/v1/ext/studio/sessions/s1", true)).toBe(false);
    expect(sensitiveRequest("POST", "/v1/ext/studio/sessions", true)).toBe(false);
    expect(sensitiveRequest("POST", "/v1/ext/studio/qa/runs/r1/verdict", true)).toBe(false);
    expect(sensitiveRequest("POST", "/v1/ext/studio/lock/unlock", true)).toBe(false);
  });

  it("a locked whole client still loads the page, the connection check and the way to unlock", () => {
    expect(openWhileLocked("GET", "/ui/")).toBe(true);
    expect(openWhileLocked("GET", "/ui/assets/index-abc12345.js")).toBe(true);
    expect(openWhileLocked("GET", "/v1/health")).toBe(true);
    expect(openWhileLocked("POST", "/v1/ext/studio/lock/unlock")).toBe(true);
    expect(openWhileLocked("GET", "/v1/events")).toBe(false);
    expect(openWhileLocked("GET", "/v1/ext/studio/sessions")).toBe(false);
  });

  it("waits grow after the third wrong PIN", () => {
    expect([1, 2, 3].map(attemptDelayMs)).toEqual([0, 0, 0]);
    expect(attemptDelayMs(4)).toBe(2000);
    expect(attemptDelayMs(5)).toBe(4000);
    expect(attemptDelayMs(9)).toBe(64_000);
  });

  it("a paired browser can never reach the PIN's settings: they sit under remote control's own routes", () => {
    for (const m of ["GET", "PUT", "DELETE"]) {
      expect(remotePath(m, "/v1/ext/studio/remote/lock")).toBeNull();
      expect(remotePath(m, "/v1/ext/studio/remote/lock/pin")).toBeNull();
      expect(remotePath(m, "/v1/ext/studio/remote/lock%2Fpin")).toBeNull();
      expect(remotePath(m, "/v1/ext/studio//remote/lock/pin")).toBeNull();
    }
    expect(remotePath("POST", "/v1/ext/studio/lock/unlock")).toBe("/v1/ext/studio/lock/unlock");
  });
});

describe("the PIN lock's state", () => {
  let clock = 1_000_000;
  const now = () => clock;
  let file = "";
  beforeEach(() => {
    clock = 1_000_000;
    file = path.join(tmp(), "remote-lock.json");
  });

  it("is off until a PIN is set, and a switch needs one", async () => {
    const lock = new PinLock({ file, now });
    expect(lock.settings()).toEqual({ pin: false, whole: false, sensitive: false, idleMinutes: 15 });
    expect(lock.check("p1", "POST", "/v1/editor/restart", true)).toBe("ok");
    expect(() => lock.configure({ whole: true })).toThrow(/PIN first/);
    await lock.setPin("4821");
    expect(lock.configure({ whole: true, idleMinutes: 5 })).toEqual({ pin: true, whole: true, sensitive: false, idleMinutes: 5 });
    expect(() => lock.configure({ idleMinutes: 7 })).toThrow(/idle time/);
  });

  it("keeps a salted hash, never the PIN", async () => {
    const lock = new PinLock({ file, now });
    await lock.setPin("482193");
    const text = fs.readFileSync(file, "utf-8");
    expect(text).not.toContain("482193");
    expect(JSON.parse(text)).toMatchObject({ salt: expect.any(String), hash: expect.any(String) });
  });

  it("whole client: locked until the PIN, open while used, locked again after sitting idle", async () => {
    const lock = new PinLock({ file, now });
    await lock.setPin("4821");
    lock.configure({ whole: true, idleMinutes: 5 });
    expect(lock.check("p1", "GET", "/v1/ext/studio/sessions", false)).toBe("locked");
    expect(lock.state("p1").locked).toBe(true);
    expect((await lock.unlock("p1", "4821")).ok).toBe(true);
    expect(lock.check("p1", "GET", "/v1/ext/studio/sessions", false)).toBe("ok");
    // Another browser stays locked.
    expect(lock.check("p2", "GET", "/v1/ext/studio/sessions", false)).toBe("locked");
    clock += 4 * 60_000;
    lock.touch("p1");
    clock += 4 * 60_000;
    expect(lock.check("p1", "GET", "/v1/ext/studio/sessions", false)).toBe("ok");
    clock += 5 * 60_000 + 1;
    expect(lock.check("p1", "GET", "/v1/ext/studio/sessions", false)).toBe("locked");
    // A touch on a locked browser does not open it.
    lock.touch("p1");
    expect(lock.state("p1").locked).toBe(true);
  });

  it("sensitive only: reads and plain requests go, a sensitive one asks, and one PIN covers a short while", async () => {
    const lock = new PinLock({ file, now });
    await lock.setPin("4821");
    lock.configure({ sensitive: true });
    expect(lock.check("p1", "GET", "/v1/ext/studio/sessions", true)).toBe("ok");
    expect(lock.check("p1", "POST", "/v1/ext/studio/sessions/s1/messages", false)).toBe("ok");
    expect(lock.check("p1", "POST", "/v1/ext/studio/sessions/s1/approvals/a1", false)).toBe("pin-required");
    await lock.unlock("p1", "4821");
    expect(lock.check("p1", "POST", "/v1/ext/studio/sessions/s1/approvals/a1", false)).toBe("ok");
    clock += SENSITIVE_GRANT_MS + 1;
    expect(lock.check("p1", "POST", "/v1/ext/studio/sessions/s1/approvals/a1", false)).toBe("pin-required");
  });

  it("both: the whole client opens with the PIN and sensitive actions still need it once the short grant ends", async () => {
    const lock = new PinLock({ file, now });
    await lock.setPin("4821");
    lock.configure({ whole: true, sensitive: true, idleMinutes: 60 });
    await lock.unlock("p1", "4821");
    clock += SENSITIVE_GRANT_MS + 1;
    lock.touch("p1");
    expect(lock.check("p1", "GET", "/v1/ext/studio/sessions", false)).toBe("ok");
    expect(lock.check("p1", "POST", "/v1/editor/restart", false)).toBe("pin-required");
  });

  it("a restart locks every browser again", async () => {
    const lock = new PinLock({ file, now });
    await lock.setPin("4821");
    lock.configure({ whole: true });
    await lock.unlock("p1", "4821");
    expect(lock.check("p1", "GET", "/v1/ext/studio/sessions", false)).toBe("ok");
    const after = new PinLock({ file, now });
    expect(after.check("p1", "GET", "/v1/ext/studio/sessions", false)).toBe("locked");
  });

  it("wrong PINs: a growing wait after the third, the count survives a restart, the tenth removes the browser", async () => {
    let lock = new PinLock({ file, now });
    await lock.setPin("4821");
    lock.configure({ whole: true });
    for (let i = 1; i <= 3; i++) expect(await lock.unlock("p1", "0000")).toMatchObject({ ok: false, status: 401, remaining: REMOTE_PIN_ATTEMPTS - i });
    const fourth = await lock.unlock("p1", "0000");
    expect(fourth).toMatchObject({ ok: false, status: 401, retryAfterMs: 2000 });
    // Even the right PIN waits out the delay.
    expect(await lock.unlock("p1", "4821")).toMatchObject({ ok: false, status: 429 });
    clock += 2001;
    lock = new PinLock({ file, now });
    for (let i = 5; i < REMOTE_PIN_ATTEMPTS; i++) {
      clock += 5 * 60_000;
      expect(await lock.unlock("p1", "1111")).toMatchObject({ ok: false, status: 401, remaining: REMOTE_PIN_ATTEMPTS - i });
    }
    clock += 5 * 60_000;
    expect(await lock.unlock("p1", "1111")).toMatchObject({ ok: false, status: 403, unpaired: true });
  });

  it("the right PIN clears the count; changing the PIN locks everyone; removing it turns both switches off", async () => {
    const lock = new PinLock({ file, now });
    await lock.setPin("4821");
    lock.configure({ whole: true, sensitive: true });
    await lock.unlock("p1", "0000");
    expect(lock.state("p1").remaining).toBe(REMOTE_PIN_ATTEMPTS - 1);
    await lock.unlock("p1", "4821");
    expect(lock.state("p1").remaining).toBeUndefined();
    expect(lock.state("p1").locked).toBe(false);
    await lock.setPin("9999");
    expect(lock.state("p1").locked).toBe(true);
    lock.removePin();
    expect(lock.settings()).toEqual({ pin: false, whole: false, sensitive: false, idleMinutes: 15 });
    expect(lock.check("p1", "POST", "/v1/editor/restart", true)).toBe("ok");
  });
});

// ── The connector's service, end to end through sealing ───────────
class Sink implements CallSink {
  status = 0;
  bytes: Uint8Array[] = [];
  failed: { status: number; error: string } | null = null;
  done = false;
  head(status: number): void {
    this.status = status;
  }
  async chunk(b: Uint8Array): Promise<void> {
    this.bytes.push(b);
  }
  end(): void {
    this.done = true;
  }
  fail(status: number, error: string): void {
    this.failed = { status, error };
    this.done = true;
  }
}

interface Browser {
  phone: PairedPhone;
  send(method: string, p: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }>;
}

async function setup(o: { risky?: boolean } = {}) {
  const dir = tmp();
  const keys = new ComputerKeys(dir);
  const me = await keys.identity();
  const lock = new PinLock({ file: path.join(dir, "remote-lock.json") });
  const lockouts: PairedPhone[] = [];
  const make = (l: PinLock) =>
    new RemoteService({ keys, deviceId: DEVICE, daemon: () => ({ port, token: TOKEN }), lock: l, risky: () => o.risky ?? false, onLockout: (p) => lockouts.push(p) });
  let service = make(lock);
  const pair = await generateKeyPair(false);
  const phonePublic = await exportPublic(pair.publicKey);
  const phone = await keys.addPhone(phonePublic, "Android (Chrome)");
  const secret = await sharedSecret(pair.privateKey, me.publicKey);
  const browser: Browser = {
    phone,
    async send(method, p, body) {
      const plain: PlainRequest = {
        id: crypto.randomUUID(),
        ts: Date.now(),
        device: DEVICE,
        method,
        path: p,
        headers: body !== undefined ? { "content-type": "application/json" } : {},
        ...(body !== undefined ? { body: Buffer.from(JSON.stringify(body)).toString("base64") } : {}),
      };
      const { sealed, responseKey } = await sealRequest(secret, phone.id, plain);
      const sink = new Sink();
      await service.sealed(JSON.stringify(sealed), sink, new AbortController().signal);
      if (sink.failed) return { status: sink.failed.status, json: { error: sink.failed.error } };
      const opener = new ResponseOpener(responseKey);
      let status = 0;
      const parts: Uint8Array[] = [];
      for (const b of sink.bytes) {
        for (const f of await opener.push(b)) {
          if (f.kind === "head") status = f.head.status;
          else if (f.kind === "data") parts.push(f.data);
        }
      }
      const text = Buffer.concat(parts).toString("utf-8");
      return { status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
    },
  };
  return { keys, lock, browser, lockouts, restart: () => (service = make(new PinLock({ file: path.join(dir, "remote-lock.json") }))) };
}

describe("the lock in the connector, for sealed requests", () => {
  beforeEach(() => void hits.splice(0));

  it("with the feature off, a paired browser works exactly as before", async () => {
    const { browser } = await setup();
    expect((await browser.send("GET", "/v1/ext/studio/lock")).json).toMatchObject({ whole: false, sensitive: false, locked: false });
    expect((await browser.send("POST", "/v1/editor/restart", {})).status).toBe(200);
    expect(hits).toEqual(["POST /v1/editor/restart"]);
  });

  it("whole client: refused with 423 before the daemon until the PIN, then carried; the page and health stay open", async () => {
    const { lock, browser } = await setup();
    await lock.setPin("4821");
    lock.configure({ whole: true });
    const refused = await browser.send("GET", "/v1/ext/studio/sessions");
    expect(refused).toEqual({ status: 423, json: { error: "Locked. Enter your PIN.", code: "locked" } });
    expect((await browser.send("GET", "/v1/events")).status).toBe(423);
    expect(hits).toEqual([]);
    expect((await browser.send("GET", "/v1/health")).status).toBe(200);
    expect((await browser.send("GET", "/ui/")).status).toBe(200);
    expect((await browser.send("GET", "/v1/ext/studio/lock")).json).toMatchObject({ whole: true, locked: true });
    expect((await browser.send("POST", "/v1/ext/studio/lock/unlock", { pin: "4821" })).json).toMatchObject({ locked: false });
    expect((await browser.send("GET", "/v1/ext/studio/sessions")).status).toBe(200);
    expect(hits).toEqual(["GET /v1/health", "GET /ui/", "GET /v1/ext/studio/sessions"]);
    // The unlock itself never reached the daemon.
    expect(hits.some((h) => h.includes("/lock"))).toBe(false);
    // Lock now.
    await browser.send("POST", "/v1/ext/studio/lock/lock", {});
    expect((await browser.send("GET", "/v1/ext/studio/sessions")).status).toBe(423);
  });

  it("sensitive only: an approval answer asks for the PIN, a message asks only while commands run without asking", async () => {
    const calm = await setup({ risky: false });
    await calm.lock.setPin("4821");
    calm.lock.configure({ sensitive: true });
    expect((await calm.browser.send("GET", "/v1/ext/studio/sessions")).status).toBe(200);
    expect((await calm.browser.send("POST", "/v1/ext/studio/sessions/s1/messages", { text: "hi" })).status).toBe(200);
    const approval = await calm.browser.send("POST", "/v1/ext/studio/sessions/s1/approvals/a1", { allow: true });
    expect(approval).toEqual({ status: 423, json: { error: "Enter your PIN to do this.", code: "pin-required" } });
    await calm.browser.send("POST", "/v1/ext/studio/lock/unlock", { pin: "4821" });
    expect((await calm.browser.send("POST", "/v1/ext/studio/sessions/s1/approvals/a1", { allow: true })).status).toBe(200);

    const risky = await setup({ risky: true });
    await risky.lock.setPin("4821");
    risky.lock.configure({ sensitive: true });
    expect((await risky.browser.send("POST", "/v1/ext/studio/sessions/s1/messages", { text: "hi" })).status).toBe(423);
  });

  it("a daemon restart locks the browser again", async () => {
    const { lock, browser, restart } = await setup();
    await lock.setPin("4821");
    lock.configure({ whole: true });
    await browser.send("POST", "/v1/ext/studio/lock/unlock", { pin: "4821" });
    expect((await browser.send("GET", "/v1/ext/studio/sessions")).status).toBe(200);
    restart();
    expect((await browser.send("GET", "/v1/ext/studio/sessions")).status).toBe(423);
  });

  it("ten wrong PINs remove the browser and tell the computer", async () => {
    const { lock, browser, keys, lockouts } = await setup();
    await lock.setPin("4821");
    lock.configure({ whole: true });
    const fast = lock as unknown as { nextTry: Map<string, number> };
    let last: { status: number; json: Record<string, unknown> } = { status: 0, json: {} };
    for (let i = 0; i < REMOTE_PIN_ATTEMPTS; i++) {
      fast.nextTry.clear();
      last = await browser.send("POST", "/v1/ext/studio/lock/unlock", { pin: "0000" });
    }
    expect(last).toMatchObject({ status: 403, json: { unpaired: true } });
    expect(keys.phones().find((p) => p.id === browser.phone.id)).toBeUndefined();
    expect(lockouts.map((p) => p.label)).toEqual(["Android (Chrome)"]);
    // Not paired any more: refused before anything opens.
    expect((await browser.send("GET", "/v1/ext/studio/sessions")).status).toBe(403);
  });

  it("a paired browser is refused the PIN's settings", async () => {
    const { lock, browser } = await setup();
    await lock.setPin("4821");
    for (const [m, p] of [["DELETE", "/v1/ext/studio/remote/lock/pin"], ["PUT", "/v1/ext/studio/remote/lock"], ["PUT", "/v1/ext/studio/remote/lock/pin"]] as const) {
      expect((await browser.send(m, p, { pin: "1111", whole: false })).status).toBe(403);
    }
    expect(lock.settings().pin).toBe(true);
    expect(hits).toEqual([]);
  });
});

describe("the PIN's length, for the keypad", () => {
  it("is kept when the PIN is set and shown to the paired browser, never the PIN", async () => {
    const file = path.join(tmp(), "remote-lock.json");
    const lock = new PinLock({ file });
    expect(lock.state("p").pinLength).toBeUndefined();
    await lock.setPin("482915");
    lock.configure({ whole: true });
    expect(lock.state("p").pinLength).toBe(6);
    expect(new PinLock({ file }).state("p").pinLength).toBe(6);
    lock.removePin();
    expect(lock.state("p").pinLength).toBeUndefined();
  });

  it("is learned from the first right PIN when it was set before the length was kept", async () => {
    const file = path.join(tmp(), "remote-lock.json");
    const lock = new PinLock({ file });
    await lock.setPin("1234");
    lock.configure({ whole: true });
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    delete raw.length;
    fs.writeFileSync(file, JSON.stringify(raw));
    const old = new PinLock({ file });
    expect(old.state("p").pinLength).toBeUndefined();
    expect((await old.unlock("p", "9999")).ok).toBe(false);
    expect(old.state("p").pinLength).toBeUndefined();
    expect((await old.unlock("p", "1234")).ok).toBe(true);
    expect(old.state("p").pinLength).toBe(4);
  });
});

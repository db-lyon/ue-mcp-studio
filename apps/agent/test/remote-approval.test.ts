/**
 * A browser that scanned a pairing code is not paired until the owner allows
 * it on the computer: allowed, denied, timed out, a stranger racing the owner,
 * and codes that outlive a daemon restart. RemoteService directly, no relay.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PAIR_APPROVAL_TTL_MS, b64u, exportPublic, generateKeyPair, keyId, listedPairingCode, pairCommit, pairingCode, pairingMac, randomBytes } from "@ue-mcp-studio/remote";
import { ComputerKeys, type PairedPhone } from "../src/remote/keys.js";
import { RemoteService, type CallSink, type PairingApproval } from "../src/remote/service.js";

interface Answer {
  status?: number;
  body?: Record<string, unknown>;
  failed?: { status: number; error: string };
}

function sink(): { s: CallSink; done: Promise<Answer> } {
  const a: Answer = {};
  const bytes: Uint8Array[] = [];
  let finish!: (x: Answer) => void;
  const done = new Promise<Answer>((r) => (finish = r));
  const s: CallSink = {
    head: (status) => void (a.status = status),
    chunk: async (b) => void bytes.push(b),
    end: () => finish({ ...a, body: JSON.parse(Buffer.concat(bytes).toString()) as Record<string, unknown> }),
    fail: (status, error) => finish({ failed: { status, error } }),
  };
  return { s, done };
}

let dir = "";
let clock = 0;
let approvals: PairingApproval[] = [];
let paired: PairedPhone[] = [];

function service(keys = new ComputerKeys(path.join(dir, "computer"))): RemoteService {
  return new RemoteService({
    keys,
    deviceId: "dev-1",
    daemon: () => null,
    pendingFile: path.join(dir, "project", "pairing-secrets.json"),
    onApproval: (a) => approvals.push(a),
    onPaired: (p) => paired.push(p),
    now: () => clock,
  });
}

async function phone() {
  const pair = await generateKeyPair();
  const publicKey = await exportPublic(pair.publicKey);
  return { publicKey, id: await keyId(publicKey) };
}

async function enroll(svc: RemoteService, keys: ComputerKeys, secret: string, p: { publicKey: string }): Promise<Answer> {
  const me = await keys.identity();
  const { s, done } = sink();
  await svc.enroll(JSON.stringify({ phonePublic: p.publicKey, mac: await pairingMac(secret, p.publicKey, me.publicKey), label: "Android" }), s);
  return done;
}

async function poll(svc: RemoteService, approval: string): Promise<Answer> {
  const { s, done } = sink();
  await svc.enroll(JSON.stringify({ poll: approval }), s);
  return done;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-approval-"));
  clock = Date.parse("2026-11-03T12:00:00Z");
  approvals = [];
  paired = [];
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("pairing waits for the owner", () => {
  it("allowed: the browser waits with the same six digits the computer shows, then is paired", async () => {
    const keys = new ComputerKeys(path.join(dir, "computer"));
    const svc = service(keys);
    const secret = svc.newPairingSecret();
    const p = await phone();

    const first = await enroll(svc, keys, secret, p);
    expect(first.status).toBe(202);
    const approval = String(first.body!.approval);
    // Not paired yet: nothing on disk, nothing a sealed request could use.
    expect(keys.phones()).toEqual([]);
    expect(await keys.secretFor(p.id)).toBeNull();

    expect(svc.pendingApprovals()).toEqual([{ id: approval, label: "Android", code: await pairingCode(secret, p.publicKey), expiresAt: expect.any(String) }]);
    expect(approvals).toHaveLength(1);
    expect((await poll(svc, approval)).status).toBe(202);

    expect(await svc.decide(approval, true)).toMatchObject({ ok: true, phone: { id: p.id, label: "Android" } });
    expect(paired.map((x) => x.id)).toEqual([p.id]);
    const done = await poll(svc, approval);
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ phoneId: p.id, computerPublic: (await keys.identity()).publicKey });
    expect(keys.phones().map((x) => x.id)).toEqual([p.id]);
    expect(svc.pendingApprovals()).toEqual([]);
  });

  it("denied: never paired, the browser is told, and the code is spent", async () => {
    const keys = new ComputerKeys(path.join(dir, "computer"));
    const svc = service(keys);
    const secret = svc.newPairingSecret();
    const p = await phone();
    const approval = String((await enroll(svc, keys, secret, p)).body!.approval);

    expect(await svc.decide(approval, false)).toEqual({ ok: true });
    expect((await poll(svc, approval)).failed).toEqual({ status: 403, error: "The computer denied this device." });
    expect(keys.phones()).toEqual([]);
    expect(paired).toEqual([]);
    // Allowing afterwards does nothing, and the same code cannot start a new request.
    expect((await svc.decide(approval, true)).ok).toBe(false);
    expect((await enroll(svc, keys, secret, p)).failed?.status).toBe(403);
  });

  it("times out after two minutes: denied, and too late to allow", async () => {
    const keys = new ComputerKeys(path.join(dir, "computer"));
    const svc = service(keys);
    const secret = svc.newPairingSecret();
    const approval = String((await enroll(svc, keys, secret, await phone())).body!.approval);

    clock += PAIR_APPROVAL_TTL_MS + 1;
    expect(svc.pendingApprovals()).toEqual([]);
    expect((await svc.decide(approval, true)).ok).toBe(false);
    expect((await poll(svc, approval)).failed?.status).toBe(403);
    expect(keys.phones()).toEqual([]);
  });

  it("a stranger who scans first shows a different code than the owner's phone, and the owner's scan is refused", async () => {
    const keys = new ComputerKeys(path.join(dir, "computer"));
    const svc = service(keys);
    const secret = svc.newPairingSecret();
    const stranger = await phone();
    const owner = await phone();

    expect((await enroll(svc, keys, secret, stranger)).status).toBe(202);
    const [shown] = svc.pendingApprovals();
    // What the owner's phone would show for the same code is not what the computer shows.
    expect(shown.code).toBe(await pairingCode(secret, stranger.publicKey));
    expect(shown.code).not.toBe(await pairingCode(secret, owner.publicKey));
    // The code is spent, so the owner's phone is refused and the owner denies the stranger.
    expect((await enroll(svc, keys, secret, owner)).failed?.status).toBe(403);
    await svc.decide(shown.id, false);
    expect(keys.phones()).toEqual([]);
  });

  it("refuses a browser that did not read the code", async () => {
    const keys = new ComputerKeys(path.join(dir, "computer"));
    const svc = service(keys);
    svc.newPairingSecret();
    const forged = await enroll(svc, keys, "A".repeat(43), await phone());
    expect(forged.failed?.status).toBe(403);
    expect(approvals).toEqual([]);
  });

  it("a code shown before a daemon restart still works after it, and its secret file is private", async () => {
    const keys = new ComputerKeys(path.join(dir, "computer"));
    const secret = service(keys).newPairingSecret();
    const file = path.join(dir, "project", "pairing-secrets.json");
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o077).toBe(0);

    // A new process: a fresh service and key store on the same folders.
    const restartedKeys = new ComputerKeys(path.join(dir, "computer"));
    const restarted = service(restartedKeys);
    const first = await enroll(restarted, restartedKeys, secret, await phone());
    expect(first.status).toBe(202);
    // Used: gone from the file.
    expect(Object.keys(JSON.parse(fs.readFileSync(file, "utf-8")) as object)).toEqual([]);
  });

  it("drops expired code secrets", async () => {
    const keys = new ComputerKeys(path.join(dir, "computer"));
    const svc = service(keys);
    const old = svc.newPairingSecret();
    clock += 10 * 60_000 + 1;
    svc.newPairingSecret();
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, "project", "pairing-secrets.json"), "utf-8")) as object)).not.toContain(old);
    expect((await enroll(svc, keys, old, await phone())).failed?.status).toBe(403);
  });
});

describe("pairing from the account's list", () => {
  async function ask(svc: RemoteService, p: { publicKey: string }, commit: string): Promise<Answer> {
    const { s, done } = sink();
    await svc.enroll(JSON.stringify({ listed: true, phonePublic: p.publicKey, commit, label: "Android" }), s);
    return done;
  }
  async function reveal(svc: RemoteService, approval: string, nonce: string): Promise<Answer> {
    const { s, done } = sink();
    await svc.enroll(JSON.stringify({ poll: approval, reveal: nonce }), s);
    return done;
  }

  it("shows nothing until the client reveals its nonce, then the six digits the client computes, and pairs once allowed", async () => {
    const keys = new ComputerKeys(path.join(dir, "computer"));
    const svc = service(keys);
    const p = await phone();
    const nonce = b64u(randomBytes(32));

    const first = await ask(svc, p, await pairCommit(nonce));
    expect(first.status).toBe(202);
    const approval = String(first.body!.approval);
    const computerNonce = String(first.body!.nonce);
    expect(computerNonce).toMatch(/^[\w-]{43}$/);
    // Committed only: the owner sees nothing yet, and nothing is paired.
    expect(approvals).toEqual([]);
    expect(svc.pendingApprovals()).toEqual([]);

    expect((await reveal(svc, approval, nonce)).status).toBe(202);
    const me = await keys.identity();
    const expected = await listedPairingCode(p.publicKey, me.publicKey, computerNonce, nonce);
    expect(approvals).toEqual([expect.objectContaining({ id: approval, code: expected, label: "Android" })]);
    // A later poll does not raise it again.
    expect((await poll(svc, approval)).status).toBe(202);
    expect(approvals).toHaveLength(1);

    expect((await svc.decide(approval, true)).ok).toBe(true);
    const done = await poll(svc, approval);
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ phoneId: p.id, computerPublic: me.publicKey });
    expect(await keys.secretFor(p.id)).not.toBeNull();
  });

  it("ends the request when the revealed nonce is not the one committed to", async () => {
    const keys = new ComputerKeys(path.join(dir, "computer"));
    const svc = service(keys);
    const p = await phone();
    const first = await ask(svc, p, await pairCommit(b64u(randomBytes(32))));
    const approval = String(first.body!.approval);
    expect((await reveal(svc, approval, b64u(randomBytes(32)))).failed?.status).toBe(403);
    expect(approvals).toEqual([]);
    expect((await poll(svc, approval)).failed?.status).toBe(403);
    expect(keys.phones()).toEqual([]);
  });

  it("refuses a malformed commitment", async () => {
    const svc = service();
    expect((await ask(svc, await phone(), "short")).failed?.status).toBe(400);
  });
});

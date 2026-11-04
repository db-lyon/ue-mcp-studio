/**
 * Remote control in one process: the real routes, connector and computer-side
 * service against a fake relay and a fake daemon, and a browser that is the
 * ported e2e code. Every frame on the relay's socket is recorded, to show the
 * relay never carries plaintext.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import type { DaemonExtensionApi, ExtensionHandler } from "ue-mcp/daemon";
import {
  ResponseOpener,
  decodeChunk,
  exportPublic,
  generateKeyPair,
  keyId,
  pairingCode,
  pairingMac,
  parseFrame,
  parsePairingFragment,
  sealRequest,
  sharedSecret,
  type ConnectorFrame,
  type OpenedFrame,
  type PlainRequest,
  type RelayFrame,
} from "@ue-mcp-studio/remote";
import type { RemoteStatus } from "@ue-mcp-studio/shared";
import { registerRemote, deviceId } from "../src/remote/routes.js";
import { NO_PLAN, PLAN_LAPSED_CLOSE } from "../src/remote/connector.js";
import type { PlanCheck } from "../src/remote/plan.js";
import { shareBusy } from "../src/busy-sources.js";
import { AccountSource } from "../src/account-source.js";
import { ACCOUNT_SIGNED_OUT, REMOTE_SIGN_IN_AGAIN } from "@ue-mcp-studio/shared";

const DAEMON_TOKEN = "d".repeat(32);
const MARKER = "PLAINTEXT-MARKER-c0ffee";
const NO_PLAN_BODY = { error: "Remote control needs a Pro or Studio plan on this account." };

/** The gateway's answer, as the routes see it: paid or not, and how it was asked. */
class FakePlan implements PlanCheck {
  asks: boolean[] = [];
  invalidated = 0;
  constructor(public paid = false) {}
  async available(force = false): Promise<boolean> {
    this.asks.push(force);
    return this.paid;
  }
  invalidate(): void {
    this.invalidated++;
  }
}

const listen = (server: http.Server): Promise<number> => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));

/** Resolved by every frame the fake relay receives, so a wait wakes when there is something to see rather than on a timer. */
let wake: Array<() => void> = [];
function woken(): void {
  for (const w of wake.splice(0)) w();
}
/** The next frame, or 20 ms, whichever is first. */
const tick = () => new Promise<void>((r) => {
  wake.push(r);
  setTimeout(r, 20);
});

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await tick();
  }
}

// ── The daemon a browser's requests reach ─────────────────────────
const daemonHits: Array<{ method: string; url: string; auth?: string; cookie?: string }> = [];
const daemon = http.createServer((req, res) => {
  daemonHits.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, cookie: req.headers.cookie });
  if (req.headers.authorization !== `Bearer ${DAEMON_TOKEN}`) return void res.writeHead(401).end();
  if (req.url === "/ui/") return void res.writeHead(200, { "content-type": "text/html", "set-cookie": "leak=1" }).end(`<!doctype html><title>Studio ${MARKER}</title>`);
  if (req.url === "/v1/events?silent=1") {
    // A quiet project: the stream opens and then says nothing.
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
    return;
  }
  if (req.url === "/v1/events") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`id: 1\nevent: hello\ndata: {"m":"${MARKER}"}\n\n`);
    const t = setInterval(() => res.write(`id: 2\nevent: tick\ndata: {}\n\n`), 30);
    req.on("close", () => clearInterval(t));
    return;
  }
  if (req.url === "/v1/ext/studio/echo" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end(body));
    return;
  }
  res.writeHead(404).end();
});

// ── The relay: the connector's socket, /api/pair, and calls it routes ──
interface Call {
  status?: number;
  headers?: Record<string, string>;
  bytes: Buffer[];
  ended: boolean;
  failed?: { status: number; error: string };
}
const relay = {
  /** Say hello with `binary`, as the deployed relay does, so chunks come as binary frames. */
  binary: false,
  mode: "allow" as "allow" | "deny",
  pairMode: "allow" as "allow" | "deny",
  upgrades: [] as http.IncomingHttpHeaders[],
  socket: null as WebSocket | null,
  wire: [] as string[],
  calls: new Map<string, Call>(),
  next: 0,
  base: "",
};
const relayServer = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/pair") {
    if (req.headers.authorization !== "Bearer uemcp_dev") return void res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "Sign in" }));
    if (relay.pairMode === "deny") return void res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify(NO_PLAN_BODY));
    return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ url: `${relay.base}/pair#RELAYCODE`, code: "RELAYCODE", expiresAt: "2030-01-01T00:00:00.000Z" }));
  }
  res.writeHead(404).end();
});
const wss = new WebSocketServer({ noServer: true });
relayServer.on("upgrade", (req, socket, head) => {
  relay.upgrades.push(req.headers);
  if (req.url !== "/connect" || req.headers.authorization !== "Bearer uemcp_dev") return void socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
  if (relay.mode === "deny") return void socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 9\r\n\r\nForbidden");
  wss.handleUpgrade(req, socket, head, (ws) => {
    relay.socket = ws;
    ws.on("message", (data, isBinary) => {
      woken();
      if (isBinary) {
        const bytes = Buffer.from(data as Buffer);
        relay.wire.push(bytes.toString("latin1"));
        const chunk = decodeChunk(new Uint8Array(bytes));
        const c = chunk && relay.calls.get(chunk.id);
        if (c) c.bytes.push(Buffer.from(chunk.data));
        return;
      }
      relay.wire.push(String(data));
      const f = parseFrame<ConnectorFrame>(data);
      const c = f && relay.calls.get(f.id);
      if (!f || !c) return;
      if (f.t === "head") Object.assign(c, { status: f.status, headers: f.headers });
      else if (f.t === "chunk") c.bytes.push(Buffer.from(f.data, "base64"));
      else if (f.t === "end") c.ended = true;
      else c.failed = { status: f.status, error: f.error };
    });
    ws.on("close", () => relay.socket === ws && (relay.socket = null));
    send({ t: "hello", deviceId: String(req.headers["x-ue-mcp-device"]), login: "dev", ...(relay.binary ? { binary: true } : {}) });
  });
});
function send(frame: RelayFrame): void {
  const s = JSON.stringify(frame);
  relay.wire.push(s);
  relay.socket!.send(s);
}
function call(kind: "sealed" | "enroll", body: string): { id: string; c: Call } {
  const id = `call-${relay.next++}`;
  const c: Call = { bytes: [], ended: false };
  relay.calls.set(id, c);
  send({ t: "call", id, kind, body });
  return { id, c };
}

// ── The computer: Studio's remote routes on a fake daemon api ─────
let root = "";
let base = 0;
interface Host {
  call: (key: string, body?: unknown, params?: Record<string, string>) => Promise<{ status?: number; body?: unknown }>;
  routes: Map<string, ExtensionHandler>;
  busy: () => boolean;
  events: Array<{ type: string; data: Record<string, unknown> }>;
  dataDir: string;
  computerDir: string;
  dispose: () => void;
}
const hosts: Host[] = [];

/** A paid account unless a plan is given. */
function host(o: { plan?: PlanCheck; signedIn?: boolean; enabled?: boolean; planRecheckMs?: number; account?: AccountSource; owns?: () => boolean; keepaliveMs?: number } = {}): Host {
  const projectDir = fs.mkdtempSync(path.join(root, "proj-"));
  fs.writeFileSync(path.join(projectDir, "Game.uproject"), "{}");
  const dataDir = path.join(root, "home", "data", path.basename(projectDir), "studio");
  fs.mkdirSync(dataDir, { recursive: true });
  const computerDir = path.join(root, "home", "remote");
  if (o.enabled) {
    fs.mkdirSync(path.join(dataDir, "remote"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "remote", "remote.json"), JSON.stringify({ enabled: true }));
  }
  const routes = new Map<string, ExtensionHandler>();
  const events: Host["events"] = [];
  let busy: () => boolean = () => false;
  const api = {
    projectDir,
    dataDir,
    route: (method: string, p: string, h: ExtensionHandler) => void routes.set(`${method} ${p}`, h),
    setBusy: (fn: () => boolean) => void (busy = fn),
    events: { publish: (type: string, data: Record<string, unknown>) => void events.push({ type, data }) },
    registryAccount: async () => (o.signedIn === false ? null : { login: "dev", token: "uemcp_dev", registry: "https://registry.invalid" }),
    log: { info() {}, warn() {}, error() {} },
  } as unknown as DaemonExtensionApi;
  const port = (daemon.address() as AddressInfo).port;
  const r = registerRemote(shareBusy(api), {
    account: o.account,
    plan: o.plan ?? new FakePlan(true),
    planRecheckMs: o.planRecheckMs,
    computerDir,
    daemon: () => ({ port, token: DAEMON_TOKEN }),
    env: { UE_MCP_REMOTE_RELAY: relay.base },
    refusedRetryMs: 60_000,
    owns: o.owns,
    keepaliveMs: o.keepaliveMs,
  });
  const h: Host = {
    routes,
    events,
    dataDir,
    computerDir,
    busy: () => busy(),
    dispose: r.dispose,
    call: async (key, body, params = {}) => (await routes.get(key)!({ method: "", path: "", params, query: {}, headers: {}, body } as never)) ?? {},
  };
  hosts.push(h);
  return h;
}
const status = async (h: Host) => (await h.call("GET /remote/status")).body as RemoteStatus;

// ── A browser: its own key pair and the ported sealing ─────────────
class Browser {
  keyPair!: CryptoKeyPair;
  publicKey = "";
  id = "";
  secret!: CryptoKey;
  device = "";

  static async make(): Promise<Browser> {
    const b = new Browser();
    b.keyPair = await generateKeyPair();
    b.publicKey = await exportPublic(b.keyPair.publicKey);
    b.id = await keyId(b.publicKey);
    return b;
  }

  /** The code from the scanned link, kept for the six digits this browser shows. */
  codeSecret = "";

  /** What a scanned link leads to: the MAC under the fragment's secret, sent as the relay sends an enrollment. Answers 202 until the owner decides. */
  async enroll(url: string, device: string): Promise<Call> {
    const parts = parsePairingFragment(new URL(url).hash)!;
    this.device = device;
    this.codeSecret = parts.secret;
    this.secret = await sharedSecret(this.keyPair.privateKey, parts.computerPublic);
    const { c } = call("enroll", JSON.stringify({ phonePublic: this.publicKey, mac: await pairingMac(parts.secret, this.publicKey, parts.computerPublic), label: "Android" }));
    await until(() => c.ended || !!c.failed);
    return c;
  }

  /** Ask the computer again how the owner answered. */
  async poll(approval: string): Promise<Call> {
    const { c } = call("enroll", JSON.stringify({ poll: approval }));
    await until(() => c.ended || !!c.failed);
    return c;
  }

  /** The six digits this browser shows while it waits. */
  code(): Promise<string> {
    return pairingCode(this.codeSecret, this.publicKey);
  }

  /** Scan, have the owner allow it on host h, and return the computer's final answer. */
  async pair(url: string, device: string, h: Host): Promise<Call> {
    const first = await this.enroll(url, device);
    if (first.failed || first.status !== 202) return first;
    const { approval } = JSON.parse(Buffer.concat(first.bytes).toString()) as { approval: string };
    const allowed = await h.call("POST /remote/approvals/:id", { allow: true }, { id: approval });
    if (allowed.status) throw new Error(`approval refused: ${JSON.stringify(allowed.body)}`);
    return this.poll(approval);
  }

  async seal(over: Partial<PlainRequest>) {
    const req: PlainRequest = { id: crypto.randomUUID(), ts: Date.now(), device: this.device, method: "GET", path: "/ui/", headers: {}, ...over };
    return sealRequest(this.secret, this.id, req);
  }

  /** Send a sealed request and open what comes back. */
  async request(over: Partial<PlainRequest>, wait: (frames: OpenedFrame[], c: Call) => boolean = (_f, c) => c.ended || !!c.failed) {
    const { sealed, responseKey } = await this.seal(over);
    const { id, c } = call("sealed", JSON.stringify(sealed));
    const opener = new ResponseOpener(responseKey);
    const frames: OpenedFrame[] = [];
    let read = 0;
    const pump = async () => {
      while (read < c.bytes.length) frames.push(...(await opener.push(c.bytes[read++])));
    };
    const end = Date.now() + 5000;
    for (;;) {
      await pump();
      if (wait(frames, c)) break;
      if (Date.now() > end) throw new Error("timed out");
      await tick();
    }
    const head = frames.find((f) => f.kind === "head") as Extract<OpenedFrame, { kind: "head" }> | undefined;
    const text = () => Buffer.concat(frames.filter((f) => f.kind === "data").map((f) => Buffer.from((f as { data: Uint8Array }).data))).toString();
    return { id, c, head: head?.head, text, frames, opener, pump };
  }
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-remote-"));
  await listen(daemon);
  base = await listen(relayServer);
  relay.base = `http://127.0.0.1:${base}`;
});

afterEach(() => {
  for (const h of hosts.splice(0)) h.dispose();
  relay.binary = false;
  relay.mode = "allow";
  relay.pairMode = "allow";
});

afterAll(async () => {
  wss.close();
  relayServer.closeAllConnections();
  await new Promise((r) => relayServer.close(r));
  daemon.closeAllConnections();
  await new Promise((r) => daemon.close(r));
  fs.rmSync(root, { recursive: true, force: true });
});

const REMOTE_ROUTES = ["DELETE /remote/browsers/:id", "GET /remote/approvals", "GET /remote/browsers", "POST /remote/approvals/:id", "GET /remote/status", "POST /remote/pair", "PUT /remote/config", "GET /remote/lock", "PUT /remote/lock", "PUT /remote/lock/pin", "DELETE /remote/lock/pin"];
const available = async (h: Host, refresh = false) =>
  ((await h.routes.get("GET /remote/available")!({ method: "GET", path: "", params: {}, query: refresh ? { refresh: "1" } : {}, headers: {}, body: undefined } as never))!.body as { available: boolean }).available;
const settle = () => new Promise((r) => setTimeout(r, 100));

describe("remote control, offered or not", () => {
  it("without a paid plan: every route answers 404, no socket even when turned on, no busy check", async () => {
    const before = relay.upgrades.length;
    const h = host({ plan: new FakePlan(false), enabled: true });
    await settle();
    expect(await available(h)).toBe(false);
    for (const key of REMOTE_ROUTES) expect((await h.call(key, { enabled: true }, { id: "x" })).status, key).toBe(404);
    expect(relay.upgrades.length).toBe(before);
    expect(h.busy()).toBe(false);
    expect(h.events.some((e) => e.type === "remote.available")).toBe(false);
  });

  it("with a paid plan: the routes answer and a turned-on project connects", async () => {
    const h = host({ plan: new FakePlan(true), enabled: true });
    await until(() => relay.socket !== null);
    await until(() => h.busy());
    expect(await available(h)).toBe(true);
    expect(await status(h)).toMatchObject({ enabled: true, state: "online" });
    expect(h.events).toContainEqual({ type: "remote.available", data: { available: true } });
  });

  it("asks the gateway afresh when Settings opens with ?refresh, and reads the cache otherwise", async () => {
    const plan = new FakePlan(false);
    const h = host({ plan });
    await settle();
    plan.asks = [];
    await available(h);
    await available(h, true);
    expect(plan.asks).toEqual([false, true]);
  });

  it("connects as soon as ?refresh finds a plan bought after start, without waiting for the recheck timer", async () => {
    const plan = new FakePlan(false);
    const h = host({ plan, enabled: true, planRecheckMs: 3_600_000 });
    await settle();
    expect(relay.socket).toBeNull();
    plan.paid = true;
    expect(await available(h, true)).toBe(true);
    expect(plan.asks.at(-1)).toBe(true);
    await until(() => relay.socket !== null);
    expect(await status(h)).toMatchObject({ enabled: true, state: "online" });
    expect(h.events).toContainEqual({ type: "remote.available", data: { available: true } });
  });

  it("starts the connector when the plan appears and stops it when it lapses, without a restart", async () => {
    const plan = new FakePlan(false);
    const h = host({ plan, enabled: true, planRecheckMs: 30 });
    await settle();
    expect(relay.socket).toBeNull();
    plan.paid = true;
    await until(() => relay.socket !== null);
    await until(() => h.busy());
    expect(await status(h)).toMatchObject({ enabled: true, state: "online" });
    plan.paid = false;
    await until(() => relay.socket === null);
    expect(h.busy()).toBe(false);
    expect((await h.call("GET /remote/status")).status).toBe(404);
    expect(h.events.filter((e) => e.type === "remote.available").map((e) => e.data.available)).toEqual([true, false]);
  });

  it("from /remote in the chat: turned on, refuses a code until online, then hands one out", async () => {
    const h = host();
    expect(await status(h)).toMatchObject({ enabled: false, state: "off" });
    await h.call("PUT /remote/config", { enabled: true });
    const early = await h.call("POST /remote/pair");
    if (early.status !== undefined) expect(early.status).toBe(409);
    await until(() => relay.socket !== null);
    await until(() => h.busy());
    expect(await status(h)).toMatchObject({ enabled: true, state: "online" });
    const pairing = (await h.call("POST /remote/pair")).body as { url: string; svg: string; expiresAt: string };
    expect(pairing.svg).toMatch(/^<svg/);
    expect(pairing.expiresAt).toBe("2030-01-01T00:00:00.000Z");
  });

  it("is off until turned on: no socket to the relay, and pairing waits for it", async () => {
    const before = relay.upgrades.length;
    const h = host();
    expect([...h.routes.keys()].sort()).toEqual(["GET /remote/available", "GET /lock", ...REMOTE_ROUTES].sort());
    expect(await status(h)).toEqual({ enabled: false, relay: relay.base, state: "off" });
    expect((await h.call("POST /remote/pair")).status).toBe(409);
    expect((await h.call("PUT /remote/config", { enabled: "yes" })).status).toBe(400);
    await new Promise((r) => setTimeout(r, 100));
    expect(relay.upgrades.length).toBe(before);
  });
});

describe("remote control, sealed end to end", () => {
  it("connects, pairs a browser, carries its requests, refuses remote control's own routes, and cuts it off on revoke", async () => {
    const h = host();
    expect((await h.call("PUT /remote/config", { enabled: true })).status).toBeUndefined();
    await until(() => relay.socket !== null);
    await until(() => h.busy());
    const s = await status(h);
    expect(s).toMatchObject({ enabled: true, state: "online", login: "dev" });
    expect(h.events.at(-1)).toMatchObject({ type: "remote.status", data: { state: "online" } });

    // The upgrade names this project and this computer.
    const device = JSON.parse(fs.readFileSync(path.join(h.dataDir, "remote", "device.json"), "utf-8")).id as string;
    const computerKey = JSON.parse(fs.readFileSync(path.join(h.computerDir, "computer-key.json"), "utf-8")).publicKey as string;
    const up = relay.upgrades.at(-1)!;
    expect(up["x-ue-mcp-device"]).toBe(device);
    expect(up["x-ue-mcp-computer-key"]).toBe(computerKey);
    expect(up["x-ue-mcp-device-name"]).toMatch(/^Game on /);
    expect(JSON.parse(fs.readFileSync(path.join(h.dataDir, "remote", "remote.json"), "utf-8"))).toEqual({ enabled: true });

    // Pair: the link's fragment carries the relay code, this computer's key and a one-time secret.
    const pairing = (await h.call("POST /remote/pair")).body as { url: string; svg: string; expiresAt: string };
    expect(pairing.svg).toMatch(/^<svg/);
    expect(pairing.url.startsWith(`${relay.base}/pair#RELAYCODE.${computerKey}.`)).toBe(true);
    expect(pairing.expiresAt).toBe("2030-01-01T00:00:00.000Z");
    const browser = await Browser.make();
    const enrolled = await browser.pair(pairing.url, device, h);
    expect(enrolled.failed).toBeUndefined();
    expect(JSON.parse(Buffer.concat(enrolled.bytes).toString())).toEqual({ phoneId: browser.id, computerPublic: computerKey });
    expect(((await h.call("GET /remote/browsers")).body as { browsers: unknown[] }).browsers).toEqual([{ id: browser.id, label: "Android", addedAt: expect.any(String) }]);

    // The code works once.
    const again = await (await Browser.make()).pair(pairing.url, device, h);
    expect(again.failed?.status).toBe(403);

    // Requests reach the daemon with its token, and nothing of theirs crosses the relay in the clear.
    const ui = await browser.request({ path: "/ui/", headers: { cookie: "relay=1", accept: "text/html" } });
    expect(ui.head).toEqual({ status: 200, headers: { "content-type": "text/html" } });
    expect(ui.text()).toContain(MARKER);
    expect(ui.opener.finished).toBe(true);
    const hit = daemonHits.at(-1)!;
    expect(hit).toMatchObject({ method: "GET", url: "/ui/", auth: `Bearer ${DAEMON_TOKEN}` });
    expect(hit.cookie).toBeUndefined();
    const echo = await browser.request({ method: "POST", path: "/v1/ext/studio/echo", headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ m: MARKER })).toString("base64") });
    expect(JSON.parse(echo.text())).toEqual({ m: MARKER });
    expect(relay.wire.join("\n")).not.toContain(MARKER);
    expect(relay.wire.join("\n")).not.toContain("/v1/ext/studio/echo");

    // A paired browser cannot reach remote control itself: no pairing others, no turning it off, no revoking.
    const hits = daemonHits.length;
    for (const [method, p] of [
      ["POST", "/v1/ext/studio/remote/pair"],
      ["PUT", "/v1/ext/studio/remote/config"],
      ["DELETE", `/v1/ext/studio/remote/browsers/${browser.id}`],
      ["GET", "/v1/ext/studio/remote/browsers"],
      ["GET", "/v1/ext/studio/remote/status"],
      // Nor answer another browser's request to be allowed.
      ["GET", "/v1/ext/studio/remote/approvals"],
      ["POST", "/v1/ext/studio/remote/approvals/anything"],
      ["POST", "/v1/ext/studio/Remote/approvals/anything"],
      ["POST", "/v1/ext/studio/Remote/pair"],
      ["POST", "/v1/ext/studio/x/../remote/pair"],
      // Nor install, update or restart software on the computer.
      ["POST", "/v1/ext/studio/updates/studio"],
      ["POST", "/v1/ext/studio/updates/plugin"],
      ["POST", "/v1/ext/studio/updates/ueMcp"],
      ["POST", "/v1/ext/studio/updates/restart"],
      ["POST", "/v1/ext/studio/updates/deferred/now"],
      ["PUT", "/v1/ext/studio/updates/channel"],
      ["PUT", "/v1/ext/studio/updates/run"],
      ["POST", "/v1/ext/studio/Updates/studio"],
      ["POST", "/v1/ext/studio/sessions/../updates/ueMcp"],
      ["POST", "/v1/ext/studio/refusal/update"],
      ["POST", "/v1/ext/studio/version-notice/update"],
      ["POST", "/v1/update/apply"],
      // Nor change where prompts go or what ue-mcp runs.
      ["POST", "/v1/ext/studio/endpoints"],
      ["PUT", "/v1/ext/studio/endpoints/abc"],
      ["DELETE", "/v1/ext/studio/endpoints/abc"],
      ["POST", "/v1/ext/studio/endpoints/abc/models"],
      ["POST", "/v1/ext/studio/signin/claude"],
      ["DELETE", "/v1/ext/studio/signin/claude"],
      ["PUT", "/v1/ext/studio/config"],
      ["PUT", "/v1/ext/studio/Config/"],
      ["PUT", "/v1/ext/studio/context-strategy"],
    ]) {
      const r = await browser.request({ method, path: p, body: method === "PUT" ? Buffer.from('{"enabled":false}').toString("base64") : undefined });
      expect(r.head?.status, `${method} ${p}`).toBe(403);
      expect(JSON.parse(r.text())).toEqual({ error: "Not available remotely." });
    }
    // Settings that move prompts, keys or approvals are refused by their fields; everyday ones go through.
    for (const body of [{ gatewayUrl: "https://evil.example" }, { keys: { anthropic: "sk-x" } }, { approvals: { shell: "anywhere" } }, { theme: "editor", signOut: "studio" }]) {
      const r = await browser.request({ method: "PUT", path: "/v1/ext/studio/settings", headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(body)).toString("base64") });
      expect(r.head?.status, JSON.stringify(body)).toBe(403);
    }
    expect(daemonHits.length).toBe(hits);
    await browser.request({ method: "PUT", path: "/v1/ext/studio/settings", headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ theme: "editor" })).toString("base64") });
    expect(daemonHits.at(-1)).toMatchObject({ method: "PUT", url: "/v1/ext/studio/settings" });
    expect(daemonHits.length).toBe(hits + 1);
    expect(keys(h)).toEqual([browser.id]);
    expect((await status(h)).enabled).toBe(true);

    // Replays and requests meant for another project are refused before anything runs.
    const { sealed } = await browser.seal({ path: "/ui/" });
    const first = call("sealed", JSON.stringify(sealed)).c;
    await until(() => first.ended);
    const replay = call("sealed", JSON.stringify(sealed)).c;
    await until(() => !!replay.failed);
    expect(replay.failed?.status).toBe(403);
    const elsewhere = await browser.request({ device: "7a2d3b63-1f54-4a8f-8b62-9e2f3a4b5c6d" });
    expect(elsewhere.c.failed?.status).toBe(403);

    // Revoking a browser ends the stream it has open, without a final frame, and refuses its next request.
    const stream = await browser.request({ path: "/v1/events", headers: { accept: "text/event-stream" } }, (f) => f.some((x) => x.kind === "data"));
    expect(stream.text()).toContain("event: hello");
    expect((await h.call("DELETE /remote/browsers/:id", undefined, { id: browser.id })).status).toBe(204);
    await until(() => stream.c.ended || !!stream.c.failed);
    await stream.pump();
    expect(stream.opener.finished).toBe(false);
    expect(keys(h)).toEqual([]);
    const after = await browser.request({ path: "/ui/" });
    expect(after.c.failed).toEqual({ status: 403, error: "This browser is not paired with that computer. Scan its pairing code again." });
    expect((await h.call("DELETE /remote/browsers/:id", undefined, { id: browser.id })).status).toBe(404);

    // Off closes the socket and lets the daemon idle again.
    expect((await h.call("PUT /remote/config", { enabled: false })).body).toEqual({ enabled: false, relay: relay.base, state: "off" });
    await until(() => relay.socket === null);
    expect(h.busy()).toBe(false);
    // About 30 sealed round trips with key agreement; alone it takes under a second, beside the full suite's workers several.
  }, 20_000);

  it("with a relay that reads binary frames, sends chunks as binary, and gzips text for a browser that opens it", async () => {
    relay.binary = true;
    const h = host();
    await h.call("PUT /remote/config", { enabled: true });
    await until(() => relay.socket !== null && h.busy());
    const device = JSON.parse(fs.readFileSync(path.join(h.dataDir, "remote", "device.json"), "utf-8")).id as string;
    const pairing = (await h.call("POST /remote/pair")).body as { url: string };
    const browser = await Browser.make();
    expect((await browser.pair(pairing.url, device, h)).failed).toBeUndefined();
    const before = relay.wire.length;

    // Asked for gzip: the head says so, the body opens to the page, and chunks went as binary frames.
    const zipped = await browser.request({ path: "/ui/", accept: ["gzip"] });
    expect(zipped.head).toEqual({ status: 200, headers: { "content-type": "text/html", "content-encoding": "gzip" } });
    const raw = Buffer.concat(zipped.frames.filter((f) => f.kind === "data").map((f) => Buffer.from((f as { data: Uint8Array }).data)));
    expect(zlib.gunzipSync(raw).toString()).toContain(MARKER);
    expect(relay.wire.slice(before).some((w) => w.startsWith('{"t":"chunk"'))).toBe(false);
    expect(relay.wire.join("\n")).not.toContain(MARKER);

    // Not asked: sent as the daemon wrote it.
    const plain = await browser.request({ path: "/ui/" });
    expect(plain.head).toEqual({ status: 200, headers: { "content-type": "text/html" } });
    expect(plain.text()).toContain(MARKER);

    // An event stream is never compressed, so each event arrives as it is written.
    const stream = await browser.request({ path: "/v1/events", headers: { accept: "text/event-stream" }, accept: ["gzip"] }, (f) => f.some((x) => x.kind === "data"));
    expect(stream.head?.headers["content-encoding"]).toBeUndefined();
    expect(stream.text()).toContain("event: hello");
  });
});

function keys(h: Host): string[] {
  const file = path.join(h.computerDir, "phones.json");
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf-8")) as Array<{ id: string }>).map((p) => p.id) : [];
}

describe("a quiet event stream through the relay", () => {
  it("gets a keepalive comment while the project has nothing to say, so no proxy closes it as idle", async () => {
    const h = host({ keepaliveMs: 60 });
    await h.call("PUT /remote/config", { enabled: true });
    await until(() => relay.socket !== null);
    await until(() => h.events.some((e) => e.data.state === "online"));
    const device = JSON.parse(fs.readFileSync(path.join(h.dataDir, "remote", "device.json"), "utf-8")).id as string;
    const pairing = (await h.call("POST /remote/pair")).body as { url: string };
    const browser = await Browser.make();
    expect((await browser.pair(pairing.url, device, h)).failed).toBeUndefined();
    const stream = await browser.request({ path: "/v1/events?silent=1", headers: { accept: "text/event-stream" } }, (f) => f.filter((x) => x.kind === "data").length >= 2);
    expect(stream.head?.status).toBe(200);
    expect(stream.text()).toContain(": keepalive\n\n");
  }, 20_000);
});

describe("an account without remote control in its plan", () => {
  it("shows as no-plan when the relay refuses the socket with 403, and pairing says the same", async () => {
    relay.mode = "deny";
    const h = host();
    await h.call("PUT /remote/config", { enabled: true });
    await until(() => h.events.some((e) => e.data.state === "error"));
    expect(await status(h)).toEqual({ enabled: true, relay: relay.base, state: "error", reason: NO_PLAN, code: "no-plan" });
    expect(h.busy()).toBe(false);
    expect(await h.call("POST /remote/pair")).toEqual({ status: 403, body: { error: NO_PLAN, code: "no-plan" } });
  });

  it("shows as no-plan when the relay drops a live socket with close code 4003", async () => {
    const h = host();
    await h.call("PUT /remote/config", { enabled: true });
    await until(() => h.busy());
    relay.socket!.close(PLAN_LAPSED_CLOSE, "plan lapsed");
    await until(() => h.events.some((e) => e.data.state === "error"));
    expect(await status(h)).toEqual({ enabled: true, relay: relay.base, state: "error", reason: NO_PLAN, code: "no-plan" });
    expect(h.busy()).toBe(false);
    expect(await h.call("POST /remote/pair")).toEqual({ status: 403, body: { error: NO_PLAN, code: "no-plan" } });
  });

  it("a 4003 asks the gateway again at once, and a lapsed plan takes remote control away", async () => {
    const plan = new FakePlan(true);
    const h = host({ plan, enabled: true });
    await until(() => h.busy());
    plan.paid = false;
    relay.socket!.close(PLAN_LAPSED_CLOSE, "plan lapsed");
    await until(() => h.events.some((e) => e.type === "remote.available" && e.data.available === false));
    expect(plan.invalidated).toBeGreaterThan(0);
    expect(plan.asks.at(-1)).toBe(true);
    expect((await h.call("GET /remote/status")).status).toBe(404);
    expect(await available(h)).toBe(false);
    expect(h.busy()).toBe(false);
  });

  it("a 403 upgrade on an account the gateway still calls paid shows no-plan", async () => {
    relay.mode = "deny";
    const plan = new FakePlan(true);
    const h = host({ plan, enabled: true });
    await until(() => h.events.some((e) => e.data.state === "error"));
    await settle();
    expect(await status(h)).toMatchObject({ state: "error", code: "no-plan", reason: NO_PLAN });
    expect(plan.invalidated).toBeGreaterThan(0);
  });

  it("shows as no-plan when the relay refuses /api/pair with 403", async () => {
    relay.pairMode = "deny";
    const h = host();
    await h.call("PUT /remote/config", { enabled: true });
    await until(() => h.busy());
    expect(await h.call("POST /remote/pair")).toEqual({ status: 403, body: { error: NO_PLAN, code: "no-plan" } });
  });

  it("says so when this computer is not signed in", async () => {
    const h = host({ signedIn: false });
    await h.call("PUT /remote/config", { enabled: true });
    await until(() => h.events.some((e) => e.data.state === "error"));
    expect(await status(h)).toMatchObject({ state: "error", code: "signed-out", reason: ACCOUNT_SIGNED_OUT });
    expect(await h.call("POST /remote/pair")).toEqual({ status: 401, body: { error: ACCOUNT_SIGNED_OUT, code: "signed-out" } });
  });
});

/** A panel sign-in that tests change, beside a `ue-mcp login` account. */
class Panel {
  token: string | null = null;
  login: string | null = null;
  accountToken = () => this.token;
  accountLogin = () => this.login;
}

/** The gateway's answer for whichever token the account source holds: paid for the tokens listed. */
class TokenPlan implements PlanCheck {
  invalidated = 0;
  constructor(private readonly account: AccountSource, public paid = new Set(["uemcp_dev"])) {}
  async available(): Promise<boolean> {
    const t = await this.account.token();
    return t !== null && this.paid.has(t);
  }
  invalidate(): void {
    this.invalidated++;
  }
}

describe("the account remote control uses", () => {
  it("the connector sends the panel sign-in's token ahead of the ue-mcp login one", async () => {
    const panel = new Panel();
    panel.token = "uemcp_dev";
    const registry = { login: "cli", token: "uemcp_cli" };
    const account = new AccountSource(panel, async () => registry);
    const h = host({ account, plan: new FakePlan(true), enabled: true });
    await until(() => h.busy());
    expect(relay.upgrades.at(-1)!.authorization).toBe("Bearer uemcp_dev");
    expect(await status(h)).toMatchObject({ state: "online" });
  });

  it("the ue-mcp login token when the panel has none", async () => {
    const account = new AccountSource(new Panel(), async () => ({ login: "dev", token: "uemcp_dev" }));
    const h = host({ account, plan: new FakePlan(true), enabled: true });
    await until(() => h.busy());
    expect(relay.upgrades.at(-1)!.authorization).toBe("Bearer uemcp_dev");
  });

  it("a panel sign-in starts it and a sign-out stops it, without a restart, asking the gateway afresh each time", async () => {
    const panel = new Panel();
    const account = new AccountSource(panel, async () => null);
    const plan = new TokenPlan(account);
    const h = host({ account, plan, enabled: true });
    await settle();
    expect(relay.socket).toBeNull();
    expect((await h.routes.get("GET /remote/available")!({ query: {} } as never))!.body).toEqual({ available: false, signedIn: false });

    panel.token = "uemcp_dev";
    account.changed();
    await until(() => h.busy());
    expect(plan.invalidated).toBe(1);
    expect((await h.routes.get("GET /remote/available")!({ query: {} } as never))!.body).toEqual({ available: true, signedIn: true });

    panel.token = null;
    account.changed();
    await until(() => relay.socket === null && !h.busy());
    expect(plan.invalidated).toBe(2);
    expect((await h.call("GET /remote/status")).status).toBe(404);
    expect(h.events.filter((e) => e.type === "remote.available").map((e) => e.data.available)).toEqual([true, false]);
  });

  it("a switch to another paid account reconnects as that account", async () => {
    const panel = new Panel();
    panel.token = "uemcp_dev";
    const account = new AccountSource(panel, async () => null);
    const h = host({ account, plan: new TokenPlan(account, new Set(["uemcp_dev", "uemcp_other"])), enabled: true });
    await until(() => h.busy());
    const before = relay.upgrades.length;
    panel.token = "uemcp_other";
    account.changed();
    await until(() => relay.upgrades.length > before);
    expect(relay.upgrades.at(-1)!.authorization).toBe("Bearer uemcp_other");
    // The fake relay knows only uemcp_dev, so the new account's refusal shows: proof the connector reconnected.
    await until(() => h.events.some((e) => e.data.state === "error"));
    expect(await status(h)).toMatchObject({ state: "error", code: "signed-out", reason: REMOTE_SIGN_IN_AGAIN });
  });

  it("a new ue-mcp login is picked up on the next read, without a restart", async () => {
    let registry: { login: string; token: string } | null = null;
    const account = new AccountSource(new Panel(), async () => registry);
    const h = host({ account, plan: new TokenPlan(account), enabled: true });
    await settle();
    expect(relay.socket).toBeNull();
    registry = { login: "dev", token: "uemcp_dev" };
    await account.refresh();
    await until(() => h.busy());
  });

  it("points at the in-app sign-in, never a terminal command", () => {
    for (const m of [ACCOUNT_SIGNED_OUT, REMOTE_SIGN_IN_AGAIN]) {
      expect(m).toMatch(/Settings > General/);
      expect(m).not.toMatch(/npx|ue-mcp login/);
    }
  });
});

describe("the PIN lock, set on the computer", () => {
  it("off by default; a PIN, then the switches; removing the PIN turns them off; each change is announced", async () => {
    const h = host({ plan: new FakePlan(true) });
    await settle();
    expect((await h.call("GET /remote/lock")).body).toEqual({ pin: false, whole: false, sensitive: false, idleMinutes: 15 });
    expect((await h.call("PUT /remote/lock", { whole: true })).status).toBe(409);
    expect((await h.call("PUT /remote/lock/pin", { pin: "12" })).status).toBe(400);
    expect((await h.call("PUT /remote/lock/pin", { pin: "48219" })).body).toMatchObject({ pin: true, whole: false });
    expect((await h.call("PUT /remote/lock", { whole: true, sensitive: true, idleMinutes: 60 })).body).toEqual({ pin: true, whole: true, sensitive: true, idleMinutes: 60 });
    expect((await h.call("PUT /remote/lock", { whole: "yes" })).status).toBe(400);
    expect(h.events).toContainEqual({ type: "remote.lock", data: { pin: true, whole: true, sensitive: true, idleMinutes: 60 } });
    // One PIN for the computer, beside the paired browsers, never the PIN itself.
    const file = path.join(h.computerDir, "remote-lock.json");
    expect(fs.readFileSync(file, "utf-8")).not.toContain("48219");
    expect((await h.call("DELETE /remote/lock/pin")).body).toEqual({ pin: false, whole: false, sensitive: false, idleMinutes: 60 });
  });

  it("the desktop's own Studio is never locked", async () => {
    const h = host({ plan: new FakePlan(true) });
    await settle();
    await h.call("PUT /remote/lock/pin", { pin: "4821" });
    await h.call("PUT /remote/lock", { whole: true, sensitive: true });
    expect((await h.call("GET /lock")).body).toMatchObject({ whole: false, sensitive: false, locked: false, sensitiveOpen: true });
  });
});

describe("remote control storage and busy", () => {
  it("keeps the project id the standalone remote extension already registered", () => {
    const d = fs.mkdtempSync(path.join(root, "dev-"));
    const legacy = path.join(d, "remote");
    fs.mkdirSync(legacy);
    fs.writeFileSync(path.join(legacy, "device.json"), JSON.stringify({ id: "6f1c2a52-0f43-4f7e-9a51-8d1e2f3a4b5c" }));
    expect(deviceId(path.join(d, "studio", "remote"), legacy)).toBe("6f1c2a52-0f43-4f7e-9a51-8d1e2f3a4b5c");
    const fresh = deviceId(path.join(d, "other"));
    expect(fresh).toMatch(/^[0-9a-f-]{36}$/);
    expect(deviceId(path.join(d, "other"))).toBe(fresh);
  });

  it("reports busy when any part of Studio is, not only the last to ask", () => {
    let busy: () => boolean = () => false;
    const shared = shareBusy({ setBusy: (fn: () => boolean) => void (busy = fn), projectDir: "p" } as unknown as DaemonExtensionApi);
    let turns = false;
    let remote = false;
    shared.setBusy(() => turns);
    shared.setBusy(() => remote);
    expect(shared.projectDir).toBe("p");
    expect(busy()).toBe(false);
    turns = true;
    expect(busy()).toBe(true);
    turns = false;
    remote = true;
    expect(busy()).toBe(true);
  });
});

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
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import type { DaemonExtensionApi, ExtensionHandler } from "ue-mcp/daemon";
import {
  ResponseOpener,
  exportPublic,
  generateKeyPair,
  keyId,
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

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ── The daemon a browser's requests reach ─────────────────────────
const daemonHits: Array<{ method: string; url: string; auth?: string; cookie?: string }> = [];
const daemon = http.createServer((req, res) => {
  daemonHits.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, cookie: req.headers.cookie });
  if (req.headers.authorization !== `Bearer ${DAEMON_TOKEN}`) return void res.writeHead(401).end();
  if (req.url === "/ui/") return void res.writeHead(200, { "content-type": "text/html", "set-cookie": "leak=1" }).end(`<!doctype html><title>Studio ${MARKER}</title>`);
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
    ws.on("message", (data) => {
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
    send({ t: "hello", deviceId: String(req.headers["x-ue-mcp-device"]), login: "dev" });
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
function host(o: { plan?: PlanCheck; signedIn?: boolean; enabled?: boolean; planRecheckMs?: number } = {}): Host {
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
    plan: o.plan ?? new FakePlan(true),
    planRecheckMs: o.planRecheckMs,
    computerDir,
    daemon: () => ({ port, token: DAEMON_TOKEN }),
    env: { UE_MCP_REMOTE_RELAY: relay.base },
    refusedRetryMs: 60_000,
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

  /** What a scanned link leads to: the MAC under the fragment's secret, sent as the relay sends an enrollment. */
  async pair(url: string, device: string): Promise<Call> {
    const parts = parsePairingFragment(new URL(url).hash)!;
    this.device = device;
    this.secret = await sharedSecret(this.keyPair.privateKey, parts.computerPublic);
    const { c } = call("enroll", JSON.stringify({ phonePublic: this.publicKey, mac: await pairingMac(parts.secret, this.publicKey, parts.computerPublic), label: "Android" }));
    await until(() => c.ended || !!c.failed);
    return c;
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
      await new Promise((r) => setTimeout(r, 20));
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

const REMOTE_ROUTES = ["DELETE /remote/browsers/:id", "GET /remote/browsers", "GET /remote/status", "POST /remote/pair", "PUT /remote/config"];
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

  it("is off until turned on: no socket to the relay, and pairing waits for it", async () => {
    const before = relay.upgrades.length;
    const h = host();
    expect([...h.routes.keys()].sort()).toEqual(["GET /remote/available", ...REMOTE_ROUTES].sort());
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
    const enrolled = await browser.pair(pairing.url, device);
    expect(enrolled.failed).toBeUndefined();
    expect(JSON.parse(Buffer.concat(enrolled.bytes).toString())).toEqual({ phoneId: browser.id, computerPublic: computerKey });
    expect(((await h.call("GET /remote/browsers")).body as { browsers: unknown[] }).browsers).toEqual([{ id: browser.id, label: "Android", addedAt: expect.any(String) }]);

    // The code works once.
    const again = await (await Browser.make()).pair(pairing.url, device);
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
      ["POST", "/v1/ext/studio/Remote/pair"],
      ["POST", "/v1/ext/studio/x/../remote/pair"],
    ]) {
      const r = await browser.request({ method, path: p, body: method === "PUT" ? Buffer.from('{"enabled":false}').toString("base64") : undefined });
      expect(r.head?.status, `${method} ${p}`).toBe(403);
      expect(JSON.parse(r.text())).toEqual({ error: "Not available remotely." });
    }
    expect(daemonHits.length).toBe(hits);
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
  });
});

function keys(h: Host): string[] {
  const file = path.join(h.computerDir, "phones.json");
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf-8")) as Array<{ id: string }>).map((p) => p.id) : [];
}

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
    expect(await status(h)).toMatchObject({ state: "error", code: "signed-out" });
    expect((await h.call("POST /remote/pair")).status).toBe(401);
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

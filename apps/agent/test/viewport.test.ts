/**
 * The live viewport: the Pixel Streaming signalling server against a fake
 * streamer that speaks the editor's side of the protocol, the routes' Pro
 * gate, the stream actions found by category, and the stream stopping when
 * the last viewer leaves.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import type { ActionResult, DaemonExtensionApi } from "ue-mcp/daemon";
import { hasProPlan, iceServersOf, isViewerMessage, type AccountUsage, type ViewerSignals, type ViewportAccess, type ViewportJoin, type ViewportStatus } from "@ue-mcp-studio/shared";
import { SignallingServer } from "../src/viewport/signalling.js";
import { ViewportAccessCheck, actionBridge, readViewportConfig, registerViewport, type BridgeAnswer, type StreamBridge } from "../src/viewport/routes.js";

type Reply = { status?: number; body?: unknown };
type Req = { params: Record<string, string>; query: Record<string, string>; body?: unknown };
type Handler = (req: Req) => Reply | Promise<Reply>;

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});

/** The editor's streamer: connects, identifies, and answers each playerConnected with an offer and a candidate. */
async function fakeStreamer(url: string): Promise<{ ws: WebSocket; got: Array<Record<string, unknown>>; next(type: string): Promise<Record<string, unknown>> }> {
  const ws = new WebSocket(url);
  const got: Array<Record<string, unknown>> = [];
  const waiting: Array<{ type: string; resolve: (m: Record<string, unknown>) => void }> = [];
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString()) as Record<string, unknown>;
    got.push(m);
    if (m.type === "identify") ws.send(JSON.stringify({ type: "endpointId", id: "studio", protocolVersion: "1.0.0" }));
    if (m.type === "playerConnected") {
      ws.send(JSON.stringify({ type: "offer", playerId: m.playerId, sdp: "v=0 fake-offer" }));
      ws.send(JSON.stringify({ type: "iceCandidate", playerId: m.playerId, candidate: { candidate: "candidate:1 1 udp 1 192.0.2.1 5000 typ host", sdpMid: "0", sdpMLineIndex: 0 } }));
    }
    for (const w of waiting.filter((x) => x.type === m.type)) {
      waiting.splice(waiting.indexOf(w), 1);
      w.resolve(m);
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  cleanup.push(() => ws.close());
  return {
    ws,
    got,
    next: (type) => {
      const seen = got.find((m) => m.type === type && !(m as { taken?: boolean }).taken);
      if (seen) {
        (seen as { taken?: boolean }).taken = true;
        return Promise.resolve(seen);
      }
      return new Promise((resolve) => waiting.push({ type, resolve }));
    },
  };
}

describe("the signalling server", () => {
  it("speaks the streamer's side of the protocol and carries a viewer's offer, answer and candidates", async () => {
    const s = new SignallingServer({ iceServers: () => [{ urls: "stun:stun.example:3478" }] });
    cleanup.push(() => s.close());
    const url = await s.start();
    expect(url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}$/);

    const viewer = s.addViewer();
    const first = await s.poll(viewer, 0, 0);
    expect(first?.signals).toEqual([{ type: "streamer", connected: false }]);

    const streamer = await fakeStreamer(url);
    const config = await streamer.next("config");
    expect(config.peerConnectionOptions).toEqual({ iceServers: [{ urls: "stun:stun.example:3478" }] });
    expect((await streamer.next("endpointIdConfirm")).committedId).toBe("studio");
    expect((await streamer.next("playerConnected")).playerId).toBe(viewer);

    // Long-polled: the offer and the candidate arrive after the poll started.
    let polled: ViewerSignals | null = { signals: [], next: first!.next };
    const signals = [];
    while (signals.filter((x) => x.type !== "streamer").length < 2) {
      polled = await s.poll(viewer, polled!.next, 2000);
      signals.push(...polled!.signals);
    }
    expect(signals).toContainEqual({ type: "streamer", connected: true });
    expect(signals).toContainEqual({ type: "offer", sdp: "v=0 fake-offer" });
    expect(signals).toContainEqual({ type: "iceCandidate", candidate: { candidate: "candidate:1 1 udp 1 192.0.2.1 5000 typ host", sdpMid: "0", sdpMLineIndex: 0 } });

    s.fromViewer(viewer, { type: "answer", sdp: "v=0 fake-answer" });
    s.fromViewer(viewer, { type: "iceCandidate", candidate: { candidate: "candidate:2", sdpMid: "0", sdpMLineIndex: 0 } });
    expect(await streamer.next("answer")).toEqual({ type: "answer", playerId: viewer, sdp: "v=0 fake-answer" });
    expect((await streamer.next("iceCandidate")).candidate).toEqual({ candidate: "candidate:2", sdpMid: "0", sdpMLineIndex: 0 });

    streamer.ws.send(JSON.stringify({ type: "ping", time: 42 }));
    expect((await streamer.next("pong")).time).toBe(42);

    s.removeViewer(viewer);
    expect((await streamer.next("playerDisconnected")).playerId).toBe(viewer);
  });

  it("refuses a connection on any other path, so a web page cannot pose as the streamer", async () => {
    const s = new SignallingServer({ iceServers: () => [] });
    cleanup.push(() => s.close());
    const url = await s.start();
    const wrong = new WebSocket(url.replace(/\/[0-9a-f]+$/, "/guess"));
    const code = await new Promise<number>((resolve) => wrong.on("close", (c) => resolve(c)));
    expect(code).toBe(1008);
    expect(s.streamerConnected()).toBe(false);
  });

  it("tells viewers when the streamer goes, offers again when it comes back, and passes on the editor ending a viewer", async () => {
    const s = new SignallingServer({ iceServers: () => [] });
    cleanup.push(() => s.close());
    const url = await s.start();
    const one = await fakeStreamer(url);
    await one.next("identify");
    const viewer = s.addViewer();
    await one.next("playerConnected");
    let at = 0;
    const drain = async () => {
      const r = await s.poll(viewer, at, 50);
      at = r!.next;
      return r!.signals;
    };
    await drain();
    one.ws.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(await drain()).toContainEqual({ type: "streamer", connected: false });

    const two = await fakeStreamer(url);
    expect((await two.next("playerConnected")).playerId).toBe(viewer);
    two.ws.send(JSON.stringify({ type: "disconnectPlayer", playerId: viewer, reason: "Stopped in the editor." }));
    await new Promise((r) => setTimeout(r, 100));
    expect(s.has(viewer)).toBe(false);
    const after = await s.poll(viewer, at, 0);
    expect(after?.signals.at(-1)).toEqual({ type: "ended", reason: "Stopped in the editor." });
    expect(await s.poll(viewer, at, 0)).toBeNull();
  });
});

const ok = (data: Record<string, unknown>): BridgeAnswer => ({ kind: "ok", data });

/** The editor's side: armed from stream_start until stream_stop, unless `status` says otherwise. */
function fakeBridge(status?: () => BridgeAnswer) {
  const calls: Array<{ action: string; args?: Record<string, unknown> }> = [];
  let armed = false;
  const bridge: StreamBridge = {
    status: async () => (calls.push({ action: "stream_status" }), status ? status() : ok({ available: true, pluginEnabled: true, streaming: false, armed })),
    start: async (args) => (calls.push({ action: "stream_start", args }), (armed = true), ok({ streaming: false, armed: true })),
    stop: async () => (calls.push({ action: "stream_stop" }), (armed = false), ok({ streaming: false })),
    enablePlugin: async () => (calls.push({ action: "enable_plugin" }), ok({ created: true })),
  };
  return { bridge, calls };
}

function setup(o: { access?: ViewportAccess; bridge?: StreamBridge; stopGraceMs?: number; viewerTtlMs?: number; sweepMs?: number } = {}) {
  const routes = new Map<string, Handler>();
  const api = { route: (m: string, p: string, h: Handler) => void routes.set(`${m} ${p}`, h) } as unknown as DaemonExtensionApi;
  let access: ViewportAccess = o.access ?? "ok";
  const fb = fakeBridge();
  const signalling = new SignallingServer({ iceServers: () => [] });
  const reg = registerViewport(api, {
    access: { get: async () => access },
    bridge: o.bridge ?? fb.bridge,
    signalling,
    stopGraceMs: o.stopGraceMs ?? 20,
    pollWaitMs: 50,
    viewerTtlMs: o.viewerTtlMs,
    sweepMs: o.sweepMs ?? 20,
  });
  cleanup.push(() => reg.dispose());
  const call = (key: string, req: Partial<Req> = {}) => routes.get(key)!({ params: {}, query: {}, ...req });
  return { call, calls: fb.calls, signalling, setAccess: (a: ViewportAccess) => void (access = a) };
}

describe("the viewport routes", () => {
  it("refuses every viewer route without Pro and says why in the status", async () => {
    for (const access of ["signed-out", "needs-pro", "unreachable"] as const) {
      const v = setup({ access });
      const join = await v.call("POST /viewport/viewers");
      expect(join.status).toBe(access === "unreachable" ? 503 : 403);
      expect((join.body as { status: ViewportStatus }).status.access).toBe(access);
      expect((await v.call("GET /viewport/viewers/:id/signals", { params: { id: "x" } })).status).toBe(join.status);
      expect((await v.call("POST /viewport/viewers/:id/signals", { params: { id: "x" }, body: { message: { type: "answer", sdp: "x" } } })).status).toBe(join.status);
      expect((await v.call("POST /viewport/plugin")).status).toBe(join.status);
      expect(v.calls.filter((c) => c.action !== "stream_status")).toEqual([]);
      expect(((await v.call("GET /viewport")).body as ViewportStatus).access).toBe(access);
    }
  });

  it("arms the stream for PIE on the first viewer, with the signalling URL, and stops it after the last one leaves", async () => {
    const v = setup();
    const r = await v.call("POST /viewport/viewers", { body: {} });
    expect(r.status).toBe(201);
    const join = r.body as ViewportJoin;
    expect(join.iceServers.length).toBeGreaterThan(0);
    const start = v.calls.find((c) => c.action === "stream_start");
    expect(start?.args).toMatchObject({ streamerId: "studio", source: "pie" });
    expect(String(start?.args?.signallingUrl)).toBe(v.signalling.url());

    // A second viewer of the same source does not restart it.
    const second = (await v.call("POST /viewport/viewers", { body: { source: "pie" } })).body as ViewportJoin;
    expect(v.calls.filter((c) => c.action === "stream_start")).toHaveLength(1);
    expect(((await v.call("GET /viewport")).body as ViewportStatus).viewers).toBe(2);

    await v.call("DELETE /viewport/viewers/:id", { params: { id: join.viewer } });
    await new Promise((x) => setTimeout(x, 60));
    expect(v.calls.some((c) => c.action === "stream_stop")).toBe(false);
    await v.call("DELETE /viewport/viewers/:id", { params: { id: second.viewer } });
    await new Promise((x) => setTimeout(x, 80));
    expect(v.calls.filter((c) => c.action === "stream_stop")).toHaveLength(1);
  });

  it("restarts the stream when a viewer asks for another source", async () => {
    const v = setup();
    await v.call("POST /viewport/viewers", { body: {} });
    await v.call("POST /viewport/viewers", { body: { source: "level_viewport" } });
    expect(v.calls.filter((c) => c.action === "stream_start").map((c) => c.args?.source)).toEqual(["pie", "level_viewport"]);
    expect(((await v.call("GET /viewport")).body as ViewportStatus).source).toBe("level_viewport");
  });

  it("carries signals through the routes and refuses a message that is not an answer or a candidate", async () => {
    const v = setup();
    const join = (await v.call("POST /viewport/viewers", { body: {} })).body as ViewportJoin;
    const polled = (await v.call("GET /viewport/viewers/:id/signals", { params: { id: join.viewer }, query: { after: "0" } })).body as ViewerSignals;
    expect(polled.signals).toEqual([{ type: "streamer", connected: false }]);
    expect((await v.call("POST /viewport/viewers/:id/signals", { params: { id: join.viewer }, body: { message: { type: "offer", sdp: "x" } } })).status).toBe(400);
    expect((await v.call("POST /viewport/viewers/:id/signals", { params: { id: join.viewer }, body: { message: { type: "answer", sdp: "v=0" } } })).status).toBe(204);
    expect((await v.call("GET /viewport/viewers/:id/signals", { params: { id: "gone" } })).status).toBe(404);
  });

  it("drops a viewer that stopped polling, and ends everyone when the plan lapses", async () => {
    const v = setup({ viewerTtlMs: 40, sweepMs: 15 });
    await v.call("POST /viewport/viewers", { body: {} });
    await new Promise((x) => setTimeout(x, 120));
    expect(v.signalling.viewerCount()).toBe(0);
    expect(v.calls.some((c) => c.action === "stream_stop")).toBe(true);

    const w = setup({ sweepMs: 15 });
    const join = (await w.call("POST /viewport/viewers", { body: {} })).body as ViewportJoin;
    w.setAccess("needs-pro");
    await new Promise((x) => setTimeout(x, 60));
    expect(w.signalling.has(join.viewer)).toBe(false);
  });

  it("names what stops the editor streaming, and enabling the plugin waits for a restart", async () => {
    const off = setup({ bridge: fakeBridge(() => ok({ available: true, pluginEnabled: false, streaming: false, armed: false })).bridge });
    const refused = await off.call("POST /viewport/viewers", { body: {} });
    expect(refused.status).toBe(409);
    expect((refused.body as { status: ViewportStatus }).status.editor).toBe("plugin-off");
    expect(((await off.call("POST /viewport/plugin")).body as ViewportStatus).editor).toBe("plugin-restart");

    expect(((await setup({ bridge: fakeBridge(() => ({ kind: "no-editor" })).bridge }).call("GET /viewport")).body as ViewportStatus).editor).toBe("no-editor");
    expect(((await setup({ bridge: fakeBridge(() => ({ kind: "missing" })).bridge }).call("GET /viewport")).body as ViewportStatus).editor).toBe("no-actions");
    const unavailable = (await setup({ bridge: fakeBridge(() => ok({ available: false, pluginEnabled: true, reason: "No hardware encoder." })).bridge }).call("GET /viewport")).body as ViewportStatus;
    expect(unavailable).toMatchObject({ editor: "unavailable", detail: "No hardware encoder." });
  });
});

describe("the stream actions by category", () => {
  const result = (text: string, isError = false): ActionResult => ({ isError, content: [{ type: "text", text }] });

  it("tries pie, then editor, keeps the one that answered, and reports missing actions and no editor", async () => {
    const asked: string[] = [];
    let connected = true;
    const api = {
      editors: () => [{ name: "e", connected, port: 1, pid: 1, lastDisconnect: null }],
      callAction: async (category: string, action: string) => {
        asked.push(`${category}.${action}`);
        return category === "editor" ? result(JSON.stringify({ available: true, pluginEnabled: true, streaming: true, armed: false })) : result(`Unknown action '${action}' for pie`, true);
      },
    } as unknown as DaemonExtensionApi;
    const b = actionBridge(api);
    expect(await b.status()).toEqual({ kind: "ok", data: { available: true, pluginEnabled: true, streaming: true, armed: false } });
    await b.stop();
    expect(asked).toEqual(["pie.stream_status", "editor.stream_status", "editor.stream_stop"]);
    connected = false;
    expect(await b.status()).toEqual({ kind: "no-editor" });

    const none = actionBridge({ editors: () => [{ connected: true }], callAction: async () => result("Unknown action", true) } as unknown as DaemonExtensionApi);
    expect(await none.status()).toEqual({ kind: "missing" });
  });
});

describe("the Pro check and the configuration", () => {
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const usage = (id: string, status = "active"): AccountUsage => ({ plan: { id, name: id, models: [] }, status, periodEnd: future }) as unknown as AccountUsage;

  it("holds Pro only on a live pro entitlement, an operator grant included", () => {
    expect(hasProPlan(usage("pro"))).toBe(true);
    expect(hasProPlan(usage("pro", "past_due"))).toBe(true);
    expect(hasProPlan(usage("remote"))).toBe(false);
    expect(hasProPlan(usage("pro", "canceled"))).toBe(false);
    expect(hasProPlan({ ...usage("pro"), periodEnd: "2000-01-01T00:00:00Z" })).toBe(false);
  });

  it("asks the gateway with the account token and reads the answer as access", async () => {
    const answer = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });
    expect(await new ViewportAccessCheck({ token: async () => null, gatewayUrl: () => "http://g" }).get()).toBe("signed-out");
    expect(await new ViewportAccessCheck({ token: async () => "t", gatewayUrl: () => "http://g", fetch: answer(200, usage("pro")) }).get()).toBe("ok");
    expect(await new ViewportAccessCheck({ token: async () => "t", gatewayUrl: () => "http://g", fetch: answer(200, usage("remote")) }).get()).toBe("needs-pro");
    expect(await new ViewportAccessCheck({ token: async () => "t", gatewayUrl: () => "http://g", fetch: answer(500, {}) }).get()).toBe("unreachable");
    expect(await new ViewportAccessCheck({ token: async () => "t", gatewayUrl: () => "http://g", fetch: answer(401, {}) }).get()).toBe("signed-out");
  });

  it("reads TURN servers and stream settings from viewport.json and the environment, after the default STUN", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-viewport-"));
    fs.writeFileSync(path.join(dir, "viewport.json"), JSON.stringify({ iceServers: [{ urls: "turn:turn.example:3478", username: "u", credential: "c" }, { urls: "http://not-ice" }], stream: { fps: 30, codec: "VP9", resolution: "nope" } }));
    const c = readViewportConfig(dir, { UE_MCP_STUDIO_ICE_SERVERS: JSON.stringify([{ urls: ["turns:t2.example:443"] }]) });
    expect(c.iceServers.map((s) => s.urls)).toEqual(["stun:stun.l.google.com:19302", "turn:turn.example:3478", ["turns:t2.example:443"]]);
    expect(c.stream).toEqual({ fps: 30, codec: "VP9" });
    expect(iceServersOf("nope")).toEqual([]);
  });

  it("takes only an answer or a candidate from a viewer", () => {
    expect(isViewerMessage({ type: "answer", sdp: "v=0" })).toBe(true);
    expect(isViewerMessage({ type: "iceCandidate", candidate: { candidate: "c" } })).toBe(true);
    expect(isViewerMessage({ type: "offer", sdp: "v=0" })).toBe(false);
    expect(isViewerMessage({ type: "answer", sdp: "" })).toBe(false);
  });
});

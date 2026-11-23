/**
 * Whether PIE runs, as Studio knows it without polling: the calls it makes,
 * other clients' calls, the editor coming and going, and the streamer of a PIE
 * stream. And the agent kept off the stream the Viewport tab owns (#570).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { ActionResult, DaemonExtensionApi } from "ue-mcp/daemon";
import type { ViewportStatus } from "@ue-mcp-studio/shared";
import { PieWatch, VIEWPORT_OWNED_REFUSAL, pieAfter } from "../src/viewport/pie-watch.js";
import { SignallingServer } from "../src/viewport/signalling.js";
import { registerViewport, type StreamBridge } from "../src/viewport/routes.js";
import { SUBAGENT_SYSTEM, VIEWPORT_LINE } from "../src/runner.js";

const answer = (body: Record<string, unknown>, isError = false): ActionResult => ({ isError, content: [{ type: "text", text: JSON.stringify(body) }] });

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});

function watch(o: { connected?: boolean; status?: () => ActionResult } = {}) {
  let changes = 0;
  const asked: string[] = [];
  const w = new PieWatch({
    callAction: async (c, a, args) => (asked.push(`${c}.${a}:${String(args?.pieAction)}`), o.status ? o.status() : answer({ isPlaying: false })),
    connected: () => o.connected ?? true,
    changed: () => void changes++,
  });
  return { w, asked, changes: () => changes };
}

describe("what a call says about PIE", () => {
  it("reads starts, stops and status answers, and ignores the rest", () => {
    expect(pieAfter("editor", "play_in_editor", { pieAction: "start" }, answer({ playSessionRequested: true, isPlaying: false }))).toBe(true);
    expect(pieAfter("editor", "play_in_editor", { pieAction: "start" }, answer({ success: false, alreadyRunning: true }, true))).toBe(true);
    expect(pieAfter("editor", "play_in_editor", { pieAction: "stop" }, answer({ success: true }))).toBe(false);
    expect(pieAfter("editor", "play_in_editor", { pieAction: "stop" }, answer({ alreadyStopped: true }, true))).toBe(false);
    expect(pieAfter("editor", "play_in_editor", {}, answer({ isPlaying: true }))).toBe(true);
    expect(pieAfter("editor", "play_in_editor", {}, answer({ isPlaying: false }))).toBe(false);
    expect(pieAfter("pie", "script_run", { script: "/Game/T" }, answer({ run_id: "r" }))).toBe(true);
    expect(pieAfter("pie", "script_run", { script: "/Game/T", mode: "manual" }, answer({ run_id: "r" }))).toBeNull();
    expect(pieAfter("level", "list_actors", {}, answer({}))).toBeNull();
  });
});

describe("the PIE watch", () => {
  it("publishes only a change", () => {
    const { w, changes } = watch();
    w.set(true);
    w.set(true);
    w.set(false);
    expect(changes()).toBe(2);
  });

  it("asks the editor after another client's PIE call and on connect, and forgets PIE when the editor goes", async () => {
    const { w, asked } = watch({ status: () => answer({ isPlaying: true }) });
    w.observe({ type: "call.finished", data: { category: "editor", action: "play_in_editor" } });
    w.observe({ type: "call.finished", data: { category: "level", action: "list_actors" } });
    await w.refresh();
    expect(asked).toEqual(["editor.play_in_editor:status"]);
    expect(w.get()).toBe(true);
    w.observe({ type: "editor.disconnected", data: {} });
    expect(w.get()).toBe(false);
  });

  it("follows the daemon's pie events, and stops guessing from calls once the daemon pushes them", async () => {
    let pushed = false;
    let changes = 0;
    const asked: string[] = [];
    const w = new PieWatch({
      callAction: async (c, a) => (asked.push(`${c}.${a}`), answer({ isPlaying: false })),
      connected: () => true,
      changed: () => void changes++,
      pushed: () => pushed,
    });
    // A session the user started with the editor's Play button reaches Studio only as pie.started.
    w.observe({ type: "pie.started", data: { editor: "E", state: "started", simulate: false } });
    expect(w.get()).toBe(true);
    w.observe({ type: "pie.paused", data: {} });
    w.observe({ type: "pie.resumed", data: {} });
    expect(w.get()).toBe(true);
    w.observe({ type: "pie.ended", data: {} });
    expect(w.get()).toBe(false);
    expect(changes).toBe(2);

    // An older daemon: another client's call is still a reason to ask the editor.
    w.observe({ type: "call.finished", data: { category: "editor", action: "play_in_editor" } });
    await Promise.resolve();
    expect(asked).toEqual(["editor.play_in_editor"]);
    await w.refresh();

    // A daemon with the events: no asking, the events say it, and the editor going still means no PIE.
    pushed = true;
    asked.length = 0;
    w.observe({ type: "call.finished", data: { category: "editor", action: "play_in_editor" } });
    w.observe({ type: "editor.connected", data: {} });
    w.observe({ type: "script.run_started", data: {} });
    expect(asked).toEqual([]);
    w.set(true);
    w.observe({ type: "editor.disconnected", data: {} });
    expect(w.get()).toBe(false);
  });

  it("watches the chat's calls and refuses the stream actions the Viewport tab owns", async () => {
    const { w } = watch();
    const sent: string[] = [];
    const host = { callAction: async (c: string, a: string) => (sent.push(`${c}.${a}`), answer({ playSessionRequested: true })) };
    const wrapped = w.wrap(host);
    const refused = await wrapped.callAction("pie", "stream_start", { signallingUrl: "ws://x" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toBe(VIEWPORT_OWNED_REFUSAL);
    expect((await wrapped.callAction("pie", "stream_stop", {})).isError).toBe(true);
    await wrapped.callAction("pie", "stream_status", {});
    await wrapped.callAction("editor", "play_in_editor", { pieAction: "start" });
    expect(sent).toEqual(["pie.stream_status", "editor.play_in_editor"]);
    expect(w.get()).toBe(true);
  });

  it("tells every agent who owns the stream and never to ask for a signalling URL", () => {
    expect(SUBAGENT_SYSTEM).toContain(VIEWPORT_LINE);
    expect(VIEWPORT_LINE).toMatch(/never ask the user for a signalling URL/);
    expect(VIEWPORT_LINE).toMatch(/Pro plan/);
  });
});

describe("the viewport status", () => {
  it("answers PIE to every account, and the streamer of a PIE stream moves it", async () => {
    const routes = new Map<string, (req: unknown) => unknown>();
    const api = { route: (m: string, p: string, h: (req: unknown) => unknown) => void routes.set(`${m} ${p}`, h) } as unknown as DaemonExtensionApi;
    const { w } = watch();
    let changed = 0;
    const ok = (data: Record<string, unknown>) => ({ kind: "ok" as const, data });
    const bridge: StreamBridge = {
      status: async () => ok({ available: true, pluginEnabled: true, streaming: false, armed: true }),
      start: async () => ok({ armed: true }),
      stop: async () => ok({}),
      enablePlugin: async () => ok({}),
    };
    let access: "ok" | "needs-pro" = "needs-pro";
    const signalling = new SignallingServer({ iceServers: () => [] });
    const reg = registerViewport(api, { access: { get: async () => access }, bridge, signalling, pie: w, changed: () => void changed++, stopGraceMs: 10, pollWaitMs: 20, sweepMs: 20 });
    cleanup.push(() => reg.dispose());
    const get = async () => (await routes.get("GET /viewport")!({ params: {}, query: {} })) as { body: ViewportStatus };

    w.set(true);
    expect((await get()).body).toMatchObject({ access: "needs-pro", pie: true });

    access = "ok";
    w.set(false);
    await routes.get("POST /viewport/viewers")!({ params: {}, query: {}, body: { source: "pie" } });
    expect(changed).toBeGreaterThan(0);
    const ws = new WebSocket(signalling.url());
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    // Polled rather than a fixed sleep: under a full suite's load the socket's events can take longer than a few ms.
    await vi.waitFor(() => expect(w.get()).toBe(true), { timeout: 2000, interval: 10 });
    ws.close();
    await vi.waitFor(() => expect(w.get()).toBe(false), { timeout: 2000, interval: 10 });
  });
});

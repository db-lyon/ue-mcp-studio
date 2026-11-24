/**
 * The live viewport in the hub demo: the viewport routes answered as the
 * agent would (GET /viewport, joining, the long-polled signals, leaving),
 * with Play In Editor running whenever the simulated project plays a run,
 * and a stand-in RTCPeerConnection whose video is a canvas animation of a
 * simple third-person scene labelled "Simulated feed". The page's real
 * ViewportSession and the hub's real placements run against them unchanged:
 * nothing in the views knows it is a demo.
 */
import type { ViewerSignal, ViewportStatus } from "@ue-mcp-studio/shared";

const V = "/v1/ext/studio/viewport";
const POLL_WAIT_MS = 15_000;
/** The SDP the stand-in peer accepts; anything goes, since no real connection is made. */
const DEMO_SDP = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=Simulated feed\r\n";

export interface FeedAnswer {
  status: number;
  body?: unknown;
}

interface Viewer {
  id: string;
  signals: ViewerSignal[];
  wake: Set<() => void>;
}

/** The viewport routes over the simulated project: PIE runs while `playing()` says so and the editor is up. */
export class DemoViewport {
  private readonly viewers = new Map<string, Viewer>();
  private was = false;
  private n = 0;

  constructor(private readonly o: { playing: () => boolean; editor: () => boolean; emit: (type: string, data: Record<string, unknown>) => void }) {}

  private pie(): boolean {
    return this.o.editor() && this.o.playing();
  }

  status(): ViewportStatus {
    const pie = this.pie();
    const viewers = this.viewers.size;
    return {
      access: "ok",
      editor: this.o.editor() ? "ready" : "no-editor",
      bridge: { available: true, pluginEnabled: true, streaming: pie && viewers > 0, armed: !pie && viewers > 0 },
      streamer: pie && viewers > 0,
      source: viewers > 0 ? "pie" : null,
      viewers,
      pie,
    };
  }

  /** PIE starting or stopping with the simulated runs: what the streamer would tell each viewer, and the events the daemon would publish. */
  tick(): void {
    const pie = this.pie();
    if (pie === this.was) return;
    this.was = pie;
    this.o.emit(pie ? "pie.started" : "pie.ended", {});
    this.o.emit("studio.viewport.changed", {});
    for (const v of this.viewers.values()) this.push(v, ...this.streamerSignals(pie));
  }

  private streamerSignals(pie: boolean): ViewerSignal[] {
    return pie ? [{ type: "streamer", connected: true }, { type: "offer", sdp: DEMO_SDP }] : [{ type: "streamer", connected: false }];
  }

  private push(v: Viewer, ...s: ViewerSignal[]): void {
    v.signals.push(...s);
    for (const w of [...v.wake]) w();
  }

  /** A viewport route, or undefined for any other path. Signals wait, as the agent's long poll does. */
  handle(method: string, path: string, query: URLSearchParams, signal?: AbortSignal | null): Promise<FeedAnswer> | FeedAnswer | undefined {
    if (path !== V && !path.startsWith(`${V}/`)) return undefined;
    if (method === "GET" && path === V) return { status: 200, body: this.status() };
    if (method === "POST" && path === `${V}/viewers`) {
      if (!this.o.editor()) return { status: 503, body: { error: "The editor is not running", status: this.status() } };
      const v: Viewer = { id: `demo-viewer-${++this.n}`, signals: [], wake: new Set() };
      this.viewers.set(v.id, v);
      v.signals.push(...this.streamerSignals(this.pie()));
      this.o.emit("studio.viewport.changed", {});
      return { status: 201, body: { viewer: v.id, iceServers: [], status: this.status() } };
    }
    const m = /^\/v1\/ext\/studio\/viewport\/viewers\/([^/]+)(\/signals)?$/.exec(path);
    const v = m ? this.viewers.get(decodeURIComponent(m[1])) : undefined;
    if (!m) return { status: 404, body: { error: "The demo daemon has no such viewport route" } };
    if (method === "DELETE" && !m[2]) {
      if (v) {
        this.viewers.delete(v.id);
        this.o.emit("studio.viewport.changed", {});
      }
      return { status: 204 };
    }
    if (!v) return { status: 404, body: { error: "No such viewer" } };
    if (method === "POST" && m[2]) return { status: 200, body: { ok: true } };
    if (method === "GET" && m[2]) {
      const after = Number(query.get("after") ?? 0) || 0;
      const answer = (): FeedAnswer => ({ status: 200, body: { signals: v.signals.slice(after), next: v.signals.length } });
      if (v.signals.length > after) return answer();
      return new Promise<FeedAnswer>((resolve) => {
        const done = () => {
          clearTimeout(t);
          v.wake.delete(done);
          resolve(answer());
        };
        const t = setTimeout(done, POLL_WAIT_MS);
        v.wake.add(done);
        signal?.addEventListener("abort", done);
      });
    }
    return { status: 405, body: { error: "The demo daemon does not do this" } };
  }
}

// ---------- The picture ----------

const W = 640;
const H = 360;

/** One canvas drawing a third-person scene for every stand-in peer: a runner on a path through pillars, a label in the corner. */
let shared: { canvas: HTMLCanvasElement; stream: MediaStream } | null = null;

function feedStream(): MediaStream {
  if (shared) return shared.stream;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext("2d")!;
  const start = performance.now();
  const draw = () => {
    const t = (performance.now() - start) / 1000;
    drawScene(g, t);
  };
  draw();
  // A timer, not requestAnimationFrame: the frames keep coming in a background tab and a headless shot.
  setInterval(draw, 1000 / 30);
  const stream = (canvas as HTMLCanvasElement & { captureStream(fps?: number): MediaStream }).captureStream(30);
  shared = { canvas, stream };
  return stream;
}

function drawScene(g: CanvasRenderingContext2D, t: number): void {
  const horizon = H * 0.46;
  // Sky.
  const sky = g.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, "#1d2a44");
  sky.addColorStop(1, "#6b5a6e");
  g.fillStyle = sky;
  g.fillRect(0, 0, W, horizon);
  // Far hills, drifting with the camera's sway.
  const sway = Math.sin(t * 0.35) * 18;
  g.fillStyle = "#3a3448";
  g.beginPath();
  g.moveTo(0, horizon);
  for (let x = 0; x <= W; x += 20) g.lineTo(x, horizon - 30 - 22 * Math.sin((x + sway * 4) / 90) - 12 * Math.sin((x + sway * 2) / 37));
  g.lineTo(W, horizon);
  g.closePath();
  g.fill();
  // Ground.
  const ground = g.createLinearGradient(0, horizon, 0, H);
  ground.addColorStop(0, "#3d4a35");
  ground.addColorStop(1, "#1f2a1c");
  g.fillStyle = ground;
  g.fillRect(0, horizon, W, H - horizon);
  // The path, in perspective, with stripes moving toward the camera.
  const cx = W / 2 + sway;
  g.fillStyle = "#6e6150";
  g.beginPath();
  g.moveTo(cx - 14, horizon);
  g.lineTo(cx + 14, horizon);
  g.lineTo(W / 2 + 190, H);
  g.lineTo(W / 2 - 190, H);
  g.closePath();
  g.fill();
  const speed = 0.9;
  for (let i = 0; i < 10; i++) {
    const z = ((i / 10 + t * speed * 0.1) % 1);
    const y = horizon + (H - horizon) * z * z;
    const half = 14 + (190 - 14) * z * z;
    g.fillStyle = `rgba(40, 32, 24, ${0.25 + 0.35 * z})`;
    g.fillRect(cx + (W / 2 - cx) * z * z - half, y, half * 2, 2 + 6 * z * z);
  }
  // Pillars passing on both sides.
  for (let i = 0; i < 6; i++) {
    const z = ((i / 6 + t * speed * 0.12) % 1);
    const s = z * z;
    const y = horizon + (H - horizon) * s;
    const side = i % 2 === 0 ? -1 : 1;
    const x = cx + (W / 2 - cx) * s + side * (40 + 330 * s);
    const w = 4 + 34 * s;
    const h = 10 + 190 * s;
    g.fillStyle = `rgba(150, 140, 125, ${0.35 + 0.65 * s})`;
    g.fillRect(x - w / 2, y - h, w, h);
    g.fillStyle = `rgba(0, 0, 0, ${0.25 * s})`;
    g.fillRect(x - w / 2 + w * 0.6, y - h, w * 0.4, h);
  }
  // The character, from behind: a capsule with a lantern, bobbing as it runs.
  const bob = Math.abs(Math.sin(t * 6)) * 6;
  const px = W / 2 + Math.sin(t * 0.8) * 22;
  const py = H - 60 - bob;
  g.fillStyle = "rgba(0, 0, 0, 0.35)";
  g.beginPath();
  g.ellipse(px, H - 46, 34 - bob, 9, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#2b3550";
  g.beginPath();
  g.ellipse(px, py - 30, 24, 40, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#d7b48a";
  g.beginPath();
  g.arc(px, py - 82, 15, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#3b2a1f";
  g.beginPath();
  g.arc(px, py - 86, 15, Math.PI, Math.PI * 2);
  g.fill();
  const lx = px + 30;
  const ly = py - 26 + Math.sin(t * 6) * 3;
  const glow = g.createRadialGradient(lx, ly, 2, lx, ly, 46);
  glow.addColorStop(0, "rgba(255, 196, 92, 0.85)");
  glow.addColorStop(1, "rgba(255, 196, 92, 0)");
  g.fillStyle = glow;
  g.beginPath();
  g.arc(lx, ly, 46, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#ffd27a";
  g.fillRect(lx - 4, ly - 6, 8, 12);
  // A crosshair and the label: this is not an editor.
  g.strokeStyle = "rgba(255, 255, 255, 0.55)";
  g.lineWidth = 1.5;
  g.beginPath();
  g.moveTo(W / 2 - 7, H * 0.42);
  g.lineTo(W / 2 + 7, H * 0.42);
  g.moveTo(W / 2, H * 0.42 - 7);
  g.lineTo(W / 2, H * 0.42 + 7);
  g.stroke();
  g.font = "600 13px system-ui, sans-serif";
  const label = "Simulated feed";
  const lw = g.measureText(label).width + 16;
  g.fillStyle = "rgba(0, 0, 0, 0.55)";
  g.fillRect(W - lw - 10, H - 30, lw, 22);
  g.fillStyle = "#fff";
  g.fillText(label, W - lw - 2, H - 14);
}

// ---------- The stand-in peer ----------

type Listener = (e: unknown) => void;

/** Enough of RTCPeerConnection for a viewer: it answers any offer, then delivers the canvas as the streamer's video. */
class SimulatedPeer {
  connectionState = "new";
  iceConnectionState = "new";
  private readonly listeners = new Map<string, Set<Listener>>();
  private closed = false;
  private frames = 0;

  addEventListener(type: string, fn: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }
  private fire(type: string, e: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }
  async setRemoteDescription(): Promise<void> {}
  async createAnswer(): Promise<{ type: string; sdp: string }> {
    return { type: "answer", sdp: DEMO_SDP };
  }
  async setLocalDescription(): Promise<void> {
    setTimeout(() => {
      if (this.closed) return;
      const stream = feedStream();
      for (const track of stream.getVideoTracks()) this.fire("track", { track, streams: [stream] });
      this.connectionState = "connected";
      this.iceConnectionState = "connected";
      this.fire("iceconnectionstatechange", {});
      this.fire("connectionstatechange", {});
    }, 350);
  }
  async addIceCandidate(): Promise<void> {}
  async getStats(): Promise<Map<string, unknown>> {
    this.frames += 30;
    return new Map([["v", { type: "inbound-rtp", kind: "video", framesDecoded: this.frames }]]);
  }
  close(): void {
    this.closed = true;
    this.connectionState = "closed";
  }
}

/** Put the stand-in peer where the page's viewer looks for RTCPeerConnection. */
export function installSimulatedPeer(): void {
  (window as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection = SimulatedPeer;
}

/**
 * The signalling server the editor's Pixel Streaming 2 streamer connects to,
 * on localhost, speaking Epic's Pixel Streaming signalling protocol (the one
 * the PixelStreamingInfrastructure signalling server speaks to a streamer):
 *
 *   server -> streamer   config {peerConnectionOptions}, identify,
 *                        endpointIdConfirm, playerConnected, playerDisconnected,
 *                        answer {playerId, sdp}, iceCandidate {playerId, candidate}, pong
 *   streamer -> server   endpointId {id}, offer {playerId, sdp},
 *                        iceCandidate {playerId, candidate}, disconnectPlayer {playerId}, ping
 *
 * Viewers are not WebSockets here: each is a queue of signals a viewer polls
 * through Studio's routes, which reach the computer directly or through the
 * sealed relay. So the editor sees an ordinary signalling server with players,
 * and a player is the same whether it sits on the computer or on a phone.
 *
 * The URL carries a random path, and a connection on any other path is
 * closed: a web page can open a WebSocket to localhost, and must not pose as
 * the streamer.
 */
import * as crypto from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { IceServer, ViewerMessage, ViewerSignal, ViewerSignals } from "@ue-mcp-studio/shared";

/** The protocol version this server speaks to the streamer. */
export const PS_PROTOCOL_VERSION = "1.0.0";

interface Viewer {
  id: string;
  seq: number;
  queue: Array<{ seq: number; signal: ViewerSignal }>;
  waiters: Set<() => void>;
  seen: number;
}

export interface SignallingOptions {
  iceServers: () => IceServer[];
  log?: (message: string) => void;
  /** Told when a streamer connects or goes. */
  onStreamer?: (connected: boolean) => void;
  now?: () => number;
}

export class SignallingServer {
  private wss: WebSocketServer | null = null;
  private starting: Promise<string> | null = null;
  private streamer: WebSocket | null = null;
  /**
   * The streamer has sent its endpointId and been confirmed. Pixel Streaming 2
   * joins its room only then, and drops a playerConnected that arrives before
   * as an unknown message, so players are announced from here on.
   */
  private streamerJoined = false;
  private readonly viewers = new Map<string, Viewer>();
  /** Viewers ended by the editor or the agent, and why, until their next poll. */
  private readonly ended = new Map<string, string>();
  private readonly secret = crypto.randomBytes(16).toString("hex");
  private port = 0;

  constructor(private readonly o: SignallingOptions) {}

  /** Listen on 127.0.0.1 at a free port, once; the URL the editor's streamer connects to. */
  start(): Promise<string> {
    this.starting ??= new Promise<string>((resolve, reject) => {
      const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: 1024 * 1024 });
      wss.once("error", (e) => {
        this.starting = null;
        reject(e);
      });
      wss.once("listening", () => {
        const addr = wss.address();
        this.port = typeof addr === "object" && addr ? addr.port : 0;
        this.wss = wss;
        resolve(this.url());
      });
      wss.on("connection", (ws, req) => this.accept(ws, req.url ?? ""));
    });
    return this.starting;
  }

  /** The streamer's URL, once started. */
  url(): string {
    return `ws://127.0.0.1:${this.port}/${this.secret}`;
  }

  streamerConnected(): boolean {
    return this.streamer !== null;
  }

  viewerCount(): number {
    return this.viewers.size;
  }

  viewerIds(): string[] {
    return [...this.viewers.keys()];
  }

  has(id: string): boolean {
    return this.viewers.has(id);
  }

  /** A new viewer: told whether a streamer is there, and offered the stream when one is. */
  addViewer(): string {
    const id = crypto.randomUUID();
    this.viewers.set(id, { id, seq: 0, queue: [], waiters: new Set(), seen: this.now() });
    this.push(id, { type: "streamer", connected: this.streamer !== null });
    if (this.streamerJoined) this.announce(id);
    return id;
  }

  /** The viewer leaves (or is ended with `reason`, which it is told first). */
  removeViewer(id: string, reason?: string): void {
    const v = this.viewers.get(id);
    if (!v) return;
    if (reason) {
      this.push(id, { type: "ended", reason });
      // A viewer between polls hears why on its next one.
      this.ended.set(id, reason);
      if (this.ended.size > 100) this.ended.delete(this.ended.keys().next().value as string);
    }
    this.viewers.delete(id);
    for (const w of v.waiters) w();
    if (this.streamerJoined) this.toStreamer({ type: "playerDisconnected", playerId: id });
  }

  /** A viewer's answer or candidate, passed to the streamer as that player's. */
  fromViewer(id: string, m: ViewerMessage): boolean {
    const v = this.viewers.get(id);
    if (!v) return false;
    v.seen = this.now();
    if (!this.streamer) return true;
    if (m.type === "answer") this.toStreamer({ type: "answer", playerId: id, sdp: m.sdp });
    else this.toStreamer({ type: "iceCandidate", playerId: id, candidate: m.candidate });
    return true;
  }

  /**
   * The signals after `after`, waiting up to `waitMs` while there are none;
   * null for a viewer that is gone. Signals at or before `after` are dropped,
   * since the viewer has them.
   */
  async poll(id: string, after: number, waitMs: number, signal?: AbortSignal): Promise<ViewerSignals | null> {
    const v = this.viewers.get(id);
    if (!v) {
      const reason = this.ended.get(id);
      if (reason === undefined) return null;
      this.ended.delete(id);
      return { signals: [{ type: "ended", reason }], next: after + 1 };
    }
    v.seen = this.now();
    v.queue = v.queue.filter((q) => q.seq > after);
    if (v.queue.length === 0 && waitMs > 0 && !signal?.aborted) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          v.waiters.delete(done);
          signal?.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, waitMs);
        v.waiters.add(done);
        signal?.addEventListener("abort", done);
      });
      v.seen = this.now();
    }
    const signals = v.queue.filter((q) => q.seq > after);
    return { signals: signals.map((q) => q.signal), next: signals.length ? signals[signals.length - 1].seq : Math.max(after, 0) };
  }

  /** Viewers that have not been heard from since `before`. */
  idleViewers(before: number): string[] {
    return [...this.viewers.values()].filter((v) => v.seen < before).map((v) => v.id);
  }

  close(): void {
    for (const id of [...this.viewers.keys()]) this.removeViewer(id, "Studio stopped.");
    this.streamer?.close();
    this.streamer = null;
    this.wss?.close();
    this.wss = null;
    this.starting = null;
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  private push(id: string, signal: ViewerSignal): void {
    const v = this.viewers.get(id);
    if (!v) return;
    v.seq += 1;
    v.queue.push({ seq: v.seq, signal });
    // A viewer that stopped polling must not grow without end: the newest signals are what matter.
    if (v.queue.length > 500) v.queue.splice(0, v.queue.length - 500);
    for (const w of [...v.waiters]) w();
  }

  private broadcast(signal: ViewerSignal): void {
    for (const id of this.viewers.keys()) this.push(id, signal);
  }

  /** Tell the streamer about a player, which it answers with an offer. */
  private announce(id: string): void {
    this.toStreamer({ type: "playerConnected", playerId: id, dataChannel: true, sfu: false, sendOffer: true });
  }

  private toStreamer(msg: Record<string, unknown>): void {
    if (this.streamer?.readyState === 1) this.streamer.send(JSON.stringify(msg));
  }

  private accept(ws: WebSocket, url: string): void {
    const pathOnly = url.split("?")[0].replace(/\/+$/, "");
    if (pathOnly !== `/${this.secret}`) {
      ws.close(1008, "unknown path");
      return;
    }
    // One streamer: a new one replaces the old (an editor that restarted streaming).
    const previous = this.streamer;
    this.streamer = ws;
    this.streamerJoined = false;
    if (previous) previous.close(1000, "replaced");
    this.o.log?.("viewport: the editor's streamer connected");
    ws.send(JSON.stringify({ type: "config", peerConnectionOptions: { iceServers: this.o.iceServers() }, protocolVersion: PS_PROTOCOL_VERSION }));
    ws.send(JSON.stringify({ type: "identify" }));
    this.broadcast({ type: "streamer", connected: true });
    this.o.onStreamer?.(true);

    ws.on("message", (data) => this.fromStreamer(ws, data.toString()));
    ws.on("close", () => {
      if (this.streamer !== ws) return;
      this.streamer = null;
      this.streamerJoined = false;
      this.o.log?.("viewport: the editor's streamer disconnected");
      this.broadcast({ type: "streamer", connected: false });
      this.o.onStreamer?.(false);
    });
    ws.on("error", () => undefined);
  }

  private fromStreamer(ws: WebSocket, text: string): void {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    const playerId = typeof m.playerId === "string" ? m.playerId : typeof m.playerId === "number" ? String(m.playerId) : null;
    switch (m.type) {
      case "endpointId":
        ws.send(JSON.stringify({ type: "endpointIdConfirm", committedId: typeof m.id === "string" ? m.id : "studio" }));
        if (ws === this.streamer && !this.streamerJoined) {
          this.streamerJoined = true;
          for (const id of this.viewers.keys()) this.announce(id);
        }
        return;
      case "ping":
        ws.send(JSON.stringify({ type: "pong", time: m.time }));
        return;
      case "offer":
        if (playerId && typeof m.sdp === "string") this.push(playerId, { type: "offer", sdp: m.sdp });
        return;
      case "iceCandidate": {
        const c = m.candidate as Record<string, unknown> | undefined;
        if (playerId && c && typeof c.candidate === "string") {
          this.push(playerId, {
            type: "iceCandidate",
            candidate: { candidate: c.candidate, sdpMid: typeof c.sdpMid === "string" ? c.sdpMid : null, sdpMLineIndex: typeof c.sdpMLineIndex === "number" ? c.sdpMLineIndex : null },
          });
        }
        return;
      }
      case "disconnectPlayer":
        if (playerId) this.removeViewer(playerId, typeof m.reason === "string" && m.reason ? m.reason : "The editor ended the stream.");
        return;
      default:
        // streamerDataChannels, layerPreference, stats and the like: nothing a view-only player needs.
        return;
    }
  }
}

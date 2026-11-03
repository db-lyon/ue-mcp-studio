/**
 * The project's end of remote control: one outbound WebSocket to the relay,
 * which delivers calls whose bodies only this computer can open. Nothing
 * listens on the network, and the relay never sees a request in the clear.
 */
import WebSocket from "ws";
import {
  COMPUTER_KEY_HEADER,
  CONNECTOR_PATH,
  DEVICE_HEADER,
  DEVICE_NAME_HEADER,
  parseFrame,
  type ConnectorFrame,
  type RelayFrame,
} from "@ue-mcp-studio/remote";
import { REMOTE_NO_PLAN, ACCOUNT_SIGNED_OUT, REMOTE_SIGN_IN_AGAIN, type RemoteConnection, type RemoteRefusal } from "@ue-mcp-studio/shared";
import type { CallSink } from "./service.js";

export type ConnectorState = RemoteConnection;

/** The words for a relay that refused the connection, by HTTP status. 403 is an account without remote control in its plan. */
export function refusal(status: number): { reason: string; code?: RemoteRefusal } {
  if (status === 401) return { reason: REMOTE_SIGN_IN_AGAIN, code: "signed-out" };
  if (status === 403) return { reason: NO_PLAN, code: "no-plan" };
  if (status === 409) return { reason: "This project's id belongs to another account.", code: "other-account" };
  return { reason: `The relay refused the connection (HTTP ${status}).` };
}

export const NO_PLAN = REMOTE_NO_PLAN;
export const NOT_SIGNED_IN = ACCOUNT_SIGNED_OUT;

/** The relay closes a live socket with this code when the account's plan lapsed. */
export const PLAN_LAPSED_CLOSE = 4003;

export type CallHandler = (kind: "sealed" | "enroll", body: string, sink: CallSink, signal: AbortSignal) => Promise<void>;

export interface ConnectorOptions {
  relayUrl: string;
  deviceId: string;
  deviceName: string;
  computerPublic: string;
  /** The ue-mcp account token, or null when this computer is not signed in. */
  token: () => Promise<string | null>;
  handle: CallHandler;
  onState: (s: ConnectorState) => void;
  log: (message: string) => void;
  /** How long to wait after the relay refused this account. */
  refusedRetryMs?: number;
}

/** Pause sending while the socket holds more than this unsent. */
const HIGH_WATER = 4 * 1024 * 1024;

export class Connector {
  private socket: WebSocket | null = null;
  private stopped = true;
  private attempt = 0;
  private retry: NodeJS.Timeout | null = null;
  private readonly inflight = new Map<string, AbortController>();
  private current: ConnectorState = { state: "off" };

  constructor(private readonly o: ConnectorOptions) {}

  get status(): ConnectorState {
    return this.current;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.set({ state: "connecting", attempt: 0 });
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.abortAll();
    this.socket?.close(1000, "turned off");
    this.socket = null;
    this.set({ state: "off" });
  }

  private set(s: ConnectorState): void {
    this.current = s;
    this.o.onState(s);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const token = await this.o.token().catch(() => null);
    if (this.stopped) return;
    if (!token) {
      this.set({ state: "error", reason: NOT_SIGNED_IN, code: "signed-out" });
      this.schedule(60_000);
      return;
    }
    this.set({ state: "connecting", attempt: this.attempt });
    const url = new URL(CONNECTOR_PATH, this.o.relayUrl);
    url.protocol = url.protocol.replace("http", "ws");
    const ws = new WebSocket(url, {
      headers: {
        authorization: `Bearer ${token}`,
        [DEVICE_HEADER]: this.o.deviceId,
        [DEVICE_NAME_HEADER]: this.o.deviceName,
        [COMPUTER_KEY_HEADER]: this.o.computerPublic,
      },
      handshakeTimeout: 15_000,
      maxPayload: 16 * 1024 * 1024,
    });
    this.socket = ws;
    let refused: { reason: string; code?: RemoteRefusal } | null = null;
    ws.on("unexpected-response", (_req, res) => {
      refused = refusal(res.statusCode ?? 0);
      res.resume();
      ws.terminate();
    });
    ws.on("message", (data) => {
      const frame = parseFrame<RelayFrame>(data);
      if (!frame) return;
      if (frame.t === "hello") {
        this.attempt = 0;
        this.set({ state: "online", login: frame.login, since: new Date().toISOString() });
        this.o.log(`remote control: online as ${frame.login}`);
      } else if (frame.t === "call") void this.call(ws, frame);
      else if (frame.t === "abort") this.inflight.get(frame.id)?.abort();
    });
    ws.on("error", () => {
      // A close follows; the reason is reported there.
    });
    ws.on("close", (code, reason) => {
      if (this.socket !== ws) return;
      this.socket = null;
      this.abortAll();
      if (this.stopped) return;
      // A lapsed plan closes a live socket; it is the same refusal as a 403 upgrade.
      const r = (refused as { reason: string; code?: RemoteRefusal } | null) ?? (code === PLAN_LAPSED_CLOSE ? refusal(403) : null);
      // A refusal will not fix itself on the next try; wait longer before asking again.
      const delay = r ? this.o.refusedRetryMs ?? 5 * 60_000 : Math.min(60_000, 1000 * 2 ** this.attempt) * (0.5 + Math.random() * 0.5);
      this.attempt++;
      if (r) this.set({ state: "error", ...r });
      else this.set({ state: "connecting", attempt: this.attempt, reason: code === 4000 ? "Another connection for this project took over." : reason.toString() || "Connection lost." });
      this.schedule(delay);
    });
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.retry) clearTimeout(this.retry);
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.connect();
    }, ms);
    this.retry.unref?.();
  }

  private abortAll(): void {
    for (const c of this.inflight.values()) c.abort();
    this.inflight.clear();
  }

  private send(ws: WebSocket, frame: ConnectorFrame): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  }

  private async call(ws: WebSocket, frame: Extract<RelayFrame, { t: "call" }>): Promise<void> {
    const controller = new AbortController();
    this.inflight.set(frame.id, controller);
    let closed = false;
    const sink: CallSink = {
      head: (status, headers) => this.send(ws, { t: "head", id: frame.id, status, headers }),
      chunk: async (bytes) => {
        this.send(ws, { t: "chunk", id: frame.id, data: Buffer.from(bytes).toString("base64") });
        while (ws.readyState === WebSocket.OPEN && ws.bufferedAmount > HIGH_WATER) await new Promise((r) => setTimeout(r, 20));
        if (ws.readyState !== WebSocket.OPEN) controller.abort();
      },
      end: () => {
        if (closed) return;
        closed = true;
        this.send(ws, { t: "end", id: frame.id });
      },
      fail: (status, error) => {
        if (closed) return;
        closed = true;
        this.send(ws, { t: "fail", id: frame.id, status, error });
      },
    };
    try {
      await this.o.handle(frame.kind, frame.body, sink, controller.signal);
    } catch (e) {
      sink.fail(500, e instanceof Error ? e.message : String(e));
    } finally {
      this.inflight.delete(frame.id);
    }
  }
}

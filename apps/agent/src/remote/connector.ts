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
  encodeChunk,
  parseFrame,
  type ConnectorFrame,
  type RelayFrame,
} from "@ue-mcp-studio/remote";
import { REMOTE_NO_PLAN, ACCOUNT_SIGNED_OUT, REMOTE_SIGN_IN_AGAIN, type RemoteConnection, type RemoteRefusal } from "@ue-mcp-studio/shared";
import type { CallSink } from "./service.js";
import { SendQueue } from "./send-queue.js";

export type ConnectorState = RemoteConnection;

/** The words for a relay that refused the connection, by HTTP status. 403 is an account without remote control in its plan. */
export function refusal(status: number): { reason: string; code?: RemoteRefusal } | null {
  if (status === 401) return { reason: REMOTE_SIGN_IN_AGAIN, code: "signed-out" };
  if (status === 403) return { reason: NO_PLAN, code: "no-plan" };
  if (status === 409) return { reason: "This project's id belongs to another account.", code: "other-account" };
  // Anything else (a 5xx while the relay redeploys, a proxy error) is passing: retry on the normal backoff.
  return null;
}

/** The relay closes the older socket with this code when another connection for the same project arrives. */
export const TAKEN_OVER_CLOSE = 4000;
/** After a takeover, wait this long before trying again, so two processes for one project cannot trade places every second. */
export const TAKEOVER_RETRY_MS = 60_000;

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
  /** Checked before each connection: false when another process now runs this project, and this one stands down. */
  owns?: () => boolean;
  /** A call that waited long to be sent, or a dropped connection: for Diagnostics. */
  onDiagnostic?: (d: ConnectorDiagnostic) => void;
}

/** What the connector reports for Diagnostics. */
export type ConnectorDiagnostic =
  | { kind: "slow"; waitedMs: number; totalMs: number; backlogCalls: number; backlogBytes: number }
  | { kind: "closed"; code: number; reason: string; onlineMs: number };

/** A call whose frames waited this long to be sent is reported as slow. */
export const SLOW_SEND_MS = 2000;

export class Connector {
  private socket: WebSocket | null = null;
  private stopped = true;
  private attempt = 0;
  private retry: NodeJS.Timeout | null = null;
  private readonly inflight = new Map<string, AbortController>();
  private current: ConnectorState = { state: "off" };
  /** The relay said hello with `binary`: chunks go as binary frames instead of base64 JSON. */
  private binary = false;
  /** Frames to the relay, in fair turns across calls. One per socket. */
  private queue: SendQueue | null = null;
  private onlineAt = 0;

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
    if (this.o.owns && !this.o.owns()) {
      this.o.log("remote control: another ue-mcp process runs this project; this one stays off");
      this.stopped = true;
      this.set({ state: "off" });
      return;
    }
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
    this.binary = false;
    this.queue?.clear();
    const queue = new SendQueue({
      get bufferedAmount() {
        return ws.bufferedAmount;
      },
      get open() {
        return ws.readyState === WebSocket.OPEN;
      },
      send: (data, binary) => ws.send(data, { binary }),
    });
    this.queue = queue;
    let refused: { reason: string; code?: RemoteRefusal } | null = null;
    let failedStatus = 0;
    ws.on("unexpected-response", (_req, res) => {
      failedStatus = res.statusCode ?? 0;
      refused = refusal(failedStatus);
      res.resume();
      ws.terminate();
    });
    ws.on("message", (data) => {
      const frame = parseFrame<RelayFrame>(data);
      if (!frame) return;
      if (frame.t === "hello") {
        this.attempt = 0;
        this.binary = frame.binary === true;
        if (frame.acks === true) queue.useAcks();
        this.onlineAt = Date.now();
        this.set({ state: "online", login: frame.login, since: new Date().toISOString() });
        this.o.log(`remote control: online as ${frame.login}`);
      } else if (frame.t === "ack") queue.ack(frame.n);
      else if (frame.t === "call") void this.call(queue, frame);
      else if (frame.t === "abort") {
        this.inflight.get(frame.id)?.abort();
        queue.close(frame.id, true);
      }
    });
    ws.on("error", () => {
      // A close follows; the reason is reported there.
    });
    ws.on("close", (code, reason) => {
      queue.clear();
      if (this.socket !== ws) return;
      this.socket = null;
      this.abortAll();
      if (this.onlineAt) {
        const onlineMs = Date.now() - this.onlineAt;
        this.onlineAt = 0;
        this.o.log(`remote control: connection to the relay closed (code ${code}${reason.length ? `, ${reason.toString()}` : ""}) after ${Math.round(onlineMs / 1000)}s online`);
        this.o.onDiagnostic?.({ kind: "closed", code, reason: reason.toString(), onlineMs });
      }
      if (this.stopped) return;
      // A lapsed plan closes a live socket; it is the same refusal as a 403 upgrade.
      const r = (refused as { reason: string; code?: RemoteRefusal } | null) ?? (code === PLAN_LAPSED_CLOSE ? refusal(403) : null);
      // A refusal will not fix itself on the next try; wait longer before asking again.
      const backoff = Math.min(60_000, 1000 * 2 ** this.attempt) * (0.5 + Math.random() * 0.5);
      const delay = r ? this.o.refusedRetryMs ?? 5 * 60_000 : code === TAKEN_OVER_CLOSE ? TAKEOVER_RETRY_MS : backoff;
      this.attempt++;
      if (r) this.set({ state: "error", ...r });
      else {
        const why =
          code === TAKEN_OVER_CLOSE
            ? "Another connection for this project took over."
            : failedStatus
              ? `The relay answered HTTP ${failedStatus}; trying again.`
              : reason.toString() || "Connection lost.";
        this.set({ state: "connecting", attempt: this.attempt, reason: why });
      }
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

  private async call(queue: SendQueue, frame: Extract<RelayFrame, { t: "call" }>): Promise<void> {
    const controller = new AbortController();
    this.inflight.set(frame.id, controller);
    const started = Date.now();
    let closed = false;
    const json = (f: ConnectorFrame): Promise<void> => queue.push(frame.id, JSON.stringify(f), false);
    const sink: CallSink = {
      head: (status, headers) => void json({ t: "head", id: frame.id, status, headers }),
      chunk: async (bytes) => {
        if (this.binary) await queue.push(frame.id, encodeChunk(frame.id, bytes), true);
        else await json({ t: "chunk", id: frame.id, data: Buffer.from(bytes).toString("base64") });
        if (this.queue !== queue) controller.abort();
      },
      end: () => {
        if (closed) return;
        closed = true;
        void json({ t: "end", id: frame.id });
      },
      fail: (status, error) => {
        if (closed) return;
        closed = true;
        void json({ t: "fail", id: frame.id, status, error });
      },
    };
    try {
      await this.o.handle(frame.kind, frame.body, sink, controller.signal);
    } catch (e) {
      sink.fail(500, e instanceof Error ? e.message : String(e));
    } finally {
      this.inflight.delete(frame.id);
      const waited = queue.worstWait(frame.id);
      queue.close(frame.id);
      if (waited >= SLOW_SEND_MS) {
        const b = queue.backlog();
        this.o.log(`remote control: a response waited ${(waited / 1000).toFixed(1)}s to be sent (${b.calls} calls, ${Math.round(b.bytes / 1024)} KB still queued)`);
        this.o.onDiagnostic?.({ kind: "slow", waitedMs: waited, totalMs: Date.now() - started, backlogCalls: b.calls, backlogBytes: b.bytes });
      }
    }
  }
}

/**
 * The daemon's event stream (GET /v1/events, server-sent events) over any
 * Transport, resuming from the last id after a drop.
 *
 * A restarted daemon numbers its events from 1 again, and asked to resume past
 * its newest id it sends nothing, not even its head, until its next event. So
 * before resuming, the stream asks the daemon who it is (GET /v1/health): a new
 * daemon, or one with fewer events than the last id seen, is followed from its
 * start. Every step is bounded: the identity check, the head, and with
 * `idleMs` an open stream that goes silent.
 */
import { readJson, type Transport } from "./transport.js";

export interface StreamEvent {
  id: number;
  type: string;
  at: string;
  data: Record<string, unknown>;
}

export const EVENTS_HEAD_TIMEOUT_MS = 6000;
export const IDENTITY_TIMEOUT_MS = 5000;
/** Through the relay a quiet stream carries a keepalive every 20 seconds; this long with no bytes means it died. */
export const STREAM_IDLE_MS = 50_000;
export const MAX_BACKOFF_MS = 5000;

/** Splits a server-sent event stream into events, across chunk boundaries. */
export class SseParser {
  private buf = "";
  private readonly decoder = new TextDecoder();

  push(chunk: Uint8Array): Array<{ id?: number; type: string; data: string }> {
    this.buf += this.decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    const out: Array<{ id?: number; type: string; data: string }> = [];
    let cut: number;
    while ((cut = this.buf.indexOf("\n\n")) >= 0) {
      const block = this.buf.slice(0, cut);
      this.buf = this.buf.slice(cut + 2);
      const id = /^id: ?(\d+)$/m.exec(block)?.[1];
      const type = /^event: ?(.+)$/m.exec(block)?.[1];
      const data = /^data: ?(.*)$/m.exec(block)?.[1];
      if (!type || data === undefined) continue;
      out.push({ ...(id ? { id: Number(id) } : {}), type, data });
    }
    return out;
  }
}

export interface DaemonIdentity {
  startedAt: string;
  lastEventId: number;
}

export async function daemonIdentity(transport: Transport, signal?: AbortSignal): Promise<DaemonIdentity | null> {
  try {
    const reply = await transport("GET", "/v1/health", { signal, headTimeoutMs: IDENTITY_TIMEOUT_MS });
    const h = await readJson<{ startedAt?: unknown; lastEventId?: unknown }>(reply);
    if (reply.status !== 200) return null;
    return { startedAt: String(h.startedAt ?? ""), lastEventId: Number(h.lastEventId ?? 0) || 0 };
  } catch {
    return null;
  }
}

export interface EventStreamOptions {
  /** Drop a stream that carries no bytes for this long. */
  idleMs?: number;
  /** Why a connection attempt ended, for diagnostics. */
  onDrop?: (cause: string) => void;
}

export interface EventStream {
  /** Reconnect now; `force` drops a stream that still looks open (after the app slept). */
  kick(force?: boolean): void;
  stop(): void;
}

export function subscribeEvents(transport: Transport, onEvent: (e: StreamEvent) => void, onStatus?: (connected: boolean) => void, options: EventStreamOptions = {}): EventStream {
  let stopped = false;
  let lastId = 0;
  let daemonStarted = "";
  let controller: { signal: AbortSignal; abort(): void } | null = null;
  let wake: (() => void) | null = null;
  let connected = false;
  let skipWait = false;

  const kick = (force = false): void => {
    if (connected && !force) return;
    skipWait = true;
    controller?.abort();
    wake?.();
  };

  const run = async (): Promise<void> => {
    for (let attempt = 0; !stopped; attempt++) {
      const c = new AbortController();
      controller = c;
      let cause = "";
      try {
        let resumeFrom = 0;
        if (lastId > 0) {
          const who = await daemonIdentity(transport, c.signal);
          if (c.signal.aborted) throw new Error("woken");
          const same = !!who && (!daemonStarted || who.startedAt === daemonStarted);
          if (who && same && who.lastEventId > lastId) resumeFrom = lastId;
          if (!same || (who && who.lastEventId < lastId)) lastId = 0;
        }
        const reply = await transport("GET", "/v1/events", {
          signal: c.signal,
          headTimeoutMs: EVENTS_HEAD_TIMEOUT_MS,
          headers: { accept: "text/event-stream", ...(resumeFrom > 0 ? { "last-event-id": String(resumeFrom) } : {}) },
        });
        if (reply.status !== 200 || !reply.body) {
          cause = `HTTP ${reply.status}`;
          throw new Error(cause);
        }
        connected = true;
        onStatus?.(true);
        attempt = 0;
        void daemonIdentity(transport, c.signal).then((who) => {
          if (who && !c.signal.aborted) daemonStarted = who.startedAt;
        });
        const parser = new SseParser();
        let idle: ReturnType<typeof setTimeout> | null = null;
        const quiet = (): void => {
          if (!options.idleMs) return;
          if (idle) clearTimeout(idle);
          idle = setTimeout(() => {
            cause = `no bytes for ${Math.round((options.idleMs ?? 0) / 1000)}s`;
            c.abort();
          }, options.idleMs);
        };
        quiet();
        try {
          for await (const chunk of reply.body) {
            quiet();
            for (const e of parser.push(chunk)) {
              if (e.id !== undefined) lastId = e.id;
              let parsed: Record<string, unknown> & { at?: string };
              try {
                parsed = JSON.parse(e.data) as Record<string, unknown> & { at?: string };
              } catch {
                continue;
              }
              const { at, ...rest } = parsed;
              onEvent({ id: e.id ?? 0, type: e.type, at: at ?? new Date().toISOString(), data: rest });
            }
            if (c.signal.aborted) break;
          }
        } finally {
          if (idle) clearTimeout(idle);
        }
        cause ||= "ended by the daemon or the relay";
      } catch (e) {
        if (!cause) cause = skipWait || stopped ? "reconnect asked" : e instanceof Error && e.name !== "AbortError" ? `network error: ${e.message}` : "aborted";
      }
      if (!stopped) options.onDrop?.(cause);
      if (connected) {
        connected = false;
        onStatus?.(false);
      } else if (attempt === 0) onStatus?.(false);
      if (stopped) return;
      if (skipWait) {
        skipWait = false;
        continue;
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(done, Math.min(MAX_BACKOFF_MS, 250 * 2 ** attempt));
        function done(): void {
          clearTimeout(t);
          wake = null;
          skipWait = false;
          resolve();
        }
        wake = done;
      });
    }
  };
  void run();

  return {
    kick,
    stop() {
      stopped = true;
      controller?.abort();
      wake?.();
    },
  };
}

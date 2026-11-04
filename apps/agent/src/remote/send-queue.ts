/**
 * The connector's sending side. Every call for a project shares one socket to
 * the relay, so one big response (a playtest's captures, a long transcript)
 * written straight onto it holds every small one behind it: on a slow upload
 * the page's health check and event stream wait seconds and it decides ue-mcp
 * is offline. Here each call has its own queue and frames go out in turns, one
 * frame per call per turn, with frames of calls that send little (heads,
 * events, keepalives, small answers) ahead of bulk. The socket is only fed
 * while its own buffer is nearly empty, so a newcomer waits at most about one
 * frame per busy call, and a call may hold only a small window of queued bytes
 * before its producer waits.
 */

export interface Wire {
  /** Bytes handed to the socket and not yet written out. */
  readonly bufferedAmount: number;
  readonly open: boolean;
  send(data: string | Uint8Array, binary: boolean): void;
}

interface Frame {
  data: string | Uint8Array;
  binary: boolean;
  bytes: number;
}

interface Lane {
  id: string;
  frames: Frame[];
  queued: number;
  /** Bytes this call has sent so far: calls that sent little go first. */
  sent: number;
  /** Producers waiting for the window to open. */
  waiters: Array<() => void>;
  /** When the oldest queued frame was queued, for diagnostics. */
  since: number;
  /** Longest a frame of this call waited, for diagnostics. */
  worstWait: number;
  /** The call ended: forget it once its last frame is out. */
  closing: boolean;
}

/** Feed the socket only while it holds less than this unsent. */
export const SOCKET_LOW_WATER = 64 * 1024;
/**
 * With a relay that acknowledges what it read: keep at most this many bytes
 * sent and not yet read by the relay. The socket's own buffer says nothing
 * about bytes the operating system already took, which on a slow upload can
 * be megabytes queued ahead of a small answer.
 */
export const IN_FLIGHT = 96 * 1024;
/** A call may queue this much before its producer waits. */
export const CALL_WINDOW = 256 * 1024;
/** A call that has sent no more than this is light: its frames go before bulk. */
export const LIGHT_BYTES = 64 * 1024;
/** A frame this small is light too, whatever its call sent before: events and keepalives on a long stream. */
export const LIGHT_FRAME = 8 * 1024;

export class SendQueue {
  private readonly lanes = new Map<string, Lane>();
  private order: string[] = [];
  private turn = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pumping = false;
  /** Bytes sent, and bytes the relay said it read; null until the relay offers acknowledgements. */
  private sentTotal = 0;
  private ackedTotal: number | null = null;

  constructor(
    private readonly wire: Wire,
    private readonly opts: { lowWater?: number; window?: number; inFlight?: number; now?: () => number } = {},
  ) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private lane(id: string): Lane {
    let l = this.lanes.get(id);
    if (!l) {
      l = { id, frames: [], queued: 0, sent: 0, waiters: [], since: 0, worstWait: 0, closing: false };
      this.lanes.set(id, l);
      this.order.push(id);
    }
    return l;
  }

  /** Queue one frame of call `id`; resolves when the call's window has room for more. */
  async push(id: string, data: string | Uint8Array, binary: boolean): Promise<void> {
    const l = this.lane(id);
    const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
    if (l.frames.length === 0) l.since = this.now();
    l.frames.push({ data, binary, bytes });
    l.queued += bytes;
    this.pump();
    const window = this.opts.window ?? CALL_WINDOW;
    while (this.wire.open && this.lanes.get(id) === l && l.queued > window) await new Promise<void>((r) => l.waiters.push(r));
  }

  /** Forget call `id` once its last frame went out, or drop what it still had queued when it was aborted. */
  close(id: string, discard = false): void {
    const l = this.lanes.get(id);
    if (!l) return;
    if (discard) {
      l.frames = [];
      l.queued = 0;
    }
    if (l.frames.length === 0) this.forget(l);
    else l.closing = true;
  }

  /** The relay acknowledges reads: from now on the in-flight window, not the socket buffer, paces sending. */
  useAcks(): void {
    this.ackedTotal ??= this.sentTotal;
  }

  /** The relay has read `n` bytes in all. */
  ack(n: number): void {
    if (this.ackedTotal === null) return;
    if (n > this.ackedTotal) this.ackedTotal = n;
    this.pump();
  }

  /** Bytes sent and not yet acknowledged, or null without acknowledgements. */
  inFlight(): number | null {
    return this.ackedTotal === null ? null : this.sentTotal - this.ackedTotal;
  }

  private room(): boolean {
    if (!this.wire.open) return false;
    if (this.ackedTotal !== null) return this.sentTotal - this.ackedTotal < (this.opts.inFlight ?? IN_FLIGHT) && this.wire.bufferedAmount < (this.opts.lowWater ?? SOCKET_LOW_WATER);
    return this.wire.bufferedAmount < (this.opts.lowWater ?? SOCKET_LOW_WATER);
  }

  /** Longest any frame of call `id` waited so far, in ms. */
  worstWait(id: string): number {
    return this.lanes.get(id)?.worstWait ?? 0;
  }

  /** Calls with frames waiting, and the bytes they hold. */
  backlog(): { calls: number; bytes: number } {
    let calls = 0;
    let bytes = 0;
    for (const l of this.lanes.values()) {
      if (l.frames.length) {
        calls++;
        bytes += l.queued;
      }
    }
    return { calls, bytes };
  }

  /** Drop everything: the socket is gone. Waiting producers are released. */
  clear(): void {
    for (const l of this.lanes.values()) for (const w of l.waiters.splice(0)) w();
    this.lanes.clear();
    this.order = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private forget(l: Lane): void {
    for (const w of l.waiters.splice(0)) w();
    this.lanes.delete(l.id);
    this.order = this.order.filter((x) => x !== l.id);
  }

  /** The next call to send a frame: light calls first, then bulk in turns. */
  private pick(): Lane | null {
    const ready = this.order.map((id) => this.lanes.get(id)!).filter((l) => l.frames.length > 0);
    if (ready.length === 0) return null;
    const light = ready.filter((l) => l.sent <= LIGHT_BYTES || l.frames[0].bytes <= LIGHT_FRAME);
    const pool = light.length ? light : ready;
    this.turn = (this.turn + 1) % pool.length;
    return pool[this.turn];
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.room()) {
        const l = this.pick();
        if (!l) break;
        const f = l.frames.shift()!;
        l.queued -= f.bytes;
        l.sent += f.bytes;
        const waited = this.now() - l.since;
        if (waited > l.worstWait) l.worstWait = waited;
        l.since = this.now();
        this.wire.send(f.data, f.binary);
        this.sentTotal += f.bytes;
        const window = this.opts.window ?? CALL_WINDOW;
        if (l.queued <= window) for (const w of l.waiters.splice(0)) w();
        if (l.frames.length === 0 && l.closing) this.forget(l);
      }
    } finally {
      this.pumping = false;
    }
    if (!this.wire.open) {
      this.clear();
      return;
    }
    // Frames are left only when the socket is still busy: look again shortly.
    if (this.backlog().calls > 0 && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.pump();
      }, 5);
      (this.timer as { unref?: () => void }).unref?.();
    }
  }
}

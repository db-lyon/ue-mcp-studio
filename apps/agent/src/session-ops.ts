/**
 * A watch of each session for the clients (#463 L2): every saved change
 * becomes one op on the event stream (studio.session.ops), in order per
 * session, which the relay carries to phones like every other event. A client
 * holds a snapshot (the paged sync, which says which op it is current with)
 * and applies the ops after it, so a change reaches it without a request.
 *
 * Ops are absolute: an entry is set at its index, the transcript cut or grown
 * to a length, a field set. Applying an op to a snapshot that already has
 * some of its changes is harmless, so a snapshot taken between a change and
 * its op is safe. Writes close together fold into one op.
 */
import type { SessionDetail, SessionOps, TranscriptEntry } from "@ue-mcp-studio/shared";
import { headOf, leanTranscript } from "./session-delta.js";

/** Writes within this long of each other fold into one op. */
export const OPS_FOLD_MS = 30;
/** An op larger than this (as JSON) is sent as `resync`: the client reads the session instead. */
export const OPS_MAX_BYTES = 256 * 1024;

interface Seen {
  seq: number;
  hashes: number[];
  head: Record<string, string>;
}

export class SessionWatch {
  private readonly seen = new Map<string, Seen>();
  private readonly due = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly base = Date.now();

  constructor(
    private readonly detailOf: (id: string) => SessionDetail | null,
    private readonly publish: (ops: SessionOps) => void,
    private readonly foldMs = OPS_FOLD_MS,
  ) {}

  /** The op a snapshot of the session taken now is current with. */
  seq(id: string): number {
    return this.state(id).seq;
  }

  /** The session was saved: its op goes out once the burst of writes it belongs to ends. */
  changed(id: string): void {
    // No client has read it since this daemon started: no snapshot for an op to follow, and its first read starts the watch.
    if (!this.seen.has(id) || this.due.has(id)) return;
    const t = setTimeout(() => {
      this.due.delete(id);
      this.flush(id);
    }, this.foldMs);
    (t as { unref?: () => void }).unref?.();
    this.due.set(id, t);
  }

  /** The session was deleted: nothing more goes out for it. */
  forget(id: string): void {
    const t = this.due.get(id);
    if (t) clearTimeout(t);
    this.due.delete(id);
    this.seen.delete(id);
  }

  dispose(): void {
    for (const t of this.due.values()) clearTimeout(t);
    this.due.clear();
  }

  /** What the session looks like now against what the last op left, sent as one op when anything differs. */
  flush(id: string): void {
    const detail = this.detailOf(id);
    if (!detail) return this.forget(id);
    const was = this.state(id, detail);
    const { lean, hashes } = leanTranscript(detail.transcript);
    const entries: Array<[number, TranscriptEntry, number]> = [];
    for (let i = 0; i < lean.length; i++) if (was.hashes[i] !== hashes[i]) entries.push([i, lean[i], hashes[i]]);
    const head = headOf(detail) as unknown as Record<string, unknown>;
    const json: Record<string, string> = {};
    const changedHead: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(head)) {
      json[k] = JSON.stringify(v);
      if (was.head[k] !== json[k]) changedHead[k] = v;
    }
    const removed = Object.keys(was.head).filter((k) => !(k in json));
    if (!entries.length && lean.length === was.hashes.length && !Object.keys(changedHead).length && !removed.length) return;
    const seq = was.seq + 1;
    this.seen.set(id, { seq, hashes, head: json });
    let ops: SessionOps = {
      sessionId: id,
      seq,
      length: lean.length,
      entries,
      ...(Object.keys(changedHead).length ? { head: changedHead as SessionOps["head"] } : {}),
      ...(removed.length ? { removed } : {}),
    };
    if (JSON.stringify(ops).length > OPS_MAX_BYTES) ops = { sessionId: id, seq, length: lean.length, entries: [], resync: true };
    this.publish(ops);
  }

  /** What the last op left; for a session not seen yet, what it is now, with no op owed for it. */
  private state(id: string, now?: SessionDetail): Seen {
    let s = this.seen.get(id);
    if (!s) {
      const detail = now ?? this.detailOf(id);
      const head: Record<string, string> = {};
      if (detail) for (const [k, v] of Object.entries(headOf(detail))) head[k] = JSON.stringify(v);
      // Numbered from this daemon's start time, so a client still holding a number from an earlier daemon sees a gap, never an op it thinks it has.
      s = { seq: this.base, hashes: detail ? leanTranscript(detail.transcript).hashes : [], head };
      this.seen.set(id, s);
    }
    return s;
  }
}

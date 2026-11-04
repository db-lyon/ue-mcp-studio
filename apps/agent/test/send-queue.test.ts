import { describe, expect, it } from "vitest";
import { CALL_WINDOW, IN_FLIGHT, SendQueue, type Wire } from "../src/remote/send-queue.js";

/** A socket that takes everything at once (as the operating system's buffer does) and records the order. */
function wire(): Wire & { sent: Array<{ data: string | Uint8Array }>; buffered: number; isOpen: boolean } {
  const w = {
    sent: [] as Array<{ data: string | Uint8Array }>,
    buffered: 0,
    isOpen: true,
    get bufferedAmount() {
      return w.buffered;
    },
    get open() {
      return w.isOpen;
    },
    send(data: string | Uint8Array) {
      w.sent.push({ data });
    },
  };
  return w;
}

const bulk = (tag: number, kb = 32): Uint8Array => new Uint8Array(kb * 1024).fill(tag);
const tagOf = (d: string | Uint8Array): string => (typeof d === "string" ? d : `bulk${d[0]}`);

describe("SendQueue", () => {
  it("sends a small answer ahead of a large one already queued, once the relay acknowledges reads", async () => {
    const w = wire();
    const q = new SendQueue(w);
    q.useAcks();
    // A big response: 1 MB in 32 KB frames, queued without waiting (its producer would wait on the window).
    for (let i = 0; i < 32; i++) void q.push("big", bulk(1), true);
    // Only the in-flight window went out; the rest waits for acknowledgements.
    expect(w.sent.length).toBe(Math.ceil(IN_FLIGHT / (32 * 1024)));
    // A health check arrives.
    void q.push("health", "head:health", false);
    void q.push("health", "end:health", false);
    // The relay reads what was in flight; the next frames out are the small call's, not more bulk.
    q.ack(w.sent.length * 32 * 1024);
    const next = w.sent.slice(Math.ceil(IN_FLIGHT / (32 * 1024))).map((s) => tagOf(s.data));
    expect(next.slice(0, 2)).toEqual(["head:health", "end:health"]);
  });

  it("takes turns between two large responses", async () => {
    const w = wire();
    const q = new SendQueue(w);
    q.useAcks();
    for (let i = 0; i < 8; i++) void q.push("a", bulk(1), true);
    for (let i = 0; i < 8; i++) void q.push("b", bulk(2), true);
    let acked = 0;
    for (let i = 0; i < 20; i++) {
      acked = w.sent.length * 32 * 1024;
      q.ack(acked);
    }
    const order = w.sent.map((s) => tagOf(s.data));
    // After the first frames of a, b gets its turns: neither waits for the other to finish.
    const firstB = order.indexOf("bulk2");
    expect(firstB).toBeGreaterThan(0);
    expect(firstB).toBeLessThan(6);
    expect(order.filter((t) => t === "bulk1")).toHaveLength(8);
    expect(order.filter((t) => t === "bulk2")).toHaveLength(8);
  });

  it("keeps each call's frames in order", async () => {
    const w = wire();
    const q = new SendQueue(w);
    q.useAcks();
    for (let i = 0; i < 6; i++) void q.push("a", new Uint8Array(40 * 1024).fill(i), true);
    for (let i = 0; i < 10; i++) q.ack(w.sent.length * 40 * 1024);
    expect(w.sent.map((s) => (s.data as Uint8Array)[0])).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("makes a producer wait once its call holds a full window, and lets it go as frames leave", async () => {
    const w = wire();
    const q = new SendQueue(w);
    q.useAcks();
    let resolved = 0;
    const frames = Math.ceil(CALL_WINDOW / (32 * 1024)) + 6;
    for (let i = 0; i < frames; i++) void q.push("big", bulk(1), true).then(() => resolved++);
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBeLessThan(frames);
    for (let i = 0; i < 20; i++) q.ack(w.sent.length * 32 * 1024);
    await new Promise((r) => setTimeout(r, 0));
    expect(resolved).toBe(frames);
  });

  it("without acknowledgements, feeds the socket only while its buffer is low", () => {
    const w = wire();
    const q = new SendQueue(w, { lowWater: 64 * 1024 });
    w.buffered = 100 * 1024;
    void q.push("a", bulk(1), true);
    expect(w.sent).toHaveLength(0);
    w.buffered = 0;
    void q.push("a", bulk(1), true);
    expect(w.sent.length).toBeGreaterThan(0);
  });

  it("drops an aborted call's queued frames", () => {
    const w = wire();
    const q = new SendQueue(w);
    q.useAcks();
    for (let i = 0; i < 10; i++) void q.push("a", bulk(1), true);
    const before = w.sent.length;
    q.close("a", true);
    q.ack(before * 32 * 1024);
    expect(w.sent.length).toBe(before);
    expect(q.backlog()).toEqual({ calls: 0, bytes: 0 });
  });

  it("releases waiting producers when the socket closes", async () => {
    const w = wire();
    const q = new SendQueue(w);
    q.useAcks();
    const waits = Array.from({ length: 20 }, () => q.push("a", bulk(1), true));
    w.isOpen = false;
    q.clear();
    await expect(Promise.all(waits)).resolves.toBeDefined();
  });
});

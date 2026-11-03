// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EVENTS_HEAD_TIMEOUT_MS, subscribeEvents } from "./api";

/** A fake daemon behind fetch, as the page reaches it directly or through the relay. */
interface FakeDaemon {
  startedAt: string;
  lastEventId: number;
  /** Events the stream sends once opened. */
  events: { id: number; type: string }[];
  /** End each stream right after its events, as a daemon going away does. */
  closeAfterSend: boolean;
  /** Hold every head back. */
  stallHead: boolean;
}

let daemon: FakeDaemon;
let eventCalls: { lastEventId: string | null }[];

function sse(events: { id: number; type: string }[], close: boolean): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const e of events) c.enqueue(enc.encode(`id: ${e.id}\nevent: ${e.type}\ndata: {"at":"2026-11-03T00:00:00Z"}\n\n`));
      if (close) c.close();
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  daemon = { startedAt: "A", lastEventId: 0, events: [], closeAfterSend: false, stallHead: false };
  eventCalls = [];
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    if (url === "/v1/health") return Promise.resolve(new Response(JSON.stringify({ startedAt: daemon.startedAt, lastEventId: daemon.lastEventId })));
    const last = new Headers(init?.headers).get("last-event-id");
    eventCalls.push({ lastEventId: last });
    // The daemon's behaviour: asked to resume past its newest id, it sends no head until its next event.
    if (daemon.stallHead || (last !== null && Number(last) > daemon.lastEventId)) {
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    }
    const after = Number(last ?? 0);
    return Promise.resolve(new Response(sse(daemon.events.filter((e) => e.id > after), daemon.closeAfterSend), { headers: { "content-type": "text/event-stream" } }));
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const flush = (ms = 0): Promise<void> => vi.advanceTimersByTimeAsync(ms).then(() => undefined);

describe("subscribeEvents", () => {
  it("follows a restarted daemon from its start instead of resuming past its newest id", async () => {
    daemon.lastEventId = 50;
    daemon.events = [{ id: 50, type: "a" }];
    daemon.closeAfterSend = true;
    const seen: number[] = [];
    const status: boolean[] = [];
    const stop = subscribeEvents((e) => seen.push(e.id), (c) => status.push(c));
    await flush();
    expect(seen).toEqual([50]);

    // Restarted: ids begin again, below the one this page last saw.
    daemon.startedAt = "B";
    daemon.lastEventId = 3;
    daemon.events = [{ id: 3, type: "b" }];
    daemon.closeAfterSend = false;
    await flush(1000);
    expect(seen).toEqual([50, 3]);
    expect(status[status.length - 1]).toBe(true);
    expect(eventCalls[eventCalls.length - 1].lastEventId).toBeNull();
    stop();
  });

  it("resumes from the last id on the same daemon", async () => {
    daemon.lastEventId = 5;
    daemon.events = [{ id: 5, type: "a" }];
    daemon.closeAfterSend = true;
    const stop = subscribeEvents(() => {}, () => {});
    await flush();
    daemon.closeAfterSend = false;
    await flush(1000);
    expect(eventCalls[1].lastEventId).toBe("5");
    stop();
  });

  it("gives up on a stalled head after the timeout and connects once it answers", async () => {
    daemon.stallHead = true;
    const status: boolean[] = [];
    const stop = subscribeEvents(() => {}, (c) => status.push(c));
    await flush(EVENTS_HEAD_TIMEOUT_MS - 100);
    expect(eventCalls).toHaveLength(1);
    expect(status).toEqual([]);
    await flush(200);
    expect(status).toEqual([false]);
    daemon.stallHead = false;
    await flush(1000);
    expect(eventCalls.length).toBeGreaterThanOrEqual(2);
    expect(status[status.length - 1]).toBe(true);
    stop();
  });

  it("retries at once when the page regains focus instead of waiting out the backoff", async () => {
    daemon.stallHead = true;
    const stop = subscribeEvents(() => {}, () => {});
    await flush(EVENTS_HEAD_TIMEOUT_MS * 3 + 6000);
    const before = eventCalls.length;
    daemon.stallHead = false;
    window.dispatchEvent(new Event("focus"));
    await flush(10);
    expect(eventCalls.length).toBe(before + 1);
    stop();
  });
});

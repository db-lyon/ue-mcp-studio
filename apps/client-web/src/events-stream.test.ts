// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EVENTS_HEAD_TIMEOUT_MS, IDENTITY_TIMEOUT_MS, WAKE_REFRESH_MS, entryScript, reconnectEvents, subscribeEvents } from "./api";

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
  /** The next this many health requests are lost on the way: never answered, only aborted. */
  loseHealth: number;
  /** Streams stay open with nothing on them, as a connection that died silently does. */
  silent: boolean;
}

let daemon: FakeDaemon;
let eventCalls: { lastEventId: string | null }[];
let healthCalls: number;

const hang = (init?: RequestInit): Promise<Response> =>
  new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));

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
  daemon = { startedAt: "A", lastEventId: 0, events: [], closeAfterSend: false, stallHead: false, loseHealth: 0, silent: false };
  eventCalls = [];
  healthCalls = 0;
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    if (url === "/v1/health") {
      healthCalls++;
      if (daemon.loseHealth > 0) {
        daemon.loseHealth--;
        return hang(init);
      }
      return Promise.resolve(new Response(JSON.stringify({ startedAt: daemon.startedAt, lastEventId: daemon.lastEventId })));
    }
    const last = new Headers(init?.headers).get("last-event-id");
    eventCalls.push({ lastEventId: last });
    // The daemon's behaviour: asked to resume past its newest id, it sends no head until its next event.
    if (daemon.stallHead || (last !== null && Number(last) > daemon.lastEventId)) {
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    }
    const after = Number(last ?? 0);
    if (daemon.silent) {
      // Open, then nothing: the body errors only when the request is aborted.
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          init?.signal?.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
        },
      });
      return Promise.resolve(new Response(body, { headers: { "content-type": "text/event-stream" } }));
    }
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

  it("a health request lost on the way cannot hold the stream down", async () => {
    daemon.lastEventId = 5;
    daemon.events = [{ id: 5, type: "a" }];
    daemon.closeAfterSend = true;
    const status: boolean[] = [];
    const stop = subscribeEvents(() => {}, (c) => status.push(c));
    await flush();
    // The stream drops, and the identity check before the resume is never answered.
    daemon.loseHealth = 1;
    daemon.closeAfterSend = false;
    const calls = eventCalls.length;
    await flush(1000);
    expect(eventCalls.length).toBe(calls);
    await flush(IDENTITY_TIMEOUT_MS);
    expect(eventCalls.length).toBe(calls + 1);
    expect(status[status.length - 1]).toBe(true);
    stop();
  });

  it("Retry drops a lost health request at once instead of waiting for its timeout", async () => {
    daemon.lastEventId = 5;
    daemon.events = [{ id: 5, type: "a" }];
    daemon.closeAfterSend = true;
    const status: boolean[] = [];
    const stop = subscribeEvents(() => {}, (c) => status.push(c));
    await flush();
    daemon.loseHealth = 1;
    daemon.closeAfterSend = false;
    await flush(500);
    reconnectEvents();
    await flush(50);
    expect(status[status.length - 1]).toBe(true);
    expect(healthCalls).toBeGreaterThanOrEqual(3);
    stop();
  });

  it("drops an open stream that goes silent past idleMs and connects again", async () => {
    daemon.silent = true;
    const status: boolean[] = [];
    const stop = subscribeEvents(() => {}, (c) => status.push(c), { idleMs: 50_000 });
    await flush(10);
    expect(status).toEqual([true]);
    await flush(49_000);
    expect(eventCalls).toHaveLength(1);
    await flush(2000);
    expect(status.slice(0, 2)).toEqual([true, false]);
    expect(eventCalls.length).toBeGreaterThanOrEqual(2);
    stop();
  });

  it("keeps a quiet stream open without idleMs, as the local panel does", async () => {
    daemon.silent = true;
    const status: boolean[] = [];
    const stop = subscribeEvents(() => {}, (c) => status.push(c));
    await flush(10 * 60_000);
    expect(status).toEqual([true]);
    expect(eventCalls).toHaveLength(1);
    stop();
  });

  it("a page back after sleeping opens a fresh stream even when the old one looks open", async () => {
    daemon.silent = true;
    const stop = subscribeEvents(() => {}, () => {});
    await flush(10);
    expect(eventCalls).toHaveLength(1);
    const visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await flush(WAKE_REFRESH_MS + 1000);
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await flush(10);
    expect(eventCalls).toHaveLength(2);
    visibility.mockRestore();
    stop();
  });

  it("a short look away keeps the open stream", async () => {
    daemon.silent = true;
    const stop = subscribeEvents(() => {}, () => {});
    await flush(10);
    const visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await flush(2000);
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await flush(10);
    expect(eventCalls).toHaveLength(1);
    visibility.mockRestore();
    stop();
  });

  it("an unfrozen page opens a fresh stream", async () => {
    daemon.silent = true;
    const stop = subscribeEvents(() => {}, () => {});
    await flush(10);
    document.dispatchEvent(new Event("resume"));
    await flush(10);
    expect(eventCalls).toHaveLength(2);
    stop();
  });
});

describe("a page whose UI was updated while it slept", () => {
  it("reloads into the new build once, after the daemon restarted", async () => {
    const script = document.createElement("script");
    script.setAttribute("src", "/ui/assets/index-OLDBUILD1.js");
    document.head.appendChild(script);
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    sessionStorage.clear();
    const realFetch = fetch;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
      url === "/ui/" ? Promise.resolve(new Response('<script type="module" src="/ui/assets/index-NEWBUILD2.js"></script>')) : realFetch(url, init),
    );
    daemon.lastEventId = 5;
    daemon.events = [{ id: 5, type: "a" }];
    daemon.closeAfterSend = true;
    const stop = subscribeEvents(() => {}, () => {});
    await flush(10);
    expect(reload).not.toHaveBeenCalled();
    daemon.startedAt = "B";
    daemon.lastEventId = 1;
    daemon.events = [{ id: 1, type: "b" }];
    daemon.closeAfterSend = false;
    await flush(1000);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem("studio.reloadedFor")).toBe("/assets/index-NEWBUILD2.js");
    stop();
    script.remove();
  });
});

describe("entryScript", () => {
  it("reads the hashed entry script from an index page or a script list", () => {
    expect(entryScript('<script type="module" crossorigin src="/ui/assets/index-Dk3_a9Zq.js"></script>')).toBe("/assets/index-Dk3_a9Zq.js");
    expect(entryScript("/ui/assets/vendor-x1.js /ui/assets/index-AAAA1111.js")).toBe("/assets/index-AAAA1111.js");
    expect(entryScript("<html></html>")).toBeNull();
  });
});

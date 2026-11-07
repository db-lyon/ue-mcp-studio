import { describe, expect, it } from "vitest";
import { createLock, createNoticeGate, newestEventId, HttpError, requestJson, SseParser, subscribeEvents, unreachable, type Reply, type StreamEvent, type Transport } from "../src/index.js";

const enc = new TextEncoder();

function reply(status: number, body: unknown, chunks?: string[]): Reply {
  const parts = chunks ?? [typeof body === "string" ? body : JSON.stringify(body)];
  return {
    status,
    headers: {},
    body: (async function* () {
      for (const p of parts) yield enc.encode(p);
    })(),
  };
}

describe("SseParser", () => {
  it("splits events across chunk boundaries and skips comments", () => {
    const p = new SseParser();
    expect(p.push(enc.encode(": keepalive\n\nid: 1\nevent: a\nda"))).toEqual([]);
    expect(p.push(enc.encode('ta: {"x":1}\n\nid: 2\nevent: b\ndata: {}\n\n'))).toEqual([
      { id: 1, type: "a", data: '{"x":1}' },
      { id: 2, type: "b", data: "{}" },
    ]);
  });
});

describe("subscribeEvents", () => {
  it("delivers events and resumes from the last id after a drop", async () => {
    const asked: Array<string | undefined> = [];
    let opened = 0;
    const transport: Transport = async (_m, path, o) => {
      if (path === "/v1/health") return reply(200, { startedAt: "s1", lastEventId: 5 });
      asked.push(o?.headers?.["last-event-id"]);
      opened++;
      if (opened === 1) return reply(200, "", ['id: 1\nevent: turn\ndata: {"at":"t","n":1}\n\n']);
      return reply(200, "", ['id: 2\nevent: turn\ndata: {"n":2}\n\n']);
    };
    const got: StreamEvent[] = [];
    const s = subscribeEvents(transport, (e) => got.push(e));
    await new Promise((r) => setTimeout(r, 600));
    s.stop();
    expect(got[0]).toEqual({ id: 1, type: "turn", at: "t", data: { n: 1 } });
    expect(got[1]?.data).toEqual({ n: 2 });
    expect(asked.slice(0, 2)).toEqual([undefined, "1"]);
  });

  it("starts over when the daemon restarted with fewer events", async () => {
    const asked: Array<string | undefined> = [];
    let opened = 0;
    const transport: Transport = async (_m, path, o) => {
      if (path === "/v1/health") return reply(200, { startedAt: opened > 1 ? "s2" : "s1", lastEventId: opened > 1 ? 0 : 9 });
      asked.push(o?.headers?.["last-event-id"]);
      opened++;
      return reply(200, "", [`id: ${opened === 1 ? 9 : 1}\nevent: e\ndata: {}\n\n`]);
    };
    const s = subscribeEvents(transport, () => undefined);
    await new Promise((r) => setTimeout(r, 900));
    s.stop();
    expect(asked[1]).toBeUndefined();
  });
});

describe("lock", () => {
  it("holds a locked request until the PIN is in, then sends it again", async () => {
    let unlocked = false;
    const transport: Transport = async (method, path, o) => {
      if (path === "/v1/ext/studio/lock") return reply(200, { whole: true, sensitive: false, locked: !unlocked, sensitiveOpen: false, idleMinutes: 5 });
      if (path === "/v1/ext/studio/lock/unlock") {
        if ((o?.json as { pin?: string }).pin !== "1234") return reply(403, { error: "Wrong PIN.", remaining: 4 });
        unlocked = true;
        return reply(200, { whole: true, sensitive: false, locked: false, sensitiveOpen: false, idleMinutes: 5 });
      }
      return unlocked ? reply(200, { sessions: [] }) : reply(423, { code: "locked", error: "Locked." });
    };
    const lock = createLock(transport);
    const guarded = lock.guard(transport);
    const pending = requestJson<{ sessions: unknown[] }>(guarded, "GET", "/v1/ext/studio/sessions");
    await new Promise((r) => setTimeout(r, 10));
    expect(lock.view().screen).toBe(true);
    expect(await lock.unlock("0000")).toMatchObject({ ok: false, remaining: 4 });
    expect(await lock.unlock("1234")).toEqual({ ok: true });
    expect(await pending).toEqual({ sessions: [] });
    expect(lock.view().screen).toBe(false);
  });

  it("returns a 423 that is not a lock code unchanged", async () => {
    const transport: Transport = async () => reply(423, { error: "Busy." });
    await expect(requestJson(createLock(transport).guard(transport), "GET", "/v1/x")).rejects.toThrow("Busy.");
  });
});

describe("unreachable", () => {
  it("is the relay's answer for an away computer, a dropped network or a timeout, never ue-mcp's own refusal", () => {
    expect(unreachable(new HttpError(503, "That project is offline."))).toBe(true);
    expect(unreachable(Object.assign(new Error("The relay answered 502."), { status: 502 }))).toBe(true);
    expect(unreachable(Object.assign(new Error("cut off"), { status: 0 }))).toBe(true);
    expect(unreachable(new TypeError("Network request failed"))).toBe(true);
    expect(unreachable(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(true);
    expect(unreachable(new HttpError(409, "A turn is running."))).toBe(false);
    expect(unreachable(new HttpError(404, "No such session."))).toBe(false);
    expect(unreachable(new Error("bad"))).toBe(false);
  });
});

describe("subscribeEvents retryNow", () => {
  it("ends a wait between attempts at once, and does nothing while connected", async () => {
    let calls = 0;
    let up = false;
    const t: Transport = async (_m, path) => {
      if (path === "/v1/events") {
        calls++;
        if (!up) throw new TypeError("Network request failed");
        return { status: 200, headers: {}, body: (async function* () { await new Promise(() => undefined); })() };
      }
      return { status: 503, headers: {}, body: null };
    };
    const seen: boolean[] = [];
    const stream = subscribeEvents(t, () => undefined, (c) => seen.push(c));
    for (let i = 0; i < 4 && calls < 4; i++) await new Promise((r) => setTimeout(r, 400));
    up = true;
    const before = calls;
    stream.retryNow();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(before + 1);
    expect(seen[seen.length - 1]).toBe(true);
    stream.retryNow();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(before + 1);
    stream.stop();
  });
});

describe("each notice once", () => {
  const n = (id: string, at: string, test?: { device: string }) => ({ id, at, ...(test ? { test } : {}) });
  it("admits a notice the first time only, and none from before the client started", () => {
    const start = Date.parse("2026-11-07T15:00:00Z");
    const gate = createNoticeGate(start);
    expect(gate.admit(n("a", "2026-11-07T15:01:00Z"))).toBe(true);
    expect(gate.admit(n("a", "2026-11-07T15:01:00Z"))).toBe(false);
    // The backlog a new stream starts with: an hour old.
    expect(gate.admit(n("b", "2026-11-07T14:00:00Z"))).toBe(false);
    // A phone's clock a little ahead of the computer's still admits a live notice.
    expect(gate.admit(n("c", "2026-11-07T14:57:00Z"))).toBe(true);
    // A test is asked for now, whatever its time says.
    expect(gate.admit(n("d", "2026-11-07T14:00:00Z", { device: "phone" }))).toBe(true);
    expect(gate.admit(n("e", "not a time"))).toBe(true);
  });

  it("forgets the oldest ids past what it keeps", () => {
    const gate = createNoticeGate(0, 2);
    gate.admit(n("a", "x"));
    gate.admit(n("b", "x"));
    gate.admit(n("c", "x"));
    expect(gate.admit(n("a", "x"))).toBe(true);
    expect(gate.admit(n("c", "x"))).toBe(false);
  });

  it("takes the newest event id, not the last in the list", () => {
    expect(newestEventId([{ id: 10 }, { id: 9 }], 5)).toBe(10);
    expect(newestEventId([], 5)).toBe(5);
    expect(newestEventId([{ id: 0 }], 5)).toBe(5);
  });

});

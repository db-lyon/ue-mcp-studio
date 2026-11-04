import { describe, expect, it } from "vitest";
import { createLock, requestJson, SseParser, subscribeEvents, type Reply, type StreamEvent, type Transport } from "../src/index.js";

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

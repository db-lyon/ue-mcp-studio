import { describe, expect, it } from "vitest";
import type { SessionDetail, SessionSync, TranscriptEntry } from "@ue-mcp-studio/shared";
import { DetailLoader, mergeSync } from "../src/session-sync.js";

const at = "2026-11-03T12:00:00.000Z";
const user = (text: string): TranscriptEntry => ({ kind: "user", text, at });
const base = { title: "t", status: "idle", createdAt: at, updatedAt: at, touched: [], draft: "", seen: [], dismissed: [], queue: [], error: null, approvals: [] };
const full = (id: string, transcript: TranscriptEntry[], hashes = "h0"): SessionSync => ({ ...base, id, hashes, transcript }) as unknown as SessionSync;
const delta = (id: string, length: number, entries: Array<[number, TranscriptEntry]>, hashes = "h1"): SessionSync => ({ ...base, id, hashes, changed: { length, entries } }) as unknown as SessionSync;

describe("mergeSync", () => {
  it("puts changed entries into the held transcript, keeping the unchanged ones as the same objects", () => {
    const a = user("a");
    const held = mergeSync(null, full("s1", [a, user("b")]));
    const next = mergeSync(held, delta("s1", 3, [[1, user("B")], [2, user("c")]]));
    expect(next.transcript.map((e) => (e as { text: string }).text)).toEqual(["a", "B", "c"]);
    expect(next.transcript[0]).toBe(a);
    expect("hashes" in next).toBe(false);
  });

  it("shortens to the new length, and reads a plain detail from an older agent as it is", () => {
    const held = mergeSync(null, full("s1", [user("a"), user("b")]));
    expect(mergeSync(held, delta("s1", 1, [])).transcript).toHaveLength(1);
    const plain = { ...base, id: "s1", transcript: [user("x")] } as unknown as SessionDetail;
    expect(mergeSync(held, plain)).toBe(plain);
  });
});

describe("DetailLoader", () => {
  it("runs one request at a time and folds the asks made meanwhile into one follow-up with the hashes held", async () => {
    const asks: Array<{ id: string; have?: string }> = [];
    let release: () => void = () => {};
    const shown: SessionDetail[] = [];
    const loader = new DetailLoader(
      async (id, have) => {
        asks.push({ id, have });
        if (asks.length === 1) {
          await new Promise<void>((r) => (release = r));
          return full(id, [user("a")], "H1");
        }
        return delta(id, 2, [[1, user("b")]], "H2");
      },
      (d) => shown.push(d),
      () => {},
    );
    const first = loader.load("s1");
    void loader.load("s1");
    void loader.load("s1");
    const last = loader.load("s1");
    release();
    await Promise.all([first, last]);
    expect(asks).toEqual([{ id: "s1", have: undefined }, { id: "s1", have: "H1" }]);
    expect(shown.at(-1)!.transcript).toHaveLength(2);
  });

  it("drops an answer for a session no longer wanted, and fetches the new one whole", async () => {
    const asks: Array<{ id: string; have?: string }> = [];
    let release: () => void = () => {};
    const shown: string[] = [];
    const loader = new DetailLoader(
      async (id, have) => {
        asks.push({ id, have });
        if (id === "s1") await new Promise<void>((r) => (release = r));
        return full(id, [user(id)]);
      },
      (d) => shown.push(d.id),
      () => {},
    );
    const p = loader.load("s1");
    void loader.load("s2");
    release();
    await p;
    expect(shown).toEqual(["s2"]);
    expect(asks).toEqual([{ id: "s1", have: undefined }, { id: "s2", have: undefined }]);
  });
});

import { describe, expect, it } from "vitest";
import { agentThreadPage, deriveSession, type SessionDetail, type SessionSync, type TranscriptEntry } from "@ue-mcp-studio/shared";
import { DetailLoader, MIN_MAIN_ENTRIES, ThreadLoader, UNREADABLE_ENTRY, mainEntries, mergeSync, readableDetail, sessionGone, wantsOlder, type HeldThread } from "../src/session-sync.js";
import { HttpError } from "../src/transport.js";
import { subagentsOf } from "../src/chat-model.js";
import { workingStatus } from "../src/working.js";

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

  it("takes the daemon's subagents and working line from every answer, page or delta, over what the held page could say", async () => {
    const call = (id: string, outcome: "pending" | "done" = "pending") => ({ id, name: "agent", input: { description: id, prompt: id }, outcome, startedAt: at });
    const whole: TranscriptEntry[] = [user("go"), { kind: "tool", call: call("g1") } as TranscriptEntry, user("a"), user("b"), user("c"), user("d")];
    const derived = (t: TranscriptEntry[]) => deriveSession(t, { status: "running", asked: new Set() });
    const page = { ...base, status: "running", id: "s1", hashes: "h0", transcript: whole.slice(4), from: 4, total: 6, ...derived(whole) } as unknown as SessionSync;
    const held = mergeSync(null, page);
    expect(held.from).toBe(4);
    // The page holds neither the subagent nor the turn's start; the daemon's facts do.
    expect(subagentsOf(held).map((a) => [a.id, a.state])).toEqual([["g1", "working"]]);
    expect(workingStatus(held)?.since).toBe(Date.parse(at));
    // A delta in which the subagent finished, though its entry is before the page.
    const done = [...whole];
    done[1] = { kind: "tool", call: { ...call("g1", "done"), endedAt: at } } as TranscriptEntry;
    const next = mergeSync(held, { ...delta("s1", 6, []), status: "running", ...derived(done) } as unknown as SessionSync);
    expect(subagentsOf(next).map((a) => [a.id, a.state])).toEqual([["g1", "done"]]);

    // Through the loader, as the phone reads a session: the tail page, then a delta that adds a subagent.
    const more = [...done, { kind: "tool", call: call("g2") } as TranscriptEntry];
    const shown: SessionDetail[] = [];
    const loader = new DetailLoader(async (_id, have) => (have === undefined ? page : { ...delta("s1", 7, [[6, more[6]]]), status: "running", ...derived(more) } as unknown as SessionSync), (d) => shown.push(d), () => {}, { tail: 2 });
    await loader.load("s1");
    await loader.load("s1");
    expect(shown.map((d) => subagentsOf(d).map((a) => `${a.id}:${a.state}`))).toEqual([["g1:working"], ["g1:done", "g2:working"]]);
  });
});

describe("readableDetail", () => {
  it("mends what the chat cannot read in place and says what, leaving a sound answer as the same object", () => {
    const sound = mergeSync(null, full("s1", [user("a")]));
    expect(readableDetail(sound)).toEqual({ detail: sound, problems: [] });
    const odd = { ...base, id: "s1", from: 10, transcript: [user("a"), { kind: "tool", at, parent: "g1" }, null, { kind: "later-kind", at }], subagents: {}, working: "x", seen: "y", draft: 3 } as unknown as SessionDetail;
    const { detail, problems } = readableDetail(odd);
    expect(detail.transcript).toEqual([user("a"), { kind: "note", text: UNREADABLE_ENTRY, at, parent: "g1" }, { kind: "note", text: UNREADABLE_ENTRY, at: new Date(0).toISOString() }, { kind: "later-kind", at }]);
    expect(detail.subagents).toBeUndefined();
    expect(detail.working).toBeUndefined();
    expect(detail.seen).toEqual([]);
    expect(detail.draft).toBe("");
    expect(problems).toEqual(expect.arrayContaining(["entry 11 (tool) could not be read", "entry 12 (object) could not be read", "subagents is not a list", "working is not an object"]));
    // The client works the subagents out from the transcript instead, as for an older daemon.
    expect(subagentsOf(detail)).toEqual([]);
  });

  it("reports through the loader what it mended", async () => {
    const seen: string[][] = [];
    const loader = new DetailLoader(async () => ({ ...full("s1", [user("a")]), queue: "no" }) as unknown as SessionSync, () => {}, () => {}, { problem: (_id, p) => seen.push(p) });
    await loader.load("s1");
    expect(seen).toEqual([["queue is not a list"]]);
  });
});

describe("ThreadLoader", () => {
  const steps = Array.from({ length: 12 }, (_, i): TranscriptEntry => ({ kind: "assistant", text: `s${i}`, at, parent: "g1" }));
  const transcript: TranscriptEntry[] = [user("go"), ...steps.slice(0, 6), user("between"), ...steps.slice(6)];
  const texts = (t: HeldThread | null) => t?.entries.map((e) => (e as { text: string }).text);

  it("reads a subagent's thread by its id, newest page first, then the pages before it", async () => {
    const asked: Array<{ tail?: number; before?: number }> = [];
    let held: HeldThread | null = null;
    const loader = new ThreadLoader(async (_s, id, page) => (asked.push(page), agentThreadPage(transcript, id, page)), (t) => (held = t), (e) => { throw e; }, 5);
    await loader.load("s1", "g1");
    expect(texts(held)).toEqual(["s7", "s8", "s9", "s10", "s11"]);
    expect(loader.hasOlder()).toBe(true);
    await loader.older();
    await loader.older();
    expect(texts(held)).toEqual(steps.map((e) => (e as { text: string }).text));
    expect(held!.from).toBe(0);
    expect(loader.hasOlder()).toBe(false);
    expect(asked).toEqual([{ tail: 5 }, { tail: 5, before: 7 }, { tail: 5, before: 2 }]);
  });

  it("reads the held span again with what came since, when the session changed", async () => {
    let t = transcript;
    let held: HeldThread | null = null;
    const loader = new ThreadLoader(async (_s, id, page) => agentThreadPage(t, id, page), (x) => (held = x), (e) => { throw e; }, 5);
    await loader.load("s1", "g1");
    await loader.older();
    t = [...transcript, { kind: "assistant", text: "s12", at, parent: "g1" }];
    await loader.load("s1", "g1");
    // The span held (s2 on) and room for a page more: nothing held is lost, the new line is in.
    expect(texts(held)?.slice(-11)).toEqual(["s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10", "s11", "s12"]);
    // Another subagent's thread starts from its own newest page.
    await loader.load("s1", "nope");
    expect(held!.entries).toEqual([]);
  });
});

describe("DetailLoader", () => {
  it("says a deleted session is gone instead of failing, and still fails on anything else", async () => {
    const gone: string[] = [];
    const failed: string[] = [];
    let answer: Error = new HttpError(404, "no session s1");
    const loader = new DetailLoader(async () => { throw answer; }, () => {}, (e) => failed.push(e.message), { gone: (id) => gone.push(id) });
    await loader.load("s1");
    expect(gone).toEqual(["s1"]);
    expect(failed).toEqual([]);
    answer = new HttpError(500, "boom");
    await loader.load("s1");
    expect(failed).toEqual(["boom"]);
    expect(sessionGone(new HttpError(404, "no call c1"))).toBe(false);
    expect(sessionGone(new Error("no session s1"))).toBe(false);
  });

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

describe("a loader holding only the newest entries", () => {
  const page = (id: string, transcript: TranscriptEntry[], from: number, total: number, hashes = "H"): SessionSync => ({ ...base, id, hashes, transcript, from, total }) as unknown as SessionSync;
  const texts = (d: SessionDetail) => d.transcript.map((e) => (e as { text: string }).text);

  it("asks for the tail first, puts later changes in by their place in the whole transcript, and reads older pages in front", async () => {
    const asks: unknown[] = [];
    const shown: SessionDetail[] = [];
    const answers: SessionSync[] = [
      page("s1", [user("m8"), user("m9")], 8, 10, "H1"),
      delta("s1", 11, [[9, user("M9")], [10, user("m10")], [2, user("ignored, not held")]], "H2"),
      page("s1", [user("m6"), user("m7")], 6, 11, "H3"),
    ];
    const loader = new DetailLoader(
      async (id, have, p) => {
        asks.push({ have, ...p });
        return answers.shift()!;
      },
      (d) => shown.push(d),
      () => {},
      { tail: 2 },
    );
    await loader.load("s1");
    expect(texts(shown.at(-1)!)).toEqual(["m8", "m9"]);
    expect(shown.at(-1)!.from).toBe(8);
    await loader.load("s1");
    expect(texts(shown.at(-1)!)).toEqual(["m8", "M9", "m10"]);
    expect(loader.hasOlder("s1")).toBe(true);
    await loader.older("s1");
    expect(texts(shown.at(-1)!)).toEqual(["m6", "m7", "m8", "M9", "m10"]);
    expect(shown.at(-1)!.from).toBe(6);
    expect(asks).toEqual([{ have: undefined, tail: 2 }, { have: "H1" }, { have: undefined, tail: 2, before: 8 }]);
  });

  it("reads the newest page again when the transcript is cut back past what it holds", async () => {
    const asks: unknown[] = [];
    const shown: SessionDetail[] = [];
    const answers: SessionSync[] = [page("s1", [user("m8"), user("m9")], 8, 10, "H1"), delta("s1", 5, [], "H2"), page("s1", [user("m3"), user("m4")], 3, 5, "H3")];
    const loader = new DetailLoader(
      async (id, have, p) => {
        asks.push({ have, ...p });
        return answers.shift()!;
      },
      (d) => shown.push(d),
      () => {},
      { tail: 2 },
    );
    await loader.load("s1");
    await loader.load("s1");
    expect(asks).toEqual([{ have: undefined, tail: 2 }, { have: "H1" }, { have: undefined, tail: 2 }]);
    expect(texts(shown.at(-1)!)).toEqual(["m3", "m4"]);
    expect(shown.at(-1)!.from).toBe(3);
  });

  describe("when the newest page is all subagent lines", () => {
    const sub = (i: number): TranscriptEntry => ({ kind: "assistant", text: `s${i}`, at, parent: "g1" });
    const transcript: TranscriptEntry[] = [...Array.from({ length: 30 }, (_, i) => user(`m${i}`)), ...Array.from({ length: 300 }, (_, i) => sub(i)), { kind: "note", text: "rebuilding", at }];
    /** A daemon before 0.1.35-beta.28: the `tail` entries before `before`, as asked, whatever they are. */
    const plainPage = (_id: string, _have: string | undefined, p?: { tail?: number; before?: number }): SessionSync => {
      const end = p?.before ?? transcript.length;
      const from = Math.max(0, end - (p?.tail ?? end));
      return page("s1", transcript.slice(from, end), from, transcript.length);
    };

    it("against an older daemon, reads the pages before it on its own until the main thread has enough to draw", async () => {
      const asks: unknown[] = [];
      const shown: SessionDetail[] = [];
      const loader = new DetailLoader(async (id, have, p) => (asks.push(p), plainPage(id, have, p)), (d) => shown.push(d), () => {}, { tail: 60 });
      await loader.load("s1");
      const held = shown.at(-1)!;
      expect(mainEntries(held.transcript)).toBeGreaterThanOrEqual(MIN_MAIN_ENTRIES);
      expect(held.transcript).toEqual(transcript.slice(held.from));
      expect(texts(held).filter((t) => t.startsWith("m")).at(-1)).toBe("m29");
      // The newest page, then the pages before it until the main thread was reached, and no more.
      expect(asks[0]).toEqual({ tail: 60 });
      expect(asks.slice(1).every((a) => (a as { tail: number }).tail === 60 && typeof (a as { before: number }).before === "number")).toBe(true);
      expect(asks).toHaveLength(6);
    });

    it("against a daemon that reaches back itself, asks once", async () => {
      let n = 0;
      const shown: SessionDetail[] = [];
      const reached = page("s1", transcript.slice(10), 10, transcript.length);
      const loader = new DetailLoader(async () => (n++, reached), (d) => shown.push(d), () => {}, { tail: 60 });
      await loader.load("s1");
      expect(n).toBe(1);
      expect(wantsOlder(shown.at(-1)!)).toBe(false);
    });

    it("stops at the start of a session with too little of the main thread", async () => {
      const subOnly = transcript.slice(30);
      let n = 0;
      const loader = new DetailLoader(
        async (_id, _have, p) => {
          n++;
          const end = p?.before ?? subOnly.length;
          const from = Math.max(0, end - (p?.tail ?? end));
          return page("s1", subOnly.slice(from, end), from, subOnly.length);
        },
        () => {},
        () => {},
        { tail: 60 },
      );
      await loader.load("s1");
      expect(n).toBe(Math.ceil(subOnly.length / 60));
      expect(loader.hasOlder("s1")).toBe(false);
    });
  });

  it("without a tail, asks as before and holds the session whole", async () => {
    const asks: unknown[] = [];
    const loader = new DetailLoader(
      async (id, have, p) => {
        asks.push([have, p]);
        return full(id, [user("a")]);
      },
      () => {},
      () => {},
    );
    await loader.load("s1");
    expect(asks).toEqual([[undefined, undefined]]);
    expect(loader.hasOlder("s1")).toBe(false);
  });
});

/**
 * The session sent as what changed: whole without hashes, only differing or
 * new entries with them, and long finished results left out for a fetch.
 */
import { describe, expect, it } from "vitest";
import { deriveSession, type SessionDetail, type TranscriptEntry } from "@ue-mcp-studio/shared";
import { agentView, mergeSync, subagentsOf, workingStatus } from "@ue-mcp-studio/client-core";
import { LAZY_RESULT_CHARS, decodeHashes, leanEntry, resultOf, syncOf, threadOf } from "../src/session-delta.js";

const at = "2026-11-03T12:00:00.000Z";
const tool = (id: string, result: string, outcome: "done" | "error" | "pending" = "done"): TranscriptEntry => ({
  kind: "tool",
  call: { id, name: "shell", input: { command: "ls" }, outcome, result, startedAt: at },
});
function detail(transcript: TranscriptEntry[]): SessionDetail {
  return { id: "s1", title: "t", status: "idle", createdAt: at, updatedAt: at, transcript, touched: [], draft: "", seen: [], dismissed: [], queue: [], error: null, approvals: [] } as unknown as SessionDetail;
}

describe("session delta", () => {
  it("leaves a long finished result out with its size, and keeps short ones and errors", () => {
    const long = "x".repeat(LAZY_RESULT_CHARS + 1);
    const lean = leanEntry(tool("a", long));
    expect(lean.kind === "tool" && lean.call.result).toBeUndefined();
    expect(lean.kind === "tool" && lean.call.resultSize).toBe(long.length);
    expect(leanEntry(tool("b", "short"))).toEqual(tool("b", "short"));
    expect(leanEntry(tool("c", long, "error"))).toEqual(tool("c", long, "error"));
    expect(resultOf([tool("a", long)], "a")).toBe(long);
    expect(resultOf([tool("a", long)], "zz")).toBeNull();
  });

  it("sends the transcript whole without hashes, and one hash per entry", () => {
    const d = detail([{ kind: "user", text: "hi", at }, tool("a", "ok")]);
    const s = syncOf(d, undefined);
    expect(s.transcript).toHaveLength(2);
    expect(s.changed).toBeUndefined();
    expect(decodeHashes(s.hashes)).toHaveLength(2);
  });

  it("with the hashes held, sends only entries that changed in place or were added", () => {
    const first = syncOf(detail([{ kind: "user", text: "hi", at }, tool("a", "", "pending")]), undefined);
    const now = detail([{ kind: "user", text: "hi", at }, tool("a", "done now"), { kind: "assistant", text: "ok", at }]);
    const s = syncOf(now, first.hashes);
    expect(s.transcript).toBeUndefined();
    expect(s.changed).toEqual({ length: 3, entries: [[1, tool("a", "done now")], [2, { kind: "assistant", text: "ok", at }]] });
    // Nothing changed: nothing sent.
    expect(syncOf(now, s.hashes).changed).toEqual({ length: 3, entries: [] });
  });

  it("an unreadable hash list gets the whole transcript", () => {
    expect(syncOf(detail([{ kind: "user", text: "hi", at }]), "!!").transcript).toHaveLength(1);
  });
});

describe("session delta, a page at a time", () => {
  const many = (n: number) => detail(Array.from({ length: n }, (_, i) => ({ kind: "user", text: `m${i}`, at }) as TranscriptEntry));

  it("sends only the newest `tail` entries with where they start, and hashes for the whole transcript", () => {
    const s = syncOf(many(10), undefined, { tail: 3 });
    expect(s.transcript?.map((e) => (e as { text: string }).text)).toEqual(["m7", "m8", "m9"]);
    expect(s.from).toBe(7);
    expect(s.total).toBe(10);
    expect(decodeHashes(s.hashes)).toHaveLength(10);
  });

  it("sends the page before `before`, and stops at the start", () => {
    expect(syncOf(many(10), undefined, { tail: 3, before: 7 }).transcript?.map((e) => (e as { text: string }).text)).toEqual(["m4", "m5", "m6"]);
    const first = syncOf(many(10), undefined, { tail: 3, before: 2 });
    expect(first.transcript?.map((e) => (e as { text: string }).text)).toEqual(["m0", "m1"]);
    expect(first.from).toBe(0);
  });

  it("keeps the old answers: no tail is the whole transcript, and held hashes get a delta whatever the tail", () => {
    const whole = syncOf(many(4), undefined);
    expect(whole.transcript).toHaveLength(4);
    expect(whole.from).toBeUndefined();
    expect(syncOf(many(5), whole.hashes, { tail: 2 }).changed).toEqual({ length: 5, entries: [[4, { kind: "user", text: "m4", at }]] });
  });

});

describe("the session state the daemon works out for every client", () => {
  const long = "x".repeat(LAZY_RESULT_CHARS + 1);
  const agent = (id: string, outcome: "pending" | "done" = "pending", result?: string): TranscriptEntry => ({ kind: "tool", call: { id, name: "agent", input: { description: `Task ${id}`, prompt: id }, outcome, ...(result ? { result } : {}), startedAt: at } });
  const step = (parent: string, id: string, outcome: "pending" | "done"): TranscriptEntry => ({ kind: "tool", parent, call: { id, name: "shell", input: { command: `run ${id}` }, outcome, startedAt: at } });
  const talk = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: "assistant", text: `m${i}`, at }) as TranscriptEntry);
  /** A stored session as the daemon answers it: SessionStore.detail, the derived state included. */
  const session = (transcript: TranscriptEntry[], asked: string[] = []): SessionDetail => {
    const s = { ...detail(transcript), status: "running", approvals: asked.map((toolUseId, i) => ({ id: `ap${i}`, toolUseId, tool: "shell", parent: "g1" })) } as unknown as SessionDetail;
    return { ...s, ...deriveSession(transcript, { status: "running", asked: new Set(asked), seen: s.seen, dismissed: s.dismissed, tokens: s.tokens, context: s.context }) };
  };
  /** What a client shows: the subagents' rows and the working line. */
  const shows = (d: SessionDetail, now: number) => ({
    agents: subagentsOf(d).map((a) => ({ id: a.id, steps: a.steps, ...agentView(a, now) })),
    working: workingStatus(d),
  });

  it("gives a paged client and a whole one the same subagents, states and working line, also for subagents before the page", () => {
    const t = [{ kind: "user", text: "Dress the cave", at } as TranscriptEntry, agent("g1"), step("g1", "c1", "pending"), agent("g2", "done", long), ...talk(30), { kind: "tool", call: { id: "m1", name: "glob", input: {}, outcome: "pending", startedAt: at } } as TranscriptEntry];
    const now = Date.parse(at) + 5000;
    const whole = mergeSync(null, syncOf(session(t, ["c1"]), undefined));
    const paged = mergeSync(null, syncOf(session(t, ["c1"]), undefined, { tail: 5 }));
    expect(paged.from).toBeGreaterThan(3);
    expect(paged.transcript.some((e) => e.kind === "tool" && e.call.name === "agent")).toBe(false);
    expect(shows(paged, now)).toEqual(shows(whole, now));
    expect(shows(paged, now).agents.map((a) => [a.id, a.state, a.activity])).toEqual([["g1", "approval", "approve run c1"], ["g2", "done", null]]);
    expect(shows(paged, now).working?.label).toBe("Running glob");
    // The long report is left out of the list as from the entries.
    const sent = syncOf(session(t), undefined, { tail: 5 }).subagents!;
    expect(sent[1].call.result).toBeUndefined();
    expect(sent[1].call.resultSize).toBe(long.length);
  });

  it("keeps the model current through deltas: a subagent finishing before the page, and one started after", () => {
    const t = [{ kind: "user", text: "go", at } as TranscriptEntry, agent("g1"), ...talk(20)];
    const first = syncOf(session(t), undefined, { tail: 4 });
    let held = mergeSync(null, first);
    expect(subagentsOf(held).map((a) => a.state)).toEqual(["working"]);
    const later = [t[0], agent("g1", "done", "ok"), ...talk(20), agent("g2")];
    const d = syncOf(session(later), first.hashes);
    held = mergeSync(held, d);
    expect(subagentsOf(held).map((a) => `${a.id}:${a.state}`)).toEqual(["g1:done", "g2:working"]);
    expect(shows(held, Date.parse(at))).toEqual(shows(mergeSync(null, syncOf(session(later), undefined)), Date.parse(at)));
  });

  it("pages a subagent's own thread by its id, newest first, lean as the session's entries", () => {
    const own = Array.from({ length: 7 }, (_, i) => ({ kind: "assistant", text: `s${i}`, at, parent: "g1" }) as TranscriptEntry);
    const t = [agent("g1"), own[0], agent("g2"), ...own.slice(1, 4), step("g2", "x", "done"), ...own.slice(4), { kind: "tool", parent: "g1", call: { id: "big", name: "shell", input: {}, outcome: "done", result: long, startedAt: at } } as TranscriptEntry];
    const newest = threadOf(t, "g1", { tail: 3 });
    expect(newest.total).toBe(8);
    expect(newest.from).toBe(5);
    expect(newest.entries.map((e) => (e.kind === "assistant" ? e.text : e.kind === "tool" ? e.call.id : ""))).toEqual(["s5", "s6", "big"]);
    expect((newest.entries[2] as Extract<TranscriptEntry, { kind: "tool" }>).call.resultSize).toBe(long.length);
    const before = threadOf(t, "g1", { tail: 3, before: newest.from });
    expect(before.entries.map((e) => (e.kind === "assistant" ? e.text : ""))).toEqual(["s2", "s3", "s4"]);
    expect(threadOf(t, "g1").entries).toHaveLength(8);
  });
});

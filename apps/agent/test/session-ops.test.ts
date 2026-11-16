/**
 * #463 L2: a client follows a session through its watch: a paged snapshot,
 * then one op per saved change, applied without a request. Driven end to end
 * here: the daemon's SessionWatch and sync on one side, client-core's
 * DetailLoader on the other.
 */
import { describe, expect, it } from "vitest";
import type { SessionDetail, SessionOps, SessionSync, TranscriptEntry } from "@ue-mcp-studio/shared";
import { DetailLoader, decodeHashList, encodeHashList } from "@ue-mcp-studio/client-core";
import { syncOf } from "../src/session-delta.js";
import { OPS_MAX_BYTES, SessionWatch } from "../src/session-ops.js";

const at = "2026-11-03T12:00:00.000Z";
const user = (text: string): TranscriptEntry => ({ kind: "user", text, at });
const tool = (id: string, outcome: "pending" | "done", result?: string): TranscriptEntry => ({ kind: "tool", call: { id, name: "shell", input: { command: "ls" }, outcome, startedAt: at, ...(result ? { result } : {}) } });

function rig(initial: TranscriptEntry[]) {
  const d = { id: "s1", title: "t", status: "idle", createdAt: at, updatedAt: at, transcript: [...initial], touched: [], draft: "", seen: [], dismissed: [], queue: [], error: null, approvals: [] } as unknown as SessionDetail & Record<string, unknown>;
  const published: SessionOps[] = [];
  const watch = new SessionWatch((id) => (id === "s1" ? (structuredClone(d) as SessionDetail) : null), (o) => published.push(o), 0);
  let shown: SessionDetail | null = null;
  let reads = 0;
  const loader = new DetailLoader(async (id, have, page) => {
    reads++;
    return syncOf(structuredClone(d) as SessionDetail, have, page, watch.seq(id)) as SessionSync;
  }, (x) => (shown = x), (e) => {
    throw e;
  }, { tail: 3 });
  const take = () => published.splice(0);
  return { d, watch, loader, shown: () => shown!, reads: () => reads, take };
}

const texts = (d: SessionDetail) => d.transcript.map((e) => (e.kind === "tool" ? `${e.call.id}:${e.call.outcome}` : (e as { text: string }).text));

describe("a session's watch", () => {
  it("brings appends, changes in place, cuts and field changes to a client without a request", async () => {
    const r = rig([user("a"), user("b"), tool("c1", "pending"), user("d")]);
    await r.loader.load("s1");
    expect(texts(r.shown())).toEqual(["b", "c1:pending", "d"]);
    expect(r.loader.following("s1")).toBe(true);
    const reads = r.reads();

    // A call finishing in place, an entry added, and the status: one save burst, one op.
    (r.d.transcript[2] as { call: { outcome: string; result?: string } }).call.outcome = "done";
    r.d.transcript.push(user("e"));
    r.d.status = "running";
    r.watch.flush("s1");
    const [op] = r.take();
    expect(op.entries.map(([i]) => i)).toEqual([2, 4]);
    expect(op.head).toMatchObject({ status: "running" });
    expect(r.loader.ops(op)).toBe(true);
    expect(texts(r.shown())).toEqual(["b", "c1:done", "d", "e"]);
    expect(r.shown().status).toBe("running");
    expect(r.shown().from).toBe(1);

    // A cut back within the held page.
    r.d.transcript.splice(3);
    r.watch.flush("s1");
    expect(r.loader.ops(r.take()[0])).toBe(true);
    expect(texts(r.shown())).toEqual(["b", "c1:done"]);
    expect(r.reads()).toBe(reads);

    // The hashes the client now holds are the daemon's: the next sync finds nothing changed.
    const check = syncOf(structuredClone(r.d) as SessionDetail, encodeHashList(decodeHashList((r.loader as unknown as { held: { hashes: string } }).held.hashes)!));
    expect(check.changed?.entries).toEqual([]);
  });

  it("ignores an op it holds, and reads again on a gap, a cut below its page, or a change too large to send", async () => {
    const r = rig([user("a"), user("b"), user("c"), user("d")]);
    await r.loader.load("s1");
    r.d.transcript.push(user("e"));
    r.watch.flush("s1");
    const first = r.take()[0];
    expect(r.loader.ops(first)).toBe(true);
    expect(r.loader.ops(first)).toBe(true);
    // One missed.
    r.d.transcript.push(user("f"));
    r.watch.flush("s1");
    r.take();
    r.d.transcript.push(user("g"));
    r.watch.flush("s1");
    expect(r.loader.ops(r.take()[0])).toBe(false);
    await r.loader.load("s1");
    expect(texts(r.shown()).at(-1)).toBe("g");
    // Cut back to before the held page.
    expect(r.shown().from).toBeGreaterThan(0);
    r.d.transcript.splice(0);
    r.watch.flush("s1");
    expect(r.loader.ops(r.take()[0])).toBe(false);
    await r.loader.load("s1");
    expect(texts(r.shown())).toEqual([]);
    // Too large: sent as resync.
    r.d.transcript.push(tool("big", "done", "x".repeat(OPS_MAX_BYTES)));
    (r.d.transcript.at(-1) as { call: { outcome: string } }).call.outcome = "error";
    r.watch.flush("s1");
    const big = r.take()[0];
    expect(big.resync).toBe(true);
    expect(r.loader.ops(big)).toBe(false);
  });

  it("sends nothing for a save that changed nothing, or for a session no client has read", () => {
    const r = rig([user("a")]);
    r.watch.changed("s1");
    expect(r.take()).toEqual([]);
    r.watch.seq("s1");
    r.watch.flush("s1");
    expect(r.take()).toEqual([]);
    delete r.d.draft;
    r.watch.flush("s1");
    expect(r.take()[0].removed).toEqual(["draft"]);
  });

  it("numbers ops from the daemon's start, so a client holding a number from an earlier daemon sees a gap", () => {
    const r = rig([user("a")]);
    expect(r.watch.seq("s1")).toBeGreaterThan(1_000_000_000_000);
  });
});

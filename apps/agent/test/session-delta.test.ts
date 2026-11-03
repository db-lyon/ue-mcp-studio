/**
 * The session sent as what changed: whole without hashes, only differing or
 * new entries with them, and long finished results left out for a fetch.
 */
import { describe, expect, it } from "vitest";
import type { SessionDetail, TranscriptEntry } from "@ue-mcp-studio/shared";
import { LAZY_RESULT_CHARS, decodeHashes, leanEntry, resultOf, syncOf } from "../src/session-delta.js";

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

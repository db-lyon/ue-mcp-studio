/**
 * A session's detail sent as what changed. The client keeps a hash per
 * transcript entry and sends them back (`have`); only entries whose hash
 * differs, and any past the end, are sent again. Entries change in place (a
 * call finishing, a flow step) as well as being appended, so a hash per entry
 * catches both. Long tool results are left out (`resultSize`) and fetched when
 * the call is opened.
 */
import { agentThreadPage, type AgentThreadPage, type SessionDetail, type SessionSync, type ToolCallRecord, type TranscriptEntry } from "@ue-mcp-studio/shared";

/** A tool result longer than this is fetched on open instead of sent with the session. */
export const LAZY_RESULT_CHARS = 8 * 1024;

/** The entry as sent: a long result of a finished call replaced by its size. Errors stay, the thread banner shows them. */
export function leanEntry(e: TranscriptEntry): TranscriptEntry {
  if (e.kind !== "tool") return e;
  const call = leanCall(e.call);
  return call === e.call ? e : { ...e, call };
}

/** A call as sent: a long result of a finished call replaced by its size. */
export function leanCall(c: ToolCallRecord): ToolCallRecord {
  if (!c.result || c.result.length <= LAZY_RESULT_CHARS || c.outcome === "error" || c.outcome === "unknown") return c;
  const { result, ...rest } = c;
  return { ...rest, resultSize: result.length };
}

/** FNV-1a over the entry's JSON: four bytes, enough to tell an entry changed. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function encodeHashes(hs: number[]): string {
  const b = Buffer.alloc(hs.length * 4);
  hs.forEach((h, i) => b.writeUInt32BE(h, i * 4));
  return b.toString("base64url");
}

export function decodeHashes(s: string): number[] | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const b = Buffer.from(s, "base64url");
    if (b.byteLength % 4 !== 0) return null;
    const out: number[] = [];
    for (let i = 0; i < b.byteLength; i += 4) out.push(b.readUInt32BE(i));
    return out;
  } catch {
    return null;
  }
}

/** A page of the transcript: the `tail` entries that end before `before` (the end when absent). */
export interface SyncPage {
  tail?: number;
  before?: number;
}

/**
 * The detail to send: in full when the client has nothing (`have` absent or
 * unreadable), only a page of it when it asks for one, else the entries that
 * differ from what it holds.
 */
export function syncOf(detail: SessionDetail, have: string | undefined, page: SyncPage = {}): SessionSync {
  const { transcript, subagents, ...whole } = detail;
  // The derived state (subagents, working line, compacting, live playtests) goes with every answer, whole, page or delta.
  const rest = subagents ? { ...whole, subagents: subagents.map((a) => ({ ...a, call: leanCall(a.call), ...(a.step ? { step: leanCall(a.step) } : {}) })) } : whole;
  const lean = transcript.map(leanEntry);
  const hashes = lean.map((e) => hash(JSON.stringify(e)));
  const held = have === undefined ? null : decodeHashes(have);
  if (!held && page.tail !== undefined && page.tail > 0) {
    const end = Math.min(lean.length, Math.max(0, page.before ?? lean.length));
    const from = Math.max(0, end - page.tail);
    return { ...rest, hashes: encodeHashes(hashes), transcript: lean.slice(from, end), from, total: lean.length };
  }
  if (!held) return { ...rest, hashes: encodeHashes(hashes), transcript: lean };
  const entries: Array<[number, TranscriptEntry]> = [];
  for (let i = 0; i < lean.length; i++) if (held[i] !== hashes[i]) entries.push([i, lean[i]]);
  return { ...rest, hashes: encodeHashes(hashes), changed: { length: lean.length, entries } };
}

/** A subagent's thread a page at a time, lean as the session's entries are. */
export function threadOf(transcript: TranscriptEntry[], callId: string, page: SyncPage = {}): AgentThreadPage {
  const p = agentThreadPage(transcript, callId, page);
  return { ...p, entries: p.entries.map(leanEntry) };
}

/** A call's full result, for a call opened whose result was left out. */
export function resultOf(transcript: TranscriptEntry[], callId: string): string | null {
  for (const e of transcript) if (e.kind === "tool" && e.call.id === callId) return e.call.result ?? "";
  return null;
}

/** The open subagent's thread, read by its id whatever part of the main transcript the phone holds. */
import { useEffect, useMemo, useState } from "react";
import type { TranscriptEntry } from "@ue-mcp-studio/shared";
import { ThreadLoader, type FetchThread, type HeldThread } from "@ue-mcp-studio/client-core";

/**
 * `callId`'s thread in `sessionId`, read again whenever `version` changes (the
 * session's detail came back changed). Until its first page is in, the lines
 * of it the held transcript has stand in. `more` reads the page before.
 */
export function useAgentThread(fetch: FetchThread, sessionId: string | null, callId: string | null, version: unknown, held: TranscriptEntry[]): { entries: TranscriptEntry[]; from: number; more?: () => void } {
  const [thread, setThread] = useState<HeldThread | null>(null);
  const loader = useMemo(() => new ThreadLoader(fetch, setThread, () => {}), [fetch]);
  useEffect(() => {
    if (!sessionId || !callId) {
      loader.reset();
      setThread(null);
      return;
    }
    void loader.load(sessionId, callId);
  }, [loader, sessionId, callId, version]);
  const mine = thread && thread.sessionId === sessionId && thread.callId === callId ? thread : null;
  const standIn = useMemo(() => (mine || !callId ? [] : held.filter((t) => t.parent === callId)), [mine, callId, held]);
  return { entries: mine ? mine.entries : standIn, from: mine ? mine.from : 0, more: mine && mine.from > 0 ? () => void loader.older() : undefined };
}

/** A session's playtest runs, kept current from the events since its transcript was read. */
import { useMemo, useRef } from "react";
import type { QaRun, TranscriptEntry } from "@ue-mcp-studio/shared";
import { sessionRunsOf, type SessionRuns, type StreamEvent } from "@ue-mcp-studio/client-core";

export type { SessionRuns };

/** `live`: the daemon's live runs (SessionDetail.liveRuns), pinned even when their card is before the page held. */
export function useSessionRuns(sessionId: string | null, transcript: TranscriptEntry[] | undefined, events: StreamEvent[], live?: QaRun[]): SessionRuns {
  // Events up to the read are in the transcript already; only later ones are applied.
  const read = useRef<{ transcript: TranscriptEntry[] | undefined; after: number }>({ transcript: undefined, after: 0 });
  if (read.current.transcript !== transcript) read.current = { transcript, after: events.length ? events[events.length - 1].id : 0 };
  const after = read.current.after;
  return useMemo(() => sessionRunsOf(sessionId, transcript, events, after, live), [sessionId, transcript, events, after, live]);
}

/** A session's playtest runs, kept current from the events since its transcript was read. */
import { useMemo, useRef } from "react";
import type { DaemonEvent } from "ue-mcp/daemon";
import type { QaRun, TranscriptEntry } from "@ue-mcp-studio/shared";
import { newerRun } from "./Qa";

/** The session's runs as they are now: its transcript's, with every studio.qa.changed since the transcript was read. */
export interface SessionRuns {
  runs: QaRun[];
  /** A run id the transcript may still hold (a draft's, before its run took the card) to the run that holds it now. */
  alias: ReadonlyMap<string, string>;
}

export function useSessionRuns(sessionId: string | null, transcript: TranscriptEntry[] | undefined, events: DaemonEvent[]): SessionRuns {
  // Events up to the read are in the transcript already; only later ones are applied.
  const read = useRef<{ transcript: TranscriptEntry[] | undefined; after: number }>({ transcript: undefined, after: 0 });
  if (read.current.transcript !== transcript) read.current = { transcript, after: events.length ? events[events.length - 1].id : 0 };
  const after = read.current.after;
  return useMemo(() => {
    const byId = new Map<string, QaRun>();
    const alias = new Map<string, string>();
    for (const t of transcript ?? []) if (t.kind === "qa") byId.set(t.run.runId, t.run);
    for (const e of events) {
      if (e.id <= after || e.type !== "studio.qa.changed") continue;
      const run = e.data.run as QaRun | undefined;
      if (!run?.runId) continue;
      const replaces = typeof e.data.replaces === "string" ? e.data.replaces : null;
      if (replaces && byId.has(replaces)) {
        byId.delete(replaces);
        alias.set(replaces, run.runId);
        byId.set(run.runId, run);
      } else if (byId.has(run.runId)) {
        byId.set(run.runId, newerRun(run, byId.get(run.runId)!));
      } else if (sessionId && run.sessionId === sessionId) {
        byId.set(run.runId, run);
      }
    }
    // An alias chain (draft, manual run, full run) resolves to the run at its end.
    for (const [from, to] of alias) {
      let end = to;
      for (let i = 0; i < 8 && alias.has(end); i++) end = alias.get(end)!;
      alias.set(from, end);
    }
    return { runs: [...byId.values()], alias };
  }, [sessionId, transcript, events, after]);
}

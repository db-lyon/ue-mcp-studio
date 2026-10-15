import { useState } from "react";
import type { TranscriptEntry } from "@ue-mcp-studio/shared";
import { STATE_LABEL, agentCalls, agentStatus, callsIn, describe, formatDuration, isActive, summarize } from "./model";
import { useNow } from "./hooks";

const EMPTY: ReadonlySet<string> = new Set();

/**
 * The threads of the session, under the composer: the main agent, the
 * subagents still running (each with a stop button), and the finished ones in
 * a section that starts collapsed. Finished ones this viewer has not opened
 * are marked new. A row switches the conversation to that thread. A finished
 * row can be dismissed, one at a time or all at once; the session keeps the
 * dismissals, and the subagent's line in the conversation stays.
 */
export function Threads({ transcript, thread, onThread, onStop, sessionWaiting, seen, dismissed = EMPTY, onDismiss }: {
  transcript: TranscriptEntry[];
  thread: string | null;
  onThread: (id: string | null) => void;
  onStop: (id: string) => void;
  sessionWaiting: boolean;
  seen: ReadonlySet<string>;
  dismissed?: ReadonlySet<string>;
  onDismiss?: (ids: string[]) => void;
}) {
  const agents = agentCalls(transcript);
  const now = useNow(agents.some((a) => a.outcome === "pending"));
  const [showFinished, setShowFinished] = useState(false);
  // The open thread keeps its row until it is closed, so a dismissal never pulls the list out from under it.
  const listed = agents.filter((a) => !dismissed.has(a.id) || a.outcome === "pending" || a.id === thread);
  if (listed.length === 0) return null;
  const rows = listed.map((a) => ({ call: a, ...agentStatus(a, transcript, sessionWaiting, now) }));
  const active = rows.filter((r) => isActive(r.state));
  const finished = rows.filter((r) => !isActive(r.state));
  const failed = finished.filter((r) => r.state === "failed" || r.state === "unknown").length;
  const fresh = finished.filter((r) => !seen.has(r.call.id)).length;
  const open = showFinished || finished.some((r) => r.call.id === thread);

  const row = (r: (typeof rows)[number]) => {
    const calls = callsIn(transcript, r.call.id);
    const isNew = !isActive(r.state) && !seen.has(r.call.id);
    return (
      <div key={r.call.id} className={`agents-row state-${r.state} ${thread === r.call.id ? "current" : ""}`}>
        <button role="tab" aria-selected={thread === r.call.id} className="agents-open" onClick={() => onThread(r.call.id)}>
          <span className="agents-dot" />
          <span className="agents-name">{describe(r.call)}</span>
          {isNew && <span className="agents-new" title="Not opened yet">new</span>}
          <span className="agents-state">{STATE_LABEL[r.state]}</span>
          {r.activity && <span className="agents-activity dim">{r.activity}</span>}
          <span className="agents-meta dim small">{calls} {calls === 1 ? "call" : "calls"}, {formatDuration(r.secs)}</span>
        </button>
        {isActive(r.state) && (
          <button className="agents-stop" aria-label={`Stop ${describe(r.call)}`} title="Stop this subagent" onClick={() => onStop(r.call.id)}>
            {"■"}
          </button>
        )}
        {!isActive(r.state) && onDismiss && (
          <button className="agents-dismiss" aria-label={`Dismiss ${describe(r.call)}`} title="Remove from this list" onClick={() => onDismiss([r.call.id])}>
            {"×"}
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="agents-bar" role="tablist">
      <div className="agents-head dim small">Subagents: {summarize(rows.map((r) => r.state))}</div>
      <div className={`agents-row main ${thread === null ? "current" : ""}`}>
        <button role="tab" aria-selected={thread === null} className="agents-open" onClick={() => onThread(null)}>
          <span className="agents-dot" />
          <span className="agents-name">Main</span>
        </button>
      </div>
      {active.map(row)}
      {finished.length > 0 && (
        <>
          <div className="agents-fold-row">
            <button className="agents-fold dim small" aria-expanded={open} onClick={() => setShowFinished(!open)}>
              <span className="agents-caret">{open ? "▾" : "▸"}</span>
              <span>
                Finished ({finished.length})
                {fresh > 0 && <span className="agents-new-count">, {fresh} new</span>}
                {failed > 0 && <span className="agents-failed">, {failed} failed</span>}
              </span>
            </button>
            {onDismiss && (
              <button className="ghost small-button agents-clear dim small" title="Remove every finished subagent from this list" onClick={() => onDismiss(finished.map((r) => r.call.id))}>
                Clear finished
              </button>
            )}
          </div>
          {open && finished.map(row)}
        </>
      )}
    </div>
  );
}

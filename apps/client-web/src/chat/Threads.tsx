import { useState } from "react";
import type { ContextUsage, SessionAgent } from "@ue-mcp-studio/shared";
import { STATE_LABEL, agentView, describe, formatDuration, isActive, listedSubagents, summarize, tokenCount } from "@ue-mcp-studio/client-core";
import { useNow } from "./hooks";

const EMPTY: ReadonlySet<string> = new Set();

/**
 * The threads of the session, under the composer: the main agent, the
 * subagents still running (each with a stop button), and the finished ones in
 * a section that starts collapsed. Finished ones this viewer has not opened
 * are marked new. A row switches the conversation to that thread. A finished
 * row can be dismissed, one at a time or all at once; the session keeps the
 * dismissals, and the subagent's line in the conversation stays. Each row
 * shows that agent's context now, and what it spent this session on hover.
 * The rows are the daemon's subagent list (SessionDetail.subagents), never
 * worked out from the transcript held, so a page and a whole one agree.
 */
export function Threads({ agents, thread, onThread, onStop, seen, dismissed = EMPTY, onDismiss, tokens = {}, context = {} }: {
  agents: SessionAgent[];
  thread: string | null;
  onThread: (id: string | null) => void;
  onStop: (id: string) => void;
  seen: ReadonlySet<string>;
  dismissed?: ReadonlySet<string>;
  onDismiss?: (ids: string[]) => void;
  /** Tokens the main agent spent this session, under "main". */
  tokens?: Record<string, number>;
  /** The main agent's current context, under "main". */
  context?: Record<string, ContextUsage>;
}) {
  const now = useNow(agents.some((a) => isActive(a.state)));
  const [showFinished, setShowFinished] = useState(false);
  // The open thread keeps its row until it is closed, so a dismissal never pulls the list out from under it.
  const listed = listedSubagents(agents, dismissed, thread);
  // With no subagents there is no list: the composer's context meter has the main agent's numbers.
  if (listed.length === 0) return null;
  const byId = new Map(agents.map((a) => [a.id, a]));
  /** An agent's line: its context now when measured, with what it spent this session in the tooltip. */
  const usage = (key: string) => {
    const a = byId.get(key);
    const c = a ? a.context : context[key];
    const spent = (a ? a.tokens : tokens[key]) ?? 0;
    const title = `${spent.toLocaleString("en-US")} input and output tokens spent this session`;
    return c
      ? <span className="agents-tokens dim small" title={title}>context {tokenCount(c.input + c.output)}</span>
      : <span className="agents-tokens dim small" title={title}>{tokenCount(spent)} spent</span>;
  };
  const rows = listed.map((a) => ({ call: a.call, steps: a.steps, ...agentView(a, now) }));
  const active = rows.filter((r) => isActive(r.state));
  const finished = rows.filter((r) => !isActive(r.state));
  const failed = finished.filter((r) => r.state === "failed" || r.state === "unknown").length;
  const fresh = finished.filter((r) => !seen.has(r.call.id)).length;
  const open = showFinished || finished.some((r) => r.call.id === thread);

  const row = (r: (typeof rows)[number]) => {
    const calls = r.steps;
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
          {usage(r.call.id)}
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
          {usage("main")}
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

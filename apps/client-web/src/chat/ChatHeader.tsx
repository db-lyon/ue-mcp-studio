import type { TranscriptEntry } from "@ue-mcp-studio/shared";
import { STATE_LABEL, agentStatus, describe, formatDuration, isActive, type Call } from "./model";
import { useNow } from "./hooks";
import { useAsked } from "./asked";

/**
 * The single header over a conversation where the chat shows one pane at a
 * time. Back goes up one level: from a subagent's thread to the main thread,
 * from the main thread to the session list. The title is the thread on
 * screen, with the session above it in small type while a subagent's thread
 * is open. `onAgents`, when given, adds a button for the session's subagents.
 */
export function ChatHeader({ title, thread, transcript, sessionWaiting, agents, onSessions, onMain, onStop, onAgents, onReview }: {
  title: string;
  thread: Call | null;
  transcript: TranscriptEntry[];
  sessionWaiting: boolean;
  /** How many subagents the session has started. */
  agents: number;
  onSessions: () => void;
  onMain: () => void;
  onStop: (id: string) => void;
  onAgents?: () => void;
  /** Opens the session's review switch and checkpoint timeline. */
  onReview?: () => void;
}) {
  const now = useNow(thread?.outcome === "pending");
  const asked = useAsked();
  const st = thread ? agentStatus(thread, transcript, sessionWaiting, now, asked) : null;
  return (
    <div className={`chat-back ${st ? `state-${st.state}` : ""}`}>
      <button
        className="ghost chat-back-button"
        onClick={thread ? onMain : onSessions}
        aria-label={thread ? "Back to the main thread" : "Back to sessions"}
      >
        {"‹"}
        <span className="chat-back-label">{thread ? "Main" : "Sessions"}</span>
      </button>
      <span className="chat-back-titles">
        {thread && <span className="chat-back-parent">{title}</span>}
        <span className="chat-back-title">{thread ? describe(thread) : title}</span>
      </span>
      {st && thread && (
        <span className="chat-back-state" title={`${STATE_LABEL[st.state]}${st.activity ? `, ${st.activity}` : ""}, ${formatDuration(st.secs)}`}>
          <span className="agents-dot" />
          <span className="agents-state">{STATE_LABEL[st.state]}</span>
        </span>
      )}
      {st && thread && isActive(st.state) && <button className="thread-stop" onClick={() => onStop(thread.id)}>Stop</button>}
      {onReview && !thread && (
        <button className="ghost chat-review-button" onClick={onReview} title="Review and checkpoints">Checkpoints</button>
      )}
      {onAgents && agents > 0 && (
        <button className="ghost chat-agents-button" onClick={onAgents} aria-label={`Subagents (${agents})`} title="Subagents">
          <AgentsGlyph />
          <span>{agents}</span>
        </button>
      )}
    </div>
  );
}

function AgentsGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      <circle cx="5" cy="5" r="2" />
      <circle cx="11" cy="5" r="2" />
      <path d="M1.5 13c0-2 1.6-3.5 3.5-3.5S8.5 11 8.5 13M7.5 13c0-2 1.6-3.5 3.5-3.5s3.5 1.5 3.5 3.5" />
    </svg>
  );
}

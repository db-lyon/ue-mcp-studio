import type { SessionAgent } from "@ue-mcp-studio/shared";
import { STATE_LABEL, agentView, describe, formatDuration, isActive } from "@ue-mcp-studio/client-core";
import { useNow } from "./hooks";

/**
 * The single header over a conversation where the chat shows one pane at a
 * time. Back goes up one level: from a subagent's thread to the main thread,
 * from the main thread to the session list. The title is the thread on
 * screen, with the session above it in small type while a subagent's thread
 * is open, and that subagent's state (the daemon's) and Stop. Checkpoints and
 * the subagents are in the composer bar, at every width.
 */
export function ChatHeader({ title, thread, onSessions, onMain, onStop }: {
  title: string;
  /** The subagent whose thread is open, from the daemon's list; null on the main thread. */
  thread: SessionAgent | null;
  onSessions: () => void;
  onMain: () => void;
  onStop: (id: string) => void;
}) {
  const now = useNow(!!thread && isActive(thread.state));
  const st = thread ? agentView(thread, now) : null;
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
        <span className="chat-back-title">{thread ? describe(thread.call) : title}</span>
      </span>
      {st && thread && (
        <span className="chat-back-state" title={`${STATE_LABEL[st.state]}${st.activity ? `, ${st.activity}` : ""}, ${formatDuration(st.secs)}`}>
          <span className="agents-dot" />
          <span className="agents-state">{STATE_LABEL[st.state]}</span>
        </span>
      )}
      {st && thread && isActive(st.state) && <button className="thread-stop" onClick={() => onStop(thread.id)}>Stop</button>}
    </div>
  );
}

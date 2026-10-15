import { useState } from "react";
import type { QueuedMessage } from "@ue-mcp-studio/shared";

/**
 * Messages written while a turn ran, in the order they will go, under the
 * conversation. Each can be changed or removed until it is sent. A turn that
 * finishes sends the next one; after a Stop or an error the queue waits, and
 * Send next starts it again.
 */
export function QueuedMessages({ queue, busy, onEdit, onRemove, onSendNext }: {
  queue: QueuedMessage[];
  busy: boolean;
  onEdit: (id: string, text: string) => void;
  onRemove: (id: string) => void;
  onSendNext: () => void;
}) {
  if (queue.length === 0) return null;
  return (
    <div className="queue" aria-label="Queued messages">
      <div className="queue-head dim small">
        <span>Queued ({queue.length}){busy ? ", sent one by one as each turn ends" : ""}</span>
        <span className="spacer" />
        {!busy && <button className="ghost small-button" onClick={onSendNext}>Send next</button>}
      </div>
      {queue.map((q, i) => <QueuedRow key={q.id} q={q} n={i + 1} onEdit={onEdit} onRemove={onRemove} />)}
    </div>
  );
}

function QueuedRow({ q, n, onEdit, onRemove }: { q: QueuedMessage; n: number; onEdit: (id: string, text: string) => void; onRemove: (id: string) => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  if (editing !== null) {
    const save = () => {
      if (editing.trim()) onEdit(q.id, editing);
      setEditing(null);
    };
    return (
      <div className="queue-row editing">
        <textarea
          aria-label={`Edit queued message ${n}`}
          value={editing}
          autoFocus
          rows={Math.min(8, Math.max(2, editing.split("\n").length))}
          onChange={(e) => setEditing(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              save();
            } else if (e.key === "Escape") setEditing(null);
          }}
        />
        <div className="row">
          <span className="spacer" />
          <button className="ghost small-button" onClick={() => setEditing(null)}>Cancel</button>
          <button className="primary small-button" disabled={!editing.trim()} onClick={save}>Save</button>
        </div>
      </div>
    );
  }
  return (
    <div className="queue-row">
      <span className="queue-n dim small">{n}</span>
      <span className="queue-text">{q.text || <span className="dim">(files only)</span>}</span>
      {q.attachments.length > 0 && <span className="dim small">{q.attachments.length} {q.attachments.length === 1 ? "file" : "files"}</span>}
      <button className="ghost small-button" aria-label={`Edit queued message ${n}`} onClick={() => setEditing(q.text)}>Edit</button>
      <button className="queue-remove" aria-label={`Remove queued message ${n}`} title="Remove from the queue" onClick={() => onRemove(q.id)}>{"×"}</button>
    </div>
  );
}

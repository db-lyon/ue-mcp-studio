import { useEffect, useRef, useState } from "react";
import type { SessionSummary, SessionUpdate } from "@ue-mcp-studio/shared";
import { api } from "../api";

const STATUS_LABEL: Record<string, string> = {
  idle: "",
  running: "Working",
  waiting: "Waiting for editor",
  stopped: "Stopped",
  error: "Stopped on an error",
};

/**
 * The state the session list shows: a call waiting for approval, from the main
 * agent or any subagent, puts the session on the user whatever its turn is
 * doing, since a subagent the user assigned runs while the session is idle (#149).
 */
export const listState = (s: Pick<SessionSummary, "status" | "awaiting">): string => (s.awaiting ? "needs-you" : s.status);

/** The line under a session's title: what it is doing, its subagents, or when it last changed. */
export function sessionLine(s: SessionSummary): string {
  const status = s.awaiting
    ? s.awaiting === 1 ? "Waiting on your approval" : `Waiting on your approval of ${s.awaiting} calls`
    : STATUS_LABEL[s.status] ?? "";
  const agents = s.agents?.running ? `${s.agents.running} of ${s.agents.total} subagents running` : "";
  const line = [status, agents].filter(Boolean).join(", ") || new Date(s.updatedAt).toLocaleString();
  // The model of its last turn, and how it was reached.
  const where = s.model ? `${s.model}${s.route ? ` via ${s.route}` : ""}` : "";
  return [where, line].filter(Boolean).join(". ");
}

/**
 * One session in the list: open it, or from its menu rename, archive (or
 * restore) and delete it. Delete asks once more before it removes anything.
 */
export function SessionRow({ s, selected, onOpen, onChanged }: {
  s: SessionSummary;
  selected: boolean;
  onOpen: () => void;
  onChanged: (deleted?: string) => void;
}) {
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(s.title);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => setTitle(s.title), [s.title]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) {
        setMenu(false);
        setConfirm(false);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu]);

  const update = (u: SessionUpdate) => api.updateSession(s.id, u).then(() => onChanged(), () => onChanged());
  const rename = () => {
    if (!editing) return;
    setEditing(false);
    if (title.trim() && title.trim() !== s.title) void update({ title: title.trim() });
    else setTitle(s.title);
  };
  const remove = () => api.deleteSession(s.id).then(() => onChanged(s.id), () => onChanged());

  return (
    <div ref={box} className={`item status-${listState(s)} ${selected ? "selected" : ""} ${s.archived ? "archived" : ""}`} onClick={() => !editing && onOpen()}>
      {editing ? (
        <input
          className="session-title-edit"
          aria-label="Session title"
          autoFocus
          value={title}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={rename}
          onKeyDown={(e) => {
            if (e.key === "Enter") rename();
            if (e.key === "Escape") {
              setTitle(s.title);
              setEditing(false);
            }
          }}
        />
      ) : (
        <strong><span className="session-dot" />{s.title}</strong>
      )}
      <div className="muted small">{sessionLine(s)}</div>
      <button
        className={`session-more ${menu ? "open" : ""}`}
        aria-label="Session actions"
        onClick={(e) => {
          e.stopPropagation();
          setMenu(!menu);
          setConfirm(false);
        }}
      >
        {"⋯"}
      </button>
      {menu && (
        <div className="session-menu" role="menu" onClick={(e) => e.stopPropagation()}>
          <button role="menuitem" onClick={() => { setMenu(false); setEditing(true); }}>Rename</button>
          <button role="menuitem" onClick={() => { setMenu(false); void update({ archived: !s.archived }); }}>{s.archived ? "Restore" : "Archive"}</button>
          <button role="menuitem" className={`danger ${confirm ? "confirm" : ""}`} onClick={() => (confirm ? void remove() : setConfirm(true))}>
            {confirm ? "Are you sure?" : "Delete"}
          </button>
        </div>
      )}
    </div>
  );
}

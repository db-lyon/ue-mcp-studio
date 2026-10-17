import { useEffect, useState, type ReactNode } from "react";
import type { SessionSummary } from "@ue-mcp-studio/shared";
import { api } from "../api";

export type NavTab = "Chat" | "Flows" | "Plugins" | "Settings";
const TABS: NavTab[] = ["Chat", "Flows", "Plugins", "Settings"];

/**
 * Navigation at narrow widths: a panel that slides over the page from the
 * left, opened from the top bar's menu button. It holds New session, the
 * tabs, the recent sessions and, at the foot, the bar's tools. A pick, the
 * scrim, or Escape closes it. The recent sessions are read each time it opens.
 */
export function NavDrawer({ open, onClose, tab, session, updates, onTab, onSession, onNewSession, children }: {
  open: boolean;
  onClose: () => void;
  tab: NavTab;
  /** The open session, if the chat shows one. */
  session: string | null;
  updates: number;
  onTab: (t: NavTab) => void;
  onSession: (id: string) => void;
  onNewSession: () => void;
  children?: ReactNode;
}) {
  const [recent, setRecent] = useState<SessionSummary[] | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    api.sessions().then((r) => live && setRecent(r.sessions.filter((s) => !s.archived)), () => live && setRecent([]));
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => {
      live = false;
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const pick = (f: () => void) => () => {
    f();
    onClose();
  };

  return (
    <div className={`drawer-root ${open ? "open" : ""}`} aria-hidden={!open}>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Navigation">
        <div className="drawer-head">
          <span className="brand">
            <span className="mark" />
            <span className="name">ue-mcp</span>
            <span className="product">Studio</span>
          </span>
        </div>
        <button className="drawer-new" onClick={pick(onNewSession)}>
          <PlusGlyph />
          New session
        </button>
        <nav className="drawer-nav" aria-label="Sections">
          {TABS.map((t) => (
            <button key={t} className={`drawer-item ${t === tab ? "active" : ""}`} aria-current={t === tab ? "page" : undefined} onClick={pick(() => onTab(t))}>
              <TabGlyph tab={t} />
              <span>{t}</span>
              {t === "Settings" && updates > 0 && <span className="tab-dot" title={`${updates} ${updates === 1 ? "update" : "updates"} available`} />}
            </button>
          ))}
        </nav>
        <div className="drawer-recents">
          <div className="drawer-label">Recents</div>
          {recent === null && <p className="dim small drawer-note">Loading</p>}
          {recent?.length === 0 && <p className="dim small drawer-note">No sessions yet.</p>}
          {recent?.map((s) => (
            <button
              key={s.id}
              className={`drawer-session status-${s.status} ${tab === "Chat" && s.id === session ? "active" : ""}`}
              onClick={pick(() => onSession(s.id))}
              title={s.title}
            >
              <span className="session-dot" />
              <span className="drawer-session-title">{s.title || "Untitled"}</span>
            </button>
          ))}
        </div>
        {children && <div className="drawer-foot">{children}</div>}
      </aside>
    </div>
  );
}

function PlusGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

function TabGlyph({ tab }: { tab: NavTab }) {
  const path = {
    Chat: "M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5a1.5 1.5 0 0 1-1.5 1.5H7l-3 2.5V11h0.5A1.5 1.5 0 0 1 3 9.5z",
    Flows: "M4 3.5h3v3H4zM9 9.5h3v3H9zM5.5 6.5v2.5a1.5 1.5 0 0 0 1.5 1.5h2",
    Plugins: "M6 2.5v3M10 2.5v3M4 5.5h8v2.5a4 4 0 0 1-8 0zM8 12v1.5",
    Settings: "M3 5h10M3 11h10M6 3.5v3M10 9.5v3",
  }[tab];
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={path} />
    </svg>
  );
}

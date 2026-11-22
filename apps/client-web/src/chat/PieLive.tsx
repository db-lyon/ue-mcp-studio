/**
 * The way into the live PIE viewport from the chat: the composer bar's PIE
 * indicator, the Play In Editor card after what started PIE, and the dialog
 * both open, which draws the Viewport tab's own player, gate and states. The
 * card never streams in the thread; the dialog joins as a viewer while it is
 * open, and closing it leaves, so the stream stops once nobody watches.
 *
 * The status is GET /viewport, asked on mount and again after the events
 * client-core's asksViewportAgain names. Nothing polls.
 */
import { createContext, useContext, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { ViewportStatus } from "@ue-mcp-studio/shared";
import { VIEWPORT_MODAL_TITLE, VIEWPORT_PLANS_URL, WATCH_LIVE, asksViewportAgain, pieCard, type ViewportAction } from "@ue-mcp-studio/client-core";
import { api } from "../api";
import { openExternal } from "../native";
import type { DaemonState } from "../state";
import { ViewportView } from "../views/Viewport";
import type { SettingsSection } from "../views/settings/sections";

/** GET /viewport for the chat, asked again after an event that may change it. */
export function usePieStatus(daemon: Pick<DaemonState, "events">, enabled = true): { status: ViewportStatus | null; check: (fresh?: boolean) => Promise<void> } {
  const [status, setStatus] = useState<ViewportStatus | null>(null);
  const check = (fresh = false) => Promise.resolve().then(() => api.viewport(fresh)).then(setStatus, () => undefined);
  const asks = daemon.events.filter((e) => asksViewportAgain(e.type)).length;
  useEffect(() => {
    if (enabled) void check();
  }, [asks, enabled]);
  return { status, check };
}

/** What the chat's PIE card and indicator read: the status, and the ways out of the thread. */
export interface PieLiveValue {
  status: ViewportStatus | null;
  remote: boolean;
  /** Open the viewport over the chat. */
  watch: () => void;
  check: (fresh?: boolean) => Promise<void>;
  onSettings: (s: SettingsSection) => void;
}

export const PieLiveContext = createContext<PieLiveValue | null>(null);

/**
 * The Play In Editor card: a compact line with a live dot while PIE runs and
 * Watch live, or, for an account without Pro, the Viewport's refusal with its
 * way forward.
 */
export function PieCard({ current }: { current: boolean }) {
  const v = useContext(PieLiveContext);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!v) return null;
  const card = pieCard(v.status, { remote: v.remote, current });
  const act = async (a: ViewportAction) => {
    setError(null);
    setBusy(a.id);
    try {
      if (a.id === "upgrade") openExternal((await api.billingCheckout({ plan: "pro", interval: "month" })).url);
      else if (a.id === "plans") openExternal(VIEWPORT_PLANS_URL);
      else if (a.id === "settings") v.onSettings("general");
      else if (a.id === "check") await v.check(true);
      else v.watch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className={`pie-card ${card.live ? "live" : ""}`} role="group" aria-label={card.title}>
      <div className="pie-card-row">
        <span className={`pie-dot ${card.live ? "live" : ""}`} aria-hidden="true" />
        <strong className="pie-card-title">{card.title}</strong>
        <span className="spacer" />
        {!card.gate && <button className={card.live ? "primary small-button" : "small-button"} onClick={v.watch}>{WATCH_LIVE}</button>}
      </div>
      {card.gate && (
        <div className="pie-card-gate">
          <strong>{card.gate.title}</strong>
          <p>{card.gate.body}</p>
          <div className="viewport-actions">
            {card.gate.actions.map((a) => (
              <button key={a.id} className={a.primary ? "primary small-button" : "small-button"} disabled={busy !== null} onClick={() => void act(a)}>
                {busy === a.id ? "Working" : a.label}
              </button>
            ))}
          </div>
          {error && <p className="viewport-error">{error}</p>}
        </div>
      )}
    </div>
  );
}

/**
 * The viewport in a dialog over the chat. Mounted only while open, so its
 * viewer joins on open and leaves on close; Escape or the scrim closes it.
 */
export function ViewportDialog({ daemon, onClose, onSettings }: { daemon: DaemonState; onClose: () => void; onSettings: (s: SettingsSection) => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);
  return createPortal(
    <div className="overlay" onClick={onClose}>
      <div className="overlay-card viewport-dialog" role="dialog" aria-modal="true" aria-label={VIEWPORT_MODAL_TITLE} onClick={(e) => e.stopPropagation()}>
        <div className="overlay-head">
          {VIEWPORT_MODAL_TITLE}
          <span className="spacer" />
          <button className="ghost" onClick={onClose}>Close</button>
        </div>
        <ViewportView daemon={daemon} embedded onSettings={(s) => { onClose(); onSettings(s); }} />
      </div>
    </div>,
    document.body,
  );
}

/** The bar's PIE indicator: the viewport's screen with a live dot. */
export function PieLiveGlyph() {
  return (
    <span className="pie-glyph" aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2.5 4.5A1.5 1.5 0 0 1 4 3h8a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 12 12H4a1.5 1.5 0 0 1-1.5-1.5zM7 5.8v3.4l2.8-1.7zM5.5 14h5" />
      </svg>
      <span className="pie-dot live" />
    </span>
  );
}

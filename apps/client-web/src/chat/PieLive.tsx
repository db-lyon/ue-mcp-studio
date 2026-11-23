/**
 * The way into the live PIE viewport from the chat: the Play In Editor card
 * after what started PIE, a live playtest card's Viewport (Qa.tsx), and the
 * dialog both open, which draws the viewer's player, gate and states
 * (views/Viewport.tsx). The cards never stream in the thread; the dialog
 * joins as a viewer while it is open, and closing it leaves, so the stream
 * stops once nobody watches.
 *
 * The status is GET /viewport, asked on mount and again after the events
 * client-core's asksViewportAgain names, and a pie.* event from the daemon
 * applies at once (pieFromEvent). Nothing polls.
 */
import { createContext, useContext, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { ViewportStatus } from "@ue-mcp-studio/shared";
import { VIEWPORT_MODAL_TITLE, WATCH_LIVE, asksViewportAgain, pieCard, pieFromEvent, withPie } from "@ue-mcp-studio/client-core";
import { api } from "../api";
import type { DaemonState } from "../state";
import { ViewportView, type SharedViewer } from "../views/Viewport";
import type { SettingsSection } from "../views/settings/sections";

/** GET /viewport for the chat, asked again after an event that may change it. */
export function usePieStatus(daemon: Pick<DaemonState, "events">, enabled = true): { status: ViewportStatus | null; check: (fresh?: boolean) => Promise<void> } {
  const [status, setStatus] = useState<ViewportStatus | null>(null);
  const check = (fresh = false) => Promise.resolve().then(() => api.viewport(fresh)).then(setStatus, () => undefined);
  const asks = daemon.events.filter((e) => asksViewportAgain(e.type)).length;
  useEffect(() => {
    if (enabled) void check();
  }, [asks, enabled]);
  // A Play session the daemon pushed, however it started: shown at once.
  // A loop, not findLast: the UI still targets Chrome 90.
  let lastPie: (typeof daemon.events)[number] | undefined;
  for (let i = daemon.events.length - 1; i >= 0 && !lastPie; i--) if (pieFromEvent(daemon.events[i].type) !== null) lastPie = daemon.events[i];
  useEffect(() => {
    const pie = lastPie ? pieFromEvent(lastPie.type) : null;
    if (enabled && pie !== null) setStatus((s) => withPie(s, pie));
  }, [lastPie?.id, enabled]);
  return { status, check };
}

/** What the chat's PIE card and playtest cards read: the status, and the ways out of the thread. */
export interface PieLiveValue {
  status: ViewportStatus | null;
  remote: boolean;
  /** Open the viewport over the chat. */
  watch: () => void;
  check: (fresh?: boolean) => Promise<void>;
  onSettings: (s: SettingsSection) => void;
}

export const PieLiveContext = createContext<PieLiveValue | null>(null);

/** The Play In Editor card: a compact line with a live dot while PIE runs, and Watch live. */
export function PieCard({ current }: { current: boolean }) {
  const v = useContext(PieLiveContext);
  if (!v) return null;
  const card = pieCard(v.status, { current });
  return (
    <div className={`pie-card ${card.live ? "live" : ""}`} role="group" aria-label={card.title}>
      <div className="pie-card-row">
        <span className={`pie-dot ${card.live ? "live" : ""}`} aria-hidden="true" />
        <strong className="pie-card-title">{card.title}</strong>
        <span className="spacer" />
        <button className={card.live ? "primary small-button" : "small-button"} onClick={v.watch}>{WATCH_LIVE}</button>
      </div>
    </div>
  );
}

/**
 * The viewport in a dialog over the chat or the Playtest Hub. Mounted only
 * while open, so its viewer joins on open and leaves on close; Escape or the
 * scrim closes it. Given `viewer`, it draws that one instead of joining.
 */
export function ViewportDialog({ daemon, onClose, onSettings, viewer }: { daemon: Pick<DaemonState, "events">; onClose: () => void; onSettings: (s: SettingsSection) => void; viewer?: SharedViewer }) {
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
        <ViewportView daemon={daemon} embedded viewer={viewer} onSettings={(s) => { onClose(); onSettings(s); }} />
      </div>
    </div>,
    document.body,
  );
}

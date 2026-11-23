/**
 * The ways into the live PIE viewport: the bar's Live button on every tab
 * while PIE runs, the chat's Play In Editor card after what started PIE, a
 * live playtest card's Viewport (Qa.tsx), and the dialog they all open, which
 * draws the viewer's player, gate and states (views/Viewport.tsx). Nothing
 * streams until the dialog opens; it joins as a viewer while open, and
 * closing it leaves, so the stream stops once nobody watches. Only a remote
 * client offers any of it (client-core's viewportAllowed).
 *
 * The status is GET /viewport, held once for the app (PieStatusContext),
 * asked on mount and again after the events client-core's asksViewportAgain
 * names, and a pie.* event from the daemon applies at once (pieFromEvent).
 * Nothing polls.
 */
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { ViewportStatus } from "@ue-mcp-studio/shared";
import { LIVE_BUTTON, VIEWPORT_MODAL_TITLE, WATCH_LIVE, asksViewportAgain, liveButtonHint, pieCard, pieFromEvent, pieRunning, withPie } from "@ue-mcp-studio/client-core";
import { api } from "../api";
import type { DaemonState } from "../state";
import { ViewportView, type SharedViewer } from "../views/Viewport";
import type { SettingsSection } from "../views/settings/sections";

/** GET /viewport as one place holds it, with a pie.* event applied: whether PIE runs is client-core's pieRunning of it. */
export interface PieStatus {
  status: ViewportStatus | null;
  check: (fresh?: boolean) => Promise<ViewportStatus | null>;
  setStatus: (s: ViewportStatus) => void;
}

/** The app's one PieStatus (App.tsx), which the chat, the hub and the bar's Live button all read. */
export const PieStatusContext = createContext<PieStatus | null>(null);

/**
 * GET /viewport, asked again after an event that may change it: the app's
 * shared one when there is one, so every reader agrees and one request
 * answers them all; otherwise this component's own (tests, the hub demo).
 */
export function usePieStatus(daemon: Pick<DaemonState, "events">, enabled = true): PieStatus {
  const shared = useContext(PieStatusContext);
  const own = useOwnPieStatus(daemon, enabled && !shared);
  return shared ?? own;
}

/** The fetch behind PieStatus; App.tsx calls it once for the whole app. */
export function useOwnPieStatus(daemon: Pick<DaemonState, "events">, enabled = true): PieStatus {
  const [status, setStatus] = useState<ViewportStatus | null>(null);
  const check = (fresh = false): Promise<ViewportStatus | null> =>
    Promise.resolve()
      .then(() => api.viewport(fresh))
      .then((s) => {
        setStatus(s);
        return s;
      }, () => null);
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
  return useMemo(() => ({ status, check, setStatus }), [status]);
}

/**
 * Who opens the full viewer for the bar's Live button. The Playtest Hub
 * registers its own while it is mounted, so the dialog draws the hub's
 * viewer and the editor never streams to this page twice.
 */
export const LiveHostContext = createContext<((open: (() => void) | null) => void) | null>(null);

/** The bar's Live button: a pulsing dot and Live, shown only while Play In Editor runs. */
export function LiveButton({ onOpen, check, className = "" }: { onOpen: () => void; check?: string | null; className?: string }) {
  const pie = useContext(PieStatusContext);
  if (!pie || !pieRunning(pie.status)) return null;
  const hint = liveButtonHint(check);
  return (
    <button className={`ghost live-button ${className}`} onClick={onOpen} title={hint} aria-label={hint}>
      <span className="pie-dot live" aria-hidden="true" />
      {LIVE_BUTTON}
    </button>
  );
}

/** What the chat's PIE card and playtest cards read: the status, and the ways out of the thread. */
export interface PieLiveValue {
  status: ViewportStatus | null;
  remote: boolean;
  /** Open the viewport over the chat. */
  watch: () => void;
  check: (fresh?: boolean) => Promise<unknown>;
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
 * The viewport in a dialog over whatever tab is up. Mounted only
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

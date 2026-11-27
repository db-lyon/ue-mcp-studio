/**
 * The live PIE viewport, on a remote client only (client-core's
 * viewportAllowed; App.tsx mounts LiveProvider there and nowhere else).
 *
 * LiveProvider holds the page's one PIE status and its one viewer, and the
 * full viewer's dialog. Everything that shows the viewport reads it
 * (LiveContext): the bar's Live button on every tab while PIE runs, the
 * chat's Play In Editor card and the Playtest Hub's Arrangement. So the
 * editor never streams to this page twice.
 *
 * The viewer joins while something wants it (the dialog open, or an inline
 * picture holding it) and leaves LIVE_LINGER_MS after the last lets go,
 * so moving between screens keeps the one connection.
 *
 * The status is GET /viewport, asked on mount and again after the events
 * client-core's asksViewportAgain names, and a pie.* event from the daemon
 * applies at once (pieFromEvent). Nothing polls.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ViewportSource, ViewportStatus } from "@ue-mcp-studio/shared";
import {
  LIVE_BUTTON,
  VIEWPORT_MODAL_TITLE,
  WATCH_LIVE,
  ViewportSession,
  asksViewportAgain,
  liveButtonHint,
  pieCard,
  pieFromEvent,
  pieRunning,
  viewportGate,
  withPie,
  type PeerFactory,
  type ViewerPhase,
  type ViewportNotice,
} from "@ue-mcp-studio/client-core";
import { api } from "../api";

/** How long the viewer stays joined after the last picture lets it go, so moving between screens keeps one connection. */
const LIVE_LINGER_MS = 15_000;
import type { DaemonState } from "../state";
import { ViewportView, browserPeer } from "../views/Viewport";
import type { SettingsSection } from "../views/settings/sections";

/** The longest side of the frame kept for after a run ends. */
const FRAME_MAX_W = 640;
/** How often that frame is taken while live. */
const FRAME_EVERY_MS = 1000;

/** GET /viewport, with a pie.* event applied: whether PIE runs is client-core's pieRunning of it. */
export interface PieStatus {
  status: ViewportStatus | null;
  /** Why the last GET /viewport failed, or null. */
  error: string | null;
  check: (fresh?: boolean) => Promise<ViewportStatus | null>;
  setStatus: (s: ViewportStatus) => void;
}

/** The page's one viewer, and what draws it. */
export interface LiveValue {
  pie: PieStatus;
  /** What stands between this page and the stream (plan, account, editor), or null. */
  gate: ViewportNotice | null;
  phase: ViewerPhase;
  /** Join again from the start. */
  retry: () => void;
  /** What the viewer shows; the dialog can switch it, and closing the dialog puts Play In Editor back. */
  source: ViewportSource;
  setSource: (s: ViewportSource) => void;
  /** Keep the viewer joined while an inline picture is on screen; call what it returns to let go. Stable across renders. */
  hold: () => () => void;
  /** The inline pictures are expanded: the person asked to watch. Kept here so it outlives a screen. */
  expanded: boolean;
  setExpanded: (on: boolean) => void;
  /** A frame of the stream has been kept. */
  hasFrame: () => boolean;
  /** The newest kept frame as an image URL, or null. */
  lastFrame: () => string | null;
  /** Open the full viewer over the current tab. */
  open: () => void;
  onSettings: (s: SettingsSection) => void;
}

export const LiveContext = createContext<LiveValue | null>(null);

/** GET /viewport, asked again after an event that may change it. */
function usePieStatus(daemon: Pick<DaemonState, "events">): PieStatus {
  const [status, setStatus] = useState<ViewportStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const check = (fresh = false): Promise<ViewportStatus | null> =>
    Promise.resolve()
      .then(() => api.viewport(fresh))
      .then((s) => {
        setStatus(s);
        setError(null);
        return s;
      }, (e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        return null;
      });
  const asks = daemon.events.filter((e) => asksViewportAgain(e.type)).length;
  useEffect(() => {
    void check();
  }, [asks]);
  // A Play session the daemon pushed, however it started: shown at once.
  // A loop, not findLast: the UI still targets Chrome 90.
  let lastPie: (typeof daemon.events)[number] | undefined;
  for (let i = daemon.events.length - 1; i >= 0 && !lastPie; i--) if (pieFromEvent(daemon.events[i].type) !== null) lastPie = daemon.events[i];
  useEffect(() => {
    const pie = lastPie ? pieFromEvent(lastPie.type) : null;
    if (pie !== null) setStatus((s) => withPie(s, pie));
  }, [lastPie?.id]);
  return useMemo(() => ({ status, error, check, setStatus }), [status, error]);
}

/** The page's one PIE status and viewer, and the full viewer's dialog. App.tsx mounts it on a remote client only. */
export function LiveProvider({ daemon, onSettings, peer = browserPeer, children }: {
  daemon: Pick<DaemonState, "events">;
  onSettings: (s: SettingsSection) => void;
  peer?: PeerFactory;
  children: ReactNode;
}) {
  const pie = usePieStatus(daemon);
  const [holds, setHolds] = useState(0);
  const [dialog, setDialog] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [source, setSource] = useState<ViewportSource>("pie");
  const wanted = holds > 0 || dialog;
  useEffect(() => {
    if (wanted) void pie.check();
  }, [wanted]);
  const gate = pie.status ? viewportGate(pie.status, { remote: true }) : null;

  // Joined on the first want, left a while after the last.
  const [keep, setKeep] = useState(false);
  useEffect(() => {
    if (wanted) {
      setKeep(true);
      return;
    }
    const t = setTimeout(() => setKeep(false), LIVE_LINGER_MS);
    return () => clearTimeout(t);
  }, [wanted]);
  const joined = keep && pie.status !== null && gate === null;
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<ViewerPhase>({ phase: "joining" });
  useEffect(() => {
    if (!joined) return;
    const s = new ViewportSession({ api, peer, source, onPhase: setPhase });
    s.start();
    return () => {
      s.stop();
      setPhase({ phase: "joining" });
    };
  }, [joined, source, attempt]);
  // A refusal mid-watch carries the status that explains it.
  useEffect(() => {
    if (phase.phase === "refused" && phase.status) pie.setStatus(phase.status);
  }, [phase]);

  // A frame now and then while live, for the moment after a run ends, when the stream is already gone.
  const live = phase.phase === "live" ? phase.stream : null;
  const frame = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (!live || typeof MediaStream === "undefined" || !(live instanceof MediaStream)) return;
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.srcObject = live;
    void v.play().catch(() => undefined);
    const canvas = document.createElement("canvas");
    const take = () => {
      if (v.readyState < 2 || !v.videoWidth) return;
      const w = Math.min(FRAME_MAX_W, v.videoWidth);
      canvas.width = w;
      canvas.height = Math.round((w * v.videoHeight) / v.videoWidth);
      const g = canvas.getContext("2d");
      if (!g) return;
      g.drawImage(v, 0, 0, canvas.width, canvas.height);
      frame.current = canvas;
    };
    const t = setInterval(take, FRAME_EVERY_MS);
    return () => {
      clearInterval(t);
      v.srcObject = null;
    };
  }, [live]);

  const stable = useRef<Pick<LiveValue, "hold" | "hasFrame" | "lastFrame" | "open" | "retry">>();
  if (!stable.current) {
    stable.current = {
      hold: () => {
        setHolds((n) => n + 1);
        let held = true;
        return () => {
          if (!held) return;
          held = false;
          setHolds((n) => n - 1);
        };
      },
      hasFrame: () => frame.current !== null,
      lastFrame: () => {
        try {
          return frame.current ? frame.current.toDataURL("image/jpeg", 0.82) : null;
        } catch {
          return null;
        }
      },
      open: () => setDialog(true),
      retry: () => setAttempt((n) => n + 1),
    };
  }
  const close = () => {
    setDialog(false);
    setSource("pie");
  };

  const value: LiveValue = { pie, gate, phase, source, setSource, expanded, setExpanded, onSettings, ...stable.current };
  return (
    <LiveContext.Provider value={value}>
      {children}
      {dialog && <ViewportDialog daemon={daemon} live={value} onClose={close} />}
    </LiveContext.Provider>
  );
}

/** The bar's Live button: a pulsing dot and Live, shown only while Play In Editor runs. */
export function LiveButton({ check, className = "" }: { check?: string | null; className?: string }) {
  const live = useContext(LiveContext);
  if (!live || !pieRunning(live.pie.status)) return null;
  const hint = liveButtonHint(check);
  return (
    <button className={`ghost live-button ${className}`} onClick={live.open} title={hint} aria-label={hint}>
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
 * The viewport in a dialog over whatever tab is up, on the page's one viewer.
 * Mounted only while open, so the viewer is wanted while it shows; Escape or
 * the scrim closes it.
 */
function ViewportDialog({ daemon, live, onClose }: { daemon: Pick<DaemonState, "events">; live: LiveValue; onClose: () => void }) {
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
        <ViewportView daemon={daemon} live={live} onSettings={(s) => { onClose(); live.onSettings(s); }} />
      </div>
    </div>,
    document.body,
  );
}

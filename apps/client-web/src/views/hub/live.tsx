/**
 * The editor's Play In Editor viewport in the Playtest Hub, beside whatever
 * is playing now: large on the run screen, a tile on a check or goal, a
 * thumbnail in the overview's queue card, and next to a verdict whose run
 * still plays, so a person judges a manual step by watching it.
 *
 * The hub holds one viewer for all of them (HubLiveProvider). A placement
 * that is involved in a playing run holds it; the viewer joins on the first
 * hold and leaves HUB_LIVE_LINGER_MS after the last one lets go, so moving
 * between screens, or from one run of a plan to the next, keeps the same
 * connection. Every placement draws the same MediaStream, and the full
 * viewer opened from any of them draws it too (ViewportDialog's `viewer`),
 * so the hub never asks the editor for a second stream.
 *
 * What each placement draws is client-core's hubLiveView: the video while it
 * is live, the last frame dimmed for a moment after the run ends, and
 * otherwise nothing, except that the run screen and the inbox say once why
 * there is no picture (the editor's state, the stream's) with the Viewport
 * tab's own words and ways forward.
 */
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { ViewportStatus } from "@ue-mcp-studio/shared";
import {
  HUB_LIVE_COPY,
  HUB_LIVE_ENDED_MS,
  HUB_LIVE_LINGER_MS,
  VIEWPORT_BUTTON,
  VIEWPORT_BUTTON_HINT,
  ViewportSession,
  asksViewportAgain,
  hubLiveView,
  pieFromEvent,
  showsViewportButton,
  viewerNotice,
  viewportGate,
  withPie,
  type HubLiveVariant,
  type HubLiveView,
  type PeerFactory,
  type ViewerPhase,
  type ViewportAction,
  type ViewportNotice,
} from "@ue-mcp-studio/client-core";
import { api } from "../../api";
import { onRemotePage } from "../../connection";
import { ViewportDialog } from "../../chat/PieLive";
import { browserPeer, runViewportAction } from "../Viewport";
import type { DaemonState } from "../../state";
import type { SettingsSection } from "../settings/sections";
import { HubIcon } from "./parts";

/** The longest side of the frame kept for after a run ends. */
const FRAME_MAX_W = 640;
/** How often that frame is taken while live. */
const FRAME_EVERY_MS = 1000;

export interface HubLiveValue {
  status: ViewportStatus | null;
  gate: ViewportNotice | null;
  phase: ViewerPhase;
  remote: boolean;
  /** Keep the viewer while the caller shows a playing run; call what it returns to let go. Stable across renders. */
  hold: () => () => void;
  /** A frame of the stream has been kept. */
  hasFrame: () => boolean;
  /** The newest kept frame as an image URL, or null. */
  lastFrame: () => string | null;
  /** Open the full viewer over the hub, on the same viewer. */
  expand: () => void;
  act: (a: ViewportAction) => Promise<void>;
  busy: string | null;
  actionError: string | null;
}

export const HubLiveContext = createContext<HubLiveValue | null>(null);

const NO_EVENTS: Pick<DaemonState, "events"> = { events: [] };

/** The hub's one viewer, and the full viewer over the hub when one is open. */
export function HubLiveProvider({ daemon = NO_EVENTS, onSettings = () => undefined, peer = browserPeer, children }: {
  daemon?: Pick<DaemonState, "events">;
  onSettings?: (s: SettingsSection) => void;
  peer?: PeerFactory;
  children: ReactNode;
}) {
  const remote = onRemotePage();
  const [holds, setHolds] = useState(0);
  const [dialog, setDialog] = useState(false);
  const wanted = holds > 0 || dialog;

  // GET /viewport on mount, when something comes to want the viewer, and after an event that may change it;
  // a pie.* event applies at once. Nothing polls. The Viewport buttons read whether PIE runs from it.
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
    void check();
  }, [asks, wanted]);
  // A loop, not findLast: the UI still targets Chrome 90.
  let lastPie: (typeof daemon.events)[number] | undefined;
  for (let i = daemon.events.length - 1; i >= 0 && !lastPie; i--) if (pieFromEvent(daemon.events[i].type) !== null) lastPie = daemon.events[i];
  useEffect(() => {
    const pie = lastPie ? pieFromEvent(lastPie.type) : null;
    if (pie !== null) setStatus((s) => withPie(s, pie));
  }, [lastPie?.id]);
  const gate = status ? viewportGate(status, { remote }) : null;

  // Joined on the first hold, left a while after the last.
  const [keep, setKeep] = useState(false);
  useEffect(() => {
    if (wanted) {
      setKeep(true);
      return;
    }
    const t = setTimeout(() => setKeep(false), HUB_LIVE_LINGER_MS);
    return () => clearTimeout(t);
  }, [wanted]);
  const open = keep && status !== null && gate === null;
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<ViewerPhase>({ phase: "joining" });
  useEffect(() => {
    if (!open) return;
    const s = new ViewportSession({ api, peer, source: "pie", onPhase: setPhase });
    s.start();
    return () => {
      s.stop();
      setPhase({ phase: "joining" });
    };
  }, [open, attempt]);

  // A frame now and then while live, for the moment after the run ends, when the stream is already gone.
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

  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const retry = () => setAttempt((n) => n + 1);
  const act = async (a: ViewportAction) => {
    setActionError(null);
    setBusy(a.id);
    try {
      await runViewportAction(a, { check, setStatus, onSettings, watch: retry, remote });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const stable = useRef<Pick<HubLiveValue, "hold" | "hasFrame" | "lastFrame">>();
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
    };
  }

  const value: HubLiveValue = { status, gate, phase, remote, ...stable.current, expand: () => setDialog(true), act, busy, actionError };
  return (
    <HubLiveContext.Provider value={value}>
      {children}
      {dialog && <ViewportDialog daemon={daemon} viewer={{ phase, retry }} onClose={() => setDialog(false)} onSettings={onSettings} />}
    </HubLiveContext.Provider>
  );
}

/**
 * The explicit way into the full viewer: shown while the thing beside it is
 * involved in a playing run, or while Play In Editor runs at all. Hidden
 * otherwise, since there is nothing to watch.
 */
export function ViewportButton({ relevant, compact = false, className = "" }: { relevant: boolean; compact?: boolean; className?: string }) {
  const ctx = useContext(HubLiveContext);
  if (!ctx || !showsViewportButton({ relevant, status: ctx.status })) return null;
  return (
    <button className={`hub-viewport-button ${compact ? "ghost small-button" : ""} ${className}`} onClick={ctx.expand} title={VIEWPORT_BUTTON_HINT}>
      <span className="pie-dot live" aria-hidden="true" />
      {VIEWPORT_BUTTON}
    </button>
  );
}

/** The ways forward a hub placement offers: not the source switch, since the hub shows Play In Editor only. */
const hubNotice = (n: ViewportNotice): ViewportNotice => ({ ...n, actions: n.actions.filter((a) => a.id !== "level-viewport" && a.id !== "pie") });

export interface HubLiveState {
  view: HubLiveView;
  variant: HubLiveVariant;
  /** The frame an ended or held view draws. */
  frame: string | null;
  notice: ViewportNotice | null;
  ctx: HubLiveValue | null;
}

/**
 * What one placement draws, and its hold on the hub's viewer while `playing`:
 * the thing it sits beside is involved in a run playing now. A screen that
 * lays itself out around the viewport reads `view` first.
 */
export function useHubLive(playing: boolean, variant: HubLiveVariant): HubLiveState {
  const ctx = useContext(HubLiveContext);
  const hold = ctx?.hold;
  useEffect(() => {
    if (!hold || !playing) return;
    return hold();
  }, [playing, hold]);

  // Live here at least once during this run: a stream that drops back keeps its frame, and the end shows it.
  const [seen, setSeen] = useState(false);
  const [ended, setEnded] = useState<string | null>(null);
  const [held, setHeld] = useState<string | null>(null);
  const view = ctx
    ? hubLiveView({
        playing,
        endedFrame: ended !== null,
        seenFrame: seen && ctx.hasFrame(),
        statusKnown: ctx.status !== null,
        gated: ctx.gate !== null,
        phase: ctx.phase.phase,
        variant,
      })
    : "hidden";

  useEffect(() => {
    if (view === "video" && !seen) setSeen(true);
  }, [view, seen]);
  // Before paint, so the end never flashes an empty place between the video and its last frame.
  const was = useRef(playing);
  useLayoutEffect(() => {
    if (was.current && !playing && seen) {
      const f = ctx?.lastFrame() ?? null;
      if (f) setEnded(f);
    }
    if (playing) setEnded(null);
    else setSeen(false);
    was.current = playing;
  }, [playing]);
  useLayoutEffect(() => {
    if (view === "held" && !held) setHeld(ctx?.lastFrame() ?? null);
    else if (view !== "held" && held) setHeld(null);
  }, [view]);
  useEffect(() => {
    if (!ended) return;
    const t = setTimeout(() => setEnded(null), HUB_LIVE_ENDED_MS);
    return () => clearTimeout(t);
  }, [ended]);

  const notice = view === "notice" && ctx ? hubNotice(ctx.gate ?? viewerNotice(ctx.phase, "pie", { remote: ctx.remote }) ?? { tone: "info", title: HUB_LIVE_COPY.starting, body: "", actions: [], busy: true }) : null;
  return { view, variant, frame: view === "ended" ? ended : view === "held" ? held : null, notice, ctx };
}

/**
 * One placement of the viewport. Clicking the picture opens the full viewer.
 * `overlay` sits over the picture's foot (the run screen's current step);
 * `caption` goes under it.
 */
export function HubLive({ live, overlay, caption, className = "" }: { live: HubLiveState; overlay?: ReactNode; caption?: ReactNode; className?: string }) {
  const { view, variant, ctx } = live;
  const video = useRef<HTMLVideoElement>(null);
  const stream = view === "video" && ctx?.phase.phase === "live" ? ctx.phase.stream : null;
  useEffect(() => {
    if (video.current) video.current.srcObject = (stream as MediaStream | null) ?? null;
  }, [stream]);

  if (view === "hidden" || !ctx) return null;

  if (view === "notice") {
    const n = live.notice!;
    return (
      <div className={`hub-live hub-live-${variant} hub-live-notice tone-${n.tone} ${className}`} role={n.tone === "bad" ? "alert" : "status"}>
        <div className="hub-live-notice-title">
          {n.busy ? <span className="spinner small" aria-hidden="true" /> : <span className="pie-dot" aria-hidden="true" />}
          <strong>{n.title}</strong>
        </div>
        {!n.busy && n.body && <p className="small muted">{n.body}</p>}
        {n.actions.length > 0 && (
          <div className="hub-live-actions">
            {n.actions.map((a) => (
              <button key={a.id} className={a.primary ? "primary small-button" : "small-button"} disabled={ctx.busy !== null} onClick={() => void ctx.act(a)}>
                {ctx.busy === a.id ? "Working" : a.label}
              </button>
            ))}
          </div>
        )}
        {ctx.actionError && <p className="small hub-bad-text">{ctx.actionError}</p>}
      </div>
    );
  }

  const still = view === "ended" || view === "held";
  return (
    <figure className={`hub-live hub-live-${variant} view-${view} ${className}`}>
      <div className="hub-live-stage">
        {still ? (
          live.frame ? <img className="hub-live-frame" src={live.frame} alt="" /> : <span className="hub-live-frame blank" />
        ) : (
          <video ref={video} className="hub-live-video" autoPlay playsInline muted aria-label="Play In Editor, live" />
        )}
        {view === "video" && <span className="hub-live-badge"><span className="pie-dot live" aria-hidden="true" />{HUB_LIVE_COPY.live}</span>}
        {view === "ended" && <span className="hub-live-ended" role="status">{HUB_LIVE_COPY.ended}</span>}
        {view === "held" && <span className="hub-live-ended" aria-hidden="true"><span className="spinner small" /></span>}
        {overlay && view !== "ended" && <div className="hub-live-overlay">{overlay}</div>}
        {view !== "ended" && (
          <button className="hub-live-hit" onClick={ctx.expand} aria-label={HUB_LIVE_COPY.expand} title={HUB_LIVE_COPY.expand}>
            <span className="hub-live-expand"><HubIcon name="expand" size={variant === "thumb" ? 12 : 14} /></span>
          </button>
        )}
      </div>
      {caption && <figcaption className="hub-live-caption">{caption}</figcaption>}
    </figure>
  );
}

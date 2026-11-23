/**
 * The editor's Play In Editor viewport in the Playtest Hub, on a remote
 * client only (client-core's viewportAllowed): the Viewport card on the Run
 * screen while that run plays. Elsewhere the bar's Live button (App.tsx) is
 * the way in. The card never connects on its own.
 * Collapsed, it says in one line that the run is running now.
 * Expanded, it joins the viewer and draws the picture in place, or the
 * viewer's notice with its ways forward; a second control opens the full
 * viewer.
 *
 * The hub holds one viewer for every card (HubLiveProvider), and whether the
 * cards are expanded is the hub's, not each screen's: a card that is expanded
 * and on screen holds the viewer, which joins on the first hold and leaves
 * HUB_LIVE_LINGER_MS after the last one lets go, so moving between screens
 * keeps the same connection. Every card draws the same MediaStream, and the
 * full viewer draws it too (ViewportDialog's `viewer`), including when the
 * bar's Live button opens it (LiveHostContext), so the hub never asks the
 * editor for a second stream.
 *
 * What a card says and draws is client-core's hubViewerLine and hubLiveView.
 */
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { ViewportStatus } from "@ue-mcp-studio/shared";
import {
  HUB_LIVE_COPY,
  HUB_LIVE_ENDED_MS,
  HUB_LIVE_LINGER_MS,
  HUB_VIEWER_COPY,
  ViewportSession,
  hubHash,
  hubLiveView,
  hubViewerLine,
  viewerNotice,
  viewportAllowed,
  viewportGate,
  type HubLiveView,
  type HubViewerLine,
  type PeerFactory,
  type PlayingRun,
  type ViewerPhase,
  type ViewportAction,
  type ViewportNotice,
} from "@ue-mcp-studio/client-core";
import { api } from "../../api";
import { onRemotePage } from "../../connection";
import { LiveHostContext, ViewportDialog, usePieStatus } from "../../chat/PieLive";
import { browserPeer, runViewportAction } from "../Viewport";
import type { DaemonState } from "../../state";
import type { SettingsSection } from "../settings/sections";
import { HubIcon, HubLink } from "./parts";
import { HubContext } from "./state";

/** The longest side of the frame kept for after a run ends. */
const FRAME_MAX_W = 640;
/** How often that frame is taken while live. */
const FRAME_EVERY_MS = 1000;

export interface HubLiveValue {
  status: ViewportStatus | null;
  gate: ViewportNotice | null;
  phase: ViewerPhase;
  remote: boolean;
  /** The cards are expanded: the person asked to watch. */
  expanded: boolean;
  setExpanded: (on: boolean) => void;
  /** Keep the viewer while an expanded card is on screen; call what it returns to let go. Stable across renders. */
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

interface HubLiveProps {
  daemon?: Pick<DaemonState, "events">;
  onSettings?: (s: SettingsSection) => void;
  peer?: PeerFactory;
  children: ReactNode;
}

/**
 * The hub's one viewer, whether its cards are expanded, and the full viewer
 * over the hub when one is open. Only on a remote client (viewportAllowed):
 * on the computer there is no context, so the Run screen draws no viewer.
 */
export function HubLiveProvider(props: HubLiveProps) {
  return viewportAllowed(onRemotePage()) ? <HubLive {...props} /> : <>{props.children}</>;
}

function HubLive({ daemon = NO_EVENTS, onSettings = () => undefined, peer = browserPeer, children }: HubLiveProps) {
  const remote = true;
  const [holds, setHolds] = useState(0);
  const [dialog, setDialog] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const wanted = holds > 0 || dialog;

  // The app's one GET /viewport (PieStatusContext), asked again when something comes to want the viewer.
  const { status, check, setStatus } = usePieStatus(daemon);
  useEffect(() => {
    if (wanted) void check();
  }, [wanted]);
  const gate = status ? viewportGate(status, { remote }) : null;

  // The bar's Live button opens the full viewer here while the hub is mounted, on this viewer.
  const host = useContext(LiveHostContext);
  useEffect(() => {
    if (!host) return;
    host(() => setDialog(true));
    return () => host(null);
  }, [host]);

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

  const value: HubLiveValue = { status, gate, phase, remote, expanded, setExpanded, ...stable.current, expand: () => setDialog(true), act, busy, actionError };
  return (
    <HubLiveContext.Provider value={value}>
      {children}
      {dialog && <ViewportDialog daemon={daemon} viewer={{ phase, retry }} onClose={() => setDialog(false)} onSettings={onSettings} />}
    </HubLiveContext.Provider>
  );
}

/** The ways forward a card offers: not the source switch, since the hub shows Play In Editor only. */
const hubNotice = (n: ViewportNotice): ViewportNotice => ({ ...n, actions: n.actions.filter((a) => a.id !== "level-viewport" && a.id !== "pie") });

export interface HubViewerState {
  view: HubLiveView;
  line: HubViewerLine;
  /** The card is expanded. */
  open: boolean;
  /** The frame an ended or held view draws. */
  frame: string | null;
  notice: ViewportNotice | null;
  ctx: HubLiveValue | null;
}

/**
 * One screen's Viewport card: its line, what it draws, and its hold on the
 * hub's viewer while expanded. `running` is the screen's check that is
 * running now, or null. A screen that lays itself out around the card reads
 * `open` first.
 */
export function useHubViewer(running: PlayingRun | null): HubViewerState {
  const ctx = useContext(HubLiveContext);
  const editorConnected = useContext(HubContext)?.o.editor.connected ?? true;
  const open = !!ctx?.expanded;
  const hold = ctx?.hold;
  useEffect(() => {
    if (!hold || !open) return;
    return hold();
  }, [open, hold]);
  const playing = running !== null;

  // Live here at least once during this run: a stream that drops back keeps its frame, and the end shows it.
  const [seen, setSeen] = useState(false);
  const [ended, setEnded] = useState<string | null>(null);
  const [held, setHeld] = useState<string | null>(null);
  const view = ctx
    ? hubLiveView({ open, playing, endedFrame: ended !== null, seenFrame: seen && ctx.hasFrame(), gated: ctx.gate !== null, phase: ctx.phase.phase })
    : "collapsed";

  useEffect(() => {
    if (view === "video" && playing && !seen) setSeen(true);
  }, [view, seen, playing]);
  // Before paint, so the end never flashes a notice between the video and its last frame.
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

  const line = hubViewerLine({ editorConnected, status: ctx?.status ?? null, running });
  const notice = view === "notice" && ctx ? hubNotice(ctx.gate ?? viewerNotice(ctx.phase, "pie", { remote: ctx.remote }) ?? { tone: "info", title: HUB_LIVE_COPY.starting, body: "", actions: [], busy: true }) : null;
  return { view, line, open, frame: view === "ended" ? ended : view === "held" ? held : null, notice, ctx };
}

/**
 * The Viewport card. `overlay` sits over the picture's foot (the run screen's
 * current step). `linkRun` links the running check's name to its run, for
 * screens other than that run's own.
 */
export function HubViewer({ viewer, overlay, linkRun = true, className = "" }: { viewer: HubViewerState; overlay?: ReactNode; linkRun?: boolean; className?: string }) {
  const go = useContext(HubContext)?.go;
  const { view, line, open, ctx } = viewer;
  const video = useRef<HTMLVideoElement>(null);
  const stream = view === "video" && ctx?.phase.phase === "live" ? ctx.phase.stream : null;
  useEffect(() => {
    if (video.current) video.current.srcObject = (stream as MediaStream | null) ?? null;
  }, [stream]);
  // Only while one of the screen's checks runs, or for the moment its last frame shows after: never an idle card.
  if (!ctx || (!line.run && view !== "ended")) return null;

  const run = line.run;
  const route = run ? { screen: "run" as const, runId: run.runId } : null;
  const head = (
    <div className="hub-viewer-head">
      <span className={`pie-dot ${line.tone === "on" || line.tone === "run" ? "live" : ""}`} aria-hidden="true" />
      <span className="hub-viewer-title">{HUB_VIEWER_COPY.title}</span>
      <span className="hub-viewer-line">
        {run && route ? (
          <>
            <span className="pill hub-viewer-running">{line.text}</span>
            {linkRun && go ? <HubLink href={hubHash(route)} onGo={() => go(route)}>{run.name}</HubLink> : <span>{run.name}</span>}
          </>
        ) : <span className={line.tone === "warn" ? "hub-warn-text" : ""}>{line.text}</span>}
      </span>
      {open && (
        <button className="ghost icon-button" onClick={ctx.expand} aria-label={HUB_LIVE_COPY.expand} title={HUB_LIVE_COPY.expand}>
          <HubIcon name="expand" size={13} />
        </button>
      )}
      <button className={open ? "ghost small-button" : "small-button"} aria-expanded={open} onClick={() => ctx.setExpanded(!open)}>
        {open ? HUB_VIEWER_COPY.hide : HUB_VIEWER_COPY.watch}
      </button>
    </div>
  );

  let body: ReactNode = null;
  if (view === "notice") {
    const n = viewer.notice!;
    body = (
      <div className={`hub-live-notice tone-${n.tone}`} role={n.tone === "bad" ? "alert" : "status"}>
        <div className="hub-live-notice-title">
          {n.busy ? <span className="spinner small" aria-hidden="true" /> : <span className="pie-dot" aria-hidden="true" />}
          <strong>{n.title}</strong>
        </div>
        {n.body && <p className="small muted">{n.body}</p>}
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
  } else if (view !== "collapsed") {
    const still = view === "ended" || view === "held";
    body = (
      <figure className={`hub-live view-${view}`}>
        <div className="hub-live-stage">
          {still ? (
            viewer.frame ? <img className="hub-live-frame" src={viewer.frame} alt="" /> : <span className="hub-live-frame blank" />
          ) : (
            <video ref={video} className="hub-live-video" autoPlay playsInline muted aria-label="Play In Editor, live" />
          )}
          {view === "video" && <span className="hub-live-badge"><span className="pie-dot live" aria-hidden="true" />{HUB_LIVE_COPY.live}</span>}
          {view === "ended" && <span className="hub-live-ended" role="status">{HUB_LIVE_COPY.ended}</span>}
          {view === "held" && <span className="hub-live-ended" aria-hidden="true"><span className="spinner small" /></span>}
          {overlay && view !== "ended" && <div className="hub-live-overlay">{overlay}</div>}
          {view !== "ended" && <button className="hub-live-hit" onClick={ctx.expand} aria-label={HUB_LIVE_COPY.expand} tabIndex={-1} />}
        </div>
      </figure>
    );
  }

  return (
    <section className={`hub-viewer tone-${line.tone} ${open ? "open" : ""} ${className}`} aria-label={HUB_VIEWER_COPY.title}>
      {head}
      {body}
    </section>
  );
}

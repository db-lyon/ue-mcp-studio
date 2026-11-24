/**
 * The editor's Play In Editor viewport in the Playtest Hub: the Viewport card
 * on the Run screen while that run plays. Elsewhere the bar's Live button
 * (App.tsx) is the way in. The card never connects on its own.
 * Collapsed, it says in one line that the run is running now.
 * Expanded, it holds the page's one viewer (LiveProvider in chat/PieLive.tsx)
 * and draws the picture in place, or the viewer's notice with its ways
 * forward; a second control opens the full viewer on the same viewer.
 *
 * There is no LiveProvider on the computer (client-core's viewportAllowed),
 * so there the card draws nothing.
 *
 * What a card says and draws is client-core's hubViewerLine and hubLiveView.
 */
import { useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  HUB_LIVE_COPY,
  HUB_LIVE_ENDED_MS,
  HUB_VIEWER_COPY,
  hubHash,
  hubLiveView,
  hubViewerLine,
  viewerNotice,
  type HubLiveView,
  type HubViewerLine,
  type PlayingRun,
  type ViewportAction,
  type ViewportNotice,
} from "@ue-mcp-studio/client-core";
import { LiveContext, type LiveValue } from "../../chat/PieLive";
import { runViewportAction } from "../Viewport";
import { EditorConsent, useEditorConsent } from "../EditorConsent";
import { HubIcon, HubLink } from "./parts";
import { HubContext } from "./state";

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
  ctx: LiveValue | null;
}

/**
 * The Run screen's Viewport card: its line, what it draws, and its hold on
 * the page's viewer while expanded. `running` is the run playing now, or
 * null. A screen that lays itself out around the card reads `open` first.
 */
export function useHubViewer(running: PlayingRun | null): HubViewerState {
  const ctx = useContext(LiveContext);
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

  const line = hubViewerLine({ editorConnected, status: ctx?.pie.status ?? null, running });
  const notice = view === "notice" && ctx ? hubNotice(ctx.gate ?? viewerNotice(ctx.phase, "pie", { remote: true }) ?? { tone: "info", title: HUB_LIVE_COPY.starting, body: "", actions: [], busy: true }) : null;
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
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const consent = useEditorConsent();
  // Only while the run plays, or for the moment its last frame shows after: never an idle card.
  if (!ctx || (!line.run && view !== "ended")) return null;

  const act = async (a: ViewportAction) => {
    setActionError(null);
    setBusy(a.id);
    try {
      await runViewportAction(a, { check: ctx.pie.check, setStatus: ctx.pie.setStatus, onSettings: ctx.onSettings, watch: ctx.retry, remote: true, restart: () => consent.run("restart") });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

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
        <button className="ghost icon-button" onClick={ctx.open} aria-label={HUB_LIVE_COPY.expand} title={HUB_LIVE_COPY.expand}>
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
              <button key={a.id} className={a.primary ? "primary small-button" : "small-button"} disabled={busy !== null} onClick={() => void act(a)}>
                {busy === a.id ? "Working" : a.label}
              </button>
            ))}
          </div>
        )}
        {consent.ask && (
          <EditorConsent
            ask={consent.ask}
            onApprove={() => {
              setBusy("restart-editor");
              setActionError(null);
              void consent.approve().then(
                (r) => (r ? ctx.pie.check() : undefined),
                (e: unknown) => setActionError(e instanceof Error ? e.message : String(e)),
              ).finally(() => setBusy(null));
            }}
            onCancel={consent.cancel}
          />
        )}
        {actionError && <p className="small hub-bad-text">{actionError}</p>}
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
          {view !== "ended" && <button className="hub-live-hit" onClick={ctx.open} aria-label={HUB_LIVE_COPY.expand} tabIndex={-1} />}
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

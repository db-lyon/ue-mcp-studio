import { useEffect, useRef, useState } from "react";
import type { ViewportSource, ViewportStatus } from "@ue-mcp-studio/shared";
import {
  VIEWPORT_PLANS_URL,
  VIEWPORT_SOURCE_CHOICES,
  VIEWPORT_VIEW_ONLY,
  ViewportSession,
  viewerNotice,
  viewportGate,
  type PeerFactory,
  type ViewerPhase,
  type ViewportAction,
  type ViewportNotice,
} from "@ue-mcp-studio/client-core";
import { api } from "../api";
import { openExternal } from "../native";
import { onRemotePage } from "../connection";
import type { DaemonState } from "../state";
import type { SettingsSection } from "./settings/sections";

/** The browser's own peer connection; the visual QA page passes a stand-in. */
const browserPeer: PeerFactory = (config) => new RTCPeerConnection(config) as never;

/**
 * The live viewport: Play In Editor, or the level viewport, streamed from the
 * editor over WebRTC while this tab is open. The stream starts when the tab
 * opens (armed for the next PIE when none runs) and stops when the last viewer
 * leaves. A gate (the plan, the account, the editor) shows in the stage with
 * its way forward instead of the video.
 */
export function ViewportView({ daemon, onSettings, peer = browserPeer, embedded = false }: {
  daemon: DaemonState;
  onSettings: (s: SettingsSection) => void;
  peer?: PeerFactory;
  /** Drawn in the dialog over the chat, which has its own title: no page heading. */
  embedded?: boolean;
}) {
  const remote = onRemotePage();
  const [status, setStatus] = useState<ViewportStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [source, setSource] = useState<ViewportSource>("pie");
  const [phase, setPhase] = useState<ViewerPhase>({ phase: "joining" });
  const [watch, setWatch] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [muted, setMuted] = useState(true);
  const video = useRef<HTMLVideoElement>(null);
  const stage = useRef<HTMLDivElement>(null);

  const check = (fresh = false) =>
    api.viewport(fresh).then(
      (s) => {
        setStatus(s);
        setStatusError(null);
        return s;
      },
      (e: Error) => {
        setStatusError(e.message);
        return null;
      },
    );

  useEffect(() => {
    void check();
  }, []);

  // While a gate shows, an editor coming or going may lift it: ask again.
  const gate = status ? viewportGate(status, { remote }) : null;
  const editorEvents = daemon.events.filter((e) => e.type.startsWith("editor.")).length;
  useEffect(() => {
    if (gate) void check();
  }, [editorEvents]);

  const open = status !== null && gate === null;
  useEffect(() => {
    if (!open) return;
    const s = new ViewportSession({ api, peer, source, onPhase: setPhase });
    s.start();
    return () => s.stop();
  }, [open, source, watch]);

  const live = phase.phase === "live" ? phase.stream : null;
  useEffect(() => {
    if (video.current) video.current.srcObject = (live as MediaStream | null) ?? null;
  }, [live]);

  // A refusal mid-watch carries the status that explains it.
  useEffect(() => {
    if (phase.phase === "refused" && phase.status) setStatus(phase.status);
  }, [phase]);

  const notice: ViewportNotice | null = statusError
    ? { tone: "bad", title: "Could not check the viewport", body: statusError, actions: [{ id: "check", label: "Check again", primary: true }] }
    : !status
      ? { tone: "info", title: "Checking the viewport", body: "", actions: [], busy: true }
      : (gate ?? viewerNotice(phase, source, { remote }));

  const act = async (a: ViewportAction) => {
    setActionError(null);
    setBusy(a.id);
    try {
      switch (a.id) {
        case "check": {
          const s = await check(true);
          if (s && !viewportGate(s, { remote })) setWatch((n) => n + 1);
          break;
        }
        case "plans":
          openExternal(VIEWPORT_PLANS_URL);
          break;
        case "upgrade":
          openExternal((await api.billingCheckout({ plan: "pro", interval: "month" })).url);
          break;
        case "settings":
          onSettings("general");
          break;
        case "start-editor":
        case "restart-editor":
          await api.editor(a.id === "start-editor" ? "start" : "restart");
          await check();
          break;
        case "enable-plugin":
          setStatus(await api.enableStreamPlugin());
          break;
        case "level-viewport":
          setSource("level_viewport");
          break;
        case "pie":
          setSource("pie");
          break;
        case "watch":
          setWatch((n) => n + 1);
          break;
      }
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={`viewport-page ${embedded ? "embedded" : ""}`}>
      <div className="viewport-head" hidden={embedded && !open}>
        {!embedded && <h1 className="viewport-title">Viewport</h1>}
        <span className="spacer" />
        {open && (
          <div className="viewport-sources" role="group" aria-label="Show">
            {VIEWPORT_SOURCE_CHOICES.map((c) => (
              <button key={c.id} className={`filter-chip ${source === c.id ? "active" : ""}`} aria-pressed={source === c.id} onClick={() => setSource(c.id)}>
                {c.name}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className={`viewport-stage ${live ? "live" : ""}`} ref={stage}>
        <video ref={video} className={`viewport-video ${live ? "" : "hidden"}`} autoPlay playsInline muted={muted} aria-label="Live viewport" />
        {notice && (
          <div className={`viewport-notice tone-${notice.tone}`} role={notice.tone === "bad" ? "alert" : "status"}>
            <div className="viewport-notice-title">
              {notice.busy && <span className="spinner small" aria-hidden="true" />}
              <strong>{notice.title}</strong>
            </div>
            {notice.body && <p>{notice.body}</p>}
            {notice.actions.length > 0 && (
              <div className="viewport-actions">
                {notice.actions.map((a) => (
                  <button key={a.id} className={a.primary ? "primary small-button" : "small-button"} disabled={busy !== null} onClick={() => void act(a)}>
                    {busy === a.id ? "Working" : a.label}
                  </button>
                ))}
              </div>
            )}
            {actionError && <p className="viewport-error">{actionError}</p>}
          </div>
        )}
      </div>
      {live !== null && (
        <div className="viewport-tools">
          <button className="small-button" aria-pressed={!muted} onClick={() => setMuted((m) => !m)}>{muted ? "Sound on" : "Sound off"}</button>
          {typeof stage.current?.requestFullscreen === "function" && (
            <button className="small-button" onClick={() => void stage.current?.requestFullscreen().catch(() => undefined)}>Full screen</button>
          )}
          <span className="dim small">{VIEWPORT_VIEW_ONLY}</span>
        </div>
      )}
    </div>
  );
}

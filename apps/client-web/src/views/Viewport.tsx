import { useEffect, useRef, useState } from "react";
import type { ViewportSource, ViewportStatus } from "@ue-mcp-studio/shared";
import {
  VIEWPORT_PLANS_URL,
  VIEWPORT_SOURCE_CHOICES,
  VIEWPORT_VIEW_ONLY,
  viewerNotice,
  viewportGate,
  type PeerFactory,
  type ViewportAction,
  type ViewportNotice,
} from "@ue-mcp-studio/client-core";
import { api } from "../api";
import { openExternal } from "../native";
import { EditorConsent, useEditorConsent } from "./EditorConsent";
import type { DaemonState } from "../state";
import type { LiveValue } from "../chat/PieLive";
import type { SettingsSection } from "./settings/sections";

/** The browser's own peer connection, looked up when a viewer connects; the visual QA page and the hub demo pass or install a stand-in. */
export const browserPeer: PeerFactory = (config) => new RTCPeerConnection(config) as never;

/** What a way forward needs from the panel that offers it. */
export interface ViewportActionContext {
  check: (fresh?: boolean) => Promise<ViewportStatus | null>;
  setStatus: (s: ViewportStatus) => void;
  onSettings: (s: SettingsSection) => void;
  /** Watch again: the viewer started over. */
  watch: () => void;
  setSource?: (s: ViewportSource) => void;
  remote: boolean;
  /** Restart the editor through the consent ask; resolves with the answer, or null while it is held. */
  restart?: () => Promise<unknown>;
}

/** Take one of a notice's ways forward. Throws what failed, for the panel to show. */
export async function runViewportAction(a: ViewportAction, c: ViewportActionContext): Promise<void> {
  switch (a.id) {
    case "check": {
      const s = await c.check(true);
      if (s && !viewportGate(s, { remote: c.remote })) c.watch();
      return;
    }
    case "plans":
      openExternal(VIEWPORT_PLANS_URL);
      return;
    case "upgrade":
      openExternal((await api.billingCheckout({ plan: "pro", interval: "month" })).url);
      return;
    case "settings":
      c.onSettings("general");
      return;
    case "start-editor":
      await api.editor("start");
      await c.check();
      return;
    case "restart-editor":
      // Held while other sessions use the editor: the ask shows who, and Restart anyway runs it.
      if (c.restart ? await c.restart() : await api.editor("restart")) await c.check();
      return;
    case "enable-plugin":
      c.setStatus(await api.enableStreamPlugin());
      return;
    case "level-viewport":
      c.setSource?.("level_viewport");
      return;
    case "pie":
      c.setSource?.("pie");
      return;
    case "watch":
      c.watch();
      return;
  }
}

/**
 * The full live viewer: Play In Editor, or the level viewport, drawn from the
 * page's one viewer (LiveProvider), which joins while this shows (armed for
 * the next PIE when none runs). A gate (the plan, the account, the editor)
 * shows in the stage with its way forward instead of the video.
 */
export function ViewportView({ daemon, live, onSettings }: {
  daemon: Pick<DaemonState, "events">;
  live: LiveValue;
  onSettings: (s: SettingsSection) => void;
}) {
  const { pie, phase, source, setSource } = live;
  const { status } = pie;
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const consent = useEditorConsent();
  const [muted, setMuted] = useState(true);
  const video = useRef<HTMLVideoElement>(null);
  const stage = useRef<HTMLDivElement>(null);

  // While a gate shows, an editor coming or going may lift it: ask again.
  const gate = live.gate;
  const editorEvents = daemon.events.filter((e) => e.type.startsWith("editor.")).length;
  useEffect(() => {
    if (gate) void pie.check();
  }, [editorEvents]);

  const open = status !== null && gate === null;
  const stream = phase.phase === "live" ? phase.stream : null;
  useEffect(() => {
    if (video.current) video.current.srcObject = (stream as MediaStream | null) ?? null;
  }, [stream]);

  const notice: ViewportNotice | null = pie.error && !status
    ? { tone: "bad", title: "Could not check the viewport", body: pie.error, actions: [{ id: "check", label: "Check again", primary: true }] }
    : !status
      ? { tone: "info", title: "Checking the viewport", body: "", actions: [], busy: true }
      : (gate ?? viewerNotice(phase, source, { remote: true }));

  const act = async (a: ViewportAction) => {
    setActionError(null);
    setBusy(a.id);
    try {
      await runViewportAction(a, { check: pie.check, setStatus: pie.setStatus, onSettings, watch: live.retry, setSource, remote: true, restart: () => consent.run("restart") });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="viewport-page">
      <div className="viewport-head" hidden={!open}>
        <span className="spacer" />
        <div className="viewport-sources" role="group" aria-label="Show">
          {VIEWPORT_SOURCE_CHOICES.map((c) => (
            <button key={c.id} className={`filter-chip ${source === c.id ? "active" : ""}`} aria-pressed={source === c.id} onClick={() => setSource(c.id)}>
              {c.name}
            </button>
          ))}
        </div>
      </div>
      <div className={`viewport-stage ${stream ? "live" : ""}`} ref={stage}>
        <video ref={video} className={`viewport-video ${stream ? "" : "hidden"}`} autoPlay playsInline muted={muted} aria-label="Live viewport" />
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
            {consent.ask && (
              <EditorConsent
                ask={consent.ask}
                onApprove={() => {
                  setBusy("restart-editor");
                  setActionError(null);
                  void consent.approve().then(
                    (r) => (r ? pie.check() : undefined),
                    (e: unknown) => setActionError(e instanceof Error ? e.message : String(e)),
                  ).finally(() => setBusy(null));
                }}
                onCancel={consent.cancel}
              />
            )}
            {actionError && <p className="viewport-error">{actionError}</p>}
          </div>
        )}
      </div>
      {stream !== null && (
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

import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionDetail, SessionSummary, StudioSettings } from "@ue-mcp-studio/shared";
import { api } from "../api";
import { native } from "../native";
import { ConnectModel, EffortPicker, ModelPicker, useCatalog } from "./ModelPicker";
import type { DaemonState } from "../state";
import { agentCalls, finishedTurns } from "../chat/model";
import { useSeen } from "../chat/hooks";
import { MainTranscript, SubagentThread } from "../chat/Transcript";
import { Threads } from "../chat/Threads";
import { SessionRow } from "../chat/SessionRow";
import { Composer } from "../chat/Composer";
import { Approvals } from "../chat/Approvals";
import { SessionForms } from "../chat/Forms";
import { DialogCards } from "../chat/Dialogs";
import { useDialogs } from "../chat/dialog-model";
import { SessionIdContext, useAttachments } from "../chat/attachments";
import { AssetLinksContext, AssetTranscriptContext, useAssetLinks } from "../chat/asset-links";
import { readLocation, writeLocation } from "../location";
import { useSessionFocus } from "../focus";

/** How long a subagent thread takes to slide in or out; matches .thread-drawer's transition. */
export const DRAWER_MS = 260;

/** Starting points shown on an empty session. Each is a single task the agent can finish through ue-mcp. */
const EXAMPLES = [
  "Make a glowing orange material and put it on a sphere in the level",
  "Build a Niagara fire at the player start",
  "List every Blueprint that has no references",
];

/** Events that change a session, keyed by the session they name. */
function sessionOf(data: Record<string, unknown>): string | null {
  return typeof data.sessionId === "string" ? data.sessionId : null;
}

export function ChatView({ daemon }: { daemon: DaemonState }) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(() => readLocation().session);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const seenEvent = useRef(0);
  const streamed = useRef("");
  const [streaming, setStreaming] = useState("");
  const [settings, setSettings] = useState<StudioSettings | null>(null);
  /** The subagent thread on screen, by its agent call id; null is the main thread. */
  const [thread, setThread] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  /** The thread the drawer shows, kept while it slides out, and whether it is in. */
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { seen, markSeen } = useSeen(selected);
  const attach = useAttachments(selected);
  /** Files are being dragged over the conversation. */
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const lastList = useRef<SessionSummary[] | null>(null);
  /** The transcript area, which gives up height when the composer's divider is dragged up. */
  const stage = useRef<HTMLDivElement>(null);

  const loadList = () => api.sessions().then((r) => {
    // A turn that finished while the panel was in the background asks the editor for attention.
    if (lastList.current && !document.hasFocus()) {
      const done = finishedTurns(lastList.current, r.sessions);
      if (done.length > 0) void native().drawattention?.(done.length === 1 ? `Studio: "${done[0].title}" finished` : `Studio: ${done.length} sessions finished`);
    }
    lastList.current = r.sessions;
    setSessions(r.sessions);
    // A session the location names but that is gone (deleted elsewhere) is not opened.
    setSelected((cur) => (cur && !r.sessions.some((x) => x.id === cur) ? null : cur));
  }, (e: Error) => setError(e.message));
  const loadDetail = (id: string) => api.session(id).then((d) => {
    setDetail(d);
    setDraft((cur) => (cur ? cur : d.draft));
  }, (e: Error) => setError(e.message));

  const loadSettings = () => api.settings().then(setSettings, () => setSettings(null));
  useEffect(() => writeLocation({ tab: "Chat", session: selected }), [selected]);
  useEffect(() => {
    void loadList();
    void loadSettings();
  }, []);

  // The editor's quick ask started a session while the chat is open.
  useSessionFocus(daemon.events, (id) => {
    void loadList();
    setSelected(id);
  });

  // Nothing connected runs the selected model yet.
  const disconnected = settings !== null && settings.route === null;

  useEffect(() => {
    if (!selected) return;
    // Another session opens on its main thread, with no drawer sliding out over it.
    setThread(null);
    setDrawerId(null);
    setDrawerOpen(false);
    setDraft("");
    streamed.current = "";
    setStreaming("");
    void loadDetail(selected);
  }, [selected]);

  // Follow the event stream: refetch on any change to the open session, collect streamed text.
  useEffect(() => {
    const fresh = daemon.events.filter((e) => e.id > seenEvent.current);
    if (fresh.length === 0) return;
    seenEvent.current = fresh[fresh.length - 1].id;
    let refetch = false;
    let relist = false;
    for (const e of fresh) {
      if (!e.type.startsWith("studio.")) continue;
      const id = sessionOf(e.data);
      if (e.type === "studio.session.changed") relist = true;
      if (e.type === "studio.settings.changed") void loadSettings();
      if (id !== selected) continue;
      if (e.type === "studio.turn.delta") {
        streamed.current += String(e.data.text ?? "");
      } else {
        if (e.type === "studio.transcript.added") streamed.current = "";
        refetch = true;
      }
    }
    setStreaming(streamed.current);
    if (refetch && selected) void loadDetail(selected);
    if (relist) void loadList();
  }, [daemon.events, selected]);

  // An example prompt lands as the new session's saved draft, so it is in the composer when the session opens.
  const create = (prompt?: string) => api.newSession().then(async (d) => {
    if (prompt) await api.saveDraft(d.id, prompt);
    void loadList();
    setSelected(d.id);
  }).catch((e: Error) => setError(e.message));

  const [sent, setSent] = useState(0);
  const canSend = !!selected && !disconnected && !attach.uploading && (draft.trim().length > 0 || attach.ready.length > 0);
  const send = () => {
    if (!selected || !canSend) return;
    const text = draft;
    const files = attach.ready.map((a) => a.id);
    setDraft("");
    attach.clear();
    setThread(null);
    setSent((n) => n + 1);
    api.send(selected, text, files).then(() => loadDetail(selected), (e: Error) => {
      setDraft(text);
      setError(e.message);
    });
  };

  // Files dropped anywhere on the conversation are added to the message being written.
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes("Files");
  const drop = {
    onDragEnter: (e: React.DragEvent) => {
      if (!detail || !hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current++;
      setDragging(true);
    },
    onDragOver: (e: React.DragEvent) => {
      if (detail && hasFiles(e)) e.preventDefault();
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!detail || !hasFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    },
    onDrop: (e: React.DragEvent) => {
      if (!detail || !hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      attach.add(e.dataTransfer.files);
    },
  };

  // Stable, so the memoized transcript does not render again on every keystroke.
  const openThreadId = useCallback((id: string | null) => {
    setThread(id);
    if (id) markSeen(id);
  }, [markSeen]);
  const stopSubagent = (id: string) => {
    if (selected) void api.stopSubagent(selected, id).catch((e: Error) => setError(e.message));
  };

  const busy = detail?.status === "running" || detail?.status === "waiting";
  const dialogs = useDialogs(daemon);
  const assetLinks = useAssetLinks(detail?.id ?? null);
  const live = sessions.filter((s) => !s.archived);
  const archived = sessions.filter((s) => s.archived);
  // After a rename, archive or delete: list again, and close the open session if it is gone.
  const changed = (deleted?: string) => {
    if (deleted && deleted === selected) {
      setSelected(null);
      setDetail(null);
    }
    void loadList();
  };
  const openThread = (thread && detail && agentCalls(detail.transcript).find((c) => c.id === thread)) || null;
  const drawerCall = (drawerId && detail && agentCalls(detail.transcript).find((c) => c.id === drawerId)) || null;

  // A subagent thread is a drawer over the main thread: mounted off screen, then slid in;
  // slid out, then unmounted once the slide has finished.
  useEffect(() => {
    if (thread) {
      setDrawerId(thread);
      const raf = requestAnimationFrame(() => requestAnimationFrame(() => setDrawerOpen(true)));
      return () => cancelAnimationFrame(raf);
    }
    setDrawerOpen(false);
    const t = setTimeout(() => setDrawerId(null), DRAWER_MS);
    return () => clearTimeout(t);
  }, [thread]);

  return (
    <div className="chat">
      <aside className="card sessions">
        <div className="row">
          <h2>Sessions</h2>
          <span className="spacer" />
          <button className="primary" onClick={() => void create()}>New</button>
        </div>
        {sessions.length === 0 && <p className="dim small">No sessions yet.</p>}
        {live.map((s) => <SessionRow key={s.id} s={s} selected={s.id === selected} onOpen={() => setSelected(s.id)} onChanged={changed} />)}
        {archived.length > 0 && (
          <>
            <button className="sessions-fold dim small" aria-expanded={showArchived} onClick={() => setShowArchived(!showArchived)}>
              <span className="agents-caret">{showArchived ? "▾" : "▸"}</span>
              Archived ({archived.length})
            </button>
            {showArchived && archived.map((s) => <SessionRow key={s.id} s={s} selected={s.id === selected} onOpen={() => setSelected(s.id)} onChanged={changed} />)}
          </>
        )}
      </aside>
      <section className={`card conversation ${dragging ? "dragging" : ""}`} {...drop}>
        {dragging && <div className="drop-overlay">Drop files to attach them to your message</div>}
        {error && <div className="banner bad" onClick={() => setError(null)}>{error}</div>}
        {!detail && (
          <div className="empty">
            <h1 className="display"><em>Start</em> a session.</h1>
            <p className="muted">The agent works in this project through ue-mcp: Blueprints, materials, levels, Niagara and more. It can also run commands, read and edit the project's files, and read the web, asking you first before a command or an edit.</p>
            {settings && disconnected && <ConnectCard settings={settings} onSettings={setSettings} />}
            {settings && !disconnected && <ModelPicker settings={settings} onSettings={setSettings} />}
            <button className="primary large" onClick={() => void create()}>New session</button>
            <div className="examples">
              {EXAMPLES.map((x) => (
                <button key={x} className="example" onClick={() => void create(x)}>{x}</button>
              ))}
            </div>
          </div>
        )}
        {detail && (
          <SessionIdContext.Provider value={detail.id}>
          <AssetLinksContext.Provider value={assetLinks}>
          <AssetTranscriptContext.Provider value={detail.transcript}>
            <div className="thread-stage" ref={stage}>
              <MainTranscript
                transcript={detail.transcript}
                status={detail.status}
                streaming={streaming}
                waitingCause={detail.waitingCause}
                error={detail.error}
                onOpen={openThreadId}
                hidden={drawerOpen}
                sent={sent}
              />
              {drawerCall && (
                <div className={`thread-drawer ${drawerOpen ? "open" : ""}`}>
                  <SubagentThread
                    call={drawerCall}
                    transcript={detail.transcript}
                    sessionWaiting={detail.status === "waiting"}
                    onBack={() => setThread(null)}
                    onStop={stopSubagent}
                  />
                </div>
              )}
            </div>
            <DialogCards dialogs={(dialogs.state?.dialogs ?? []).filter((d) => d.sessionId === detail.id)} now={dialogs.now()} />
            <Approvals sessionId={detail.id} approvals={detail.approvals ?? []} />
            <SessionForms daemon={daemon} sessionId={detail.id} />
            {settings && disconnected && <div className="composer-connect"><ConnectCard settings={settings} onSettings={setSettings} /></div>}
            <Composer
              draft={draft}
              onDraft={setDraft}
              onBlur={() => selected && void api.saveDraft(selected, draft)}
              placeholder={busy ? "The agent is working. You can stop it." : openThread ? "Message the main agent" : "Ask for something in the editor, or drop files here"}
              busy={busy}
              canSend={canSend}
              onSend={send}
              onStop={() => selected && void api.stop(selected)}
              files={attach.files}
              onAddFiles={attach.add}
              onRemoveFile={attach.remove}
              stage={stage}
              height={settings?.composerHeight ?? null}
              onHeight={(composerHeight) => void api.saveSettings({ composerHeight }).then(setSettings, (e: Error) => setError(e.message))}
              picker={settings && <><ModelPicker settings={settings} onSettings={setSettings} up /><EffortPicker settings={settings} onSettings={setSettings} /></>}
            >
              <Threads
                transcript={detail.transcript}
                thread={openThread ? thread : null}
                onThread={openThreadId}
                onStop={stopSubagent}
                sessionWaiting={detail.status === "waiting"}
                seen={seen}
              />
            </Composer>
          </AssetTranscriptContext.Provider>
          </AssetLinksContext.Provider>
          </SessionIdContext.Provider>
        )}
      </section>
    </div>
  );
}

/** Nothing connected runs the selected model: sign in here (a key is the fallback), or pick another model. */
function ConnectCard({ settings, onSettings }: { settings: StudioSettings; onSettings: (s: StudioSettings) => void }) {
  const catalog = useCatalog(settings);
  return (
    <div className="keyform">
      <span className="eyebrow">Sign in to start</span>
      {catalog && (
        <ConnectModel
          catalog={catalog}
          vendor={settings.provider}
          model={settings.model}
          onConnected={() => void api.settings().then(onSettings)}
        />
      )}
      <div className="row connect-other">
        <span className="dim small">Or choose another model:</span>
        <ModelPicker settings={settings} onSettings={onSettings} />
      </div>
    </div>
  );
}

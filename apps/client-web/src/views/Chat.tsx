import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PlaytestRequest, QaScriptStep, SessionDetail, SessionSummary, StudioSettings } from "@ue-mcp-studio/shared";
import { api } from "../api";
import { native } from "../native";
import { ConnectModel, EffortPicker, ModelPicker, useCatalog } from "./ModelPicker";
import type { DaemonState } from "../state";
import { agentCalls, finishedTurns } from "../chat/model";
import { useDismissed, useSeen } from "../chat/hooks";
import { EditMessageContext, MainTranscript, PlaytestCommandContext, PlaytestConvertContext, SubagentThread, type EditMode } from "../chat/Transcript";
import { QueuedMessages } from "../chat/Queue";
import { pillsFor } from "../chat/pill-providers";
import { PillRow } from "../chat/Pills";
import { Threads } from "../chat/Threads";
import { SessionRow } from "../chat/SessionRow";
import { Composer } from "../chat/Composer";
import { Approvals } from "../chat/Approvals";
import { FormCards, useForms } from "../chat/Forms";
import { OutsideRuns, QaContext, useOutsideRuns } from "../chat/Qa";
import { DialogCards } from "../chat/Dialogs";
import { useDialogs } from "../chat/dialog-model";
import { SessionIdContext, useAttachments } from "../chat/attachments";
import { AssetLinksContext, AssetTranscriptContext, useAssetLinks } from "../chat/asset-links";
import { readLocation, writeLocation } from "../location";
import { useSessionFocus } from "../focus";
import { chatPane } from "../chat/pane";
import { ChatHeader } from "../chat/ChatHeader";
import { Sheet } from "../chat/Sheet";
import { ReviewPanel } from "../chat/TurnReview";
import { NARROW, useMedia } from "../layout";

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

/** How long the session list may take before the panel says Studio is not answering. */
export const LIST_SLOW_MS = 8000;

export function ChatView({ daemon, nav }: { daemon: DaemonState; nav?: { session: string | null; n: number } }) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  /** Whether the list has come back once: until then an empty list is not "no sessions". */
  const [listed, setListed] = useState(false);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (listed) return;
    const t = setTimeout(() => setSlow(true), LIST_SLOW_MS);
    return () => clearTimeout(t);
  }, [listed]);
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
  const narrow = useMedia(NARROW);
  const [sheet, setSheet] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  /** The thread the drawer shows, kept while it slides out, and whether it is in. */
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { seen, markSeen } = useSeen(selected, detail?.seen, api.markSeen);
  const { dismissed, dismiss } = useDismissed(selected, detail?.dismissed, api.dismissAgents);
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
    setListed(true);
    setSlow(false);
    // A session the location names but that is gone (deleted elsewhere) is not opened.
    setSelected((cur) => (cur && !r.sessions.some((x) => x.id === cur) ? null : cur));
  }, (e: Error) => setError(e.message));
  const loadDetail = (id: string) => api.session(id).then((d) => {
    setDetail(d);
    setDraft((cur) => (cur ? cur : d.draft));
  }, (e: Error) => setError(e.message));

  // The panel's navigation asked for a session, or for the list (null).
  const navSeen = useRef(nav?.n ?? 0);
  useEffect(() => {
    if (!nav || nav.n === navSeen.current) return;
    navSeen.current = nav.n;
    if (nav.session) {
      void loadList();
      setSelected(nav.session);
    } else {
      setSelected(null);
      setDetail(null);
    }
  }, [nav?.n]);

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
  /** Hand the composer's message to `how`: send, send now, or queue. The draft comes back if it fails. */
  const dispatch = (how: (id: string, text: string, files: string[]) => Promise<unknown>, follow: boolean) => {
    if (!selected || !canSend) return;
    const text = draft;
    const files = attach.ready.map((a) => a.id);
    clearPills();
    setDraft("");
    attach.clear();
    void api.saveDraft(selected, "").catch(() => {});
    if (follow) {
      setThread(null);
      setSent((n) => n + 1);
    }
    how(selected, text, files).then(() => loadDetail(selected), (e: Error) => {
      setDraft(text);
      setError(e.message);
    });
  };
  const send = () => dispatch((id, text, files) => api.send(id, text, files), true);
  const sendNow = () => dispatch((id, text, files) => api.send(id, text, files, true), true);
  const queue = () => dispatch((id, text, files) => api.queue(id, text, files), false);
  const editMessage = useCallback((index: number, text: string, mode: EditMode) => {
    if (!selected) return;
    setThread(null);
    setSent((n) => n + 1);
    api.editMessage(selected, index, text, mode).then((r) => {
      // A fork is a new session: the panel moves to it, and the list shows it.
      if (mode === "fork" && r?.sessionId) {
        void loadList();
        setSelected(r.sessionId);
      } else void loadDetail(selected);
    }, (e: Error) => setError(e.message));
  }, [selected]);
  const queueCall = (p: Promise<unknown>) => void p.then(() => {
    if (selected) void loadDetail(selected);
  }, (e: Error) => setError(e.message));

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
  // A prose playtest's "Turn into Playtest": sent now, or queued behind a running turn.
  const convert = useMemo(() => (detail && !disconnected
    ? {
        status: detail.status,
        send: (text: string) => {
          setSent((n) => n + 1);
          (busy ? api.queue(detail.id, text) : api.send(detail.id, text)).then(() => loadDetail(detail.id), (e: Error) => setError(e.message));
        },
        create: (name: string, steps: QaScriptStep[]) => api.qaCreateScript(detail.id, name, steps).then(() => loadDetail(detail.id)),
      }
    : null), [detail?.id, detail?.status, disconnected, busy]);
  // The Make playtest pill and Retry: the playtest flow, started when no turn runs.
  const playtest = useMemo(() => (detail && !disconnected
    ? {
        busy,
        run: (request: PlaytestRequest) => {
          setThread(null);
          setSent((n) => n + 1);
          api.playtest(detail.id, request).then(() => loadDetail(detail.id), (e: Error) => setError(e.message));
        },
      }
    : null), [detail?.id, disconnected, busy]);
  // The pills above the composer, from the session's tool-call facts. Escape, a click or a sent message clears the row.
  const [dismissedPills, setDismissedPills] = useState<ReadonlySet<string>>(new Set());
  const pills = useMemo(() => (detail && !disconnected ? pillsFor(detail, dismissedPills) : []), [detail, disconnected, dismissedPills]);
  const clearPills = useCallback(() => setDismissedPills((cur) => new Set([...cur, ...pills.map((p) => p.id)])), [pills]);
  const dialogs = useDialogs(daemon);
  const forms = useForms(daemon, detail?.id ?? null);
  const outside = useOutsideRuns(daemon.events, daemon.streaming);
  const qaLive = useMemo(() => ({ events: daemon.events, streaming: daemon.streaming, forms, sessionId: detail?.id ?? null, onThread: openThreadId }), [daemon.events, daemon.streaming, forms, detail?.id, openThreadId]);
  /** The runs with a card on screen, so their verdict forms are answered there. */
  const qaRuns = useMemo(() => new Set([
    ...(detail?.transcript ?? []).flatMap((t) => (t.kind === "qa" ? [t.run.runId] : [])),
    ...outside.runs.map((r) => r.runId),
  ]), [detail?.transcript, outside.runs]);
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

  // The session's threads: under the composer when wide; in a sheet from the header when narrow,
  // so the composer stays at the bottom of the screen.
  const threads = detail && (
    <Threads
      transcript={detail.transcript}
      thread={openThread ? thread : null}
      onThread={(id) => {
        setSheet(false);
        openThreadId(id);
      }}
      onStop={stopSubagent}
      sessionWaiting={detail.status === "waiting"}
      seen={seen}
      dismissed={dismissed}
      onDismiss={dismiss}
    />
  );

  return (
    <div className="chat" data-pane={chatPane(selected, listed, sessions.length)}>
      <aside className="card sessions">
        <div className="row">
          <h2>Sessions</h2>
          <span className="spacer" />
          <button className="primary" onClick={() => void create()}>New</button>
        </div>
        {!listed && <p className="dim small">{slow ? "Studio is not answering yet. Your sessions are kept and show here when it does." : "Loading sessions"}</p>}
        {listed && sessions.length === 0 && <p className="dim small">No sessions yet.</p>}
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
        {detail && (
          <ChatHeader
            title={detail.title}
            thread={openThread}
            transcript={detail.transcript}
            sessionWaiting={detail.status === "waiting"}
            agents={agentCalls(detail.transcript).length}
            onSessions={() => { setSelected(null); setDetail(null); }}
            onMain={() => setThread(null)}
            onStop={stopSubagent}
            onAgents={narrow ? () => setSheet(true) : undefined}
            onReview={() => setReviewOpen(true)}
          />
        )}
        {detail && !narrow && !openThread && <button className="ghost small-button review-open" onClick={() => setReviewOpen(true)} title="Review and checkpoints">Checkpoints</button>}
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
          <QaContext.Provider value={qaLive}>
          <SessionIdContext.Provider value={detail.id}>
          <AssetLinksContext.Provider value={assetLinks}>
          <AssetTranscriptContext.Provider value={detail.transcript}>
          <EditMessageContext.Provider value={disconnected ? null : editMessage}>
          <PlaytestConvertContext.Provider value={convert}>
          <PlaytestCommandContext.Provider value={playtest}>
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
            <QueuedMessages
              queue={detail.queue ?? []}
              busy={busy}
              onEdit={(qid, text) => queueCall(api.editQueued(detail.id, qid, text))}
              onRemove={(qid) => queueCall(api.removeQueued(detail.id, qid))}
              onSendNext={() => queueCall(api.sendQueued(detail.id))}
            />
            <DialogCards dialogs={(dialogs.state?.dialogs ?? []).filter((d) => d.sessionId === detail.id)} now={dialogs.now()} />
            <Approvals sessionId={detail.id} approvals={detail.approvals ?? []} />
            <OutsideRuns runs={outside.runs} onDismiss={outside.dismiss} />
            <FormCards forms={forms} runs={qaRuns} />
            {settings && disconnected && <div className="composer-connect"><ConnectCard settings={settings} onSettings={setSettings} /></div>}
            {playtest && <PillRow pills={pills} actions={{ playtest: playtest.run }} onClear={clearPills} />}
            <Composer
              draft={draft}
              onDraft={setDraft}
              onBlur={() => selected && void api.saveDraft(selected, draft)}
              placeholder={busy ? "The agent is working. Write the next message to queue it." : openThread ? "Message the main agent" : "Ask for something in the editor, or drop files here"}
              busy={busy}
              canSend={canSend}
              onSend={send}
              onQueue={queue}
              onSendNow={sendNow}
              onStop={() => selected && void api.stop(selected)}
              files={attach.files}
              onAddFiles={attach.add}
              onRemoveFile={attach.remove}
              stage={stage}
              height={settings?.composerHeight ?? null}
              onHeight={(composerHeight) => void api.saveSettings({ composerHeight }).then(setSettings, (e: Error) => setError(e.message))}
              picker={settings && <><ModelPicker settings={settings} onSettings={setSettings} up /><EffortPicker settings={settings} onSettings={setSettings} /></>}
            >
              {!narrow && threads}
            </Composer>
            {narrow && <Sheet open={sheet} title="Subagents" onClose={() => setSheet(false)}>{threads}</Sheet>}
            <Sheet open={reviewOpen} title="Checkpoints" onClose={() => setReviewOpen(false)}>
              {reviewOpen && <ReviewPanel sessionId={detail.id} review={detail.review ?? null} timeline={detail.timeline ?? []} onChanged={() => void loadDetail(detail.id)} />}
            </Sheet>
          </PlaytestCommandContext.Provider>
          </PlaytestConvertContext.Provider>
          </EditMessageContext.Provider>
          </AssetTranscriptContext.Provider>
          </AssetLinksContext.Provider>
          </SessionIdContext.Provider>
          </QaContext.Provider>
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

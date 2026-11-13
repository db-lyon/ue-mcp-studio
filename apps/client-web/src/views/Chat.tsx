import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ACCOUNT_NAME, ACCOUNT_SIGN_IN_GITHUB, REMOTE_SIGN_IN, REMOTE_COMMAND, REMOTE_COMMAND_REPLY, REMOTE_ON_COMPUTER, SLASH_COMMANDS, REMOTE_PLAN_OFFERED, contextView, isLocalCommand, parseSlashCommand, remoteCommand, remoteShown, type ActionRunRequest, type FlowRunRequest, type PlaytestRequest, type SessionDetail, type SessionSummary, type StudioSettings } from "@ue-mcp-studio/shared";
import { api } from "../api";
import { useRemoteAvailable } from "./settings/remote-available";
import { REMOTE_NOW_ON, UpgradeAction } from "./Upgrade";
import { RemoteChatCard } from "./remote/RemoteChatCard";
import type { SettingsSection } from "./settings/sections";
import { ConnectModel, ModelAndEffort, ModelPicker, SignInForm, useCatalog } from "./ModelPicker";
import type { DaemonState } from "../state";
import { subagentsOf } from "@ue-mcp-studio/client-core";
import { useAgentThread } from "../chat/agent-thread";
import { useDismissed, useSeen } from "../chat/hooks";
import { EditMessageContext, MainTranscript, PlaytestCommandContext, SubagentThread, type EditMode } from "../chat/Transcript";
import { QueuedMessages } from "../chat/Queue";
import { WorkingLine } from "../chat/Working";
import { pillsFor } from "../chat/pill-providers";
import { PillRow } from "../chat/Pills";
import { Threads } from "../chat/Threads";
import { ContextMeter, ContextWarning } from "../chat/ContextMeter";
import { CompactContext } from "../chat/Compaction";
import { SessionRow } from "../chat/SessionRow";
import { AgentsGlyph, CheckpointsGlyph, Composer, type BarUtility } from "../chat/Composer";
import type { MentionSearchFn } from "../chat/MentionMenu";
import { Approvals } from "../chat/Approvals";
import { AgentsContext, AskedContext } from "../chat/asked";
import { FormCards, useForms } from "../chat/Forms";
import { FlowLauncher } from "../chat/FlowCommand";
import { ActionLauncher } from "../chat/ActionCommand";
import { OutsideRuns, QaContext, useOutsideRuns } from "../chat/Qa";
import { DialogCards } from "../chat/Dialogs";
import { useDialogs } from "../chat/dialog-model";
import { SessionIdContext, useAttachments } from "../chat/attachments";
import { AssetLinksContext, AssetTranscriptContext, useAssetLinks } from "../chat/asset-links";
import { readLocation, writeLocation } from "../location";
import { useSessionFocus } from "../focus";
import { chatPane } from "../chat/pane";
import { DetailLoader, composerPlaceholder, composerQueues, composerTarget, sessionGone } from "@ue-mcp-studio/client-core";
import { SessionLoading, SessionRowsLoading } from "../chat/Skeleton";
import { ChatHeader } from "../chat/ChatHeader";
import { Sheet } from "../chat/Sheet";
import { ReviewPanel } from "../chat/TurnReview";
import { useSessionRuns } from "../chat/sessionRuns";
import { NARROW, useMedia } from "../layout";
import { Slot } from "../extensions/Slot";

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

/** The project's flows and ue-mcp's actions, for the names /flow and /action complete. One function each, so the menu fetches once per opening. */
const loadFlowNames = () => api.flows().then((r) => r.flows);
const loadActionNames = () => api.actions().then((r) => r.actions);
/** Names for the composer's @-mentions: the project's assets, the open level's actors and the project's files. */
const searchMentions: MentionSearchFn = (request, signal) => api.searchMentions(request, signal);

/** How long the session list may take before the panel says Studio is not answering. */
export const LIST_SLOW_MS = 8000;

export function ChatView({ daemon, nav, active = true, onSettings }: {
  daemon: DaemonState;
  nav?: { session: string | null; n: number };
  /** False while another tab is up: the chat stays mounted but leaves the location alone. */
  active?: boolean;
  /** Open a Settings section, for /remote on a paid plan. */
  onSettings?: (section: SettingsSection) => void;
}) {
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
  /** An action that failed. A session deleted meanwhile is not an error: the list drops it. */
  const fail = (e: Error) => (sessionGone(e) ? undefined : setError(e.message));
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
  /** The transcript area, which gives up height when the composer's divider is dragged up. */
  const stage = useRef<HTMLDivElement>(null);

  // A finished turn is told by notifications (notify.ts), under this device's rules.
  const loadList = () => api.sessions().then((r) => {
    setSessions(r.sessions);
    setListed(true);
    setSlow(false);
    // A session the location names but that is gone (deleted elsewhere) is not opened.
    setSelected((cur) => (cur && !r.sessions.some((x) => x.id === cur) ? null : cur));
  }, fail);
  // Only what changed since the last answer, one request at a time however many events ask.
  const detailLoader = useMemo(() => new DetailLoader(
    (id, have) => api.sessionSync(id, have),
    (d) => {
      setDetail(d);
      setDraft((cur) => (cur ? cur : d.draft));
    },
    (e) => setError(e.message),
    // A session deleted meanwhile closes quietly instead of showing an error.
    { gone: (id) => (setSelected((cur) => (cur === id ? null : cur)), setDetail((d) => (d?.id === id ? null : d))) },
  ), []);
  const loadDetail = (id: string) => detailLoader.load(id);

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
  useEffect(() => {
    if (active) writeLocation({ tab: "Chat", session: selected });
  }, [selected, active]);
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
    // The last session's transcript does not stand in for this one while it loads.
    setDetail((d) => (d && d.id === selected ? d : null));
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
  }).catch(fail);

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
  // /remote and /rc: offered only where remoteSurface says, and answered here, never as a turn.
  const remote = useRemoteAvailable(false);
  // Listed in the menu only where Settings lists remote control; typed, it also answers any signed-in account without a paid plan.
  const remoteListed = remoteShown(remote.surface);
  const remoteAction = remoteCommand(REMOTE_PLAN_OFFERED, remote.available, remote.signedIn ?? true);
  const commands = useMemo(() => (remoteListed ? [...SLASH_COMMANDS, REMOTE_COMMAND] : SLASH_COMMANDS), [remoteListed]);
  /**
   * The session /remote was answered in: the pairing code on a paid plan, the
   * sign-in when signed out, the Upgrade action otherwise. Always in the chat,
   * never by opening Settings; it shows there until the next message.
   */
  const [remoteReply, setRemoteReply] = useState<string | null>(null);
  const runRemoteCommand = (): boolean => {
    if (!selected || !remoteAction || attach.ready.length > 0 || !isLocalCommand(draft, REMOTE_COMMAND)) return false;
    setDraft("");
    void api.saveDraft(selected, "").catch(() => {});
    setRemoteReply(selected);
    return true;
  };
  /** A /flow or /action message being run: its form, above the composer. */
  const [flowAsk, setFlowAsk] = useState<string | null>(null);
  const [actionAsk, setActionAsk] = useState<string | null>(null);
  useEffect(() => {
    setFlowAsk(null);
    setActionAsk(null);
  }, [selected]);
  const send = () => {
    if (runRemoteCommand()) return;
    setRemoteReply(null);
    // A /flow or /action opens its form rather than going out as a message.
    const parsed = selected && canSend && attach.ready.length === 0 ? parseSlashCommand(draft) : null;
    const command = parsed?.name;
    // /compact goes straight to the compaction, never into the conversation.
    if (selected && parsed?.name === "compact") {
      clearPills();
      setDraft("");
      void api.saveDraft(selected, "").catch(() => {});
      compactNow(parsed.args);
      return;
    }
    if (selected && (command === "flow" || command === "action")) {
      (command === "flow" ? setFlowAsk : setActionAsk)(draft.trim());
      clearPills();
      setDraft("");
      void api.saveDraft(selected, "").catch(() => {});
      return;
    }
    if (target.to !== "main") return toThread(false);
    dispatch((id, text, files) => api.send(id, text, files), true);
  };
  /**
   * A message written in a subagent's thread. A running subagent takes it at its next step and the
   * thread stays open, where it shows; a finished one hands it to the main agent, naming the subagent,
   * and the main thread opens for the reply.
   */
  const toThread = (now: boolean) => {
    if (target.to === "main") return;
    if (target.to === "subagent" && attach.ready.length > 0) {
      setError("A subagent takes text only. Remove the files, or send them to the main agent from the main thread.");
      return;
    }
    const callId = target.call.id;
    dispatch((id, text, files) => api.messageSubagent(id, callId, text, files, now), target.to === "finished");
  };
  const runFlow =(request: FlowRunRequest) => {
    if (!selected) return Promise.reject(new Error("Open a session first."));
    const id = selected;
    setThread(null);
    setSent((n) => n + 1);
    return api.flow(id, request).then(() => loadDetail(id));
  };
  const runAction = (request: ActionRunRequest) => {
    if (!selected) return Promise.reject(new Error("Open a session first."));
    const id = selected;
    setThread(null);
    setSent((n) => n + 1);
    return api.action(id, request).then(() => loadDetail(id));
  };
  /** Compact now, from the meter, the warning or /compact. */
  const compactNow = (instructions?: string) => {
    if (!selected) return;
    const id = selected;
    setSent((n) => n + 1);
    api.compact(id, instructions).then(() => loadDetail(id), fail);
  };
  const catalog = useCatalog(settings);
  const nameOf = (id: string): string => {
    for (const p of catalog?.providers ?? []) for (const m of p.models) if (m.id === id) return `${p.name} ${m.name}`;
    return id;
  };
  const listedWindow = settings ? catalog?.providers.find((p) => p.id === settings.provider)?.models.find((m) => m.id === settings.model)?.contextWindow : undefined;
  const mainContext = detail?.context?.main;
  // The daemon's, from the whole transcript; worked out here only for a daemon that sends none.
  const compacting = detail?.compacting ?? !!detail?.transcript.some((t) => t.kind === "compaction" && !t.parent && t.state === "running");
  const runtimeCompacts = settings?.route === "claude";
  const meterView = settings ? contextView(mainContext, settings.model, listedWindow) : null;
  // Dismissed per session, until it reaches the next level.
  const [warnDismissed, setWarnDismissed] = useState<string | null>(null);
  const warnKey = detail && meterView ? `${detail.id}:${meterView.level}` : null;
  const sendNow = () => runRemoteCommand() || (target.to !== "main" ? toThread(true) : dispatch((id, text, files) => api.send(id, text, files, true), true));
  const queue = () => runRemoteCommand() || (target.to !== "main" ? toThread(false) : dispatch((id, text, files) => api.queue(id, text, files), false));
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
    }, fail);
  }, [selected]);
  const queueCall = (p: Promise<unknown>) => void p.then(() => {
    if (selected) void loadDetail(selected);
  }, fail);

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
    if (selected) void api.stopSubagent(selected, id).catch(fail);
  };

  const busy = detail?.status === "running" || detail?.status === "waiting";
  // The calls waiting for approval, so the thread a call waits in says it waits on the user.
  const asked = useMemo(() => new Set((detail?.approvals ?? []).map((a) => a.toolUseId)), [detail?.approvals]);
  // The Make playtest pill and Retry: the playtest flow, started when no turn runs.
  const playtest = useMemo(() => (detail && !disconnected
    ? {
        busy,
        run: (request: PlaytestRequest) => {
          setThread(null);
          setSent((n) => n + 1);
          api.playtest(detail.id, request).then(() => loadDetail(detail.id), fail);
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
  // The session's live playtests, pinned under its header while they run or wait for the user.
  const sessionRuns = useSessionRuns(detail?.id ?? null, detail?.transcript, daemon.events, detail?.liveRuns);
  const qaLive = useMemo(() => ({ events: daemon.events, streaming: daemon.streaming, forms, sessionId: detail?.id ?? null, onThread: openThreadId }), [daemon.events, daemon.streaming, forms, detail?.id, openThreadId]);
  /** The runs with a card on screen, so their verdict forms are answered there. */
  const qaRuns = useMemo(() => new Set([
    ...(detail?.transcript ?? []).flatMap((t) => (t.kind === "qa" ? [t.run.runId] : [])),
    ...outside.runs.map((r) => r.runId),
    ...sessionRuns.runs.map((r) => r.runId),
  ]), [detail?.transcript, outside.runs, sessionRuns.runs]);
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
  // The session's subagents as the daemon worked them out from the whole transcript: the one source of their state.
  const agents = useMemo(() => (detail ? subagentsOf(detail) : []), [detail]);
  const agentMap = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const openThread = (thread && agentMap.get(thread)) || null;
  // Who a message written now goes to: the open subagent while it runs, else the main agent.
  const target = composerTarget(openThread?.call);
  const drawerAgent = (drawerId && agentMap.get(drawerId)) || null;
  // The open thread, read by its id: its own entries, whatever part of the session is held.
  const drawerThread = useAgentThread(api.agentThread, detail?.id ?? null, drawerAgent ? drawerAgent.id : null, detail, detail?.transcript ?? []);
  // The bar's utilities after the context meter, at every width: Checkpoints, and the subagents while there are some.
  const utilities: BarUtility[] = [
    { id: "checkpoints", icon: <CheckpointsGlyph />, onClick: () => setReviewOpen(true) },
    ...(agents.length > 0 ? [{ id: "subagents" as const, icon: <AgentsGlyph />, count: agents.length, onClick: () => setSheet(true) }] : []),
  ];

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

  // The session's threads: under the composer when wide, and at every width in a sheet from the bar's Subagents button.
  const threads = detail && (
    <Threads
      agents={agents}
      thread={openThread ? thread : null}
      onThread={(id) => {
        setSheet(false);
        openThreadId(id);
      }}
      onStop={stopSubagent}
      seen={seen}
      dismissed={dismissed}
      onDismiss={dismiss}
      tokens={detail.tokens}
      context={detail.context}
    />
  );

  return (
    <AskedContext.Provider value={asked}>
    <AgentsContext.Provider value={agentMap}>
    <div className="chat" data-pane={chatPane(selected, listed, sessions.length)}>
      <aside className="card sessions">
        <div className="row">
          <h2>Sessions</h2>
          <span className="spacer" />
          <button className="primary" onClick={() => void create()}>New</button>
        </div>
        {!listed && (slow
          ? <p className="dim small">Studio is not answering yet. Your sessions are kept and show here when it does.</p>
          : <SessionRowsLoading />)}
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
            onSessions={() => { setSelected(null); setDetail(null); }}
            onMain={() => setThread(null)}
            onStop={stopSubagent}
          />
        )}
        {error && <div className="banner bad" onClick={() => setError(null)}>{error}</div>}
        {!detail && selected && <SessionLoading />}
        {!detail && !selected && (
          <div className="empty">
            <h1 className="display"><em>Start</em> a session.</h1>
            <p className="muted">The agent works in this project through ue-mcp: Blueprints, materials, levels, Niagara and more. It can also run commands, read and edit the project's files, and read the web. Approvals in Settings set what it asks you first.</p>
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
          <PlaytestCommandContext.Provider value={playtest}>
          <CompactContext.Provider value={disconnected ? null : () => compactNow()}>
            <div className="session-stage">
            <div className="thread-stage" ref={stage}>
              <MainTranscript
                transcript={detail.transcript}
                status={detail.status}
                streaming={streaming}
                waitingCause={detail.waitingCause}
                error={detail.error}
                onOpen={openThreadId}
                onStop={stopSubagent}
                hidden={drawerOpen}
                sent={sent}
              />
              {drawerAgent && (
                <div className={`thread-drawer ${drawerOpen ? "open" : ""}`}>
                  <SubagentThread
                    agent={drawerAgent}
                    entries={drawerThread.entries}
                    more={drawerThread.more}
                    onBack={() => setThread(null)}
                    onStop={stopSubagent}
                  />
                </div>
              )}
            </div>
            </div>
            <Slot
              key={detail.id}
              name="session.panel"
              ctx={{ sessionId: detail.id, status: detail.status }}
              wrap={(item, host) => (
                <details className="ext-panel" open>
                  <summary>{item.contribution.title ?? item.contribution.id}</summary>
                  {host}
                </details>
              )}
            />
            <QueuedMessages
              queue={detail.queue ?? []}
              busy={busy}
              onEdit={(qid, text) => queueCall(api.editQueued(detail.id, qid, text))}
              onRemove={(qid) => queueCall(api.removeQueued(detail.id, qid))}
              onSendNext={() => queueCall(api.sendQueued(detail.id))}
              onSendNow={(qid) => queueCall(api.sendQueuedNow(detail.id, qid))}
            />
            <DialogCards dialogs={(dialogs.state?.dialogs ?? []).filter((d) => d.sessionId === detail.id)} now={dialogs.now()} />
            <Approvals sessionId={detail.id} approvals={detail.approvals ?? []} />
            <OutsideRuns runs={outside.runs} onDismiss={outside.dismiss} />
            <FormCards forms={forms} runs={qaRuns} />
            {remoteReply === detail.id && (
              <div className="msg assistant local-reply" role="status">
                <p>{remote.paired ? REMOTE_ON_COMPUTER : remote.available ? REMOTE_NOW_ON : remote.signedIn === false ? REMOTE_SIGN_IN : REMOTE_COMMAND_REPLY}</p>
                <button className="icon-button reply-close" aria-label="Dismiss" title="Dismiss" onClick={() => setRemoteReply(null)}>{"×"}</button>
                {remote.paired ? null : remote.available ? (
                  <RemoteChatCard onSettings={onSettings && (() => { setRemoteReply(null); onSettings("remote"); })} />
                ) : remote.signedIn === false ? (
                  <div className="remote-chat-card">
                    <SignInForm id="studio" name={ACCOUNT_NAME} about={ACCOUNT_SIGN_IN_GITHUB} onDone={remote.recheck} />
                  </div>
                ) : (
                  <UpgradeAction />
                )}
              </div>
            )}
            {flowAsk && !busy && <FlowLauncher key={flowAsk} text={flowAsk} run={runFlow} onClose={() => setFlowAsk(null)} />}
            {actionAsk && !busy && <ActionLauncher key={actionAsk} text={actionAsk} run={runAction} onClose={() => setActionAsk(null)} />}
            {settings && disconnected && <div className="composer-connect"><ConnectCard settings={settings} onSettings={setSettings} /></div>}
            {meterView && meterView.level === "high" && !compacting && warnKey !== warnDismissed && (
              <ContextWarning view={meterView} runtime={runtimeCompacts} busy={busy} onCompact={() => compactNow()} onDismiss={() => setWarnDismissed(warnKey)} />
            )}
            {playtest && <PillRow pills={pills} actions={{ playtest: playtest.run }} onClear={clearPills} />}
            <WorkingLine detail={detail} />
            <Composer
              draft={draft}
              onDraft={setDraft}
              onBlur={() => selected && void api.saveDraft(selected, draft)}
              placeholder={composerPlaceholder(detail, target)}
              busy={composerQueues(detail, target)}
              canSend={canSend}
              onSend={send}
              commands={commands}
              flows={loadFlowNames}
              actions={loadActionNames}
              mentions={searchMentions}
              onQueue={queue}
              onSendNow={sendNow}
              onStop={() => selected && void api.stop(selected)}
              files={attach.files}
              onAddFiles={attach.add}
              onRemoveFile={attach.remove}
              extras={<Slot name="composer.action" ctx={{ sessionId: detail.id, draft, setDraft, busy, addFiles: attach.add }} />}
              stage={stage}
              height={settings?.composerHeight ?? null}
              onHeight={(composerHeight) => void api.saveSettings({ composerHeight }).then(setSettings, fail)}
              picker={<>
                {settings && <ModelAndEffort settings={settings} onSettings={setSettings} />}
                {settings && (
                  <ContextMeter
                    context={mainContext}
                    totals={detail.totals}
                    model={settings.model}
                    modelName={nameOf(settings.model)}
                    nameOf={nameOf}
                    listedWindow={listedWindow}
                    busy={busy}
                    compacting={compacting}
                    runtime={runtimeCompacts}
                    onCompact={() => compactNow()}
                    owner={openThread ? "Main" : undefined}
                  />
                )}
              </>}
              utilities={utilities}
            >
              {!narrow && threads}
            </Composer>
            <Sheet open={sheet} title="Subagents" onClose={() => setSheet(false)}>{(narrow || sheet) && threads}</Sheet>
            <Sheet open={reviewOpen} title="Checkpoints" onClose={() => setReviewOpen(false)}>
              {reviewOpen && <ReviewPanel sessionId={detail.id} review={detail.review ?? null} timeline={detail.timeline ?? []} onChanged={() => void loadDetail(detail.id)} />}
            </Sheet>
          </CompactContext.Provider>
          </PlaytestCommandContext.Provider>
          </EditMessageContext.Provider>
          </AssetTranscriptContext.Provider>
          </AssetLinksContext.Provider>
          </SessionIdContext.Provider>
          </QaContext.Provider>
        )}
      </section>
    </div>
    </AgentsContext.Provider>
    </AskedContext.Provider>
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

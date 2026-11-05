/**
 * The Chat tab as a paired phone draws it: the session list, or one open
 * session with its header, conversation, queue, cards, the context warning and
 * the composer; the subagents and the checkpoints in sheets. The open
 * session follows the daemon's events through client-core's DetailLoader,
 * asking only for what changed.
 */
import { useBack } from "../back";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, AppState, Pressable, RefreshControl, ScrollView, useWindowDimensions, View } from "react-native";
import { SLASH_COMMANDS, contextView, parseSlashCommand, type ActionRunRequest, type FlowRunRequest, type PlaytestRequest, type SessionDetail, type SessionSummary, type StudioSettings } from "@ue-mcp-studio/shared";
import { DetailLoader, agentCalls, chatPane, unreachable } from "@ue-mcp-studio/client-core";
import { useProjectNav } from "../nav";
import { haptic } from "../native/haptics";
import { KeyboardAvoidingView } from "../native/keyboard";
import { useSharedFiles } from "../native/share";
import { publishRecentSessions } from "../native/shortcuts";
import { Banner, Button, font, labelFont, T, useAvoidedInsets, useSheetInsets, useTheme, type Theme } from "../ui";
import { ConnectModel, ModelAndEffort, ModelPicker, useCatalog } from "./ModelPicker";
import { useDaemonState, useDismissed, useSeen } from "../chat/hooks";
import { EditMessageContext, MainTranscript, PlaytestCommandContext, SubagentThread, type EditMode } from "../chat/Transcript";
import { QueuedMessages } from "../chat/Queue";
import { pillsFor } from "../chat/pill-providers";
import { PillRow } from "../chat/Pills";
import { Threads } from "../chat/Threads";
import { ContextMeter, ContextWarning } from "../chat/ContextMeter";
import { CompactContext } from "../screens/chat/items";
import { SessionRow } from "../chat/SessionRow";
import { Composer } from "../chat/Composer";
import { RemoteReply, useRemoteCommand } from "../screens/chat/composer/RemoteReply";
import type { MentionSearchFn } from "../chat/MentionMenu";
import { Approvals } from "../screens/chat/items";
import { AskedContext } from "../chat/asked";
import { FormCards, useForms } from "../screens/chat/items";
import { FlowLauncher } from "../chat/FlowCommand";
import { ActionLauncher } from "../chat/ActionCommand";
import { OutsideRuns, QaContext, useOutsideRuns } from "../chat/Qa";
import { DialogCards } from "../screens/chat/items";
import { useDialogs } from "../chat/dialog-model";
import { SessionIdContext, useAttachments } from "../chat/attachments";
import { AssetLinksContext, AssetTranscriptContext, useAssetLinks } from "../chat/asset-links";
import { SessionLoading, SessionRowsLoading } from "../chat/Skeleton";
import { ChatHeader } from "../chat/ChatHeader";
import { Sheet } from "../chat/Sheet";
import { ReviewPanel } from "../screens/chat/items";
import { useSessionRuns } from "../chat/sessionRuns";
import { buttonText, small } from "../chat/styles";

/** How long a subagent thread takes to slide in or out; matches .thread-drawer's transition. */
export const DRAWER_MS = 260;

/** Starting points shown on an empty session. Each is a single task the agent can finish through ue-mcp. */
export const EXAMPLES = [
  "Make a glowing orange material and put it on a sphere in the level",
  "Build a Niagara fire at the player start",
  "List every Blueprint that has no references",
];

/** How long the session list may take before the chat says Studio is not answering. */
export const LIST_SLOW_MS = 8000;
/** A read that failed while ue-mcp was away is tried again after this, times the failures so far, up to RETRY_MAX_MS. */
export const RETRY_MS = 2000;
export const RETRY_MAX_MS = 10_000;
/** An action that failed because ue-mcp could not be reached. */
export const NOT_ANSWERING = "ue-mcp on your computer is not answering. Try again once it reconnects.";

/** Events that change a session, keyed by the session they name. */
function sessionOf(data: Record<string, unknown>): string | null {
  return typeof data.sessionId === "string" ? data.sessionId : null;
}

/** What another app shared, in words, for the banner that asks for a session. */
function sharedNoun(files: Array<{ mimeType: string }>): string {
  if (files.length === 0) return "shared text";
  if (files.length > 1) return "shared files";
  return files[0].mimeType.startsWith("image/") ? "shared image" : "shared file";
}

export function Chat({ nav, initialSession = null, onSettings, active = true }: {
  /** The shell asked for a session, or for the list (null); `n` counts the asks. */
  nav?: { session: string | null; n: number };
  /** The Chat tab is the one shown (the web client's prop; the shell parks the chat while another tab is up). */
  active?: boolean;
  /** The session to open first: a deep link or a shortcut. */
  initialSession?: string | null;
  /** Open a Settings section. */
  onSettings?: (section: string) => void;
}) {
  const t = useTheme();
  const listInsets = useSheetInsets();
  const { project, api } = useProjectNav();
  const daemon = useDaemonState(project);
  const shared = useSharedFiles();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  /** Whether the list has come back once: until then an empty list is not "no sessions". */
  const [listed, setListed] = useState(false);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (listed) return;
    const tm = setTimeout(() => setSlow(true), LIST_SLOW_MS);
    return () => clearTimeout(tm);
  }, [listed]);
  const [selected, setSelected] = useState<string | null>(initialSession);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** The open session could not be read, for a reason other than ue-mcp being away: said where its transcript goes. */
  const [detailError, setDetailError] = useState<string | null>(null);
  /** Reads that failed because ue-mcp was away, counted: each schedules the next try. Zero once one succeeds. */
  const [missed, setMissed] = useState(0);
  /** A pull to refresh running. */
  const [pulling, setPulling] = useState(false);
  /** An action that failed: ue-mcp being away is said plainly, never as the relay's own words. */
  const fail = useCallback((e: Error) => setError(unreachable(e) ? NOT_ANSWERING : e.message), []);
  const streamed = useRef("");
  const [streaming, setStreaming] = useState("");
  const [settings, setSettings] = useState<StudioSettings | null>(null);
  /** The subagent thread on screen, by its agent call id; null is the main thread. */
  const [thread, setThread] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  /** The thread the drawer shows, kept while it slides out, and whether it is in. */
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const slide = useRef(new Animated.Value(0)).current;
  const { width } = useWindowDimensions();
  const markSeenApi = useCallback((id: string, threadId: string) => api.markSeen(id, threadId), [api]);
  const dismissApi = useCallback((id: string, ids: string[]) => api.dismissAgents(id, ids), [api]);
  const { seen, markSeen } = useSeen(selected, detail?.seen, markSeenApi);
  const { dismissed, dismiss } = useDismissed(selected, detail?.dismissed, dismissApi);
  const attach = useAttachments(selected);

  const loadList = useCallback(
    () =>
      api.sessions().then(
        (r) => {
          setSessions(r.sessions);
          setListed(true);
          setSlow(false);
          publishRecentSessions(project.device.id, r.sessions);
          // A session the location names but that is gone (deleted elsewhere) is not opened.
          setSelected((cur) => (cur && !r.sessions.some((x) => x.id === cur) ? null : cur));
          setMissed(0);
        },
        // ue-mcp away: the connection line says so, and the list is read again when it answers.
        (e: Error) => (unreachable(e) ? setMissed((n) => n + 1) : setError(e.message)),
      ),
    [api, project.device.id],
  );
  // Only what changed since the last answer, one request at a time however many events ask.
  const detailLoader = useMemo(
    () =>
      new DetailLoader(
        (id, have) => api.sessionSync(id, have),
        (d) => {
          setDetail(d);
          setDetailError(null);
          setMissed(0);
          setDraft((cur) => (cur ? cur : d.draft));
        },
        (e) => (unreachable(e) ? setMissed((n) => n + 1) : setDetailError(e.message)),
      ),
    [api],
  );
  const loadDetail = useCallback((id: string) => detailLoader.load(id), [detailLoader]);

  // The shell asked for a session, or for the list (null).
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

  const loadSettings = useCallback(() => api.settings().then(setSettings, () => setSettings(null)), [api]);
  useEffect(() => {
    void loadList();
    void loadSettings();
  }, [loadList, loadSettings]);
  // Everything on screen read again: after ue-mcp was away, on return to the foreground, on a pull.
  const selectedNow = useRef(selected);
  selectedNow.current = selected;
  const refresh = useCallback(() => {
    const id = selectedNow.current;
    return Promise.all([loadList(), loadSettings(), id ? loadDetail(id) : undefined]).then(() => undefined);
  }, [loadList, loadSettings, loadDetail]);
  // A read that failed while ue-mcp was away is tried again on its own, sooner at first.
  useEffect(() => {
    if (missed === 0) return;
    const tm = setTimeout(() => void refresh(), Math.min(RETRY_MAX_MS, RETRY_MS * missed));
    return () => clearTimeout(tm);
  }, [missed, refresh]);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => state === "active" && void refresh());
    return () => sub.remove();
  }, [refresh]);
  const pull = () => {
    setPulling(true);
    project.reconnect?.();
    void refresh().finally(() => setPulling(false));
  };
  // The stream came back: what changed while it was down is read again.
  useEffect(() => {
    if (project.live !== "live") return;
    void loadList();
    if (selected) void loadDetail(selected);
  }, [project.live]);

  // Nothing connected runs the selected model yet.
  const disconnected = settings !== null && settings.route === null;

  useEffect(() => {
    if (!selected) return;
    // The last session's transcript does not stand in for this one while it loads.
    setDetail((d) => (d && d.id === selected ? d : null));
    setDetailError(null);
    // Another session opens on its main thread, with no drawer sliding out over it.
    setThread(null);
    setDrawerId(null);
    slide.setValue(0);
    setDraft("");
    streamed.current = "";
    setStreaming("");
    void loadDetail(selected);
  }, [selected]);

  // Follow the event stream: refetch on any change to the open session, collect streamed text.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  useEffect(
    () =>
      project.onEvent((e) => {
        if (!e.type.startsWith("studio.") && e.type !== "gap") return;
        const cur = selectedRef.current;
        if (e.type === "studio.session.changed" || e.type === "gap") void loadList();
        if (e.type === "studio.settings.changed") void loadSettings();
        if (e.type === "gap" && cur) return void loadDetail(cur);
        if (!cur || sessionOf(e.data) !== cur) return;
        if (e.type === "studio.turn.delta") {
          streamed.current += String(e.data.text ?? "");
          setStreaming(streamed.current);
          return;
        }
        if (e.type === "studio.transcript.added") {
          streamed.current = "";
          setStreaming("");
        }
        void loadDetail(cur);
      }),
    [project, loadList, loadSettings, loadDetail],
  );

  // An example prompt lands as the new session's saved draft, so it is in the composer when the session opens.
  const create = (prompt?: string) =>
    api
      .newSession()
      .then(async (d) => {
        if (prompt) await api.saveDraft(d.id, prompt);
        void loadList();
        setSelected(d.id);
      })
      .catch(fail);

  // Files or text another app shared: into the open session's message, or a banner until one is picked.
  const pendingShare = shared.files.length > 0 || !!shared.text;
  useEffect(() => {
    if (!pendingShare || !detail) return;
    if (shared.files.length) attach.add(shared.files.map((f) => ({ uri: f.uri, name: f.name, type: f.mimeType, size: 0 })));
    if (shared.text) setDraft((cur) => (cur ? `${cur}\n${shared.text}` : shared.text!));
    shared.consume();
  }, [pendingShare, detail?.id]);

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
    haptic.tap();
    void api.saveDraft(selected, "").catch(() => {});
    if (follow) {
      setThread(null);
      setSent((n) => n + 1);
    }
    how(selected, text, files).then(
      () => loadDetail(selected),
      (e: Error) => {
        setDraft(text);
        fail(e);
      },
    );
  };
  /** A /flow or /action message being run: its form, above the composer. */
  const [flowAsk, setFlowAsk] = useState<string | null>(null);
  const [actionAsk, setActionAsk] = useState<string | null>(null);
  useEffect(() => {
    setFlowAsk(null);
    setActionAsk(null);
  }, [selected]);
  // /remote and /rc: offered only where remoteSurface says, and answered here, never as a turn.
  const remoteCmd = useRemoteCommand({ sessionId: selected, draft, setDraft, readyFiles: attach.ready.length, saveDraft: (id, text) => api.saveDraft(id, text) });
  const send = () => {
    if (remoteCmd.runRemoteCommand()) return;
    remoteCmd.dismiss();
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
    dispatch((id, text, files) => api.send(id, text, files), true);
  };
  const runFlow = (request: FlowRunRequest) => {
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
  const compacting = !!detail?.transcript.some((x) => x.kind === "compaction" && !x.parent && x.state === "running");
  const runtimeCompacts = settings?.route === "claude";
  const meterView = settings ? contextView(mainContext, settings.model, listedWindow) : null;
  // Dismissed per session, until it reaches the next level.
  const [warnDismissed, setWarnDismissed] = useState<string | null>(null);
  const warnKey = detail && meterView ? `${detail.id}:${meterView.level}` : null;
  const sendNow = () => remoteCmd.runRemoteCommand() || dispatch((id, text, files) => api.send(id, text, files, true), true);
  const queue = () => remoteCmd.runRemoteCommand() || dispatch((id, text, files) => api.queue(id, text, files), false);
  const editMessage = useCallback(
    (index: number, text: string, mode: EditMode) => {
      if (!selected) return;
      setThread(null);
      setSent((n) => n + 1);
      api.editMessage(selected, index, text, mode).then(
        (r) => {
          // A fork is a new session: the chat moves to it, and the list shows it.
          if (mode === "fork" && r?.sessionId) {
            void loadList();
            setSelected(r.sessionId);
          } else void loadDetail(selected);
        },
        fail,
      );
    },
    [selected, api, loadList, loadDetail],
  );
  const queueCall = (p: Promise<unknown>) =>
    void p.then(
      () => {
        if (selected) void loadDetail(selected);
      },
      fail,
    );

  // Stable, so the memoized transcript does not render again on every keystroke.
  const openThreadId = useCallback(
    (id: string | null) => {
      setThread(id);
      if (id) markSeen(id);
    },
    [markSeen],
  );
  const stopSubagent = (id: string) => {
    if (selected) void api.stopSubagent(selected, id).catch(fail);
  };

  const busy = detail?.status === "running" || detail?.status === "waiting";
  // The calls waiting for approval, so the thread a call waits in says it waits on the user.
  const asked = useMemo(() => new Set((detail?.approvals ?? []).map((a) => a.toolUseId)), [detail?.approvals]);
  // Retry on a failed playtest: the playtest flow, started when no turn runs.
  const playtest = useMemo(
    () =>
      detail && !disconnected
        ? {
            busy,
            run: (request: PlaytestRequest) => {
              setThread(null);
              setSent((n) => n + 1);
              api.playtest(detail.id, request).then(() => loadDetail(detail.id), fail);
            },
          }
        : null,
    [detail?.id, disconnected, busy],
  );
  // The pills above the composer, from the session's tool-call facts. A sent message clears the row.
  const [dismissedPills, setDismissedPills] = useState<ReadonlySet<string>>(new Set());
  const pills = useMemo(() => (detail && !disconnected ? pillsFor(detail, dismissedPills) : []), [detail, disconnected, dismissedPills]);
  const clearPills = useCallback(() => setDismissedPills((cur) => new Set([...cur, ...pills.map((p) => p.id)])), [pills]);
  const dialogs = useDialogs();
  const forms = useForms(daemon, detail?.id ?? null);
  const outside = useOutsideRuns(daemon.events, daemon.streaming);
  // The session's live playtests, pinned under its header while they run or wait for the user.
  const sessionRuns = useSessionRuns(detail?.id ?? null, detail?.transcript, daemon.events);
  const qaLive = useMemo(() => ({ events: daemon.events, streaming: daemon.streaming, forms, sessionId: detail?.id ?? null, onThread: openThreadId }), [daemon.events, daemon.streaming, forms, detail?.id, openThreadId]);
  /** The runs with a card on screen, so their verdict forms are answered there. */
  const qaRuns = useMemo(
    () => new Set([...(detail?.transcript ?? []).flatMap((x) => (x.kind === "qa" ? [x.run.runId] : [])), ...outside.runs.map((r) => r.runId), ...sessionRuns.runs.map((r) => r.runId)]),
    [detail?.transcript, outside.runs, sessionRuns.runs],
  );
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
      Animated.timing(slide, { toValue: 1, duration: DRAWER_MS, useNativeDriver: true }).start();
      return;
    }
    Animated.timing(slide, { toValue: 0, duration: DRAWER_MS, useNativeDriver: true }).start(({ finished }) => finished && setDrawerId(null));
  }, [thread]);

  // The session's threads, in a sheet from the header, so the composer stays at the bottom of the screen.
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
      tokens={detail.tokens}
      context={detail.context}
    />
  );
  const pane = chatPane(selected, listed, sessions.length);
  // Back: a subagent thread to the main thread, a session to the sessions list (the root).
  useBack(
    active && (thread || selected)
      ? () => {
          if (thread) return setThread(null);
          setSelected(null);
          setDetail(null);
        }
      : null,
  );
  const bannerBox = { marginTop: 10, marginHorizontal: 10, marginBottom: 0 };

  if (pane === "list") {
    return (
      <AskedContext.Provider value={asked}>
        {/* The list's end scrolls clear of the navigation bar, or of the keyboard while a rename has it up. */}
        <ScrollView
          testID="sessions"
          refreshControl={<RefreshControl refreshing={pulling} onRefresh={pull} tintColor={t.c.accent} colors={[t.c.accent]} progressBackgroundColor={t.c.panel2} />}
          style={{ flex: 1, backgroundColor: t.c.panel }}
          contentContainerStyle={{ paddingTop: 10, paddingBottom: 10 + listInsets.bottom, paddingHorizontal: 12 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginVertical: 6 }}>
            <T accessibilityRole="header" style={labelFont(t)}>Sessions</T>
            <View style={{ flex: 1 }} />
            <Button title="New" variant="primary" onPress={() => void create()} />
          </View>
          {pendingShare ? (
            // A request, not a warning: the accent wash, what to do, and a way to drop what was shared.
            <View accessibilityRole="text" accessibilityLiveRegion="polite" style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 4, paddingLeft: 12, paddingRight: 4, marginBottom: 10, borderRadius: 8, borderWidth: 1, borderColor: t.c.accentLine, backgroundColor: t.c.accentWash }}>
              <View style={{ flex: 1, minWidth: 0, paddingVertical: 5 }}>
                <T style={{ ...font(t, "sans", 600, t.base.size), lineHeight: t.base.lineHeight, color: t.c.text }}>{`Pick a session for the ${sharedNoun(shared.files)}`}</T>
                <T style={{ ...font(t, "sans", 400, 12), lineHeight: 12 * (t.base.lineHeight / t.base.size), color: t.c.muted }}>
                  It goes into that session's message box. <T style={{ ...font(t, "sans", 600, 12), color: t.c.text }}>New</T> starts a session for it.
                </T>
              </View>
              <Button title="Discard" variant="ghost" label={`Discard the ${sharedNoun(shared.files)}`} onPress={() => shared.consume()} />
            </View>
          ) : null}
          {error ? (
            <Pressable accessibilityRole="button" accessibilityLabel={error} onPress={() => setError(null)}>
              <Banner kind="bad" role="alert">{error}</Banner>
            </Pressable>
          ) : null}
          {!listed ? slow ? <T style={[small(t), { color: t.c.dim, marginVertical: 12 }]}>Studio is not answering yet. Your sessions are kept and show here when it does.</T> : <SessionRowsLoading /> : null}
          {live.map((s) => (
            <SessionRow key={s.id} s={s} selected={s.id === selected} onOpen={() => setSelected(s.id)} onChanged={changed} />
          ))}
          {archived.length > 0 ? (
            <>
              <Pressable accessibilityRole="button" accessibilityState={{ expanded: showArchived }} accessibilityLabel={`Archived (${archived.length})`} onPress={() => setShowArchived(!showArchived)} style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 44, marginTop: 8, marginHorizontal: -6, marginBottom: 2, paddingVertical: 4, paddingHorizontal: 8, borderRadius: t.radius, backgroundColor: pressed ? t.c.panel2 : "transparent" })}>
                <T style={[buttonText(t), { fontSize: 12, width: 10, color: t.c.dim }]}>{showArchived ? "▾" : "▸"}</T>
                <T style={[buttonText(t), { fontSize: 12, color: t.c.dim }]}>{`Archived (${archived.length})`}</T>
              </Pressable>
              {showArchived ? archived.map((s) => <SessionRow key={s.id} s={s} selected={s.id === selected} onOpen={() => setSelected(s.id)} onChanged={changed} />) : null}
            </>
          ) : null}
        </ScrollView>
      </AskedContext.Provider>
    );
  }

  return (
    <AskedContext.Provider value={asked}>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: t.c.panel }}>
        {detail ? (
          <ChatHeader
            title={detail.title}
            thread={openThread}
            transcript={detail.transcript}
            sessionWaiting={detail.status === "waiting"}
            agents={agentCalls(detail.transcript).length}
            onSessions={() => {
              setSelected(null);
              setDetail(null);
            }}
            onMain={() => setThread(null)}
            onStop={stopSubagent}
            onAgents={() => setSheet(true)}
            onReview={() => setReviewOpen(true)}
          />
        ) : null}
        {error ? (
          <Pressable accessibilityRole="button" accessibilityLabel={error} onPress={() => setError(null)}>
            <Banner kind="bad" role="alert" style={bannerBox}>{error}</Banner>
          </Pressable>
        ) : null}
        {!detail && selected ? (
          detailError ? (
            <View accessibilityRole="alert" style={{ flex: 1, padding: 14, gap: 10 }}>
              <Banner kind="bad">{`This session could not be loaded: ${detailError}`}</Banner>
              <Button title="Try again" label="Load the session again" style={{ alignSelf: "flex-start" }} onPress={() => (setDetailError(null), void loadDetail(selected))} />
            </View>
          ) : (
            <SessionLoading />
          )
        ) : null}
        {!detail && !selected ? <Empty settings={settings} onSettings={setSettings} onCreate={(x) => void create(x)} /> : null}
        {detail ? (
          <QaContext.Provider value={qaLive}>
            <SessionIdContext.Provider value={detail.id}>
              <AssetLinksContext.Provider value={assetLinks}>
                <AssetTranscriptContext.Provider value={detail.transcript}>
                  <EditMessageContext.Provider value={disconnected ? null : editMessage}>
                    <PlaytestCommandContext.Provider value={playtest}>
                      <CompactContext.Provider value={disconnected ? null : () => compactNow()}>
                        <View style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
                          <MainTranscript transcript={detail.transcript} status={detail.status} streaming={streaming} waitingCause={detail.waitingCause} error={detail.error} onOpen={openThreadId} hidden={!!drawerId} sent={sent} refreshing={pulling} onRefresh={pull} />
                          {drawerCall ? (
                            <Animated.View
                              style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: t.c.panel, borderLeftWidth: 1, borderLeftColor: t.c.line, shadowColor: "#000", shadowOpacity: 0.28, shadowRadius: 16, shadowOffset: { width: -16, height: 0 }, transform: [{ translateX: slide.interpolate({ inputRange: [0, 1], outputRange: [width, 0] }) }] }}
                            >
                              <SubagentThread call={drawerCall} transcript={detail.transcript} sessionWaiting={detail.status === "waiting"} onBack={() => setThread(null)} onStop={stopSubagent} />
                            </Animated.View>
                          ) : null}
                        </View>
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
                        {remoteCmd.reply === detail.id ? (
                          <RemoteReply remote={remoteCmd.remote} onDismiss={remoteCmd.dismiss} onSettings={onSettings && (() => { remoteCmd.dismiss(); onSettings("remote"); })} />
                        ) : null}
                        {flowAsk && !busy ? <FlowLauncher key={flowAsk} text={flowAsk} run={runFlow} onClose={() => setFlowAsk(null)} /> : null}
                        {actionAsk && !busy ? <ActionLauncher key={actionAsk} text={actionAsk} run={runAction} onClose={() => setActionAsk(null)} /> : null}
                        {settings && disconnected ? (
                          <View style={{ paddingTop: 12, paddingHorizontal: 16, alignItems: "center" }}>
                            <ConnectCard settings={settings} onSettings={setSettings} />
                          </View>
                        ) : null}
                        {meterView && meterView.level === "high" && !compacting && warnKey !== warnDismissed ? (
                          <ContextWarning view={meterView} runtime={runtimeCompacts} busy={busy} onCompact={() => compactNow()} onDismiss={() => setWarnDismissed(warnKey)} />
                        ) : null}
                        {playtest ? <PillRow pills={pills} actions={{ playtest: playtest.run }} onClear={clearPills} /> : null}
                        <Composer
                          draft={draft}
                          onDraft={setDraft}
                          onBlur={() => selected && void api.saveDraft(selected, draft).catch(() => {})}
                          placeholder={busy ? "The agent is working. Write the next message to queue it." : openThread ? "Message the main agent" : "Ask for something in the editor, or drop files here"}
                          busy={busy}
                          canSend={canSend}
                          onSend={send}
                          commands={remoteCmd.commands}
                          flows={loadFlowNames(api)}
                          actions={loadActionNames(api)}
                          mentions={searchMentions(api)}
                          onQueue={queue}
                          onSendNow={sendNow}
                          onStop={() => {
                            haptic.warning();
                            if (selected) void api.stop(selected).catch(fail);
                          }}
                          files={attach.files}
                          onAddFiles={attach.add}
                          onRemoveFile={attach.remove}
                          height={settings?.composerHeight ?? null}
                          onHeight={(composerHeight) => void api.saveSettings({ composerHeight }).then(setSettings, fail)}
                          picker={
                            <>
                              {settings ? <ModelAndEffort settings={settings} onSettings={setSettings} /> : null}
                              {settings ? (
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
                              ) : null}
                            </>
                          }
                        />
                        <Sheet open={sheet} title="Subagents" onClose={() => setSheet(false)}>
                          {threads}
                        </Sheet>
                        <Sheet open={reviewOpen} title="Checkpoints" onClose={() => setReviewOpen(false)}>
                          {reviewOpen ? <ReviewPanel sessionId={detail.id} review={detail.review ?? null} timeline={detail.timeline ?? []} onChanged={() => void loadDetail(detail.id)} /> : null}
                        </Sheet>
                      </CompactContext.Provider>
                    </PlaytestCommandContext.Provider>
                  </EditMessageContext.Provider>
                </AssetTranscriptContext.Provider>
              </AssetLinksContext.Provider>
            </SessionIdContext.Provider>
          </QaContext.Provider>
        ) : null}
      </KeyboardAvoidingView>
    </AskedContext.Provider>
  );
}

/** The web client's name for the same view. */
export const ChatView = Chat;

/** The project's flows and ue-mcp's actions, for the names /flow and /action complete; one function per api, so the menu fetches once per opening. */
const memo = <T,>(f: (api: ReturnType<typeof useProjectNav>["api"]) => T) => {
  const cache = new WeakMap<object, T>();
  return (api: ReturnType<typeof useProjectNav>["api"]): T => {
    if (!cache.has(api)) cache.set(api, f(api));
    return cache.get(api)!;
  };
};
const loadFlowNames = memo((api) => () => api.flows().then((r) => r.flows));
const loadActionNames = memo((api) => () => api.actions().then((r) => r.actions));
/** Names for the composer's @-mentions: the project's assets, the open level's actors and the project's files. */
const searchMentions = memo((api): MentionSearchFn => (request, signal) => api.searchMentions(request, signal));

/** .display: the empty page's heading, "Start" in the display face. */
function Display({ t }: { t: Theme }) {
  const size = t.editor ? 24 : 28;
  return (
    <T accessibilityRole="header" style={{ ...font(t, "sans", 700, size, 1.1), letterSpacing: t.editor ? 0 : -0.03 * size, marginBottom: 10, textAlign: "center", color: t.c.text }}>
      <T style={t.editor ? { ...font(t, "sans", 700, 24, 1.1), letterSpacing: -0.24, color: t.c.text } : { ...font(t, "serif", 400, 42, 1, true), letterSpacing: -0.42, color: t.c.accent }}>Start</T>
      {/* .display em's padding-right: 2px, which a nested text cannot take on a phone. */}
      <View testID="display-em-pad" style={{ width: 2, height: 1 }} />
      {" a session."}
    </T>
  );
}

/** A session not yet started: what the agent can do, the model, New session and three examples. */
function Empty({ settings, onSettings, onCreate }: { settings: StudioSettings | null; onSettings: (s: StudioSettings) => void; onCreate: (prompt?: string) => void }) {
  const t = useTheme();
  const insets = useAvoidedInsets();
  const disconnected = settings !== null && settings.route === null;
  return (
    <ScrollView testID="chat-empty" style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1, justifyContent: "center", alignItems: "center", paddingTop: 28, paddingBottom: 28 + insets.bottom, paddingHorizontal: 14 }}>
      <Display t={t} />
      <T style={{ ...font(t, "sans", 400, 13.5, t.base.lineHeight / t.base.size), color: t.c.muted, textAlign: "center", maxWidth: 460, marginBottom: 20 }}>
        The agent works in this project through ue-mcp: Blueprints, materials, levels, Niagara and more. It can also run commands, read and edit the project&apos;s files, and read the web. Approvals in Settings set what it asks you first.
      </T>
      {settings && disconnected ? <ConnectCard settings={settings} onSettings={onSettings} /> : null}
      {settings && !disconnected ? (
        <View style={{ marginBottom: 14 }}>
          <ModelPicker settings={settings} onSettings={onSettings} />
        </View>
      ) : null}
      <Button title="New session" variant="primary" size="large" onPress={() => onCreate()} />
      <View style={{ gap: 8, marginTop: 28, width: "100%", maxWidth: 520 }}>
        <T style={[labelFont(t, t.c.dim), { marginBottom: 4, textAlign: "center" }]}>or try</T>
        {EXAMPLES.map((x) => (
          <Pressable key={x} accessibilityRole="button" accessibilityLabel={x} onPress={() => onCreate(x)} style={({ pressed }) => ({ minHeight: 44, flexDirection: "row", alignItems: "center", paddingVertical: 11, paddingHorizontal: 14, borderWidth: 1, borderColor: t.c.line, borderRadius: t.radius, backgroundColor: pressed ? t.c.accentWash : t.c.tint })}>
            {/* The caret is inline with the text, as the web's ::before: a second line wraps under it, and the mono glyph shares the line box. */}
            <T style={{ flex: 1, ...(t.editor ? font(t, "sans", 400, 12, 1.2) : font(t, "sans", 400, 13.5, 1.45)), color: t.c.muted }}>
              {t.editor ? null : <T testID="example-caret" style={{ ...font(t, "mono", 400, 13.5, 1.45), color: t.c.accent }}>{"›"}</T>}
              {t.editor ? null : <View style={{ width: 10, height: 1 }} />}
              {x}
            </T>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

/** Nothing connected runs the selected model: sign in here (a key is the fallback), or pick another model. */
function ConnectCard({ settings, onSettings }: { settings: StudioSettings; onSettings: (s: StudioSettings) => void }) {
  const t = useTheme();
  const { api } = useProjectNav();
  const catalog = useCatalog(settings);
  return (
    <View style={{ alignItems: "center", gap: 4, width: "100%", maxWidth: 520, paddingVertical: 14, paddingHorizontal: 12, borderWidth: 1, borderColor: t.editor ? t.c.lineStrong : t.c.accentLine, borderRadius: 10, backgroundColor: t.editor ? t.c.panel2 : t.c.accentWash, marginBottom: 14 }}>
      <T style={labelFont(t)}>Sign in to start</T>
      {catalog ? <ConnectModel catalog={catalog} vendor={settings.provider} model={settings.model} onConnected={() => void api.settings().then(onSettings)} /> : null}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, marginTop: 8, width: "100%" }}>
        <T style={[small(t), { color: t.c.dim }]}>Or choose another model:</T>
        <ModelPicker settings={settings} onSettings={onSettings} />
      </View>
    </View>
  );
}

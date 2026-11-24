/**
 * One open project as the web client draws it on a phone (apps/client-web
 * App.tsx at narrow widths): the top bar with the menu button, the tab's name
 * and the editor's chip; the banners under it; the tab's view; the update and
 * connection overlays; the navigation drawer; and the PIN lock over all of
 * it. The project's Studio theme picks the app's theme.
 */
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Linking, Pressable, StyleSheet, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { hubRecordLocation, hubRouteScript, parseHubPath, playtestRecordIndex, studioApi, viewportAllowed, type PanelLocation, type Transport } from "@ue-mcp-studio/client-core";
import { HubRecordsContext, type HubRecords } from "./chat/HubRecordLink";
import { playtestMatches, type StudioTheme } from "@ue-mcp-studio/shared";
import { BackLayer, useBack } from "./back";
import { useProject } from "./connection";
import { transportFor, watchUnpaired, type Device } from "./relay";
import { ProjectContext, useProjectNav, type ProjectNav, type Route } from "./nav";
import { useDaemon } from "./state";
import { readLocation, resetLocation, writeLocation } from "./location";
import { useSessionFocus } from "./focus";
import { useNotifications } from "./notifications/useNotifications";
import { useSettingsApi } from "./screens/settings/hooks";
import { Banner, Button, font, PageGlow, T, useInsets, useSetTheme, useStyles, useTheme, type Theme } from "./ui";
import { Chat } from "./views/Chat";
import { PlaytestsView, usePlaytestIndex } from "./views/Playtests";
import { LiveButton, PieStatusContext, ViewportSheet, useOwnPieStatus } from "./chat/PieLive";
import { SettingsHub } from "./views/SettingsHub";
import { sectionOf, type SettingsSection } from "./views/settings/sections";
import { useUpdateCount } from "./views/Updates";
import { FeedbackDialog } from "./views/Feedback";
import { VcsChip } from "./screens/git/VcsChip";
import { EditorBanner } from "./views/EditorBanner";
import { DialogBanner } from "./views/DialogBanner";
import { PendingDisruptions } from "./views/PendingDisruptions";
import { SHELL_BANNER, VersionNotice } from "./views/VersionNotice";
import { DrawerTool, NavDrawer, TabDot, useDrawerClose } from "./views/NavDrawer";
import { UpdateRunner } from "./views/UpdateOverlay";
import { RefusalPending, RefusedScreen, useRefusal } from "./views/Refused";
import { ErrorBoundary } from "./views/ErrorBoundary";
import { RemoteLock } from "./views/remote/RemoteLock";
import { CompatBanner } from "./native/CompatBanner";
import { useDeviceOnline } from "./native/online";
import { OFFLINE_STRIP } from "./views/OfflineBanner";
import { FileViewerProvider } from "./chat/FileViewer";
import { HeldBar, HeldContext, LeaseBar, useHeld, useLease } from "./held";
// Ways out of the project the drawer offers at all times: the projects list and pairing.
import { Exits } from "./exits";

const TABS = ["Chat", "Playtests", "Settings"] as const;
type Tab = (typeof TABS)[number];

const THEMES: StudioTheme[] = ["ue-mcp", "editor", "editor-orange"];

export interface AppShellProps {
  device: Device;
  onBack: () => void;
  onUnpaired: (message: string) => void;
  /** Opens the pairing scanner: from the drawer, whatever the project is doing. */
  onPair?: () => void;
  /** Replaces the sealed transport: the visual QA harness answers from fixtures through it. */
  transport?: Transport;
  /** Where the panel opens: a tab, a section, a session. */
  initial?: PanelLocation;
}


export function AppShell({ device, onBack, onUnpaired, onPair, transport, initial }: AppShellProps) {
  // The computer saying it does not know this phone ends the project: its pairing is dropped and pairing opens.
  const unpairedRef = useRef(onUnpaired);
  unpairedRef.current = onUnpaired;
  const watched = useMemo(() => watchUnpaired(transport ?? transportFor(device), (m) => unpairedRef.current(m)), [device, transport]);
  const project = useProject(device, watched);
  const exits = useMemo(() => ({ name: device.name, onBack, onPair }), [device.name, onBack, onPair]);
  const api = useMemo(() => studioApi(project.transport), [project.transport]);
  const [stack, setStack] = useState<Route[]>([]);
  const nav = useMemo<ProjectNav>(() => ({ project, api, push: (r) => setStack((s) => [...s, r]), pop: () => setStack((s) => s.slice(0, -1)) }), [project, api]);
  const top = stack[stack.length - 1];
  const setTheme = useSetTheme();

  // The project's Studio theme is the app's.
  useEffect(() => {
    api.settings().then((s) => THEMES.includes(s.theme) && setTheme(s.theme), () => undefined);
  }, [api, setTheme]);

  // Back pops the project's own stack first: it covers every tab.
  useBack(top ? () => nav.pop() : null, { overlay: true });

  return (
    <Exits.Provider value={exits}>
    <ProjectContext.Provider value={nav}>
    <FileViewerProvider>
      <View style={{ flex: 1 }} onTouchStart={() => project.lock.touched()}>
        <Root initial={initial} onBack={onBack} device={device} />
        {top ? (
          <View style={StyleSheet.absoluteFill}>
          </View>
        ) : null}
        <RemoteLock lock={project.lock} computerKey={device.computerKey} onRemoved={() => onUnpaired("This phone was removed after too many wrong PINs. Pair it again.")} />
      </View>
    </FileViewerProvider>
    </ProjectContext.Provider>
    </Exits.Provider>
  );
}

/** Studio, or the one screen that says it needs a newer ue-mcp. */
function Root({ initial, onBack, device }: { initial?: PanelLocation; onBack: () => void; device: Device }) {
  const t = useTheme();
  const { project } = useProjectNav();
  const daemon = useDaemon(project);
  const [attempt, setAttempt] = useState(0);
  const refusal = useRefusal(daemon.health, attempt);
  /** Open Studio anyway: the check never answered, and the user chose not to wait for it. */
  const [skipCheck, setSkipCheck] = useState(false);
  const check = () => {
    setAttempt((n) => n + 1);
    daemon.refresh();
  };
  if (refusal === undefined && !skipCheck) return <View style={{ flex: 1, backgroundColor: t.c.bg }}><RefusalPending key={attempt} onCheck={check} onOpen={() => setSkipCheck(true)} onBack={onBack} /></View>;
  if (refusal) return <RefusedScreen refusal={refusal} onCheck={check} onBack={onBack} />;
  return <Studio daemon={daemon} initial={initial} onBack={onBack} device={device} />;
}

function Studio({ daemon, initial, onBack, device }: { daemon: ReturnType<typeof useDaemon>; initial?: PanelLocation; onBack: () => void; device: Device }) {
  const exits = useContext(Exits);
  const t = useTheme();
  const s = useStyles(styles);
  const insets = useInsets();
  const offline = !useDeviceOnline();
  const { api } = useProjectNav();
  const setTheme = useSetTheme();
  const [tab, setTab] = useState<Tab>(() => {
    resetLocation(initial);
    return readLocation().tab;
  });
  const [section, setSection] = useState<SettingsSection | null>(() => sectionOf(readLocation().section));
  useEffect(() => writeLocation({ tab, section: tab === "Settings" ? section : null }), [tab, section]);
  useSessionFocus(daemon.events, (session) => {
    writeLocation({ tab: "Chat", session });
    setTab("Chat");
  }, (to) => {
    // No model is connected: the quick ask points at the model picker.
    const next = sectionOf(to);
    if (next) setSection(next);
    setTab("Settings");
  });
  const [feedback, setFeedback] = useState(false);
  // Whether PIE runs, held once for the bar's Live button and the chat. A phone is always remote, so it may watch.
  const pie = useOwnPieStatus(viewportAllowed(true));
  // The live viewport over the current tab, from the bar's Live button, a Play In Editor card or a live playtest's Viewport;
  // closing it returns to the same place.
  const [watching, setWatching] = useState(false);
  const watchLive = useCallback(() => setWatching(true), []);
  const settingsFromChat = useCallback((x: string) => {
    setWatching(false);
    setSection(sectionOf(x));
    setTab("Settings");
  }, []);
  const [drawer, setDrawer] = useState(false);
  const [chatNav, setChatNav] = useState<{ session: string | null; n: number }>({ session: null, n: 0 });
  const openChat = (session: string | null) => {
    writeLocation({ tab: "Chat", session });
    setTab("Chat");
    setChatNav((c) => ({ session, n: c.n + 1 }));
  };
  // Notifications while the project is open; a tap on one opens its session.
  const settings = useSettingsApi();
  useNotifications({ events: daemon.events, device, api: settings, streaming: daemon.streaming, onOpen: (n) => n.sessionId && openChat(n.sessionId) });
  const newSession = () => void api.newSession().then((d) => openChat(d.id), () => openChat(null));
  const updates = useUpdateCount();
  const playtests = usePlaytestIndex(daemon);
  const playtestsWaiting = (playtests.index?.playtests ?? []).filter((e) => playtestMatches(e, "needs-you")).length;
  const openPlaytest = (sessionId: string) => openChat(sessionId);
  // The Playtest Hub experiment, read from the computer's settings and again when they change.
  const [hubOn, setHubOn] = useState(false);
  const settingsChanged = [...daemon.events].reverse().find((e) => e.type === "studio.settings.changed" || e.type === "settings.changed");
  useEffect(() => {
    api.settings().then((x) => setHubOn(x?.experiments?.playtestHub === true), () => undefined);
  }, [api, settingsChanged?.id]);
  // The playtest card a hub link or a start location asked for; `n` tells requests apart.
  const [focus, setFocus] = useState<{ script: string; n: number } | null>(() => {
    const script = hubRouteScript(parseHubPath(readLocation().sub));
    return script ? { script, n: 0 } : null;
  });
  // While the hub is on, a link to one of its records opens it on the Playtests page: a playtest at its card.
  const playtestList = playtests.index?.playtests;
  const hubRecords = useMemo<HubRecords | null>(() => (hubOn ? {
    index: playtestList ? playtestRecordIndex(playtestList) : null,
    open: (route) => {
      writeLocation(hubRecordLocation(route));
      setTab("Playtests");
      const script = hubRouteScript(route);
      setFocus((f) => (script ? { script, n: (f?.n ?? 0) + 1 } : null));
    },
  } : null), [hubOn, playtestList]);
  // Runs holding at a manual step for a verdict, PIE paused: the bar under the top bar, and the cards' Resume and watch.
  const held = useHeld(daemon);
  // While the Playtest Hub holds the editor: the bar that says so, with Release the editor.
  const lease = useLease(daemon);
  // The chat stays mounted once shown, parked while another tab is up, so coming back finds the same session and draft.
  const chatShown = useRef(tab === "Chat");
  if (tab === "Chat") chatShown.current = true;
  // Back: a Settings section to the section list, any other tab to Chat. Chat's own levels sit a layer deeper.
  useBack(tab === "Chat" ? null : () => (tab === "Settings" && section ? setSection(null) : setTab("Chat")));

  return (
    <HubRecordsContext.Provider value={hubRecords}>
    <PieStatusContext.Provider value={pie}>
    <HeldContext.Provider value={held}>
    <View style={s.app}>
      {/* body's glow over --bg, under everything; the bar's --bar-bg reads over it as the web's blurred bar does. */}
      <PageGlow top={insets.top} />
      <View style={[s.bar, { paddingTop: insets.top, height: 50 + insets.top, paddingLeft: 6 + insets.left, paddingRight: 12 + insets.right }]}>
        <Pressable accessibilityRole="button" accessibilityLabel="Open navigation" accessibilityState={{ expanded: drawer }} onPress={() => setDrawer(true)} style={({ pressed }) => [s.menu, pressed && s.menuPressed]}>
          <Svg width={18} height={18} viewBox="0 0 18 18" fill="none" stroke={t.c.muted} strokeWidth={1.6} strokeLinecap="round">
            <Path d="M3 5h12M3 9h12M3 13h12" />
          </Svg>
          {updates > 0 ? <TabDot style={{ position: "absolute", top: 8, right: 8 }} /> : null}
        </Pressable>
        <T style={s.title} numberOfLines={1}>
          {tab}
        </T>
        <View style={{ flex: 1 }} />
        <LiveButton onOpen={watchLive} />
        <EditorBanner daemon={daemon} compact />
      </View>
      {/* Room for the offline strip that lies under the bar, so it covers nothing. */}
      {offline ? <View style={{ height: OFFLINE_STRIP }} /> : null}
      <CompatBanner />
      {daemon.error && daemon.streaming ? (
        <Banner kind="bad" role="alert" style={SHELL_BANNER}>
          <T style={{ color: t.c.badText, flexGrow: 1, flexShrink: 1, flexBasis: 200, minWidth: 0 }}>Daemon unreachable: {daemon.error}</T>
          <Button title="Retry" label="Ask ue-mcp again" onPress={() => daemon.refresh()} />
        </Banner>
      ) : null}
      <DialogBanner daemon={daemon} />
      <LeaseBar lease={lease} />
      <HeldBar value={held} onOpenCard={(h) => h.sessionId && openChat(h.sessionId)} onWatchLive={watchLive} />
      <PendingDisruptions daemon={daemon} />
      <VersionNotice daemon={daemon} />
      {/* A landscape navigation bar's side; each view pads the end of its own scrolling by the bottom one. */}
      <View style={[s.stage, { paddingLeft: insets.left, paddingRight: insets.right }]}>
        {chatShown.current ? (
          <View style={[s.main, tab !== "Chat" && s.parked]} pointerEvents={tab === "Chat" ? "auto" : "none"} accessibilityElementsHidden={tab !== "Chat"}>
            <ErrorBoundary what="Chat">
              <BackLayer>
              <Chat
                nav={chatNav}
                initialSession={initial?.tab === "Chat" ? initial.session : null}
                active={tab === "Chat"}
                onSettings={settingsFromChat}
                onWatchLive={watchLive}
              />
              </BackLayer>
            </ErrorBoundary>
          </View>
        ) : null}
        {tab !== "Chat" ? (
          // The Playtests page pads inside its own scroller, as the web main scrolls with its padding.
          <View style={[s.main, tab !== "Playtests" && s.padded]}>
            <ErrorBoundary what={tab} resetKey={tab}>
              {tab === "Playtests" ? <PlaytestsView daemon={daemon} index={playtests} onOpenSession={openPlaytest} onChat={() => setTab("Chat")} focus={focus} /> : null}
              {tab === "Settings" ? <SettingsHub daemon={daemon} section={section} onSection={setSection} onTheme={(x: StudioTheme) => THEMES.includes(x) && setTheme(x)} updates={updates} narrow /> : null}
            </ErrorBoundary>
          </View>
        ) : null}
      </View>
      <UpdateRunner streaming={daemon.streaming} events={daemon.events} onReload={() => daemon.refresh()} />
      {watching ? <ViewportSheet daemon={daemon} onClose={() => setWatching(false)} onSettings={(x) => settingsFromChat(x)} /> : null}
      <NavDrawer
        open={drawer}
        onClose={() => setDrawer(false)}
        tab={tab}
        session={tab === "Chat" ? readLocation().session : null}
        updates={updates}
        playtestsWaiting={playtestsWaiting}
        onTab={setTab}
        onSession={openChat}
        onNewSession={newSession}
        project={{ name: exits.name, onSwitch: exits.onBack }}
      >
        <DrawerVcsChip />
        <DrawerTool title="Feedback" label="Report a problem or suggest an idea" onPress={() => setFeedback(true)} />
        <DrawerTool title="Docs" label="The ue-mcp documentation" onPress={() => void Linking.openURL("https://ue-mcp.com/docs/")} />
        <DrawerExits />
      </NavDrawer>
      {feedback ? <FeedbackDialog onClose={() => setFeedback(false)} /> : null}
    </View>
    </HeldContext.Provider>
    </PieStatusContext.Provider>
    </HubRecordsContext.Provider>
  );
}

/** Pairing, in the drawer's foot at all times (Switch project in its head goes to the projects). */
function DrawerExits() {
  const { onPair } = useContext(Exits);
  return onPair ? <DrawerTool title="Pair again" label="Pair this phone with a computer again" onPress={onPair} /> : null;
}

/** The source control chip at the drawer's foot: opening its changes closes the drawer. */
function DrawerVcsChip() {
  return <VcsChip onOpen={useDrawerClose()} />;
}

const styles = (t: Theme) => ({
  app: { flex: 1, backgroundColor: t.c.bg },
  bar: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 6,
    paddingLeft: 6,
    paddingRight: 12,
    backgroundColor: t.c.barBg,
    borderBottomWidth: 1,
    borderBottomColor: t.c.line,
    zIndex: 30,
    flexShrink: 0,
  },
  menu: { width: 44, height: 44, alignItems: "center" as const, justifyContent: "center" as const, borderRadius: t.radius, borderWidth: 1, borderColor: "transparent" },
  menuPressed: { backgroundColor: t.c.panel2, borderColor: t.c.line },
  title: { ...font(t, "sans", 600, 15, 1.3), color: t.c.text, flexShrink: 1, minWidth: 0 },
  stage: { flex: 1, minHeight: 0 },
  main: { flex: 1, minHeight: 0 },
  padded: { padding: 6 },
  parked: { position: "absolute" as const, top: 0, left: 0, right: 0, bottom: 0, opacity: 0 },
});

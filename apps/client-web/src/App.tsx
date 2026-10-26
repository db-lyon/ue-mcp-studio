import { useEffect, useRef, useState } from "react";
import type { StudioTheme } from "@ue-mcp-studio/shared";
import { api } from "./api";
import { applyTheme } from "./theme";
import { useDaemon, type DaemonState } from "./state";
import { openDocs } from "./native";
import { PluginsView } from "./views/Plugins";
import { useUpdateCount } from "./views/Updates";
import { UpdateRunner } from "./views/UpdateOverlay";
import { FeedbackDialog } from "./views/Feedback";
import { ChatView } from "./views/Chat";
import { SettingsHub } from "./views/SettingsHub";
import { sectionOf, type SettingsSection } from "./views/settings/sections";
import { VcsChip } from "./chat/VcsChip";
import { EditorBanner } from "./views/EditorBanner";
import { DialogBanner } from "./views/DialogBanner";
import { DockToggle } from "./views/DockToggle";
import { NavDrawer } from "./views/NavDrawer";
import { PlaytestsView, usePlaytestIndex } from "./views/Playtests";
import { playtestMatches } from "@ue-mcp-studio/shared";
import { NARROW, useMedia } from "./layout";
import { readLocation, writeLocation } from "./location";
import { useSessionFocus } from "./focus";
import { focusRun, useAttention } from "./attention";
import { replaceStaleWindow } from "./window-version";
import { RefusedScreen, useRefusal } from "./views/Refused";

const TABS = ["Chat", "Playtests", "Plugins", "Settings"] as const;
type Tab = (typeof TABS)[number];

/** Studio, or the one screen that says it needs a newer ue-mcp. */
export function App() {
  const daemon = useDaemon();
  const refusal = useRefusal(daemon.health);
  useEffect(() => {
    api.settings().then((s) => void applyTheme(s.theme), () => void applyTheme("ue-mcp"));
  }, []);
  if (refusal === undefined) return <div className="app" />;
  if (refusal) return <RefusedScreen refusal={refusal} />;
  return <Studio daemon={daemon} />;
}

function Studio({ daemon }: { daemon: DaemonState }) {
  // Where the panel was, from the URL's hash: a reload, or ue-mcp back on a new port, lands there.
  const [tab, setTab] = useState<Tab>(() => readLocation().tab);
  // null: the section list, which only a narrow panel shows on its own.
  const [section, setSection] = useState<SettingsSection | null>(() => sectionOf(readLocation().section));
  useEffect(() => writeLocation({ tab, section: tab === "Settings" ? section : null }), [tab, section]);
  // The editor's quick ask started a session: show it, from any tab.
  useSessionFocus(daemon.events, (session) => {
    writeLocation({ tab: "Chat", session });
    setTab("Chat");
  });
  const [feedback, setFeedback] = useState(false);
  const narrow = useMedia(NARROW);
  const [drawer, setDrawer] = useState(false);
  useEffect(() => {
    if (!narrow) setDrawer(false);
  }, [narrow]);
  // A wide panel always has a section open, Agents first; a narrow one starts on the section list.
  useEffect(() => {
    if (tab === "Settings" && section === null && !narrow) setSection("agents");
  }, [tab, section, narrow]);
  /** A request for the chat to show a session, or its list (null); `n` tells requests apart. */
  const [chatNav, setChatNav] = useState<{ session: string | null; n: number }>({ session: null, n: 0 });
  const openChat = (session: string | null) => {
    writeLocation({ tab: "Chat", session });
    setTab("Chat");
    setChatNav((c) => ({ session, n: c.n + 1 }));
  };
  const newSession = () => void api.newSession().then((d) => openChat(d.id), () => openChat(null));
  // A playtest loop needs the user: a Windows notification, whose click opens the playtest's card.
  useAttention(daemon.events, (t) => {
    openChat(t.sessionId);
    focusRun(t.runId);
  });
  const updates = useUpdateCount();
  // The project's playtests: the page's rows, and the count on its tab of those that wait for the user.
  const playtests = usePlaytestIndex(daemon);
  const playtestsWaiting = (playtests.index?.playtests ?? []).filter((e) => playtestMatches(e, "needs-you")).length;
  const openPlaytest = (sessionId: string, runId: string) => {
    openChat(sessionId);
    focusRun(runId);
  };
  // The chat stays mounted once shown, parked while another tab is up, so coming back to it
  // finds the same session, scroll position and composer draft (#40).
  const chatShown = useRef(tab === "Chat");
  if (tab === "Chat") chatShown.current = true;

  useEffect(() => {
    replaceStaleWindow().catch(() => undefined);
  }, []);

  // The bar's tools: in the bar when wide, at the foot of the drawer when narrow, never both.
  const tools = (
    <div className="bar-tools">
      <DockToggle />
      <button className="ghost docs-link" onClick={() => setFeedback(true)} title="Report a problem or suggest an idea">Feedback</button>
      <button className="ghost docs-link" onClick={() => void openDocs()} title="The ue-mcp documentation">Docs</button>
      <VcsChip events={daemon.events.filter((e) => e.type === "studio.session.changed")} />
    </div>
  );

  return (
    <div className="app">
      <header className="bar">
        {narrow ? (
          <>
            <button className="ghost bar-menu-button" aria-label="Open navigation" aria-expanded={drawer} onClick={() => setDrawer(true)}>
              <MenuGlyph />
              {updates > 0 && <span className="tab-dot" />}
            </button>
            <span className="bar-title">{tab}</span>
            <span className="spacer" />
            <EditorBanner daemon={daemon} compact />
          </>
        ) : (
          <>
            <span className="brand">
              <span className="mark" />
              <span className="name">ue-mcp</span>
              <span className="product">Studio</span>
            </span>
            <nav>
              {TABS.map((t) => (
                <button key={t} className={t === tab ? "tab active" : "tab"} onClick={() => setTab(t)}>
                  {t}
                  {t === "Settings" && updates > 0 && <span className="tab-dot" title={`${updates} ${updates === 1 ? "update" : "updates"} available`} />}
                  {t === "Playtests" && playtestsWaiting > 0 && <span className="tab-count warn" aria-label={`${playtestsWaiting} need you`} title={`${playtestsWaiting} ${playtestsWaiting === 1 ? "playtest needs" : "playtests need"} you`}>{playtestsWaiting}</span>}
                </button>
              ))}
            </nav>
            <span className="spacer" />
            {tools}
          </>
        )}
      </header>
      {narrow && (
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
        >
          {tools}
        </NavDrawer>
      )}
      {daemon.error && <div className="banner bad">Daemon unreachable: {daemon.error}</div>}
      <DialogBanner daemon={daemon} />
      {!narrow && <EditorBanner daemon={daemon} />}
      <div className="stage">
        {chatShown.current && (
          <main className={tab === "Chat" ? "view-chat" : "view-chat parked"} aria-hidden={tab !== "Chat" || undefined}>
            <ChatView daemon={daemon} nav={chatNav} active={tab === "Chat"} />
          </main>
        )}
        {tab !== "Chat" && (
          <main className={`view-${tab.toLowerCase()}`}>
            {tab === "Playtests" && <PlaytestsView daemon={daemon} index={playtests} onOpenSession={openPlaytest} onChat={() => setTab("Chat")} />}
            {tab === "Plugins" && <PluginsView daemon={daemon} />}
            {tab === "Settings" && <SettingsHub daemon={daemon} section={section} onSection={setSection} onTheme={(t: StudioTheme) => void applyTheme(t)} updates={updates} narrow={narrow} />}
          </main>
        )}
      </div>
      <UpdateRunner streaming={daemon.streaming} events={daemon.events} />
      {feedback && <FeedbackDialog onClose={() => setFeedback(false)} />}
    </div>
  );
}

function MenuGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <path d="M3 5h12M3 9h12M3 13h12" />
    </svg>
  );
}

import { useEffect, useState } from "react";
import type { StudioTheme } from "@ue-mcp-studio/shared";
import { api } from "./api";
import { applyTheme } from "./theme";
import { useDaemon } from "./state";
import { openDocs } from "./native";
import { FlowsView } from "./views/Flows";
import { PluginsView } from "./views/Plugins";
import { useUpdateCount } from "./views/Updates";
import { UpdateRunner } from "./views/UpdateOverlay";
import { FeedbackDialog } from "./views/Feedback";
import { ChatView } from "./views/Chat";
import { SettingsHub, type SettingsSection } from "./views/SettingsHub";
import { VcsChip } from "./chat/VcsChip";
import { EditorBanner } from "./views/EditorBanner";
import { DialogBanner } from "./views/DialogBanner";
import { DockToggle } from "./views/DockToggle";
import { NavDrawer } from "./views/NavDrawer";
import { backToSessions, MENU_BAR, SINGLE_PANE_CHAT, useMedia } from "./layout";
import { readLocation, writeLocation } from "./location";
import { useSessionFocus } from "./focus";
import { replaceStaleWindow } from "./window-version";

const TABS = ["Chat", "Flows", "Plugins", "Settings"] as const;
type Tab = (typeof TABS)[number];
const SECTIONS: SettingsSection[] = ["general", "agent", "account", "project", "diagnostics"];

export function App() {
  const daemon = useDaemon();
  // Where the panel was, from the URL's hash: a reload, or ue-mcp back on a new port, lands there.
  const [tab, setTab] = useState<Tab>(() => readLocation().tab);
  const [section, setSection] = useState<SettingsSection>(() => {
    const s = readLocation().section;
    return s && (SECTIONS as string[]).includes(s) ? (s as SettingsSection) : "general";
  });
  useEffect(() => writeLocation({ tab, section: tab === "Settings" ? section : null }), [tab, section]);
  // The editor's quick ask started a session: show it, from any tab.
  useSessionFocus(daemon.events, (session) => {
    writeLocation({ tab: "Chat", session });
    setTab("Chat");
  });
  const [feedback, setFeedback] = useState(false);
  const narrow = useMedia(MENU_BAR);
  const singlePane = useMedia(SINGLE_PANE_CHAT);
  const [drawer, setDrawer] = useState(false);
  useEffect(() => {
    if (!narrow) setDrawer(false);
  }, [narrow]);
  /** A request for the chat to show a session, or its list (null); `n` tells requests apart. */
  const [chatNav, setChatNav] = useState<{ session: string | null; n: number }>({ session: null, n: 0 });
  const openChat = (session: string | null) => {
    writeLocation({ tab: "Chat", session });
    setTab("Chat");
    setChatNav((c) => ({ session, n: c.n + 1 }));
  };
  const pick = (t: Tab) => {
    if (backToSessions(tab, t, singlePane)) openChat(null);
    else setTab(t);
  };
  const newSession = () => void api.newSession().then((d) => openChat(d.id), () => openChat(null));
  const updates = useUpdateCount();

  useEffect(() => {
    api.settings().then((s) => void applyTheme(s.theme), () => void applyTheme("ue-mcp"));
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
                <button key={t} className={t === tab ? "tab active" : "tab"} onClick={() => pick(t)}>
                  {t}
                  {t === "Settings" && updates > 0 && <span className="tab-dot" title={`${updates} ${updates === 1 ? "update" : "updates"} available`} />}
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
          onTab={(t) => (t === "Chat" ? openChat(null) : setTab(t))}
          onSession={openChat}
          onNewSession={newSession}
        >
          {tools}
        </NavDrawer>
      )}
      {daemon.error && <div className="banner bad">Daemon unreachable: {daemon.error}</div>}
      <DialogBanner daemon={daemon} />
      {!narrow && <EditorBanner daemon={daemon} />}
      <main>
        {tab === "Flows" && <FlowsView daemon={daemon} />}
        {tab === "Plugins" && <PluginsView daemon={daemon} />}
        {tab === "Chat" && <ChatView daemon={daemon} nav={chatNav} />}
        {tab === "Settings" && <SettingsHub daemon={daemon} section={section} onSection={setSection} onTheme={(t: StudioTheme) => void applyTheme(t)} />}
      </main>
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

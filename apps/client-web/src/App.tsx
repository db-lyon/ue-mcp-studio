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
import { readLocation, writeLocation } from "./location";

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
  const [feedback, setFeedback] = useState(false);
  const updates = useUpdateCount();

  useEffect(() => {
    api.settings().then((s) => void applyTheme(s.theme), () => void applyTheme("ue-mcp"));
  }, []);

  return (
    <div className="app">
      <header className="bar">
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
            </button>
          ))}
        </nav>
        <span className="spacer" />
        <DockToggle />
        <button className="ghost docs-link" onClick={() => setFeedback(true)} title="Report a problem or suggest an idea">Feedback</button>
        <button className="ghost docs-link" onClick={() => void openDocs()} title="The ue-mcp documentation">Docs</button>
        <VcsChip events={daemon.events.filter((e) => e.type === "studio.session.changed")} />
      </header>
      {daemon.error && <div className="banner bad">Daemon unreachable: {daemon.error}</div>}
      <DialogBanner daemon={daemon} />
      <EditorBanner daemon={daemon} />
      <main>
        {tab === "Flows" && <FlowsView daemon={daemon} />}
        {tab === "Plugins" && <PluginsView daemon={daemon} />}
        {tab === "Chat" && <ChatView daemon={daemon} />}
        {tab === "Settings" && <SettingsHub daemon={daemon} section={section} onSection={setSection} onTheme={(t: StudioTheme) => void applyTheme(t)} />}
      </main>
      <UpdateRunner streaming={daemon.streaming} events={daemon.events} />
      {feedback && <FeedbackDialog onClose={() => setFeedback(false)} />}
    </div>
  );
}

import { useEffect, useState } from "react";
import type { StudioTheme } from "@ue-mcp-studio/shared";
import { api } from "./api";
import { applyTheme } from "./theme";
import { useDaemon } from "./state";
import { openDocs } from "./native";
import { FlowsView } from "./views/Flows";
import { PluginsView } from "./views/Plugins";
import { ChatView } from "./views/Chat";
import { SettingsHub, type SettingsSection } from "./views/SettingsHub";
import { VcsChip } from "./chat/VcsChip";

const TABS = ["Chat", "Flows", "Plugins", "Settings"] as const;
type Tab = (typeof TABS)[number];

export function App() {
  const daemon = useDaemon();
  const [tab, setTab] = useState<Tab>("Chat");
  const [section, setSection] = useState<SettingsSection>("general");
  const openSettings = (s: SettingsSection) => {
    setSection(s);
    setTab("Settings");
  };
  const editor = daemon.health?.editors[0];

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
            </button>
          ))}
        </nav>
        <span className="spacer" />
        <button className="ghost docs-link" onClick={() => void openDocs()} title="The ue-mcp documentation">Docs</button>
        <VcsChip events={daemon.events.filter((e) => e.type === "studio.session.changed")} />
        {/* Nothing to say while all is well; a problem shows here and opens Diagnostics. */}
        {(!daemon.streaming || !editor?.connected) && (
          <button className={`chip problem ${daemon.streaming ? "warn" : "bad"}`} onClick={() => openSettings("diagnostics")} title="Open Diagnostics">
            {!daemon.streaming ? "Reconnecting to ue-mcp" : "Editor offline"}
          </button>
        )}
      </header>
      {daemon.error && <div className="banner bad">Daemon unreachable: {daemon.error}</div>}
      <main>
        {tab === "Flows" && <FlowsView daemon={daemon} />}
        {tab === "Plugins" && <PluginsView daemon={daemon} />}
        {tab === "Chat" && <ChatView daemon={daemon} />}
        {tab === "Settings" && <SettingsHub daemon={daemon} section={section} onSection={setSection} onTheme={(t: StudioTheme) => void applyTheme(t)} />}
      </main>
    </div>
  );
}

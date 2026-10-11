import { useEffect, useState } from "react";
import type { StudioTheme } from "@ue-mcp-studio/shared";
import { api } from "./api";
import { applyTheme } from "./theme";
import { useDaemon } from "./state";
import { inEditor } from "./native";
import { StatusView } from "./views/Status";
import { FlowsView } from "./views/Flows";
import { LogsView } from "./views/Logs";
import { ChatView } from "./views/Chat";
import { SettingsHub } from "./views/SettingsHub";

const TABS = ["Chat", "Status", "Flows", "Logs", "Settings"] as const;
type Tab = (typeof TABS)[number];

export function App() {
  const daemon = useDaemon();
  const [tab, setTab] = useState<Tab>("Chat");
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
        <span className={`chip ${editor?.connected ? "ok" : "warn"}`}>
          {editor ? (editor.connected ? "Editor connected" : "Editor offline") : "No editor"}
        </span>
        <span className={`chip ${daemon.streaming ? "ok" : "bad"}`} title="Daemon event stream">
          {daemon.streaming ? "Live" : "Reconnecting"}
        </span>
        {!inEditor() && <span className="chip">Browser</span>}
      </header>
      {daemon.error && <div className="banner bad">Daemon unreachable: {daemon.error}</div>}
      <main>
        {tab === "Status" && <StatusView daemon={daemon} />}
        {tab === "Flows" && <FlowsView daemon={daemon} />}
        {tab === "Logs" && <LogsView daemon={daemon} />}
        {tab === "Chat" && <ChatView daemon={daemon} />}
        {tab === "Settings" && <SettingsHub onTheme={(t: StudioTheme) => void applyTheme(t)} />}
      </main>
    </div>
  );
}

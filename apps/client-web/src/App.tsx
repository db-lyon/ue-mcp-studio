import { useState } from "react";
import { useDaemon } from "./state";
import { inEditor } from "./native";
import { StatusView } from "./views/Status";
import { SetupView } from "./views/Setup";
import { FlowsView } from "./views/Flows";
import { LogsView } from "./views/Logs";
import { ConfigView } from "./views/Config";
import { ChatView } from "./views/Chat";
import { SettingsView } from "./views/Settings";
import { AccountView } from "./views/Account";

const TABS = ["Chat", "Status", "Setup", "Flows", "Logs", "Config", "Settings", "Account"] as const;
type Tab = (typeof TABS)[number];

export function App() {
  const daemon = useDaemon();
  const [tab, setTab] = useState<Tab>("Chat");
  const editor = daemon.health?.editors[0];

  return (
    <div className="app">
      <header className="bar">
        <span className="brand">UE-MCP Studio</span>
        <nav>
          {TABS.map((t) => (
            <button key={t} className={t === tab ? "tab active" : "tab"} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </nav>
        <span className="spacer" />
        <span className={`pill ${editor?.connected ? "ok" : "warn"}`}>
          {editor ? (editor.connected ? "Editor connected" : "Editor offline") : "No editor"}
        </span>
        <span className={`pill ${daemon.streaming ? "ok" : "bad"}`} title="Daemon event stream">
          {daemon.streaming ? "Live" : "Reconnecting"}
        </span>
        {!inEditor() && <span className="pill muted">Browser</span>}
      </header>
      {daemon.error && <div className="banner bad">Daemon unreachable: {daemon.error}</div>}
      <main>
        {tab === "Status" && <StatusView daemon={daemon} />}
        {tab === "Setup" && <SetupView />}
        {tab === "Flows" && <FlowsView daemon={daemon} />}
        {tab === "Logs" && <LogsView daemon={daemon} />}
        {tab === "Config" && <ConfigView />}
        {tab === "Chat" && <ChatView daemon={daemon} />}
        {tab === "Settings" && <SettingsView />}
        {tab === "Account" && <AccountView />}
      </main>
    </div>
  );
}

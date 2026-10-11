import { STUDIO_PLAN_AVAILABLE } from "@ue-mcp-studio/shared";
import type { StudioTheme } from "@ue-mcp-studio/shared";
import type { DaemonState } from "../state";
import { SettingsView } from "./Settings";
import { AccountView } from "./Account";
import { SetupView } from "./Setup";
import { StatusView } from "./Status";
import { LogsView } from "./Logs";

const SECTIONS = [
  { id: "general", name: "General" },
  ...(STUDIO_PLAN_AVAILABLE ? [{ id: "account" as const, name: "Account" }] : []),
  { id: "project", name: "Project" },
  { id: "diagnostics", name: "Diagnostics" },
] as const;
export type SettingsSection = "general" | "account" | "project" | "diagnostics";

/**
 * Everything that configures or explains Studio, as one tab: theme and model,
 * the project (its install, init choices and ue-mcp.yml), and Diagnostics:
 * the editor and daemon status and the logs.
 */
export function SettingsHub({ daemon, section, onSection, onTheme }: {
  daemon: DaemonState;
  section: SettingsSection;
  onSection: (s: SettingsSection) => void;
  onTheme: (t: StudioTheme) => void;
}) {
  return (
    <div className="hub">
      <nav className="subtabs" aria-label="Settings sections">
        {SECTIONS.map((s) => (
          <button key={s.id} className={s.id === section ? "subtab active" : "subtab"} onClick={() => onSection(s.id)}>
            {s.name}
          </button>
        ))}
      </nav>
      {section === "general" && <SettingsView onTheme={onTheme} />}
      {section === "account" && <AccountView />}
      {section === "project" && <SetupView />}
      {section === "diagnostics" && (
        <div className="stack">
          <StatusView daemon={daemon} />
          <LogsView daemon={daemon} />
        </div>
      )}
    </div>
  );
}

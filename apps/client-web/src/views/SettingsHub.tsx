import { useState } from "react";
import { STUDIO_PLAN_AVAILABLE } from "@ue-mcp-studio/shared";
import type { StudioTheme } from "@ue-mcp-studio/shared";
import { SettingsView } from "./Settings";
import { AccountView } from "./Account";
import { SetupView } from "./Setup";

const SECTIONS = [
  { id: "general", name: "General" },
  ...(STUDIO_PLAN_AVAILABLE ? [{ id: "account" as const, name: "Account" }] : []),
  { id: "project", name: "Project" },
] as const;
type Section = (typeof SECTIONS)[number]["id"];

/** Everything that configures Studio, as one tab: theme and model, account, and the project: its install, init choices and ue-mcp.yml. */
export function SettingsHub({ onTheme }: { onTheme: (t: StudioTheme) => void }) {
  const [section, setSection] = useState<Section>("general");
  return (
    <div className="hub">
      <nav className="subtabs" aria-label="Settings sections">
        {SECTIONS.map((s) => (
          <button key={s.id} className={s.id === section ? "subtab active" : "subtab"} onClick={() => setSection(s.id)}>
            {s.name}
          </button>
        ))}
      </nav>
      {section === "general" && <SettingsView onTheme={onTheme} />}
      {section === "account" && <AccountView />}
      {section === "project" && <SetupView />}
    </div>
  );
}

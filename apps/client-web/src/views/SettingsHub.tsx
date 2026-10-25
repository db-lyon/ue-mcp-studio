import { useEffect, useState, type ReactNode } from "react";
import type { StudioSettings, StudioTheme } from "@ue-mcp-studio/shared";
import type { DaemonState } from "../state";
import { api } from "../api";
import { AgentsSection } from "./settings/AgentsSection";
import { ModelsSection } from "./settings/ModelsSection";
import { ApprovalsSection } from "./settings/ApprovalsSection";
import { ProjectSection } from "./settings/ProjectSection";
import { UsageSection } from "./settings/UsageSection";
import { GeneralSection } from "./settings/GeneralSection";
import { StatusView } from "./Status";
import { LogsView } from "./Logs";

import { type SettingsSection } from "./settings/sections";
export type { SettingsSection } from "./settings/sections";

const ICONS: Record<SettingsSection, string> = {
  agents: "M5.5 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM2 13c0-2 1.6-3.5 3.5-3.5S9 11 9 13M11 7.5a1.7 1.7 0 1 0 0-3.4M12 9.6c1.3.4 2 1.6 2 3.4",
  models: "M4 4h8v8H4zM6 1.5V4M10 1.5V4M6 12v2.5M10 12v2.5M1.5 6H4M1.5 10H4M12 6h2.5M12 10h2.5",
  approvals: "M8 1.5l5 2v4c0 3.2-2.2 5.6-5 7-2.8-1.4-5-3.8-5-7v-4zM5.5 8l1.7 1.7L10.7 6",
  project: "M1.5 4.5h4l1.5 1.5h7.5v7.5h-13z",
  usage: "M3 13V8M6.5 13V4M10 13V7M13.5 13V10",
  general: "M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4",
  diagnostics: "M1.5 8.5h3l2-5 3 9 2-4h3",
};

const GROUPS: Array<{ label: string; items: Array<{ id: SettingsSection; name: string; sub: string }> }> = [
  {
    label: "Work",
    items: [
      { id: "agents", name: "Agents", sub: "Who works, on what, reading which instructions" },
      { id: "models", name: "Models & accounts", sub: "Sign-ins, API keys and every model they run" },
      { id: "approvals", name: "Approvals & review", sub: "What asks first, and what you check after" },
    ],
  },
  {
    label: "Project and Studio",
    items: [
      { id: "project", name: "Project", sub: "ue-mcp for every client on this project" },
      { id: "usage", name: "Usage", sub: "Budgets and what agents spend" },
      { id: "general", name: "General", sub: "Appearance and updates" },
      { id: "diagnostics", name: "Diagnostics", sub: "Editor and daemon status, logs" },
    ],
  },
];

function Icon({ d }: { d: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

/** What needs attention, per section, for the rail's dots. */
export function useAttentionDots(updates: number): Partial<Record<SettingsSection, string>> {
  const [settings, setSettings] = useState<StudioSettings | null>(null);
  useEffect(() => {
    api.settings().then(setSettings, () => setSettings(null));
  }, []);
  const dots: Partial<Record<SettingsSection, string>> = {};
  if (settings && settings.route === null) dots.models = "Nothing connected can run the main agent's model";
  if (updates > 0) dots.general = `${updates} ${updates === 1 ? "update" : "updates"} available`;
  return dots;
}

/**
 * Settings, grouped by the decision being made rather than by where a value
 * is stored. Wide: a rail of sections beside the open one. Narrow: the list
 * of sections, each opening full width with Back.
 */
export function SettingsHub({ daemon, section, onSection, onTheme, updates = 0, narrow = false }: {
  daemon: DaemonState;
  section: SettingsSection | null;
  onSection: (s: SettingsSection | null) => void;
  onTheme: (t: StudioTheme) => void;
  updates?: number;
  narrow?: boolean;
}) {
  const dots = useAttentionDots(updates);
  // Wide always shows a section; narrow starts on the list.
  const open: SettingsSection | null = section ?? (narrow ? null : "agents");
  let body: ReactNode = null;
  if (open === "agents") body = <AgentsSection onSection={onSection} />;
  else if (open === "models") body = <ModelsSection />;
  else if (open === "approvals") body = <ApprovalsSection />;
  else if (open === "project") body = <ProjectSection onSection={onSection} />;
  else if (open === "usage") body = <UsageSection />;
  else if (open === "general") body = <GeneralSection onTheme={onTheme} />;
  else if (open === "diagnostics") body = (
    <>
      <Head title="Diagnostics" lead="The editor and daemon as Studio sees them now, and the daemon's log." />
      <StatusView daemon={daemon} />
      <LogsView daemon={daemon} />
    </>
  );
  return (
    <div className={`cfg ${open ? "has-section" : ""}`}>
      <nav className="cfg-rail" aria-label="Settings sections">
        {GROUPS.map((g) => (
          <div key={g.label} className="cfg-rail-group">
            <div className="cfg-rail-label">{g.label}</div>
            {g.items.map((s) => (
              <button
                key={s.id}
                className={`cfg-rail-item ${open === s.id ? "active" : ""}`}
                aria-current={open === s.id ? "page" : undefined}
                onClick={() => onSection(s.id)}
              >
                <Icon d={ICONS[s.id]} />
                <span className="cfg-rail-text">
                  <span>{s.name}</span>
                  <span className="cfg-rsub">{dots[s.id] ?? s.sub}</span>
                </span>
                {dots[s.id] && <span className="cfg-rdot" title={dots[s.id]} aria-label={dots[s.id]} />}
              </button>
            ))}
          </div>
        ))}
      </nav>
      {open && (
        <div className="cfg-content">
          <button className="ghost cfg-back" onClick={() => onSection(null)}>{"‹"} Settings</button>
          {body}
        </div>
      )}
    </div>
  );
}

/** A section's title and the one sentence that says what it decides. */
export function Head({ title, lead, actions }: { title: string; lead: ReactNode; actions?: ReactNode }) {
  return (
    <div className="cfg-head">
      <div>
        <h1>{title}</h1>
        <p className="muted">{lead}</p>
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

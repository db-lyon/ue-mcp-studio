import { useEffect, useState, type ReactNode } from "react";
import { CONTEXT_STRATEGY_INFO, anythingConnected, remoteShown, type ModelCatalog, type StudioSettings, type StudioTheme } from "@ue-mcp-studio/shared";
import type { DaemonState } from "../state";
import { api } from "../api";
import { AgentsSection } from "./settings/AgentsSection";
import { ModelsSection } from "./settings/ModelsSection";
import { ApprovalsSection } from "./settings/ApprovalsSection";
import { ProjectSection } from "./settings/ProjectSection";
import { GeneralSection } from "./settings/GeneralSection";
import { NotificationsSection } from "./settings/NotificationsSection";
import { RemoteSection, RemoteSignIn, RemoteUpsell } from "./settings/RemoteSection";
import { useRemoteAvailable } from "./settings/remote-available";
import { StatusView } from "./Status";
import { LogsView } from "./Logs";

import { extensionSection, isExtensionSection, sectionOf, type BuiltinSection, type SettingsSection } from "./settings/sections";
import { ErrorBoundary } from "./ErrorBoundary";
import { useSlot } from "../extensions/registry";
import { Contribution } from "../extensions/Slot";
export type { SettingsSection } from "./settings/sections";

const ICONS: Record<BuiltinSection, string> = {
  agents: "M5.5 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM2 13c0-2 1.6-3.5 3.5-3.5S9 11 9 13M11 7.5a1.7 1.7 0 1 0 0-3.4M12 9.6c1.3.4 2 1.6 2 3.4",
  models: "M4 4h8v8H4zM6 1.5V4M10 1.5V4M6 12v2.5M10 12v2.5M1.5 6H4M1.5 10H4M12 6h2.5M12 10h2.5",
  approvals: "M8 1.5l5 2v4c0 3.2-2.2 5.6-5 7-2.8-1.4-5-3.8-5-7v-4zM5.5 8l1.7 1.7L10.7 6",
  project: "M1.5 4.5h4l1.5 1.5h7.5v7.5h-13z",
  general: "M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4",
  notifications: "M4 11.5V7a4 4 0 0 1 8 0v4.5l1.5 1.5h-11zM6.5 13.5a1.5 1.5 0 0 0 3 0",
  remote: "M5 1.5h6v13H5zM7.3 12.5h1.4",
  diagnostics: "M1.5 8.5h3l2-5 3 9 2-4h3",
};
const EXTENSION_ICON = "M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z";
const NO_CTX = {};

const REMOTE_ITEM = { id: "remote" as const, name: "Remote control", sub: "Use this project from a phone or browser" };

const GROUPS: Array<{ label: string; items: Array<{ id: BuiltinSection; name: string; sub: string }> }> = [
  {
    label: "Studio",
    items: [
      { id: "general", name: "General", sub: "Account, appearance and updates" },
      { id: "notifications", name: "Notifications", sub: "Events, mutes and quiet hours" },
      REMOTE_ITEM,
    ],
  },
  {
    label: "Work",
    items: [
      { id: "agents", name: "Agents", sub: "Models and project agent files" },
      { id: "models", name: "Models & accounts", sub: "Sign-ins, keys and endpoints" },
      { id: "approvals", name: "Approvals & review", sub: "Approvals, dialogs and turn review" },
    ],
  },
  {
    label: "Project",
    items: [
      { id: "project", name: "Project", sub: "ue-mcp setup for this project" },
      { id: "diagnostics", name: "Diagnostics", sub: "Status and logs" },
    ],
  },
];

const NAMES = Object.fromEntries(GROUPS.flatMap((g) => g.items.map((s) => [s.id, s.name]))) as Record<BuiltinSection, string>;

function Icon({ d }: { d: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const ROUTE_LABEL: Record<string, string> = { claude: "Claude sign-in", chatgpt: "ChatGPT sign-in", studio: "Studio plan", key: "key" };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Each section's state in a line, for the narrow section list, and what needs
 * attention, for the rail's dots. Read once when Settings opens.
 */
export function useSectionStatus(updates: number, daemon: DaemonState): { dots: Partial<Record<SettingsSection, string>>; lines: Partial<Record<SettingsSection, string>> } {
  const [settings, setSettings] = useState<StudioSettings | null>(null);
  const [extra, setExtra] = useState<{ approvalsOff?: number; strategy?: string; overridden?: boolean; ready?: boolean; models?: ModelCatalog } >({});
  useEffect(() => {
    api.settings().then(setSettings, () => setSettings(null));
    // The strategy in effect: an environment override beats the saved one.
    if (typeof api.contextStrategy === "function") api.contextStrategy().then((c) => setExtra((e) => ({ ...e, strategy: c.envOverride ? `${CONTEXT_STRATEGY_INFO[c.envOverride]?.name ?? c.envOverride}, from environment` : CONTEXT_STRATEGY_INFO[c.strategy]?.name ?? c.strategy, overridden: !!c.envOverride && c.envOverride !== c.strategy })), () => undefined);
    if (typeof api.install === "function") api.install().then((r) => setExtra((e) => ({ ...e, ready: r.ok })), () => undefined);
    if (typeof api.models === "function") api.models().then((m) => setExtra((e) => ({ ...e, models: m })), () => undefined);
  }, []);
  // The rail's lines only describe; one that cannot be worked out is left off rather than taking Settings down.
  try {
    return statusOf(updates, daemon, settings, extra);
  } catch (e) {
    console.error("Settings could not work out a section's state", e);
    return { dots: {}, lines: {} };
  }
}

function statusOf(updates: number, daemon: DaemonState, settings: StudioSettings | null, extra: { strategy?: string; overridden?: boolean; ready?: boolean; models?: ModelCatalog }): { dots: Partial<Record<SettingsSection, string>>; lines: Partial<Record<SettingsSection, string>> } {
  const dots: Partial<Record<SettingsSection, string>> = {};
  if (settings && !anythingConnected(settings)) dots.models = "Nothing connected";
  if (settings && settings.route === null) dots.agents = "No model connected";
  else if (settings && settings.route === null) dots.models = "Main agent's model not connected";
  if (extra.overridden) dots.project = "Context strategy overridden by environment";
  if (updates > 0) dots.general = `${updates} ${updates === 1 ? "update" : "updates"} available`;
  const lines: Partial<Record<SettingsSection, string>> = {};
  if (settings) {
    const model = extra.models?.providers.flatMap((p) => p.models).find((m) => m.id === settings.model)?.name ?? settings.model;
    const helpers = settings.usage?.projectInstructions === false ? "project files off" : "project files on";
    const anything = anythingConnected(settings);
    // An endpoint route is named by the endpoint.
    const via = settings.route === "endpoint" ? extra.models?.providers.find((p) => p.id === settings.provider)?.name ?? "a custom endpoint" : settings.route ? ROUTE_LABEL[settings.route] ?? settings.route : null;
    lines.agents = !anything ? "No model connected" : `${model}${via ? ` on ${via}` : ", not connected"}, ${helpers}`;
    const signIns = (["claude", "chatgpt", "studio"] as const).filter((s) => settings.connected?.[s]).length;
    const keys = (["anthropic", "openai", "google"] as const).filter((k) => settings.connected?.[k]).length;
    const endpoints = settings.endpoints ?? 0;
    lines.models = signIns + keys + endpoints === 0 ? "Nothing connected" : `${plural(signIns, "sign-in")}, ${plural(keys, "key")}${endpoints ? `, ${plural(endpoints, "endpoint")}` : ""}`;
    const rules = settings.approvals ? Object.values(settings.approvals) : [];
    if (rules.length) lines.approvals = `${rules.filter((r) => r === "ask").length} ask first, review ${settings.reviewTurns === false ? "off" : "on"}`;
  }
  if (extra.ready !== undefined || extra.strategy) lines.project = [extra.ready === undefined ? null : extra.ready ? "Ready" : "Needs attention", extra.strategy ?? null].filter(Boolean).join(", ");
  // A count of 0 is also what a failed check reads, so it never claims up to date.
  if (updates > 0) lines.general = dots.general;
  const editor = daemon?.health?.editors?.find((e) => e.connected);
  if (daemon?.health) lines.diagnostics = editor ? `Editor connected, ue-mcp ${daemon.health.version}` : `No editor connected, ue-mcp ${daemon.health.version}`;
  return { dots, lines };
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
  const { dots, lines } = useSectionStatus(updates, daemon);
  // Extension sections; one not registered (yet) shows the fallback, and the hash keeps it.
  const extensions = useSlot("settings.section");
  // Remote control: working on a paid plan; while the plan is offered, a sign-in when signed out and a plan note for a free account; else not there and its name opens General.
  const remote = useRemoteAvailable();
  const shown = remoteShown(remote.surface);
  const groups = remote.surface !== "hidden" ? GROUPS : GROUPS.map((g) => ({ ...g, items: g.items.filter((s) => s.id !== "remote") }));
  const named = sectionOf(section);
  const asked = named === "remote" && remote.surface === "hidden" && remote.available !== null ? "general" : named;
  const extOpen = isExtensionSection(asked) ? extensions.find((i) => extensionSection(i.ext, i.contribution.id) === asked) : undefined;
  // Wide always shows a section; narrow starts on the list. A name no version used opens General.
  const open: SettingsSection | null = (isExtensionSection(asked) && !extOpen ? null : asked) ?? (narrow ? null : "general");
  const name = extOpen ? extOpen.contribution.title ?? extOpen.contribution.id : open === "remote" && !shown ? "" : open && !isExtensionSection(open) ? NAMES[open] : "";
  let body: ReactNode = null;
  if (extOpen) body = <Contribution item={extOpen} ctx={NO_CTX} />;
  else if (open === "agents") body = <AgentsSection onSection={onSection} />;
  else if (open === "models") body = <ModelsSection />;
  else if (open === "approvals") body = <ApprovalsSection />;
  else if (open === "project") body = <ProjectSection onSection={onSection} />;
  else if (open === "general") body = <GeneralSection onTheme={onTheme} />;
  else if (open === "notifications") body = <NotificationsSection />;
  else if (open === "remote" && remote.surface === "working") body = <RemoteSection onUnavailable={remote.recheck} />;
  else if (open === "remote" && remote.surface === "upsell") body = <RemoteUpsell />;
  else if (open === "remote" && remote.surface === "signin") body = <RemoteSignIn onDone={remote.recheck} />;
  else if (open === "diagnostics") body = (
    <>
      <Head title="Diagnostics" lead="Editor and daemon status, and recent daemon events." />
      <StatusView daemon={daemon} />
      <LogsView daemon={daemon} />
    </>
  );
  return (
    <div className={`cfg ${open ? "has-section" : ""}`}>
      <nav className="cfg-rail" aria-label="Settings sections">
        {groups.map((g) => (
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
                  <span className="cfg-rsub">{dots[s.id] ?? lines[s.id] ?? s.sub}</span>
                </span>
                {dots[s.id] && <span className="cfg-rdot" title={dots[s.id]} aria-label={dots[s.id]} />}
              </button>
            ))}
          </div>
        ))}
        {extensions.length > 0 && (
          <div className="cfg-rail-group">
            <div className="cfg-rail-label">Extensions</div>
            {extensions.map((i) => {
              const id = extensionSection(i.ext, i.contribution.id);
              return (
                <button key={id} className={`cfg-rail-item ${open === id ? "active" : ""}`} aria-current={open === id ? "page" : undefined} onClick={() => onSection(id)}>
                  <Icon d={EXTENSION_ICON} />
                  <span className="cfg-rail-text">
                    <span>{i.contribution.title ?? i.contribution.id}</span>
                    <span className="cfg-rsub">{i.ext}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </nav>
      {open && (
        <div className="cfg-content">
          <button className="ghost cfg-back" onClick={() => onSection(null)}>{"‹"} All settings</button>
          {/* A section that throws shows why in its place; the rail and the other sections keep working. */}
          <ErrorBoundary what="This section" where={`Settings > ${name}`} resetKey={open}>
            {body}
          </ErrorBoundary>
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

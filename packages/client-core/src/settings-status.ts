/**
 * Settings' sections and what the section list says about each: its state in
 * a line, and what needs attention (a dot). Shared by client-web's SettingsHub
 * and the mobile app's Settings.
 */
import { CONTEXT_STRATEGY_INFO, anythingConnected, type ClientContextStrategy, type ModelCatalog, type StudioSettings } from "@ue-mcp-studio/shared";

/** Settings sections, grouped by the decision being made. */
export type BuiltinSection = "agents" | "models" | "approvals" | "project" | "general" | "remote" | "diagnostics";
/** A section an extension adds: `ext:<extension>:<contribution id>`. */
export type ExtensionSection = `ext:${string}:${string}`;
export type SettingsSection = BuiltinSection | ExtensionSection;
/** Remote control is listed only while it is offered; the hub opens General for it otherwise. */
export const SETTINGS_SECTIONS: readonly BuiltinSection[] = ["agents", "models", "approvals", "project", "general", "remote", "diagnostics"];

const EXT = /^ext:[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,64}$/;
export const extensionSection = (ext: string, id: string): ExtensionSection => `ext:${ext}:${id}`;
export const isExtensionSection = (s: string | null | undefined): s is ExtensionSection => !!s && EXT.test(s);

/** Where an older link or hash pointed before the sections were regrouped, and the tabs that became sections. */
const MOVED: Record<string, BuiltinSection> = {
  agent: "agents",
  usage: "agents",
  account: "models",
  accounts: "models",
  update: "general",
  updates: "general",
  appearance: "general",
  theme: "general",
  config: "project",
  status: "diagnostics",
  logs: "diagnostics",
};

/** A section from a location: null when there is none, an extension's kept as written, General for any other unknown name. */
export function sectionOf(raw: string | null | undefined): SettingsSection | null {
  if (!raw) return null;
  if (isExtensionSection(raw)) return raw;
  const s = MOVED[raw.toLowerCase()] ?? raw.toLowerCase();
  return (SETTINGS_SECTIONS as readonly string[]).includes(s) ? (s as BuiltinSection) : "general";
}

export interface SettingsItem {
  id: BuiltinSection;
  name: string;
  sub: string;
}

export const REMOTE_ITEM: SettingsItem = { id: "remote", name: "Remote control", sub: "Use this project from a phone or browser" };

/** The section list, in its groups. */
export const SETTINGS_GROUPS: ReadonlyArray<{ label: string; items: SettingsItem[] }> = [
  { label: "Studio", items: [{ id: "general", name: "General", sub: "Account, appearance and updates" }, REMOTE_ITEM] },
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

export const SECTION_NAMES = Object.fromEntries(SETTINGS_GROUPS.flatMap((g) => g.items.map((s) => [s.id, s.name]))) as Record<BuiltinSection, string>;

const ROUTE_LABEL: Record<string, string> = { claude: "Claude sign-in", chatgpt: "ChatGPT sign-in", studio: "Studio plan", key: "key" };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What the list reads besides the settings: the context strategy, the install check and the model catalog. */
export interface SectionExtra {
  strategy?: string;
  overridden?: boolean;
  ready?: boolean;
  models?: ModelCatalog;
}

/** The strategy line and whether the environment overrides the saved one. */
export function strategyLine(c: ClientContextStrategy): Pick<SectionExtra, "strategy" | "overridden"> {
  return {
    strategy: c.envOverride ? `${CONTEXT_STRATEGY_INFO[c.envOverride]?.name ?? c.envOverride}, from environment` : CONTEXT_STRATEGY_INFO[c.strategy]?.name ?? c.strategy,
    overridden: !!c.envOverride && c.envOverride !== c.strategy,
  };
}

/** The health the Diagnostics line reads. */
export interface HealthLine {
  version: string;
  editors?: Array<{ connected: boolean }>;
}

/** Each section's state in a line, and what needs attention, for the section list. */
export function sectionStatus(updates: number, health: HealthLine | null | undefined, settings: StudioSettings | null, extra: SectionExtra): { dots: Partial<Record<SettingsSection, string>>; lines: Partial<Record<SettingsSection, string>> } {
  const dots: Partial<Record<SettingsSection, string>> = {};
  if (settings && !anythingConnected(settings)) dots.models = "Nothing connected";
  if (settings && settings.route === null) dots.agents = "No model connected";
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
  lines.general = updates > 0 ? dots.general : "Up to date";
  const editor = health?.editors?.find((e) => e.connected);
  if (health) lines.diagnostics = editor ? `Editor connected, ue-mcp ${health.version}` : `No editor connected, ue-mcp ${health.version}`;
  return { dots, lines };
}

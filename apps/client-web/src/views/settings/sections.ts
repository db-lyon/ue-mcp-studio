/** Settings sections, grouped by the decision being made. Kept apart from the views so the location code can read them. */
export type SettingsSection = "agents" | "models" | "approvals" | "project" | "general" | "diagnostics";
export const SETTINGS_SECTIONS: readonly SettingsSection[] = ["agents", "models", "approvals", "project", "general", "diagnostics"];

/** Where an older link or hash pointed before the sections were regrouped, and the tabs that became sections. */
const MOVED: Record<string, SettingsSection> = {
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

/**
 * A section from the hash, the old names mapped to the new; null when there is
 * none, and General for a name no version used, so Settings always opens on one.
 */
export function sectionOf(raw: string | null | undefined): SettingsSection | null {
  if (!raw) return null;
  const s = MOVED[raw.toLowerCase()] ?? raw.toLowerCase();
  return (SETTINGS_SECTIONS as readonly string[]).includes(s) ? (s as SettingsSection) : "general";
}

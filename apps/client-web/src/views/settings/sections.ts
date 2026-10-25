/** Settings sections, grouped by the decision being made. Kept apart from the views so the location code can read them. */
export type SettingsSection = "agents" | "models" | "approvals" | "project" | "usage" | "general" | "diagnostics";
export const SETTINGS_SECTIONS: readonly SettingsSection[] = ["agents", "models", "approvals", "project", "usage", "general", "diagnostics"];

/** Where an older link or hash pointed before the sections were regrouped. */
const MOVED: Record<string, SettingsSection> = { agent: "agents", account: "models" };

/** A section from the hash, the old names mapped to the new; null when there is none. */
export function sectionOf(raw: string | null | undefined): SettingsSection | null {
  if (!raw) return null;
  const s = MOVED[raw] ?? raw;
  return (SETTINGS_SECTIONS as readonly string[]).includes(s) ? (s as SettingsSection) : null;
}

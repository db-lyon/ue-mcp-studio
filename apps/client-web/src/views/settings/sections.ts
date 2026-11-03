/** Settings sections, grouped by the decision being made. Kept apart from the views so the location code can read them. */
export type BuiltinSection = "agents" | "models" | "approvals" | "project" | "general" | "remote" | "diagnostics";
/** A section an extension adds: `ext:<extension>:<contribution id>`. */
export type ExtensionSection = `ext:${string}:${string}`;
export type SettingsSection = BuiltinSection | ExtensionSection;
/** Remote control is listed only while it is offered; the hub opens General for it otherwise (useRemoteAvailable). */
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

/**
 * A section from the hash, the old names mapped to the new; null when there is
 * none, an extension's kept as written, and General for any other unknown name.
 */
export function sectionOf(raw: string | null | undefined): SettingsSection | null {
  if (!raw) return null;
  if (isExtensionSection(raw)) return raw;
  const s = MOVED[raw.toLowerCase()] ?? raw.toLowerCase();
  return (SETTINGS_SECTIONS as readonly string[]).includes(s) ? (s as BuiltinSection) : "general";
}

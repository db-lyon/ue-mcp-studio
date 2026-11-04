// STUB: owned by agent-b; replaced at merge.
export type BuiltinSection = "agents" | "models" | "approvals" | "project" | "general" | "remote" | "diagnostics";
export type ExtensionSection = `ext:${string}:${string}`;
export type SettingsSection = BuiltinSection | ExtensionSection;
export const SETTINGS_SECTIONS: readonly BuiltinSection[] = ["agents", "models", "approvals", "project", "general", "remote", "diagnostics"];

export function sectionOf(raw: string | null | undefined): SettingsSection | null {
  if (!raw) return null;
  if ((SETTINGS_SECTIONS as readonly string[]).includes(raw)) return raw as BuiltinSection;
  return /^ext:[^:]+:[^:]+$/.test(raw) ? (raw as ExtensionSection) : null;
}

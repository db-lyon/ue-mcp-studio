/**
 * Settings in the shell (client-web views/SettingsHub.tsx at phone width): the
 * section list, or one section under All settings. The screens are in
 * screens/settings.
 */
import type { StudioTheme } from "@ue-mcp-studio/shared";
import type { DaemonState } from "../state";
import type { SettingsSection } from "./settings/sections";
import { SettingsScreen } from "../screens/settings/SettingsScreen";

export type { SettingsSection } from "./settings/sections";

export function SettingsHub({ daemon, section, onSection, onTheme, updates = 0 }: { daemon: DaemonState; section: SettingsSection | null; onSection: (s: SettingsSection | null) => void; onTheme: (t: StudioTheme) => void; updates?: number; narrow?: boolean }) {
  return <SettingsScreen daemon={daemon} section={section} onSection={onSection} onTheme={onTheme} updates={updates} />;
}

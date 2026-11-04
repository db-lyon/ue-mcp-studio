// STUB: owned by agent-b; replaced at merge.
import { View } from "react-native";
import type { StudioTheme } from "@ue-mcp-studio/shared";
import type { DaemonState } from "../state";
import type { SettingsSection } from "./settings/sections";

export type { SettingsSection } from "./settings/sections";

export function SettingsHub(_props: { daemon: DaemonState; section: SettingsSection | null; onSection: (s: SettingsSection | null) => void; onTheme: (t: StudioTheme) => void; updates?: number; narrow?: boolean }) {
  return <View style={{ flex: 1 }} />;
}

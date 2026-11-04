/**
 * The screens area.tsx draws for a scenario, as the shell will show them:
 * Settings at the scenario's section, Plugins, the feedback sheet over the
 * Settings list, and an update the computer runs over the Settings list.
 */
import { useState, type ReactNode } from "react";
import { View } from "react-native";
import { parseLocation } from "@ue-mcp-studio/client-core";
import { SCENARIOS } from "./harness";
import { SettingsScreen } from "../src/screens/settings/SettingsScreen";
import { PluginsScreen } from "../src/screens/plugins/PluginsScreen";
import { FeedbackSheet } from "../src/screens/feedback/FeedbackSheet";
import { UpdateNotices } from "../src/screens/updates/UpdateNotices";

function Settings({ initial }: { initial: string | null }) {
  const [section, setSection] = useState<string | null>(initial);
  return <SettingsScreen section={section} onSection={setSection} />;
}

function WithFeedback() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <Settings initial={null} />
      {open ? <FeedbackSheet onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** The scene for a scenario, or undefined when this area does not draw it. */
export function areaScene(name: string): (() => ReactNode) | undefined {
  const s = SCENARIOS[name];
  if (!s) return undefined;
  if (name.startsWith("feedback-")) return () => <WithFeedback />;
  if (name.startsWith("update-"))
    return () => (
      <View style={{ flex: 1 }}>
        <View style={{ flex: 1, minHeight: 0 }}>
          <Settings initial={null} />
        </View>
        <UpdateNotices />
      </View>
    );
  const at = parseLocation(s.hash ?? "");
  if (at.tab === "Plugins") return () => <PluginsScreen />;
  if (at.tab === "Settings") return () => <Settings initial={at.section} />;
  return undefined;
}

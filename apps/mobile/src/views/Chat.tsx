// STUB: owned by chat-core; replaced at merge.
import { View } from "react-native";
import type { SettingsSection } from "./settings/sections";

/** The chat: the session list and the open conversation. `nav` asks it to show a session, or its list (null); `n` tells requests apart. */
export function Chat(_props: { nav: { session: string | null; n: number }; active: boolean; onSettings: (s: SettingsSection) => void }) {
  return <View style={{ flex: 1 }} />;
}

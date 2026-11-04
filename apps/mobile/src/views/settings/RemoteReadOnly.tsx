// STUB: owned by agent-b (settings). The web client's views/settings/RemoteReadOnly.tsx; the app is always a paired browser.
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { font, useTheme } from "../../ui";

/** Why a paired browser cannot change a setting: it decides where prompts go or what runs on the computer. */
export const REMOTE_CHANGE_NOTE = "Change this from Studio on the computer.";

export function RemoteReadOnly({ children }: { children: ReactNode; remote?: boolean }) {
  const t = useTheme();
  return (
    <View pointerEvents="box-only" accessibilityState={{ disabled: true }}>
      <Text style={[font(t, "sans", 400, 12, 1.55), { color: t.c.dim }]}>{REMOTE_CHANGE_NOTE}</Text>
      {children}
    </View>
  );
}

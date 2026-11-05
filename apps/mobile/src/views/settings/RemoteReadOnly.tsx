import type { ReactNode } from "react";
import { View } from "react-native";
import { REMOTE_CHANGE_NOTE } from "@ue-mcp-studio/client-core";
import { Txt } from "../../screens/settings/controls";

/** Why a paired browser cannot change a setting: it decides where prompts go or what runs on the computer. */
export { REMOTE_CHANGE_NOTE } from "@ue-mcp-studio/client-core";

/**
 * In a paired browser, shows its children read only under the note above:
 * the web client's disabled fieldset.remote-readonly, the note's 8px below it
 * and what it covers at 70% with nothing pressable. The computer refuses these
 * writes from a paired client anyway (remotePath, remoteBodyAllowed); this
 * keeps the page from offering them. The app is always a paired client.
 */
export function RemoteReadOnly({ children, remote = true }: { children: ReactNode; remote?: boolean }) {
  if (!remote) return <>{children}</>;
  return (
    <View accessibilityState={{ disabled: true }} testID="remote-readonly">
      <Txt size={12} tone="dim" style={{ marginBottom: 8 }}>
        {REMOTE_CHANGE_NOTE}
      </Txt>
      <View pointerEvents="none" style={{ opacity: 0.7 }}>
        {children}
      </View>
    </View>
  );
}

/** Plugins in the shell (client-web views/Plugins.tsx): read only on a phone, which is always a paired client. */
import type { DaemonState } from "../state";
import { PluginsScreen } from "../screens/plugins/PluginsScreen";

export function PluginsView({ daemon }: { daemon: DaemonState; remote?: boolean }) {
  return <PluginsScreen daemon={daemon} />;
}

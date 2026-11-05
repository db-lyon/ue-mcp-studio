/**
 * One open project: the shell the web client draws on a phone, around the
 * project's tabs (AppShell).
 */
import type { PanelLocation, Transport } from "@ue-mcp-studio/client-core";
import type { Device } from "../relay";
import { AppShell } from "../AppShell";

export function ProjectScreen(props: { device: Device; onBack: () => void; onUnpaired: (message: string) => void; onPair?: () => void; transport?: Transport; initial?: PanelLocation }) {
  return <AppShell {...props} />;
}

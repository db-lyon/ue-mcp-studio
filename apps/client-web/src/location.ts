/**
 * Where the panel is: its tab, the Settings section, and the open session,
 * kept in the URL's hash (#/chat/<session>, #/settings/<section>, #/playtests,
 * #/plugins). A reload reads it back, and Studio's window carries the hash
 * to the daemon's new address when ue-mcp restarts on another port, so the
 * panel comes back where it was. The draft lives with the session, agent side.
 */
import { formatLocation, parseLocation, type PanelLocation } from "@ue-mcp-studio/client-core";

export { formatLocation, parseLocation, type PanelLocation, type Tab } from "@ue-mcp-studio/client-core";

export function readLocation(): PanelLocation {
  return parseLocation(typeof window === "undefined" ? "" : window.location.hash);
}

/** Merge a change into the hash without a navigation or a history entry. */
export function writeLocation(change: Partial<PanelLocation>): void {
  if (typeof window === "undefined") return;
  const next = formatLocation({ ...readLocation(), ...change });
  if (next !== window.location.hash) window.history.replaceState(window.history.state, "", next);
}

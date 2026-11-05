/**
 * Where the open project's panel is: its tab, the Settings section and the
 * open session, as the web client keeps it in the URL's hash
 * (apps/client-web/src/location.ts). The app has no hash, so it is kept here,
 * seeded from the project's start location; the same names read and write it.
 */
import type { PanelLocation } from "@ue-mcp-studio/client-core";

export { formatLocation, parseLocation, type PanelLocation, type Tab } from "@ue-mcp-studio/client-core";

let current: PanelLocation = { tab: "Chat", session: null, section: null };

export function readLocation(): PanelLocation {
  return current;
}

/** Merge a change into where the panel is. */
export function writeLocation(change: Partial<PanelLocation>): void {
  current = { ...current, ...change };
}

/** Start a project's panel at a location, or Chat's list. */
export function resetLocation(start?: PanelLocation): void {
  current = start ?? { tab: "Chat", session: null, section: null };
}

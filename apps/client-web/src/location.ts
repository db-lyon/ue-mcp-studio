/**
 * Where the panel is: its tab, the Settings section, and the open session,
 * kept in the URL's hash (#/chat/<session>, #/settings/<section>, #/playtests,
 * #/flows, #/plugins). A reload reads it back, and Studio's window carries the hash
 * to the daemon's new address when ue-mcp restarts on another port, so the
 * panel comes back where it was. The draft lives with the session, agent side.
 */
export type Tab = "Chat" | "Playtests" | "Flows" | "Plugins" | "Settings";

export interface PanelLocation {
  tab: Tab;
  session: string | null;
  section: string | null;
}

const TABS: Record<string, Tab> = { chat: "Chat", playtests: "Playtests", flows: "Flows", plugins: "Plugins", settings: "Settings" };

/** A session id or section name as it may appear in the hash. */
const SAFE = /^[A-Za-z0-9_-]{1,128}$/;

export function parseLocation(hash: string): PanelLocation {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const tab = TABS[parts[0]?.toLowerCase() ?? ""] ?? "Chat";
  const rest = parts[1] && SAFE.test(parts[1]) ? parts[1] : null;
  return { tab, session: tab === "Chat" ? rest : null, section: tab === "Settings" ? rest : null };
}

export function formatLocation(l: PanelLocation): string {
  const head = `#/${l.tab.toLowerCase()}`;
  const rest = l.tab === "Chat" ? l.session : l.tab === "Settings" ? l.section : null;
  return rest && SAFE.test(rest) ? `${head}/${rest}` : head;
}

export function readLocation(): PanelLocation {
  return parseLocation(typeof window === "undefined" ? "" : window.location.hash);
}

/** Merge a change into the hash without a navigation or a history entry. */
export function writeLocation(change: Partial<PanelLocation>): void {
  if (typeof window === "undefined") return;
  const next = formatLocation({ ...readLocation(), ...change });
  if (next !== window.location.hash) window.history.replaceState(window.history.state, "", next);
}

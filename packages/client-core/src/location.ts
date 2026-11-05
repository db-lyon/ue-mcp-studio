/**
 * Where the panel is: its tab, the Settings section, and the open session, as
 * the web client keeps it in the URL's hash (#/chat/<session>,
 * #/settings/<section>, #/playtests, #/plugins). The mobile app reads the same
 * shape, so a location means the same screen on both.
 */
export type Tab = "Chat" | "Playtests" | "Plugins" | "Settings";

export interface PanelLocation {
  tab: Tab;
  session: string | null;
  section: string | null;
}

const TABS: Record<string, Tab> = { chat: "Chat", playtests: "Playtests", plugins: "Plugins", settings: "Settings" };

/** A session id or section name as it may appear in the hash; a section may also be an extension's. */
const SAFE = /^[A-Za-z0-9_-]{1,128}$/;
const SECTION = /^(?:[A-Za-z0-9_-]{1,128}|ext:[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,64})$/;

export function parseLocation(hash: string): PanelLocation {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const tab = TABS[parts[0]?.toLowerCase() ?? ""] ?? "Chat";
  const rest = parts[1] ?? "";
  return { tab, session: tab === "Chat" && SAFE.test(rest) ? rest : null, section: tab === "Settings" && SECTION.test(rest) ? rest : null };
}

export function formatLocation(l: PanelLocation): string {
  const head = `#/${l.tab.toLowerCase()}`;
  const rest = l.tab === "Chat" ? l.session : l.tab === "Settings" ? l.section : null;
  return rest && (l.tab === "Settings" ? SECTION : SAFE).test(rest) ? `${head}/${rest}` : head;
}

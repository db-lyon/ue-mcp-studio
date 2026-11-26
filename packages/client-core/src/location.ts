/**
 * Where the panel is: its tab, the Settings section, the open session and,
 * on Playtests, the hub screen, as the web client keeps it in the URL's hash
 * (#/chat/<session>, #/settings/<section>, #/playtests,
 * #/playtests/goals/<id>). The mobile app reads the same shape,
 * so a location means the same screen on both. A hash that names no tab,
 * such as the old #/viewport, lands on Chat. The old #/plugins opens
 * Settings, Plugins.
 */
export type Tab = "Chat" | "Playtests" | "Settings";

export interface PanelLocation {
  tab: Tab;
  session: string | null;
  section: string | null;
  /** On Playtests: the hub screen's path after #/playtests/, still encoded (see parseHubPath). Absent for the overview. */
  sub?: string | null;
}

const TABS: Record<string, Tab> = { chat: "Chat", playtests: "Playtests", settings: "Settings" };

/** A session id or section name as it may appear in the hash; a section may also be an extension's. */
const SAFE = /^[A-Za-z0-9_-]{1,128}$/;
const SECTION = /^(?:[A-Za-z0-9_-]{1,128}|ext:[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,64})$/;
/** A hub path: a screen name, at most one encodeURIComponent'd id and the editor's edit or new, nothing that could climb or inject. */
const HUB_SUB = /^(?:arrangements|arrangement(?:\/[A-Za-z0-9%._~!*'()-]{1,600})?|(?:queue|checks|goals|milestones|runs|clips)(?:\/[A-Za-z0-9%._~!*'()-]{1,600}(?:\/(?:edit|new))?)?)$/;

export function parseLocation(hash: string): PanelLocation {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0]?.toLowerCase() === "plugins") return { tab: "Settings", session: null, section: "plugins" };
  const tab = TABS[parts[0]?.toLowerCase() ?? ""] ?? "Chat";
  const rest = parts[1] ?? "";
  const sub = tab === "Playtests" ? parts.slice(1, 4).join("/") : "";
  return {
    tab,
    session: tab === "Chat" && SAFE.test(rest) ? rest : null,
    section: tab === "Settings" && SECTION.test(rest) ? rest : null,
    ...(sub && HUB_SUB.test(sub) && parts.length <= 4 ? { sub } : {}),
  };
}

export function formatLocation(l: PanelLocation): string {
  const head = `#/${l.tab.toLowerCase()}`;
  if (l.tab === "Playtests") return l.sub && HUB_SUB.test(l.sub) ? `${head}/${l.sub}` : head;
  const rest = l.tab === "Chat" ? l.session : l.tab === "Settings" ? l.section : null;
  return rest && (l.tab === "Settings" ? SECTION : SAFE).test(rest) ? `${head}/${rest}` : head;
}

/**
 * Where the panel is: its tab, the Settings section, the open session and,
 * on Playtests, the hub screen, as the web client keeps it in the URL's hash
 * (#/chat/<session>, #/settings/<section>, #/viewport, #/playtests,
 * #/playtests/goals/<id>, #/plugins). The mobile app reads the same shape,
 * so a location means the same screen on both.
 */
export type Tab = "Chat" | "Viewport" | "Playtests" | "Plugins" | "Settings";

export interface PanelLocation {
  tab: Tab;
  session: string | null;
  section: string | null;
  /** On Playtests: the hub screen's path after #/playtests/, still encoded (see parseHubPath). Absent for the overview. */
  sub?: string | null;
}

const TABS: Record<string, Tab> = { chat: "Chat", viewport: "Viewport", playtests: "Playtests", plugins: "Plugins", settings: "Settings" };

/** A session id or section name as it may appear in the hash; a section may also be an extension's. */
const SAFE = /^[A-Za-z0-9_-]{1,128}$/;
const SECTION = /^(?:[A-Za-z0-9_-]{1,128}|ext:[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,64})$/;
/** A hub path: a screen name and at most one encodeURIComponent'd id, nothing that could climb or inject. */
const HUB_SUB = /^(?:inbox|queue|checks|goals|runs)(?:\/[A-Za-z0-9%._~!*'()-]{1,600})?$/;

export function parseLocation(hash: string): PanelLocation {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const tab = TABS[parts[0]?.toLowerCase() ?? ""] ?? "Chat";
  const rest = parts[1] ?? "";
  const sub = tab === "Playtests" ? parts.slice(1, 3).join("/") : "";
  return {
    tab,
    session: tab === "Chat" && SAFE.test(rest) ? rest : null,
    section: tab === "Settings" && SECTION.test(rest) ? rest : null,
    ...(sub && HUB_SUB.test(sub) && parts.length <= 3 ? { sub } : {}),
  };
}

export function formatLocation(l: PanelLocation): string {
  const head = `#/${l.tab.toLowerCase()}`;
  if (l.tab === "Playtests") return l.sub && HUB_SUB.test(l.sub) ? `${head}/${l.sub}` : head;
  const rest = l.tab === "Chat" ? l.session : l.tab === "Settings" ? l.section : null;
  return rest && (l.tab === "Settings" ? SECTION : SAFE).test(rest) ? `${head}/${rest}` : head;
}

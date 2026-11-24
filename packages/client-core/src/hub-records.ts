/**
 * Playtest Hub records in links. A link in a reply, a tool result or a card
 * that names a playtest, goal, milestone or run the hub knows opens that
 * record on the Playtests tab, where an asset link would otherwise open the
 * playtest's script in the editor. Anything the hub does not know keeps its
 * own link.
 *
 * A record is named three ways: the hub's own address (#/playtests/goals/<id>,
 * which the agent is told to write), a playtest script's object path (as
 * every asset is linked), or a bare goal, run or check id.
 */
import { checkId as checkIdOf, parseCheckId, type HubOverview, type PlaytestEntry } from "@ue-mcp-studio/shared";
import { parseLocation } from "./location.js";
import { hubPath, parseHubPath, type HubRoute } from "./hub.js";

/** What a client knows of the hub's records, to tell a record's link from any other. */
export interface HubRecordIndex {
  /** Playtest script package paths, lower case (Unreal paths ignore case), to their check ids. */
  scripts: ReadonlyMap<string, string>;
  goals: ReadonlySet<string>;
  runs: ReadonlySet<string>;
}

export const EMPTY_HUB_RECORDS: HubRecordIndex = { scripts: new Map(), goals: new Set(), runs: new Set() };

/** The index from the hub's overview: every playtest (also under the path goals still name after a move), goal and milestone, and the runs it lists. */
export function hubRecordIndex(o: Pick<HubOverview, "goals" | "checks" | "recent">): HubRecordIndex {
  const scripts = new Map<string, string>();
  const runs = new Set<string>();
  for (const c of o.checks) {
    scripts.set(c.check.target.toLowerCase(), c.id);
    if (c.renamedFrom && !scripts.has(c.renamedFrom.toLowerCase())) scripts.set(c.renamedFrom.toLowerCase(), c.id);
    if (c.last) runs.add(c.last.runId);
  }
  for (const r of o.recent) runs.add(r.runId);
  return { scripts, goals: new Set(o.goals.map((g) => g.goal.id)), runs };
}

/** The index from the playtest list (the phone's Playtests page): its scripts, which are the hub's playtests. */
export function playtestRecordIndex(list: readonly Pick<PlaytestEntry, "script" | "deleted">[]): HubRecordIndex {
  const scripts = new Map<string, string>();
  for (const e of list) if (!e.deleted) scripts.set(e.script.toLowerCase(), checkIdOf({ kind: "script", target: e.script }));
  return { scripts, goals: new Set(), runs: new Set() };
}

const HUB_ADDRESS = /^#\/?playtests(?:\/|$)/i;

/** Whether a link is written as the hub's own address, #/playtests/... */
export const isHubAddress = (target: string | null | undefined): boolean => HUB_ADDRESS.test((target ?? "").trim());

/** The hub screen an address names: #/playtests/goals/<id> is that goal, an unknown screen the overview. Null when it is not a hub address. */
export function hubAddressRoute(target: string | null | undefined): HubRoute | null {
  const t = (target ?? "").trim();
  if (!HUB_ADDRESS.test(t)) return null;
  return parseHubPath(parseLocation(t).sub);
}

/** An object path's package: /Game/T/PT_A.PT_A:Sub is /Game/T/PT_A. */
const packageOf = (path: string): string => path.replace(/:.*$/, "").replace(/\.[^/]*$/, "");

/**
 * The hub record a link names, as the screen that shows it, or null when the
 * hub does not know it: then the link keeps doing what it did. A hub address
 * always names its screen; an object path, goal, run or check id only when
 * `index` holds it. Without an index (the hub is off) only addresses resolve.
 */
export function hubRecordRoute(target: string | null | undefined, index: HubRecordIndex | null): HubRoute | null {
  const t = (target ?? "").trim();
  if (!t) return null;
  const address = hubAddressRoute(t);
  if (address) return address;
  if (!index) return null;
  if (t.startsWith("/")) {
    const id = index.scripts.get(packageOf(t).toLowerCase());
    return id ? { screen: "check", checkId: id } : null;
  }
  if (index.goals.has(t)) return { screen: "goal", goalId: t };
  if (index.runs.has(t)) return { screen: "run", runId: t };
  const check = parseCheckId(t);
  const id = check ? index.scripts.get(check.target.toLowerCase()) : undefined;
  return id ? { screen: "check", checkId: id } : null;
}

/** The playtest script a route shows, for a client whose Playtests page lists scripts rather than hub screens (the phone). */
export function hubRouteScript(route: HubRoute): string | null {
  const id = route.screen === "check" ? route.checkId : route.screen === "draft" ? route.checkId : undefined;
  return id ? parseCheckId(id)?.target ?? null : null;
}

/** The location change that opens a route on the Playtests tab. */
export const hubRecordLocation = (route: HubRoute): { tab: "Playtests"; sub: string | null } => ({ tab: "Playtests", sub: hubPath(route) || null });

/** The words around a hub record's link. */
export const HUB_RECORD_COPY = {
  /** A record link's tooltip. */
  opensInHub: "Opens in the Playtest Hub",
  /** The hub's way to a playtest's script asset. */
  openInUnreal: "Open in Unreal",
  openInUnrealTip: "Open the script asset in the editor",
} as const;

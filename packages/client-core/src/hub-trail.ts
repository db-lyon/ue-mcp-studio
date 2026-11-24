/**
 * The way the user came to a hub screen: every screen they opened, in order,
 * and the tab they came from (a link in the chat). Back and the breadcrumbs
 * follow it, never the hub's own map of which screen sits under which. A
 * screen reached fresh (a pasted link, a reload with no history) has a trail
 * of one, and only then does a screen fall back to its parent in the map.
 *
 * The web client keeps each history entry's trail in that entry's state, so
 * the browser's Back and Forward bring the trail with them.
 */
import type { HubOverview } from "@ue-mcp-studio/shared";
import { HUB_COPY, hubPath, type HubRoute } from "./hub.js";
import { DRAFT_COPY } from "./drafting.js";

export interface HubTrail {
  /** The screens opened, oldest first; the last is the screen on show. */
  routes: HubRoute[];
  /** The tab the first screen was opened from, such as "Chat"; absent when the hub was opened on its own. */
  from?: string;
}

/** How many screens a trail keeps; older ones fall off its start. */
export const HUB_TRAIL_MAX = 50;

const same = (a: HubRoute, b: HubRoute): boolean => hubPath(a) === hubPath(b) && a.screen === b.screen;

/** A trail that starts at a screen: opened fresh, or from another tab. */
export const freshTrail = (route: HubRoute, from?: string): HubTrail => (from ? { routes: [route], from } : { routes: [route] });

/** The trail after opening a screen: it grows by one, unless the screen is already on show. */
export function trailPush(t: HubTrail | null | undefined, route: HubRoute): HubTrail {
  if (!t || t.routes.length === 0) return freshTrail(route);
  if (same(t.routes[t.routes.length - 1], route)) return t;
  const routes = [...t.routes, route];
  // A trail cut at its start no longer starts where the user came from.
  return routes.length > HUB_TRAIL_MAX ? { routes: routes.slice(-HUB_TRAIL_MAX) } : { ...t, routes };
}

const isRoute = (r: unknown): r is HubRoute => !!r && typeof r === "object" && typeof (r as { screen?: unknown }).screen === "string";

/**
 * The trail a history entry kept (its state's `hubTrail`), when it ends at
 * the screen on show; a fresh trail otherwise, as for a pasted link.
 */
export function trailOf(state: unknown, route: HubRoute): HubTrail {
  const kept = (state as { hubTrail?: unknown } | null)?.hubTrail as Partial<HubTrail> | undefined;
  const routes = Array.isArray(kept?.routes) ? kept!.routes.filter(isRoute) : [];
  if (routes.length === 0 || routes.length !== kept!.routes!.length || !same(routes[routes.length - 1], route)) return freshTrail(route);
  return typeof kept!.from === "string" && kept!.from ? { routes, from: kept!.from } : { routes };
}

/** Whether the trail has somewhere to go back to: an earlier screen, or the tab it was opened from. */
export const trailHasBack = (t: HubTrail): boolean => t.routes.length > 1 || !!t.from;

/** A screen's name in the breadcrumbs. */
export function hubRouteLabel(route: HubRoute, o: Pick<HubOverview, "goals" | "checks" | "recent"> | null): string {
  switch (route.screen) {
    case "overview": return HUB_COPY.overview;
    case "milestones": return HUB_COPY.milestones;
    case "goals": return HUB_COPY.goals;
    case "library": return HUB_COPY.library;
    case "queue": return HUB_COPY.queue;
    case "goal": return o?.goals.find((g) => g.goal.id === route.goalId)?.goal.title ?? (route.goalId);
    case "check": return o?.checks.find((c) => c.id === route.checkId)?.name ?? HUB_COPY.playtest;
    case "run": {
      const name = o?.recent.find((r) => r.runId === route.runId)?.name;
      return name ? HUB_TRAIL_COPY.runOf(name) : HUB_TRAIL_COPY.run;
    }
    case "draft": return route.checkId ? DRAFT_COPY.editPlaytest : DRAFT_COPY.newPlaytest;
  }
}

/** One breadcrumb: its name, and how many steps back it is (1 is the screen before this one). The last crumb is the screen on show, 0 steps. */
export interface HubCrumb {
  label: string;
  steps: number;
  /** The screen, or null for the tab the trail came from. */
  route: HubRoute | null;
}

/** The breadcrumbs for a trail, oldest first: the tab it came from, then each screen. At most `max`, the oldest folded away. */
export function trailCrumbs(t: HubTrail, o: Pick<HubOverview, "goals" | "checks" | "recent"> | null, max = 5): { crumbs: HubCrumb[]; folded: number } {
  const n = t.routes.length;
  const all: HubCrumb[] = [
    ...(t.from ? [{ label: t.from, steps: n, route: null }] : []),
    ...t.routes.map((r, i) => ({ label: hubRouteLabel(r, o), steps: n - 1 - i, route: r })),
  ];
  const folded = Math.max(0, all.length - max);
  return { crumbs: all.slice(folded), folded };
}

export const HUB_TRAIL_COPY = {
  run: "Run",
  runOf: (name: string) => `Run of ${name}`,
  /** The breadcrumbs' landmark. */
  trail: "Where you came from",
  back: "Back",
} as const;

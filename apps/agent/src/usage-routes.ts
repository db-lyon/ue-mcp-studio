/**
 * Usage's dashboard, under /v1/ext/studio:
 *
 *   GET /usage/summary?from&to&groupBy&agent&vendor&route&source  totals, rows, days and sessions for a period
 *   GET /usage/records?from&to&...&limit                           the ledger's records, newest first
 *   GET /usage/plans?from&to                                       one meter per signed-in plan route
 *   GET /usage/warnings                                            budgets near or past their limit, plan windows, cache drops
 *   GET /usage/cache                                               how each connected vendor caches
 *   GET /prices, PUT /prices { prices }                            the price table and the user's own prices
 *
 * Every figure comes from the ledger's records; a period before the ledger
 * starts is never filled in.
 */
import type { DaemonExtensionApi } from "ue-mcp/daemon";
import { USAGE_SOURCES, type Budgets, type PlanMeter, type TokenKinds, type UsageGroup, type UsageRecord, type UsageSource, type UsageWarning } from "@ue-mcp-studio/shared";
import { budgetStates, budgetWarnings, cachedShare, summarize, type Ledger, type RecordFilter } from "./ledger.js";
import type { PlanStore } from "./plans.js";
import { CACHE_EXPLAINERS, type PriceStore } from "./prices.js";

const GROUPS: readonly UsageGroup[] = ["agent", "model", "vendor", "route", "source", "session"];

export interface UsageRouteOptions {
  ledger: Ledger;
  prices: PriceStore;
  plans: PlanStore;
  budgets: () => Budgets;
  /** Display names. */
  agentName: (id: string) => string;
  modelName: (vendor: string, model: string) => string;
  vendorName: (vendor: string) => string;
  routeName: (route: string) => string;
  sessionTitle: (id: string) => string | null;
  /** The plan routes signed in on this machine, and their names. */
  signedIn: () => Array<{ route: PlanMeter["route"]; name: string }>;
  /** The vendors a connected route reaches, for the cache explainers. */
  connectedVendors: () => string[];
  now?: () => Date;
}

const SOURCE_NAME: Record<UsageSource, string> = { chat: "Chat", quick: "Quick ask", flow: "Flows", playtest: "Playtests" };

const ZERO: TokenKinds = { input: null, cacheRead: null, cacheWrite: null, output: null };
const plus = (a: number | null, b: number | null): number | null => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));
const sum = (list: UsageRecord[]): TokenKinds =>
  list.reduce((t, r) => ({ input: plus(t.input, r.tokens.input), cacheRead: plus(t.cacheRead, r.tokens.cacheRead), cacheWrite: plus(t.cacheWrite, r.tokens.cacheWrite), output: plus(t.output, r.tokens.output) }), ZERO);

/**
 * A model group's key, `<vendor>:<model>`, split back. A custom endpoint's
 * vendor holds a colon itself (`endpoint:<id>`), and a model id may too.
 */
export function splitModelKey(key: string): { vendor: string; model: string } {
  const i = key.indexOf(":", key.startsWith("endpoint:") ? 9 : 0);
  return i < 0 ? { vendor: key, model: "" } : { vendor: key.slice(0, i), model: key.slice(i + 1) };
}

/** A period from the query: from and to as ISO dates; the last 7 local days by default. */
export function periodOf(q: Record<string, unknown>, now: Date): { from: Date; to: Date } | { error: string } {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const to = typeof q.to === "string" ? new Date(q.to) : new Date(day.getTime() + 86_400_000);
  const from = typeof q.from === "string" ? new Date(q.from) : new Date(day.getTime() - 6 * 86_400_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return { error: "from and to must be ISO dates" };
  if (from >= to) return { error: "from must be before to" };
  if (to.getTime() - from.getTime() > 366 * 86_400_000) return { error: "a period is at most a year" };
  return { from, to };
}

function filterOf(q: Record<string, unknown>): RecordFilter {
  const f: RecordFilter = {};
  for (const k of ["agent", "vendor", "route", "source", "session"] as const) if (typeof q[k] === "string" && q[k]) f[k] = q[k] as string;
  return f;
}

/** Warnings: budgets past the warning share, plan windows near their limit, and a route whose cached share fell. */
export function usageWarnings(o: UsageRouteOptions, now: Date): UsageWarning[] {
  const b = o.budgets();
  const out = budgetWarnings(budgetStates(b, o.ledger.today(), o.ledger.thisMonth(), now), b.warnAt);
  for (const { route, name } of o.signedIn()) {
    if (route === "studio") continue;
    for (const w of o.plans.get(route).windows) {
      if (w.used === null || (w.used < b.warnAt && w.status !== "rejected")) continue;
      out.push({
        kind: "plan-limit",
        severity: w.status === "rejected" ? "bad" : "warn",
        text: `${name}: ${Math.round(w.used * 100)}% of the ${w.label.toLowerCase()} limit used`,
        detail: w.resetsAt ? `It resets ${new Date(w.resetsAt).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" })}. Past it, ${name} refuses calls until then.` : `Past it, ${name} refuses calls until the window resets.`,
      });
    }
  }
  // A cached share that fell by a third or more this week against last: often a changing prompt prefix.
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const week = 7 * 86_400_000;
  const starts = o.ledger.starts();
  if (starts && new Date(starts) <= new Date(day.getTime() - 2 * week)) {
    const recent = o.ledger.records(new Date(day.getTime() - week), day);
    const before = o.ledger.records(new Date(day.getTime() - 2 * week), new Date(day.getTime() - week));
    for (const route of new Set(recent.map((r) => r.route))) {
      const a = cachedShare(sum(before.filter((r) => r.route === route)));
      const c = cachedShare(sum(recent.filter((r) => r.route === route)));
      if (a !== null && c !== null && a >= 0.3 && c <= a * (2 / 3)) {
        out.push({
          kind: "cache-drop",
          severity: "info",
          text: `${o.routeName(route)}: cached reads fell from ${Math.round(a * 100)}% to ${Math.round(c * 100)}% of input`,
          detail: "Calls are rereading more at the full input price. A prompt that changes early, such as instructions edited often or a different screenshot size, breaks the cache.",
        });
      }
    }
  }
  return out;
}

export function registerUsageRoutes(api: DaemonExtensionApi, o: UsageRouteOptions): void {
  const now = () => (o.now ? o.now() : new Date());
  const bad = (error: string) => ({ status: 400, body: { error } });
  const label = (g: UsageGroup, key: string): string => {
    if (g === "agent") return o.agentName(key);
    if (g === "model") {
      const { vendor, model } = splitModelKey(key);
      return o.modelName(vendor, model);
    }
    if (g === "vendor") return o.vendorName(key);
    if (g === "route") return o.routeName(key);
    if (g === "source") return SOURCE_NAME[key as UsageSource] ?? key;
    return o.sessionTitle(key) ?? "A deleted session";
  };

  api.route("GET", "/usage/summary", (req) => {
    const q = req.query as Record<string, unknown>;
    const p = periodOf(q, now());
    if ("error" in p) return bad(p.error);
    const groupBy = (q.groupBy ?? "agent") as UsageGroup;
    if (!GROUPS.includes(groupBy)) return bad(`groupBy must be one of ${GROUPS.join(", ")}`);
    if (typeof q.source === "string" && q.source && !USAGE_SOURCES.includes(q.source as UsageSource)) return bad(`source must be one of ${USAGE_SOURCES.join(", ")}`);
    const body = summarize(o.ledger, { ...p, groupBy, filter: filterOf(q), prices: o.prices.all(), label, sessions: (id) => { const t = o.sessionTitle(id); return t === null ? null : { title: t }; } });
    return { body };
  });

  api.route("GET", "/usage/records", (req) => {
    const q = req.query as Record<string, unknown>;
    const p = periodOf(q, now());
    if ("error" in p) return bad(p.error);
    const limit = Math.min(Math.max(Number(q.limit ?? 200) || 200, 1), 2000);
    const all = o.ledger.records(p.from, p.to, filterOf(q));
    return { body: { records: all.slice(-limit).reverse(), total: all.length } };
  });

  api.route("GET", "/usage/plans", (req) => {
    const p = periodOf(req.query as Record<string, unknown>, now());
    if ("error" in p) return bad(p.error);
    const meters: PlanMeter[] = o.signedIn().map(({ route, name }) => {
      const reported = route === "studio" ? { reportedAt: null, windows: [] } : o.plans.get(route);
      return { route, name, signedIn: true, ...reported, tokens: sum(o.ledger.records(p.from, p.to, { route })) };
    });
    return { body: { plans: meters } };
  });

  api.route("GET", "/usage/warnings", () => ({ body: { warnings: usageWarnings(o, now()) } }));

  api.route("GET", "/usage/cache", () => {
    const vendors = new Set(o.connectedVendors());
    return { body: { explainers: CACHE_EXPLAINERS.filter((c) => vendors.has(c.vendor)) } };
  });

  api.route("GET", "/prices", () => ({ body: o.prices.table() }));

  api.route("PUT", "/prices", (req) => {
    try {
      const body = o.prices.setOwn((req.body as { prices?: unknown } | undefined)?.prices);
      api.events.publish("usage.changed", {});
      return { body };
    } catch (e) {
      return bad(e instanceof Error ? e.message : String(e));
    }
  });
}

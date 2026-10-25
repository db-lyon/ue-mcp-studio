/**
 * The usage ledger and the dashboard that reads it: one record per model
 * call, in four token kinds, with estimated cost only where a price exists.
 */

/** A route's or a call's tokens by kind. null: the vendor did not report that kind, which is never shown as zero. */
export interface TokenKinds {
  input: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  output: number | null;
}

/** Where a run started. */
export type UsageSource = "chat" | "quick" | "flow" | "playtest";
export const USAGE_SOURCES: readonly UsageSource[] = ["chat", "quick", "flow", "playtest"];

/** One model call, as the ledger keeps it: monthly JSONL in the extension's data dir. */
export interface UsageRecord {
  at: string;
  sessionId: string | null;
  turnId: string | null;
  /** "main", "worker", a project subagent's name, or "playtest-runner". */
  agentId: string;
  parentAgentId: string | null;
  source: UsageSource;
  vendor: string;
  model: string;
  /** claude, chatgpt, studio, key, or endpoint:<id>. */
  route: string;
  /** A fallback in use: the configured model this call stood in for. */
  insteadOf?: { vendor: string; model: string };
  tokens: TokenKinds;
  durationMs: number;
}

/** What budgets count from a call: input, cache writes and output. */
export const budgetTokens = (t: TokenKinds): number => (t.input ?? 0) + (t.cacheWrite ?? 0) + (t.output ?? 0);

/** A price per million tokens of each kind, dated and sourced. null: the vendor has no such charge, or none is known. */
export interface Price {
  vendor: string;
  /** A model id, or a prefix ending in * for a family. */
  model: string;
  perMTok: TokenKinds;
  /** ISO date the price was read. */
  asOf: string;
  source: string;
  /** The user's own price, set in Usage. */
  user?: boolean;
}

/** GET /prices */
export interface PriceTable {
  prices: Price[];
  /** The table Studio shipped with, by date. */
  shippedAsOf: string;
}

export type UsageGroup = "agent" | "model" | "vendor" | "route" | "source" | "session";

/** One group's totals. */
export interface UsageRow {
  key: string;
  label: string;
  tokens: TokenKinds;
  /** Input, cache writes and output: what budgets count. */
  budgetTokens: number;
  /** Cached reads as a share of all input read, 0 to 1; null when the route reports no cache reads. */
  cachedShare: number | null;
  calls: number;
  runs: number;
  /** Estimated cost in USD where every call in the row is billed per token and has a price; null otherwise. */
  cost: number | null;
  /** Some calls had no price, or ran on a sign-in billed by plan. */
  costPartial: boolean;
  /** For agent rows: the model and route its latest call ran on. */
  lastModel?: string;
  lastRoute?: string;
  /** For agent rows: calls that ran on a fallback. */
  fallbackCalls?: number;
}

/** GET /usage/summary?from&to&groupBy&agent&vendor&route&source */
export interface UsageSummary {
  from: string;
  to: string;
  groupBy: UsageGroup;
  total: UsageRow;
  rows: UsageRow[];
  /** Budget tokens per local calendar day, per group key, for the stacked bars. */
  days: Array<{ day: string; byKey: Record<string, number> }>;
  /** The same totals for the period of equal length before, for the comparison under each tile. */
  previous: { budgetTokens: number; cachedShare: number | null } | null;
  /** The first record the ledger holds, so the page never implies data from before it. */
  ledgerStarts: string | null;
  /** Sessions in the period with their totals. */
  sessions: Array<{ id: string; title: string; agents: string[]; budgetTokens: number; cost: number | null; turns: number; last: string }>;
}

/** One limit window a sign-in reports. */
export interface PlanWindow {
  /** five_hour, seven_day, seven_day_opus, primary, secondary. */
  kind: string;
  label: string;
  /** 0 to 1, as the route reported it. */
  used: number | null;
  resetsAt: string | null;
  status: "allowed" | "warning" | "rejected" | "unknown";
}

/** GET /usage/plans: one meter per signed-in plan route. */
export interface PlanMeter {
  route: "claude" | "chatgpt" | "studio";
  name: string;
  signedIn: boolean;
  /** When the route last reported its windows; null when it never has. */
  reportedAt: string | null;
  windows: PlanWindow[];
  /** Tokens Studio sent through this route in the period asked for. */
  tokens: TokenKinds;
}

/** A warning on the dashboard. */
export interface UsageWarning {
  kind: "budget" | "fallback" | "plan-limit" | "cache-drop";
  text: string;
  detail: string;
  severity: "warn" | "bad" | "info";
}

/** How a vendor caches, under the same four headings for every vendor. */
export interface CacheExplainer {
  vendor: string;
  name: string;
  what: string;
  whoDecides: string;
  cachedReadCost: string;
  howLong: string;
  asOf: string;
  source: string;
}

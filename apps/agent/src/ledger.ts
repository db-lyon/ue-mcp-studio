/**
 * The usage ledger: one record per model call, monthly JSONL in the
 * extension's data dir, and the sums the dashboard and the per-day budgets
 * read from it. Every figure comes from these records; nothing is estimated
 * for a time the ledger did not see.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { budgetTokens, type BudgetReached, type Budgets, type UsageWarning, type Price, type TokenKinds, type UsageGroup, type UsageRecord, type UsageRow, type UsageSummary } from "@ue-mcp-studio/shared";
import { costOf, priceFor } from "./prices.js";

/** The local calendar day of a time, as YYYY-MM-DD. */
export function localDay(at: string | Date): string {
  const d = typeof at === "string" ? new Date(at) : at;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const monthOf = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

export interface RecordFilter {
  agent?: string;
  vendor?: string;
  route?: string;
  source?: string;
  session?: string;
}

const matches = (r: UsageRecord, f: RecordFilter): boolean =>
  (!f.agent || r.agentId === f.agent) && (!f.vendor || r.vendor === f.vendor) && (!f.route || r.route === f.route) && (!f.source || r.source === f.source) && (!f.session || r.sessionId === f.session);

/** Routes billed per token: a vendor key or a custom endpoint. A sign-in is billed by plan. */
export const billedPerToken = (route: string): boolean => route === "key" || route.startsWith("endpoint:");

const add = (a: TokenKinds, b: TokenKinds): TokenKinds => ({
  input: a.input === null && b.input === null ? null : (a.input ?? 0) + (b.input ?? 0),
  cacheRead: a.cacheRead === null && b.cacheRead === null ? null : (a.cacheRead ?? 0) + (b.cacheRead ?? 0),
  cacheWrite: a.cacheWrite === null && b.cacheWrite === null ? null : (a.cacheWrite ?? 0) + (b.cacheWrite ?? 0),
  output: a.output === null && b.output === null ? null : (a.output ?? 0) + (b.output ?? 0),
});
const ZERO: TokenKinds = { input: null, cacheRead: null, cacheWrite: null, output: null };

/** Cached reads as a share of all input read; null when nothing reported cache reads. */
export function cachedShare(t: TokenKinds): number | null {
  if (t.cacheRead === null) return null;
  const all = (t.input ?? 0) + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0);
  return all > 0 ? t.cacheRead / all : null;
}

export class Ledger {
  private readonly dir: string;
  /** Records appended this process, by month, so a busy run is not reread from disk per call. */
  private readonly cache = new Map<string, UsageRecord[]>();

  constructor(dataDir: string, private readonly now: () => Date = () => new Date()) {
    this.dir = path.join(dataDir, "usage");
  }

  private file(month: string): string {
    return path.join(this.dir, `${month}.jsonl`);
  }

  private month(month: string): UsageRecord[] {
    const hit = this.cache.get(month);
    if (hit) return hit;
    let list: UsageRecord[] = [];
    try {
      list = fs.readFileSync(this.file(month), "utf-8").split("\n").filter(Boolean).flatMap((l) => {
        try {
          return [JSON.parse(l) as UsageRecord];
        } catch {
          // A torn last line from a crash: the rest still count.
          return [];
        }
      });
    } catch {
      // No calls that month.
    }
    this.cache.set(month, list);
    return list;
  }

  append(r: Omit<UsageRecord, "at"> & { at?: string }): UsageRecord {
    const rec: UsageRecord = { ...r, at: r.at ?? this.now().toISOString() };
    const month = monthOf(new Date(rec.at));
    // Read the month before writing to it, so the cache never holds this record twice.
    const list = this.month(month);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this.file(month), `${JSON.stringify(rec)}\n`);
    list.push(rec);
    return rec;
  }

  /** Records from `from` (inclusive) to `to` (exclusive). */
  records(from: Date, to: Date, f: RecordFilter = {}): UsageRecord[] {
    const out: UsageRecord[] = [];
    const cur = new Date(from.getFullYear(), from.getMonth(), 1);
    while (cur < to) {
      for (const r of this.month(monthOf(cur))) {
        const t = new Date(r.at);
        if (t >= from && t < to && matches(r, f)) out.push(r);
      }
      cur.setMonth(cur.getMonth() + 1);
    }
    return out;
  }

  /** When the ledger's first record was written, or null when it has none. */
  starts(): string | null {
    let files: string[];
    try {
      files = fs.readdirSync(this.dir).filter((n) => /^\d{4}-\d{2}\.jsonl$/.test(n)).sort();
    } catch {
      return null;
    }
    for (const f of files) {
      const first = this.month(f.slice(0, 7))[0];
      if (first) return first.at;
    }
    return null;
  }

  /** Budget tokens spent today, by agent and in all, for the per-day budgets. */
  today(): { byAgent: Map<string, number>; total: number } {
    const n = this.now();
    const start = new Date(n.getFullYear(), n.getMonth(), n.getDate());
    const byAgent = new Map<string, number>();
    let total = 0;
    for (const r of this.records(start, new Date(start.getTime() + 86_400_000))) {
      const b = budgetTokens(r.tokens);
      byAgent.set(r.agentId, (byAgent.get(r.agentId) ?? 0) + b);
      total += b;
    }
    return { byAgent, total };
  }

  /** Budget tokens spent this calendar month, and from when the ledger has records in it. */
  thisMonth(): { total: number; since: string } {
    const n = this.now();
    const start = new Date(n.getFullYear(), n.getMonth(), 1);
    const list = this.records(start, new Date(n.getFullYear(), n.getMonth() + 1, 1));
    return { total: list.reduce((s, r) => s + budgetTokens(r.tokens), 0), since: list[0]?.at ?? start.toISOString() };
  }
}

const keyOf = (r: UsageRecord, g: UsageGroup): string =>
  g === "agent" ? r.agentId : g === "model" ? `${r.vendor}:${r.model}` : g === "vendor" ? r.vendor : g === "route" ? r.route : g === "source" ? r.source : r.sessionId ?? "none";

/** One group's totals from its records. */
export function rowOf(key: string, label: string, list: UsageRecord[], prices: Price[]): UsageRow {
  let tokens = ZERO;
  let cost = 0;
  let priced = true;
  let anyKey = false;
  const runs = new Set<string>();
  for (const r of list) {
    tokens = add(tokens, r.tokens);
    runs.add(`${r.turnId ?? r.sessionId ?? r.at}:${r.agentId}`);
    if (!billedPerToken(r.route)) {
      priced = false;
      continue;
    }
    anyKey = true;
    const c = costOf(priceFor(prices, r.vendor, r.model), r.tokens);
    if (c === null) priced = false;
    else cost += c;
  }
  const last = list.at(-1);
  return {
    key,
    label,
    tokens,
    budgetTokens: list.reduce((s, r) => s + budgetTokens(r.tokens), 0),
    cachedShare: cachedShare(tokens),
    calls: list.length,
    runs: runs.size,
    cost: anyKey ? cost : null,
    costPartial: anyKey && !priced,
    ...(last ? { lastModel: last.model, lastRoute: last.route } : {}),
    fallbackCalls: list.filter((r) => r.insteadOf).length,
  };
}

export interface SummaryOptions {
  from: Date;
  to: Date;
  groupBy: UsageGroup;
  filter: RecordFilter;
  prices: Price[];
  label: (g: UsageGroup, key: string) => string;
  sessions: (id: string) => { title: string } | null;
}

/** The dashboard's numbers for a period: totals, rows by group, days, the period before, and sessions. */
export function summarize(ledger: Ledger, o: SummaryOptions): UsageSummary {
  const list = ledger.records(o.from, o.to, o.filter);
  const groups = new Map<string, UsageRecord[]>();
  for (const r of list) {
    const k = keyOf(r, o.groupBy);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const rows = [...groups.entries()].map(([k, l]) => rowOf(k, o.label(o.groupBy, k), l, o.prices)).sort((a, b) => b.budgetTokens - a.budgetTokens);
  const days = new Map<string, Record<string, number>>();
  for (let d = new Date(o.from.getFullYear(), o.from.getMonth(), o.from.getDate()); d < o.to; d.setDate(d.getDate() + 1)) days.set(localDay(d), {});
  for (const r of list) {
    const day = days.get(localDay(r.at));
    if (!day) continue;
    const k = keyOf(r, o.groupBy);
    day[k] = (day[k] ?? 0) + budgetTokens(r.tokens);
  }
  const span = o.to.getTime() - o.from.getTime();
  const before = ledger.records(new Date(o.from.getTime() - span), o.from, o.filter);
  const starts = ledger.starts();
  const bySession = new Map<string, UsageRecord[]>();
  for (const r of list) if (r.sessionId) bySession.set(r.sessionId, [...(bySession.get(r.sessionId) ?? []), r]);
  return {
    from: o.from.toISOString(),
    to: o.to.toISOString(),
    groupBy: o.groupBy,
    total: rowOf("total", "All", list, o.prices),
    rows,
    days: [...days.entries()].map(([day, byKey]) => ({ day, byKey })),
    // Only a period the ledger fully saw is compared against.
    previous: starts && new Date(starts) <= new Date(o.from.getTime() - span)
      ? (({ budgetTokens, cachedShare, cost, costPartial, runs, calls }) => ({ budgetTokens, cachedShare, cost, costPartial, runs, calls }))(rowOf("previous", "", before, o.prices))
      : null,
    ledgerStarts: starts,
    sessions: [...bySession.entries()].map(([id, l]) => {
      const row = rowOf(id, "", l, o.prices);
      return {
        id,
        title: o.sessions(id)?.title ?? "A deleted session",
        agents: [...new Set(l.map((r) => r.agentId))],
        budgetTokens: row.budgetTokens,
        cost: row.cost,
        turns: new Set(l.map((r) => r.turnId).filter(Boolean)).size,
        last: l.at(-1)!.at,
      };
    }).sort((a, b) => b.last.localeCompare(a.last)),
  };
}

/** Every per-day and per-month budget and how far the ledger says each has gone, for the gate and the warnings. */
export function budgetStates(b: Budgets, today: { byAgent: Map<string, number>; total: number }, month: { total: number }, now: Date): BudgetReached[] {
  const day = localDay(now);
  const out: BudgetReached[] = [];
  for (const [agent, a] of Object.entries(b.agents)) {
    if (a.perDayTokens !== null) out.push({ scope: "agent-day", agent, spent: today.byAgent.get(agent) ?? 0, limit: a.perDayTokens, period: day, onLimit: a.onLimit === "ask" ? "ask" : "stop" });
  }
  if (b.team.perDayTokens !== null) out.push({ scope: "team-day", spent: today.total, limit: b.team.perDayTokens, period: day, onLimit: b.team.onLimit });
  if (b.team.perMonthTokens !== null) out.push({ scope: "team-month", spent: month.total, limit: b.team.perMonthTokens, period: monthOf(now), onLimit: b.team.onLimit });
  return out;
}

/** The first budget an agent's next call is past: its own day, then the team's day, then the month. */
export function overBudget(states: BudgetReached[], agentId: string): BudgetReached | null {
  return states.find((s) => s.spent >= s.limit && (s.scope !== "agent-day" || s.agent === agentId)) ?? null;
}

/** What a reached budget says, in the chat and on the approval. */
export const AGENT_LABEL = (id: string): string => (id === "main" ? "the main agent" : id === "worker" ? "Studio's worker" : id === "playtest-runner" ? "the playtest runner" : id);

/** A budget by whose it is and its period, as a sentence's subject. */
export function budgetName(r: BudgetReached, name: (agent: string) => string = AGENT_LABEL): string {
  return r.scope === "agent-day" ? `${name(r.agent ?? "")}'s budget for today` : r.scope === "team-day" ? "the budget for all agents today" : "the budget for all agents this month";
}

/** What a reached budget says, in the chat and on the approval. */
export function budgetText(r: BudgetReached, name: (agent: string) => string = AGENT_LABEL): string {
  return `${budgetName(r, name)} (${r.spent.toLocaleString("en-US")} of ${r.limit.toLocaleString("en-US")} tokens) in Usage > Budgets was reached`;
}

/** Budgets past the warning share, as dashboard warnings. */
export function budgetWarnings(states: BudgetReached[], warnAt: number, name: (agent: string) => string = AGENT_LABEL): UsageWarning[] {
  return states.filter((s) => s.spent >= s.limit * warnAt).map((s) => {
    const share = Math.round((s.spent / s.limit) * 100);
    const reached = s.spent >= s.limit;
    return {
      kind: "budget" as const,
      severity: reached ? ("bad" as const) : ("warn" as const),
      text: `${share}% of ${budgetName(s, name)}`,
      detail: reached ? (s.onLimit === "ask" ? "Each further call asks you first." : "Runs stop until the period ends or the budget is raised.") : `${s.spent.toLocaleString("en-US")} of ${s.limit.toLocaleString("en-US")} tokens. Warnings start at ${Math.round(warnAt * 100)}%.`,
    };
  });
}

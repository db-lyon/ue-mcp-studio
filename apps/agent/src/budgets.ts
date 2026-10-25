/**
 * Every budget, per machine and project: one file in the extension's data
 * dir, never in the project. Usage > Budgets is the only place they are
 * edited (GET and PUT /budgets).
 *
 * The first read moves the two limits Studio had before agents had names into
 * it: the turn token limit (Settings > Agent > Usage) becomes the main agent's
 * per-run tokens, and the Assign to subagent budget becomes the Playtest
 * runner's per-run minutes and tokens. Both old places are still written when
 * those change, so an older Studio reads the same limits.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  BUDGET_LIMITS,
  DEFAULT_BUDGETS,
  MAIN_AGENT_ID,
  NO_BUDGET,
  PLAYTEST_RUNNER_ID,
  type Budget,
  type BudgetLimitAction,
  type Budgets,
  type PlaytestBudget,
} from "@ue-mcp-studio/shared";

const LIMIT_ACTIONS: readonly BudgetLimitAction[] = ["stop-and-report", "ask", "fallback-model"];

/** Where the limits lived before this file, read once to migrate and written to keep an older Studio in step. */
export interface LegacyBudgets {
  turnTokenLimit(): number | null;
  setTurnTokenLimit(n: number | null): void;
  playtestBudget(): PlaytestBudget;
  setPlaytestBudget(b: PlaytestBudget): void;
}

const tokensOk = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= BUDGET_LIMITS.minTokens && (v as number) <= BUDGET_LIMITS.maxTokens;
const minutesOk = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= BUDGET_LIMITS.maxMinutes;

/** A field from a file or a request: null, a valid number, or undefined when it is neither. */
const field = (v: unknown, ok: (x: unknown) => boolean): number | null | undefined => (v === null ? null : ok(v) ? (v as number) : undefined);

/** One agent's budget, every field checked; throws naming the first bad one. `base` fills what the update leaves out. */
export function budgetFrom(v: unknown, base: Budget, where: string): Budget {
  if (!v || typeof v !== "object") throw new Error(`${where} must be an object`);
  const b = v as Record<string, unknown>;
  const out = { ...base };
  for (const [k, ok] of [["perRunTokens", tokensOk], ["perDayTokens", tokensOk]] as const) {
    if (b[k] === undefined) continue;
    const n = field(b[k], ok);
    if (n === undefined) throw new Error(`${where}.${k} must be null or a whole number from ${BUDGET_LIMITS.minTokens} to ${BUDGET_LIMITS.maxTokens}`);
    out[k] = n;
  }
  if (b.perRunMinutes !== undefined) {
    const n = field(b.perRunMinutes, minutesOk);
    if (n === undefined) throw new Error(`${where}.perRunMinutes must be null or a whole number from 1 to ${BUDGET_LIMITS.maxMinutes}`);
    out.perRunMinutes = n;
  }
  if (b.onLimit !== undefined) {
    if (!LIMIT_ACTIONS.includes(b.onLimit as BudgetLimitAction)) throw new Error(`${where}.onLimit must be one of ${LIMIT_ACTIONS.join(", ")}`);
    out.onLimit = b.onLimit as BudgetLimitAction;
  }
  return out;
}

/** A stored file, each bad field at its default rather than failing. */
function parse(raw: unknown): Budgets {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const team = (r.team && typeof r.team === "object" ? r.team : {}) as Record<string, unknown>;
  const agents: Record<string, Budget> = {};
  for (const [id, b] of Object.entries((r.agents && typeof r.agents === "object" ? r.agents : {}) as Record<string, unknown>)) {
    const x = (b && typeof b === "object" ? b : {}) as Record<string, unknown>;
    agents[id] = {
      perRunTokens: field(x.perRunTokens, tokensOk) ?? null,
      perRunMinutes: field(x.perRunMinutes, minutesOk) ?? null,
      perDayTokens: field(x.perDayTokens, tokensOk) ?? null,
      onLimit: LIMIT_ACTIONS.includes(x.onLimit as BudgetLimitAction) ? (x.onLimit as BudgetLimitAction) : "stop-and-report",
    };
  }
  const warn = typeof r.warnAt === "number" && r.warnAt >= BUDGET_LIMITS.minWarn && r.warnAt <= BUDGET_LIMITS.maxWarn ? r.warnAt : DEFAULT_BUDGETS.warnAt;
  return {
    team: {
      perDayTokens: field(team.perDayTokens, tokensOk) ?? null,
      perMonthTokens: field(team.perMonthTokens, tokensOk) ?? null,
      onLimit: team.onLimit === "stop" ? "stop" : "ask",
    },
    agents,
    warnAt: warn,
  };
}

/** PUT /budgets: the parts given change. agents: { id: partial budget, or null to remove its row }. */
export interface BudgetsUpdate {
  team?: Partial<Budgets["team"]>;
  agents?: Record<string, Partial<Budget> | null>;
  warnAt?: number;
}

export class BudgetStore {
  private readonly file: string;

  constructor(dataDir: string, private readonly legacy?: LegacyBudgets) {
    this.file = path.join(dataDir, "budgets.json");
  }

  /** The budgets, migrated from the old limits on first read. */
  get(): Budgets {
    try {
      return parse(JSON.parse(fs.readFileSync(this.file, "utf-8")));
    } catch {
      const migrated = this.migrate();
      this.write(migrated);
      return migrated;
    }
  }

  /** The first file: today's two limits as the first rows, and nothing else limited. */
  private migrate(): Budgets {
    const b: Budgets = structuredClone(DEFAULT_BUDGETS);
    const turn = this.legacy?.turnTokenLimit() ?? null;
    b.agents[MAIN_AGENT_ID] = { ...NO_BUDGET, perRunTokens: turn };
    const loop = this.legacy?.playtestBudget();
    if (loop) b.agents[PLAYTEST_RUNNER_ID] = { perRunTokens: loop.tokens, perRunMinutes: loop.minutes, perDayTokens: null, onLimit: "ask" };
    return b;
  }

  /** One agent's budget, nothing limited when it has no row. */
  agent(id: string): Budget {
    return this.get().agents[id] ?? NO_BUDGET;
  }

  update(u: BudgetsUpdate): Budgets {
    if (!u || typeof u !== "object") throw new Error("body must be an object");
    const b = this.get();
    if (u.team !== undefined) {
      const t = u.team as Record<string, unknown>;
      for (const k of ["perDayTokens", "perMonthTokens"] as const) {
        if (t[k] === undefined) continue;
        const n = field(t[k], tokensOk);
        if (n === undefined) throw new Error(`team.${k} must be null or a whole number from ${BUDGET_LIMITS.minTokens} to ${BUDGET_LIMITS.maxTokens}`);
        b.team[k] = n;
      }
      if (t.onLimit !== undefined) {
        if (t.onLimit !== "ask" && t.onLimit !== "stop") throw new Error("team.onLimit must be ask or stop");
        b.team.onLimit = t.onLimit;
      }
    }
    for (const [id, next] of Object.entries(u.agents ?? {})) {
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error(`no agent ${id}`);
      if (next === null) {
        delete b.agents[id];
        continue;
      }
      const budget = budgetFrom(next, b.agents[id] ?? NO_BUDGET, `agents.${id}`);
      // The playtest loop has to end: its runner always has both limits.
      if (id === PLAYTEST_RUNNER_ID && (budget.perRunTokens === null || budget.perRunMinutes === null)) {
        throw new Error("The Playtest runner keeps a per-run token and minute limit, so an assigned playtest always stops.");
      }
      b.agents[id] = budget;
    }
    if (u.warnAt !== undefined) {
      if (typeof u.warnAt !== "number" || u.warnAt < BUDGET_LIMITS.minWarn || u.warnAt > BUDGET_LIMITS.maxWarn) throw new Error(`warnAt must be from ${BUDGET_LIMITS.minWarn} to ${BUDGET_LIMITS.maxWarn}`);
      b.warnAt = u.warnAt;
    }
    this.write(b);
    // An older Studio reads the old places: keep them in step.
    const main = b.agents[MAIN_AGENT_ID];
    if (u.agents && MAIN_AGENT_ID in u.agents) this.legacy?.setTurnTokenLimit(main?.perRunTokens ?? null);
    const runner = b.agents[PLAYTEST_RUNNER_ID];
    if (u.agents && PLAYTEST_RUNNER_ID in u.agents && runner?.perRunTokens && runner.perRunMinutes) {
      this.legacy?.setPlaytestBudget({ tokens: runner.perRunTokens, minutes: runner.perRunMinutes });
    }
    return b;
  }

  /** What one assigned playtest's loop may spend, from the Playtest runner's row. */
  playtestBudget(): PlaytestBudget {
    const r = this.agent(PLAYTEST_RUNNER_ID);
    const fallback = this.legacy?.playtestBudget();
    return {
      minutes: r.perRunMinutes ?? fallback?.minutes ?? BUDGET_LIMITS.maxMinutes,
      tokens: r.perRunTokens ?? fallback?.tokens ?? BUDGET_LIMITS.maxTokens,
    };
  }

  private write(b: Budgets): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(b, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

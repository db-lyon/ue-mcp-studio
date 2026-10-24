/**
 * What Studio keeps about this project's playtests that ue-mcp's scripts do
 * not hold: who may start a run (the Playtest runs setting, manual or
 * automatic) and the player each step is for. One file in the extension's
 * per-project data directory.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_PLAYTEST_BUDGET, qaScriptKey, type PlaytestBudget, type PlaytestRunsMode } from "@ue-mcp-studio/shared";

interface Saved {
  runs?: PlaytestRunsMode;
  players?: Record<string, Record<string, string>>;
  budget?: Partial<PlaytestBudget>;
}

/** The most a budget may be set to: a day, and a billion tokens. */
export const MAX_BUDGET: PlaytestBudget = { minutes: 24 * 60, tokens: 1_000_000_000 };

/** A budget from a request, or why it is not one. Each field is a positive whole number up to its cap. */
export function budgetOf(v: unknown): PlaytestBudget | string {
  const b = (v ?? {}) as Partial<Record<keyof PlaytestBudget, unknown>>;
  const ok = (n: unknown, max: number) => Number.isInteger(n) && (n as number) > 0 && (n as number) <= max;
  if (!ok(b.minutes, MAX_BUDGET.minutes)) return `playtestBudget.minutes must be a whole number from 1 to ${MAX_BUDGET.minutes}`;
  if (!ok(b.tokens, MAX_BUDGET.tokens)) return `playtestBudget.tokens must be a whole number from 1 to ${MAX_BUDGET.tokens}`;
  return { minutes: b.minutes as number, tokens: b.tokens as number };
}

export class PlaytestStore {
  private readonly file: string;
  private data: Saved;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "playtests.json");
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, "utf-8")) as Saved;
    } catch {
      this.data = {};
    }
  }

  /** Playtest runs: manual unless the user chose automatic. */
  runs(): PlaytestRunsMode {
    return this.data.runs === "automatic" ? "automatic" : "manual";
  }

  setRuns(mode: PlaytestRunsMode): void {
    this.data.runs = mode;
    this.write();
  }

  /** What one Assign to subagent loop may spend: the defaults unless the user set them. */
  budget(): PlaytestBudget {
    const saved = budgetOf({ ...DEFAULT_PLAYTEST_BUDGET, ...(this.data.budget ?? {}) });
    return typeof saved === "string" ? { ...DEFAULT_PLAYTEST_BUDGET } : saved;
  }

  setBudget(budget: PlaytestBudget): void {
    this.data.budget = budget;
    this.write();
  }

  /** The player each step of a script is for, by step index. */
  players(script: string): Record<number, string> {
    const p = this.data.players?.[qaScriptKey(script)] ?? {};
    return Object.fromEntries(Object.entries(p).map(([k, v]) => [Number(k), v]));
  }

  setPlayers(script: string, players: Record<number, string>): void {
    const key = qaScriptKey(script);
    const all = { ...(this.data.players ?? {}) };
    if (Object.keys(players).length === 0) delete all[key];
    else all[key] = Object.fromEntries(Object.entries(players).map(([k, v]) => [String(k), v]));
    this.data.players = all;
    this.write();
  }

  private write(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}

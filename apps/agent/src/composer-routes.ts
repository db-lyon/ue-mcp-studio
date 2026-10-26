/**
 * Settings routes grouped by decision, under /v1/ext/studio:
 *
 *   GET  /budgets                      every budget, the definition, and the agents that have rows
 *   PUT  /budgets                      { team?, agents?, warnAt? }
 *   GET  /context-strategy             what ue-mcp.yml gives other MCP clients, and what each strategy costs
 *   PUT  /context-strategy             { strategy }: writes context.strategy and restarts ue-mcp after the turn in progress
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isMap, parseDocument } from "yaml";
import type { DaemonExtensionApi } from "ue-mcp/daemon";
import {
  BUDGET_DEFINITION,
  MAX_SUBAGENTS_PER_TURN,
  CONTEXT_STRATEGIES,
  AGENT_CONTEXT_STRATEGIES,
  type AgentContextStrategy,
  type AgentContextView,
  MAIN_AGENT_ID,
  PLAYTEST_RUNNER_ID,
  PUBLISHED_SEEDS,
  type ClientContextStrategy,
  type ContextStrategy,
} from "@ue-mcp-studio/shared";
import type { BudgetStore, BudgetsUpdate } from "./budgets.js";
import type { SettingsStore } from "./settings.js";

export interface ComposerRouteOptions {
  settings: SettingsStore;
  budgets: BudgetStore;
  /** Restart ue-mcp once no turn is in progress, so a changed ue-mcp.yml is read. */
  restartUeMcp: () => Promise<unknown>;
  /** The runs that have a budget row, by id and name: the main agent and the Playtest runner. */
  agents: () => Array<{ id: string; name: string }>;
  /** Studio's own agent's context strategy: what it is, and what each would cost. */
  agentContext?: { view(): AgentContextView };
}

/** The context strategy ue-mcp.yml names, or null when it names none. */
export function ymlStrategy(text: string): ContextStrategy | null {
  try {
    const s = (parseDocument(text).toJS() as { context?: { strategy?: unknown } } | null)?.context?.strategy;
    return typeof s === "string" && (CONTEXT_STRATEGIES as readonly string[]).includes(s.toLowerCase()) ? (s.toLowerCase() as ContextStrategy) : null;
  } catch {
    return null;
  }
}

/** ue-mcp.yml with context.strategy set, comments and layout kept. Micro is the default, so it is written as no setting, as `ue-mcp init` does. */
export function withStrategy(text: string, strategy: ContextStrategy): string {
  const doc = parseDocument(text || "{}\n");
  if (strategy === "micro") {
    const ctx = doc.get("context");
    if (isMap(ctx)) {
      ctx.delete("strategy");
      if (ctx.items.length === 0) doc.delete("context");
    }
  } else {
    doc.setIn(["context", "strategy"], strategy);
  }
  return doc.toString();
}

/** The env override ue-mcp honours over the file, as the daemon's own process sees it. */
export function envStrategy(env: NodeJS.ProcessEnv = process.env): ContextStrategy | null {
  const v = env.UE_MCP_CONTEXT_STRATEGY?.trim().toLowerCase();
  return v && (CONTEXT_STRATEGIES as readonly string[]).includes(v) ? (v as ContextStrategy) : null;
}

type Projector = { project(o: { strategy: ContextStrategy; categories?: string[] }): { seedTokens: number } };

export function registerComposerRoutes(api: DaemonExtensionApi, o: ComposerRouteOptions): void {
  const bad = (e: unknown) => ({ status: 400, body: { error: e instanceof Error ? e.message : String(e) } });
  const projectDir = api.projectDir;

  const budgetsBody = () => ({
    budgets: o.budgets.get(),
    definition: BUDGET_DEFINITION,
    agents: o.agents().map(({ id, name }) => ({ id, name })),
    // A spend safety limit: kept where it always was, in usage.subagentsPerTurn, which the runner reads.
    helpersPerTurn: o.settings.usage().subagentsPerTurn,
  });
  api.route("GET", "/budgets", () => ({ body: budgetsBody() }));
  api.route("PUT", "/budgets", (req) => {
    const { helpersPerTurn, ...rest } = (req.body ?? {}) as BudgetsUpdate & { helpersPerTurn?: unknown };
    try {
      if (helpersPerTurn !== undefined) {
        if (!Number.isInteger(helpersPerTurn) || (helpersPerTurn as number) < 1 || (helpersPerTurn as number) > MAX_SUBAGENTS_PER_TURN) throw new Error(`helpersPerTurn must be a whole number from 1 to ${MAX_SUBAGENTS_PER_TURN}`);
        o.settings.update({ usage: { subagentsPerTurn: helpersPerTurn as number } });
      }
      o.budgets.update(rest);
    } catch (e) {
      return bad(e);
    }
    api.events.publish("budgets.changed", {});
    return { body: budgetsBody() };
  });

  const yml = path.join(projectDir, "ue-mcp.yml");
  const readYml = (): string => (fs.existsSync(yml) ? fs.readFileSync(yml, "utf-8") : "");
  const projector = (api as unknown as { context?: Projector }).context;
  const seeds = (): Pick<ClientContextStrategy, "seeds" | "seedSource"> => {
    if (projector?.project) {
      try {
        const s = Object.fromEntries(CONTEXT_STRATEGIES.map((x) => [x, projector.project({ strategy: x }).seedTokens])) as Record<ContextStrategy, number>;
        return { seeds: s, seedSource: "measured by this ue-mcp" };
      } catch {
        // Fall through to the published figures.
      }
    }
    return { seeds: PUBLISHED_SEEDS, seedSource: "ue-mcp's published figures" };
  };
  const contextView = (): ClientContextStrategy => {
    const named = ymlStrategy(readYml());
    return { strategy: named ?? "micro", fromFile: named !== null, envOverride: envStrategy(), ...seeds() };
  };
  api.route("GET", "/context-strategy", () => ({ body: contextView() }));
  // Studio's own agent: kept in Studio's settings, never in ue-mcp.yml, so other clients are untouched.
  api.route("GET", "/context-strategy/agent", () => (o.agentContext ? { body: o.agentContext.view() } : { status: 404, body: { error: "not available" } }));
  api.route("PUT", "/context-strategy/agent", (req) => {
    const strategy = (req.body as { strategy?: unknown } | undefined)?.strategy;
    if (!(AGENT_CONTEXT_STRATEGIES as readonly unknown[]).includes(strategy)) return bad(`strategy must be one of ${AGENT_CONTEXT_STRATEGIES.join(", ")}`);
    if (strategy === "auto" && o.agentContext && !o.agentContext.view().measurement) return bad("auto needs a measurement, and none ships with this Studio");
    o.settings.update({ usage: { contextStrategy: strategy as AgentContextStrategy } });
    api.events.publish("settings.changed", {});
    return o.agentContext ? { body: o.agentContext.view() } : { status: 204 };
  });
  api.route("PUT", "/context-strategy", async (req) => {
    const strategy = (req.body as { strategy?: unknown } | undefined)?.strategy;
    if (!(CONTEXT_STRATEGIES as readonly unknown[]).includes(strategy)) return bad(`strategy must be one of ${CONTEXT_STRATEGIES.join(", ")}`);
    const before = readYml();
    if ((ymlStrategy(before) ?? "micro") === strategy) return { body: contextView() };
    fs.writeFileSync(yml, withStrategy(before, strategy as ContextStrategy));
    api.events.publish("config.saved", { path: yml });
    await o.restartUeMcp();
    return { body: { ...contextView(), restarting: true } };
  });
}

/** The runs Studio budgets: the main agent's turn, and an assigned playtest's loop. */
export const BUDGET_ROWS: Array<{ id: string; name: string }> = [
  { id: MAIN_AGENT_ID, name: "Main agent" },
  // Per day only: a helper's run is bounded by the turn that started it.
  { id: "worker", name: "Studio's worker" },
  { id: PLAYTEST_RUNNER_ID, name: "Playtest runner" },
];

/** Studio's rows, then one per project subagent by the name its file gives it, for per-day budgets. */
export function budgetRows(subagents: string[]): Array<{ id: string; name: string }> {
  const own = new Set(BUDGET_ROWS.map((r) => r.id));
  return [...BUDGET_ROWS, ...[...new Set(subagents)].filter((n) => !own.has(n)).map((n) => ({ id: n, name: n }))];
}

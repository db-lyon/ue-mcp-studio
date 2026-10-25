/**
 * Settings routes grouped by decision, under /v1/ext/studio:
 *
 *   GET  /instructions                 every instruction file found, in reading order, with sizes and duplicates
 *   PUT  /instructions                 { off, added }: files turned off, and files the user added where they go
 *   GET  /instructions/preview?agent=  the composed text an agent is given
 *   POST /instructions/agents-md       { point?: string[] } create AGENTS.md from the shared files
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
  MAIN_AGENT_ID,
  PLAYTEST_RUNNER_ID,
  PUBLISHED_SEEDS,
  type ClientContextStrategy,
  type ContextStrategy,
  type InstructionSettings,
  type InstructionFile,
} from "@ue-mcp-studio/shared";
import { createAgentsMd, instructionsView, preview, type FileChoice } from "./instructions.js";
import type { BudgetStore, BudgetsUpdate } from "./budgets.js";
import type { SettingsStore } from "./settings.js";

export interface ComposerRouteOptions {
  settings: SettingsStore;
  budgets: BudgetStore;
  /** Restart ue-mcp once no turn is in progress, so a changed ue-mcp.yml is read. */
  restartUeMcp: () => Promise<unknown>;
  /** The agents with a budget row or instruction choice, by id and name. Phase 1: the main agent and the Playtest runner. */
  agents: () => Array<{ id: string; name: string; instructionFiles: FileChoice }>;
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

  const readBy = (file: InstructionFile): string[] =>
    file.on ? o.agents().filter((a) => a.instructionFiles === "all" || (a.instructionFiles !== "none" && a.instructionFiles.only.includes(file.path))).map((a) => a.id) : [];

  api.route("GET", "/instructions", () => ({ body: instructionsView(projectDir, o.settings.instructions(), readBy) }));
  api.route("PUT", "/instructions", (req) => {
    const b = (req.body ?? {}) as Partial<InstructionSettings>;
    if ((b.off !== undefined && !Array.isArray(b.off)) || (b.added !== undefined && !Array.isArray(b.added))) return bad("body must be { off?: string[], added?: { path, after }[] }");
    const current = o.settings.instructions();
    o.settings.setInstructions({ off: b.off ?? current.off, added: b.added ?? current.added });
    return { body: instructionsView(projectDir, o.settings.instructions(), readBy) };
  });
  api.route("GET", "/instructions/preview", (req) => {
    const id = typeof req.query.agent === "string" && req.query.agent ? req.query.agent : null;
    const agent = id ? o.agents().find((a) => a.id === id) : o.agents()[0];
    if (id && !agent) return { status: 404, body: { error: `no agent ${id}` } };
    return { body: preview(projectDir, o.settings.instructions(), agent?.id ?? null, agent?.instructionFiles ?? "all") };
  });
  api.route("POST", "/instructions/agents-md", (req) => {
    const point = (req.body as { point?: unknown } | undefined)?.point;
    try {
      const r = createAgentsMd(projectDir, o.settings.instructions(), Array.isArray(point) ? point.filter((p): p is string => typeof p === "string") : []);
      api.events.publish("instructions.changed", { created: r.written });
      return { status: 201, body: { ...r, view: instructionsView(projectDir, o.settings.instructions(), readBy) } };
    } catch (e) {
      return { status: 409, body: { error: e instanceof Error ? e.message : String(e) } };
    }
  });

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

/** Phase 1's agents: the main agent, and the helper assigned playtests run as. */
export const PHASE1_AGENTS = (projectInstructions: boolean): Array<{ id: string; name: string; instructionFiles: FileChoice }> => [
  { id: MAIN_AGENT_ID, name: "Main agent", instructionFiles: projectInstructions ? "all" : "none" },
  { id: PLAYTEST_RUNNER_ID, name: "Playtest runner", instructionFiles: projectInstructions ? "all" : "none" },
];

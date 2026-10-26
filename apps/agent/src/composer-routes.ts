/**
 * Settings routes grouped by decision, under /v1/ext/studio:
 *
 *   GET  /context-strategy             what ue-mcp.yml gives other MCP clients, and what each strategy costs
 *   PUT  /context-strategy             { strategy }: writes context.strategy and restarts ue-mcp after the turn in progress
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isMap, parseDocument } from "yaml";
import type { DaemonExtensionApi } from "ue-mcp/daemon";
import { required } from "./backend.js";
import {
  CONTEXT_STRATEGIES,
  AGENT_CONTEXT_STRATEGIES,
  type AgentContextStrategy,
  type AgentContextView,
  type ClientContextStrategy,
  type ContextStrategy,
} from "@ue-mcp-studio/shared";
import type { SettingsStore } from "./settings.js";

export interface ComposerRouteOptions {
  settings: SettingsStore;
  /** Restart ue-mcp once no turn is in progress, so a changed ue-mcp.yml is read. */
  restartUeMcp: () => Promise<unknown>;
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

  const yml = path.join(projectDir, "ue-mcp.yml");
  const readYml = (): string => (fs.existsSync(yml) ? fs.readFileSync(yml, "utf-8") : "");
  const projector = required((api as unknown as { context?: Projector }).context, "context projection");
  const seeds = (): Record<ContextStrategy, number> =>
    Object.fromEntries(CONTEXT_STRATEGIES.map((x) => [x, projector.project({ strategy: x }).seedTokens])) as Record<ContextStrategy, number>;
  const contextView = (): ClientContextStrategy => {
    const named = ymlStrategy(readYml());
    return { strategy: named ?? "micro", fromFile: named !== null, envOverride: envStrategy(), seeds: seeds() };
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


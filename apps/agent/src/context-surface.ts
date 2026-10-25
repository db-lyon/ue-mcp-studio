/**
 * How ue-mcp's tools are put to Studio's own agent: Micro (Studio's single
 * ue_mcp tool: search, describe, call), Lean (a tool per category with its
 * action names) or Full (every signature inline). Lean and Full come from the
 * daemon's projection of ue-mcp's own surfaces (feature "context.projection"),
 * so Studio never rebuilds ue-mcp's tools; a daemon without it runs Micro.
 *
 * A call to a projected category tool is read back as the ue_mcp call it is
 * (category, method, args), so approvals, the action effects, the transcript
 * and the checkpoints see one shape on every strategy. A projected tool that
 * is not a category (Lean's catalog) runs through the daemon's context.call.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import type { ActionResult } from "ue-mcp/daemon";
import type { AgentContextStrategy, AgentContextView, ContextStrategy } from "@ue-mcp-studio/shared";
import { CONTEXT_STRATEGIES } from "@ue-mcp-studio/shared";
import { EDITOR_TOOLS } from "./tools.js";

export interface ProjectedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** The category this tool is; null for one that is not (Lean's catalog, the flow tool). */
  category: string | null;
}

export interface Projection {
  strategy: ContextStrategy;
  categories: string[];
  instructions: string;
  tools: ProjectedTool[];
  seedTokens: number;
}

/** The daemon's api.context, as ue-mcp declares it; absent on a daemon before "context.projection". */
export interface ContextApi {
  project(opts: { strategy: ContextStrategy; categories?: string[] }): Projection;
  call(tool: string, input: Record<string, unknown>, opts?: { strategy?: ContextStrategy; categories?: string[] }): Promise<ActionResult>;
}

export function contextApiOf(api: unknown): ContextApi | null {
  const c = (api as { context?: Partial<ContextApi> } | null)?.context;
  return c && typeof c.project === "function" && typeof c.call === "function" ? (c as ContextApi) : null;
}

/* ── Measurements and Auto ───────────────────────────────────────── */

/** ue-mcp's ContextMeasurement, the fields Auto reads. */
export interface ContextMeasurement {
  version: 1;
  measuredAt: string;
  ueMcpVersion: string;
  runs: Array<{
    model: { vendor: string; model: string };
    scope: "1-3" | "4-8" | "9+";
    strategy: ContextStrategy;
    seedTokens: number;
    tasks: Array<{ id: string; totalTokens: number; modelCalls: number; discoveryCalls: number; passed: boolean }>;
  }>;
}

/** A measurement file as shipped, or null when it is missing or not in ue-mcp's format. */
export function readMeasurement(file: string): ContextMeasurement | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<ContextMeasurement>;
    if (v.version !== 1 || typeof v.measuredAt !== "string" || !Array.isArray(v.runs)) return null;
    const ok = v.runs.every((r) => r && CONTEXT_STRATEGIES.includes(r.strategy) && Array.isArray(r.tasks) && typeof r.model?.vendor === "string");
    return ok ? (v as ContextMeasurement) : null;
  } catch {
    return null;
  }
}

/** Where Studio ships its measurement: beside the agent's bundle. */
export const MEASUREMENT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "context-costs.json");

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Auto's pick for a vendor and scope: among the strategies whose pass rate is
 * within one task of the best, the one with the fewest median tokens. Null
 * when the measurement has no runs for that vendor and scope.
 */
export function autoPick(m: ContextMeasurement, vendor: string, scope: "1-3" | "4-8" | "9+"): { strategy: ContextStrategy; why: string } | null {
  const by = new Map<ContextStrategy, { passed: number; tasks: number; tokens: number[] }>();
  for (const r of m.runs) {
    if (r.model.vendor !== vendor || r.scope !== scope) continue;
    const e = by.get(r.strategy) ?? { passed: 0, tasks: 0, tokens: [] };
    for (const t of r.tasks) {
      e.tasks++;
      if (t.passed) e.passed++;
      e.tokens.push(t.totalTokens);
    }
    by.set(r.strategy, e);
  }
  const rated = [...by.entries()].filter(([, e]) => e.tasks > 0).map(([s, e]) => ({ s, rate: e.passed / e.tasks, slack: 1 / e.tasks, med: median(e.tokens) }));
  if (!rated.length) return null;
  const best = Math.max(...rated.map((r) => r.rate));
  const near = rated.filter((r) => r.rate >= best - r.slack).sort((a, b) => a.med - b.med);
  const pick = near[0];
  return { strategy: pick.s, why: `${Math.round(pick.rate * 100)}% of tasks passed at a median ${Math.round(pick.med).toLocaleString("en-US")} tokens` };
}

/* ── The surface a turn is given ─────────────────────────────────── */

/** What the agent is told about the editor on Micro. */
export const MICRO_LINE = "Anything in the running editor (assets, levels, actors, Blueprints, materials, Niagara) goes through ue_mcp: find the action with ue_mcp search, check its parameters with ue_mcp describe, then call it.";

export interface EditorSurface {
  strategy: ContextStrategy;
  /** The editor tools for this turn: Studio's ue_mcp on Micro, ue-mcp's projected tools otherwise, and editor_restart. */
  tools: Anthropic.Beta.BetaToolUnion[];
  /** The projected tools as ue-mcp describes them, for the Agent SDK's tool registry; empty on Micro. */
  projected: ProjectedTool[];
  /** What the agent is told about the editor, and ue-mcp's own instructions for the strategy. */
  line: string;
  instructions: string | null;
  seedTokens: number | null;
  /** A projected category call as the ue_mcp call it is; any other call unchanged. */
  canon(name: string, input: Record<string, unknown>): { name: string; input: Record<string, unknown> };
  /** A projected tool that is not a category: it runs through context.call. */
  passthrough(name: string): ((input: Record<string, unknown>) => Promise<ActionResult>) | null;
}

const RESTART = EDITOR_TOOLS.filter((t) => (t as { name: string }).name !== "ue_mcp");
/** Studio's own tools, which a projected tool of the same name must never shadow. */
const RESERVED = new Set(["ue_mcp", "editor_restart", "shell", "read_file", "write_file", "edit_file", "glob", "grep", "web_fetch", "web_search", "agent", "skill"]);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * A category tool's call read as ue_mcp's: `action` names the method; the
 * parameters are `args` when every other key is one the tool advertises
 * (routing such as an editor target, merged in), else the call is flat.
 */
export function canonCategoryCall(tool: ProjectedTool, input: Record<string, unknown>): Record<string, unknown> {
  const { action, args, ...rest } = input;
  const advertised = new Set(Object.keys((tool.inputSchema.properties as Record<string, unknown> | undefined) ?? {}));
  const envelope = isObj(args) && Object.keys(rest).every((k) => advertised.has(k));
  const params = envelope ? { ...(args as Record<string, unknown>), ...rest } : { ...rest, ...(args !== undefined ? { args } : {}) };
  return { action: "call", category: tool.category, method: typeof action === "string" ? action : "", args: params };
}

export function microSurface(): EditorSurface {
  return {
    strategy: "micro",
    tools: EDITOR_TOOLS,
    projected: [],
    line: MICRO_LINE,
    instructions: null,
    seedTokens: null,
    canon: (name, input) => ({ name, input }),
    passthrough: () => null,
  };
}

function projectedSurface(api: ContextApi, p: Projection): EditorSurface {
  const tools = p.tools.filter((t) => !RESERVED.has(t.name));
  const byName = new Map(tools.map((t) => [t.name, t]));
  const categories = tools.filter((t) => t.category).map((t) => t.name);
  const line = p.strategy === "lean"
    ? `Anything in the running editor (assets, levels, actors, Blueprints, materials, Niagara) goes through ue-mcp's tools, one per category (${categories.join(", ")}): each lists its actions; read an action's parameters with the catalog tool before its first call, then call the category tool with action and args.`
    : `Anything in the running editor (assets, levels, actors, Blueprints, materials, Niagara) goes through ue-mcp's tools, one per category (${categories.join(", ")}), each with every action's signature: call the category tool with action and args.`;
  return {
    strategy: p.strategy,
    tools: [...tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema })), ...RESTART],
    projected: tools,
    line,
    instructions: p.instructions.trim() || null,
    seedTokens: p.seedTokens,
    canon: (name, input) => {
      const t = byName.get(name);
      return t?.category ? { name: "ue_mcp", input: canonCategoryCall(t, input) } : { name, input };
    },
    passthrough: (name) => {
      const t = byName.get(name);
      return t && !t.category ? (input) => api.call(name, input, { strategy: p.strategy }) : null;
    },
  };
}

/**
 * The editor surface each turn gets, by the agent's setting: projected once per
 * strategy and kept until ue-mcp's tools change (a plugin installed or removed).
 */
export class ContextSurfaces {
  private cache = new Map<ContextStrategy, EditorSurface>();

  constructor(
    private readonly api: ContextApi | null,
    private readonly choice: () => AgentContextStrategy,
    private readonly vendor: () => string,
    private readonly measurement: () => ContextMeasurement | null = () => readMeasurement(MEASUREMENT_FILE),
  ) {}

  /** ue-mcp's tools changed: project again on the next turn. */
  invalidate(): void {
    this.cache.clear();
  }

  /** The strategy turns run on now, and why it differs from the choice when it does. */
  resolve(): { effective: ContextStrategy; note: string | null } {
    const c = this.choice();
    if (!this.api) return { effective: "micro", note: c === "micro" ? null : "This ue-mcp cannot project its tools for Studio, so Studio's agent uses Micro. Update ue-mcp to choose another." };
    if (c !== "auto") return { effective: c, note: null };
    const m = this.measurement();
    const pick = m ? autoPick(m, this.vendor(), "9+") : null;
    if (!pick) return { effective: "micro", note: m ? "The measurement has no runs for this model's vendor, so Auto uses Micro." : "No measurement ships with this Studio, so Auto uses Micro." };
    return { effective: pick.strategy, note: `Auto chose ${pick.strategy}: ${pick.why}.` };
  }

  current(): EditorSurface {
    const { effective } = this.resolve();
    if (effective === "micro" || !this.api) return microSurface();
    const hit = this.cache.get(effective);
    if (hit) return hit;
    try {
      const s = projectedSurface(this.api, this.api.project({ strategy: effective }));
      this.cache.set(effective, s);
      return s;
    } catch {
      // A projection that fails leaves the agent working: Micro needs nothing from it.
      return microSurface();
    }
  }

  view(): AgentContextView {
    const { effective, note } = this.resolve();
    let seeds: Record<ContextStrategy, number> | null = null;
    if (this.api) {
      try {
        seeds = Object.fromEntries(CONTEXT_STRATEGIES.map((s) => [s, this.api!.project({ strategy: s }).seedTokens])) as Record<ContextStrategy, number>;
      } catch {
        seeds = null;
      }
    }
    const m = this.measurement();
    return {
      strategy: this.choice(),
      effective,
      projection: !!this.api,
      seeds,
      measurement: m ? { measuredAt: m.measuredAt, ueMcpVersion: m.ueMcpVersion, runs: m.runs.length } : null,
      note,
    };
  }
}

/** The system prompt with the editor surface's own line and ue-mcp's instructions for it. */
export function withSurface(text: string, s: EditorSurface): string {
  if (s.strategy === "micro") return text;
  return [text.replace(MICRO_LINE, s.line), s.instructions].filter(Boolean).join("\n\n");
}

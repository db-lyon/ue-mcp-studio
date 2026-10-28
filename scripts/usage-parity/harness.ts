// Studio's own subscription turn, tool executor and system prompts, run outside the daemon. Bundled by measure.mjs from a
// source tree (this checkout, or a git ref) so a source change is measured before it ships.
// node <bundle> <prompts.json> <promptId> <model> <effort> <label> <uproject> <ue-mcp entry> <results.jsonl> <dataDir> [nonce] [strategy]
// strategy (micro, lean or full) runs ue-mcp under that context strategy and gives Studio's agent that surface.
import * as fs from "node:fs";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DEFAULT_USAGE } from "@ue-mcp-studio/shared";
import { runSubscriptionTurn } from "./subscription.js";
import { executeTool, type AgentHost, type ToolExecution } from "./tools.js";
import { ContextSurfaces, microSurface, withSurface, type ContextApi, type EditorSurface, type ProjectedTool } from "./context-surface.js";
// @ts-expect-error exported by measure.mjs's bundler plugin
import { system, subagentSystem } from "./runner.js";

const [, , promptsFile, pid, model, effort, label, uproject, ueMcp, results, dataDir, nonce, strategyArg] = process.argv;
const strategy = (["lean", "full"].includes(strategyArg) ? strategyArg : "micro") as "micro" | "lean" | "full";
const spec = (JSON.parse(fs.readFileSync(promptsFile, "utf8")) as Record<string, string | string[]>)[pid];
const turns = (Array.isArray(spec) ? spec : [spec]).map((t, i) => (i === 0 && nonce ? `${t}\n\n(run ${nonce})` : t));
const projectDir = path.dirname(path.resolve(uproject));

const c = new Client({ name: "usage-parity", version: "0" });
await c.connect(new StdioClientTransport({ command: process.execPath, args: [ueMcp, uproject], stderr: "ignore", env: { ...(process.env as Record<string, string>), UE_MCP_CONTEXT_STRATEGY: strategy } }));

// On Lean and Full the server's own tools/list is the projected surface: a tool with an action enum is a category.
let surface: EditorSurface = microSurface();
let seedTokens = 0;
if (strategy !== "micro") {
  const listed = (await c.listTools()).tools;
  const instructions = c.getInstructions?.() ?? "";
  const tools: ProjectedTool[] = listed.map((t) => {
    const action = (t.inputSchema.properties as Record<string, { enum?: unknown }> | undefined)?.action;
    return { name: t.name, description: t.description ?? "", inputSchema: t.inputSchema as Record<string, unknown>, category: Array.isArray(action?.enum) ? t.name : null };
  });
  seedTokens = Math.round(JSON.stringify({ instructions, tools: listed }).length / 4);
  const api: ContextApi = {
    project: () => ({ strategy, categories: tools.filter((t) => t.category).map((t) => t.name), instructions, tools, seedTokens }),
    call: async (tool, input) => {
      const r = await c.callTool({ name: tool, arguments: input }, undefined, { timeout: 600000 });
      return { isError: !!r.isError, content: r.content as Array<{ type: string; text?: string }> };
    },
  };
  surface = new ContextSurfaces(api, () => strategy).current();
}
const host = {
  projectDir,
  dataDir,
  async callAction(category: string, method: string, args: Record<string, unknown> = {}) {
    // Micro calls through ue-mcp's gateway; Lean and Full call the category tool itself.
    const call = strategy === "micro" ? { name: "tools", arguments: { action: "call", category, method, args } } : { name: category, arguments: { action: method, args } };
    const r = await c.callTool(call, undefined, { timeout: 600000 });
    return { isError: !!r.isError, content: r.content as Array<{ type: string; text?: string }> };
  },
  editors: () => [{ name: path.basename(projectDir), connected: true }],
  editorOperation: async () => ({ steps: [] }),
  events: { publish: () => undefined, subscribe: () => () => undefined },
  setBusy: () => undefined,
  log: { info: () => undefined, warn: () => undefined },
} as unknown as AgentHost;

const usage = { ...DEFAULT_USAGE };
const sys = withSurface(system(projectDir, "manual", usage), surface);
const sub = withSurface(subagentSystem(projectDir, "manual", usage), surface);
const run = async (name: string, input: Record<string, unknown>): Promise<ToolExecution> => {
  const pass = surface.passthrough(name);
  if (!pass) return executeTool(host, name, input);
  const r = await pass(input);
  return { text: r.content.map((x) => x.text ?? "").join("\n"), isError: r.isError, outcome: r.isError ? "error" : "done", touched: [], saved: [] };
};
const t0 = Date.now();
let session: string | null = null;
let final = "";
const errors: Array<string | null> = [];
const finals: string[] = [];
const turnWall: number[] = [];
for (const text of turns) {
  const t1 = Date.now();
  final = "";
  errors.push(await runSubscriptionTurn({
    projectDir, model, effort: effort as never, system: sys, subagentSystem: sub,
    subagents: { mode: usage.subagents, perTurn: usage.subagentsPerTurn, model, effort: effort as never },
    prompt: [{ type: "text", text }], resume: session, signal: new AbortController().signal,
    onSession: (id) => (session = id), onDelta: () => undefined,
    onAssistant: (_id, blocks, parent) => {
      if (!parent) for (const b of blocks as Array<{ type: string; text?: string }>) if (b.type === "text" && b.text) final = b.text;
    },
    onToolResults: () => undefined, onStopper: () => undefined, onTask: () => undefined,
    ...(strategy === "micro" ? {} : { editor: { tools: surface.projected.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })), canon: surface.canon } }),
    runTool: (_id, name, input) => run(name, input),
  }));
  finals.push(final);
  turnWall.push((Date.now() - t1) / 1000);
}
const r = { label, strategy, seedTokens, prompt: pid, model, effort, wall: (Date.now() - t0) / 1000, turnWall, session, error: errors.find((e) => e) ?? null, finalText: finals.join("\n---\n") };
fs.appendFileSync(results, JSON.stringify(r) + "\n");
await c.close();
process.exit(0);

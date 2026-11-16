// Studio's turn as it ships: AgentRunner on the durable runtime, with the harness in this process and the Claude sign-in
// through pi-claude-code, Studio's tool executor and system prompts, run outside the daemon against ue-mcp. Bundled by
// measure.mjs from a source tree (this checkout, or a git ref) so a source change is measured before it ships.
// node <bundle> <prompts.json> <promptId> <model> <effort> <label> <uproject> <ue-mcp entry> <results.jsonl> <dataDir> [nonce] [strategy]
// strategy (micro, lean or full) runs ue-mcp under that context strategy and gives Studio's agent that surface.
import * as fs from "node:fs";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DEFAULT_USAGE } from "@ue-mcp-studio/shared";
import type { AgentHost } from "./tools.js";
import { ContextSurfaces, microSurface, type ContextApi, type EditorSurface, type ProjectedTool } from "./context-surface.js";
import { AgentRunner } from "./runner.js";
import { SessionStore } from "./sessions.js";
import { routeSpec } from "./durable/routes.js";
import { runHarness } from "./durable/harness-main.js";
import { ensureRuntime } from "./runtime.js";

const [, , promptsFile, pid, model, effort, label, uproject, ueMcp, results, dataDir, nonce, strategyArg] = process.argv;
const strategy = (["lean", "full"].includes(strategyArg) ? strategyArg : "micro") as "micro" | "lean" | "full";
const spec = (JSON.parse(fs.readFileSync(promptsFile, "utf8")) as Record<string, string | string[]>)[pid];
const turns = (Array.isArray(spec) ? spec : [spec]).map((t, i) => (i === 0 && nonce ? `${t}\n\n(run ${nonce})` : t));
const projectDir = path.dirname(path.resolve(uproject));
fs.mkdirSync(dataDir, { recursive: true });

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
  editors: () => [{ name: path.basename(projectDir), connected: true, port: 1, pid: 1, lastDisconnect: null }],
  editorOperation: async () => ({ steps: [] }),
  events: { publish: () => undefined, subscribe: () => () => undefined },
  setBusy: () => undefined,
  log: { info: () => undefined, warn: () => undefined },
} as unknown as AgentHost;

// The harness runs in this process, on its own storage under the run's data folder.
let harness: { close(): Promise<void> } | null = null;
const store = new SessionStore(dataDir);
const runner = new AgentRunner({
  host,
  store,
  model: () => model,
  effort: () => effort as never,
  // The main agent's reply alone: subagents are off, outside what this measures.
  usage: () => ({ ...DEFAULT_USAGE, subagents: "off" }),
  surfaces: { current: () => surface },
  askBeforeChanges: () => false,
  durable: {
    route: () => "claude",
    routeSpec: (m) => routeSpec({ route: "claude", model: m, vendor: "anthropic", gatewayUrl: "", agentVersion: "usage-parity", endpoint: () => null }),
    credential: async () => null,
    harness: {
      dataDir, projectDir, version: "usage-parity", script: null, extensionFile: null,
      claudeCommand: () => ensureRuntime(),
      start: async (launch) => {
        harness = await runHarness(launch);
      },
    },
  },
});

const t0 = Date.now();
const s = store.create("usage-parity");
const errors: Array<string | null> = [];
const finals: string[] = [];
const turnWall: number[] = [];
const settled = (): boolean => {
  const now = store.get(s.id)!;
  return now.status === "idle" || now.status === "error" || now.status === "stopped";
};
for (const text of turns) {
  const t1 = Date.now();
  const before = store.get(s.id)!.transcript.length;
  await runner.send(s.id, text);
  while (!settled()) await new Promise((r) => setTimeout(r, 250));
  const now = store.get(s.id)!;
  const said = now.transcript.slice(before).filter((e) => e.kind === "assistant" && !e.parent) as Array<{ text: string }>;
  finals.push(said.at(-1)?.text ?? "");
  errors.push(now.status === "error" ? now.error ?? "the turn failed" : null);
  turnWall.push((Date.now() - t1) / 1000);
}
const done = store.get(s.id)!;
// How the agent used ue-mcp, as report.mjs counts it from a Claude Code transcript.
const ue = { search: 0, describe: 0, call: 0 };
for (const e of done.transcript) {
  if (e.kind !== "tool" || e.call.name !== "ue_mcp") continue;
  const a = (e.call.input as { action?: string } | undefined)?.action;
  if (a === "search" || a === "describe" || a === "call") ue[a]++;
}
const r = { label, strategy, seedTokens, prompt: pid, model, effort, wall: (Date.now() - t0) / 1000, turnWall, session: s.id, totals: done.totals ?? null, ue, error: errors.find((e) => e) ?? null, finalText: finals.join("\n---\n") };
fs.appendFileSync(results, JSON.stringify(r) + "\n");
runner.dispose();
store.flush();
await (harness as { close(): Promise<void> } | null)?.close();
await c.close();
process.exit(0);

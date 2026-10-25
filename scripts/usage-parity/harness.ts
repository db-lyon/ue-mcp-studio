// Studio's own subscription turn, tool executor and system prompts, run outside the daemon. Bundled by measure.mjs from a
// source tree (this checkout, or a git ref) so a source change is measured before it ships.
// node <bundle> <prompts.json> <promptId> <model> <effort> <label> <uproject> <ue-mcp entry> <results.jsonl> <dataDir> [nonce]
import * as fs from "node:fs";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DEFAULT_USAGE } from "@ue-mcp-studio/shared";
import { runSubscriptionTurn } from "./subscription.js";
import { executeTool, type AgentHost } from "./tools.js";
// @ts-expect-error exported by measure.mjs's bundler plugin
import { system, subagentSystem } from "./runner.js";

const [, , promptsFile, pid, model, effort, label, uproject, ueMcp, results, dataDir, nonce] = process.argv;
const spec = (JSON.parse(fs.readFileSync(promptsFile, "utf8")) as Record<string, string | string[]>)[pid];
const turns = (Array.isArray(spec) ? spec : [spec]).map((t, i) => (i === 0 && nonce ? `${t}\n\n(run ${nonce})` : t));
const projectDir = path.dirname(path.resolve(uproject));

const c = new Client({ name: "usage-parity", version: "0" });
await c.connect(new StdioClientTransport({ command: process.execPath, args: [ueMcp, uproject], stderr: "ignore" }));
const host = {
  projectDir,
  dataDir,
  async callAction(category: string, method: string, args: Record<string, unknown> = {}) {
    const r = await c.callTool({ name: "tools", arguments: { action: "call", category, method, args } }, undefined, { timeout: 600000 });
    return { isError: !!r.isError, content: r.content as Array<{ type: string; text?: string }> };
  },
  editors: () => [{ name: path.basename(projectDir), connected: true }],
  editorOperation: async () => ({ steps: [] }),
  events: { publish: () => undefined, subscribe: () => () => undefined },
  setBusy: () => undefined,
  log: { info: () => undefined, warn: () => undefined },
} as unknown as AgentHost;

const usage = { ...DEFAULT_USAGE };
const sys = system(projectDir, "manual", usage);
const sub = subagentSystem(projectDir, "manual", usage);
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
    runTool: (_id, name, input) => executeTool(host, name, input),
  }));
  finals.push(final);
  turnWall.push((Date.now() - t1) / 1000);
}
const r = { label, prompt: pid, model, effort, wall: (Date.now() - t0) / 1000, turnWall, session, error: errors.find((e) => e) ?? null, finalText: finals.join("\n---\n") };
fs.appendFileSync(results, JSON.stringify(r) + "\n");
await c.close();
process.exit(0);

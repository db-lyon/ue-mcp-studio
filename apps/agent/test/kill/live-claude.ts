/**
 * The durable runtime on the real Claude sign-in (pi-claude-code through the
 * Claude runtime and this machine's own login), through the same stand-in
 * daemon the kill tests use: one turn with an editor call, then the same with
 * the daemon killed while the call runs. Costs a few cheap requests.
 *
 * node live-claude.mjs <claude runtime> <model>
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { TranscriptEntry } from "@ue-mcp-studio/shared";

const [command, model] = process.argv.slice(2);
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const DIST = process.env.STUDIO_AGENT_DIST!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PROMPT = "Call the ue_mcp tool once with action \"call\", category \"level\", method \"get_info\" and args {}. Then reply with one short sentence that quotes what it returned.";

/** Web search through the provider's own tool, in two turns: the second replays the first's searches. */
const SEARCH = [
  "Search the web: when was Unreal Engine 5.7 released? Answer in one sentence with the date and the URL you found it at.",
  "Search the web again: when was Unreal Engine 5.6 released? One sentence with the date and the URL.",
];

async function run(kill: boolean, prompts: string[] = [PROMPT]): Promise<Record<string, unknown>> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-live-claude-"));
  const data = path.join(root, "data");
  const project = path.join(root, "project");
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  const cfg = path.join(root, "config.json");
  fs.writeFileSync(cfg, JSON.stringify({ runtime: "durable", dataDir: data, projectDir: project, base: "http://127.0.0.1:1", version: "0.0.1", dist: DIST, callMs: kill ? 4000 : 0, ask: false, claude: { model, command } }));
  let daemon: ChildProcess | null = null;
  let port = 0;
  const start = async () => {
    fs.rmSync(path.join(data, "daemon.json"), { force: true });
    daemon = spawn(process.execPath, [path.join(here, "daemon.mjs"), cfg], { cwd: project, stdio: "ignore", windowsHide: true });
    for (let i = 0; i < 200 && !fs.existsSync(path.join(data, "daemon.json")); i++) await sleep(100);
    port = (JSON.parse(fs.readFileSync(path.join(data, "daemon.json"), "utf-8")) as { port: number }).port;
  };
  const call = async (method: string, p: string, b?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, ...(b ? { body: JSON.stringify(b), headers: { "content-type": "application/json" } } : {}) }).catch(() => null);
    return r?.ok ? ((await r.json()) as Record<string, unknown>) : null;
  };
  const started = Date.now();
  await start();
  const id = String((await call("POST", "/session", {}))!.id);
  const calls = () => (fs.existsSync(path.join(data, "calls.jsonl")) ? fs.readFileSync(path.join(data, "calls.jsonl"), "utf-8").split("\n").filter(Boolean).length : 0);
  let d: Record<string, unknown> | null = null;
  for (const text of prompts) {
    await call("POST", "/send", { id, text });
    if (kill) {
      for (let i = 0; i < 1200 && calls() === 0; i++) await sleep(100);
      await sleep(300);
      daemon!.kill();
      await sleep(800);
      await start();
    }
    await sleep(1000);
    for (let i = 0; i < 600; i++) {
      d = await call("GET", `/detail?id=${id}`);
      if (d && ["idle", "error", "stopped"].includes(String(d.status))) break;
      await sleep(500);
    }
    if (String(d?.status) !== "idle") break;
  }
  const transcript = (d?.transcript ?? []) as TranscriptEntry[];
  const out = {
    kill,
    status: d?.status,
    error: d?.error ?? null,
    ms: Date.now() - started,
    editorCalls: calls(),
    entries: transcript.map((e) => (e.kind === "tool" ? `tool ${e.call.name} ${e.call.outcome}` : `${e.kind}: ${(e as { text?: string }).text?.slice(0, 160)}`)),
    totals: d?.totals ?? null,
    harnessLog: (() => {
      try {
        return fs.readFileSync(path.join(data, "durable", "harness.log"), "utf-8").split("\n").filter(Boolean).slice(-12);
      } catch {
        return [];
      }
    })(),
  };
  daemon!.kill();
  try {
    process.kill((JSON.parse(fs.readFileSync(path.join(data, "durable", "harness.json"), "utf-8")) as { pid: number }).pid);
  } catch {
    // Gone.
  }
  await sleep(1000);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  return out;
}

if (process.env.STUDIO_LIVE_ONLY !== "search") {
  console.log(JSON.stringify(await run(false), null, 2));
  console.log(JSON.stringify(await run(true), null, 2));
}
console.log(JSON.stringify(await run(false, SEARCH), null, 2));
process.exit(0);

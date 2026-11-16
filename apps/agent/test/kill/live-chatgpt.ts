/**
 * The durable runtime on a real Sign in with ChatGPT (pi-ai's OAuth, the
 * plan's tokens on OpenAI's Responses API), through the same stand-in daemon
 * the kill tests use: one turn with an editor call, then the same turn with
 * the daemon killed at each point a kill can land on this route. The sign-in
 * is read from a test folder, never the user's own. Costs a few requests on
 * the ChatGPT plan.
 *
 * node live-chatgpt.mjs <model> <chatgpt home>
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { TranscriptEntry } from "@ue-mcp-studio/shared";

const [model, home] = process.argv.slice(2);
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const DIST = process.env.STUDIO_AGENT_DIST!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PROMPT = "Call the ue_mcp tool once with action \"call\", category \"level\", method \"get_info\" and args {}. Then reply with one short sentence that quotes what it returned.";

/** Where the daemon is killed: never, as the request streams, while the editor call runs, or just after it returned. */
type Kill = "none" | "stream" | "tool" | "between";

async function run(kill: Kill): Promise<Record<string, unknown>> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-live-chatgpt-"));
  const data = path.join(root, "data");
  const project = path.join(root, "project");
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  const cfg = path.join(root, "config.json");
  fs.writeFileSync(cfg, JSON.stringify({ runtime: "durable", dataDir: data, projectDir: project, base: "http://127.0.0.1:1", version: "0.0.1", dist: DIST, callMs: kill === "tool" ? 4000 : 0, ask: false, chatgpt: { model, home } }));
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
  const lines = (f: string) => (fs.existsSync(path.join(data, f)) ? fs.readFileSync(path.join(data, f), "utf-8").split("\n").filter(Boolean).length : 0);
  const started = Date.now();
  await start();
  const id = String((await call("POST", "/session", {}))!.id);
  await call("POST", "/send", { id, text: PROMPT });
  const restart = async () => {
    daemon!.kill();
    await sleep(800);
    await start();
  };
  if (kill === "stream") {
    // The request is streaming once the harness has a run going and no call has been made yet.
    await sleep(1500);
    if (lines("calls.jsonl") === 0) await restart();
  } else if (kill === "tool") {
    for (let i = 0; i < 1200 && lines("calls.jsonl") === 0; i++) await sleep(100);
    await sleep(300);
    await restart();
  } else if (kill === "between") {
    for (let i = 0; i < 1200 && lines("calls-ended.jsonl") === 0; i++) await sleep(50);
    await restart();
  }
  await sleep(1000);
  let d: Record<string, unknown> | null = null;
  for (let i = 0; i < 600; i++) {
    d = await call("GET", `/detail?id=${id}`);
    if (d && ["idle", "error", "stopped"].includes(String(d.status))) break;
    await sleep(500);
  }
  const transcript = (d?.transcript ?? []) as TranscriptEntry[];
  const out = {
    kill,
    status: d?.status,
    error: d?.error ?? null,
    ms: Date.now() - started,
    editorCalls: lines("calls.jsonl"),
    entries: transcript.map((e) => (e.kind === "tool" ? `tool ${e.call.name} ${e.call.outcome}` : `${e.kind}: ${(e as { text?: string }).text?.slice(0, 160)}`)),
    requests: (d?.totals as { requests?: number } | undefined)?.requests ?? null,
    harnessLog: (() => {
      try {
        return fs.readFileSync(path.join(data, "durable", "harness.log"), "utf-8").split("\n").filter(Boolean).filter((l) => /report|fail|error/i.test(l)).slice(-8);
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

for (const k of ["none", "stream", "tool", "between"] as const) console.log(JSON.stringify(await run(k)));
process.exit(0);

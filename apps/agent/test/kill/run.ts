/**
 * The kill tests (#445): each scenario on the durable runtime, the daemon
 * killed at each kill point (TerminateProcess, as a crash) and started again
 * on the same data folder. Each run records whether the turn resumed on its
 * own, what a client that held the session open saw and then lost, what ran
 * twice, how many model requests it cost beyond an undisturbed run, and
 * whether the transcript kept its order.
 *
 * Run with scripts/kill-tests.mjs, which bundles this and daemon-main.ts.
 * node run.mjs <out.json> [runtime,...] [scenario,...]
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { TranscriptEntry } from "@ue-mcp-studio/shared";
import { startFakeAnthropic, type FakeTurn } from "../durable/fake-anthropic.js";

/** Studio's loop and the turn hosts are gone: the durable runtime is the only one left to kill. */
type Runtime = "durable";
const [outFile, runtimesArg, scenariosArg] = process.argv.slice(2);
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const DIST = process.env.STUDIO_AGENT_DIST!;

const LONG = "This answer is long on purpose, so that the stream is still running when the daemon is killed. ".repeat(4);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Ctx {
  data: string;
  project: string;
  sessionId: string;
  get(p: string): Promise<Record<string, unknown> | null>;
  post(p: string, b: unknown): Promise<Record<string, unknown> | null>;
  requests(): Array<{ studio: boolean; sub: boolean; toolResults: number }>;
  calls(action?: string): number;
  ended(action?: string): number;
  shellRuns(): number;
  transcript(): Promise<TranscriptEntry[]>;
}

interface Scenario {
  id: string;
  label: string;
  callMs?: number;
  ask?: boolean;
  script: (r: { toolResults: number; system: string; userText: string }) => FakeTurn;
  /** Studio-tool requests an undisturbed run makes. */
  expected: number;
  /** The main agent's last answer. */
  final: string;
  trigger: (c: Ctx) => Promise<void>;
  graceful?: boolean;
  after?: (c: Ctx) => Promise<void>;
  extra?: (c: Ctx, t: TranscriptEntry[]) => Record<string, unknown>;
}

async function until(cond: () => boolean | Promise<boolean>, ms: number, what: string, every = 25): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(every);
  }
}

const isSub = (r: { system: string }) => r.system.includes("You are a subagent");

const SCENARIOS: Scenario[] = [
  {
    id: "stream", label: "mid model stream", expected: 1, final: LONG.trim(),
    script: () => ({ text: LONG.trim(), paceMs: 60 }),
    trigger: async (c) => {
      await until(() => c.requests().some((r) => r.studio), 20_000, "the stream");
      await sleep(1200);
    },
  },
  {
    id: "tool-editor", label: "mid tool call, editor side", expected: 2, final: "Saved.", callMs: 3000,
    script: ({ toolResults }) => (toolResults === 0 ? { tool: { name: "ue_mcp", input: { action: "call", category: "level", method: "save", args: {} } } } : { text: "Saved." }),
    trigger: async (c) => {
      await until(() => c.calls("save") >= 1, 20_000, "the editor call");
      await sleep(300);
    },
  },
  {
    id: "tool-shell", label: "mid tool call, shell side", expected: 2, final: "Ran it.",
    script: ({ toolResults }) => (toolResults === 0 ? { tool: { name: "shell", input: { command: "node slow.js" } } } : { text: "Ran it." }),
    trigger: async (c) => {
      await until(() => c.shellRuns() >= 1, 20_000, "the command");
      await sleep(300);
    },
  },
  {
    id: "between", label: "between a tool result and the next model call", expected: 2, final: "Saved.", callMs: 1500,
    script: ({ toolResults }) => (toolResults === 0 ? { tool: { name: "ue_mcp", input: { action: "call", category: "level", method: "save", args: {} } } } : { text: "Saved.", delayMs: 2500 }),
    trigger: async (c) => until(() => c.ended("save") >= 1, 20_000, "the call's end", 5),
  },
  {
    id: "subagent", label: "mid subagent", expected: 3, final: "Got the report.",
    script: (r) => {
      if (isSub(r)) return { text: `Report: ${LONG.trim()}`, paceMs: 60 };
      return r.toolResults === 0 ? { tool: { name: "agent", input: { description: "Write report", prompt: "Write a report." } } } : { text: "Got the report." };
    },
    trigger: async (c) => {
      await until(() => c.requests().some((r) => r.sub), 20_000, "the subagent's stream");
      await sleep(1200);
    },
  },
  {
    id: "subagent-message", label: "during a subagent message delivery", expected: 4, final: "Done.", callMs: 2500,
    script: (r) => {
      if (isSub(r)) return r.toolResults === 0 ? { tool: { name: "ue_mcp", input: { action: "call", category: "asset", method: "list", args: {} } } } : { text: r.userText.includes("also count them") ? "Report: listed and counted." : "Report: listed." };
      return r.toolResults === 0 ? { tool: { name: "agent", input: { description: "List assets", prompt: "List the assets." } } } : { text: "Done." };
    },
    trigger: async (c) => {
      await until(() => c.calls("list") >= 1, 20_000, "the subagent's call");
      const t = await c.transcript();
      const agent = t.find((e) => e.kind === "tool" && e.call.name === "agent");
      const callId = agent?.kind === "tool" ? agent.call.id : "";
      const r = await c.post("/message", { id: c.sessionId, callId, text: "also count them" });
      if (!r?.ok) throw new Error("the message was not taken");
      await sleep(150);
    },
    extra: (_c, t) => {
      const told = t.find((e) => e.kind === "user" && !!e.parent);
      const agent = t.find((e) => e.kind === "tool" && e.call.name === "agent");
      return { delivered: agent?.kind === "tool" && /counted/.test(agent.call.result ?? ""), delivery: told?.kind === "user" ? told.delivery ?? "none" : "missing" };
    },
  },
  {
    id: "approval", label: "during an approval wait", expected: 2, final: "Ran it.", ask: true,
    script: ({ toolResults }) => (toolResults === 0 ? { tool: { name: "shell", input: { command: "node slow.js" } } } : { text: "Ran it." }),
    trigger: async (c) => {
      await until(async () => (((await c.get(`/detail?id=${c.sessionId}`))?.approvals as unknown[] | undefined)?.length ?? 0) > 0, 20_000, "the approval");
      await sleep(200);
    },
    after: async (c) => {
      await until(async () => (((await c.get(`/detail?id=${c.sessionId}`))?.approvals as unknown[] | undefined)?.length ?? 0) > 0, 30_000, "the approval asked again");
      await c.post("/approve", { id: c.sessionId });
    },
  },
  {
    id: "update", label: "during an update install", expected: 1, final: LONG.trim(), graceful: true,
    script: () => ({ text: LONG.trim(), paceMs: 60 }),
    trigger: async (c) => {
      await until(() => c.requests().some((r) => r.studio), 20_000, "the stream");
      await sleep(1200);
    },
    extra: (c) => {
      // The harness took the newer Studio's code over its own while the turn ran.
      let log = "";
      try {
        log = fs.readFileSync(path.join(c.data, "durable", "harness.log"), "utf-8");
      } catch {
        return {};
      }
      return { newCode: /installed Studio 0\.0\.2's extension/.test(log) };
    },
  },
  {
    id: "client-open", label: "while a client holds the session open", expected: 3, final: LONG.trim(), callMs: 600,
    script: ({ toolResults }) => (toolResults === 0
      ? { text: "Step one.", tool: { name: "ue_mcp", input: { action: "call", category: "level", method: "save", args: {} } } }
      : toolResults === 1 ? { text: "Step two.", tool: { name: "ue_mcp", input: { action: "call", category: "level", method: "load", args: {} } } }
      : { text: LONG.trim(), paceMs: 60 }),
    trigger: async (c) => {
      await until(() => c.requests().filter((r) => r.studio).length >= 3, 30_000, "the third request");
      await sleep(1200);
    },
  },
];

const SLOW_JS = `require("fs").appendFileSync(require("path").join(__dirname, "shell-runs.txt"), "ran\\n"); setTimeout(() => console.log("slow done"), 4000);\n`;

function readLines(file: string): Array<Record<string, unknown>> {
  try {
    return fs.readFileSync(file, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

function killPid(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(pid);
  } catch {
    // Gone already.
  }
}

/** Every process this run started: the daemons, and the harness they started. */
function cleanup(data: string, daemon: ChildProcess | null): void {
  if (daemon && daemon.exitCode === null) killPid(daemon.pid);
  try {
    killPid((JSON.parse(fs.readFileSync(path.join(data, "durable", "harness.json"), "utf-8")) as { pid: number }).pid);
  } catch {
    // None.
  }
}

interface Result {
  runtime: Runtime;
  scenario: string;
  label: string;
  resumed: boolean;
  status: string;
  shownLost: number;
  ranTwice: string[];
  unknown: number;
  extraRequests: number;
  orderOk: boolean;
  notes: string[];
  ms: number;
  error?: string;
}

async function runOne(runtime: Runtime, sc: Scenario): Promise<Result> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `studio-kill-${runtime}-${sc.id}-`));
  const data = path.join(root, "data");
  const project = path.join(root, "project");
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "slow.js"), SLOW_JS);
  const reqLog = path.join(root, "requests.jsonl");
  const fake = await startFakeAnthropic(sc.script, reqLog);
  const started = Date.now();
  let daemon: ChildProcess | null = null;
  let port = 0;
  const notes: string[] = [];
  const config = (version: string) => {
    const file = path.join(root, `config-${version}.json`);
    fs.writeFileSync(file, JSON.stringify({ runtime, dataDir: data, projectDir: project, base: fake.base, version, dist: DIST, callMs: sc.callMs ?? 0, ask: !!sc.ask }));
    return file;
  };
  const env = { ...process.env, ANTHROPIC_BASE_URL: fake.base, ANTHROPIC_API_KEY: "test-key", CLAUDE_CONFIG_DIR: path.join(root, "claude-config"), STUDIO_CLAUDE_RUNTIME_DIR: process.env.STUDIO_CLAUDE_RUNTIME_DIR ?? path.join(os.homedir(), ".ue-mcp", "studio", "runtime") };
  const startDaemon = async (version: string) => {
    fs.rmSync(path.join(data, "daemon.json"), { force: true });
    daemon = spawn(process.execPath, [path.join(here, "daemon.mjs"), config(version)], { cwd: project, env, stdio: ["ignore", fs.openSync(path.join(root, "daemon.out"), "a"), fs.openSync(path.join(root, "daemon.out"), "a")], windowsHide: true });
    await until(() => fs.existsSync(path.join(data, "daemon.json")), 20_000, "the daemon");
    port = (JSON.parse(fs.readFileSync(path.join(data, "daemon.json"), "utf-8")) as { port: number }).port;
  };
  const call = async (method: string, p: string, b?: unknown): Promise<Record<string, unknown> | null> => {
    try {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, ...(b !== undefined ? { body: JSON.stringify(b), headers: { "content-type": "application/json" } } : {}), signal: AbortSignal.timeout(3000) });
      return r.ok ? ((await r.json()) as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const ctx: Ctx = {
    data,
    project,
    sessionId: "",
    get: (p) => call("GET", p),
    post: (p, b) => call("POST", p, b),
    requests: () => readLines(reqLog) as unknown as ReturnType<Ctx["requests"]>,
    calls: (a) => readLines(path.join(data, "calls.jsonl")).filter((c) => !a || c.action === a).length,
    ended: (a) => readLines(path.join(data, "calls-ended.jsonl")).filter((c) => !a || c.action === a).length,
    shellRuns: () => {
      try {
        return fs.readFileSync(path.join(project, "shell-runs.txt"), "utf-8").split("\n").filter(Boolean).length;
      } catch {
        return 0;
      }
    },
    transcript: async () => (((await call("GET", `/detail?id=${ctx.sessionId}`))?.transcript ?? []) as TranscriptEntry[]),
  };
  const seen: TranscriptEntry[][] = [];
  let polling = true;
  let result: Result;
  try {
    await startDaemon("0.0.1");
    ctx.sessionId = String((await ctx.post("/session", {}))!.id);
    // A client holding the session open: it reads the session as a phone does, all through.
    const poller = (async () => {
      while (polling) {
        const d = await call("GET", `/detail?id=${ctx.sessionId}`);
        if (d?.transcript) seen.push(d.transcript as TranscriptEntry[]);
        await sleep(100);
      }
    })();
    await ctx.post("/send", { id: ctx.sessionId, text: `Scenario ${sc.id}` });
    await sc.trigger(ctx);
    const shownBefore = seen.length;
    if (sc.graceful) {
      await ctx.post("/dispose", {});
      await until(() => daemon!.exitCode !== null, 10_000, "the daemon to exit");
    } else {
      killPid(daemon!.pid);
      await until(() => daemon!.exitCode !== null || daemon!.signalCode !== null, 10_000, "the daemon to die");
    }
    await sleep(500);
    await startDaemon(sc.graceful ? "0.0.2" : "0.0.1");
    if (sc.after) await sc.after(ctx).catch((e) => notes.push(`after: ${String(e)}`));
    let status = "";
    let final: TranscriptEntry[] = [];
    try {
      await until(async () => {
        const d = await call("GET", `/detail?id=${ctx.sessionId}`);
        status = String(d?.status ?? "");
        final = (d?.transcript ?? []) as TranscriptEntry[];
        return status === "idle" || status === "error" || status === "stopped";
      }, 90_000, "the turn to end", 200);
    } catch (e) {
      notes.push(String(e));
    }
    polling = false;
    await poller;
    const main = final.filter((e) => !e.parent);
    const last = [...main].reverse().find((e) => e.kind === "assistant");
    const resumed = status === "idle" && last?.kind === "assistant" && last.text.trim() === sc.final;
    // What a client saw before the kill and no longer sees after: an entry gone or changed in place (a call's outcome may change).
    const same = (a: TranscriptEntry, b: TranscriptEntry | undefined) => !!b && a.kind === b.kind && (a.kind === "tool" ? b.kind === "tool" && a.call.id === b.call.id : (a as { text?: string }).text === (b as { text?: string }).text);
    const lostKeys = new Set<string>();
    for (const snap of seen.slice(0, shownBefore)) snap.forEach((e, i) => {
      if (!same(e, final[i])) lostKeys.add(`${i}:${e.kind}:${e.kind === "tool" ? e.call.id : (e as { text?: string }).text?.slice(0, 30)}`);
    });
    const counts = new Map<string, number>();
    for (const c of readLines(path.join(data, "calls.jsonl"))) counts.set(`${c.category}.${c.action}`, (counts.get(`${c.category}.${c.action}`) ?? 0) + 1);
    const ranTwice = [...counts].filter(([, n]) => n > 1).map(([k, n]) => `${k} x${n}`);
    if (ctx.shellRuns() > 1) ranTwice.push(`shell x${ctx.shellRuns()}`);
    const ids = final.filter((e) => e.kind === "tool").map((e) => (e.kind === "tool" ? e.call.id : ""));
    const texts = main.filter((e) => e.kind === "assistant").map((e) => (e.kind === "assistant" ? e.text : ""));
    const orderOk = new Set(ids).size === ids.length && new Set(texts).size === texts.length && lostKeys.size === 0;
    const counted = ctx.requests().filter((r) => r.studio).length;
    for (const t of final) if (t.kind === "tool" && t.call.outcome !== "done") notes.push(`${t.call.name}: ${t.call.outcome}`);
    if (status === "error") notes.push(`error`);
    result = {
      runtime, scenario: sc.id, label: sc.label, resumed, status, shownLost: lostKeys.size, ranTwice,
      unknown: final.filter((e) => e.kind === "tool" && e.call.outcome === "unknown").length,
      extraRequests: counted - sc.expected, orderOk, notes: [...notes, ...Object.entries(sc.extra?.(ctx, final) ?? {}).map(([k, v]) => `${k}=${String(v)}`)], ms: Date.now() - started,
    };
  } catch (e) {
    polling = false;
    result = { runtime, scenario: sc.id, label: sc.label, resumed: false, status: "harness-error", shownLost: 0, ranTwice: [], unknown: 0, extraRequests: 0, orderOk: false, notes, ms: Date.now() - started, error: String(e) };
  } finally {
    cleanup(data, daemon);
    await fake.close();
  }
  if (process.env.KILL_KEEP !== "1") {
    await sleep(500);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } else result.notes.push(`kept ${root}`);
  return result;
}

const runtimes = (runtimesArg ? runtimesArg.split(",").filter((r) => r === "durable") : ["durable"]) as Runtime[];
const picked = scenariosArg ? SCENARIOS.filter((s) => scenariosArg.split(",").includes(s.id)) : SCENARIOS;
const results: Result[] = [];
for (const sc of picked) {
  for (const rt of runtimes) {
    const r = await runOne(rt, sc);
    results.push(r);
    console.log(JSON.stringify(r));
    fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  }
}
console.log("done");
process.exit(0);

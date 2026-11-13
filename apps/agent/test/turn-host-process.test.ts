/**
 * A turn host as a real process, started the way the daemon starts it
 * (detached, no window, no pipes): it keeps running when the daemon that
 * started it lets go, and a new daemon reattaches to it, replays what it
 * missed and answers the call the host was waiting on.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { DETACHED, TurnHosts, type HostedCallbacks } from "../src/hosted-turn.js";
import { listRecords, pidAlive, type TurnSpec } from "../src/turn-host-protocol.js";
import type { ToolExecution } from "../src/tools.js";

const here = path.dirname(fileURLToPath(import.meta.url));
let root: string;
let script: string;
let daemonScript: string;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-host-proc-"));
  script = path.join(root, "turn-host.mjs");
  daemonScript = path.join(root, "daemon.mjs");
  const bundle = (entry: string, outfile: string) => build({ entryPoints: [path.join(here, "fixtures", entry)], outfile, bundle: true, platform: "node", format: "esm", target: "node20", logLevel: "warning" });
  await Promise.all([bundle("turn-host-entry.ts", script), bundle("turn-host-daemon.ts", daemonScript)]);
}, 60_000);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const until = async (cond: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met");
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** A daemon's side, recorded: what it was told, and the calls it was asked to run. */
function daemon(answer: ((callId: string) => Promise<ToolExecution>) | null) {
  const seen: string[] = [];
  const asked: string[] = [];
  let seq = 0;
  const cb: HostedCallbacks = {
    signal: new AbortController().signal,
    onSession: (id) => seen.push(`session ${id}`),
    onDelta: () => {},
    onAssistant: (_mid, content) => {
      for (const b of content) seen.push(b.type === "text" ? (b as { text: string }).text : `${b.type} ${(b as { id?: string }).id ?? ""}`);
    },
    onToolResults: () => seen.push("tool result"),
    onStopper: () => {},
    onTask: () => {},
    runTool: (callId) => {
      asked.push(callId);
      return answer ? answer(callId) : new Promise<ToolExecution>(() => {});
    },
    lostTool: async () => ({ text: "lost", isError: true, outcome: "unknown", touched: [], saved: [] }),
    onSeq: (s) => void (seq = s),
  };
  return { cb, seen, asked, seq: () => seq };
}

const spec: TurnSpec = {
  projectDir: os.tmpdir(),
  model: "claude-test",
  effort: "high",
  system: "",
  subagentSystem: "",
  subagents: { mode: "off", perTurn: 0, model: "claude-test", effort: "high" },
  prompt: [{ type: "text", text: "go" }],
  resume: null,
};

describe("a turn host process", () => {
  it("outlives the daemon that started it, and the next daemon picks the turn up where it was", async () => {
    const dataDir = path.join(root, "data");
    const log = { info() {}, warn() {} };
    // The first daemon starts the host, sees its first events and the call it waits on, then goes away without answering.
    const first = daemon(null);
    const run1 = await new TurnHosts({ dataDir, projectDir: os.tmpdir(), version: "1.0.0", script, log }).start("s1", spec, first.cb);
    await until(() => first.asked.length === 1);
    expect(first.seen).toEqual(["session proc-session", expect.stringMatching(/^running in process \d+$/), "tool_use c1"]);
    const record = listRecords(dataDir).find((r) => r.session === "s1")!;
    expect(record.pid).not.toBe(process.pid);
    expect(record.version).toBe("1.0.0");
    run1.detach();
    expect(await run1.done).toBe(DETACHED);

    // No daemon: the host is still there, its turn waiting on the call.
    await new Promise((r) => setTimeout(r, 300));
    expect(pidAlive(record.pid)).toBe(true);

    // A new daemon, a newer Studio: it attaches from the last event it applied, gets the waiting call and answers it.
    const second = daemon(async () => ({ text: "hi from the new daemon", isError: false, outcome: "done", touched: [], saved: [] }));
    const hosts2 = new TurnHosts({ dataDir, projectDir: os.tmpdir(), version: "2.0.0", script, log });
    const found = hosts2.recordFor("s1")!;
    expect(found.host).toBe(record.host);
    const run2 = await hosts2.attach(found, second.cb, first.seq());
    expect(await run2.done).toBeNull();
    expect(second.asked).toEqual(["c1"]);
    // Nothing the first daemon applied comes again; only what followed.
    expect(second.seen).toEqual(["tool result", "the daemon answered: hi from the new daemon"]);
    // Its end applied, the host exits and leaves nothing behind.
    await until(() => !pidAlive(record.pid));
    expect(listRecords(dataDir)).toEqual([]);
  }, 60_000);

  it("keeps running when the daemon process that started it is killed outright", async () => {
    const dataDir = path.join(root, "data-killed");
    // A daemon process of its own, started as a launcher starts one: not detached, with pipes.
    const daemonProc = spawn(process.execPath, [daemonScript, script, dataDir], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    daemonProc.stdout.setEncoding("utf-8");
    daemonProc.stdout.on("data", (d: string) => void (out += d));
    daemonProc.stderr.setEncoding("utf-8");
    daemonProc.stderr.on("data", (d: string) => void (out += d));
    await until(() => out.includes("ready"), 20_000);
    const record = listRecords(dataDir).find((r) => r.session === "s-killed")!;
    // No dispose, no detach: the process is terminated.
    const exited = new Promise((r) => daemonProc.on("exit", r));
    daemonProc.kill("SIGKILL");
    await exited;
    await new Promise((r) => setTimeout(r, 500));
    expect(pidAlive(record.pid)).toBe(true);

    // The next daemon finds it, replays everything and answers the call it still waits on.
    const next = daemon(async () => ({ text: "answered after the kill", isError: false, outcome: "done", touched: [], saved: [] }));
    const run = await new TurnHosts({ dataDir, projectDir: os.tmpdir(), version: "2.0.0", script, log: { info() {}, warn() {} } }).attach(record, next.cb, 0);
    expect(await run.done).toBeNull();
    expect(next.seen).toEqual(["session proc-session", expect.stringMatching(/^running in process \d+$/), "tool_use c1", "tool result", "the daemon answered: answered after the kill"]);
    await until(() => !pidAlive(record.pid));
  }, 60_000);
});

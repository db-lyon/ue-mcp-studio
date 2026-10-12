/**
 * The Claude subscription route end to end through the runner, with the Agent
 * SDK replaced by a scripted binary: it sends messages, calls Studio's tools
 * through the in-process server, and keeps going after an abort the way the
 * real binary does on Windows until it is killed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ActionResult, EditorStatus } from "ue-mcp/daemon";

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError: boolean }>;
interface FakeBinary {
  /** Call one of Studio's tools the way the binary does, by its SDK name. */
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  emit(m: unknown): void;
  end(): void;
  signal: AbortSignal;
  prompt: unknown;
}
const sdk = vi.hoisted(() => ({
  script: null as null | ((b: FakeBinary) => Promise<void>),
  prompts: [] as unknown[],
  interrupts: 0,
}));

vi.mock("../src/runtime.js", () => ({ ensureRuntime: async () => "claude.exe", installedRuntime: () => "claude.exe" }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  tool: (name: string, _d: string, _s: unknown, handler: Handler) => ({ name, handler }),
  createSdkMcpServer: (o: { tools: Array<{ name: string; handler: Handler }> }) => ({ tools: o.tools }),
  query: ({ prompt, options }: { prompt: unknown; options: { mcpServers: { studio: { tools: Array<{ name: string; handler: Handler }> } }; abortController: AbortController } }) => {
    sdk.prompts.push(prompt);
    const queue: unknown[] = [];
    let wake: (() => void) | null = null;
    let done = false;
    const push = (m: unknown) => {
      queue.push(m);
      wake?.();
    };
    const binary: FakeBinary = {
      async call(name, args) {
        const t = options.mcpServers.studio.tools.find((x) => x.name === name)!;
        // The binary cannot reach the in-process server once its input is closed.
        if (options.abortController.signal.aborted) return { text: "The tool call was interrupted before a result was received.", isError: true };
        const r = await t.handler(args);
        return { text: r.content.map((c) => c.text).join(""), isError: r.isError };
      },
      emit: push,
      end() {
        done = true;
        wake?.();
      },
      signal: options.abortController.signal,
      prompt,
    };
    void sdk.script!(binary).finally(() => binary.end());
    return {
      async interrupt() {
        sdk.interrupts++;
      },
      stopTask: async () => undefined,
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<unknown>> {
            for (;;) {
              if (queue.length) return { value: queue.shift(), done: false };
              if (done) return { value: undefined, done: true };
              await new Promise<void>((r) => (wake = r));
              wake = null;
            }
          },
        };
      },
    };
  },
}));

const { AgentRunner } = await import("../src/runner.js");
const { SessionStore } = await import("../src/sessions.js");

class Host {
  connected = true;
  private listeners: Array<(e: { type: string; data: Record<string, unknown> }) => void> = [];
  log = { info() {}, warn() {} };
  events = {
    publish: () => undefined,
    subscribe: (l: (e: { type: string; data: Record<string, unknown> }) => void) => {
      this.listeners.push(l);
      return () => void (this.listeners = this.listeners.filter((x) => x !== l));
    },
  };
  operation: (op: string) => Promise<Record<string, unknown>> = async (op) => ({ op, steps: [] });
  constructor(public projectDir: string, public dataDir: string) {}
  async callAction(category: string, action: string): Promise<ActionResult> {
    return { isError: false, content: [{ type: "text", text: JSON.stringify({ success: true, category, action }) }] };
  }
  editors(): EditorStatus[] {
    return [{ name: "P", connected: this.connected, port: 1, pid: 1, lastDisconnect: null }];
  }
  editorOperation(op: "start" | "stop" | "restart" | "rebuild") {
    return this.operation(op);
  }
  setBusy(): void {}
  emit(type: string, data: Record<string, unknown> = {}): void {
    for (const l of this.listeners) l({ type, data });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met");
    await sleep(5);
  }
}

const assistant = (id: string, content: unknown[]) => ({ type: "assistant", parent_tool_use_id: null, message: { id, content } });
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name: `mcp__studio__${name}`, input });
const results = (id: string, r: { text: string; isError: boolean }) => ({
  type: "user",
  parent_tool_use_id: null,
  message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: r.text }], is_error: r.isError }] },
});

/** One tool call the way the binary makes it: the block, the call, the result. */
async function use(b: FakeBinary, id: string, name: string, input: Record<string, unknown>) {
  b.emit(assistant(`m_${id}`, [toolUse(id, name, input)]));
  const r = await b.call(name, input);
  b.emit(results(id, r));
  return r;
}

let root: string;
let host: Host;
let store: InstanceType<typeof SessionStore>;
const env = { ...process.env };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-sdk-"));
  process.env.STUDIO_CLAUDE_HOME = path.join(root, "claude");
  fs.mkdirSync(process.env.STUDIO_CLAUDE_HOME, { recursive: true });
  fs.writeFileSync(path.join(process.env.STUDIO_CLAUDE_HOME, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "x", subscriptionType: "max" } }));
  fs.mkdirSync(path.join(root, "project", "Content"), { recursive: true });
  host = new Host(path.join(root, "project"), path.join(root, "data"));
  store = new SessionStore(host.dataDir);
  sdk.prompts = [];
  sdk.interrupts = 0;
});

afterEach(() => {
  process.env = { ...env };
  fs.rmSync(root, { recursive: true, force: true });
});

const runnerOn = (s = store) =>
  new AgentRunner({ host, store: s, provider: () => { throw new Error("the API route is not used"); }, model: () => "claude-opus-5-5", subscription: () => true, askBeforeChanges: () => false });

describe("editor_restart on the subscription route", () => {
  it("rebuilds, waits for the editor to connect again, and every later call returns a real result", async () => {
    host.operation = async (op) => {
      host.connected = false;
      host.emit("editor.disconnected", { cause: "rebuild" });
      await sleep(30);
      // The daemon reports the editor started; the bridge connects a moment later.
      setTimeout(() => {
        host.connected = true;
        host.emit("editor.connected");
      }, 1200);
      return { op, steps: [{ step: "editor.stop_editor", ok: true }, { step: "project.build", ok: true }, { step: "editor.start_editor", ok: true }] };
    };
    const seen: Array<{ text: string; isError: boolean }> = [];
    sdk.script = async (b) => {
      b.emit({ type: "system", subtype: "init", session_id: "sdk-1" });
      seen.push(await use(b, "r", "editor_restart", { operation: "rebuild", reason: "C++ changed" }));
      seen.push(await use(b, "s", "shell", { command: "echo after-rebuild" }));
      seen.push(await use(b, "u", "ue_mcp", { action: "call", category: "project", method: "get_status", args: {} }));
      b.emit(assistant("m_end", [{ type: "text", text: "Rebuilt and checked." }]));
      b.emit({ type: "result", subtype: "success", is_error: false, session_id: "sdk-1" });
    };
    const runner = runnerOn();
    const s = store.create();
    await runner.send(s.id, "rebuild and check");

    expect(seen.map((r) => r.isError)).toEqual([false, false, false]);
    expect(seen[0].text).toMatch(/rebuild finished: editor.stop_editor, project.build, editor.start_editor/);
    expect(seen[0].text).toMatch(/The editor is running and connected/);
    expect(seen[1].text).toMatch(/after-rebuild/);
    expect(seen[2].text).toMatch(/"success":true/);
    const fin = store.get(s.id)!;
    expect(fin.status).toBe("idle");
    expect(fin.transcript.filter((t) => t.kind === "tool").map((t) => t.kind === "tool" && t.call.outcome)).toEqual(["done", "done", "done"]);
    expect(fin.transcript.at(-1)).toMatchObject({ kind: "assistant", text: "Rebuilt and checked." });
  });
});

describe("Stop on the subscription route", () => {
  it("ends the turn at once: nothing the binary says after is relayed, and the next message says what the Stop did", async () => {
    let rebuildDone!: () => void;
    host.operation = (op) => new Promise((resolve) => {
      host.connected = false;
      rebuildDone = () => resolve({ op, steps: [{ step: "editor.stop_editor", ok: true }, { step: "project.build", ok: true }, { step: "editor.start_editor", ok: true }] });
    });
    let afterStop: Array<{ text: string; isError: boolean }> = [];
    sdk.script = async (b) => {
      b.emit({ type: "system", subtype: "init", session_id: "sdk-1" });
      b.emit(assistant("m_r", [toolUse("r", "editor_restart", { operation: "rebuild", reason: "C++ changed" })]));
      const restart = b.call("editor_restart", { operation: "rebuild", reason: "C++ changed" });
      await new Promise<void>((r) => b.signal.addEventListener("abort", () => r(), { once: true }));
      // What the real binary did for seconds after an abort: an interrupted result, more text, more calls.
      b.emit(results("r", { text: "The tool call was interrupted before a result was received.", isError: true }));
      b.emit(assistant("m_x", [{ type: "text", text: "Two tool calls in a row were cut off." }]));
      afterStop = [await use(b, "s1", "shell", { command: "tasklist" }), await use(b, "s2", "shell", { command: "tasklist" })];
      void restart;
    };
    const runner = runnerOn();
    const s = store.create();
    const turn = runner.send(s.id, "rebuild");
    await until(() => store.get(s.id)!.transcript.some((t) => t.kind === "tool" && t.call.name === "editor_restart"));
    const before = store.get(s.id)!.transcript.length;

    runner.stop(s.id);
    await turn;
    await sleep(1700);
    rebuildDone();
    await sleep(20);

    const fin = store.get(s.id)!;
    expect(fin.status).toBe("stopped");
    expect(sdk.interrupts).toBe(1);
    expect(afterStop.every((r) => r.isError)).toBe(true);
    // Only the Stop's note follows the call: no text, no calls from the binary after the Stop.
    expect(fin.transcript.slice(before).map((t) => t.kind)).toEqual(["note"]);
    const restart = fin.transcript.find((t) => t.kind === "tool" && t.call.name === "editor_restart");
    expect(restart).toMatchObject({ call: { outcome: "stopped" } });
    expect(restart?.kind === "tool" && restart.call.result).toMatch(/Stopped by the user while this was running.*the rebuild goes on in the daemon/);
    expect(fin.notes[0]).toMatch(/The user pressed Stop.*editor_restart \(rebuild\) was running.*no connection dropped/);

    // The next message starts with that account.
    sdk.script = async (b) => {
      b.emit(assistant("m_n", [{ type: "text", text: "Here is what happened." }]));
      b.emit({ type: "result", subtype: "success", is_error: false, session_id: "sdk-1" });
    };
    await runner.send(s.id, "what happened?");
    expect(String(sdk.prompts.at(-1))).toMatch(/^\[Studio\] The user pressed Stop/);
    expect(store.get(s.id)!.status).toBe("idle");
  });
});

describe("a daemon restart on the subscription route", () => {
  it("ends the turn saying Studio restarted, never that the user stopped it", async () => {
    sdk.script = async (b) => {
      b.emit(assistant("m_s", [toolUse("s", "shell", { command: "sleep 30" })]));
      await new Promise(() => undefined);
    };
    const runner = runnerOn();
    const s = store.create();
    void runner.send(s.id, "wait");
    await until(() => store.get(s.id)!.transcript.some((t) => t.kind === "tool"));
    fs.mkdirSync(host.dataDir, { recursive: true });
    fs.writeFileSync(path.join(host.dataDir, "restart-cause.json"), JSON.stringify({ cause: "Studio's daemon restarted to install Studio 0.1.0-beta.99", at: Date.now() }));
    runner.dispose();

    const fin = new SessionStore(host.dataDir).get(s.id)!;
    expect(fin.status).toBe("error");
    expect(fin.error).toMatch(/restarted to install Studio 0.1.0-beta.99/);
    const call = fin.transcript.find((t) => t.kind === "tool");
    expect(call).toMatchObject({ call: { outcome: "unknown" } });
    expect(call?.kind === "tool" && call.call.result).toMatch(/^Interrupted: Studio's daemon restarted to install/);
    expect(JSON.stringify(fin)).not.toMatch(/by the user/);
    expect(fin.notes[0]).toMatch(/^Your last turn ended because Studio.s daemon restarted to install Studio 0.1.0-beta.99/);
  });

  it("a daemon that died without saying so: the next one ends the turn with the same account", () => {
    const s = store.create();
    s.status = "running";
    s.transcript.push({ kind: "tool", call: { id: "e", name: "editor_restart", input: { operation: "rebuild" }, outcome: "pending", startedAt: new Date().toISOString() } });
    store.save(s);
    runnerOn(new SessionStore(host.dataDir)).recover();
    const fin = new SessionStore(host.dataDir).get(s.id)!;
    expect(fin.status).toBe("error");
    expect(fin.transcript[0]).toMatchObject({ call: { outcome: "unknown" } });
    expect(fin.transcript[0].kind === "tool" && fin.transcript[0].call.result).toMatch(/Interrupted: Studio's daemon restarted while this ran.*rebuild may or may not have finished/);
  });
});

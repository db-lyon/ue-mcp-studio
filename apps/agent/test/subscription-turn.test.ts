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
import { DEFAULT_USAGE } from "@ue-mcp-studio/shared";

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type?: string; text?: string; data?: string; mimeType?: string }>; isError: boolean }>;
interface FakeBinary {
  /** Call one of Studio's tools the way the binary does, by its SDK name. */
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean; content?: Array<{ type?: string; mimeType?: string }> }>;
  emit(m: unknown): void;
  end(): void;
  signal: AbortSignal;
  prompt: unknown;
}
const sdk = vi.hoisted(() => ({
  script: null as null | ((b: FakeBinary) => Promise<void>),
  prompts: [] as unknown[],
  envs: [] as Array<Record<string, string | undefined>>,
  resumes: [] as Array<string | undefined>,
  interrupts: 0,
  stopTask: null as null | ((taskId: string) => void),
  options: [] as Array<Record<string, unknown>>,
}));

vi.mock("../src/runtime.js", () => ({ ensureRuntime: async () => "claude.exe", installedRuntime: () => "claude.exe" }));
// Signed in, as the runtime's `auth status` would say (claude-auth.test.ts covers asking it).
vi.mock("../src/claude-auth.js", async (actual) => {
  const login = { method: "claude.ai", subscription: "max", keySource: null };
  return { ...(await actual<typeof import("../src/claude-auth.js")>()), claudeLogin: () => login, refreshClaudeLogin: async () => login };
});
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  tool: (name: string, _d: string, _s: unknown, handler: Handler) => ({ name, handler }),
  createSdkMcpServer: (o: { tools: Array<{ name: string; handler: Handler }> }) => ({ tools: o.tools }),
  query: ({ prompt, options }: { prompt: unknown; options: { resume?: string; mcpServers: { studio: { tools: Array<{ name: string; handler: Handler }> } }; abortController: AbortController; env: Record<string, string | undefined> } }) => {
    sdk.prompts.push(prompt);
    sdk.options.push(options as unknown as Record<string, unknown>);
    sdk.envs.push(options.env);
    sdk.resumes.push(options.resume);
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
        return { text: r.content.map((c) => c.text ?? "").join(""), isError: r.isError, content: r.content };
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
      stopTask: async (taskId: string) => sdk.stopTask?.(taskId),
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
const { loadout } = await import("../src/native.js");
const { composeNative, toolsFor } = await import("../src/native-runtime.js");

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
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
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
  // Real time: the editor reconnects 1.2 s in, polled each second, then a shell runs. A loaded run takes longer than the 5 s default.
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
  }, 20_000);
});

describe("editing a message on the subscription route", () => {
  it("never resumes the old Claude session past the edit: a new one starts from what is kept", async () => {
    let n = 0;
    sdk.script = async (b) => {
      n++;
      b.emit({ type: "system", subtype: "init", session_id: `sdk-${n}` });
      b.emit(assistant(`m${n}`, [{ type: "text", text: `reply ${n}` }]));
      b.emit({ type: "result", subtype: "success", is_error: false, session_id: `sdk-${n}` });
    };
    sdk.resumes = [];
    const runner = runnerOn();
    const s = store.create();
    await runner.send(s.id, "first message");
    await runner.send(s.id, "second message");
    expect(sdk.resumes).toEqual([undefined, "sdk-1"]);
    const index = store.get(s.id)!.transcript.findIndex((t) => t.kind === "user" && t.text === "second message");
    await runner.editMessage(s.id, index, "second, edited");
    expect(sdk.resumes[2]).toBeUndefined();
    const prompt = JSON.stringify(sdk.prompts[2]);
    expect(prompt).toContain("first message");
    expect(prompt).toContain("reply 1");
    expect(prompt).not.toContain("second message");
    expect(prompt).not.toContain("reply 2");
    expect(prompt).toContain("second, edited");
    expect(store.get(s.id)!.sdkPast).toEqual(["sdk-2"]);
    // Nothing in the panel says the model moved: to the user it is the same conversation.
    expect(store.get(s.id)!.transcript.some((t) => t.kind === "note")).toBe(false);
  });
});

describe("stopping one subagent on the subscription route", () => {
  it("answers its call in flight as stopped at once, and the main turn carries on", async () => {
    let release: (() => void) | null = null;
    const slow = host.callAction.bind(host);
    host.callAction = async (category: string, action: string) => {
      if (action === "slow_build") await new Promise<void>((r) => (release = r));
      return slow(category, action);
    };
    let inFlight: Promise<{ text: string; isError: boolean }> | null = null;
    let stopTask: (() => void) | null = null;
    sdk.stopTask = () => stopTask?.();
    sdk.script = async (b) => {
      b.emit({ type: "system", subtype: "init", session_id: "sdk-stop" });
      b.emit(assistant("m_a", [{ type: "tool_use", id: "ag", name: "Agent", input: { description: "Busy", prompt: "busy" } }]));
      b.emit({ type: "system", subtype: "task_started", tool_use_id: "ag", task_id: "task-1", is_backgrounded: false });
      b.emit({ type: "assistant", parent_tool_use_id: "ag", message: { id: "m_s", content: [toolUse("c1", "ue_mcp", { action: "call", category: "asset", method: "slow_build", args: {} })] } });
      await sleep(30);
      inFlight = b.call("ue_mcp", { action: "call", category: "asset", method: "slow_build", args: {} });
      await new Promise<void>((r) => (stopTask = r));
      b.emit({ type: "system", subtype: "task_notification", tool_use_id: "ag", task_id: "task-1", status: "stopped", summary: "" });
      b.emit(results("ag", { text: "The user stopped this agent.", isError: true }));
      b.emit(assistant("m_end", [{ type: "text", text: "Going on without it." }]));
      b.emit({ type: "result", subtype: "success", is_error: false, session_id: "sdk-stop" });
    };
    const runner = runnerOn();
    const s = store.create();
    const turn = runner.send(s.id, "start one");
    await until(() => release !== null);
    expect(runner.stopSubagent(s.id, "ag")).toBe(true);
    const r = await inFlight!;
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Stopped by the user while this was running/);
    await turn;
    const fin = store.get(s.id)!;
    const outcome = (id: string) => fin.transcript.find((t) => t.kind === "tool" && t.call.id === id);
    expect((outcome("c1") as { call: { outcome: string } }).call.outcome).toBe("stopped");
    expect((outcome("ag") as { call: { outcome: string } }).call.outcome).toBe("stopped");
    expect(fin.status).toBe("idle");
    expect(fin.transcript.at(-1)).toMatchObject({ kind: "assistant", text: "Going on without it." });
    release!();
    sdk.stopTask = null;
  });
});

describe("a call's result on the subscription route", () => {
  it("goes back to the binary without indentation and stays as ue-mcp answered in the transcript", async () => {
    const answer = JSON.stringify({ success: true, actors: [{ label: "Sun" }] }, null, 2);
    host.callAction = async () => ({ isError: false, content: [{ type: "text", text: answer }] });
    let got: Awaited<ReturnType<FakeBinary["call"]>> | null = null;
    sdk.script = async (b) => {
      b.emit({ type: "system", subtype: "init", session_id: "sdk-c" });
      got = await use(b, "c", "ue_mcp", { action: "call", category: "level", method: "get_outliner", args: {} });
      b.emit(assistant("m_end", [{ type: "text", text: "One actor." }]));
      b.emit({ type: "result", subtype: "success", is_error: false, session_id: "sdk-c" });
    };
    const s = store.create();
    await runnerOn().send(s.id, "what is in the level");
    expect(got!.text).toBe(JSON.stringify(JSON.parse(answer)));
    const call = store.get(s.id)!.transcript.find((t) => t.kind === "tool");
    expect(call?.kind === "tool" && call.call.result).toBe(answer);
  });
});

describe("images on the subscription route", () => {
  it("go back to the binary as MCP image content, and into the transcript", async () => {
    const { pngBytes } = await import("./image-fixtures.js");
    fs.writeFileSync(path.join(host.projectDir, "shot.png"), pngBytes(10, 5));
    let got: Awaited<ReturnType<FakeBinary["call"]>> | null = null;
    sdk.script = async (b) => {
      b.emit({ type: "system", subtype: "init", session_id: "sdk-img" });
      // The real binary's message naming the call reaches the runner before the call itself.
      b.emit(assistant("m_r", [toolUse("r", "read_file", { path: "shot.png" })]));
      await sleep(30);
      got = await b.call("read_file", { path: "shot.png" });
      b.emit(results("r", got));
      b.emit(assistant("m_end", [{ type: "text", text: "Orange." }]));
      b.emit({ type: "result", subtype: "success", is_error: false, session_id: "sdk-img" });
    };
    const s = store.create();
    await runnerOn().send(s.id, "look at shot.png");
    expect(got!.content!.map((c) => c.type)).toEqual(["text", "image"]);
    expect(got!.content![1].mimeType).toBe("image/png");
    const call = store.get(s.id)!.transcript.find((t) => t.kind === "tool");
    expect(call?.kind === "tool" && call.call.images?.map((i) => i.name)).toEqual(["shot.png"]);
  });
});

describe("background subagents on the subscription route (#1384)", () => {
  it("keep Studio's tools past the SDK's default ten minute ceiling after the main turn's result", async () => {
    sdk.script = async (b) => {
      b.emit({ type: "system", subtype: "init", session_id: "sdk-1" });
      b.emit({ type: "result", subtype: "success", is_error: false, session_id: "sdk-1" });
    };
    const runner = runnerOn();
    const s = store.create();
    await runner.send(s.id, "go");
    const ceiling = Number(sdk.envs.at(-1)?.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS);
    expect(ceiling).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000);
    expect(ceiling).toBeLessThanOrEqual(2147483647);
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

describe("what a turn spends on the subscription route", () => {
  const spending = (id: string, input: number, parent: string | null = null, text = "...") =>
    ({ type: "assistant", parent_tool_use_id: parent, message: { id, content: [{ type: "text", text }], usage: { input_tokens: input, output_tokens: 0 } } });

  it("ends the turn with the main agent's and the subagents' tokens", async () => {
    sdk.script = async (b) => {
      b.emit({ type: "system", subtype: "init", session_id: "sdk-u" });
      b.emit(spending("m1", 3000));
      b.emit(spending("s1", 5000, "agent-call"));
      b.emit(spending("m2", 1000, null, "Done."));
      b.emit({ type: "result", subtype: "success", is_error: false, session_id: "sdk-u" });
    };
    const s = store.create();
    await runnerOn().send(s.id, "go");
    await until(() => store.get(s.id)!.status === "idle");
    expect(store.get(s.id)!.transcript.at(-1)).toMatchObject({ kind: "usage", main: 4000, subagents: 5000 });
  });

  it("stops the turn at the token limit", async () => {
    let afterStop = false;
    sdk.script = async (b) => {
      b.emit({ type: "system", subtype: "init", session_id: "sdk-l" });
      b.emit(spending("m1", 30_000));
      b.emit(spending("m2", 30_000));
      await sleep(50);
      afterStop = !b.signal.aborted;
      b.emit({ type: "result", subtype: "success", is_error: false, session_id: "sdk-l" });
    };
    const runner = new AgentRunner({
      host, store, provider: () => { throw new Error("the API route is not used"); }, model: () => "claude-opus-5-5", subscription: () => true, askBeforeChanges: () => false,
      usage: () => ({ ...DEFAULT_USAGE, turnTokenLimit: 50_000 }),
    });
    const s = store.create();
    await runner.send(s.id, "go");
    await until(() => store.get(s.id)!.status === "error");
    const fin = store.get(s.id)!;
    expect(fin.error).toContain("past the main agent's per-run budget of 50000 tokens");
    expect(fin.transcript.find((t) => t.kind === "usage")).toMatchObject({ main: 60_000, limit: 50_000 });
    expect(afterStop).toBe(false);
  });
});

describe("the project's own Claude Code files on the Claude sign-in", () => {
  const native = () => {
    const l = loadout("claude", host.projectDir, path.join(root, "home"), new Map(), root);
    return { convention: "claude" as const, loadout: l, composed: composeNative(l), helpers: [], skills: l.skills, sdkLoads: true };
  };
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(host.projectDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(host.projectDir, rel), text);
  };

  it("load through the SDK's own setting sources, with subagents' tools mapped onto Studio's and built-in names aliased", async () => {
    write("CLAUDE.md", "Project rule only the SDK should read.");
    write(".claude/agents/reviewer.md", "---\nname: reviewer\ndescription: Reviews changes\ntools: Read, Grep\nmodel: haiku\n---\nReview carefully.");
    write(".claude/skills/naming/SKILL.md", "---\nname: naming\ndescription: Asset naming\n---\nPrefix with the zone.");
    write("Source/a.txt", "hello");
    sdk.script = async (b) => {
      // A skill told the model to use the built-in Read: it runs Studio's read_file.
      b.emit(assistant("m1", [{ type: "tool_use", id: "r1", name: "Read", input: { file_path: "Source/a.txt" } }]));
      const r = await b.call("read_file", { file_path: "Source/a.txt" });
      b.emit(results("r1", r));
      b.emit({ type: "result", subtype: "success", is_error: false, result: "done", session_id: "x" });
    };
    const runner = new AgentRunner({ host, store, provider: () => { throw new Error("unused"); }, model: () => "claude-opus-5-5", subscription: () => true, askBeforeChanges: () => false, native });
    const s = store.create();
    await runner.send(s.id, "check the naming");
    await until(() => store.get(s.id)!.status === "idle");
    const o = sdk.options.at(-1)!;
    expect(o.settingSources).toEqual(["user", "project", "local"]);
    expect(o.toolAliases).toMatchObject({ Read: "mcp__studio__read_file", Bash: "mcp__studio__shell", Edit: "mcp__studio__edit_file" });
    expect(o.tools).toEqual(expect.arrayContaining(["Agent", "WebSearch", "Skill"]));
    expect((o.agents as Record<string, { tools: string[]; model: string; prompt: string }>).reviewer).toMatchObject({ tools: ["mcp__studio__read_file", "mcp__studio__grep"], model: "haiku" });
    expect((o.agents as Record<string, { prompt: string }>).reviewer.prompt).toContain("Review carefully.");
    // The SDK reads CLAUDE.md itself, so Studio's prompt does not carry it as well.
    expect(String(o.systemPrompt)).not.toContain("Project rule only the SDK should read.");
    const call = store.get(s.id)!.transcript.find((t) => t.kind === "tool" && t.call.id === "r1");
    expect(call?.kind === "tool" && call.call).toMatchObject({ name: "read_file", outcome: "done" });
    expect(call?.kind === "tool" && call.call.result).toContain("hello");
    expect(toolsFor({ tools: ["Read", "Grep"], noShell: false }).allowed).toEqual(new Set(["read_file", "grep"]));
  });

  it("load none while the project's own files are off", async () => {
    sdk.script = async (b) => b.emit({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "x" });
    const runner = new AgentRunner({ host, store, provider: () => { throw new Error("unused"); }, model: () => "claude-opus-5-5", subscription: () => true, native: () => null });
    const s = store.create();
    await runner.send(s.id, "hi");
    await until(() => store.get(s.id)!.status === "idle");
    const o = sdk.options.at(-1)!;
    expect(o.settingSources).toEqual([]);
    expect(o).not.toHaveProperty("toolAliases");
  });
});

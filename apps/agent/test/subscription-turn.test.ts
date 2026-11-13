/**
 * The Claude sign-in route end to end through the runner, with the Agent SDK
 * replaced by a scripted binary (fake-sdk.ts): it sends messages, calls
 * Studio's tools through the in-process server, and keeps going after an abort
 * the way the real binary does on Windows until it is killed. What subagents
 * do on this route is in subagent-parity.test.ts, beside Studio's loop: here
 * is what only this route has.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_USAGE } from "@ue-mcp-studio/shared";
import { Host, assistant, results, sdk, sleep, toolUse, until, use, type FakeBinary } from "./fake-sdk.js";

vi.mock("../src/runtime.js", () => ({ ensureRuntime: async () => "claude.exe", installedRuntime: () => "claude.exe" }));
// Signed in, as the runtime's `auth status` would say (claude-auth.test.ts covers asking it).
vi.mock("../src/claude-auth.js", async (actual) => {
  const login = { method: "claude.ai", subscription: "max", keySource: null };
  return { ...(await actual<typeof import("../src/claude-auth.js")>()), claudeLogin: () => login, refreshClaudeLogin: async () => login };
});
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./fake-sdk.js")).fakeSdk);

const { AgentRunner } = await import("../src/runner.js");
const { SessionStore } = await import("../src/sessions.js");
const { loadout } = await import("../src/native.js");
const { composeNative, toolsFor } = await import("../src/native-runtime.js");
const { AGENT_TOOL } = await import("../src/tools.js");

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
  sdk.options = [];
  sdk.interrupts = 0;
  sdk.backgrounded = 0;
});

afterEach(() => {
  process.env = { ...env };
  fs.rmSync(root, { recursive: true, force: true });
});

const runnerOn = (s = store) =>
  new AgentRunner({ host, store: s, provider: () => { throw new Error("the API route is not used"); }, model: () => "claude-opus-5-5", subscription: () => true, askBeforeChanges: () => false });

/** Whether a conversation the binary runs is a subagent's, by what its system prompt says. */
const isSubagent = (b: FakeBinary) => String(b.options.systemPrompt).includes("You are a subagent");

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

describe("orchestration on the Claude sign-in is Studio's", () => {
  it("switches the runtime's own subagent tool off and gives the main agent Studio's agent tool, the same definition as every route", async () => {
    sdk.script = async (b) => {
      b.emit({ type: "system", subtype: "init", session_id: "sdk-o" });
      b.emit({ type: "result", subtype: "success", is_error: false, session_id: "sdk-o" });
    };
    const runner = new AgentRunner({ host, store, provider: () => { throw new Error("unused"); }, model: () => "claude-opus-5-5", subscription: () => true, usage: () => ({ ...DEFAULT_USAGE, subagents: "automatic" }) });
    const s = store.create();
    await runner.send(s.id, "hi");
    const o = sdk.options.at(-1)!;
    expect(o.disallowedTools).toEqual(expect.arrayContaining(["Agent", "Task"]));
    expect(o.tools).not.toContain("Agent");
    expect(o).not.toHaveProperty("agents");
    expect(o.allowedTools).toContain("mcp__studio__agent");
    const tools = (o.mcpServers as { studio: { tools: Array<{ name: string; description: string; annotations?: { readOnlyHint?: boolean } }> } }).studio.tools;
    const agent = tools.find((t) => t.name === "agent")!;
    expect(agent.description).toBe((AGENT_TOOL as { description: string }).description);
    // Several agent calls of one message run at once, as on Studio's loop.
    expect(agent.annotations?.readOnlyHint).toBe(true);
    // No background ceiling: nothing of the runtime runs past a reply's end.
    expect(sdk.envs.at(-1)).not.toHaveProperty("CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS");
  });

  it("runs each subagent as a session of its own, with Studio's tools and no agent tool", async () => {
    sdk.script = async (b) => {
      if (isSubagent(b)) {
        b.emit({ type: "system", subtype: "init", session_id: "sdk-sub" });
        b.emit(assistant("s_end", [{ type: "text", text: "Built it." }]));
        b.emit({ type: "result", subtype: "success", is_error: false, session_id: "sdk-sub" });
        return;
      }
      b.emit({ type: "system", subtype: "init", session_id: "sdk-main" });
      b.emit(assistant("m_a", [toolUse("ag", "agent", { description: "Build", prompt: "build the door" })]));
      const r = await b.call("agent", { description: "Build", prompt: "build the door" });
      b.emit(results("ag", r));
      b.emit(assistant("m_end", [{ type: "text", text: `It said: ${r.text}` }]));
      b.emit({ type: "result", subtype: "success", is_error: false, session_id: "sdk-main" });
    };
    const runner = runnerOn();
    const s = store.create();
    await runner.send(s.id, "build it");
    await until(() => store.get(s.id)!.status === "idle");
    expect(sdk.options).toHaveLength(2);
    const sub = sdk.options.find((o) => String(o.systemPrompt).includes("You are a subagent"))!;
    expect(sub.resume).toBeUndefined();
    expect(sub.allowedTools).not.toContain("mcp__studio__agent");
    expect(sub.disallowedTools).toEqual(expect.arrayContaining(["Agent", "Task"]));
    expect(sdk.prompts).toContainEqual("build the door");
    const fin = store.get(s.id)!;
    expect(fin.transcript.find((t) => t.kind === "assistant" && t.parent === "ag")).toMatchObject({ text: "Built it." });
    expect(fin.transcript.find((t) => t.kind === "tool" && t.call.id === "ag")).toMatchObject({ call: { outcome: "done", result: "Built it." } });
    expect(fin.transcript.at(-1)).toMatchObject({ kind: "assistant", text: "It said: Built it." });
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
    // Nothing follows the call: no text or calls from the binary after the Stop, and no note on screen for the user's own Stop.
    expect(fin.transcript.slice(before).map((t) => t.kind)).toEqual([]);
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
  const spending = (id: string, input: number, text = "...") =>
    ({ type: "assistant", parent_tool_use_id: null, message: { id, content: [{ type: "text", text }], usage: { input_tokens: input, output_tokens: 0 } } });

  it("keeps the main agent's and each subagent's tokens in the session, each message's growth once", async () => {
    sdk.script = async (b) => {
      if (isSubagent(b)) {
        b.emit({ type: "system", subtype: "init", session_id: "sdk-s" });
        b.emit(spending("s1", 5000, "Sub done."));
        b.emit({ type: "result", subtype: "success", is_error: false, session_id: "sdk-s" });
        return;
      }
      b.emit({ type: "system", subtype: "init", session_id: "sdk-u" });
      b.emit(spending("m1", 3000));
      // The same message reported again with more: only the new tokens count.
      b.emit(spending("m1", 3500));
      b.emit(assistant("m_a", [toolUse("agent-call", "agent", { description: "Sub", prompt: "sub" })]));
      b.emit(results("agent-call", await b.call("agent", { description: "Sub", prompt: "sub" })));
      b.emit(spending("m2", 1000, "Done."));
      b.emit({ type: "result", subtype: "success", is_error: false, session_id: "sdk-u" });
    };
    const s = store.create();
    await runnerOn().send(s.id, "go");
    await until(() => store.get(s.id)!.status === "idle");
    expect(SessionStore.detail(store.get(s.id)!).tokens).toEqual({ main: 4500, "agent-call": 5000 });
  });
});

describe("context and compaction on the subscription route", () => {
  const usage = (id: string, input: number, cacheRead: number, output: number, parent: string | null = null) =>
    ({ type: "assistant", parent_tool_use_id: parent, message: { id, model: "claude-opus-5-5", content: [{ type: "text", text: "..." }], usage: { input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0, output_tokens: output } } });
  const postCompact = async (summary: string) => {
    const hooks = (sdk.options.at(-1)!.hooks as Record<string, Array<{ hooks: Array<(i: unknown, id: string | undefined, o: { signal: AbortSignal }) => Promise<unknown>> }>>).PostCompact;
    await hooks[0].hooks[0]({ hook_event_name: "PostCompact", trigger: "auto", compact_summary: summary, session_id: "x", transcript_path: "", cwd: "" }, undefined, { signal: new AbortController().signal });
  };

  it("keeps the latest request's whole prompt as the context, not the sum, and the spend apart as totals", async () => {
    sdk.script = async (b) => {
      b.emit({ type: "system", subtype: "init", session_id: "sdk-c" });
      b.emit(usage("m1", 200, 90_000, 400));
      b.emit(usage("m2", 300, 91_000, 500));
      b.emit({ type: "result", subtype: "success", is_error: false, session_id: "sdk-c" });
    };
    const s = store.create();
    await runnerOn().send(s.id, "go");
    await until(() => store.get(s.id)!.status === "idle");
    const d = SessionStore.detail(store.get(s.id)!);
    expect(d.context!.main).toMatchObject({ input: 91_300, cached: 91_000, output: 500, model: "claude-opus-5-5" });
    expect(d.totals).toMatchObject({ input: 500, cacheRead: 181_000, output: 900, requests: 2 });
    expect(d.totals!.costUsd).toBeGreaterThan(0);
  });

  it("marks where the runtime compacted, with the tokens before and after and the summary its hook handed over", async () => {
    sdk.script = async (b) => {
      b.emit({ type: "system", subtype: "init", session_id: "sdk-k" });
      b.emit(usage("m1", 100, 840_000, 300));
      b.emit({ type: "system", subtype: "status", status: "compacting", session_id: "sdk-k" });
      await postCompact("The door swings; the trigger is next.");
      b.emit({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 840_400, post_tokens: 18_000 }, session_id: "sdk-k" });
      b.emit({ type: "system", subtype: "status", status: null, compact_result: "success", session_id: "sdk-k" });
      b.emit(usage("m2", 100, 18_200, 200));
      b.emit({ type: "result", subtype: "success", is_error: false, session_id: "sdk-k" });
    };
    const s = store.create();
    await runnerOn().send(s.id, "go");
    await until(() => store.get(s.id)!.status === "idle");
    const marks = store.get(s.id)!.transcript.filter((t) => t.kind === "compaction");
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ kind: "compaction", state: "done", trigger: "auto", before: 840_400, after: 18_000, method: "runtime", summary: "The door swings; the trigger is next." });
    // The context after is the next request's, far below what it was.
    expect(SessionStore.detail(store.get(s.id)!).context!.main.input).toBe(18_300);
  });

  it("runs /compact as the runtime's own compaction of the Claude session, nothing added to the conversation", async () => {
    sdk.script = async (b) => {
      b.emit({ type: "system", subtype: "init", session_id: "sdk-m" });
      b.emit(usage("m1", 100, 50_000, 300));
      b.emit({ type: "result", subtype: "success", is_error: false, session_id: "sdk-m" });
    };
    const runner = runnerOn();
    const s = store.create();
    await runner.send(s.id, "go");
    await until(() => store.get(s.id)!.status === "idle");
    const userEntries = store.get(s.id)!.transcript.filter((t) => t.kind === "user").length;
    sdk.script = async (b) => {
      b.emit({ type: "system", subtype: "status", status: "compacting", session_id: "sdk-m" });
      b.emit({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 50_400, post_tokens: 6_000 }, session_id: "sdk-m" });
      await postCompact("Short summary.");
      b.emit({ type: "result", subtype: "success", is_error: false, session_id: "sdk-m" });
    };
    await runner.send(s.id, "/compact keep the door paths");
    await until(() => store.get(s.id)!.status === "idle");
    expect(sdk.prompts.at(-1)).toBe("/compact keep the door paths");
    expect(sdk.resumes.at(-1)).toBe("sdk-m");
    const t = store.get(s.id)!.transcript;
    expect(t.filter((x) => x.kind === "user")).toHaveLength(userEntries);
    expect(t.at(-1)).toMatchObject({ kind: "compaction", trigger: "manual", state: "done", before: 50_400, after: 6_000, summary: "Short summary.", instructions: "keep the door paths" });
  });

  it("says when the runtime's compaction failed", async () => {
    sdk.script = async (b) => {
      b.emit({ type: "system", subtype: "init", session_id: "sdk-f" });
      b.emit({ type: "system", subtype: "status", status: "compacting", session_id: "sdk-f" });
      b.emit({ type: "system", subtype: "status", status: null, compact_result: "failed", compact_error: "overloaded", session_id: "sdk-f" });
      b.emit({ type: "result", subtype: "success", is_error: false, session_id: "sdk-f" });
    };
    const s = store.create();
    await runnerOn().send(s.id, "go");
    await until(() => store.get(s.id)!.status === "idle");
    expect(store.get(s.id)!.transcript.find((t) => t.kind === "compaction")).toMatchObject({ state: "failed", error: "overloaded" });
  });
});

describe("the project's own Claude Code files on the Claude sign-in", () => {
  const nativeWith = (helpers: Array<{ name: string; description: string; prompt: string; allowed: Set<never> | null; maxTurns: number | null; effort: string | null }> = []) => () => {
    const l = loadout("claude", host.projectDir, path.join(root, "home"), new Map(), root);
    return { convention: "claude" as const, loadout: l, composed: composeNative(l), helpers, skills: l.skills, sdkLoads: true };
  };
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(host.projectDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(host.projectDir, rel), text);
  };

  it("load instructions and skills through the SDK's setting sources, built-in names aliased onto Studio's tools", async () => {
    write("CLAUDE.md", "Project rule only the SDK should read.");
    write(".claude/skills/naming/SKILL.md", "---\nname: naming\ndescription: Asset naming\n---\nPrefix with the zone.");
    write("Source/a.txt", "hello");
    sdk.script = async (b) => {
      // A skill told the model to use the built-in Read: it runs Studio's read_file.
      b.emit(assistant("m1", [{ type: "tool_use", id: "r1", name: "Read", input: { file_path: "Source/a.txt" } }]));
      const r = await b.call("read_file", { file_path: "Source/a.txt" });
      b.emit(results("r1", r));
      b.emit({ type: "result", subtype: "success", is_error: false, result: "done", session_id: "x" });
    };
    const runner = new AgentRunner({ host, store, provider: () => { throw new Error("unused"); }, model: () => "claude-opus-5-5", subscription: () => true, askBeforeChanges: () => false, native: nativeWith() });
    const s = store.create();
    await runner.send(s.id, "check the naming");
    await until(() => store.get(s.id)!.status === "idle");
    const o = sdk.options.at(-1)!;
    expect(o.settingSources).toEqual(["user", "project", "local"]);
    // The project's files load, but only Studio's MCP server: a project .mcp.json's ue-mcp would offer tools no call may use.
    expect(o.strictMcpConfig).toBe(true);
    expect(Object.keys(o.mcpServers as Record<string, unknown>)).toEqual(["studio"]);
    expect(o.toolAliases).toMatchObject({ Read: "mcp__studio__read_file", Bash: "mcp__studio__shell", Edit: "mcp__studio__edit_file" });
    expect(o.tools).toEqual(expect.arrayContaining(["WebSearch", "Skill"]));
    // The SDK reads CLAUDE.md itself, so Studio's prompt does not carry it as well.
    expect(String(o.systemPrompt)).not.toContain("Project rule only the SDK should read.");
    const call = store.get(s.id)!.transcript.find((t) => t.kind === "tool" && t.call.id === "r1");
    expect(call?.kind === "tool" && call.call).toMatchObject({ name: "read_file", outcome: "done" });
    expect(call?.kind === "tool" && call.call.result).toContain("hello");
  });

  it("run the project's subagent files as Studio's helpers: listed in the agent tool, each a session of its own with the tools its file allows", async () => {
    const allowed = toolsFor({ tools: ["Read", "Grep"], noShell: false }).allowed as Set<never>;
    sdk.script = async (b) => {
      if (isSubagent(b)) {
        b.emit(assistant("s1", [{ type: "text", text: "Reviewed." }]));
        b.emit({ type: "result", subtype: "success", is_error: false, session_id: "sub" });
        return;
      }
      b.emit(assistant("m_a", [toolUse("h", "agent", { description: "Review", prompt: "review the diff", helper: "reviewer" })]));
      b.emit(results("h", await b.call("agent", { description: "Review", prompt: "review the diff", helper: "reviewer" })));
      b.emit({ type: "result", subtype: "success", is_error: false, session_id: "main" });
    };
    const runner = new AgentRunner({ host, store, provider: () => { throw new Error("unused"); }, model: () => "claude-opus-5-5", subscription: () => true, askBeforeChanges: () => false, native: nativeWith([{ name: "reviewer", description: "Reviews changes", prompt: "Review carefully.", allowed, maxTurns: 5, effort: null }]) });
    const s = store.create();
    await runner.send(s.id, "review it");
    await until(() => store.get(s.id)!.status === "idle");
    const main = sdk.options.find((o) => !String(o.systemPrompt).includes("You are a subagent"))!;
    expect(main).not.toHaveProperty("agents");
    const agentTool = (main.mcpServers as { studio: { tools: Array<{ name: string; description: string }> } }).studio.tools.find((t) => t.name === "agent")!;
    expect(agentTool.description).toContain("- reviewer: Reviews changes");
    const sub = sdk.options.find((o) => String(o.systemPrompt).includes("You are a subagent"))!;
    expect(String(sub.systemPrompt)).toContain("Review carefully.");
    expect(sub.allowedTools).toEqual(["mcp__studio__read_file", "mcp__studio__grep"]);
    expect(sub.maxTurns).toBe(5);
    expect(store.get(s.id)!.transcript.find((t) => t.kind === "tool" && t.call.id === "h")).toMatchObject({ call: { outcome: "done", result: "Reviewed." } });
  });

  it("withhold every subagent tool while workers are Off, so neither Studio's nor the project's .claude/agents files run (#173)", async () => {
    write(".claude/agents/reviewer.md", "---\nname: reviewer\ndescription: Reviews changes\n---\nReview carefully.");
    sdk.script = async (b) => b.emit({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "x" });
    const runner = new AgentRunner({ host, store, provider: () => { throw new Error("unused"); }, model: () => "claude-opus-5-5", subscription: () => true, native: nativeWith(), usage: () => ({ ...DEFAULT_USAGE, subagents: "off" }) });
    const s = store.create();
    await runner.send(s.id, "hi");
    await until(() => store.get(s.id)!.status === "idle");
    const o = sdk.options.at(-1)!;
    expect(o.disallowedTools).toEqual(expect.arrayContaining(["Agent", "Task"]));
    expect(o.tools).not.toContain("Agent");
    expect(o.allowedTools).not.toContain("mcp__studio__agent");
    expect((o.mcpServers as { studio: { tools: Array<{ name: string }> } }).studio.tools.map((t) => t.name)).not.toContain("agent");
    expect(o).not.toHaveProperty("agents");
    // Only the hook that hands over a compaction's summary.
    expect(Object.keys(o.hooks as object)).toEqual(["PostCompact"]);
    expect(String(o.systemPrompt)).not.toMatch(/agent tool|subagents? runs? at once|no limit/i);
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

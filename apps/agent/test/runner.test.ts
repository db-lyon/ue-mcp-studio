/**
 * The agent loop against a fake model and a fake daemon: no network, no editor.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ActionResult, EditorStatus } from "ue-mcp/daemon";
import { AgentRunner } from "../src/runner.js";
import { BusyTracker } from "../src/busy.js";
import { SessionStore } from "../src/sessions.js";
import { SettingsStore } from "../src/settings.js";
import { GatewayProvider, type ModelProvider, type ModelRequest, type ModelTurn } from "../src/providers.js";
import { validateInput, type AgentHost } from "../src/tools.js";
import { pngBytes } from "./image-fixtures.js";
import { DEFAULT_USAGE, type UsageSettings } from "@ue-mcp-studio/shared";
import { loadout } from "../src/native.js";
import { composeNative, type NativeRun } from "../src/native-runtime.js";

class FakeHost implements AgentHost {
  connected = true;
  calls: Array<{ category: string; action: string; args?: Record<string, unknown> }> = [];
  published: Array<{ type: string; data?: Record<string, unknown> }> = [];
  busy: () => boolean = () => false;
  private listeners: Array<(e: { type: string; data: Record<string, unknown> }) => void> = [];
  handler: (category: string, action: string, args?: Record<string, unknown>) => Promise<ActionResult> =
    async () => ({ isError: false, content: [{ type: "text", text: "{\"success\":true}" }] });
  log = { info() {}, warn() {} };
  events = {
    publish: (type: string, data?: Record<string, unknown>) => {
      this.published.push({ type, data });
    },
    subscribe: (l: (e: { type: string; data: Record<string, unknown> }) => void) => {
      this.listeners.push(l);
      return () => {
        this.listeners = this.listeners.filter((x) => x !== l);
      };
    },
  };
  constructor(public projectDir: string, public dataDir: string) {}
  callAction(category: string, action: string, args?: Record<string, unknown>): Promise<ActionResult> {
    this.calls.push({ category, action, args });
    return this.handler(category, action, args);
  }
  editors(): EditorStatus[] {
    return [{ name: "P", connected: this.connected, port: 1, pid: 1, lastDisconnect: null }];
  }
  async editorOperation(op: string) {
    return { op, steps: [{ step: `editor.${op}_editor`, ok: true }] };
  }
  setBusy(fn: () => boolean): void {
    this.busy = fn;
  }
  emit(type: string, data: Record<string, unknown> = {}): void {
    for (const l of this.listeners) l({ type, data });
  }
}

/** A model that answers from a script, one turn per call, and records what it was sent. */
class ScriptedModel implements ModelProvider {
  requests: ModelRequest[] = [];
  constructor(private readonly turns: Array<(req: ModelRequest) => ModelTurn>) {}
  async run(req: ModelRequest, onText: (t: string) => void): Promise<ModelTurn> {
    this.requests.push(JSON.parse(JSON.stringify(req)));
    const next = this.turns.shift();
    if (!next) throw new Error("script exhausted");
    const turn = next(req);
    for (const b of turn.content) if (b.type === "text") onText(b.text);
    return turn;
  }
}

const text = (t: string): ModelTurn => ({ content: [{ type: "text", text: t, citations: null } as never], stopReason: "end_turn" });
const call = (id: string, category: string, method: string, args: Record<string, unknown> = {}): ModelTurn => ({
  content: [{ type: "tool_use", id, name: "ue_mcp", input: { action: "call", category, method, args } } as never],
  stopReason: "tool_use",
});

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met");
    await new Promise((r) => setTimeout(r, 5));
  }
}

let root: string;
let host: FakeHost;
let store: SessionStore;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-agent-"));
  fs.mkdirSync(path.join(root, "project", "Content"), { recursive: true });
  host = new FakeHost(path.join(root, "project"), path.join(root, "data"));
  store = new SessionStore(host.dataDir);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** The project's own Claude Code files as chat-routes reads them, bounded to the test's folder. */
function nativeClaude(): NativeRun {
  const l = loadout("claude", host.projectDir, path.join(root, "home"), new Map(), root);
  return { convention: "claude", loadout: l, composed: composeNative(l), helpers: [], skills: l.skills, sdkLoads: false };
}

function runnerWith(model: ScriptedModel, s = store): AgentRunner {
  return new AgentRunner({ host, store: s, provider: () => model, model: () => "claude-opus-5-5" });
}

describe("a turn", () => {
  it("runs a tool call in process and returns its result to the model in one message", async () => {
    const model = new ScriptedModel([() => call("t1", "level", "get_outliner"), () => text("Done.")]);
    const runner = runnerWith(model);
    const s = store.create();
    await runner.send(s.id, "what is in the level");

    expect(host.calls).toEqual([{ category: "level", action: "get_outliner", args: {} }]);
    const fin = store.get(s.id)!;
    expect(fin.status).toBe("idle");
    expect(fin.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    const results = fin.messages[2].content as Array<{ type: string; tool_use_id?: string }>;
    expect(results).toEqual([expect.objectContaining({ type: "tool_result", tool_use_id: "t1" })]);
    expect(fin.transcript.map((t) => t.kind)).toEqual(["user", "tool", "assistant"]);
    expect(host.published.some((e) => e.type === "turn.delta")).toBe(true);
    // The model request carries the cached system prompt and the two tools.
    expect(model.requests[0].tools.map((t) => (t as { name: string }).name)).toEqual(["ue_mcp", "editor_restart", "shell", "read_file", "write_file", "edit_file", "glob", "grep", "web_fetch", "agent"]);
  });

  it("finds and describes actions through ue-mcp's own discovery actions", async () => {
    const model = new ScriptedModel([
      () => ({ content: [{ type: "tool_use", id: "s", name: "ue_mcp", input: { action: "search", query: "spawn a light" } } as never], stopReason: "tool_use" }),
      () => ({ content: [{ type: "tool_use", id: "d", name: "ue_mcp", input: { action: "describe", category: "level", method: "spawn_light" } } as never], stopReason: "tool_use" }),
      () => text("ok"),
    ]);
    const s = store.create();
    await runnerWith(model).send(s.id, "light it");
    expect(host.calls).toEqual([
      { category: "project", action: "search_tools", args: { query: "spawn a light", limit: 15 } },
      { category: "project", action: "describe_action", args: { name: "level.spawn_light" } },
    ]);
  });
});

describe("attachments in a message", () => {
  it("go to the model before the text, and into the transcript by name", async () => {
    const model = new ScriptedModel([() => text("Seen.")]);
    const s = store.create();
    const file = path.join(root, "ref.png");
    fs.writeFileSync(file, pngBytes(4, 4));
    await runnerWith(model).send(s.id, "use this", [{ id: "a1", name: "ref.png", type: "image/png", size: 3, path: file }]);
    const sent = model.requests[0].messages[0].content as Array<{ type: string }>;
    expect(sent.map((b) => b.type)).toEqual(["text", "image", "text"]);
    const entry = store.get(s.id)!.transcript[0];
    expect(entry.kind === "user" && entry.attachments).toEqual([{ id: "a1", name: "ref.png", type: "image/png", size: 3 }]);
  });
});

describe("images a tool shows the model", () => {
  it("go to the model in the tool result, and into the transcript as the session's files", async () => {
    fs.writeFileSync(path.join(host.projectDir, "shot.png"), pngBytes(12, 6));
    const read: ModelTurn = { content: [{ type: "tool_use", id: "r1", name: "read_file", input: { path: "shot.png" } } as never], stopReason: "tool_use" };
    const model = new ScriptedModel([() => read, () => text("A flat orange picture.")]);
    const s = store.create();
    await runnerWith(model).send(s.id, "what is in shot.png");
    const sent = model.requests[1].messages[2].content as Array<{ type: string; content: Array<{ type: string }> }>;
    expect(sent[0].type).toBe("tool_result");
    expect(sent[0].content.map((b) => b.type)).toEqual(["text", "image"]);
    const entry = store.get(s.id)!.transcript.find((t) => t.kind === "tool");
    const images = entry?.kind === "tool" ? entry.call.images : undefined;
    expect(images).toEqual([expect.objectContaining({ name: "shot.png", type: "image/png" })]);
    // The panel fetches it by id from the session's files.
    const kept = fs.readdirSync(path.join(host.dataDir, "attachments", s.id));
    expect(kept).toContain(`${images![0].id}-shot.png`);
  });

  it("reach a subagent's model too", async () => {
    fs.writeFileSync(path.join(host.projectDir, "a.png"), pngBytes(4, 4));
    const model = new ScriptedModel([
      () => ({ content: [{ type: "tool_use", id: "ag", name: "agent", input: { description: "look", prompt: "look at a.png" } } as never], stopReason: "tool_use" }),
      () => ({ content: [{ type: "tool_use", id: "r2", name: "read_file", input: { path: "a.png" } } as never], stopReason: "tool_use" }),
      () => text("It is orange."),
      () => text("Done."),
    ]);
    const s = store.create();
    await runnerWith(model).send(s.id, "check a.png");
    const sub = model.requests[2].messages[2].content as Array<{ content: Array<{ type: string }> }>;
    expect(sub[0].content.map((b) => b.type)).toEqual(["text", "image"]);
  });
});

describe("archived sessions", () => {
  it("are listed as archived, and come back when the user sends to one", async () => {
    const s = store.create();
    s.archived = true;
    store.save(s);
    expect(SessionStore.summary(store.get(s.id)!).archived).toBe(true);
    await runnerWith(new ScriptedModel([() => text("Hi.")])).send(s.id, "hello again");
    expect(SessionStore.summary(store.get(s.id)!).archived).toBe(false);
  });
});

describe("subagents", () => {
  it("runs each agent call as its own conversation, at the same time, and returns each report", async () => {
    let running = 0;
    let most = 0;
    const requests: ModelRequest[] = [];
    const model: ModelProvider = {
      async run(req) {
        requests.push(JSON.parse(JSON.stringify(req)));
        const sub = req.system.some((b) => b.text.includes("You are a subagent"));
        if (!sub) {
          if (req.messages.length === 1) {
            return {
              content: [
                { type: "tool_use", id: "a1", name: "agent", input: { description: "Red material", prompt: "make red" } },
                { type: "tool_use", id: "a2", name: "agent", input: { description: "Blue material", prompt: "make blue" } },
              ] as never,
              stopReason: "tool_use",
            };
          }
          return text("Both made.");
        }
        const task = req.messages[0].content as string;
        if (req.messages.length === 1) {
          running++;
          most = Math.max(most, running);
          await new Promise((r) => setTimeout(r, 20));
          running--;
          return call(`c-${task}`, "material", "create", { name: task });
        }
        return text(`Report: ${task} done.`);
      },
    };
    const runner = new AgentRunner({ host, store, provider: () => model, model: () => "claude-opus-5-5" });
    const s = store.create();
    await runner.send(s.id, "make two materials");

    const fin = store.get(s.id)!;
    expect(fin.status).toBe("idle");
    expect(most).toBe(2);
    // A subagent gets the work tools only, so it cannot start subagents of its own.
    const subTools = requests.find((r) => r.system.some((b) => b.text.includes("You are a subagent")))!.tools.map((t) => (t as { name: string }).name);
    expect(subTools).toEqual(["ue_mcp", "editor_restart", "shell", "read_file", "write_file", "edit_file", "glob", "grep", "web_fetch"]);
    // Both prompts ask for assets as markdown links to their full object path.
    const link = "markdown link to its full object path";
    expect(requests.find((r) => r.system.some((b) => b.text.includes("You are a subagent")))!.system[0].text).toContain(link);
    expect(requests.find((r) => !r.system.some((b) => b.text.includes("You are a subagent")))!.system[0].text).toContain(link);
    const results = fin.messages[2].content as Array<{ tool_use_id: string; content: string }>;
    expect(results.map((r) => [r.tool_use_id, r.content])).toEqual([["a1", "Report: make red done."], ["a2", "Report: make blue done."]]);
    // Their steps are in the transcript under the call that started them.
    expect(fin.transcript.filter((t) => t.parent === "a1").map((t) => t.kind)).toEqual(["tool", "assistant"]);
    expect(fin.transcript.filter((t) => t.parent === "a2").map((t) => t.kind)).toEqual(["tool", "assistant"]);
    expect(fin.transcript.filter((t) => !t.parent).map((t) => t.kind)).toEqual(["user", "tool", "tool", "assistant"]);
  });
});

describe("stopping one subagent", () => {
  it("stops that subagent, lets the other finish, and tells the main agent the user stopped it", async () => {
    let mainCalls = 0;
    let seenResults: Array<{ tool_use_id: string; content: string }> = [];
    const model: ModelProvider = {
      async run(req, _onText, signal) {
        const sub = req.system.some((b) => b.text.includes("You are a subagent"));
        if (!sub) {
          mainCalls++;
          if (mainCalls === 1) {
            return {
              content: [
                { type: "tool_use", id: "slow", name: "agent", input: { description: "Slow", prompt: "slow" } },
                { type: "tool_use", id: "fast", name: "agent", input: { description: "Fast", prompt: "fast" } },
              ] as never,
              stopReason: "tool_use",
            };
          }
          seenResults = req.messages[2].content as never;
          return text("Carried on.");
        }
        if ((req.messages[0].content as string) === "fast") return text("Fast done.");
        // The slow one waits until it is stopped.
        await new Promise((_r, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
        return text("never");
      },
    };
    const runner = new AgentRunner({ host, store, provider: () => model, model: () => "claude-opus-5-5" });
    const s = store.create();
    const turn = runner.send(s.id, "two");
    await until(() => store.get(s.id)!.transcript.some((t) => t.kind === "tool" && t.call.id === "fast" && t.call.outcome === "done"));
    expect(SessionStore.summary(store.get(s.id)!).agents).toEqual({ total: 2, running: 1 });
    expect(runner.stopSubagent(s.id, "slow")).toBe(true);
    await turn;

    const fin = store.get(s.id)!;
    expect(fin.status).toBe("idle");
    const slow = fin.transcript.find((t) => t.kind === "tool" && t.call.id === "slow");
    expect(slow?.kind === "tool" && slow.call.outcome).toBe("stopped");
    expect(seenResults.find((r) => r.tool_use_id === "slow")!.content).toMatch(/user stopped this subagent/);
    expect(seenResults.find((r) => r.tool_use_id === "fast")!.content).toBe("Fast done.");
    expect(runner.stopSubagent(s.id, "slow")).toBe(false);
    expect(SessionStore.summary(fin).agents).toEqual({ total: 2, running: 0 });
  });

  it("marks every running call stopped when the whole turn is stopped", async () => {
    const model: ModelProvider = {
      async run(req, _onText, signal) {
        if (!req.system.some((b) => b.text.includes("You are a subagent"))) {
          return { content: [{ type: "tool_use", id: "a", name: "agent", input: { description: "A", prompt: "a" } }] as never, stopReason: "tool_use" };
        }
        await new Promise((_r, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
        return text("never");
      },
    };
    const runner = new AgentRunner({ host, store, provider: () => model, model: () => "claude-opus-5-5" });
    const s = store.create();
    void runner.send(s.id, "go");
    await until(() => store.get(s.id)!.transcript.some((t) => t.kind === "tool" && t.call.id === "a"));
    runner.stop(s.id);
    const fin = store.get(s.id)!;
    expect(fin.status).toBe("stopped");
    expect(fin.transcript.filter((t) => t.kind === "tool").map((t) => t.kind === "tool" && t.call.outcome)).toEqual(["stopped"]);
  });
});

describe("the editor going away", () => {
  it("pauses at the tool-call boundary and resumes when the editor is back", async () => {
    host.connected = false;
    const model = new ScriptedModel([() => call("t1", "level", "get_outliner"), () => text("Back.")]);
    const runner = runnerWith(model);
    const s = store.create();
    host.emit("editor.disconnected", { cause: "closed" });
    await runner.send(s.id, "go");

    expect(store.get(s.id)!.status).toBe("waiting");
    expect(store.get(s.id)!.waitingCause).toBe("the editor was closed");
    expect(host.calls).toHaveLength(0);
    expect(host.busy()).toBe(true);

    host.connected = true;
    host.emit("editor.connected");
    await until(() => store.get(s.id)!.status === "idle");
    expect(host.calls).toHaveLength(1);
    expect(host.busy()).toBe(false);
  });

  it("never reruns a call whose outcome is unknown, and tells the model to verify", async () => {
    host.handler = async () => {
      host.connected = false;
      throw new Error("Bridge connection lost (close code 1006)");
    };
    const model = new ScriptedModel([
      () => call("t1", "blueprint", "create", { assetPath: "/Game/BP_Door" }),
      (req) => {
        const last = req.messages.at(-1)!.content as Array<{ type: string; content?: string }>;
        expect(last[0].content).toMatch(/Outcome unknown: the editor went away \(the editor crashed\)/);
        expect(last[0].content).toMatch(/On disk now: \/Game\/BP_Door does not exist/);
        return text("I will check first.");
      },
    ]);
    const runner = runnerWith(model);
    const s = store.create();
    const sending = runner.send(s.id, "make a door");
    host.emit("editor.disconnected", { cause: "crashed" });
    await sending;
    expect(store.get(s.id)!.status).toBe("waiting");

    host.handler = async () => ({ isError: false, content: [{ type: "text", text: "{}" }] });
    host.connected = true;
    host.emit("editor.connected");
    await until(() => store.get(s.id)!.status === "idle");
    expect(host.calls.filter((c) => c.action === "create")).toHaveLength(1);
    const entry = store.get(s.id)!.transcript.find((t) => t.kind === "tool");
    expect(entry && entry.kind === "tool" && entry.call.outcome).toBe("unknown");
  });

  it("after a crash, lists what the session changed and never saved before the model continues", async () => {
    host.handler = async (_c, action) => ({
      isError: false,
      content: [{ type: "text", text: action === "create" ? "{\"created\":true}" : "{\"created\":true,\"saved\":true}" }],
    });
    fs.mkdirSync(path.join(host.projectDir, "Content", "Kept"), { recursive: true });
    fs.writeFileSync(path.join(host.projectDir, "Content", "Kept", "BP_Saved.uasset"), "x");
    const model = new ScriptedModel([
      () => ({
        content: [
          { type: "tool_use", id: "a", name: "ue_mcp", input: { action: "call", category: "blueprint", method: "create", args: { assetPath: "/Game/BP_Unsaved" } } },
          { type: "tool_use", id: "b", name: "ue_mcp", input: { action: "call", category: "blueprint", method: "create_and_save", args: { assetPath: "/Game/Kept/BP_Saved" } } },
        ] as never,
        stopReason: "tool_use",
      }),
      () => text("Made two."),
      (req) => {
        const first = (req.messages.at(-1)!.content as Array<{ type: string; text?: string }>)[0];
        expect(first.text).toMatch(/The editor crashed\. These changes are gone/);
        expect(first.text).toMatch(/asset \/Game\/BP_Unsaved \(not saved\)/);
        expect(first.text).not.toMatch(/BP_Saved/);
        return text("Redoing it.");
      },
    ]);
    const runner = runnerWith(model);
    const s = store.create();
    await runner.send(s.id, "make two");
    host.emit("editor.disconnected", { cause: "crashed" });
    await runner.send(s.id, "continue");
    const fin = store.get(s.id)!;
    expect(fin.transcript.some((t) => t.kind === "note")).toBe(true);
    expect(fin.touched).toEqual([{ kind: "asset", path: "/Game/Kept/BP_Saved", saved: true }]);
  });

  it("a restart tool call waits for the editor and then continues", async () => {
    host.editorOperation = async (op: string) => {
      host.connected = false;
      return { op, steps: [{ step: "editor.restart_editor", ok: true }] };
    };
    const model = new ScriptedModel([
      () => ({ content: [{ type: "tool_use", id: "r", name: "editor_restart", input: { operation: "restart", reason: "plugin enabled" } } as never], stopReason: "tool_use" }),
      () => text("Restarted."),
    ]);
    const runner = runnerWith(model);
    const s = store.create();
    await runner.send(s.id, "restart");
    expect(store.get(s.id)!.status).toBe("waiting");
    host.connected = true;
    host.emit("editor.connected");
    await until(() => store.get(s.id)!.status === "idle");
    expect(store.get(s.id)!.transcript.at(-1)).toMatchObject({ kind: "assistant", text: "Restarted." });
  });
});

describe("the editor gone with nothing bringing it back (#1384)", () => {
  const busyOn = () => new BusyTracker((type, data) => host.emit(`studio.${type}`, data), Date.now, () => host.connected);
  const restart = (op: string): ModelTurn => ({ content: [{ type: "tool_use", id: "r", name: "editor_restart", input: { operation: op, reason: "C++ changed" } } as never], stopReason: "tool_use" });

  it("a rebuild whose build failed is an error, not a wait", async () => {
    const busy = busyOn();
    host.editorOperation = async (op: string) => {
      host.connected = false;
      return { op, steps: [
        { step: "editor.stop_editor", ok: true, result: JSON.stringify({ success: true }) },
        { step: "project.build", ok: false, result: JSON.stringify({ success: false, exitCode: 6, message: "Build failed with exit code 6" }) },
      ] };
    };
    const model = new ScriptedModel([() => restart("rebuild"), () => text("The build failed.")]);
    const runner = new AgentRunner({ host, store, provider: () => model, model: () => "claude-opus-5-5", busy });
    const s = store.create();
    await runner.send(s.id, "rebuild");
    expect(store.get(s.id)!.status).toBe("idle");
    const result = model.requests[1].messages.at(-1)!.content as Array<{ type: string; content: string; is_error?: boolean }>;
    expect(result[0]).toMatchObject({ is_error: true });
    expect(result[0].content).toMatch(/^rebuild failed at project.build/);
    expect(busy.state().failure).toMatchObject({ op: "rebuild", step: "project.build", reason: "Build failed with exit code 6" });
  });

  it("an editor call goes ahead with no restart running instead of waiting, and the cause says what is true", async () => {
    const busy = busyOn();
    host.connected = false;
    host.emit("editor.disconnected", { cause: "rebuild" });
    host.handler = async () => ({ isError: true, content: [{ type: "text", text: "Error [NOT_CONNECTED]: the editor is not running" }] });
    const model = new ScriptedModel([() => call("t1", "feedback", "submit", { title: "x" }), () => text("Noted.")]);
    const runner = new AgentRunner({ host, store, provider: () => model, model: () => "claude-opus-5-5", busy });
    const s = store.create();
    await runner.send(s.id, "file it");
    expect(store.get(s.id)!.status).toBe("idle");
    expect(host.calls.map((c) => `${c.category}.${c.action}`)).toEqual(["feedback.submit"]);
  });

  it("a paused turn resumes when the wait for the editor to attach runs out", async () => {
    const busy = new BusyTracker((type, data) => host.emit(`studio.${type}`, data), Date.now, () => host.connected, 50);
    host.editorOperation = async (op: string) => {
      host.connected = false;
      host.emit("editor.operation", { op, step: "editor.restart_editor", phase: "started" });
      host.emit("editor.operation", { op, step: "editor.restart_editor", phase: "done" });
      return { op, steps: [{ step: "editor.restart_editor", ok: true, result: JSON.stringify({ success: true }) }] };
    };
    const unobserve = host.events.subscribe((e) => busy.observe(e));
    const model = new ScriptedModel([() => restart("restart"), () => text("It did not come back.")]);
    const runner = new AgentRunner({ host, store, provider: () => model, model: () => "claude-opus-5-5", busy });
    const s = store.create();
    await runner.send(s.id, "restart");
    expect(store.get(s.id)!.status).toBe("waiting");
    expect(store.get(s.id)!.waitingCause).toBe("the editor is restarting");
    await until(() => store.get(s.id)!.status === "idle");
    expect(store.get(s.id)!.transcript.at(-1)).toMatchObject({ kind: "assistant", text: "It did not come back." });
    unobserve();
  });
});

describe("persistence", () => {
  it("survives a daemon restart mid-turn: a call that was running becomes unknown, then the turn finishes", async () => {
    const model1 = new ScriptedModel([() => call("t1", "level", "spawn_actor", { actorLabel: "Lamp" })]);
    let release!: () => void;
    host.handler = () => new Promise<ActionResult>(() => {
      release = () => undefined;
    });
    const runner1 = runnerWith(model1);
    const s = store.create();
    void runner1.send(s.id, "add a lamp");
    await until(() => store.get(s.id)!.pending?.[0]?.state === "running");
    release();
    runner1.dispose();

    // A new daemon: fresh store and runner over the same files.
    const store2 = new SessionStore(host.dataDir);
    expect(store2.get(s.id)!.pending?.[0].state).toBe("running");
    host.handler = async () => ({ isError: false, content: [{ type: "text", text: "{}" }] });
    const model2 = new ScriptedModel([
      (req) => {
        const last = req.messages.at(-1)!.content as Array<{ content?: string }>;
        expect(last[0].content).toMatch(/Outcome unknown/);
        return text("Checked.");
      },
    ]);
    const runner2 = new AgentRunner({ host, store: store2, provider: () => model2, model: () => "claude-opus-5-5" });
    runner2.recover();
    await until(() => store2.get(s.id)!.status === "idle");
    expect(store2.get(s.id)!.transcript[0]).toMatchObject({ kind: "user", text: "add a lamp" });
  });

  it("a Stop during editor_restart says the rebuild goes on, and the next message carries that to the model", async () => {
    let finish!: () => void;
    host.editorOperation = (op: string) => new Promise((resolve) => {
      host.connected = false;
      finish = () => resolve({ op, steps: [{ step: "project.build", ok: true }] });
    });
    const model = new ScriptedModel([
      () => ({ content: [{ type: "tool_use", id: "r", name: "editor_restart", input: { operation: "rebuild", reason: "C++" } } as never], stopReason: "tool_use" }),
      (req) => {
        const last = req.messages.at(-1)!.content as Array<{ type: string; text?: string }>;
        expect(last[0].text).toMatch(/^\[Studio\] The user pressed Stop.*editor_restart \(rebuild\) was running/);
        return text("The rebuild was still going.");
      },
    ]);
    const runner = runnerWith(model);
    const s = store.create();
    const turn = runner.send(s.id, "rebuild");
    await until(() => store.get(s.id)!.pending?.[0]?.state === "running");
    runner.stop(s.id);
    finish();
    await turn;
    const stopped = store.get(s.id)!;
    expect(stopped.transcript.find((t) => t.kind === "tool")).toMatchObject({ call: { outcome: "stopped" } });
    const result = (stopped.messages.at(-1)!.content as Array<{ content: string }>)[0].content;
    expect(result).toMatch(/^Stopped by the user while this was running.*the rebuild goes on in the daemon/);
    host.connected = true;
    await runner.send(s.id, "what happened?");
    expect(store.get(s.id)!.status).toBe("idle");
  });

  it("stopping answers the unanswered calls so the conversation stays valid", async () => {
    host.connected = false;
    const model = new ScriptedModel([() => call("t1", "level", "get_outliner")]);
    const runner = runnerWith(model);
    const s = store.create();
    await runner.send(s.id, "go");
    runner.stop(s.id);
    const fin = store.get(s.id)!;
    expect(fin.status).toBe("stopped");
    expect(fin.pending).toBeNull();
    expect((fin.messages.at(-1)!.content as Array<{ type: string; is_error?: boolean }>)[0]).toMatchObject({ type: "tool_result", is_error: true });
  });
});

describe("stopping while the editor is busy", () => {
  it("ends the turn at once, keeps it stopped when the call returns, and the busy state follows the call", async () => {
    let finish: () => void = () => {};
    host.handler = () => new Promise((resolve) => (finish = () => resolve({ isError: false, content: [{ type: "text", text: "{\"success\":true}" }] })));
    const busy = new BusyTracker();
    const model = new ScriptedModel([() => call("t1", "editor", "execute_python", { code: "import time; time.sleep(20)" }), () => text("never")]);
    const runner = new AgentRunner({ host, store, provider: () => model, model: () => "claude-opus-5-5", busy });
    const s = store.create();
    const turn = runner.send(s.id, "block the editor");
    await until(() => busy.state().calls.length === 1);
    expect(busy.state().calls[0]).toMatchObject({ category: "editor", action: "execute_python", sessionId: s.id });

    expect(busy.stop((id) => runner.stop(id))).toEqual([s.id]);
    expect(store.get(s.id)!.status).toBe("stopped");

    finish();
    await turn;
    await until(() => busy.state().calls.length === 0);
    const fin = store.get(s.id)!;
    expect(fin.status).toBe("stopped");
    expect(model.requests).toHaveLength(1);
  });
});

describe("inputs and settings", () => {
  it("refuses malformed tool input before running it", () => {
    expect(validateInput("ue_mcp", { action: "call", category: "level" })).toMatch(/needs category and method/);
    expect(validateInput("ue_mcp", { action: "search" })).toMatch(/needs query/);
    expect(validateInput("editor_restart", { operation: "reboot" })).toMatch(/restart or rebuild/);
    expect(validateInput("ue_mcp", { action: "call", category: "a", method: "b", args: {} })).toBeNull();
  });

  it("stores each provider's key apart from the settings and never reports it back", () => {
    const settings = new SettingsStore(path.join(root, "settings"), path.join(root, "keys"));
    settings.update({ keys: { openai: "sk-test-123" }, provider: "openai", model: "gpt-6-sol" });
    const view = settings.view();
    expect(view).toMatchObject({ provider: "openai", model: "gpt-6-sol", keys: { openai: true, anthropic: false, google: false } });
    expect(JSON.stringify(view)).not.toContain("sk-test-123");
    expect(fs.readFileSync(path.join(root, "settings", "settings.json"), "utf-8")).not.toContain("sk-test-123");
    expect(settings.key("openai")).toBe("sk-test-123");
    settings.update({ keys: { openai: "" } });
    expect(settings.view().keys.openai).toBe(false);
    expect(() => settings.update({ gatewayUrl: "ftp://x" })).toThrow(/http/);
    expect(() => settings.update({ keys: { studio: "x" } as never })).toThrow(/no key provider/);
  });

  it("sends the gateway the Messages body with the account token and session id", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.url = url;
      seen.init = init;
      return new Response(JSON.stringify({ content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" }), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = new GatewayProvider("https://gw.example", "acct-token", "0.0.0-test", fetchImpl);
    const out: string[] = [];
    const turn = await provider.run(
      { sessionId: "sess-1", model: "claude-opus-5-5", system: [{ type: "text", text: "s" }], tools: [], messages: [{ role: "user", content: "hello" }] },
      (t) => out.push(t),
      new AbortController().signal,
    );
    expect(seen.url).toBe("https://gw.example/v1/messages");
    const headers = seen.init!.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer acct-token");
    expect(headers["x-ue-mcp-session"]).toBe("sess-1");
    expect(headers["x-ue-mcp-client"]).toBe("studio-agent/0.0.0-test");
    const body = JSON.parse(String(seen.init!.body));
    expect(body).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default", cache_control: { type: "ephemeral" } });
    expect(body.betas).toBeUndefined();
    expect(out).toEqual(["hi"]);
    expect(turn.stopReason).toBe("end_turn");
  });
});

describe("asking before a command or a file change", () => {
  const use = (id: string, name: string, input: Record<string, unknown>): ModelTurn => ({
    content: [{ type: "tool_use", id, name, input } as never],
    stopReason: "tool_use",
  });
  const write = (id: string, file: string) => use(id, "write_file", { path: file, content: "hello" });
  const resultOf = (sid: string, id: string) => {
    const s = store.get(sid)!;
    for (const m of s.messages) {
      if (!Array.isArray(m.content)) continue;
      const r = (m.content as Array<{ type: string; tool_use_id?: string; content?: string; is_error?: boolean }>).find((b) => b.type === "tool_result" && b.tool_use_id === id);
      if (r) return r;
    }
    return null;
  };
  const waiting = (sid: string) => () => (store.get(sid)!.approvals ?? []).length > 0;

  it("holds the call until the user allows it, then runs it", async () => {
    const runner = runnerWith(new ScriptedModel([() => write("w1", "out.txt"), () => text("Written.")]));
    const s = store.create();
    const turn = runner.send(s.id, "write it");
    await until(waiting(s.id));

    const a = SessionStore.detail(store.get(s.id)!).approvals[0];
    expect(a).toMatchObject({ tool: "write_file", toolUseId: "w1", parent: null, creates: true, path: path.join(host.projectDir, "out.txt"), diff: [{ op: "+", text: "hello" }] });
    expect(SessionStore.summary(store.get(s.id)!).awaiting).toBe(1);
    expect(host.published.some((e) => e.type === "approval.requested" && e.data?.approvalId === a.id)).toBe(true);
    expect(fs.existsSync(path.join(host.projectDir, "out.txt"))).toBe(false);

    expect(runner.answerApproval(s.id, a.id, "allow")).toBe(true);
    await turn;
    expect(fs.readFileSync(path.join(host.projectDir, "out.txt"), "utf-8")).toBe("hello");
    expect(resultOf(s.id, "w1")?.is_error).toBeUndefined();
    expect(store.get(s.id)!.approvals).toEqual([]);
    expect(store.get(s.id)!.status).toBe("idle");
    expect(runner.answerApproval(s.id, a.id, "allow")).toBe(false);
  });

  it("tells the model the user declined, and never runs the call", async () => {
    const runner = runnerWith(new ScriptedModel([() => write("w1", "no.txt"), () => text("Understood.")]));
    const s = store.create();
    const turn = runner.send(s.id, "write it");
    await until(waiting(s.id));
    runner.answerApproval(s.id, store.get(s.id)!.approvals![0].id, "deny");
    await turn;

    expect(fs.existsSync(path.join(host.projectDir, "no.txt"))).toBe(false);
    const r = resultOf(s.id, "w1")!;
    expect(r.is_error).toBe(true);
    expect(r.content).toMatch(/user declined this file change/);
    const entry = store.get(s.id)!.transcript.find((t) => t.kind === "tool" && t.call.id === "w1");
    expect(entry?.kind === "tool" && entry.call.outcome).toBe("declined");
  });

  it("asks a command once when the user allows commands for the session", async () => {
    const runner = runnerWith(new ScriptedModel([
      () => use("c1", "shell", { command: "echo one" }),
      () => use("c2", "shell", { command: "echo two" }),
      () => text("Ran both."),
    ]));
    const s = store.create();
    const turn = runner.send(s.id, "run");
    await until(waiting(s.id));
    const a = store.get(s.id)!.approvals![0];
    expect(a).toMatchObject({ tool: "shell", command: "echo one", cwd: host.projectDir });
    runner.answerApproval(s.id, a.id, "session");
    await turn;
    expect(resultOf(s.id, "c1")!.content).toContain("one");
    expect(resultOf(s.id, "c2")!.content).toMatch(/two\s+Exit code: 0/);
    expect(host.published.filter((e) => e.type === "approval.requested")).toHaveLength(1);
    expect(store.get(s.id)!.allowed).toEqual(["shell"]);
  });

  it("does not ask for reads, or at all when the setting is off", async () => {
    fs.writeFileSync(path.join(host.projectDir, "r.txt"), "x");
    const model = new ScriptedModel([() => use("r1", "read_file", { path: "r.txt" }), () => write("w1", "free.txt"), () => text("ok")]);
    const runner = new AgentRunner({ host, store, provider: () => model, model: () => "claude-opus-5-5", askBeforeChanges: () => false });
    const s = store.create();
    await runner.send(s.id, "go");
    expect(resultOf(s.id, "r1")!.content).toBe("1\tx");
    expect(fs.existsSync(path.join(host.projectDir, "free.txt"))).toBe(true);
    expect(host.published.some((e) => e.type === "approval.requested")).toBe(false);
  });

  it("asks for a subagent's call, naming the subagent, and runs it once allowed", async () => {
    const model: ModelProvider = {
      async run(req) {
        const sub = req.system.some((b) => b.text.includes("You are a subagent"));
        if (!sub) {
          return req.messages.length === 1
            ? { content: [{ type: "tool_use", id: "a1", name: "agent", input: { description: "Write notes", prompt: "write notes" } }] as never, stopReason: "tool_use" }
            : text("Done.");
        }
        return req.messages.length === 1 ? write("sw1", "Docs/notes.md") : text("Wrote Docs/notes.md.");
      },
    };
    const runner = new AgentRunner({ host, store, provider: () => model, model: () => "claude-opus-5-5" });
    const s = store.create();
    const turn = runner.send(s.id, "notes");
    await until(waiting(s.id));
    const a = store.get(s.id)!.approvals![0];
    expect(a).toMatchObject({ toolUseId: "sw1", parent: "a1", subagent: "Write notes", tool: "write_file" });
    runner.answerApproval(s.id, a.id, "allow");
    await turn;
    expect(fs.readFileSync(path.join(host.projectDir, "Docs", "notes.md"), "utf-8")).toBe("hello");
    expect(resultOf(s.id, "a1")!.content).toBe("Wrote Docs/notes.md.");
  });

  it("drops a waiting approval when the turn is stopped", async () => {
    const runner = runnerWith(new ScriptedModel([() => use("c1", "shell", { command: "echo never" })]));
    const s = store.create();
    const turn = runner.send(s.id, "run");
    await until(waiting(s.id));
    runner.stop(s.id);
    await turn;
    const fin = store.get(s.id)!;
    expect(fin.status).toBe("stopped");
    expect(fin.approvals).toEqual([]);
    expect(resultOf(s.id, "c1")!.content).toMatch(/Stopped by the user/);
  });

  it("forgets approvals a previous daemon was holding", () => {
    const s = store.create();
    s.approvals = [{ id: "old", toolUseId: "t", tool: "shell", parent: null, command: "ls", at: new Date().toISOString() }];
    store.save(s);
    runnerWith(new ScriptedModel([])).recover();
    expect(store.get(s.id)!.approvals).toEqual([]);
  });
});

describe("the provider's own web search", () => {
  it("is recorded in the transcript, and a paused turn is sent back to go on", async () => {
    const model = new ScriptedModel([
      () => ({ content: [], stopReason: "pause_turn", searches: [{ id: "ws1", query: "ue 5.8 notes", results: [{ title: "Notes", url: "https://example.com/n" }] }] }),
      () => text("Found it."),
    ]);
    const s = store.create();
    await runnerWith(model).send(s.id, "search");
    expect(model.requests).toHaveLength(2);
    const fin = store.get(s.id)!;
    const ws = fin.transcript.find((t) => t.kind === "tool" && t.call.name === "web_search");
    expect(ws?.kind === "tool" && ws.call).toMatchObject({ input: { query: "ue 5.8 notes" }, outcome: "done", result: "Notes\nhttps://example.com/n" });
    expect(fin.status).toBe("idle");
  });
});

/** A model whose turns wait until the test lets each one finish. */
class GatedModel implements ModelProvider {
  requests: ModelRequest[] = [];
  private gates: Array<() => void> = [];
  async run(req: ModelRequest, _onText: (t: string) => void, signal: AbortSignal): Promise<ModelTurn> {
    this.requests.push(JSON.parse(JSON.stringify(req)));
    await new Promise<void>((resolve, reject) => {
      this.gates.push(resolve);
      signal.addEventListener("abort", () => {
        this.gates = this.gates.filter((g) => g !== resolve);
        reject(new Error("aborted"));
      }, { once: true });
    });
    return text(`answer ${this.requests.length}`);
  }
  release(): void {
    this.gates.shift()?.();
  }
  get waiting(): number {
    return this.gates.length;
  }
}

const userTexts = (m: MessageParamLike[]) => m.filter((x) => x.role === "user").map((x) => (typeof x.content === "string" ? x.content : (x.content as Array<{ type: string; text?: string }>).filter((b) => b.type === "text").map((b) => b.text).join(" ")));
type MessageParamLike = { role: string; content: unknown };

describe("queued messages", () => {
  it("wait for the running turn, then go one by one, in order", async () => {
    const model = new GatedModel();
    const runner = runnerWith(model as unknown as ScriptedModel);
    const s = store.create();
    const first = runner.send(s.id, "one");
    await until(() => model.waiting === 1);
    runner.enqueue(s.id, "two", []);
    runner.enqueue(s.id, "three", []);
    expect(store.get(s.id)!.queue!.map((q) => q.text)).toEqual(["two", "three"]);
    model.release();
    await first;
    await until(() => model.waiting === 1 && store.get(s.id)!.queue!.length === 1);
    model.release();
    await until(() => model.waiting === 1 && store.get(s.id)!.queue!.length === 0);
    model.release();
    await until(() => store.get(s.id)!.status === "idle" && model.requests.length === 3);
    expect(store.get(s.id)!.transcript.filter((t) => t.kind === "user").map((t) => t.kind === "user" && t.text)).toEqual(["one", "two", "three"]);
  });

  it("can be changed or removed before they go, and wait after a Stop until asked", async () => {
    const model = new GatedModel();
    const runner = runnerWith(model as unknown as ScriptedModel);
    const s = store.create();
    void runner.send(s.id, "one");
    await until(() => model.waiting === 1);
    const a = runner.enqueue(s.id, "two", []);
    const b = runner.enqueue(s.id, "three", []);
    expect(runner.editQueued(s.id, a.id, "two, changed")).toBe(true);
    expect(runner.editQueued(s.id, b.id, null)).toBe(true);
    expect(runner.editQueued(s.id, b.id, "gone")).toBe(false);
    runner.stop(s.id);
    await new Promise((r) => setTimeout(r, 30));
    expect(store.get(s.id)!.queue!.map((q) => q.text)).toEqual(["two, changed"]);
    expect(model.requests).toHaveLength(1);
    void runner.sendQueued(s.id);
    await until(() => model.waiting === 1 && model.requests.length === 2);
    expect(userTexts(model.requests[1].messages).at(-1)).toContain("two, changed");
    model.release();
  });

  it("send now stops the running turn and sends ahead of the queue", async () => {
    const model = new GatedModel();
    const runner = runnerWith(model as unknown as ScriptedModel);
    const s = store.create();
    void runner.send(s.id, "one");
    await until(() => model.waiting === 1);
    runner.enqueue(s.id, "later", []);
    void runner.sendNow(s.id, "urgent");
    await until(() => model.requests.length === 2);
    expect(userTexts(model.requests[1].messages).at(-1)).toContain("urgent");
    expect(store.get(s.id)!.queue!.map((q) => q.text)).toEqual(["later"]);
    model.release();
    await until(() => model.requests.length === 3);
    expect(userTexts(model.requests[2].messages).at(-1)).toContain("later");
    model.release();
  });
});

describe("editing a sent message", () => {
  it("cuts the model's conversation back to that message and sends the new text", async () => {
    const model = new ScriptedModel([() => text("A."), () => call("t1", "level", "get_outliner"), () => text("B."), () => text("C.")]);
    const runner = runnerWith(model);
    const s = store.create();
    await runner.send(s.id, "first");
    await runner.send(s.id, "second");
    expect(store.get(s.id)!.transcript.map((t) => t.kind)).toEqual(["user", "assistant", "user", "tool", "assistant"]);
    const index = store.get(s.id)!.transcript.findIndex((t) => t.kind === "user" && t.text === "second");
    expect(await runner.editMessage(s.id, index, "second, edited")).toBe(true);
    const sent = model.requests[3].messages;
    // first, its answer, and the edited message: nothing of the turn it replaced.
    expect(sent.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(JSON.stringify(sent)).not.toContain("get_outliner");
    expect(userTexts(sent).at(-1)).toContain("second, edited");
    expect(userTexts(sent).at(-1)).toContain("Nothing done after it in the earlier version was undone");
    const fin = store.get(s.id)!;
    expect(fin.transcript.map((t) => t.kind === "user" ? `u:${t.text}` : t.kind)).toEqual(["u:first", "assistant", "u:second, edited", "assistant"]);
  });

  it("forks: a copy up to that message continues from the new text, and the original is left as it was", async () => {
    const model = new ScriptedModel([() => text("A."), () => call("t1", "level", "get_outliner"), () => text("B."), () => text("C.")]);
    const runner = runnerWith(model);
    const s = store.create("Light the level");
    await runner.send(s.id, "first");
    await runner.send(s.id, "second");
    const before = JSON.stringify(store.get(s.id)!.transcript);
    const index = store.get(s.id)!.transcript.findIndex((t) => t.kind === "user" && t.text === "second");
    const forked = await runner.forkAt(s.id, index, "second, edited");
    expect(forked).toBeTruthy();
    expect(forked).not.toBe(s.id);
    await until(() => store.get(forked!)!.transcript.some((t) => t.kind === "assistant" && t.text === "C."));
    const sent = model.requests[3].messages;
    expect(sent.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(JSON.stringify(sent)).not.toContain("get_outliner");
    expect(userTexts(sent).at(-1)).toContain("second, edited");
    const fork = store.get(forked!)!;
    expect(fork.title).toBe("Light the level (fork)");
    expect(fork.transcript.map((t) => t.kind === "user" ? `u:${t.text}` : t.kind)).toEqual(["u:first", "assistant", "u:second, edited", "assistant"]);
    expect(fork.sdkPast ?? []).toEqual([]);
    // The original is untouched.
    expect(JSON.stringify(store.get(s.id)!.transcript)).toBe(before);
  });

  it("refuses to fork from an index that is not one of the user's messages", async () => {
    const model = new ScriptedModel([() => text("A.")]);
    const runner = runnerWith(model);
    const s = store.create();
    await runner.send(s.id, "first");
    expect(await runner.forkAt(s.id, 1, "x")).toBeNull();
  });

  it("refuses an index that is not one of the user's messages", async () => {
    const model = new ScriptedModel([() => text("A.")]);
    const runner = runnerWith(model);
    const s = store.create();
    await runner.send(s.id, "first");
    expect(await runner.editMessage(s.id, 1, "x")).toBe(false);
    expect(await runner.editMessage(s.id, 9, "x")).toBe(false);
  });
});

describe("stopping a subagent with a call in flight", () => {
  it("lets that call go at once, marks it stopped, and the main turn and the other subagent go on", async () => {
    let release: (() => void) | null = null;
    host.handler = async (_c, action) => {
      if (action === "slow_build") await new Promise<void>((r) => (release = r));
      return { isError: false, content: [{ type: "text", text: "{\"success\":true}" }] };
    };
    let results: Array<{ tool_use_id: string; content: string }> = [];
    let mainCalls = 0;
    const model: ModelProvider = {
      async run(req) {
        const sub = req.system.some((b) => b.text.includes("You are a subagent"));
        if (!sub) {
          if (++mainCalls === 1) {
            return {
              content: [
                { type: "tool_use", id: "busy", name: "agent", input: { description: "Busy", prompt: "busy" } },
                { type: "tool_use", id: "calm", name: "agent", input: { description: "Calm", prompt: "calm" } },
              ] as never,
              stopReason: "tool_use",
            };
          }
          results = req.messages[2].content as never;
          return text("Carried on without it.");
        }
        const first = req.messages.length === 1;
        if ((req.messages[0].content as string) === "calm") return text("Calm done.");
        if (first) return call("c1", "asset", "slow_build");
        return text("never");
      },
    };
    const runner = new AgentRunner({ host, store, provider: () => model, model: () => "claude-opus-5-5" });
    const s = store.create();
    const turn = runner.send(s.id, "go");
    await until(() => release !== null);
    expect(runner.stopSubagent(s.id, "busy")).toBe(true);
    // Answered now, not when the editor call returns.
    const inFlight = store.get(s.id)!.transcript.find((t) => t.kind === "tool" && t.call.id === "c1");
    expect(inFlight?.kind === "tool" && inFlight.call.outcome).toBe("stopped");
    expect(inFlight?.kind === "tool" && inFlight.call.result).toMatch(/Stopped by the user while this was running/);
    await turn;
    const fin = store.get(s.id)!;
    expect(fin.status).toBe("idle");
    const busy = fin.transcript.find((t) => t.kind === "tool" && t.call.id === "busy");
    expect(busy?.kind === "tool" && busy.call.outcome).toBe("stopped");
    expect(results.find((r) => r.tool_use_id === "busy")!.content).toMatch(/user stopped this subagent/);
    expect(results.find((r) => r.tool_use_id === "calm")!.content).toBe("Calm done.");
    expect(fin.transcript.at(-1)).toMatchObject({ kind: "assistant", text: "Carried on without it." });
    // The call's late result changes nothing that was already answered.
    release!();
    await new Promise((r) => setTimeout(r, 20));
    const after = store.get(s.id)!.transcript.find((t) => t.kind === "tool" && t.call.id === "c1");
    expect(after?.kind === "tool" && after.call.outcome).toBe("stopped");
  });
});

describe("Settings > Agent > Usage", () => {
  const isSub = (req: ModelRequest) => req.system.some((b) => b.text.includes("You are a subagent"));
  const withUsage = (u: Partial<UsageSettings>) => ({ ...DEFAULT_USAGE, ...u });
  const spent = (t: ModelTurn, input: number, output = 0): ModelTurn => ({ ...t, usage: { input, output } });

  /** A main agent that starts `n` subagents in one message, then answers; each subagent reports at once. */
  function fanOut(n: number, requests: ModelRequest[], tokens = 0): ModelProvider {
    return {
      async run(req) {
        requests.push(JSON.parse(JSON.stringify(req)));
        if (isSub(req)) return spent(text(`Report: ${req.messages[0].content as string}`), tokens);
        if (req.messages.length === 1) {
          const uses = Array.from({ length: n }, (_, i) => ({ type: "tool_use", id: `a${i}`, name: "agent", input: { description: `Part ${i}`, prompt: `part ${i}` } }));
          return spent({ content: uses as never, stopReason: "tool_use" }, tokens);
        }
        return spent(text("Done."), tokens);
      },
    };
  }

  it("offers no agent tool and says nothing of subagents while they are off", async () => {
    const model = new ScriptedModel([() => text("ok")]);
    const runner = new AgentRunner({ host, store, provider: () => model, model: () => "claude-opus-5-5", usage: () => withUsage({ subagents: "off" }) });
    const s = store.create();
    await runner.send(s.id, "hi");
    expect(model.requests[0].tools.map((t) => (t as { name: string }).name)).not.toContain("agent");
    expect(model.requests[0].system[0].text).not.toContain("with the agent tool");
  });

  it("tells the agent to start subagents only when asked, by default", async () => {
    const model = new ScriptedModel([() => text("ok")]);
    const runner = new AgentRunner({ host, store, provider: () => model, model: () => "claude-opus-5-5", usage: () => DEFAULT_USAGE });
    const s = store.create();
    await runner.send(s.id, "hi");
    const prompt = model.requests[0].system[0].text;
    expect(prompt).toContain("only when the user asks for one");
    expect(prompt).not.toContain("several in one message");
    expect(prompt).toContain("A turn starts at most 4 subagents.");
  });

  it("runs only the turn's allowance of subagents and refuses the rest", async () => {
    const requests: ModelRequest[] = [];
    const runner = new AgentRunner({ host, store, provider: () => fanOut(3, requests), model: () => "claude-opus-5-5", usage: () => withUsage({ subagents: "automatic", subagentsPerTurn: 2 }) });
    const s = store.create();
    await runner.send(s.id, "three parts");
    const fin = store.get(s.id)!;
    expect(requests.filter(isSub)).toHaveLength(2);
    const results = fin.messages[2].content as Array<{ tool_use_id: string; content: string; is_error?: boolean }>;
    expect(results.map((r) => r.tool_use_id)).toEqual(["a0", "a1", "a2"]);
    expect(results[2]).toMatchObject({ is_error: true, content: expect.stringContaining("the most Settings > Agents > Delegation allows") });
    expect(fin.turn?.agents).toBe(2);
  });

  it("runs subagents on the chosen model and effort", async () => {
    const requests: ModelRequest[] = [];
    const runner = new AgentRunner({
      host,
      store,
      provider: () => fanOut(1, requests),
      model: () => "claude-opus-5-5",
      effort: () => "high",
      subagentModel: () => "claude-haiku-5-5",
      usage: () => withUsage({ subagents: "automatic", subagentEffort: "low" }),
    });
    const s = store.create();
    await runner.send(s.id, "one part");
    const sub = requests.find(isSub)!;
    expect([sub.model, sub.effort]).toEqual(["claude-haiku-5-5", "low"]);
    const main = requests.find((r) => !isSub(r))!;
    expect([main.model, main.effort]).toEqual(["claude-opus-5-5", "high"]);
  });

  it("keeps what each agent spent in the session: the main agent and each subagent apart", async () => {
    const requests: ModelRequest[] = [];
    const runner = new AgentRunner({ host, store, provider: () => fanOut(2, requests, 1000), model: () => "claude-opus-5-5", usage: () => withUsage({ subagents: "automatic" }) });
    const s = store.create();
    await runner.send(s.id, "two parts");
    const fin = store.get(s.id)!;
    const { main, ...subs } = SessionStore.detail(fin).tokens!;
    expect(main).toBe(2000);
    expect(Object.values(subs)).toEqual([1000, 1000]);
    const agentCalls = fin.transcript.flatMap((t) => (t.kind === "tool" && t.call.name === "agent" ? [t.call.id] : []));
    expect(Object.keys(subs).sort()).toEqual(agentCalls.sort());
    expect(fin.transcript.some((t) => (t as { kind: string }).kind === "usage")).toBe(false);
  });

  it("puts the project's CLAUDE.md in the prompt as Claude Code reads it, and nothing while the project's own files are off", async () => {
    fs.writeFileSync(path.join(host.projectDir, "CLAUDE.md"), "Blueprints live under /Game/BP.");
    const on = new ScriptedModel([() => text("ok")]);
    const s = store.create();
    await new AgentRunner({ host, store, provider: () => on, model: () => "claude-opus-5-5", usage: () => DEFAULT_USAGE, native: nativeClaude }).send(s.id, "hi");
    expect(on.requests[0].system[0].text).toContain("## From CLAUDE.md\nBlueprints live under /Game/BP.");
    const off = new ScriptedModel([() => text("ok")]);
    const t = store.create();
    await new AgentRunner({ host, store, provider: () => off, model: () => "claude-opus-5-5", usage: () => withUsage({ projectInstructions: false }), native: () => null }).send(t.id, "hi");
    expect(off.requests[0].system[0].text).not.toContain("Blueprints live under");
  });
});

describe("a call's result on the key route", () => {
  it("reaches the model without indentation and stays as ue-mcp answered in the transcript", async () => {
    const answer = JSON.stringify({ success: true, actors: [{ label: "Sun", class: "DirectionalLight" }] }, null, 2);
    host.handler = async () => ({ isError: false, content: [{ type: "text", text: answer }] });
    const model = new ScriptedModel([() => call("t1", "level", "get_outliner"), () => text("Done.")]);
    const s = store.create();
    await runnerWith(model).send(s.id, "what is in the level");
    const sent = model.requests[1].messages[2].content as Array<{ type: string; content: unknown }>;
    expect(sent[0].content).toBe(JSON.stringify(JSON.parse(answer)));
    const tool = store.get(s.id)!.transcript.find((t) => t.kind === "tool");
    expect(tool?.kind === "tool" && tool.call.result).toBe(answer);
  });
});

describe("select and omit on a call", () => {
  it("go to ue-mcp beside the action's parameters, which takes them off before the action runs", async () => {
    const model = new ScriptedModel([
      () => ({ content: [{ type: "tool_use", id: "c", name: "ue_mcp", input: { action: "call", category: "level", method: "get_outliner", args: { filter: "Light" }, select: ["actors.label"], omit: ["actors.transform"] } } as never], stopReason: "tool_use" }),
      () => ({ content: [{ type: "tool_use", id: "d", name: "ue_mcp", input: { action: "call", category: "level", method: "get_outliner", select: [] } } as never], stopReason: "tool_use" }),
      () => text("ok"),
    ]);
    const s = store.create();
    await runnerWith(model).send(s.id, "list the lights");
    expect(host.calls).toEqual([
      { category: "level", action: "get_outliner", args: { filter: "Light", select: ["actors.label"], omit: ["actors.transform"] } },
      // An empty list selects nothing, so it is not sent.
      { category: "level", action: "get_outliner", args: {} },
    ]);
  });
});

describe("approval rows: editor restarts and ue-mcp actions that delete or overwrite", () => {
  const use = (id: string, name: string, input: Record<string, unknown>): ModelTurn => ({ content: [{ type: "tool_use", id, name, input } as never], stopReason: "tool_use" });
  const effects = {
    destructive: (c: string, m: string) => (c === "asset" && m === "delete" ? true : c === "asset" || c === "level" ? false : null),
    readOnly: () => null,
  };
  const rows = (over: Partial<Record<"shell" | "files" | "editorRestart" | "destructive", "ask" | "allow">>) => () =>
    ({ shell: "allow", files: "allow", editorRestart: "allow", destructive: "allow", ...over } as const);
  const waiting = (sid: string) => () => (store.get(sid)!.approvals ?? []).length > 0;

  it("asks before a destructive ue-mcp action, from ue-mcp's metadata, and runs the rest without asking", async () => {
    const model = new ScriptedModel([
      () => call("r1", "asset", "list", { path: "/Game" }),
      () => call("d1", "asset", "delete", { assetPath: "/Game/Old" }),
      () => text("Deleted."),
    ]);
    const runner = new AgentRunner({ host, store, provider: () => model, model: () => "claude-opus-5-5", approvals: rows({ destructive: "ask" }), effects });
    const s = store.create();
    const turn = runner.send(s.id, "clean up");
    await until(waiting(s.id));
    const a = store.get(s.id)!.approvals![0];
    expect(a).toMatchObject({ tool: "ue_mcp", toolUseId: "d1", call: { category: "asset", method: "delete", args: { assetPath: "/Game/Old" } } });
    expect(host.calls.map((c) => c.action)).toEqual(["list"]);
    runner.answerApproval(s.id, a.id, "allow");
    await turn;
    expect(host.calls.map((c) => c.action)).toEqual(["list", "delete"]);
  });

  it("asks before an editor restart, by the tool or by the editor action, and keeps a session allowance apart from commands", async () => {
    const model = new ScriptedModel([
      () => use("e1", "editor_restart", { operation: "rebuild", reason: "new C++ class" }),
      () => call("e2", "editor", "restart_editor"),
      () => text("Back."),
    ]);
    const runner = new AgentRunner({ host, store, provider: () => model, model: () => "claude-opus-5-5", approvals: rows({ editorRestart: "ask" }), effects });
    const s = store.create();
    const turn = runner.send(s.id, "rebuild");
    await until(waiting(s.id));
    const a = store.get(s.id)!.approvals![0];
    expect(a).toMatchObject({ tool: "editor_restart", operation: "rebuild", reason: "new C++ class" });
    runner.answerApproval(s.id, a.id, "session");
    await turn;
    // The second restart was allowed for the session: asked once.
    expect(host.published.filter((e) => e.type === "approval.requested")).toHaveLength(1);
    expect(store.get(s.id)!.allowed).toEqual(["restart"]);
  });

  it("does not ask about a kind set to allow, and cannot ask about destructive actions without ue-mcp's metadata", async () => {
    const model = new ScriptedModel([() => call("d1", "asset", "delete", { assetPath: "/Game/Old" }), () => use("e1", "editor_restart", { operation: "restart", reason: "r" }), () => text("ok")]);
    const runner = new AgentRunner({ host, store, provider: () => model, model: () => "claude-opus-5-5", approvals: rows({ destructive: "ask", editorRestart: "allow" }) });
    const s = store.create();
    await runner.send(s.id, "go");
    await until(() => store.get(s.id)!.status === "idle");
    expect(host.published.some((e) => e.type === "approval.requested")).toBe(false);
  });

  it("follows the shell and file rows separately", async () => {
    const model = new ScriptedModel([() => use("w1", "write_file", { path: "a.txt", content: "x" }), () => use("c1", "shell", { command: "echo hi" }), () => text("ok")]);
    const runner = new AgentRunner({ host, store, provider: () => model, model: () => "claude-opus-5-5", approvals: rows({ shell: "ask" }) });
    const s = store.create();
    const turn = runner.send(s.id, "go");
    await until(waiting(s.id));
    expect(fs.readFileSync(path.join(host.projectDir, "a.txt"), "utf-8")).toBe("x");
    expect(store.get(s.id)!.approvals![0]).toMatchObject({ tool: "shell", command: "echo hi" });
    runner.answerApproval(s.id, store.get(s.id)!.approvals![0].id, "deny");
    await turn;
  });
});

describe("instruction files that join as the agent works", () => {
  it("adds a subfolder's CLAUDE.md to the first result that touches the folder, once, as Claude Code loads it on demand", async () => {
    fs.mkdirSync(path.join(host.projectDir, "Source", "Game"), { recursive: true });
    fs.writeFileSync(path.join(host.projectDir, "Source", "Game", "CLAUDE.md"), "Use the Game module's logging category.");
    fs.writeFileSync(path.join(host.projectDir, "Source", "Game", "A.cpp"), "int a;");
    fs.writeFileSync(path.join(host.projectDir, "CLAUDE.md"), "Root rules.");
    const read = (id: string, file: string): ModelTurn => ({ content: [{ type: "tool_use", id, name: "read_file", input: { path: file } } as never], stopReason: "tool_use" });
    const model = new ScriptedModel([() => read("r1", "Source/Game/A.cpp"), () => read("r2", "Source/Game/A.cpp"), () => text("ok")]);
    const s = store.create();
    await new AgentRunner({ host, store, provider: () => model, model: () => "claude-opus-5-5", native: nativeClaude }).send(s.id, "read it");
    await until(() => store.get(s.id)!.status === "idle");
    expect(model.requests[0].system[0].text).toContain("## From CLAUDE.md\nRoot rules.");
    expect(model.requests[0].system[0].text).not.toContain("logging category");
    const results = store.get(s.id)!.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => (b as { type: string }).type === "tool_result") as Array<{ content: unknown }>;
    const texts = results.map((r) => JSON.stringify(r.content));
    expect(texts[0]).toContain("Instructions from Source/Game/CLAUDE.md apply to this work in Source/Game");
    expect(texts[1]).not.toContain("Instructions from Source/Game/CLAUDE.md");
  });
});

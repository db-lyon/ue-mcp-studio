/**
 * The agent loop against a fake model and a fake daemon: no network, no editor.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ActionResult, EditorStatus } from "ue-mcp/daemon";
import { AgentRunner } from "../src/runner.js";
import { SessionStore } from "../src/sessions.js";
import { SettingsStore } from "../src/settings.js";
import { GatewayProvider, type ModelProvider, type ModelRequest, type ModelTurn } from "../src/providers.js";
import { validateInput, type AgentHost } from "../src/tools.js";

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
    expect(model.requests[0].tools.map((t) => (t as { name: string }).name)).toEqual(["ue_mcp", "editor_restart"]);
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

describe("inputs and settings", () => {
  it("refuses malformed tool input before running it", () => {
    expect(validateInput("ue_mcp", { action: "call", category: "level" })).toMatch(/needs category and method/);
    expect(validateInput("ue_mcp", { action: "search" })).toMatch(/needs query/);
    expect(validateInput("editor_restart", { operation: "reboot" })).toMatch(/restart or rebuild/);
    expect(validateInput("ue_mcp", { action: "call", category: "a", method: "b", args: {} })).toBeNull();
  });

  it("stores each provider's key apart from the settings and never reports it back", () => {
    const settings = new SettingsStore(path.join(root, "settings"));
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

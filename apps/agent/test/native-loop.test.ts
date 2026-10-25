/**
 * The project's own files on Studio's loop: instructions as the vendor's tool
 * reads them, subagents as helpers on their own models, and skills through the
 * skill tool. A main agent on one vendor hands work to a helper on another.
 */
import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ActionResult, EditorStatus } from "ue-mcp/daemon";
import { AgentRunner } from "../src/runner.js";
import { SessionStore } from "../src/sessions.js";
import type { ModelProvider, ModelRequest, ModelTurn } from "../src/providers.js";
import type { AgentHost } from "../src/tools.js";
import { loadout } from "../src/native.js";
import { composeNative, modelOf, toolsFor, type NativeHelper, type NativeRun } from "../src/native-runtime.js";
import { DEFAULT_USAGE } from "@ue-mcp-studio/shared";

class Host implements AgentHost {
  calls: Array<{ category: string; action: string }> = [];
  log = { info() {}, warn() {} };
  events = { publish: () => undefined, subscribe: () => () => {} };
  constructor(public projectDir: string, public dataDir: string) {}
  async callAction(category: string, action: string): Promise<ActionResult> {
    this.calls.push({ category, action });
    return { isError: false, content: [{ type: "text", text: "{\"success\":true}" }] };
  }
  editors(): EditorStatus[] {
    return [{ name: "P", connected: true, port: 1, pid: 1, lastDisconnect: null }];
  }
  async editorOperation(op: string) {
    return { op, steps: [] };
  }
  setBusy(): void {}
}

class Scripted implements ModelProvider {
  requests: ModelRequest[] = [];
  constructor(private readonly turns: Array<(req: ModelRequest) => ModelTurn>) {}
  async run(req: ModelRequest): Promise<ModelTurn> {
    this.requests.push(JSON.parse(JSON.stringify(req)));
    const next = this.turns.shift();
    if (!next) throw new Error("script exhausted");
    return next(req);
  }
}

const text = (t: string): ModelTurn => ({ content: [{ type: "text", text: t, citations: null } as never], stopReason: "end_turn" });
const use = (id: string, name: string, input: Record<string, unknown>): ModelTurn => ({ content: [{ type: "tool_use", id, name, input } as never], stopReason: "tool_use" });

let root: string;
let project: string;
let home: string;
let host: Host;
let store: SessionStore;
const write = (rel: string, body: string) => {
  fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
  fs.writeFileSync(path.join(project, rel), body);
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-native-loop-"));
  project = path.join(root, "Game");
  home = path.join(root, "home");
  fs.mkdirSync(path.join(project, ".git"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  host = new Host(project, path.join(root, "data"));
  store = new SessionStore(host.dataDir);
});

/** The native run chat-routes builds, with each helper's model on the provider the test gives it. */
function nativeFor(convention: "codex" | "gemini" | "claude", providers: Record<string, ModelProvider> = {}): () => NativeRun {
  return () => {
    const l = loadout(convention, project, home, new Map(), root);
    const helpers: NativeHelper[] = l.subagents.map((a) => {
      const wants = modelOf(convention, a.model);
      const p = wants ? providers[`${wants.vendor}:${wants.model}`] : undefined;
      return { name: a.name, description: a.description, prompt: a.prompt, allowed: toolsFor(a).allowed, maxTurns: a.maxTurns, effort: a.effort, ...(p && wants ? { run: { provider: () => p, model: wants.model, vendor: wants.vendor, route: "key" } } : {}) };
    });
    return { convention, loadout: l, composed: composeNative(l), helpers, skills: l.skills, sdkLoads: false };
  };
}

describe("a Codex project on an OpenAI main agent, with a Gemini-file helper elsewhere", () => {
  it("gives the main agent AGENTS.md as Codex reads it, its helpers and its skills", async () => {
    write("AGENTS.md", "Name assets with the zone prefix.");
    write(".codex/agents/scout.toml", 'name = "scout"\ndescription = "Finds assets"\ndeveloper_instructions = "Search, never change."\nmodel = "gpt-6-luna"\n[features]\nshell_tool = false\n');
    write(".agents/skills/naming/SKILL.md", "---\nname: naming\ndescription: Zone naming rules\n---\nUse HR_ then the zone.");
    const main = new Scripted([() => text("ok")]);
    const runner = new AgentRunner({ host, store, provider: () => main, model: () => "gpt-6-sol", native: nativeFor("codex") });
    const s = store.create();
    await runner.send(s.id, "hello");
    const req = main.requests[0];
    expect(req.system[0].text).toContain("read as Codex reads them");
    expect(req.system[0].text).toContain("## From AGENTS.md\nName assets with the zone prefix.");
    expect(req.system[0].text).toContain("- naming: Zone naming rules");
    const agent = req.tools.find((t) => (t as { name: string }).name === "agent") as { description: string; input_schema: { properties: { helper: { enum: string[] } } } };
    expect(agent.input_schema.properties.helper.enum).toEqual(["scout"]);
    expect(agent.description).toContain("- scout: Finds assets");
    expect(req.tools.some((t) => (t as { name: string }).name === "skill")).toBe(true);
  });

  it("runs a helper on its own model and vendor, with its own prompt and only the tools its file allows", async () => {
    write(".codex/agents/scout.toml", 'name = "scout"\ndescription = "Finds assets"\ndeveloper_instructions = "Search, never change."\nmodel = "gpt-6-luna"\n[features]\nshell_tool = false\n');
    write(".agents/skills/naming/SKILL.md", "---\nname: naming\ndescription: Zone naming rules\n---\nUse HR_ then the zone.");
    const helper = new Scripted([
      () => use("h1", "shell", { command: "echo nope" }),
      () => use("h2", "skill", { name: "naming" }),
      () => use("h3", "ue_mcp", { action: "call", category: "asset", method: "list", args: {} }),
      () => text("Found 3 assets."),
    ]);
    const main = new Scripted([() => use("a1", "agent", { helper: "scout", description: "find", prompt: "Find the props" }), () => text("Done.")]);
    const runner = new AgentRunner({ host, store, provider: () => main, model: () => "claude-opus-5-5", native: nativeFor("codex", { "openai:gpt-6-luna": helper }) });
    const s = store.create();
    await runner.send(s.id, "find props");
    // The helper ran on its own provider and model; the main agent only saw its report.
    expect(helper.requests[0].model).toBe("gpt-6-luna");
    expect(helper.requests[0].system[0].text).toContain("You are the project's scout helper. Its own instructions follow.\n\nSearch, never change.");
    expect(helper.requests[0].tools.map((t) => (t as { name: string }).name)).not.toContain("shell");
    const t = store.get(s.id)!.transcript;
    const shellCall = t.find((x) => x.kind === "tool" && x.call.id === "h1");
    expect(shellCall?.kind === "tool" && shellCall.call).toMatchObject({ outcome: "error", result: "The scout helper's file does not allow shell." });
    const skillCall = t.find((x) => x.kind === "tool" && x.call.id === "h2");
    expect(skillCall?.kind === "tool" && skillCall.call.result).toContain("Use HR_ then the zone.");
    expect(host.calls).toEqual([{ category: "asset", action: "list" }]);
    const agentCall = t.find((x) => x.kind === "tool" && x.call.id === "a1");
    expect(agentCall?.kind === "tool" && agentCall.call).toMatchObject({ outcome: "done", result: "Found 3 assets." });
    expect(main.requests).toHaveLength(2);
  });

  it("runs a helper whose model nothing here runs on the main agent's provider", async () => {
    write(".gemini/agents/dresser.md", "---\nname: dresser\ndescription: Dresses levels\nmodel: gemini-9-ultra\n---\nDress it.");
    const main = new Scripted([() => use("a1", "agent", { helper: "dresser", description: "dress", prompt: "Dress the cave" }), () => text("Dressed."), () => text("All done.")]);
    const runner = new AgentRunner({ host, store, provider: () => main, model: () => "gemini-3.1-pro-preview", native: nativeFor("gemini") });
    const s = store.create();
    await runner.send(s.id, "dress");
    // Main's call, the helper's on the same provider, then main again.
    expect(main.requests.map((r) => r.model)).toEqual(["gemini-3.1-pro-preview", "gemini-3.1-pro-preview", "gemini-3.1-pro-preview"]);
    expect(main.requests[1].system[0].text).toContain("Dress it.");
  });
});

describe("Studio's own worker beside the project's helpers", () => {
  it("is refused while earlier settings turned it off, and a named helper still runs", async () => {
    write(".claude/agents/reviewer.md", "---\nname: reviewer\ndescription: Reviews\n---\nReview it.");
    const main = new Scripted([
      () => ({ content: [{ type: "tool_use", id: "w", name: "agent", input: { description: "x", prompt: "do it" } }, { type: "tool_use", id: "r", name: "agent", input: { helper: "reviewer", description: "y", prompt: "review" } }] as never, stopReason: "tool_use" }),
      () => text("Reviewed."),
      () => text("ok"),
    ]);
    const runner = new AgentRunner({ host, store, provider: () => main, model: () => "claude-sonnet-5-5", usage: () => ({ ...DEFAULT_USAGE, subagents: "off" }), native: nativeFor("claude") });
    const s = store.create();
    await runner.send(s.id, "go");
    const t = store.get(s.id)!.transcript;
    const w = t.find((x) => x.kind === "tool" && x.call.id === "w");
    expect(w?.kind === "tool" && w.call.result).toMatch(/Studio's own worker is off/);
    const r = t.find((x) => x.kind === "tool" && x.call.id === "r");
    expect(r?.kind === "tool" && r.call).toMatchObject({ outcome: "done", result: "Reviewed." });
  });

  it("offers no agent tool when the worker is off and the project has no helpers", async () => {
    const main = new Scripted([() => text("ok")]);
    const runner = new AgentRunner({ host, store, provider: () => main, model: () => "claude-sonnet-5-5", usage: () => ({ ...DEFAULT_USAGE, subagents: "off" }), native: nativeFor("claude") });
    await runner.send(store.create().id, "go");
    expect(main.requests[0].tools.some((t) => (t as { name: string }).name === "agent")).toBe(false);
  });
});

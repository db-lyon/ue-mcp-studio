/**
 * Studio's own agent on ue-mcp's projected surfaces: Micro, Lean and Full from
 * the daemon's projection, every category call read back as the ue_mcp call it
 * is, and Micro whenever the daemon cannot project.
 */
import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ActionResult, EditorStatus } from "ue-mcp/daemon";
import { ContextSurfaces, MICRO_LINE, canonCategoryCall, contextApiOf, withSurface, type ContextApi, type Projection } from "../src/context-surface.js";
import { AgentRunner } from "../src/runner.js";
import { SessionStore } from "../src/sessions.js";
import type { ModelProvider, ModelRequest, ModelTurn } from "../src/providers.js";
import type { AgentHost } from "../src/tools.js";
import { withEditor, zodShape } from "../src/subscription.js";

const level = { name: "level", description: "Levels. Actions: get_outliner, spawn_actor", category: "level", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["get_outliner", "spawn_actor"] }, args: { type: "object" }, editor: { type: "string" } }, required: ["action"] } };
const catalog = { name: "catalog", description: "Describe an action", category: null, inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } };

class FakeContext implements ContextApi {
  projected: Array<{ strategy: string }> = [];
  calls: Array<{ tool: string; input: Record<string, unknown>; strategy?: string }> = [];
  project(o: { strategy: "micro" | "lean" | "full" }): Projection {
    this.projected.push(o);
    const tools = o.strategy === "micro" ? [{ ...catalog, name: "ue_mcp" }] : o.strategy === "lean" ? [level, catalog] : [level];
    return { strategy: o.strategy, categories: ["level"], instructions: `ue-mcp ${o.strategy} instructions.`, tools, seedTokens: { micro: 2000, lean: 9000, full: 30000 }[o.strategy] };
  }
  async call(tool: string, input: Record<string, unknown>, opts?: { strategy?: "micro" | "lean" | "full" }): Promise<ActionResult> {
    this.calls.push({ tool, input, strategy: opts?.strategy });
    return { isError: false, content: [{ type: "text", text: "spawn_actor(location, class)" }] };
  }
}

describe("reading the daemon's projection", () => {
  it("reads api.context, and fails loudly on a daemon without it", () => {
    const context = new FakeContext();
    expect(contextApiOf({ context })).toBe(context);
    expect(() => contextApiOf({})).toThrow(/ue-mcp has no context projection/);
  });

  it("reads a category call as ue_mcp's: an args envelope with its routing merged in, or a flat call", () => {
    expect(canonCategoryCall(level, { action: "spawn_actor", args: { class: "Torch" }, editor: "Main" })).toEqual({ action: "call", category: "level", method: "spawn_actor", args: { class: "Torch", editor: "Main" } });
    expect(canonCategoryCall(level, { action: "spawn_actor", class: "Torch" })).toEqual({ action: "call", category: "level", method: "spawn_actor", args: { class: "Torch" } });
  });

  it("projects Lean once, keeps it until ue-mcp's tools change, and runs a non-category tool through context.call", async () => {
    const api = new FakeContext();
    const s = new ContextSurfaces(api, () => "lean");
    const lean = s.current();
    expect(lean.tools.map((t) => (t as { name: string }).name)).toEqual(["level", "catalog", "editor_restart"]);
    expect(lean.canon("level", { action: "get_outliner" })).toEqual({ name: "ue_mcp", input: { action: "call", category: "level", method: "get_outliner", args: {} } });
    expect(lean.canon("shell", { command: "ls" })).toEqual({ name: "shell", input: { command: "ls" } });
    expect(lean.passthrough("level")).toBeNull();
    await lean.passthrough("catalog")!({ name: "level.spawn_actor" });
    expect(api.calls).toEqual([{ tool: "catalog", input: { name: "level.spawn_actor" }, strategy: "lean" }]);
    s.current();
    expect(api.projected.filter((p) => p.strategy === "lean")).toHaveLength(1);
    s.invalidate();
    s.current();
    expect(api.projected.filter((p) => p.strategy === "lean")).toHaveLength(2);
  });

  it("never lets a projected tool shadow one of Studio's own", () => {
    const api = new FakeContext();
    const s = new ContextSurfaces(api, () => "micro");
    // Micro is Studio's own ue_mcp, never the projection's gateway.
    expect(s.current().tools.map((t) => (t as { name: string }).name)).toEqual(["ue_mcp", "editor_restart"]);
    expect(api.projected).toEqual([]);
  });

  it("puts the strategy's own line and ue-mcp's instructions in the prompt", () => {
    const s = new ContextSurfaces(new FakeContext(), () => "full");
    const text = withSurface(`Intro.\n${MICRO_LINE}\nMore.`, s.current());
    expect(text).not.toContain("ue_mcp search");
    expect(text).toContain("one per category (level), each with every action's signature");
    expect(text).toContain("ue-mcp full instructions.");
  });
});

describe("the Agent SDK's registry", () => {
  it("types a projected schema as far as it says, and stands projected tools in for ue_mcp", () => {
    const shape = zodShape(level.inputSchema);
    expect(Object.keys(shape)).toEqual(["action", "args", "editor"]);
    expect(shape.action.safeParse("spawn_actor").success).toBe(true);
    expect(shape.action.safeParse("explode").success).toBe(false);
    expect(shape.args.safeParse(undefined).success).toBe(true);
    expect(withEditor(["mcp__studio__ue_mcp", "mcp__studio__shell"], ["level", "catalog"])).toEqual(["mcp__studio__level", "mcp__studio__catalog", "mcp__studio__shell"]);
    expect(withEditor(["mcp__studio__ue_mcp"], undefined)).toEqual(["mcp__studio__ue_mcp"]);
  });
});

/* ── The loop on a projected surface ─────────────────────────────── */

class Host implements AgentHost {
  calls: Array<{ category: string; action: string; args?: Record<string, unknown> }> = [];
  log = { info() {}, warn() {} };
  events = { publish: () => undefined, subscribe: () => () => {} };
  constructor(public projectDir: string, public dataDir: string) {}
  async callAction(category: string, action: string, args?: Record<string, unknown>): Promise<ActionResult> {
    this.calls.push({ category, action, args });
    return { isError: false, content: [{ type: "text", text: "{\"success\":true,\"actors\":[]}" }] };
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
  constructor(private readonly turns: Array<() => ModelTurn>) {}
  async run(req: ModelRequest): Promise<ModelTurn> {
    this.requests.push(JSON.parse(JSON.stringify(req)));
    return this.turns.shift()!();
  }
}
const use = (id: string, name: string, input: Record<string, unknown>): ModelTurn => ({ content: [{ type: "tool_use", id, name, input } as never], stopReason: "tool_use" });
const text = (t: string): ModelTurn => ({ content: [{ type: "text", text: t, citations: null } as never], stopReason: "end_turn" });

describe("a turn on Lean", () => {
  let host: Host;
  let store: SessionStore;
  beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-lean-"));
    host = new Host(root, path.join(root, "data"));
    store = new SessionStore(host.dataDir);
  });

  it("offers the projected tools, runs a category call as the ue_mcp call it is, and a catalog call through context.call", async () => {
    const api = new FakeContext();
    const model = new Scripted([
      () => use("c1", "catalog", { name: "level.get_outliner" }),
      () => use("c2", "level", { action: "get_outliner", args: {} }),
      () => text("Empty level."),
    ]);
    const runner = new AgentRunner({ host, store, provider: () => model, model: () => "claude-opus-5-5", surfaces: new ContextSurfaces(api, () => "lean") });
    const s = store.create();
    await runner.send(s.id, "what is in the level");
    const names = model.requests[0].tools.map((t) => (t as { name: string }).name);
    expect(names.slice(0, 3)).toEqual(["level", "catalog", "editor_restart"]);
    expect(names).not.toContain("ue_mcp");
    expect(model.requests[0].system[0].text).toContain("ue-mcp lean instructions.");
    expect(api.calls).toEqual([{ tool: "catalog", input: { name: "level.get_outliner" }, strategy: "lean" }]);
    expect(host.calls).toEqual([{ category: "level", action: "get_outliner", args: {} }]);
    // The transcript keeps one shape on every strategy.
    const call = store.get(s.id)!.transcript.find((t) => t.kind === "tool" && t.call.id === "c2");
    expect(call?.kind === "tool" && call.call).toMatchObject({ name: "ue_mcp", input: { action: "call", category: "level", method: "get_outliner" }, outcome: "done" });
  });
});

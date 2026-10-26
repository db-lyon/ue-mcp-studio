/**
 * Studio's own agent on ue-mcp's projected surfaces: Micro, Lean and Full from
 * the daemon's projection, every category call read back as the ue_mcp call it
 * is, Auto from a measurement, and Micro whenever the daemon cannot project.
 */
import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ActionResult, EditorStatus } from "ue-mcp/daemon";
import { DEFAULT_USAGE } from "@ue-mcp-studio/shared";
import { ContextSurfaces, MICRO_LINE, autoPick, canonCategoryCall, contextApiOf, readMeasurement, withSurface, type ContextApi, type ContextMeasurement, type Projection } from "../src/context-surface.js";
import { applyUsage, usageOf } from "../src/settings.js";
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

const measurement = (runs: ContextMeasurement["runs"]): ContextMeasurement => ({ version: 1, measuredAt: "2026-10-20T10:00:00Z", ueMcpVersion: "1.4.11", runs });
const run = (vendor: string, strategy: "micro" | "lean" | "full", tokens: number[], passed: boolean[]) => ({
  model: { vendor, model: "m" }, scope: "9+" as const, strategy, seedTokens: 1, tasks: tokens.map((t, i) => ({ id: `t${i}`, totalTokens: t, modelCalls: 3, discoveryCalls: 1, passed: passed[i] })),
});

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
    const s = new ContextSurfaces(api, () => "lean", () => "anthropic", () => null);
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
    const s = new ContextSurfaces(api, () => "micro", () => "anthropic", () => null);
    // Micro is Studio's own ue_mcp, never the projection's gateway.
    expect(s.current().tools.map((t) => (t as { name: string }).name)).toEqual(["ue_mcp", "editor_restart"]);
    expect(api.projected).toEqual([]);
  });

  it("shows each strategy's seed tokens from the projection", () => {
    const s = new ContextSurfaces(new FakeContext(), () => "micro", () => "anthropic", () => null);
    expect(s.view()).toMatchObject({ strategy: "micro", effective: "micro", seeds: { micro: 2000, lean: 9000, full: 30000 }, measurement: null });
  });

  it("puts the strategy's own line and ue-mcp's instructions in the prompt", () => {
    const s = new ContextSurfaces(new FakeContext(), () => "full", () => "anthropic", () => null);
    const text = withSurface(`Intro.\n${MICRO_LINE}\nMore.`, s.current());
    expect(text).not.toContain("ue_mcp search");
    expect(text).toContain("one per category (level), each with every action's signature");
    expect(text).toContain("ue-mcp full instructions.");
  });
});

describe("Auto", () => {
  it("picks the fewest median tokens among strategies within one task of the best pass rate", () => {
    const m = measurement([
      run("anthropic", "micro", [100, 120, 140, 160], [true, true, true, false]),
      run("anthropic", "lean", [200, 210, 220, 230], [true, true, true, true]),
      run("anthropic", "full", [400, 410, 420, 430], [true, true, true, true]),
      run("openai", "full", [50, 60], [true, true]),
    ]);
    // Micro passed 3 of 4, within one task of Lean's 4 of 4, and costs least.
    expect(autoPick(m, "anthropic", "9+")?.strategy).toBe("micro");
    expect(autoPick(m, "openai", "9+")?.strategy).toBe("full");
    expect(autoPick(m, "google", "9+")).toBeNull();
  });

  it("drops a strategy more than one task behind", () => {
    const m = measurement([run("anthropic", "micro", [100, 100, 100, 100], [true, false, false, true]), run("anthropic", "lean", [200, 200, 200, 200], [true, true, true, true])]);
    expect(autoPick(m, "anthropic", "9+")?.strategy).toBe("lean");
  });

  it("resolves through a shipped measurement, and falls back to Micro with a reason when it has no runs for the vendor", () => {
    const m = measurement([run("anthropic", "lean", [10], [true])]);
    expect(new ContextSurfaces(new FakeContext(), () => "auto", () => "anthropic", () => m).resolve()).toMatchObject({ effective: "lean" });
    expect(new ContextSurfaces(new FakeContext(), () => "auto", () => "google", () => m).resolve()).toEqual({ effective: "micro", note: "The measurement has no runs for this model's vendor, so Auto uses Micro." });
    expect(new ContextSurfaces(new FakeContext(), () => "auto", () => "google", () => null).resolve().note).toBe("No measurement ships with this Studio, so Auto uses Micro.");
  });

  it("reads only ue-mcp's measurement format", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-measure-"));
    const f = path.join(dir, "m.json");
    fs.writeFileSync(f, JSON.stringify(measurement([run("anthropic", "lean", [1], [true])])));
    expect(readMeasurement(f)?.runs).toHaveLength(1);
    fs.writeFileSync(f, JSON.stringify({ version: 2, runs: [] }));
    expect(readMeasurement(f)).toBeNull();
    expect(readMeasurement(path.join(dir, "missing.json"))).toBeNull();
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
    const runner = new AgentRunner({ host, store, provider: () => model, model: () => "claude-opus-5-5", surfaces: new ContextSurfaces(api, () => "lean", () => "anthropic", () => null) });
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

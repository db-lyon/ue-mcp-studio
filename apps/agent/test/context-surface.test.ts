/**
 * Studio's own agent on ue-mcp's projected surfaces: Micro, Lean and Full from
 * the daemon's projection, every category call read back as the ue_mcp call it
 * is, and Micro whenever the daemon cannot project.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ActionResult } from "ue-mcp/daemon";
import { ContextSurfaces, MICRO_LINE, canonCategoryCall, contextApiOf, withSurface, type ContextApi, type Projection } from "../src/context-surface.js";
import { SessionStore } from "../src/sessions.js";
import { runHarness } from "../src/durable/harness-main.js";
import { FakeHost, durableRunner, until, type DurableRig } from "./durable/helpers.js";
import { startFakeAnthropic, type FakeAnthropic } from "./durable/fake-anthropic.js";

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

/* ── A turn on a projected surface, in the durable harness ───────── */

describe("a turn on Lean", () => {
  let root: string;
  let host: FakeHost;
  let store: SessionStore;
  let fake: FakeAnthropic | null = null;
  let harness: { close(): Promise<void> } | null = null;
  let rig: DurableRig | null = null;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-lean-"));
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    host = new FakeHost(root, path.join(root, "data"));
    store = new SessionStore(host.dataDir);
  });
  afterEach(async () => {
    rig?.runner.dispose();
    await harness?.close();
    await fake?.close();
    rig = null;
    harness = null;
    fake = null;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("offers the projected tools, runs a category call as the ue_mcp call it is, and a catalog call through context.call", async () => {
    const api = new FakeContext();
    fake = await startFakeAnthropic(({ toolResults }) => [
      { tool: { id: "c1", name: "catalog", input: { name: "level.get_outliner" } } },
      { tool: { id: "c2", name: "level", input: { action: "get_outliner", args: {} } } },
      { text: "Empty level." },
    ][Math.min(toolResults, 2)]);
    rig = durableRunner({
      projectDir: host.projectDir,
      dataDir: host.dataDir,
      base: fake.base,
      host,
      store,
      start: async (launch) => {
        harness = await runHarness(launch);
      },
      extra: { surfaces: new ContextSurfaces(api, () => "lean") },
    });
    const s = store.create();
    await rig.runner.send(s.id, "what is in the level");
    await until(() => store.get(s.id)!.status === "idle", 30_000, "the turn to end");
    const names = fake.requests[0].tools;
    expect(names.slice(0, 3)).toEqual(["level", "catalog", "editor_restart"]);
    expect(names).not.toContain("ue_mcp");
    expect(fake.requests[0].system).toContain("ue-mcp lean instructions.");
    expect(api.calls).toEqual([{ tool: "catalog", input: { name: "level.get_outliner" }, strategy: "lean" }]);
    expect(host.calls).toEqual([{ category: "level", action: "get_outliner", args: {} }]);
    // The transcript keeps one shape on every strategy.
    const call = store.get(s.id)!.transcript.find((t) => t.kind === "tool" && t.call.id === "c2");
    expect(call?.kind === "tool" && call.call).toMatchObject({ name: "ue_mcp", input: { action: "call", category: "level", method: "get_outliner" }, outcome: "done" });
  }, 60_000);
});

/**
 * /action: ue-mcp's catalog and one action's parameters as the agent reads
 * them, and an action run in a session without the model, under the same
 * approval rows as the agent's calls.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ActionResult } from "ue-mcp/daemon";
import type { Approvals, TranscriptEntry } from "@ue-mcp-studio/shared";
import { ActionCatalog, type ActionEffectRow } from "../src/action-catalog.js";
import { ACTION_NOTE_CHARS, AgentRunner } from "../src/runner.js";
import { SessionStore } from "../src/sessions.js";
import type { AgentHost } from "../src/tools.js";
import type { ModelProvider } from "../src/providers.js";

const answer = (body: unknown, isError = false): ActionResult => ({ isError, content: [{ type: "text", text: typeof body === "string" ? body : JSON.stringify(body) }] });

const ROWS: ActionEffectRow[] = [
  { category: "level", action: "place_actor", effect: "mutate" },
  { category: "level", action: "get_outliner", effect: "read" },
  { category: "asset", action: "delete", effect: "mutate", destructive: true },
];

const PLACE = {
  tool: "level",
  action: "place_actor",
  description: "Place an actor in the level. Params: actorClass, label?",
  class: "mutate",
  params: [{ name: "actorClass", type: "string", required: true }],
};

describe("the /action catalog", () => {
  function source(rows = ROWS) {
    const calls: Array<Record<string, unknown> | undefined> = [];
    const state = { rows };
    return {
      calls,
      state,
      src: {
        effects: () => state.rows,
        callAction: async (_c: string, _a: string, args?: Record<string, unknown>) => {
          calls.push(args);
          if (args?.category === "level") return answer({ tool: "level", actions: [PLACE, { tool: "level", action: "get_outliner", description: "List the level's actors (#123). Params: classFilter?" }] });
          if (args?.category === "asset") return answer("Unknown category", true);
          if (args?.name === "level.place_actor") return answer(PLACE);
          return answer("Unknown action 'level.plce_actor'. Closest: level.place_actor.", true);
        },
      },
    };
  }

  it("lists every action as category.method with its line and effect, a category it cannot describe still listed", async () => {
    const { src } = source();
    const list = await new ActionCatalog(src).list();
    expect(list).toEqual([
      { name: "level.place_actor", category: "level", method: "place_actor", summary: "Place an actor in the level.", effect: "mutate" },
      { name: "level.get_outliner", category: "level", method: "get_outliner", summary: "List the level's actors.", effect: "read" },
      { name: "asset.delete", category: "asset", method: "delete", effect: "mutate", destructive: true },
    ]);
  });

  it("builds once per set of actions, and again when a plugin changes the set", async () => {
    const { src, calls, state } = source();
    const catalog = new ActionCatalog(src);
    await catalog.list();
    await catalog.list();
    expect(calls).toHaveLength(2);
    state.rows = [...ROWS, { category: "level", action: "save", effect: "mutate" }];
    expect((await catalog.list()).map((a) => a.name)).toContain("level.save");
    expect(calls).toHaveLength(4);
  });

  it("describes one action, and throws ue-mcp's answer for a name it does not know", async () => {
    const { src } = source();
    const catalog = new ActionCatalog(src);
    expect(await catalog.describe("level", "place_actor")).toMatchObject({ tool: "level", action: "place_actor", params: [{ name: "actorClass" }] });
    await expect(catalog.describe("level", "plce_actor")).rejects.toThrow("Closest: level.place_actor");
  });
});

describe("a /action in a session", () => {
  let root: string;
  let store: SessionStore;
  let published: Array<{ type: string; data?: Record<string, unknown> }>;
  let calls: Array<{ category: string; action: string; args?: Record<string, unknown> }>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-action-"));
    fs.mkdirSync(path.join(root, "project"), { recursive: true });
    store = new SessionStore(path.join(root, "data"));
    published = [];
    calls = [];
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const rows = (over: Partial<Approvals> = {}) => () => ({ shell: "allow", files: "allow", editorRestart: "allow", destructive: "allow", ...over }) as Approvals;
  const effects = { destructive: (c: string, m: string) => c === "asset" && m === "delete", readOnly: () => null };

  function setup(approvals = rows(), reply: (c: string, a: string) => ActionResult = () => answer({ success: true, created: true, actorLabel: "PointLight_1" })) {
    const host = {
      projectDir: path.join(root, "project"),
      dataDir: path.join(root, "data"),
      callAction: async (category: string, action: string, args?: Record<string, unknown>) => {
        // The runner's own background read of what is unsaved, which is not the action's call.
        if (action === "list_dirty_packages") return answer({ success: true, content: [], maps: [] });
        calls.push({ category, action, args });
        return reply(category, action);
      },
      editors: () => [{ connected: true, name: "P", port: 1, pid: 1, lastDisconnect: null }],
      editorOperation: async (op: string) => ({ op, steps: [] }),
      events: { publish: (type: string, data?: Record<string, unknown>) => void published.push({ type, data }), subscribe: () => () => {} },
      setBusy: () => {},
      log: { info() {}, warn() {} },
    } as unknown as AgentHost;
    const model: ModelProvider = { run: async () => { throw new Error("a /action runs no chat turn"); } };
    const runner = new AgentRunner({ host, store, provider: () => model, model: () => "claude-opus-5-5", approvals, effects });
    const s = store.create("New session");
    return { runner, s };
  }

  const tool = (id: string) => store.get(id)!.transcript.find((t) => t.kind === "tool") as Extract<TranscriptEntry, { kind: "tool" }>;
  const until = async (f: () => boolean) => {
    const end = Date.now() + 2000;
    while (!f()) {
      if (Date.now() > end) throw new Error("condition not met");
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  it("runs the action without the model, its call and answer in the transcript, and leaves the agent a note", async () => {
    const { runner, s } = setup();
    await runner.action(s.id, { category: "level", method: "place_actor", args: { actorClass: "PointLight", label: "Key Light" } });
    const after = store.get(s.id)!;
    expect(calls).toEqual([{ category: "level", action: "place_actor", args: { actorClass: "PointLight", label: "Key Light" } }]);
    expect(after.transcript[0]).toMatchObject({ kind: "user", text: '/action level.place_actor actorClass=PointLight label="Key Light"' });
    expect(tool(s.id).call).toMatchObject({ name: "ue_mcp", input: { action: "call", category: "level", method: "place_actor" }, outcome: "done" });
    expect(tool(s.id).call.result).toContain("PointLight_1");
    expect(after.status).toBe("idle");
    expect(after.messages).toHaveLength(0);
    expect(after.notes.join("\n")).toContain("The user ran /action level.place_actor");
    expect(published.some((p) => p.type === "tool.finished")).toBe(true);
  });

  it("runs a /action message with the pairs it names, JSON read as JSON", async () => {
    const { runner, s } = setup();
    await runner.send(s.id, '/action level.place_actor actorClass=PointLight location={"x":0,"y":0,"z":200} label="Key Light"');
    expect(calls[0]).toEqual({ category: "level", action: "place_actor", args: { actorClass: "PointLight", location: { x: 0, y: 0, z: 200 }, label: "Key Light" } });
    await expect(runner.send(s.id, "/action place_actor")).rejects.toThrow(/category\.method/);
  });

  it("asks first when the approval rows say so for a destructive action, and runs it once allowed", async () => {
    const { runner, s } = setup(rows({ destructive: "ask" }));
    const run = runner.action(s.id, { category: "asset", method: "delete", args: { assetPath: "/Game/Old" } });
    await until(() => (store.get(s.id)!.approvals ?? []).length > 0);
    const a = store.get(s.id)!.approvals![0];
    expect(a).toMatchObject({ tool: "ue_mcp", call: { category: "asset", method: "delete", args: { assetPath: "/Game/Old" } } });
    expect(calls).toHaveLength(0);
    runner.answerApproval(s.id, a.id, "allow");
    await run;
    expect(calls.map((c) => c.action)).toEqual(["delete"]);
    expect(tool(s.id).call.outcome).toBe("done");
  });

  it("does not run a declined action, and says so to the agent", async () => {
    const { runner, s } = setup(rows({ destructive: "ask" }));
    const run = runner.action(s.id, { category: "asset", method: "delete", args: { assetPath: "/Game/Old" } });
    await until(() => (store.get(s.id)!.approvals ?? []).length > 0);
    runner.answerApproval(s.id, store.get(s.id)!.approvals![0].id, "deny");
    await run;
    expect(calls).toHaveLength(0);
    expect(tool(s.id).call.outcome).toBe("declined");
    expect(store.get(s.id)!.status).toBe("idle");
    expect(store.get(s.id)!.notes.join("\n")).toContain("declined it at the approval");
  });

  it("asks before an editor restart reached as an action, and honours Allow for this session", async () => {
    const { runner, s } = setup(rows({ editorRestart: "ask" }));
    const first = runner.action(s.id, { category: "editor", method: "restart_editor", args: {} });
    await until(() => (store.get(s.id)!.approvals ?? []).length > 0);
    runner.answerApproval(s.id, store.get(s.id)!.approvals![0].id, "session");
    await first;
    await runner.action(s.id, { category: "editor", method: "restart_editor", args: {} });
    expect(published.filter((p) => p.type === "approval.requested")).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it("marks a failed action as an error and cuts a long answer in the note", async () => {
    const long = "x".repeat(ACTION_NOTE_CHARS + 50);
    const { runner, s } = setup(rows(), () => answer({ success: false, error: long }, true));
    await runner.action(s.id, { category: "level", method: "place_actor", args: {} });
    expect(tool(s.id).call.outcome).toBe("error");
    const note = store.get(s.id)!.notes.join("\n");
    expect(note).toContain("It failed");
    expect(note).toContain(`[cut at ${ACTION_NOTE_CHARS} characters]`);
  });

  it("refuses while a turn runs, and a name that is no category.method", async () => {
    const { runner, s } = setup();
    const live = store.get(s.id)!;
    live.status = "running";
    store.save(live);
    await expect(runner.action(s.id, { category: "level", method: "place_actor", args: {} })).rejects.toThrow(/in progress/);
    live.status = "idle";
    store.save(live);
    await expect(runner.action(s.id, { category: "level", method: "", args: {} })).rejects.toThrow(/category\.method/);
  });

  it("ends an action a daemon restart cut off, without resuming a turn", () => {
    const { runner, s } = setup();
    const live = store.get(s.id)!;
    live.transcript.push({ kind: "user", text: "/action level.place_actor", at: "" });
    live.transcript.push({ kind: "tool", call: { id: "action-1", name: "ue_mcp", input: {}, outcome: "pending", startedAt: "" } });
    live.status = "running";
    store.save(live);
    runner.recover();
    expect(tool(s.id).call.outcome).toBe("unknown");
    expect(tool(s.id).call.result).toMatch(/^It was cut off/);
    expect(store.get(s.id)!.status).toBe("idle");
  });
});

/**
 * /playtest on the API path: the runner offers pie alone, forced, and checks
 * the call itself; a failed script_create is answered once more; the turn
 * ends with the Draft card or "No playtest was made", never with the model's
 * text. forced-tool-choice.test.ts has what each provider sends.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ActionResult, EditorStatus } from "ue-mcp/daemon";
import type { TranscriptEntry } from "@ue-mcp-studio/shared";
import type { ModelProvider, ModelRequest, ModelTurn } from "../src/providers.js";
import { AgentRunner } from "../src/runner.js";
import { SessionStore } from "../src/sessions.js";
import { QaBroker, type QaHost } from "../src/qa.js";
import { PlaytestStore } from "../src/playtest-store.js";
import { NO_CALL } from "../src/playtest-command.js";
import type { AgentHost } from "../src/tools.js";

const SCRIPT = "/Game/PIEStudio/Scripts/DoubleJump";
const STEPS = [{ instruction: "Press Space twice", judge: "auto", expect: { value: "Pawn.JumpCount", op: "eq", target: 2 } }, { instruction: "The second jump feels right", judge: "manual" }];
const ok = (body: Record<string, unknown>): ActionResult => ({ isError: false, content: [{ type: "text", text: JSON.stringify({ success: true, ...body }) }] });
const bad = (error: string): ActionResult => ({ isError: false, content: [{ type: "text", text: JSON.stringify({ success: false, error }) }] });

let root: string;
let store: SessionStore;
let calls: Array<{ category: string; action: string; args: Record<string, unknown> }>;
let createAnswers: ActionResult[];

function host(): AgentHost & QaHost {
  const listeners: Array<(e: { type: string; data: Record<string, unknown> }) => void> = [];
  return {
    projectDir: path.join(root, "project"),
    dataDir: path.join(root, "data"),
    callAction: async (category: string, action: string, args: Record<string, unknown> = {}) => {
      calls.push({ category, action, args });
      if (action === "describe_action") return { isError: false, content: [{ type: "text", text: "pie.script_create(name, steps[], profile?)" }] };
      if (action === "script_create") return createAnswers.shift() ?? ok({ path: SCRIPT, name: args.name, steps: args.steps, default_within_ms: 5000 });
      return ok({});
    },
    editors: (): EditorStatus[] => [{ name: "P", connected: true, port: 1, pid: 1, lastDisconnect: null }],
    editorOperation: async (op) => ({ op, steps: [] }),
    events: { publish: () => undefined, subscribe: (l) => (listeners.push(l), () => {}) },
    setBusy: () => {},
    log: { info() {}, warn() {} },
  };
}

class Scripted implements ModelProvider {
  requests: ModelRequest[] = [];
  constructor(private readonly turns: ModelTurn[]) {}
  async run(req: ModelRequest, onText: (t: string) => void): Promise<ModelTurn> {
    this.requests.push(JSON.parse(JSON.stringify(req)));
    const t = this.turns.shift();
    if (!t) throw new Error("script exhausted");
    for (const b of t.content) if (b.type === "text") onText(b.text);
    return t;
  }
}

const say = (text: string): ModelTurn => ({ content: [{ type: "text", text, citations: null } as never], stopReason: "end_turn" });
const use = (id: string, name: string, input: Record<string, unknown>, text?: string): ModelTurn => ({
  content: [...(text ? [{ type: "text", text, citations: null }] : []), { type: "tool_use", id, name, input }] as never,
  stopReason: "tool_use",
});
const pie = (id: string, extra: Record<string, unknown> = {}) => use(id, "pie", { action: "script_create", name: "DoubleJump", steps: STEPS, ...extra }, "Here is a checklist:\n1. Jump - PASS");

function runnerWith(model: Scripted) {
  const h = host();
  const playtests = new PlaytestStore(h.dataDir);
  const qa = new QaBroker({ host: h, store, playtests });
  const published: string[] = [];
  h.events.publish = (type: string) => void published.push(type);
  return { runner: new AgentRunner({ host: h, store, qa, provider: () => model, model: () => "claude-opus-5", playtestRuns: () => playtests.runs() }), published };
}

const kinds = (t: TranscriptEntry[]) => t.map((e) => (e.kind === "tool" ? `tool:${e.call.name}:${e.call.outcome}` : e.kind));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-playtest-"));
  fs.mkdirSync(path.join(root, "project", "Content"), { recursive: true });
  store = new SessionStore(path.join(root, "data"));
  calls = [];
  createAnswers = [];
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("a /playtest turn on the API path", () => {
  it("sends pie alone, forced, with the conversation and script_create's parameters, and ends with the Draft card", async () => {
    const model = new Scripted([pie("p1")]);
    const { runner, published } = runnerWith(model);
    const s = store.create();
    s.messages.push({ role: "user", content: "add a double jump" }, { role: "assistant", content: [{ type: "text", text: "Added it to BP_Hero.", citations: null }] as never });
    store.save(s);
    await runner.send(s.id, "/playtest the second jump");

    const req = model.requests[0];
    expect(req.forceTool).toBe("pie");
    expect(req.tools.map((t) => (t as { name: string }).name)).toEqual(["pie"]);
    expect(req.system[0].text).toMatch(/This turn is a \/playtest/);
    // The recent conversation goes with it, then the job.
    expect(req.messages.slice(0, 2).map((m) => m.role)).toEqual(["user", "assistant"]);
    const asked = JSON.stringify(req.messages[2].content);
    expect(asked).toMatch(/The user ran \/playtest/);
    expect(asked).toMatch(/What the user wants tested: the second jump/);
    expect(asked).toMatch(/pie\.script_create\(name, steps\[\], profile\?\)/);

    expect(calls.filter((c) => c.category === "pie")).toEqual([{ category: "pie", action: "script_create", args: { name: "DoubleJump", steps: STEPS } }]);
    const fin = store.get(s.id)!;
    expect(fin.status).toBe("idle");
    // The model's checklist text is never shown: the user's line, the call, the Draft card.
    expect(kinds(fin.transcript)).toEqual(["user", "tool:pie:done", "qa"]);
    expect(fin.transcript[0]).toMatchObject({ kind: "user", text: "/playtest the second jump" });
    const card = fin.transcript[2];
    expect(card.kind === "qa" && card.run.state).toBe("draft");
    expect(published).not.toContain("turn.delta");
    // Nothing ran it: Playtest runs is Manual and the turn only drafts.
    expect(calls.some((c) => c.action === "script_run")).toBe(false);
    expect(fin.playtest).toBeNull();
  });

  it("a turn that writes text instead of the call is the failure state, not the text", async () => {
    const model = new Scripted([say("1. Jump - PASS\n2. Land - PASS")]);
    const { runner } = runnerWith(model);
    const s = store.create();
    await runner.send(s.id, "/playtest");
    const fin = store.get(s.id)!;
    expect(kinds(fin.transcript)).toEqual(["user", "playtest-failed"]);
    expect(fin.transcript[1]).toMatchObject({ reason: NO_CALL, request: { text: "" } });
    expect(fin.status).toBe("idle");
    expect(calls.some((c) => c.category === "pie")).toBe(false);
  });

  it("refuses any other tool or action, answers it once, and fails visibly when the model does it again", async () => {
    const model = new Scripted([
      use("u1", "ue_mcp", { action: "call", category: "pie", method: "script_run", args: {} }),
      use("u2", "pie", { action: "script_run", script: SCRIPT }),
    ]);
    const { runner } = runnerWith(model);
    const s = store.create();
    await runner.send(s.id, "/playtest");
    expect(model.requests).toHaveLength(2);
    // The refusal went back to the model inside the same turn.
    const fed = JSON.stringify(model.requests[1].messages.at(-1)!.content);
    expect(fed).toMatch(/allows only the pie tool with action script_create; ue_mcp was refused/);
    expect(calls.some((c) => c.category === "pie")).toBe(false);
    const fin = store.get(s.id)!;
    expect(kinds(fin.transcript)).toEqual(["user", "tool:ue_mcp:error", "tool:pie:error", "playtest-failed"]);
    expect((fin.transcript[3] as { reason: string }).reason).toMatch(/only pie action script_create; script_run was refused/);
  });

  it("feeds a validation error back once, and the second call's script is the Draft card", async () => {
    createAnswers = [bad("steps[0].expect.op 'equals' is not one of eq, ne, gt, lt")];
    const model = new Scripted([pie("p1"), pie("p2")]);
    const { runner } = runnerWith(model);
    const s = store.create();
    await runner.send(s.id, "/playtest");
    expect(JSON.stringify(model.requests[1].messages.at(-1)!.content)).toMatch(/is not one of eq, ne, gt, lt/);
    expect(model.requests[1].forceTool).toBe("pie");
    const fin = store.get(s.id)!;
    expect(kinds(fin.transcript)).toEqual(["user", "tool:pie:error", "tool:pie:done", "qa"]);
    // Every call has its result and the roles stay in turn for the next message.
    expect(fin.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
  });

  it("fails visibly with the error when script_create errors twice", async () => {
    createAnswers = [bad("name is taken"), bad("name is taken")];
    const model = new Scripted([pie("p1"), pie("p2"), say("unused")]);
    const { runner } = runnerWith(model);
    const s = store.create();
    await runner.send(s.id, "/playtest");
    expect(model.requests).toHaveLength(2);
    const fin = store.get(s.id)!;
    expect(kinds(fin.transcript)).toEqual(["user", "tool:pie:error", "tool:pie:error", "playtest-failed"]);
    expect((fin.transcript[3] as { reason: string }).reason).toMatch(/name is taken/);
  });

  it("Make playtest: the agent message it names goes with the job, and the line says /playtest", async () => {
    const model = new Scripted([pie("p1")]);
    const { runner } = runnerWith(model);
    const s = store.create();
    s.transcript.push({ kind: "user", text: "add a double jump", at: "t" }, { kind: "assistant", text: "Added a double jump: press Space twice.", at: "t" });
    s.messages.push({ role: "user", content: "add a double jump" }, { role: "assistant", content: [{ type: "text", text: "Added a double jump: press Space twice.", citations: null }] as never });
    store.save(s);
    await runner.send(s.id, "", [], { text: "", source: 1 });
    expect(JSON.stringify(model.requests[0].messages.at(-1)!.content)).toMatch(/Make it from this message of yours:\\n\\nAdded a double jump: press Space twice\./);
    expect(store.get(s.id)!.transcript[2]).toMatchObject({ kind: "user", text: "/playtest", source: 1 });
    await expect(runner.send(s.id, "", [], { text: "", source: 0 })).rejects.toThrow(/not one of the agent's messages/);
  });

  it("an ordinary message that starts with a slash is an ordinary turn", async () => {
    const model = new Scripted([say("It is under /Game/Maps.")]);
    const { runner } = runnerWith(model);
    const s = store.create();
    await runner.send(s.id, "/Game/Maps/Main does not open");
    expect(model.requests[0].forceTool).toBeUndefined();
    expect(kinds(store.get(s.id)!.transcript)).toEqual(["user", "assistant"]);
  });
});

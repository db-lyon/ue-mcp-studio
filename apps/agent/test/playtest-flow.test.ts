/**
 * /playtest through ue-mcp's playtest flow: the call to the daemon's
 * /v1/flows/playtest/run, the stages its flow.* events show on the card, the
 * Draft card it ends with, and the failure state with the flow's errors.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ActionResult } from "ue-mcp/daemon";
import type { TranscriptEntry } from "@ue-mcp-studio/shared";
import { PLAYTEST_LINKS_LINE, PlaytestFlow, flowErrors, outcomeOf, playtestParams, playtestTarget, playtestTurnParams, type FlowEventLike } from "../src/playtest-flow.js";
import { AgentRunner } from "../src/runner.js";
import { SessionStore } from "../src/sessions.js";
import { QaBroker, type QaHost } from "../src/qa.js";
import type { AgentHost } from "../src/tools.js";
import type { ModelProvider, ModelTurn } from "../src/providers.js";
import { SessionStore as Sessions } from "../src/sessions.js";

const PATH = "/Game/PIEStudio/Scripts/TS_Playtest_BP_Hero";
const saved = { success: true, path: PATH, name: "TS_Playtest_BP_Hero", steps: [{ instruction: "Press Space twice", judge: "auto", expect: { value: "Pawn.JumpCount", op: "eq", target: 2 } }], step_count: 1 };
const refusal = {
  valid: false,
  attempt: 3,
  errors: [
    { step: 0, field: "expect.value", message: "Pawn.JumpCnt is not a value PIE can read", candidates: ["Pawn.JumpCount", "Pawn.JumpMaxCount"] },
    { step: null, field: "", message: "The script has no auto step" },
  ],
  summary: "2 problems",
};

/** A daemon: the flow route answers from `answer`, and emits the events `script` lists while it runs. */
function fakeDaemon(answer: () => { status: number; body: unknown }, script: FlowEventLike[] = []) {
  const listeners = new Set<(e: FlowEventLike) => void>();
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    for (const e of script) for (const l of [...listeners]) l(e);
    const a = answer();
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const flow = new PlaytestFlow({
    endpoint: () => ({ port: 4711, token: "tok" }),
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    fetchImpl,
  });
  return { flow, requests, listeners };
}

const started = (runId: string, flowName = "playtest"): FlowEventLike => ({ type: "flow.run_started", data: { runId, flowName } });
const step = (runId: string, name: string, flowName = "playtest"): FlowEventLike => ({ type: "flow.step_started", data: { runId, flowName, step: { name } } });
const success = { status: 200, body: { success: true, runId: "r1", steps: [{ name: "playtest.gather", success: true, data: {} }, { name: "playtest.save", success: true, data: saved }] } };
const failure = {
  status: 200,
  body: {
    success: false,
    runId: "r1",
    failedStep: "playtest.check",
    steps: [
      { name: "playtest.gather", success: true },
      { name: "playtest.check", success: false, error: { message: "The drafted script was still refused after 3 attempts: 2 problems" }, data: refusal },
    ],
  },
};

describe("the flow call", () => {
  it("posts the target and context to the daemon's playtest flow with its token", async () => {
    const d = fakeDaemon(() => success);
    const out = await d.flow.run({ target: "/Game/BP_Hero", context: "User: add a double jump" }, () => {}, new AbortController().signal);
    expect(d.requests).toHaveLength(1);
    expect(d.requests[0].url).toBe("http://127.0.0.1:4711/v1/flows/playtest/run");
    expect(d.requests[0].init.method).toBe("POST");
    expect((d.requests[0].init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(String(d.requests[0].init.body))).toEqual({ params: { target: "/Game/BP_Hero", context: "User: add a double jump" } });
    expect(out).toEqual({ made: true, script: saved });
    expect(d.listeners.size).toBe(0);
  });

  it("shows each stage of its own run, counting drafts, and ignores other runs and flows", async () => {
    const d = fakeDaemon(() => success, [
      started("other", "build"),
      step("other", "playtest.draft", "build"),
      started("r1"),
      step("r1", "playtest.gather"),
      step("r1", "playtest.draft"),
      step("r1", "playtest.check"),
      step("zzz", "playtest.draft"),
      step("r1", "playtest.draft"),
      step("r1", "playtest.check"),
      step("r1", "playtest.save"),
    ]);
    const seen: string[] = [];
    await d.flow.run({ target: "t", context: "" }, (s, a) => seen.push(`${s}:${a}`), new AbortController().signal);
    expect(seen).toEqual(["gathering:1", "gathering:1", "drafting:1", "checking:1", "drafting:2", "checking:2"]);
  });

  it("returns the refusal's problems one per line, steps counted from 1, with what was meant", async () => {
    const d = fakeDaemon(() => failure);
    const out = await d.flow.run({ target: "t", context: "" }, () => {}, new AbortController().signal);
    expect(out).toEqual({
      made: false,
      errors: [
        "Step 1 expect.value: Pawn.JumpCnt is not a value PIE can read (did you mean Pawn.JumpCount, Pawn.JumpMaxCount?)",
        "The script has no auto step",
      ],
    });
  });

  it("says why when the flow cannot run at all", () => {
    expect(outcomeOf(500, { error: "No model is configured for flow agent steps." })).toEqual({ made: false, errors: ["No model is configured for flow agent steps."] });
    expect(flowErrors({ steps: [{ name: "playtest.gather", success: false, error: { message: "playtest needs params.target" } }] })).toEqual(["playtest.gather: playtest needs params.target"]);
  });

  it("runs one playtest flow at a time, so each run's events are its own", async () => {
    let open = 0;
    let most = 0;
    const d = fakeDaemon(() => {
      most = Math.max(most, ++open);
      open--;
      return success;
    });
    await Promise.all([1, 2, 3].map(() => d.flow.run({ target: "t", context: "" }, () => {}, new AbortController().signal)));
    expect(d.requests).toHaveLength(3);
    expect(most).toBe(1);
  });
});

describe("the flow's params", () => {
  const at = "2026-10-24T10:00:00Z";
  const transcript: TranscriptEntry[] = [
    { kind: "user", text: "add a double jump to /Game/Blueprints/BP_Hero", at },
    { kind: "assistant", text: "Done: BP_Hero jumps twice now.", at },
    { kind: "assistant", text: "A subagent's note", at, parent: "call_1" },
    { kind: "user", text: "/playtest", at },
  ];

  it("takes an asset path from the conversation as the target, and the recent conversation as context", () => {
    const p = playtestParams("", null, transcript);
    expect(p.target).toBe("/Game/Blueprints/BP_Hero");
    expect(p.context).toContain("User: add a double jump to /Game/Blueprints/BP_Hero");
    expect(p.context).toContain("Assistant: Done: BP_Hero jumps twice now.");
    expect(p.context).not.toContain("subagent");
    expect(p.context).not.toContain("/playtest");
  });

  it("puts the user's words and the source message first", () => {
    const p = playtestParams("the second jump", "Done: BP_Hero jumps twice now.", transcript);
    expect(p.context.startsWith("The user asked to test: the second jump\n\nMade from this agent message:\nDone: BP_Hero jumps twice now.")).toBe(true);
    expect(playtestTarget("the door opens", null, [])).toBe("the door opens");
  });

  it("tells the draft to write each asset a step names as a markdown link to its object path, kept when the conversation is cut", () => {
    expect(playtestParams("", null, transcript).context.endsWith(PLAYTEST_LINKS_LINE)).toBe(true);
    const long: TranscriptEntry[] = Array.from({ length: 16 }, (_, i) => ({ kind: "user" as const, text: `${"padding ".repeat(200)}${i}`, at: "2026-10-28T10:00:00.000Z" }));
    const cut = playtestParams("", null, long);
    expect(cut.context.length).toBeLessThanOrEqual(12_000);
    expect(cut.context).toContain(PLAYTEST_LINKS_LINE);
    expect(PLAYTEST_LINKS_LINE).toContain("[L_WG_Meadow](/Game/Maps/L_WG_Meadow.L_WG_Meadow)");
    const turn = playtestTurnParams(long, [{ kind: "asset", path: "/Game/BP_Hero.BP_Hero" } as never]);
    expect(turn.context.length).toBeLessThanOrEqual(12_000);
    expect(turn.context).toContain(PLAYTEST_LINKS_LINE);
  });
});

describe("a /playtest in a session", () => {
  let root: string;
  let store: SessionStore;
  let published: Array<{ type: string; data?: Record<string, unknown> }>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-playtest-flow-"));
    fs.mkdirSync(path.join(root, "project"), { recursive: true });
    store = new SessionStore(path.join(root, "data"));
    published = [];
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function setup(answer: () => { status: number; body: unknown }, events: FlowEventLike[] = [], turns: ModelTurn[] = [], editor: (category: string, action: string) => Record<string, unknown> = () => ({})) {
    const ok = (body: Record<string, unknown>): ActionResult => ({ isError: false, content: [{ type: "text", text: JSON.stringify({ success: true, ...body }) }] });
    const host = {
      projectDir: path.join(root, "project"),
      dataDir: path.join(root, "data"),
      callAction: async (category: string, action: string) => ok(editor(category, action)),
      editors: () => [{ connected: true, name: "P", port: 1, pid: 1, lastDisconnect: null }],
      editorOperation: async (op: string) => ({ op, steps: [] }),
      events: { publish: (type: string, data?: Record<string, unknown>) => void published.push({ type, data }), subscribe: () => () => {} },
      setBusy: () => {},
      log: { info() {}, warn() {} },
    } as unknown as QaHost & AgentHost;
    const qa = new QaBroker({ host, store });
    const model: ModelProvider = { run: async () => { const t = turns.shift(); if (!t) throw new Error("a /playtest runs no chat turn"); return t; } };
    const d = fakeDaemon(answer, events);
    const runner = new AgentRunner({ host, store, qa, provider: () => model, model: () => "claude-opus-5-5", playtestFlow: d.flow });
    const s = store.create("New session");
    return { runner, s, d };
  }

  it("runs the flow for a /playtest message, shows its stages, and ends with the Draft card", async () => {
    const { runner, s, d } = setup(() => success, [started("r1"), step("r1", "playtest.gather"), step("r1", "playtest.draft"), step("r1", "playtest.check")]);
    await runner.send(s.id, "/playtest the double jump");
    const after = store.get(s.id)!;
    expect(JSON.parse(String(d.requests[0].init.body)).params.target).toBe("the double jump");
    expect(after.transcript[0]).toMatchObject({ kind: "user", text: "/playtest the double jump" });
    expect(after.transcript[1]).toMatchObject({ kind: "playtest", state: "created", attempt: 1 });
    const card = after.transcript.find((t) => t.kind === "qa");
    expect(card && card.kind === "qa" && card.run.script).toBe(PATH);
    expect(after.status).toBe("idle");
    expect(after.messages).toHaveLength(0);
    expect(after.notes.join("\n")).toContain(PATH);
    const states = published.filter((p) => p.type === "playtest.changed").map((p) => p.data?.state);
    expect(states).toEqual(["gathering", "gathering", "drafting", "checking", "created"]);
  });

  it("says no playtest was made, with the flow's errors, and keeps the request for Retry", async () => {
    const { runner, s } = setup(() => failure);
    await runner.playtest(s.id, { text: "" });
    const after = store.get(s.id)!;
    const card = after.transcript.find((t) => t.kind === "playtest");
    expect(card).toMatchObject({ kind: "playtest", state: "failed", request: { text: "" } });
    expect(card && card.kind === "playtest" && card.errors?.[0]).toMatch(/^Step 1 expect\.value: Pawn\.JumpCnt/);
    expect(after.transcript.some((t) => t.kind === "qa")).toBe(false);
    expect(after.status).toBe("idle");
    expect(after.notes.join("\n")).toContain("made no playtest");
  });

  it("makes a playtest from an agent message, and refuses an entry that is not one", async () => {
    const { runner, s, d } = setup(() => success);
    const live = store.get(s.id)!;
    live.transcript.push({ kind: "assistant", text: "Added a dash to /Game/BP_Dasher.", at: "" });
    store.save(live);
    await expect(runner.playtest(s.id, { text: "", source: 5 })).rejects.toThrow(/not one of the agent's messages/);
    await runner.playtest(s.id, { text: "", source: 0 });
    expect(JSON.parse(String(d.requests[0].init.body)).params.target).toBe("/Game/BP_Dasher");
    expect(store.get(s.id)!.transcript[1]).toMatchObject({ kind: "user", text: "/playtest", source: 0 });
  });

  it("ends a card a daemon restart cut off as failed, so Retry can run it again", () => {
    const { runner, s } = setup(() => success);
    const live = store.get(s.id)!;
    live.transcript.push({ kind: "playtest", state: "drafting", request: { text: "" }, attempt: 1, at: "" });
    live.status = "running";
    store.save(live);
    runner.recover();
    const after = store.get(s.id)!;
    expect(after.transcript[0]).toMatchObject({ state: "failed" });
    expect(after.status).toBe("idle");
  });

  const call = (id: string, category: string, method: string, args: Record<string, unknown> = {}): ModelTurn => ({
    content: [{ type: "tool_use", id, name: "ue_mcp", input: { action: "call", category, method, args } } as never],
    stopReason: "tool_use",
  });
  const said = (t: string): ModelTurn => ({ content: [{ type: "text", text: t, citations: null } as never], stopReason: "end_turn" });

  it("records what a turn changed from its calls, for the Make playtest pill, and runs the flow on it", async () => {
    const { runner, s, d } = setup(() => success, [], [
      call("c1", "blueprint", "read_blueprint", { assetPath: "/Game/BP_Door" }),
      call("c2", "blueprint", "add_component", { assetPath: "/Game/BP_Hero", componentClass: "AudioComponent" }),
      said("Added a jump sound to BP_Hero."),
    ], (_c, action) => (action === "add_component" ? { updated: true } : {}));
    await runner.send(s.id, "add a jump sound to the hero");
    const facts = Sessions.detail(store.get(s.id)!).turn!;
    expect(facts).toEqual({ start: 0, mutations: 1, targets: [{ kind: "asset", path: "/Game/BP_Hero", saved: false }], playtest: false });
    await expect(runner.playtest(s.id, { text: "", turn: 3 })).rejects.toThrow(/does not begin the latest turn/);
    await runner.playtest(s.id, { text: "", turn: 0 });
    const params = JSON.parse(String(d.requests[0].init.body)).params;
    expect(params.target).toBe("/Game/BP_Hero");
    expect(params.context).toContain("Assets it changed: /Game/BP_Hero");
    expect(params.context).toContain("Assistant: Added a jump sound to BP_Hero.");
    // The /playtest is the latest turn now, and it made a playtest: no pill follows it.
    expect(Sessions.detail(store.get(s.id)!).turn).toMatchObject({ playtest: true, mutations: 0 });
  });

  it("counts no change for a turn that only read, and marks one that saved a playtest itself", async () => {
    const { runner, s } = setup(() => success, [], [
      call("c1", "blueprint", "read_blueprint", { assetPath: "/Game/BP_Door" }),
      said("It has a hinge."),
      call("c2", "pie", "script_create", { name: "Door", steps: [{ instruction: "Open it" }] }),
      said("Saved a playtest."),
    ], (_c, action) => (action === "script_create" ? { created: true, path: "/Game/Scripts/Door", name: "Door", steps: [{ instruction: "Open it", judge: "manual" }] } : {}));
    await runner.send(s.id, "what does the door have?");
    expect(Sessions.detail(store.get(s.id)!).turn).toMatchObject({ mutations: 0, playtest: false });
    await runner.send(s.id, "make a playtest of the door");
    expect(Sessions.detail(store.get(s.id)!).turn).toMatchObject({ playtest: true });
  });
});

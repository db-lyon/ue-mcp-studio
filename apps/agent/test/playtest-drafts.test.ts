/**
 * Draft playtests: the card a created script gets before anything runs, its
 * Run, Edit and Delete, the players Studio keeps for each step, and the
 * Playtest runs setting that decides whether the agent may start a run.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ActionResult } from "ue-mcp/daemon";
import { PLAYTEST_RUNS_REFUSAL, qaDraftId, type QaRun } from "@ue-mcp-studio/shared";
import { SessionStore } from "../src/sessions.js";
import { QaBroker, type QaHost } from "../src/qa.js";
import { PlaytestStore } from "../src/playtest-store.js";
import type { AgentHost } from "../src/tools.js";

const PATH = "/Game/PIEStudio/Scripts/SigilPickup";
const RUN = "script_SigilPickup_20261024_120000";
const STEPS = [
  { instruction: "Pick up the sigil", judge: "auto", expect: { value: "PlayerState.SigilAttributes.Sigil.CurrentValue", op: "eq", target: 100, within_ms: 5000 }, player: "Host" },
  { instruction: "The pickup plays on the client", judge: "manual", player: "client 1" },
];
const ok = (body: Record<string, unknown>): ActionResult => ({ isError: false, content: [{ type: "text", text: JSON.stringify({ success: true, ...body }) }] });
const script = (steps: unknown[]) => ({ path: PATH, name: "SigilPickup", default_within_ms: 5000, steps, step_count: steps.length });
const strip = (steps: typeof STEPS) => steps.map(({ player: _p, ...rest }) => rest);
const runAnswer = { run_id: RUN, script: PATH, script_name: "SigilPickup", state: "armed", steps: strip(STEPS).map((s, index) => ({ ...s, index, status: "pending" })), awaiting: [], last_seq: 1, recording_id: RUN };

let root: string;
let store: SessionStore;
let playtests: PlaytestStore;
let calls: Array<{ category: string; action: string; args: Record<string, unknown> }>;
let published: Array<{ type: string; data?: Record<string, unknown> }>;

const qaHost = (): QaHost & AgentHost => ({
  projectDir: path.join(root, "project"),
  dataDir: path.join(root, "data"),
  callAction: async (category: string, action: string, args: Record<string, unknown> = {}) => {
    calls.push({ category, action, args });
    if (action === "script_create" || action === "script_update") return ok(script(args.steps as unknown[]));
    if (action === "script_run") return ok(runAnswer);
    return ok({});
  },
  editors: () => [{ connected: true, name: "P", port: 1, pid: 1, lastDisconnect: null }],
  editorOperation: async (op: string) => ({ op, steps: [] }),
  events: { publish: (type: string, data?: Record<string, unknown>) => void published.push({ type, data }), subscribe: () => () => {} },
  setBusy: () => {},
  log: { info() {}, warn() {} },
}) as unknown as QaHost & AgentHost;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-drafts-"));
  store = new SessionStore(path.join(root, "data"));
  playtests = new PlaytestStore(path.join(root, "data"));
  calls = [];
  published = [];
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function setup() {
  const host = qaHost();
  const broker = new QaBroker({ host, store, playtests, now: () => "2026-10-24T12:00:00.000Z" });
  const s = store.create();
  return { host, broker, s, agent: broker.wrap(host, s.id), assigned: broker.wrap(host, s.id, { assigned: true }) };
}
const cards = (id: string): QaRun[] => store.get(id)!.transcript.flatMap((t) => (t.kind === "qa" ? [t.run] : []));

describe("a script the agent creates", () => {
  it("gets a draft card, unrun, with each step's player, auto expectation or manual", async () => {
    const { agent, s } = setup();
    await agent.callAction("pie", "script_create", { name: "SigilPickup", steps: STEPS });
    // ue-mcp never sees the players.
    expect(calls[0]).toMatchObject({ action: "script_create", args: { steps: strip(STEPS) } });
    expect(calls.some((c) => c.action === "script_run")).toBe(false);
    const [card] = cards(s.id);
    expect(card).toMatchObject({ runId: qaDraftId(PATH), state: "draft", script: PATH, scriptName: "SigilPickup", sessionId: s.id });
    expect(card.steps.map((x) => [x.judge, x.player, x.expect?.value ?? null])).toEqual([
      ["auto", "host", "PlayerState.SigilAttributes.Sigil.CurrentValue"],
      ["manual", "client 1", null],
    ]);
    expect(new PlaytestStore(path.join(root, "data")).players(PATH)).toEqual({ 0: "host", 1: "client 1" });
  });

  it("updates the same card when the agent updates the script", async () => {
    const { agent, s } = setup();
    await agent.callAction("pie", "script_create", { name: "SigilPickup", steps: STEPS });
    await agent.callAction("pie", "script_update", { path: PATH, steps: [STEPS[1]] });
    expect(cards(s.id)).toHaveLength(1);
    expect(cards(s.id)[0].steps.map((x) => x.instruction)).toEqual(["The pickup plays on the client"]);
  });
});

describe("Playtest runs", () => {
  it("Manual refuses the agent's own run, naming the setting, and lets an assigned subagent run it", async () => {
    const { agent, assigned } = setup();
    expect(playtests.runs()).toBe("manual");
    const r = await agent.callAction("pie", "script_run", { script: PATH, start_pie: true });
    expect(r).toEqual({ isError: true, content: [{ type: "text", text: PLAYTEST_RUNS_REFUSAL }] });
    expect(calls).toEqual([]);
    expect((await assigned.callAction("pie", "script_run", { script: PATH })).isError).toBe(false);
  });

  it("Automatic lets the agent run it, and its draft card goes straight to live", async () => {
    playtests.setRuns("automatic");
    expect(new PlaytestStore(path.join(root, "data")).runs()).toBe("automatic");
    const { agent, s } = setup();
    await agent.callAction("pie", "script_create", { name: "SigilPickup", steps: STEPS });
    const r = await agent.callAction("pie", "script_run", { script: PATH, start_pie: true });
    expect(r.isError).toBe(false);
    const all = cards(s.id);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ runId: RUN, state: "armed" });
    expect(all[0].steps.map((x) => x.player)).toEqual(["host", "client 1"]);
    expect(published.find((e) => e.type === "qa.changed" && e.data?.replaces === qaDraftId(PATH))).toBeTruthy();
  });
});

describe("the draft card's buttons", () => {
  it("Run sets PIE's players, runs the script on the auto steps' player, and turns the same card live", async () => {
    const { agent, broker, s } = setup();
    await agent.callAction("pie", "script_create", { name: "SigilPickup", steps: STEPS });
    calls = [];
    const r = await broker.runScript(qaDraftId(PATH), { startPie: true, players: 2, listen: true, record: false });
    expect(calls.map((c) => c.action)).toEqual(["configure_pie", "script_run"]);
    expect(calls[0]).toMatchObject({ category: "editor", args: { numClients: 2, netMode: "listen" } });
    expect(calls[1].args).toEqual({ script: PATH, start_pie: true, record: false, pie_instance: 0 });
    expect("run" in r && r.run.runId).toBe(RUN);
    expect(cards(s.id).map((c) => c.runId)).toEqual([RUN]);
  });

  it("Run with one player leaves PIE's settings alone and uses the running PIE when asked", async () => {
    const { agent, broker } = setup();
    await agent.callAction("pie", "script_create", { name: "SigilPickup", steps: [STEPS[1]] });
    calls = [];
    await broker.runScript(qaDraftId(PATH), { startPie: false, players: 1 });
    expect(calls).toEqual([{ category: "pie", action: "script_run", args: { script: PATH, start_pie: false, record: true } }]);
  });

  it("Edit saves the steps through pie(script_update), keeping the players beside them", async () => {
    const { agent, broker, s } = setup();
    await agent.callAction("pie", "script_create", { name: "SigilPickup", steps: STEPS });
    calls = [];
    const edited = [{ instruction: "Pick up the sigil as the client", judge: "manual", player: "client 1" }];
    const r = await broker.saveScript(qaDraftId(PATH), { steps: edited });
    expect(calls).toEqual([{ category: "pie", action: "script_update", args: { path: PATH, steps: [{ instruction: "Pick up the sigil as the client", judge: "manual" }] } }]);
    expect("run" in r && r.run.steps.map((x) => [x.instruction, x.player])).toEqual([["Pick up the sigil as the client", "client 1"]]);
    expect(cards(s.id)).toHaveLength(1);
  });

  it("Delete removes the script with pie(script_delete) and the card says so", async () => {
    const { agent, broker, s } = setup();
    await agent.callAction("pie", "script_create", { name: "SigilPickup", steps: STEPS });
    calls = [];
    await broker.deleteScript(qaDraftId(PATH));
    expect(calls).toEqual([{ category: "pie", action: "script_delete", args: { path: PATH, confirm: true } }]);
    expect(cards(s.id)[0]).toMatchObject({ state: "draft", deleted: true });
    expect(await broker.runScript(qaDraftId(PATH), {})).toMatchObject({ status: 409 });
  });

  it("Turn into Playtest saves the steps Studio read as a new script, with its draft card", async () => {
    const { broker, s } = setup();
    const r = await broker.createScript({ sessionId: s.id, name: "SigilPickup", steps: STEPS });
    expect(calls[0]).toMatchObject({ action: "script_create", args: { name: "SigilPickup", onConflict: "error", steps: strip(STEPS) } });
    expect("run" in r && r.run.state).toBe("draft");
    expect(cards(s.id)).toHaveLength(1);
  });

  it("Assign to subagent works on a draft: the subagent's run takes the draft's card", async () => {
    const { agent, broker, assigned, s } = setup();
    await agent.callAction("pie", "script_create", { name: "SigilPickup", steps: STEPS });
    broker.setAssigner({ assign: () => ({ callId: "studio_9", done: new Promise(() => {}) }), stop: () => true });
    const a = broker.assign(qaDraftId(PATH), {});
    expect("run" in a && a.run.assignment?.state).toBe("running");
    await assigned.callAction("pie", "script_run", { script: PATH, start_pie: true });
    expect(cards(s.id)).toHaveLength(1);
    expect(cards(s.id)[0]).toMatchObject({ runId: RUN, assignment: { callId: "studio_9", state: "running" } });
  });
});

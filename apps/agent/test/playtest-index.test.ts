/**
 * The Playtests page's list: every script the editor lists, each with its
 * newest run from any session, from outside Studio or from its results.json,
 * and the card a page action works on, made in a new session when none has one.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ActionResult } from "ue-mcp/daemon";
import { playtestMatches, qaDraftId, type PlaytestEntry } from "@ue-mcp-studio/shared";
import { SessionStore } from "../src/sessions.js";
import { QaBroker, type QaHost } from "../src/qa.js";
import { PlaytestIndex, registerPlaytestIndex } from "../src/playtest-index.js";
import type { AgentHost } from "../src/tools.js";

const ok = (body: Record<string, unknown>): ActionResult => ({ isError: false, content: [{ type: "text", text: JSON.stringify({ success: true, ...body }) }] });
const fail = (error: string): ActionResult => ({ isError: false, content: [{ type: "text", text: JSON.stringify({ success: false, error }) }] });

const DOOR = "/Game/Tests/DoorOpens";
const JUMP = "/Game/Tests/JumpCheck";
const NEW = "/Game/Tests/NeverRun";
const steps = (statuses: string[]) => statuses.map((status, index) => ({ index, instruction: `Step ${index + 1}`, judge: index === statuses.length - 1 ? "manual" : "auto", status }));
const runAnswer = (runId: string, script: string, state: string, statuses: string[], awaiting: number[] = []) =>
  ({ run_id: runId, script, script_name: script.split("/").pop(), state, steps: steps(statuses), awaiting, last_seq: 1 });

let root: string;
let store: SessionStore;
let calls: Array<{ action: string; args: Record<string, unknown> }>;
let published: Array<{ type: string; data?: Record<string, unknown> }>;
let connected: boolean;
let listed: string[];
let clock: number;
let next: Record<string, unknown> | null;
/** How the bridge answers pie(script_runs); null answers as a bridge with no such action does not, with an empty success. */
let scriptRuns: ActionResult | null;
/** The daemon's actions.effects list, or undefined for a daemon without the feature. */
let effects: Array<{ category: string; action: string }> | undefined;

const host = (): QaHost & AgentHost => ({
  projectDir: path.join(root, "project"),
  dataDir: path.join(root, "data"),
  callAction: async (_category: string, action: string, args: Record<string, unknown> = {}) => {
    calls.push({ action, args });
    if (action === "script_list") return ok({ scripts: listed.map((p) => ({ path: p, object_path: `${p}.${p.split("/").pop()}`, name: p.split("/").pop() })), count: listed.length });
    if (action === "script_read") {
      const p = String(args.path);
      return listed.includes(p) ? ok({ path: p, name: p.split("/").pop(), default_within_ms: 5000, steps: [{ instruction: "Look", judge: "manual" }, { instruction: "Move", judge: "auto", expect: { value: "Speed", op: "gt", target: 0 } }] }) : fail(`no script at ${p}`);
    }
    if (action === "script_run" && next) return ok(next);
    if (action === "script_runs" && scriptRuns) return scriptRuns;
    return ok({});
  },
  ...(effects ? { actions: { effects: () => effects! } } : {}),
  editors: () => [{ connected, name: "P", port: 1, pid: 1, lastDisconnect: null }],
  editorOperation: async (op: string) => ({ op, steps: [] }),
  events: { publish: (type: string, data?: Record<string, unknown>) => void published.push({ type, data }), subscribe: () => () => {} },
  setBusy: () => {},
  log: { info() {}, warn() {} },
}) as unknown as QaHost & AgentHost;

/** A results.json under Saved/MCPObservations, as ue-mcp writes one. */
function results(runId: string, script: string, state: string, statuses: string[], startedAt: string): void {
  const dir = path.join(root, "project", "Saved", "MCPObservations", runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "results.json"), JSON.stringify({ version: 1, ...runAnswer(runId, script, state, statuses), started_at: startedAt, results_path: path.join(dir, "results.json") }));
}

function setup() {
  const h = host();
  const broker = new QaBroker({ host: h, store, now: () => new Date(clock++ * 60_000).toISOString() });
  const index = new PlaytestIndex({ host: h, broker, store, now: () => clock * 60_000 });
  /** A run the session starts, through its own call. */
  const run = async (sessionId: string, answer: Record<string, unknown>) => {
    next = answer;
    await broker.wrap(h, sessionId).callAction("pie", "script_run", { script: answer.script });
  };
  return { h, broker, index, run };
}
const entry = (all: PlaytestEntry[], script: string) => all.find((e) => e.script === script);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-index-"));
  store = new SessionStore(path.join(root, "data"));
  calls = [];
  published = [];
  connected = true;
  listed = [DOOR, JUMP, NEW];
  clock = 1;
  next = null;
  scriptRuns = null;
  effects = undefined;
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("the project's playtests", () => {
  it("lists every script the editor has, each with its newest run, the session it is in, and the steps of one that never ran", async () => {
    const { index, run } = setup();
    const a = store.create("Doors");
    const b = store.create("Jumping");
    await run(a.id, runAnswer("door_1", DOOR, "finished", ["passed", "failed", "passed"]));
    await run(b.id, runAnswer("door_2", DOOR, "finished", ["passed", "passed", "passed"]));
    await run(b.id, runAnswer("jump_1", JUMP, "awaiting_verdict", ["passed", "awaiting_verdict"], [1]));

    const r = await index.index();
    expect(r.listed).toBe(true);
    // Needs the user first, then the newest run, then the scripts that never ran.
    expect(r.playtests.map((e) => e.name)).toEqual(["JumpCheck", "DoorOpens", "NeverRun"]);
    expect(entry(r.playtests, DOOR)).toMatchObject({ last: { runId: "door_2" }, card: { runId: "door_2" }, session: { id: b.id, title: "Jumping" } });
    const fresh = entry(r.playtests, NEW)!;
    expect(fresh).toMatchObject({ last: null, card: null, session: null, draft: { state: "draft", scriptName: "NeverRun", sessionId: null } });
    expect(fresh.draft!.steps.map((s) => s.judge)).toEqual(["manual", "auto"]);
    expect(calls.find((c) => c.action === "script_list")?.args).toEqual({ directory: "/" });
  });

  it("filters to what needs the user and what is failing", async () => {
    const { index, run } = setup();
    const s = store.create("S");
    await run(s.id, runAnswer("door_1", DOOR, "finished", ["passed", "failed", "passed"]));
    await run(s.id, runAnswer("jump_1", JUMP, "awaiting_verdict", ["passed", "awaiting_verdict"], [1]));
    const all = (await index.index()).playtests;
    expect(all.filter((e) => playtestMatches(e, "needs-you")).map((e) => e.name)).toEqual(["JumpCheck"]);
    expect(all.filter((e) => playtestMatches(e, "failing")).map((e) => e.name)).toEqual(["DoorOpens"]);
    expect(all.filter((e) => playtestMatches(e, "all"))).toHaveLength(3);
  });

  it("shows a live run over a newer finished one", async () => {
    const { index, run } = setup();
    const s = store.create("S");
    await run(s.id, runAnswer("jump_live", JUMP, "running", ["running", "pending"]));
    await run(s.id, runAnswer("jump_done", JUMP, "finished", ["passed", "passed"]));
    expect(entry((await index.index()).playtests, JUMP)!.last!.runId).toBe("jump_live");
  });

  it("reads runs started outside Studio from their results.json, Studio's own copy winning", async () => {
    const { index, run } = setup();
    const s = store.create("S");
    await run(s.id, runAnswer("door_1", DOOR, "finished", ["passed", "passed", "passed"]));
    results("door_1", DOOR, "finished", ["failed", "failed", "failed"], "2026-10-25T00:00:00.000Z");
    results("jump_outside", JUMP, "finished", ["passed", "failed"], "2026-10-25T01:00:00.000Z");
    results("inline_x", "inline", "finished", ["passed"], "2026-10-25T02:00:00.000Z");
    const r = await index.index();
    expect(entry(r.playtests, DOOR)!.last).toMatchObject({ runId: "door_1", sessionId: s.id, summary: { failed: 0 } });
    const jump = entry(r.playtests, JUMP)!;
    expect(jump).toMatchObject({ last: { runId: "jump_outside", sessionId: null, seenAt: "2026-10-25T01:00:00.000Z" }, card: null, session: null });
    expect(r.playtests.some((e) => e.script === "inline")).toBe(false);
  });

  it("takes the runs ue-mcp lists with pie(script_runs) when the bridge has it, over the results files", async () => {
    const { index } = setup();
    results("jump_file", JUMP, "finished", ["failed", "failed"], "2026-10-25T00:00:00.000Z");
    scriptRuns = ok({ runs: [
      { ...runAnswer("jump_listed", JUMP, "finished", ["passed", "failed"]), started_at: "2026-10-25T03:00:00.000Z", results_path: "C:/P/Saved/MCPObservations/jump_listed/results.json", live: false },
      { ...runAnswer("door_live", `${DOOR}.DoorOpens`, "awaiting_verdict", ["passed", "passed", "awaiting_verdict"], [2]), started_at: "2026-10-25T04:00:00.000Z", live: true },
      { run_id: "inline_1", state: "finished", steps: [], started_at: "2026-10-25T05:00:00.000Z" },
    ], count: 3, total: 3 });
    const r = await index.index();
    expect(calls.find((c) => c.action === "script_runs")?.args).toEqual({ limit: 300 });
    expect(entry(r.playtests, JUMP)!.last).toMatchObject({ runId: "jump_listed", seenAt: "2026-10-25T03:00:00.000Z", resultsPath: "C:/P/Saved/MCPObservations/jump_listed/results.json", sessionId: null });
    expect(entry(r.playtests, DOOR)!.last).toMatchObject({ runId: "door_live", state: "awaiting_verdict" });
    expect(r.playtests.map((e) => e.name)[0]).toBe("DoorOpens");
    expect(r.playtests.some((e) => e.script === "inline")).toBe(false);
    // The file's run is not listed: the action is the record.
    expect(JSON.stringify(r)).not.toContain("jump_file");
  });

  it("reads the results files when the bridge has no pie(script_runs), and leaves it alone for a while", async () => {
    const { index } = setup();
    results("jump_file", JUMP, "finished", ["passed", "failed"], "2026-10-25T01:00:00.000Z");
    scriptRuns = { isError: true, content: [{ type: "text", text: "Unknown action 'script_runs' for pie" }] };
    expect(entry((await index.index()).playtests, JUMP)!.last!.runId).toBe("jump_file");
    await index.index();
    expect(calls.filter((c) => c.action === "script_runs")).toHaveLength(1);
    clock += 6;
    await index.index();
    expect(calls.filter((c) => c.action === "script_runs")).toHaveLength(2);
  });

  it("does not call pie(script_runs) on a daemon whose actions lack it, nor without an editor", async () => {
    effects = [{ category: "pie", action: "script_list" }];
    const { index } = setup();
    results("jump_file", JUMP, "finished", ["passed", "failed"], "2026-10-25T01:00:00.000Z");
    expect(entry((await index.index()).playtests, JUMP)!.last!.runId).toBe("jump_file");
    expect(calls.some((c) => c.action === "script_runs")).toBe(false);
    effects = undefined;
    const fresh = setup().index;
    connected = false;
    expect(entry((await fresh.index()).playtests, JUMP)!.last!.runId).toBe("jump_file");
    expect(calls.some((c) => c.action === "script_runs")).toBe(false);
  });

  it("keeps a script the editor no longer lists while it has runs, marked deleted, and drops a deleted draft alone", async () => {
    const { index, broker, run } = setup();
    const s = store.create("S");
    await run(s.id, runAnswer("door_1", DOOR, "finished", ["passed", "passed", "passed"]));
    await broker.drafted(s.id, { path: "/Game/Tests/Gone", name: "Gone", steps: [{ instruction: "x", judge: "manual" }] });
    await broker.wrap(host(), s.id).callAction("pie", "script_delete", { path: "/Game/Tests/Gone", confirm: true });
    listed = [JUMP];
    const r = await index.index({ fresh: true });
    expect(entry(r.playtests, DOOR)).toMatchObject({ deleted: true, last: { runId: "door_1" } });
    expect(entry(r.playtests, "/Game/Tests/Gone")).toBeUndefined();
  });

  it("lists the runs it has when the editor is not there to list scripts", async () => {
    const { index, run } = setup();
    const s = store.create("S");
    await run(s.id, runAnswer("door_1", DOOR, "finished", ["passed", "passed", "passed"]));
    connected = false;
    const r = await index.index({ fresh: true });
    expect(r.listed).toBe(false);
    expect(r.playtests.map((e) => e.name)).toEqual(["DoorOpens"]);
    expect(entry(r.playtests, DOOR)!.deleted).toBeUndefined();
  });

  it("asks the editor for its scripts again only after a while, or when asked fresh", async () => {
    const { index } = setup();
    await index.index();
    await index.index();
    expect(calls.filter((c) => c.action === "script_list")).toHaveLength(1);
    await index.index({ fresh: true });
    expect(calls.filter((c) => c.action === "script_list")).toHaveLength(2);
    clock += 1;
    await index.index();
    expect(calls.filter((c) => c.action === "script_list")).toHaveLength(3);
  });
});

describe("the card a page action works on", () => {
  it("is the newest run or draft a session has", async () => {
    const { index, run } = setup();
    const s = store.create("S");
    await run(s.id, runAnswer("door_1", DOOR, "finished", ["passed", "passed", "passed"]));
    expect(await index.card({ script: `${DOOR}.DoorOpens` })).toMatchObject({ run: { runId: "door_1", sessionId: s.id } });
    expect(calls.some((c) => c.action === "script_read")).toBe(false);
  });

  it("is a draft in a new session named for the playtest when no session has the script", async () => {
    const { index } = setup();
    const before = store.all().length;
    const r = await index.card({ script: NEW });
    expect(r).toMatchObject({ run: { runId: qaDraftId(NEW), state: "draft", scriptName: "NeverRun" } });
    const run = "run" in r ? r.run : null;
    const session = store.get(run!.sessionId!)!;
    expect(store.all().length).toBe(before + 1);
    expect(session.title).toBe("Playtest NeverRun");
    expect(session.transcript.filter((t) => t.kind === "qa")).toHaveLength(1);
    expect(published.some((p) => p.type === "session.changed" && p.data?.sessionId === session.id)).toBe(true);
    // The second ask finds that card.
    expect(await index.card({ script: NEW })).toMatchObject({ run: { runId: qaDraftId(NEW), sessionId: session.id } });
    expect(store.all().length).toBe(before + 1);
  });

  it("takes a run started outside Studio into a session of its own", async () => {
    const { index } = setup();
    results("jump_outside", JUMP, "finished", ["passed", "failed"], "2026-10-25T01:00:00.000Z");
    const r = await index.card({ script: JUMP });
    expect(r).toMatchObject({ run: { state: "draft", script: JUMP } });
  });

  it("says why it cannot be made", async () => {
    const { index } = setup();
    expect(await index.card({})).toMatchObject({ status: 400 });
    expect(await index.card({ script: "/Game/Tests/Nope" })).toMatchObject({ status: 409, error: expect.stringContaining("could not be read") });
    connected = false;
    expect(await index.card({ script: NEW })).toMatchObject({ status: 409, error: expect.stringContaining("not connected") });
  });
});

describe("the routes", () => {
  it("answer GET /qa/playtests and POST /qa/playtests/card", async () => {
    const { index } = setup();
    const routes = new Map<string, (req: { body?: unknown; query?: unknown; params: Record<string, string> }) => unknown>();
    registerPlaytestIndex({ route: (method: string, p: string, h: never) => void routes.set(`${method} ${p}`, h) } as never, index);
    const list = (await routes.get("GET /qa/playtests")!({ query: { fresh: "1" }, params: {} })) as { body: { playtests: PlaytestEntry[]; listed: boolean } };
    expect(list.body.listed).toBe(true);
    expect(list.body.playtests).toHaveLength(3);
    const bad = (await routes.get("POST /qa/playtests/card")!({ body: {}, params: {} })) as { status: number; body: { error: string } };
    expect(bad.status).toBe(400);
    const card = (await routes.get("POST /qa/playtests/card")!({ body: { script: DOOR }, params: {} })) as { body: { run: { runId: string } } };
    expect(card.body.run.runId).toBe(qaDraftId(DOOR));
  });
});

describe("Stop on a live card", () => {
  it("ends the run with pie(script_stop) and answers with the run read again", async () => {
    const { broker, run } = setup();
    const s = store.create("S");
    await run(s.id, runAnswer("jump_live", JUMP, "running", ["running", "pending"]));
    next = null;
    const r = await broker.stopRun("jump_live");
    expect(calls.find((c) => c.action === "script_stop")?.args).toEqual({ run_id: "jump_live", reason: "Stopped from its card" });
    expect(calls.some((c) => c.action === "script_status")).toBe(true);
    expect(r).toMatchObject({ run: { runId: "jump_live" } });
  });

  it("refuses a run that ended, a draft, and one a subagent runs", async () => {
    const { broker, run } = setup();
    const s = store.create("S");
    await run(s.id, runAnswer("done", JUMP, "finished", ["passed", "passed"]));
    expect(await broker.stopRun("done")).toMatchObject({ status: 409 });
    const draft = await broker.drafted(s.id, { path: DOOR, name: "DoorOpens", steps: [{ instruction: "x", judge: "manual" }] });
    expect(await broker.stopRun(draft!.runId)).toMatchObject({ status: 409 });
    await run(s.id, runAnswer("looped", NEW, "running", ["running", "pending"]));
    broker.get("looped")!.assignment = { callId: "c", sessionId: s.id, state: "running", at: "" };
    expect(await broker.stopRun("looped")).toMatchObject({ status: 409, error: expect.stringContaining("cancel") });
    expect(calls.some((c) => c.action === "script_stop")).toBe(false);
  });
});

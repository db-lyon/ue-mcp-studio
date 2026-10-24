/**
 * Assign to subagent: the brief a playtest subagent gets, the runner starting
 * it beside the session's turns, and the broker keeping the card's assignment.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ActionResult, EditorStatus } from "ue-mcp/daemon";
import { qaApplyVerdictAnswer, qaAssignable, qaRunFromAnswer, type QaRun } from "@ue-mcp-studio/shared";
import { AgentRunner } from "../src/runner.js";
import { SessionStore } from "../src/sessions.js";
import { QaBroker, type QaAssigner, type QaHost } from "../src/qa.js";
import { playtestBrief, playtestDescription } from "../src/playtest-brief.js";
import type { ModelProvider, ModelRequest, ModelTurn } from "../src/providers.js";
import type { AgentHost } from "../src/tools.js";

const RUN = "script_DoorOpens_20261023_100000";
const STEPS = [
  { index: 0, instruction: "Walk up to the door", judge: "auto", expect: { value: "Door.Distance", op: "decreasing", within_ms: 3000 }, status: "pending", within_ms: 3000 },
  { index: 1, instruction: "The door opens without a visible pop", judge: "manual", status: "pending", within_ms: 5000 },
  { index: 2, instruction: "The door sound feels right", judge: "manual", agent_judgeable: false, status: "pending", within_ms: 5000 },
];
const answer = (over: Record<string, unknown> = {}) => ({
  success: true, run_id: RUN, script: "/Game/PIEStudio/Scripts/DoorOpens", script_name: "DoorOpens", state: "running", steps: STEPS, awaiting: [], last_seq: 3, recording_id: RUN, ...over,
});
const runOf = (over: Record<string, unknown> = {}, sessionId: string | null = "s1"): QaRun => qaRunFromAnswer(answer(over), { sessionId, seenAt: "2026-10-23T15:00:00.000Z" })!;

describe("the playtest brief", () => {
  it("names the run and every step, and which manual steps the subagent judges", () => {
    const b = playtestBrief(runOf());
    expect(b).toContain(RUN);
    expect(b).toMatch(/0\. \[auto\] Walk up to the door\. Expect Door\.Distance decreasing within 3000 ms/);
    expect(b).toMatch(/1\. \[manual, you judge it\]/);
    expect(b).toMatch(/2\. \[manual, the user judges it\]/);
    expect(b).toMatch(/Steps 2 are the user's to judge: never give them a verdict/);
  });

  it("asks for agent verdicts with frames and a note as evidence", () => {
    const b = playtestBrief(runOf());
    expect(b).toMatch(/editor\.capture_screenshot \(target "pie"\)/);
    expect(b).toMatch(/source: "agent"/);
    expect(b).toMatch(/evidence: \{ note, captures \}/);
    expect(b).toMatch(/note says what you saw in the frames \(it must not be empty\)/);
    expect(b).toMatch(/captures are the capture file paths/);
  });

  it("drives the pawn from the recording when there is one, by injected input otherwise", () => {
    expect(playtestBrief(runOf())).toMatch(new RegExp(`pie\\.replay_arm \\(recording_id ${RUN}\\)`));
    const none = playtestBrief(runOf({ recording_id: undefined }));
    expect(none).not.toMatch(/replay_arm/);
    expect(none).toMatch(/pie\.inject_input_tape/);
  });

  it("runs an ended playtest again without waiting, since it has to drive input while it runs", () => {
    const b = playtestBrief(runOf({ state: "finished", steps: STEPS.map((s) => ({ ...s, status: s.index === 0 ? "failed" : "awaiting_verdict" })) }));
    expect(b).toMatch(/Run it again with pie\.script_run with script "\/Game\/PIEStudio\/Scripts\/DoorOpens", start_pie: true and wait: false/);
    expect(b).toMatch(/Never pass wait: true/);
  });

  it("is titled by the script", () => {
    expect(playtestDescription(runOf())).toBe("Playtest DoorOpens");
  });
});

describe("a playtest's agent verdicts in the run model", () => {
  it("reads agent_judgeable and keeps a person-only step out of the subagent's work", () => {
    const run = runOf();
    expect(run.steps[2].agentJudgeable).toBe(false);
    expect(run.steps[1].agentJudgeable).toBeUndefined();
    expect(qaAssignable(runOf({ steps: [STEPS[2]] }))).toBe(false);
    expect(qaAssignable(run)).toBe(true);
  });

  it("takes an agent verdict's source and evidence from the verdict answer", () => {
    const run = runOf({ state: "awaiting_verdict", steps: STEPS.map((s) => (s.index === 1 ? { ...s, status: "awaiting_verdict" } : s)) });
    const next = qaApplyVerdictAnswer(run, {
      success: true, run_id: RUN, step: 1, status: "passed", verdict: "pass", verdict_source: "agent", note: "No pop across 12 frames",
      evidence: { note: "No pop across 12 frames", captures: ["C:/P/Saved/Screenshots/door_01.png"] }, state: "running", awaiting: [],
    });
    expect(next.steps[1]).toMatchObject({ status: "passed", verdictSource: "agent", evidence: { captures: ["C:/P/Saved/Screenshots/door_01.png"] } });
  });
});

// ── The runner ───────────────────────────────────────────────────────

class FakeHost implements AgentHost {
  connected = true;
  calls: Array<{ category: string; action: string; args?: Record<string, unknown> }> = [];
  published: Array<{ type: string; data?: Record<string, unknown> }> = [];
  busy: () => boolean = () => false;
  gate: Promise<void> = Promise.resolve();
  log = { info() {}, warn() {} };
  events = { publish: (type: string, data?: Record<string, unknown>) => void this.published.push({ type, data }), subscribe: () => () => {} };
  constructor(public projectDir: string, public dataDir: string) {}
  async callAction(category: string, action: string, args?: Record<string, unknown>): Promise<ActionResult> {
    this.calls.push({ category, action, args });
    await this.gate;
    return { isError: false, content: [{ type: "text", text: JSON.stringify({ success: true, run_id: RUN, step: args?.step, status: "passed", verdict_source: args?.source }) }] };
  }
  editors(): EditorStatus[] {
    return [{ name: "P", connected: this.connected, port: 1, pid: 1, lastDisconnect: null }];
  }
  async editorOperation(op: string) {
    return { op, steps: [] };
  }
  setBusy(fn: () => boolean): void {
    this.busy = fn;
  }
}

class ScriptedModel implements ModelProvider {
  requests: ModelRequest[] = [];
  constructor(private readonly turns: Array<() => ModelTurn>) {}
  async run(req: ModelRequest): Promise<ModelTurn> {
    this.requests.push(JSON.parse(JSON.stringify(req)));
    const next = this.turns.shift();
    if (!next) throw new Error("script exhausted");
    return next();
  }
}

const verdictCall = (): ModelTurn => ({
  content: [{ type: "tool_use", id: "v1", name: "ue_mcp", input: { action: "call", category: "pie", method: "verdict", args: { run_id: RUN, step: 1, verdict: "pass", source: "agent", note: "No pop" } } } as never],
  stopReason: "tool_use",
});
const report = (t: string): ModelTurn => ({ content: [{ type: "text", text: t, citations: null } as never], stopReason: "end_turn" });

let root: string;
let host: FakeHost;
let store: SessionStore;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-playtest-"));
  host = new FakeHost(path.join(root, "project"), path.join(root, "data"));
  store = new SessionStore(host.dataDir);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("a subagent the user assigns", () => {
  it("runs as a subagent thread beside an idle session, and leaves its report for the agent's next turn", async () => {
    const model = new ScriptedModel([verdictCall, () => report("Step 1 passed: no pop.")]);
    const runner = new AgentRunner({ host, store, provider: () => model, model: () => "claude-opus-5-5" });
    const s = store.create();
    const { callId, done } = runner.assignSubagent(s.id, "Playtest DoorOpens", "the brief");
    expect(host.busy()).toBe(true);
    const r = await done;

    expect(r).toEqual({ text: "Step 1 passed: no pop.", isError: false });
    expect(model.requests[0].system[0].text).toContain("You are a subagent");
    expect(model.requests[0].messages[0]).toEqual({ role: "user", content: "the brief" });
    expect(host.calls).toEqual([{ category: "pie", action: "verdict", args: expect.objectContaining({ source: "agent", step: 1 }) }]);
    const fin = store.get(s.id)!;
    // The session itself never ran a turn.
    expect(fin.status).toBe("idle");
    expect(fin.messages).toEqual([]);
    const agent = fin.transcript.find((t) => t.kind === "tool" && t.call.id === callId);
    expect(agent).toMatchObject({ kind: "tool", call: { name: "agent", outcome: "done", input: { description: "Playtest DoorOpens" } } });
    expect(agent?.parent).toBeUndefined();
    expect(fin.transcript.filter((t) => t.parent === callId).map((t) => t.kind)).toEqual(["tool", "assistant"]);
    expect(fin.notes.join("\n")).toMatch(/Playtest DoorOpens[\s\S]*Step 1 passed: no pop\./);
    expect(host.busy()).toBe(false);
  });

  it("stops with stopSubagent, answering the call it left running", async () => {
    let release!: () => void;
    host.gate = new Promise((r) => (release = r));
    const model = new ScriptedModel([verdictCall, () => report("never")]);
    const runner = new AgentRunner({ host, store, provider: () => model, model: () => "claude-opus-5-5" });
    const s = store.create();
    const { callId, done } = runner.assignSubagent(s.id, "Playtest DoorOpens", "the brief");
    const end = Date.now() + 2000;
    while (host.calls.length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
    expect(runner.stopSubagent(s.id, callId)).toBe(true);
    const r = await done;
    release();
    expect(r.stopped).toBe(true);
    const fin = store.get(s.id)!;
    expect(fin.transcript.find((t) => t.kind === "tool" && t.call.id === callId)).toMatchObject({ call: { outcome: "stopped" } });
    expect(fin.transcript.filter((t) => t.kind === "tool" && t.parent === callId).every((t) => t.kind === "tool" && t.call.outcome !== "pending")).toBe(true);
    expect(fin.status).toBe("idle");
  });

  it("ends in the next daemon with what it was doing marked unknown", () => {
    const runner = new AgentRunner({ host, store, provider: () => new ScriptedModel([]), model: () => "m" });
    const s = store.create();
    s.transcript.push({ kind: "tool", call: { id: "studio_abc", name: "agent", input: { description: "Playtest DoorOpens", prompt: "p" }, outcome: "pending", startedAt: "2026-10-23T15:00:00.000Z" } });
    s.transcript.push({ kind: "tool", call: { id: "c1", name: "ue_mcp", input: {}, outcome: "pending", startedAt: "2026-10-23T15:00:00.000Z" }, parent: "studio_abc" });
    store.save(s);
    runner.recover();
    const fin = store.get(s.id)!;
    expect(fin.transcript.map((t) => (t.kind === "tool" ? t.call.outcome : null))).toEqual(["unknown", "unknown"]);
  });
});

// ── The broker ───────────────────────────────────────────────────────

function brokerWith(assigner?: QaAssigner) {
  const qaHost: QaHost = {
    callAction: async () => ({ isError: false, content: [{ type: "text", text: "{}" }] }),
    editors: () => [],
    events: { publish: () => undefined, subscribe: () => () => {} },
    projectDir: host.projectDir,
    log: { warn() {} },
  };
  return new QaBroker({ host: qaHost, store, assigner, now: () => "2026-10-23T15:01:00.000Z" });
}

describe("the card's assignment", () => {
  it("starts the subagent with the brief, shows it running, and records how it ended", async () => {
    const s = store.create();
    s.transcript.push({ kind: "qa", run: runOf({}, s.id) });
    store.save(s);
    let finish!: (r: { isError: boolean; stopped?: boolean }) => void;
    const asked: Array<{ sessionId: string; description: string; prompt: string }> = [];
    const broker = brokerWith({
      assign: (sessionId, description, prompt) => {
        asked.push({ sessionId, description, prompt });
        return { callId: "studio_1", done: new Promise((r) => (finish = r)) };
      },
      stop: () => true,
    });
    const r = broker.assign(RUN, {});
    expect("run" in r && r.run.assignment).toEqual({ callId: "studio_1", sessionId: s.id, state: "running", at: "2026-10-23T15:01:00.000Z" });
    expect(asked[0]).toMatchObject({ sessionId: s.id, description: "Playtest DoorOpens" });
    expect(asked[0].prompt).toContain(RUN);
    expect(broker.assign(RUN, {})).toMatchObject({ status: 409 });
    finish({ isError: false });
    await new Promise((r) => setTimeout(r, 0));
    expect(broker.get(RUN)?.assignment?.state).toBe("done");
    const saved = store.get(s.id)!.transcript.find((t) => t.kind === "qa");
    expect(saved?.kind === "qa" && saved.run.assignment?.state).toBe("done");
  });

  it("cancels through the runner's stop", () => {
    const s = store.create();
    s.transcript.push({ kind: "qa", run: runOf({}, s.id) });
    store.save(s);
    const stopped: string[] = [];
    const broker = brokerWith({ assign: () => ({ callId: "studio_2", done: new Promise(() => {}) }), stop: (_sid, id) => (stopped.push(id), true) });
    broker.assign(RUN, {});
    expect("run" in broker.cancel(RUN)).toBe(true);
    expect(stopped).toEqual(["studio_2"]);
  });

  it("runs a playtest started elsewhere in the session the user has open", () => {
    const s = store.create();
    const broker = brokerWith({ assign: () => ({ callId: "studio_3", done: new Promise(() => {}) }), stop: () => true });
    (broker as unknown as { runs: Map<string, QaRun> }).runs.set(RUN, runOf({}, null));
    expect(broker.assign(RUN, {})).toMatchObject({ status: 400 });
    const r = broker.assign(RUN, { sessionId: s.id });
    expect("run" in r && r.run.assignment?.sessionId).toBe(s.id);
  });

  it("finds an assignment from an earlier daemon stopped", () => {
    const s = store.create();
    s.transcript.push({ kind: "qa", run: { ...runOf({}, s.id), assignment: { callId: "studio_4", sessionId: s.id, state: "running", at: "x" } } });
    store.save(s);
    expect(brokerWith().get(RUN)?.assignment?.state).toBe("stopped");
  });
});

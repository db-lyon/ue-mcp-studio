/**
 * Assign to subagent: the brief a playtest subagent gets, the runner starting
 * it beside the session's turns, and the broker keeping the card's assignment.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { qaApplyVerdictAnswer, qaAssignable, qaRunFromAnswer, type QaRun } from "@ue-mcp-studio/shared";
import { SessionStore } from "../src/sessions.js";
import { QaBroker, type QaAssigner, type QaHost } from "../src/qa.js";
import { playtestBrief, playtestDescription } from "../src/playtest-brief.js";
import { runHarness } from "../src/durable/harness-main.js";
import { fakeLoopSupport, type FakeLoopSupport } from "./loop-fakes.js";
import { FakeHost, durableRunner, until, type DurableRig } from "./durable/helpers.js";
import { startFakeAnthropic, type FakeAnthropic, type FakeTurn } from "./durable/fake-anthropic.js";

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
    expect(b).toMatch(/editor\.capture_screenshot \(target "pie", on the step's player\)/);
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
    // A person's override clears the agent's evidence and note.
    const overridden = qaApplyVerdictAnswer(next, { success: true, run_id: RUN, step: 1, status: "failed", verdict: "fail", verdict_source: "action", state: "running", awaiting: [] });
    expect(overridden.steps[1]).toMatchObject({ status: "failed", verdictSource: "action" });
    expect(overridden.steps[1].evidence).toBeUndefined();
    expect(overridden.steps[1].note).toBeUndefined();
  });
});

// ── The runner ───────────────────────────────────────────────────────

const verdictCall = (): FakeTurn => ({
  tool: { id: "v1", name: "ue_mcp", input: { action: "call", category: "pie", method: "verdict", args: { run_id: RUN, step: 1, verdict: "pass", source: "agent", note: "No pop" } } },
});
const report = (t: string): FakeTurn => ({ text: t });

let root: string;
let host: FakeHost;
let store: SessionStore;
/** Holds every pie call until the test lets it go. */
let gate: Promise<void>;
let fake: FakeAnthropic | null;
let harness: { close(): Promise<void> } | null;
let rigs: DurableRig[];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-playtest-"));
  fs.mkdirSync(path.join(root, "project"), { recursive: true });
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  host = new FakeHost(path.join(root, "project"), path.join(root, "data"));
  gate = Promise.resolve();
  host.handler = async (category, action, args) => {
    if (category === "editor" && action === "list_dirty_packages") return { isError: false, content: [{ type: "text", text: "{\"success\":true,\"content\":[]}" }] };
    await gate;
    return { isError: false, content: [{ type: "text", text: JSON.stringify({ success: true, run_id: RUN, step: args?.step, status: "passed", verdict_source: args?.source }) }] };
  };
  store = new SessionStore(host.dataDir);
  fake = null;
  harness = null;
  rigs = [];
});
afterEach(async () => {
  for (const r of rigs) r.runner.dispose();
  await harness?.close();
  await fake?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** A runner on the durable harness whose subagent makes the verdict call, then reports `text`. */
async function rigWith(text: string, h = host, s = store): Promise<DurableRig> {
  fake ??= await startFakeAnthropic(({ toolResults }) => (toolResults === 0 ? verdictCall() : report(text)));
  const rig = durableRunner({
    projectDir: h.projectDir,
    dataDir: h.dataDir,
    base: fake.base,
    host: h,
    store: s,
    start: async (launch) => {
      harness ??= await runHarness(launch);
    },
  });
  rigs.push(rig);
  return rig;
}
const pieCalls = (h: FakeHost) => h.calls.filter((c) => c.category === "pie");

describe("a subagent the user assigns", () => {
  it("runs as a subagent thread beside an idle session, and leaves its report for the agent's next turn", async () => {
    const { runner } = await rigWith("Step 1 passed: no pop.");
    const s = store.create();
    const { callId, done } = runner.assignSubagent(s.id, "Playtest DoorOpens", "the brief");
    expect(host.busy()).toBe(true);
    const r = await done;

    expect(r).toEqual({ text: "Step 1 passed: no pop.", isError: false });
    expect(fake!.requests[0].system).toContain("You are a subagent");
    expect(JSON.stringify(fake!.requests[0].messages[0])).toContain("the brief");
    expect(fake!.requests[0].messages[0].role).toBe("user");
    expect(pieCalls(host)).toEqual([{ category: "pie", action: "verdict", args: expect.objectContaining({ source: "agent", step: 1 }) }]);
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
  }, 60_000);

  it("stops with stopSubagent, answering the call it left running", async () => {
    let release!: () => void;
    gate = new Promise((r) => (release = r));
    const { runner } = await rigWith("never");
    const s = store.create();
    const { callId, done } = runner.assignSubagent(s.id, "Playtest DoorOpens", "the brief");
    await until(() => pieCalls(host).length > 0, 30_000, "the subagent's call");
    expect(runner.stopSubagent(s.id, callId)).toBe(true);
    const r = await done;
    release();
    expect(r.stopped).toBe(true);
    const fin = store.get(s.id)!;
    expect(fin.transcript.find((t) => t.kind === "tool" && t.call.id === callId)).toMatchObject({ call: { outcome: "stopped" } });
    expect(fin.transcript.filter((t) => t.kind === "tool" && t.parent === callId).every((t) => t.kind === "tool" && t.call.outcome !== "pending")).toBe(true);
    expect(fin.status).toBe("idle");
  }, 60_000);

  it("goes on in the next daemon with the call it was making marked unknown, never run twice", async () => {
    let release!: () => void;
    gate = new Promise((r) => (release = r));
    const first = await rigWith("Step 1: checked after the restart.");
    const s = store.create();
    const { callId } = first.runner.assignSubagent(s.id, "Playtest DoorOpens", "the brief");
    await until(() => pieCalls(host).length > 0, 30_000, "the subagent's call");
    // The daemon goes down mid-call; the harness keeps the subagent.
    first.runner.dispose();
    store.flush();
    const store2 = new SessionStore(host.dataDir);
    const next = await rigWith("Step 1: checked after the restart.", host, store2);
    next.runner.recover();
    const agentCall = () => store2.get(s.id)!.transcript.find((t) => t.kind === "tool" && t.call.id === callId);
    await until(() => agentCall()?.kind === "tool" && (agentCall() as { call: { outcome: string } }).call.outcome !== "pending", 30_000, "the subagent to end in the next daemon");
    release();
    const fin = store2.get(s.id)!;
    expect(fin.transcript.find((t) => t.kind === "tool" && t.parent === callId)).toMatchObject({ call: { outcome: "unknown" } });
    expect(agentCall()).toMatchObject({ call: { outcome: "done", result: "Step 1: checked after the restart." } });
    expect(pieCalls(host)).toHaveLength(1);
    expect(fin.notes.join("\n")).toMatch(/Playtest DoorOpens[\s\S]*checked after the restart/);
  }, 60_000);
});

// ── The broker ───────────────────────────────────────────────────────

function brokerWith(assigner?: QaAssigner, loop: FakeLoopSupport | null = fakeLoopSupport()) {
  const qaHost: QaHost = {
    callAction: async () => ({ isError: false, content: [{ type: "text", text: "{}" }] }),
    editors: () => [],
    events: { publish: () => undefined, subscribe: () => () => {} },
    projectDir: host.projectDir,
    log: { warn() {} },
  };
  return new QaBroker({ host: qaHost, store, assigner, ...(loop ? { loop } : {}), now: () => "2026-10-23T15:01:00.000Z" });
}

describe("the card's assignment", () => {
  it("starts the loop's first attempt with the brief and shows it running on the card", async () => {
    const s = store.create();
    s.transcript.push({ kind: "qa", run: runOf({}, s.id) });
    store.save(s);
    const asked: Array<{ sessionId: string; description: string; prompt: string }> = [];
    const broker = brokerWith({
      assign: (sessionId, description, prompt) => {
        asked.push({ sessionId, description, prompt });
        return { callId: "studio_1", done: new Promise(() => {}) };
      },
      stop: () => true,
    });
    const r = await broker.assign(RUN, {});
    expect("run" in r && r.run.assignment).toMatchObject({ callId: "studio_1", sessionId: s.id, state: "running", loop: { state: "running", attempts: [{ n: 1, callId: "studio_1" }] } });
    expect(asked[0]).toMatchObject({ sessionId: s.id, description: "Playtest DoorOpens, attempt 1" });
    expect(asked[0].prompt).toContain(RUN);
    expect(asked[0].prompt).toMatch(/attempt 1 of a loop/);
    expect(await broker.assign(RUN, {})).toMatchObject({ status: 409 });
    const saved = store.get(s.id)!.transcript.find((t) => t.kind === "qa");
    expect(saved?.kind === "qa" && saved.run.assignment?.loop?.state).toBe("running");
  });

  it("cancels through the runner's stop", async () => {
    const s = store.create();
    s.transcript.push({ kind: "qa", run: runOf({}, s.id) });
    store.save(s);
    const stopped: string[] = [];
    const broker = brokerWith({ assign: () => ({ callId: "studio_2", done: new Promise(() => {}) }), stop: (_sid, id) => (stopped.push(id), true) });
    await broker.assign(RUN, {});
    expect("run" in broker.cancel(RUN)).toBe(true);
    expect(stopped).toEqual(["studio_2"]);
  });

  it("runs a playtest started elsewhere in the session the user has open", async () => {
    const s = store.create();
    const broker = brokerWith({ assign: () => ({ callId: "studio_3", done: new Promise(() => {}) }), stop: () => true });
    (broker as unknown as { runs: Map<string, QaRun> }).runs.set(RUN, runOf({}, null));
    expect(await broker.assign(RUN, {})).toMatchObject({ status: 400 });
    const r = await broker.assign(RUN, { sessionId: s.id });
    expect("run" in r && r.run.assignment?.sessionId).toBe(s.id);
  });

  it("does not start without the loop's checkpoints, and says why", async () => {
    const s = store.create();
    s.transcript.push({ kind: "qa", run: runOf({}, s.id) });
    store.save(s);
    const started: string[] = [];
    const broker = brokerWith({ assign: () => (started.push("x"), { callId: "x", done: new Promise(() => {}) }), stop: () => true }, null);
    expect(await broker.assign(RUN, {})).toMatchObject({ status: 409, error: expect.stringMatching(/needs checkpoints/) });
    expect(started).toEqual([]);
  });

  it("finds an assignment from an earlier daemon stopped, its loop too", () => {
    const s = store.create();
    const loop = { id: "l1", state: "running" as const, attempts: [], baseline: "b", startedAt: "x" };
    s.transcript.push({ kind: "qa", run: { ...runOf({}, s.id), assignment: { callId: "studio_4", sessionId: s.id, state: "running", at: "x", loop } } });
    store.save(s);
    const a = brokerWith().get(RUN)?.assignment;
    expect(a?.state).toBe("stopped");
    expect(a?.loop?.state).toBe("stopped");
  });
});

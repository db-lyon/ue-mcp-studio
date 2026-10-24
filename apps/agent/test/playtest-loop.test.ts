/**
 * Assign to subagent as a loop, against a faked daemon: pie answers the test
 * controls, checkpoints over a fake shadow history, and a fake subagent per
 * attempt that changes files, runs the playtest and reports. Every hard
 * blocker in #43 has a case, as do passing, Cancel and the reverts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ActionResult } from "ue-mcp/daemon";
import { PLAYTEST_RUNS_REFUSAL, qaRunFromAnswer, type QaLoop, type QaRun, type TranscriptEntry } from "@ue-mcp-studio/shared";
import { SessionStore } from "../src/sessions.js";
import { QaBroker, type QaAssigner, type QaHost } from "../src/qa.js";
import { decide, failingSteps, firstBrief, fixBrief, reportedBlocker } from "../src/playtest-loop.js";
import { fakeLoopSupport, until, type FakeLoopSupport } from "./loop-fakes.js";
import type { AgentHost } from "../src/tools.js";

const SCRIPT = "/Game/PIEStudio/Scripts/DoorOpens";
const BASE = "script_DoorOpens_20261024_1000";
type StepState = { status: string; evidence?: Record<string, unknown>; verdict_source?: string; note?: string };
const STEPS = [
  { instruction: "Open the door", judge: "auto", expect: { value: "Door.OpenAngle", op: "gt", target: 80 } },
  { instruction: "The door opens smoothly", judge: "manual" },
];
const PERSON = { instruction: "The door sound feels right", judge: "manual", agent_judgeable: false };

const OPEN_FAIL: StepState = { status: "failed", evidence: { value: "Door.OpenAngle", at_start: 0, at_end: 0, samples: 40, reason: "Door.OpenAngle never went above 80" } };
const PASS: StepState = { status: "passed" };

let root: string;
let store: SessionStore;
let support: FakeLoopSupport;
let published: Array<{ type: string; data?: Record<string, unknown> }>;
let listeners: Array<(e: { type: string; data: Record<string, unknown> }) => void>;
/** Every run the fake editor has, as pie answers it. */
let runs: Map<string, Record<string, unknown>>;
let steps: Array<Record<string, unknown>>;
let runCount: number;
/** Every editor(show_notification) the broker sent, and how the fake bridge answers it. */
/** Bumped per test, so a fake attempt left running by an ended test does nothing. */
let generation = 0;
let toasts: Array<Record<string, unknown>>;
let toastAnswer: "ok" | "unknown" | "throw";

const ok = (body: Record<string, unknown>): ActionResult => ({ isError: false, content: [{ type: "text", text: JSON.stringify({ success: true, ...body }) }] });

function answerOf(runId: string, states: StepState[], state = "finished"): Record<string, unknown> {
  const s = steps.map((x, index) => ({ ...x, index, ...(states[index] ?? { status: "pending" }) }));
  return { run_id: runId, script: SCRIPT, script_name: "DoorOpens", state, steps: s, awaiting: s.filter((x) => x.status === "awaiting_verdict").map((x) => x.index), last_seq: 5 };
}

const host = (): QaHost & AgentHost => ({
  projectDir: path.join(root, "project"),
  dataDir: path.join(root, "data"),
  callAction: async (category: string, action: string, args: Record<string, unknown> = {}) => {
    if (category === "editor" && action === "show_notification") {
      toasts.push(args);
      if (toastAnswer === "throw") throw new Error("the editor went away");
      if (toastAnswer === "unknown") return { isError: true, content: [{ type: "text", text: "Unknown method: show_notification" }] };
      return ok({ onScreen: true });
    }
    if (action === "script_run") throw new Error("runs come from the fake subagent");
    if (action === "script_status" || action === "script_results") return ok(runs.get(String(args.run_id)) ?? {});
    if (action === "verdict") {
      const runId = String(args.run_id);
      const a = runs.get(runId)!;
      const status = args.verdict === "pass" ? "passed" : args.verdict === "fail" ? "failed" : "skipped";
      const next = { ...a, steps: (a.steps as Array<Record<string, unknown>>).map((x) => (x.index === args.step ? { ...x, status, verdict_source: "action" } : x)) };
      runs.set(runId, next);
      return ok({ run_id: runId, step: args.step, status, verdict: args.verdict, verdict_source: "action", state: "finished", awaiting: [] });
    }
    return ok({});
  },
  editors: () => [{ connected: true, name: "P", port: 1, pid: 1, lastDisconnect: null }],
  editorOperation: async (op: string) => ({ op }),
  events: {
    publish: (type: string, data?: Record<string, unknown>) => void published.push({ type, data }),
    subscribe: (l: (e: { type: string; data: Record<string, unknown> }) => void) => {
      listeners.push(l);
      return () => void (listeners = listeners.filter((x) => x !== l));
    },
  },
  setBusy: () => {},
  log: { info() {}, warn() {} },
}) as unknown as QaHost & AgentHost;

const emit = (type: string, data: Record<string, unknown>) => listeners.forEach((l) => l({ type, data }));

/** What one attempt's subagent does: change files, add tool calls, run the playtest with these step outcomes, and report. */
interface Attempt {
  files?: Record<string, string>;
  calls?: Array<{ name: string; input: Record<string, unknown>; result?: string; outcome?: "done" | "error" | "declined" }>;
  run?: StepState[] | null;
  runState?: string;
  events?: Array<{ type: string; data: Record<string, unknown> }>;
  report?: string;
  /** Never finish on its own: only a stop ends it. */
  hang?: boolean;
}

interface Harness {
  broker: QaBroker;
  sessionId: string;
  prompts: string[];
  stops: string[];
  tokens: Map<string, number>;
  card(): QaRun;
  loop(): QaLoop;
}

function setup(plan: Attempt[], opts: { steps?: Array<Record<string, unknown>>; first?: StepState[] } = {}): Harness {
  steps = opts.steps ?? STEPS;
  const h = host();
  // This test's store and generation: an attempt still running when the test ends must not write after it.
  const st = store;
  const gen = generation;
  const s = st.create();
  // The card: an ended run of the script, which the user assigns.
  const first = `${BASE}00`;
  runs.set(first, answerOf(first, opts.first ?? [OPEN_FAIL, PASS]));
  s.transcript.push({ kind: "qa", run: qaRunFromAnswer(runs.get(first), { sessionId: s.id, seenAt: "2026-10-24T09:00:00.000Z" })! });
  store.save(s);
  const broker = new QaBroker({ host: h, store, loop: support, now: () => "2026-10-24T10:00:00.000Z" });
  const assigned = broker.wrap(h, s.id, { assigned: true });
  const prompts: string[] = [];
  const stops: string[] = [];
  const tokens = new Map<string, number>();
  const stoppers = new Map<string, () => void>();
  let n = 0;
  const assigner: QaAssigner = {
    assign: (_sid, _description, prompt) => {
      const step = plan[n++] ?? { run: null, hang: true };
      const callId = `studio_${n}`;
      prompts.push(prompt);
      const done = new Promise<{ isError: boolean; stopped?: boolean; text?: string }>((resolve) => {
        stoppers.set(callId, () => resolve({ isError: true, stopped: true, text: "stopped" }));
        void (async () => {
          await new Promise((r) => setTimeout(r, 1));
          if (gen !== generation) return;
          for (const [p, v] of Object.entries(step.files ?? {})) support.cp.files.set(p, v);
          const live = st.get(s.id);
          if (!live) return;
          for (const [i, c] of (step.calls ?? []).entries()) {
            live.transcript.push({ kind: "tool", call: { id: `${callId}_c${i}`, name: c.name, input: c.input, outcome: c.outcome ?? "done", result: c.result, startedAt: "" }, parent: callId } as TranscriptEntry);
          }
          st.save(live);
          for (const e of step.events ?? []) emit(e.type, e.data);
          if (step.run) {
            runCount++;
            const runId = `${BASE}${String(runCount).padStart(2, "0")}`;
            runs.set(runId, answerOf(runId, step.run, step.runState));
            const orig = h.callAction;
            h.callAction = async (c, a, args) => (a === "script_run" ? ok(runs.get(runId)!) : orig(c, a, args));
            await assigned.callAction("pie", "script_run", { script: SCRIPT, start_pie: true });
            h.callAction = orig;
          }
          if (!step.hang) resolve({ isError: false, text: step.report ?? "Done." });
        })();
      });
      return { callId, done };
    },
    stop: (_sid, callId) => {
      stops.push(callId);
      stoppers.get(callId)?.();
      return true;
    },
    tokens: (callId) => tokens.get(callId) ?? 0,
  };
  broker.setAssigner(assigner);
  const card = () => store.get(s.id)!.transcript.flatMap((t) => (t.kind === "qa" ? [t.run] : [])).pop()!;
  return { broker, sessionId: s.id, prompts, stops, tokens, card, loop: () => card().assignment!.loop! };
}

const ended = (h: Harness) => until(() => !!h.card().assignment?.loop && h.loop().state !== "running");

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-loop-"));
  store = new SessionStore(path.join(root, "data"));
  support = fakeLoopSupport();
  support.cp.files.set("Content/BP_Door.uasset", "v1");
  published = [];
  listeners = [];
  runs = new Map();
  runCount = 0;
  toasts = [];
  toastAnswer = "ok";
  generation++;
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const assign = async (h: Harness) => {
  const r = await h.broker.assign(`${BASE}00`, {});
  if ("error" in r) throw new Error(r.error);
};

describe("the loop", () => {
  it("runs, fixes and runs again until every step passes, with each attempt's changes", async () => {
    const h = setup([
      { run: [OPEN_FAIL, PASS] },
      { files: { "Content/BP_Door.uasset": "v2" }, run: [PASS, PASS], report: "Fixed the hinge." },
    ]);
    await assign(h);
    await ended(h);
    const loop = h.loop();
    expect(loop.state).toBe("passed");
    expect(loop.attempts.map((a) => [a.n, a.changes.map((c) => c.path), a.failing.length])).toEqual([[1, [], 1], [2, ["Content/BP_Door.uasset"], 0]]);
    expect(h.card().runId).toBe(`${BASE}02`);
    expect(h.prompts[0]).toMatch(/only run the playtest/);
    expect(h.prompts[1]).toMatch(/attempt 2 of a loop/);
    expect(h.prompts[1]).toMatch(/Step 1 \(Open the door\) failed\. Expected Door\.OpenAngle gt 80/);
    expect(h.prompts[1]).toMatch(/Door\.OpenAngle never went above 80/);
    expect(support.marks.map((m) => m.mark.kind)).toEqual(["attempt", "attempt"]);
    expect(support.notified).toEqual([]);
    // One card throughout.
    expect(store.get(h.sessionId)!.transcript.filter((t) => t.kind === "qa")).toHaveLength(1);
  });

  it("works with steps the engine acts on, telling the subagent not to drive them", () => {
    steps = [{ ...STEPS[0], act: [{ goto: "Door" }, { inject_input: "IA_Interact" }] }];
    const run = qaRunFromAnswer(answerOf("r", [OPEN_FAIL]), { sessionId: "s", seenAt: "x" })!;
    expect(run.steps[0].act).toBeTruthy();
    const brief = firstBrief(run, { minutes: 5, tokens: 10 });
    expect(brief).toMatch(/the engine acts/);
    expect(brief).toMatch(/Steps 0 carry their own act/);
    expect(brief).toMatch(/No auto step needs you to drive the pawn/);
    steps = STEPS;
    expect(firstBrief(qaRunFromAnswer(answerOf("r", [OPEN_FAIL]), { sessionId: "s", seenAt: "x" })!, { minutes: 5, tokens: 10 })).toMatch(/pie\.inject_input/);
  });
});

describe("the hard blockers", () => {
  it("a person-only step with no verdict: Needs you, and the user's verdict passes the loop", async () => {
    const h = setup([{ run: [PASS, PASS, { status: "awaiting_verdict" }], runState: "awaiting_verdict" }], { steps: [...STEPS, PERSON], first: [OPEN_FAIL, PASS, { status: "awaiting_verdict" }] });
    await assign(h);
    await ended(h);
    expect(h.loop()).toMatchObject({ state: "needs_you", blocker: { kind: "verdict", step: 2 } });
    expect(h.loop().blocker!.reason).toMatch(/Step 3 needs your verdict/);
    expect(support.notified).toHaveLength(1);
    expect(published.find((p) => p.type === "qa.attention")?.data).toMatchObject({ sessionId: h.sessionId, runId: `${BASE}01`, text: expect.stringMatching(/^Playtest DoorOpens needs you: /) });
    await h.broker.verdict(`${BASE}01`, { step: 2, verdict: "pass" });
    expect(h.loop().state).toBe("passed");
    expect(h.loop().blocker).toBeUndefined();
  });

  it("shows the blocker as a warning toast in the editor, and carries on when the bridge cannot", async () => {
    for (const answer of ["ok", "unknown", "throw"] as const) {
      toasts = [];
      toastAnswer = answer;
      support.notified.length = 0;
      published = [];
      const h = setup([{ run: [PASS, PASS, { status: "awaiting_verdict" }], runState: "awaiting_verdict" }], { steps: [...STEPS, PERSON], first: [OPEN_FAIL, PASS, { status: "awaiting_verdict" }] });
      await assign(h);
      await ended(h);
      await until(() => toasts.length > 0);
      expect(h.loop().state).toBe("needs_you");
      expect(toasts).toEqual([{ text: h.loop().blocker!.reason, subText: "DoorOpens", severity: "warning" }]);
      // The primary signals are unaffected by how the toast went.
      expect(support.notified).toHaveLength(1);
      expect(published.filter((p) => p.type === "qa.attention")).toHaveLength(1);
    }
  });

  it("shows no toast for a loop that passes", async () => {
    const h = setup([{ run: [PASS, PASS] }]);
    await assign(h);
    await ended(h);
    expect(h.loop().state).toBe("passed");
    expect(toasts).toEqual([]);
  });

  it("no progress: the same step fails the same way on two attempts in a row after a change", async () => {
    const h = setup([{ run: [OPEN_FAIL, PASS] }, { files: { "Content/BP_Door.uasset": "v2" }, run: [OPEN_FAIL, PASS] }]);
    await assign(h);
    await ended(h);
    expect(h.loop()).toMatchObject({ state: "needs_you", blocker: { kind: "no_progress", step: 0 } });
    expect(h.loop().blocker!.reason).toBe("No progress: Step 1 fails the same way on two attempts in a row after a change.");
    expect(h.loop().blocker!.evidence[0]).toMatch(/never went above 80/);
    expect(support.notified).toHaveLength(1);
  });

  it("is progress when the failure changes, so the loop goes on", async () => {
    const other: StepState = { status: "failed", evidence: { value: "Door.OpenAngle", at_start: 0, at_end: 45, reason: "Door.OpenAngle never went above 80" } };
    const h = setup([{ run: [OPEN_FAIL, PASS] }, { files: { "Content/BP_Door.uasset": "v2" }, run: [other, PASS] }, { files: { "Content/BP_Door.uasset": "v3" }, run: [PASS, PASS] }]);
    await assign(h);
    await ended(h);
    expect(h.loop().state).toBe("passed");
    expect(h.loop().attempts).toHaveLength(3);
  });

  it("a step that contradicts the design or another step, as the subagent reports it", async () => {
    const h = setup([{ run: [OPEN_FAIL, PASS], report: "I looked.\nBLOCKED: contradiction: step 1 wants the door open, the level design keeps it locked" }]);
    await assign(h);
    await ended(h);
    expect(h.loop()).toMatchObject({ state: "needs_you", blocker: { kind: "contradiction" } });
    expect(h.loop().blocker!.reason).toBe("A step cannot be satisfied: step 1 wants the door open, the level design keeps it locked");
  });

  it("a call a guard refused", async () => {
    const h = setup([{ run: [OPEN_FAIL, PASS], calls: [{ name: "ue_mcp", input: { action: "call", category: "asset", method: "delete" }, result: JSON.stringify({ blocked: true, reason: "the path is on a protected mount" }), outcome: "error" }] }]);
    await assign(h);
    await ended(h);
    expect(h.loop()).toMatchObject({ state: "needs_you", blocker: { kind: "refused", reason: "A call was refused: asset.delete: the path is on a protected mount" } });
  });

  it("a run Playtest runs refused", async () => {
    const h = setup([{ run: null, calls: [{ name: "ue_mcp", input: { action: "call", category: "pie", method: "script_run" }, result: PLAYTEST_RUNS_REFUSAL, outcome: "error" }] }]);
    await assign(h);
    await ended(h);
    expect(h.loop().blocker?.kind).toBe("refused");
  });

  it("a change needed outside the project", async () => {
    const outside = path.join(root, "elsewhere", "Engine.ini");
    const h = setup([{ run: [OPEN_FAIL, PASS], calls: [{ name: "write_file", input: { path: outside, content: "x" } }] }]);
    await assign(h);
    await ended(h);
    expect(h.loop()).toMatchObject({ state: "needs_you", blocker: { kind: "outside_project", evidence: [outside] } });
  });

  it("the editor crashes twice in a row: the second crash stops the attempt at once", async () => {
    const crash = { type: "editor.disconnected", data: { cause: "crashed" } };
    const h = setup([{ run: [OPEN_FAIL, PASS], events: [crash] }, { events: [crash], hang: true }]);
    await assign(h);
    await ended(h);
    expect(h.loop()).toMatchObject({ state: "needs_you", blocker: { kind: "crashes", reason: "The editor crashed twice in a row." } });
    expect(h.stops).toEqual(["studio_2"]);
  });

  it("one crash then a clean attempt starts the count again", async () => {
    const crash = { type: "editor.disconnected", data: { cause: "crashed" } };
    const other: StepState = { status: "failed", evidence: { at_end: 10, reason: "x" } };
    const h = setup([{ run: [OPEN_FAIL, PASS], events: [crash] }, { run: [other, PASS], files: { a: "1" } }, { run: [PASS, PASS], events: [crash], files: { a: "2" } }]);
    await assign(h);
    await ended(h);
    expect(h.loop().state).toBe("passed");
  });

  it("a build fails twice in a row", async () => {
    const rebuild = { name: "editor_restart", input: { operation: "rebuild", reason: "C++" }, result: "the build failed", outcome: "error" as const };
    const other: StepState = { status: "failed", evidence: { at_end: 10, reason: "x" } };
    const h = setup([{ run: [OPEN_FAIL, PASS], calls: [rebuild] }, { run: [other, PASS], calls: [rebuild], files: { a: "1" } }]);
    await assign(h);
    await ended(h);
    expect(h.loop()).toMatchObject({ state: "needs_you", blocker: { kind: "builds", reason: "A build failed twice in a row." } });
  });

  it("a rebuild the daemon reports failed counts as a failed build", async () => {
    const failed = (at: number) => ({ type: "studio.busy.changed", data: { failure: { op: "rebuild", step: "build", reason: "compile error", at } } });
    const h = setup([{ run: [OPEN_FAIL, PASS], events: [failed(1)] }, { events: [failed(2)], hang: true }]);
    await assign(h);
    await ended(h);
    expect(h.loop().blocker).toMatchObject({ kind: "builds", evidence: ["compile error"] });
    expect(h.stops).toEqual(["studio_2"]);
  });

  it("the token budget is spent: the running attempt stops", async () => {
    support.budgetNow = { minutes: 60, tokens: 1000 };
    const h = setup([{ hang: true }]);
    await assign(h);
    h.tokens.set("studio_1", 1500);
    await ended(h);
    expect(h.loop()).toMatchObject({ state: "needs_you", blocker: { kind: "budget" } });
    expect(h.loop().blocker!.reason).toBe("The loop's token budget is spent: 1500 of 1000 tokens.");
    expect(h.stops).toEqual(["studio_1"]);
    expect(h.loop().tokens).toBe(1500);
  });

  it("the time budget is spent", async () => {
    let t = Date.parse("2026-10-24T10:00:00.000Z");
    support.now = () => t;
    support.budgetNow = { minutes: 30, tokens: 1_000_000 };
    const h = setup([{ hang: true }]);
    await assign(h);
    t += 31 * 60_000;
    await ended(h);
    expect(h.loop()).toMatchObject({ state: "needs_you", blocker: { kind: "budget", reason: "The loop's time budget is spent: 30 minutes." } });
  });
});

describe("Cancel and revert", () => {
  it("Cancel stops the loop at once and leaves the attempt's checkpoint restorable", async () => {
    const h = setup([{ files: { "Content/BP_Door.uasset": "v2" }, hang: true }]);
    await assign(h);
    await until(() => support.cp.files.get("Content/BP_Door.uasset") === "v2");
    expect("run" in h.broker.cancel(`${BASE}00`)).toBe(true);
    await ended(h);
    expect(h.stops).toEqual(["studio_1"]);
    const loop = h.loop();
    expect(loop.state).toBe("stopped");
    expect(loop.attempts[0].after).toBeTruthy();
    expect(loop.attempts[0].changes).toEqual([{ path: "Content/BP_Door.uasset", status: "modified" }]);
    const r = await h.broker.revertLoop(h.card().runId, { attempt: 1 });
    expect("outcome" in r && r.outcome.restored).toEqual(["Content/BP_Door.uasset"]);
    expect(support.cp.files.get("Content/BP_Door.uasset")).toBe("v1");
    expect(h.loop().attempts[0].reverted).toBe(true);
    expect(support.marks.at(-1)!.mark).toMatchObject({ kind: "restore" });
  });

  it("Revert all puts every attempt's changes back to before the loop", async () => {
    const other: StepState = { status: "failed", evidence: { at_end: 10, reason: "x" } };
    const h = setup([
      { files: { "Content/BP_Door.uasset": "v2" }, run: [OPEN_FAIL, PASS] },
      { files: { "Config/DefaultGame.ini": "Speed=2" }, run: [other, PASS] },
      { files: { "Content/BP_Door.uasset": "v3" }, run: [PASS, PASS] },
    ]);
    await assign(h);
    await ended(h);
    expect(await h.broker.revertLoop(h.card().runId, {})).toMatchObject({ outcome: { restored: expect.arrayContaining(["Content/BP_Door.uasset", "Config/DefaultGame.ini"]) } });
    expect(support.cp.files.get("Content/BP_Door.uasset")).toBe("v1");
    expect(support.cp.files.has("Config/DefaultGame.ini")).toBe(false);
    expect(h.loop().reverted).toBe(true);
  });

  it("refuses to revert while the loop runs", async () => {
    const h = setup([{ hang: true }]);
    await assign(h);
    expect(await h.broker.revertLoop(`${BASE}00`, {})).toMatchObject({ status: 409 });
  });
});

describe("judging an attempt", () => {
  const run = (states: StepState[], over: Record<string, unknown> = {}, s = STEPS) => {
    steps = s;
    return qaRunFromAnswer({ ...answerOf("r1", states), ...over }, { sessionId: "s", seenAt: "x" })!;
  };
  const facts = { report: "", refusals: [], outside: [], previous: null, changed: true };

  it("passes only when every step passed", () => {
    expect(decide({ ...facts, run: run([PASS, PASS]) })).toEqual({ kind: "passed" });
    expect(decide({ ...facts, run: run([PASS, { status: "skipped" }]) }).kind).toBe("again");
    expect(decide({ ...facts, run: null }).kind).toBe("again");
  });

  it("goes again on the first failure, and stops on the same failure", () => {
    const first = decide({ ...facts, run: run([OPEN_FAIL, PASS]) });
    expect(first.kind).toBe("again");
    const sig = first.kind === "again" ? first.failing.map((f) => f.signature) : [];
    expect(decide({ ...facts, run: run([OPEN_FAIL, PASS]), previous: sig })).toMatchObject({ kind: "blocked", blocker: { kind: "no_progress" } });
    const noChange = decide({ ...facts, run: run([OPEN_FAIL, PASS]), previous: sig, changed: false });
    expect(noChange.kind === "blocked" && noChange.blocker.reason).toMatch(/the last attempt changed nothing/);
  });

  it("treats a run that never ran twice as no progress", () => {
    const sig = failingSteps(null).map((f) => f.signature);
    expect(decide({ ...facts, run: null, previous: sig })).toMatchObject({ kind: "blocked", blocker: { kind: "no_progress", reason: expect.stringMatching(/The playtest did not run/) } });
  });

  it("fixes failures before asking the person for their verdict", () => {
    const s = [...STEPS, PERSON];
    expect(decide({ ...facts, run: run([OPEN_FAIL, PASS, { status: "awaiting_verdict" }], {}, s) }).kind).toBe("again");
    expect(decide({ ...facts, run: run([PASS, PASS, { status: "awaiting_verdict" }], {}, s) })).toMatchObject({ kind: "blocked", blocker: { kind: "verdict", step: 2 } });
    // A person's fail is a failure the loop works on, with their note.
    const theirs = decide({ ...facts, run: run([PASS, PASS, { status: "failed", note: "Too loud", verdict_source: "action" }], {}, s) });
    expect(theirs.kind === "again" && theirs.failing[0].line).toMatch(/Note: Too loud/);
  });

  it("tells the next attempt when the engine's act failed, and which action", () => {
    const actFail: StepState = { status: "failed", evidence: { reason: "Door.OpenAngle never went above 80" } };
    const r = run([{ ...actFail, act_result: { status: "failed", reason: "an action failed", actions: [{ index: 0, action: "goto", ok: true }, { index: 1, action: "press", ok: false, error: "no Input Action IA_Interact" }] } } as StepState]);
    expect(r.steps[0].actResult?.status).toBe("failed");
    expect(failingSteps(r)[0].line).toMatch(/The engine's act failed: an action failed \(press: no Input Action IA_Interact\)\./);
  });

  it("reads a reported blocker from the report's last lines", () => {
    expect(reportedBlocker("x\nBLOCKED: outside_project: the engine's BaseInput.ini")).toMatchObject({ kind: "outside_project" });
    expect(reportedBlocker("**BLOCKED**: needs person: plug in a gamepad")).toMatchObject({ kind: "needs_person" });
    expect(reportedBlocker("Not blocked at all")).toBeNull();
  });

  it("tells a later attempt why each step failed, and to run again", () => {
    const r = run([OPEN_FAIL, { status: "failed", note: "It popped", verdict_source: "agent", evidence: { note: "It popped", captures: ["C:/P/Saved/a.png"] } }]);
    const b = fixBrief(r, 3, failingSteps(r), { minutes: 5, tokens: 10 });
    expect(b).toMatch(/attempt 3 of a loop/);
    expect(b).toMatch(/Step 2 \(The door opens smoothly\) failed\. Note: It popped Captures: C:\/P\/Saved\/a\.png/);
    expect(b).toMatch(/editor_restart \(operation rebuild\)/);
    expect(b).toMatch(/BLOCKED: contradiction/);
    expect(b).toMatch(/Run it again with pie\.script_run/);
  });
});

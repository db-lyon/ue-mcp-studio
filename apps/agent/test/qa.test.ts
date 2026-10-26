import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ActionResult } from "ue-mcp/daemon";
import type { QaRun } from "@ue-mcp-studio/shared";
import { QaBroker, type QaHost } from "../src/qa.js";
import { ELICIT_FEATURE, FormBroker } from "../src/forms.js";
import { SessionStore } from "../src/sessions.js";
import type { AgentHost } from "../src/tools.js";
import { RUN, runAnswer } from "./qa-fixture.js";

const ok = (body: unknown): ActionResult => ({ isError: false, content: [{ type: "text", text: JSON.stringify(body) }] });

type Listener = (e: { type: string; data: Record<string, unknown> }) => void;
type Call = { category: string; action: string; args?: Record<string, unknown>; opts?: { elicit?: unknown } };

function setup(opts: { connected?: boolean } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-qa-"));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-qa-project-"));
  const calls: Call[] = [];
  const published: Array<{ type: string; data: Record<string, unknown> }> = [];
  const listeners = new Set<Listener>();
  let answer: (c: Call) => Promise<ActionResult> = async () => ok({ success: true });
  const host: QaHost & AgentHost = {
    projectDir,
    dataDir,
    features: [ELICIT_FEATURE, "events.script"],
    callAction: (category, action, args, o) => {
      const c = { category, action, args, opts: o };
      calls.push(c);
      return answer(c);
    },
    editors: () => [{ connected: opts.connected ?? true } as never],
    editorOperation: async () => ({}),
    events: {
      publish: (type, data = {}) => {
        published.push({ type, data });
        return undefined;
      },
      subscribe: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    },
    setBusy: () => {},
    log: { info: () => {}, warn: () => {} },
  };
  const emit = (type: string, data: Record<string, unknown>) => {
    for (const l of listeners) l({ type, data });
  };
  const store = new SessionStore(dataDir);
  const forms = new FormBroker(() => {});
  const s = store.create();
  s.transcript.push({ kind: "tool", call: { id: "tu1", name: "ue_mcp", input: { action: "call", category: "pie", method: "script_run" }, outcome: "pending", startedAt: "now" } });
  store.save(s);
  const broker = new QaBroker({ host, store, forms, now: () => "2026-10-23T15:00:00.000Z" });
  return { host, calls, published, emit, store, forms, s, broker, projectDir, dataDir, setAnswer: (f: typeof answer) => (answer = f) };
}

const qaEntry = (store: SessionStore, id: string): QaRun | undefined => {
  const e = store.get(id)!.transcript.find((t) => t.kind === "qa");
  return e?.kind === "qa" ? e.run : undefined;
};

describe("a run a session starts", () => {
  it("is a checklist entry in that session's transcript, with the call that started it", async () => {
    const t = setup();
    t.setAnswer(async () => ok(runAnswer()));
    const r = await t.broker.wrap(t.host, t.s.id).callAction("pie", "script_run", { script: "/Game/PIEStudio/Scripts/DoorOpens" });
    expect(r.isError).toBe(false);
    const run = qaEntry(t.store, t.s.id)!;
    expect(run).toMatchObject({ runId: RUN, sessionId: t.s.id, toolUseId: "tu1", state: "armed", lastSeq: 1 });
    expect(t.published.find((p) => p.type === "transcript.added")?.data.sessionId).toBe(t.s.id);
    expect(t.published.find((p) => p.type === "qa.changed")?.data).toMatchObject({ runId: RUN });
    // No sessionId: the open chat does not load its transcript again for each step.
    expect(t.published.find((p) => p.type === "qa.changed")?.data.sessionId).toBeUndefined();
  });

  it("follows the stream's events and saves each change", async () => {
    const t = setup();
    t.setAnswer(async () => ok(runAnswer()));
    await t.broker.wrap(t.host, t.s.id).callAction("pie", "script_run", {});
    t.emit("script.step_passed", { runId: RUN, script: "x", atMs: 50, seq: 3, step: { index: 0, status: "passed", verdictSource: "auto" } });
    t.emit("script.verdict_requested", { runId: RUN, script: "x", atMs: 60, seq: 7, awaiting: [{ index: 2, instruction: "The door opens without a visible pop" }] });
    const saved = new SessionStore(t.dataDir);
    const run = qaEntry(saved, t.s.id)!;
    expect(run.steps[0].status).toBe("passed");
    expect(run).toMatchObject({ state: "awaiting_verdict", awaiting: [2], lastSeq: 7 });
  });

  it("gets its card from the first events when they come before the call's answer, read with the session's form", async () => {
    const t = setup();
    let release!: () => void;
    t.setAnswer(async (c) => {
      if (c.action === "script_run") {
        await new Promise<void>((r) => (release = r));
        return ok({ ...runAnswer(), state: "finished", wait: { state: "finished" } });
      }
      return ok({ ...runAnswer(), state: "running", last_seq: 2 });
    });
    const running = t.broker.wrap(t.host, t.s.id).callAction("pie", "script_run", { wait: true });
    await Promise.resolve();
    t.emit("script.run_started", { runId: RUN, script: "/Game/PIEStudio/Scripts/DoorOpens", atMs: 0, seq: 1 });
    await new Promise((r) => setTimeout(r, 0));
    const status = t.calls.find((c) => c.action === "script_status")!;
    expect(status.args).toEqual({ run_id: RUN });
    expect(typeof status.opts?.elicit).toBe("function");
    expect(qaEntry(t.store, t.s.id)).toMatchObject({ runId: RUN, sessionId: t.s.id, toolUseId: "tu1", state: "running" });
    release();
    await running;
    expect(t.store.get(t.s.id)!.transcript.filter((e) => e.kind === "qa")).toHaveLength(1);
  });

  it("does nothing for a call that failed", async () => {
    const t = setup();
    t.setAnswer(async () => ok({ success: false, error: "A run is active" }));
    await t.broker.wrap(t.host, t.s.id).callAction("pie", "script_run", {});
    expect(qaEntry(t.store, t.s.id)).toBeUndefined();
  });
});

describe("a run started elsewhere", () => {
  it("is read with script_results, which leaves its follower alone, and listed for every chat", async () => {
    const t = setup();
    t.setAnswer(async () => ok({ success: true, live: true, run_id: RUN, script: "/Game/S", script_name: "S", state: "running", steps: runAnswer().steps }));
    t.emit("script.run_started", { runId: RUN, script: "/Game/S", atMs: 0, seq: 1 });
    await new Promise((r) => setTimeout(r, 0));
    expect(t.calls.map((c) => c.action)).toEqual(["script_results"]);
    expect(t.calls[0].opts).toBeUndefined();
    expect(t.broker.unowned().map((r) => r.runId)).toEqual([RUN]);
    expect(qaEntry(t.store, t.s.id)).toBeUndefined();
    expect(t.broker.dismiss(RUN)).toMatch(/still going/);
    t.emit("script.run_finished", { runId: RUN, script: "/Game/S", atMs: 9, seq: 9, summary: {}, state: "finished" });
    expect(t.broker.dismiss(RUN)).toBeNull();
    expect(t.broker.unowned()).toEqual([]);
  });
});

describe("after a restart", () => {
  it("reads every unfinished run again from its last seq, with the session's form", async () => {
    const first = setup();
    first.setAnswer(async () => ok(runAnswer()));
    await first.broker.wrap(first.host, first.s.id).callAction("pie", "script_run", {});
    first.emit("script.step_passed", { runId: RUN, script: "x", atMs: 50, seq: 4, step: { index: 0, status: "passed" } });
    first.broker.dispose();

    // A new daemon process on the same data.
    const store = new SessionStore(first.dataDir);
    const calls: Call[] = [];
    const host = {
      ...first.host,
      callAction: async (category: string, action: string, args?: Record<string, unknown>, opts?: { elicit?: unknown }) => {
        calls.push({ category, action, args, opts });
        return ok({ ...runAnswer(), state: "awaiting_verdict", steps: runAnswer().steps.map((s, i) => ({ ...s, status: i < 2 ? "passed" : "awaiting_verdict" })), events: [{ seq: 5, type: "step_passed", run_id: RUN, step: 1, data: { status: "passed" } }], last_seq: 7 });
      },
    };
    const broker = new QaBroker({ host, store, forms: new FormBroker(() => {}) });
    await broker.resume();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ action: "script_status", args: { run_id: RUN, since_seq: 4 } });
    expect(typeof calls[0].opts?.elicit).toBe("function");
    expect(broker.get(RUN)).toMatchObject({ state: "awaiting_verdict", lastSeq: 7, awaiting: [2] });
  });

  it("waits for the editor before reading", async () => {
    const t = setup({ connected: false });
    t.setAnswer(async () => ok(runAnswer()));
    await t.broker.wrap(t.host, t.s.id).callAction("pie", "script_run", {});
    t.calls.length = 0;
    await t.broker.resume();
    expect(t.calls).toEqual([]);
  });
});

describe("the user's verdict", () => {
  it("goes to pie(verdict) with the note, and the card takes the answer", async () => {
    const t = setup();
    t.setAnswer(async () => ok(runAnswer()));
    await t.broker.wrap(t.host, t.s.id).callAction("pie", "script_run", {});
    t.emit("script.verdict_requested", { runId: RUN, script: "x", atMs: 60, seq: 7, awaiting: [{ index: 2, instruction: "x" }] });
    t.setAnswer(async () => ok({ success: true, run_id: RUN, step: 2, status: "failed", verdict: "fail", verdict_source: "action", note: "pops", state: "finished", awaiting: [] }));
    const r = await t.broker.verdict(RUN, { step: 2, verdict: "fail", note: "  pops " });
    expect(t.calls.at(-1)).toMatchObject({ action: "verdict", args: { run_id: RUN, step: 2, verdict: "fail", note: "pops" } });
    expect("run" in r && r.run.steps[2]).toMatchObject({ status: "failed", note: "pops", verdictSource: "action" });
    expect(qaEntry(t.store, t.s.id)!.awaiting).toEqual([]);
  });

  it("reports ue-mcp's refusal and a body that is not a verdict", async () => {
    const t = setup();
    t.setAnswer(async () => ok({ success: false, error: "Run x is not the current run (y)" }));
    expect(await t.broker.verdict(RUN, { step: 2, verdict: "fail", note: "the door stayed shut" })).toEqual({ error: "Run x is not the current run (y)", status: 409 });
    expect(await t.broker.verdict(RUN, { step: 2, verdict: "fail" })).toMatchObject({ status: 400 });
    expect(await t.broker.verdict(RUN, { step: 2, verdict: "maybe" })).toMatchObject({ status: 400 });
  });
});

describe("results.json", () => {
  it("is read from the project's file, and from ue-mcp for a path outside it", async () => {
    const t = setup();
    const dir = path.join(t.projectDir, "Saved", "MCPObservations", RUN);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "results.json"), JSON.stringify({ version: 1, run_id: RUN }));
    t.setAnswer(async () => ok({ ...runAnswer(), results_path: path.join(dir, "results.json") }));
    await t.broker.wrap(t.host, t.s.id).callAction("pie", "script_run", {});
    expect(await t.broker.results(RUN)).toEqual({ version: 1, run_id: RUN });

    t.setAnswer(async () => ok({ ...runAnswer(), run_id: "other", results_path: "C:/Elsewhere/results.json" }));
    await t.broker.wrap(t.host, t.s.id).callAction("pie", "script_run", {});
    t.setAnswer(async () => ok({ success: true, live: false, run_id: "other", version: 1 }));
    expect(await t.broker.results("other")).toMatchObject({ run_id: "other", version: 1 });
    expect(t.calls.at(-1)).toMatchObject({ action: "script_results", args: { run_id: "other" } });
  });
});

describe("step captures", () => {
  it("serves a step's picture from under Saved, and nothing outside it or of another type", async () => {
    const t = setup();
    const dir = path.join(t.projectDir, "Saved", "MCPObservations", RUN);
    fs.mkdirSync(dir, { recursive: true });
    const shot = path.join(dir, "step1.png");
    fs.writeFileSync(shot, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const outside = path.join(os.tmpdir(), `studio-capture-${process.pid}.png`);
    fs.writeFileSync(outside, "x");
    fs.writeFileSync(path.join(dir, "notes.txt"), "x");
    const base = runAnswer();
    const steps = (base.steps as Array<Record<string, unknown>>).map((st, i) =>
      i === 0 ? { ...st, evidence: { note: "seen", captures: [shot, outside, path.join(dir, "notes.txt"), path.join(dir, "missing.png")] } } : st);
    t.setAnswer(async () => ok({ ...base, steps }));
    await t.broker.wrap(t.host, t.s.id).callAction("pie", "script_run", {});

    expect(t.broker.capture(RUN, 0, 0)).toEqual({ type: "image/png", bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
    expect(t.broker.capture(RUN, 0, 1)).toBeNull();
    expect(t.broker.capture(RUN, 0, 2)).toBeNull();
    expect(t.broker.capture(RUN, 0, 3)).toBeNull();
    expect(t.broker.capture(RUN, 0, 9)).toBeNull();
    expect(t.broker.capture("nope", 0, 0)).toBeNull();
    fs.rmSync(outside, { force: true });
  });
});

describe("where a run's card sits in its session", () => {
  it("moves a run that starts again to the end of the transcript, and says so", async () => {
    const t = setup();
    t.setAnswer(async () => ok({ ...runAnswer(), state: "finished" }));
    await t.broker.wrap(t.host, t.s.id).callAction("pie", "script_run", {});
    const s = t.store.get(t.s.id)!;
    s.transcript.push({ kind: "user", text: "later", at: "" });
    t.setAnswer(async () => ok({ ...runAnswer(), state: "running" }));
    await t.broker.wrap(t.host, t.s.id).callAction("pie", "script_run", {});
    const kinds = t.store.get(t.s.id)!.transcript.map((e) => e.kind);
    expect(kinds.at(-1)).toBe("qa");
    expect(kinds.filter((k) => k === "qa")).toHaveLength(1);
    expect(t.published.some((p) => p.type === "transcript.moved" && p.data.sessionId === t.s.id)).toBe(true);
  });
});

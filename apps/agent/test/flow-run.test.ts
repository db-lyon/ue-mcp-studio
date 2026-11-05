/**
 * /flow <name> in a session: the call to the daemon's /v1/flows/<name>/run
 * with the params, the steps its flow.* events show on the card, the summary
 * or errors it ends with, and a card a daemon restart cut off.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Approvals, TranscriptEntry } from "@ue-mcp-studio/shared";
import type { ActionEffects } from "../src/approval-kind.js";
import { FlowCaller, applyStepEvent, flowOutcome, offersStepApproval } from "../src/flow-run.js";
import type { FlowEventLike } from "../src/playtest-flow.js";
import { AgentRunner } from "../src/runner.js";
import { SessionStore } from "../src/sessions.js";
import type { AgentHost } from "../src/tools.js";
import type { ModelProvider } from "../src/providers.js";

/** A daemon: the run route answers from `answer`, and emits `script` while the run is in progress. */
function fakeDaemon(answer: () => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>, script: FlowEventLike[] = [], plan: () => { status: number; body: unknown } = () => ({ status: 200, body: { success: true, steps: [{ stepNumber: 1, type: "task", name: "editor.stop" }, { stepNumber: 2, type: "task", name: "project.build" }] } })) {
  const listeners = new Set<(e: FlowEventLike) => void>();
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const plans: string[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (url.endsWith("/plan")) {
      plans.push(url);
      const p = plan();
      return new Response(JSON.stringify(p.body), { status: p.status, headers: { "content-type": "application/json" } });
    }
    requests.push({ url, init });
    for (const e of script) for (const l of [...listeners]) l(e);
    const a = await answer();
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const caller = new FlowCaller({
    endpoint: () => ({ port: 4711, token: "tok" }),
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    fetchImpl,
  });
  return { caller, requests, listeners, plans };
}

const started = (runId: string, flowName: string): FlowEventLike => ({ type: "flow.run_started", data: { runId, flowName } });
const stepStarted = (runId: string, flowName: string, n: number, name: string): FlowEventLike => ({ type: "flow.step_started", data: { runId, flowName, step: { stepNumber: n, name } } });
const stepDone = (runId: string, flowName: string, n: number, name: string, success = true, skipped = false): FlowEventLike =>
  ({ type: "flow.step_completed", data: { runId, flowName, step: { stepNumber: n, name }, result: { success, skipped, duration: 5 } } });
const stepFailed = (runId: string, flowName: string, n: number, name: string, message: string): FlowEventLike =>
  ({ type: "flow.step_failed", data: { runId, flowName, step: { stepNumber: n, name }, error: { message, name: "Error" } } });

const ok = { status: 200, body: { success: true, runId: "r1", duration: 1200, summary: "Flow 'rebuild' completed", steps: [{ stepNumber: 1, name: "editor.stop", success: true }, { stepNumber: 2, name: "project.build", success: true }] } };
const failed = { status: 200, body: { success: false, runId: "r1", summary: "Flow 'rebuild' failed at step 2", steps: [{ stepNumber: 1, name: "editor.stop", success: true }, { stepNumber: 2, name: "project.build", success: false, error: { message: "UBT exited 6" } }] } };

describe("the flow call", () => {
  it("posts the params to the daemon's run route for the flow, with its token", async () => {
    const d = fakeDaemon(() => ok);
    const out = await d.caller.run("rebuild", { clean: true }, () => {}, new AbortController().signal);
    expect(d.requests[0].url).toBe("http://127.0.0.1:4711/v1/flows/rebuild/run");
    expect(d.requests[0].init.method).toBe("POST");
    expect((d.requests[0].init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(String(d.requests[0].init.body))).toEqual({ params: { clean: true } });
    expect(out).toMatchObject({ success: true, summary: "Flow 'rebuild' completed", errors: [], duration: 1200 });
    expect(d.listeners.size).toBe(0);
  });

  it("hands on its own run's events only: another flow's, and another run's, are left out", async () => {
    const seen: string[] = [];
    const d = fakeDaemon(() => ok, [
      started("x", "other"),
      stepStarted("x", "other", 1, "a.b"),
      started("r1", "rebuild"),
      stepStarted("r1", "rebuild", 1, "editor.stop"),
      stepStarted("r2", "rebuild", 1, "editor.stop"),
      // A nested flow's steps carry the run's id under the child's name.
      stepStarted("r1", "child", 2, "child.step"),
    ]);
    await d.caller.run("rebuild", {}, (e) => seen.push(`${e.type}:${String(e.data?.runId)}:${String(e.data?.flowName)}`), new AbortController().signal);
    expect(seen).toEqual(["flow.run_started:r1:rebuild", "flow.step_started:r1:rebuild", "flow.step_started:r1:child"]);
  });

  it("sends stepApproval with the run when given, and nothing extra otherwise", async () => {
    const d = fakeDaemon(() => ok);
    await d.caller.run("rebuild", {}, () => {}, new AbortController().signal, { approver: "studio", token: "t1" });
    expect(JSON.parse(String(d.requests[0].init.body))).toEqual({ params: {}, stepApproval: { approver: "studio", token: "t1" } });
  });

  it("uses step approval only from a daemon that offers it", () => {
    const flows = { approveSteps: () => () => {} };
    expect(offersStepApproval({ features: ["flows.stepApproval"], flows })).toBe(true);
    expect(offersStepApproval({ features: ["models.provider"], flows })).toBe(false);
    expect(offersStepApproval({ features: ["flows.stepApproval"] })).toBe(false);
    expect(offersStepApproval({})).toBe(false);
  });

  it("reads why a run failed from its failed steps, else its error", () => {
    expect(flowOutcome(200, failed.body).errors).toEqual(["project.build: UBT exited 6"]);
    expect(flowOutcome(500, { error: "Flow 'nope' not found" }).errors).toEqual(["Flow 'nope' not found"]);
    expect(flowOutcome(409, {}).errors).toEqual(["The flow answered 409 without saying why."]);
  });

  it("folds step events into the card's steps", () => {
    const steps: Parameters<typeof applyStepEvent>[0] = [];
    applyStepEvent(steps, stepStarted("r", "f", 1, "a.one"));
    applyStepEvent(steps, stepDone("r", "f", 1, "a.one"));
    applyStepEvent(steps, stepDone("r", "f", 2, "a.two", true, true));
    applyStepEvent(steps, stepFailed("r", "f", 3, "a.three", "boom"));
    applyStepEvent(steps, { type: "flow.step_started", data: { step: { stepNumber: 1, path: "4/1", depth: 1, name: "c.x" } } });
    expect(steps).toEqual([
      { id: "1", name: "a.one", state: "done" },
      { id: "2", name: "a.two", state: "skipped" },
      { id: "3", name: "a.three", state: "failed", error: "boom" },
      { id: "4/1", name: "c.x", depth: 1, state: "running" },
    ]);
  });
});

describe("a /flow in a session", () => {
  let root: string;
  let store: SessionStore;
  let published: Array<{ type: string; data?: Record<string, unknown> }>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-flow-run-"));
    fs.mkdirSync(path.join(root, "project"), { recursive: true });
    store = new SessionStore(path.join(root, "data"));
    published = [];
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function setup(answer: () => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>, events: FlowEventLike[] = [], o: { plan?: () => { status: number; body: unknown }; approvals?: Partial<Approvals>; effects?: ActionEffects; live?: boolean } = {}) {
    const host = {
      projectDir: path.join(root, "project"),
      dataDir: path.join(root, "data"),
      callAction: async () => ({ isError: false, content: [] }),
      editors: () => [{ connected: true, name: "P", port: 1, pid: 1, lastDisconnect: null }],
      editorOperation: async (op: string) => ({ op, steps: [] }),
      events: { publish: (type: string, data?: Record<string, unknown>) => void published.push({ type, data }), subscribe: () => () => {} },
      setBusy: () => {},
      log: { info() {}, warn() {} },
    } as unknown as AgentHost;
    const model: ModelProvider = { run: async () => { throw new Error("a /flow runs no chat turn"); } };
    const d = fakeDaemon(answer, events, o.plan);
    const approvals = o.approvals ? () => ({ shell: "ask", files: "ask", editorRestart: "ask", destructive: "ask", ...o.approvals }) as Approvals : undefined;
    const runner = new AgentRunner({ host, store, provider: () => model, model: () => "claude-opus-5-5", flows: d.caller, ...(approvals ? { approvals } : {}), ...(o.effects ? { effects: o.effects } : {}), ...(o.live ? { flowStepApproval: () => true } : {}) });
    const s = store.create("New session");
    return { runner, s, d };
  }

  const card = (id: string) => store.get(id)!.transcript.find((t) => t.kind === "flow") as Extract<TranscriptEntry, { kind: "flow" }>;

  it("runs the flow from its form, shows each step, and ends with the summary", async () => {
    const { runner, s, d } = setup(() => ok, [
      started("r1", "rebuild"),
      stepStarted("r1", "rebuild", 1, "editor.stop"),
      stepDone("r1", "rebuild", 1, "editor.stop"),
      stepStarted("r1", "rebuild", 2, "project.build"),
    ]);
    await runner.flow(s.id, { name: "rebuild", params: { clean: true, target: "Editor Win64" } });
    const after = store.get(s.id)!;
    expect(after.transcript[0]).toMatchObject({ kind: "user", text: '/flow rebuild clean=true target="Editor Win64"' });
    expect(card(s.id)).toMatchObject({
      name: "rebuild",
      params: { clean: true, target: "Editor Win64" },
      state: "succeeded",
      summary: "Flow 'rebuild' completed",
      duration: 1200,
      steps: [{ id: "1", name: "editor.stop", state: "done" }, { id: "2", name: "project.build", state: "done" }],
    });
    expect(JSON.parse(String(d.requests[0].init.body))).toEqual({ params: { clean: true, target: "Editor Win64" } });
    expect(after.status).toBe("idle");
    expect(after.messages).toHaveLength(0);
    expect(after.notes.join("\n")).toContain("the flow succeeded");
    expect(published.filter((p) => p.type === "flowrun.changed").length).toBeGreaterThanOrEqual(3);
  });

  it("runs a /flow message with the pairs it names", async () => {
    const { runner, s, d } = setup(() => ok);
    await runner.send(s.id, "/flow rebuild clean=true count=3 label=hero");
    expect(JSON.parse(String(d.requests[0].init.body))).toEqual({ params: { clean: true, count: 3, label: "hero" } });
    expect(store.get(s.id)!.transcript[0]).toMatchObject({ kind: "user", text: "/flow rebuild clean=true count=3 label=hero" });
  });

  it("says why a run failed, with the steps from its answer when no event arrived", async () => {
    const { runner, s } = setup(() => failed);
    await runner.flow(s.id, { name: "rebuild", params: {} });
    expect(card(s.id)).toMatchObject({
      state: "failed",
      errors: ["project.build: UBT exited 6"],
      steps: [{ name: "editor.stop", state: "done" }, { name: "project.build", state: "failed", error: "UBT exited 6" }],
    });
    expect(store.get(s.id)!.notes.join("\n")).toContain("the flow failed. project.build: UBT exited 6");
  });

  it("refuses while a turn runs, and a run with no name", async () => {
    const { runner, s } = setup(() => ok);
    const live = store.get(s.id)!;
    live.status = "running";
    store.save(live);
    await expect(runner.flow(s.id, { name: "rebuild", params: {} })).rejects.toThrow(/in progress/);
    live.status = "idle";
    store.save(live);
    await expect(runner.flow(s.id, { name: " ", params: {} })).rejects.toThrow(/name the flow/);
  });

  const until = async (cond: () => boolean) => {
    const end = Date.now() + 3000;
    while (!cond()) {
      if (Date.now() > end) throw new Error("condition not met");
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const planOf = (...names: string[]) => () => ({ status: 200, body: { success: true, steps: names.map((name, i) => ({ stepNumber: i + 1, type: "task", name })) } });
  const effects: ActionEffects = { destructive: (c, m) => c === "asset" && m === "delete", readOnly: () => null };

  it("asks before a step that runs Python, a console command, a destructive action or an unknown task, as the agent's own call would; a denial runs nothing", async () => {
    for (const task of ["editor.execute_python", "editor.execute_command", "asset.delete", "my_project_task"]) {
      const { runner, s, d } = setup(() => ok, [], { plan: planOf("level.place_actor", task), approvals: {}, effects });
      const run = runner.flow(s.id, { name: "f", params: {} });
      await until(() => (store.get(s.id)!.approvals ?? []).length > 0);
      const a = store.get(s.id)!.approvals![0];
      const dot = task.indexOf(".");
      expect(a, task).toMatchObject({ tool: "ue_mcp", call: dot > 0 ? { category: task.slice(0, dot), method: task.slice(dot + 1) } : { category: "flow", method: task } });
      expect(store.get(s.id)!.approvals).toHaveLength(1);
      runner.answerApproval(s.id, a.id, "deny");
      await run;
      expect(d.requests, task).toHaveLength(0);
      expect(card(s.id)).toMatchObject({ state: "failed" });
      expect(card(s.id).errors?.[0]).toContain(task);
      expect(store.get(s.id)!.status).toBe("idle");
      expect(store.get(s.id)!.notes.join("\n")).toContain("declined a step at the approval");
    }
  });

  it("allowed, the flow runs; one answer per task, and Allow for this session covers the next run", async () => {
    const { runner, s, d } = setup(() => ok, [], { plan: planOf("editor.execute_python", "level.place_actor", "editor.execute_python"), approvals: {}, effects });
    const first = runner.flow(s.id, { name: "f", params: {} });
    await until(() => (store.get(s.id)!.approvals ?? []).length > 0);
    runner.answerApproval(s.id, store.get(s.id)!.approvals![0].id, "session");
    await first;
    expect(d.requests).toHaveLength(1);
    expect(published.filter((p) => p.type === "approval.requested")).toHaveLength(1);
    await runner.flow(s.id, { name: "f", params: {} });
    expect(d.requests).toHaveLength(2);
    expect(published.filter((p) => p.type === "approval.requested")).toHaveLength(1);
  });

  it("asks nothing for plain ue-mcp actions, or when the rows allow the kind", async () => {
    const plain = setup(() => ok, [], { plan: planOf("level.place_actor", "material.create"), approvals: {}, effects });
    await plain.runner.flow(plain.s.id, { name: "f", params: {} });
    expect(plain.d.requests).toHaveLength(1);
    const allowed = setup(() => ok, [], { plan: planOf("editor.execute_python"), approvals: { shell: "allow" }, effects });
    await allowed.runner.flow(allowed.s.id, { name: "f", params: {} });
    expect(allowed.d.requests).toHaveLength(1);
    expect(published.filter((p) => p.type === "approval.requested")).toHaveLength(0);
  });

  it("asks once for the whole flow when its plan cannot be read", async () => {
    const { runner, s, d } = setup(() => ok, [], { plan: () => ({ status: 404, body: {} }), approvals: {}, effects });
    const run = runner.flow(s.id, { name: "f", params: {} });
    await until(() => (store.get(s.id)!.approvals ?? []).length > 0);
    expect(store.get(s.id)!.approvals![0]).toMatchObject({ tool: "ue_mcp", call: { category: "flow", method: "run", args: { flowName: "f" } } });
    runner.answerApproval(s.id, store.get(s.id)!.approvals![0].id, "allow");
    await run;
    expect(d.requests).toHaveLength(1);
  });

  it("a /flow message goes through the same approvals", async () => {
    const { runner, s, d } = setup(() => ok, [], { plan: planOf("editor.execute_command"), approvals: { shell: "project" }, effects });
    const run = runner.send(s.id, "/flow f");
    await until(() => (store.get(s.id)!.approvals ?? []).length > 0);
    runner.answerApproval(s.id, store.get(s.id)!.approvals![0].id, "deny");
    await run;
    expect(d.requests).toHaveLength(0);
  });

  it("with the daemon's step approval: no plan check; the run carries a token and each step asks as it runs, with its options", async () => {
    let runner!: AgentRunner;
    let sid = "";
    const decisions: unknown[] = [];
    // The daemon asks for each step while the run request is open, as ue-mcp does.
    let release!: () => void;
    const held = new Promise<typeof ok>((res) => (release = () => res(ok)));
    const { runner: r, s, d } = setup(() => held, [], { live: true, approvals: {}, effects, plan: () => { throw new Error("no plan check with step approval"); } });
    runner = r;
    sid = s.id;
    const run = runner.flow(s.id, { name: "f", params: {} });
    await until(() => d.requests.length === 1);
    const body = JSON.parse(String(d.requests[0].init.body)) as { stepApproval?: { approver: string; token: string } };
    expect(body.stepApproval?.approver).toBe("studio");
    const token = body.stepApproval!.token;
    expect(d.plans).toEqual([]);
    // A plain action passes without asking.
    decisions.push(await runner.approveFlowStep({ token, task: "level.place_actor", options: {} }));
    // Python asks, with the step's code shown; a denial says which step.
    const asked = runner.approveFlowStep({ token, task: "editor.execute_python", options: { code: "import os" } });
    await until(() => (store.get(sid)!.approvals ?? []).length > 0);
    expect(store.get(sid)!.approvals![0]).toMatchObject({ tool: "ue_mcp", call: { category: "editor", method: "execute_python", args: { code: "import os" } } });
    runner.answerApproval(sid, store.get(sid)!.approvals![0].id, "deny");
    decisions.push(await asked);
    // A token this Studio never handed out is denied without asking.
    decisions.push(await runner.approveFlowStep({ token: "forged", task: "level.place_actor", options: {} }));
    expect(decisions).toEqual([
      { allow: true },
      { allow: false, reason: "Declined at the approval for the step editor.execute_python, so it did not run." },
      { allow: false, reason: "Step level.place_actor is not part of a flow this Studio started, so it did not run." },
    ]);
    release();
    await run;
    // Once the run ends its token is no longer honoured.
    expect(await runner.approveFlowStep({ token, task: "level.place_actor", options: {} })).toMatchObject({ allow: false });
  });

  it("with the daemon's step approval, Allow for this session covers later steps of that kind", async () => {
    let release!: () => void;
    const held = new Promise<typeof ok>((res) => (release = () => res(ok)));
    const { runner, s, d } = setup(() => held, [], { live: true, approvals: {}, effects });
    const run = runner.flow(s.id, { name: "f", params: {} });
    await until(() => d.requests.length === 1);
    const token = (JSON.parse(String(d.requests[0].init.body)) as { stepApproval: { token: string } }).stepApproval.token;
    const first = runner.approveFlowStep({ token, task: "editor.execute_command", options: { command: "stat fps" } });
    await until(() => (store.get(s.id)!.approvals ?? []).length > 0);
    runner.answerApproval(s.id, store.get(s.id)!.approvals![0].id, "session");
    expect(await first).toEqual({ allow: true });
    expect(await runner.approveFlowStep({ token, task: "editor.execute_python", options: { code: "1" } })).toEqual({ allow: true });
    expect(published.filter((p) => p.type === "approval.requested")).toHaveLength(1);
    release();
    await run;
  });

  it("ends a card a daemon restart cut off as failed", () => {
    const { runner, s } = setup(() => ok);
    const live = store.get(s.id)!;
    live.transcript.push({ kind: "flow", name: "rebuild", params: {}, state: "running", steps: [{ id: "1", name: "editor.stop", state: "running" }], at: "" });
    live.status = "running";
    store.save(live);
    runner.recover();
    expect(card(s.id)).toMatchObject({ state: "failed", steps: [{ state: "failed" }] });
    expect(card(s.id).errors?.[0]).toMatch(/^It was cut off/);
    expect(store.get(s.id)!.status).toBe("idle");
  });
});

/**
 * The runner editor (hub/runner.ts): found only by feature check, started on
 * demand for unattended run plans, restarted after project files change,
 * stopped when idle, and its own lease in the queue. A fake daemon; no editor.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_PLAN_OPTIONS, qaRunFromAnswer, type HubRunnerEvent, type PlanOptions, type PlanRun, type QaRun } from "@ue-mcp-studio/shared";
import { RUNNER, RUNNER_INSTANCE, RUNNER_WAIT, RunnerEditor, runnerHostOf, type InstancesApi, type RunnerHost } from "../src/hub/runner.js";
import { EditorLease, WORKSPACE } from "../src/hub/lease.js";
import { PlanQueue, type QueueRunner } from "../src/hub/queue.js";

const settle = () => new Promise((r) => setTimeout(r, 0));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let n = 0;
const plan = (options: Partial<PlanOptions> = {}, work?: "fix"): PlanRun => ({
  id: `p${n++}`,
  title: "Run all",
  scope: { kind: "all" },
  options: { ...DEFAULT_PLAN_OPTIONS, ...options },
  state: "queued",
  items: [{ check: { kind: "script", target: "/Game/A" }, name: "A", state: "queued" }],
  trigger: "person",
  createdAt: "2026-11-23T00:00:00.000Z",
  ...(work ? { work } : {}),
});

class FakeHost implements RunnerHost {
  up = false;
  starts = 0;
  stops = 0;
  fail: string | null = null;
  async start(): Promise<void> {
    this.starts += 1;
    if (this.fail) throw new Error(this.fail);
    this.up = true;
  }
  async stop(): Promise<void> {
    this.stops += 1;
    this.up = false;
  }
  connected(): boolean {
    return this.up;
  }
}

let host: FakeHost;
let seq: number;
let enabled: boolean;
let events: HubRunnerEvent[];
let now: number;
const make = (o: { host?: RunnerHost | null; idleMs?: number } = {}) => new RunnerEditor({
  host: o.host === undefined ? host : o.host,
  enabled: () => enabled,
  watch: { mark: () => seq, changedSince: (m) => seq > m },
  changed: (e) => events.push(e),
  idleMs: o.idleMs,
  retryMs: 1000,
  now: () => now,
});

beforeEach(() => {
  host = new FakeHost();
  seq = 0;
  enabled = true;
  events = [];
  now = 0;
});

describe("runnerHostOf", () => {
  const fake = (features: string[]) => {
    const calls: unknown[][] = [];
    const api: InstancesApi = {
      features,
      instances: {
        list: () => [{ name: RUNNER_INSTANCE, connected: true }],
        start: async (...a) => (calls.push(["start", ...a]), { ok: true }),
        stop: async (...a) => (calls.push(["stop", ...a]), { ok: false, reason: "busy" }),
      },
    };
    return { api, calls };
  };

  it("is null on a daemon without both features, as on every ue-mcp so far", () => {
    expect(runnerHostOf({ features: ["callAction.dialogPrompt"] })).toBeNull();
    expect(runnerHostOf(fake(["editors.instances"]).api)).toBeNull();
    expect(runnerHostOf({ features: ["editors.instances", "editors.readOnly"] })).toBeNull();
  });

  it("asks for an offscreen, read-only instance and passes on ue-mcp's refusal", async () => {
    const { api, calls } = fake(["editors.instances", "editors.readOnly"]);
    const h = runnerHostOf(api)!;
    await h.start();
    expect(calls[0]).toEqual(["start", RUNNER_INSTANCE, { window: "offscreen", readOnly: true }]);
    expect(h.connected()).toBe(true);
    await expect(h.stop()).rejects.toThrow("busy");
  });
});

describe("RunnerEditor", () => {
  it("takes only unattended run plans, and only while there is a runner", () => {
    const r = make();
    expect(r.takes(plan({ attended: false }))).toBe(true);
    expect(r.takes(plan({ attended: true }))).toBe(false);
    expect(r.takes(plan({ attended: false }, "fix"))).toBe(false);
    enabled = false;
    expect(r.takes(plan({ attended: false }))).toBe(false);
    enabled = true;
    expect(make({ host: null }).takes(plan({ attended: false }))).toBe(false);
  });

  it("says nothing while unsupported, and that it is supported once ue-mcp can run one", () => {
    expect(make({ host: null }).event()).toEqual({ supported: false, runner: null });
    expect(make().event()).toEqual({ supported: true, runner: { state: "stopped", purpose: null, error: null } });
    enabled = false;
    expect(make().event()).toEqual({ supported: true, runner: null });
  });

  it("starts on demand and is ready once its editor answers", async () => {
    const r = make();
    expect(r.prepare()).toBe(RUNNER_WAIT.starting);
    expect(r.prepare()).toBe(RUNNER_WAIT.starting);
    await settle();
    expect(host.starts).toBe(1);
    expect(r.prepare()).toBeNull();
    expect(r.connected()).toBe(true);
    expect(events.map((e) => e.runner?.state)).toEqual(["starting", "ready"]);
  });

  it("names what it plays while its lease is held", async () => {
    const r = make();
    r.prepare();
    await settle();
    r.lease.take({ purpose: "Run all: A", planRunId: "p", item: 0, work: "run" });
    expect(r.event().runner).toEqual({ state: "running", purpose: "Run all: A", error: null });
    expect(r.lease.editor).toBe(RUNNER);
  });

  it("restarts before the next item when project files changed since it started", async () => {
    const r = make();
    r.prepare();
    await settle();
    seq = 3;
    expect(r.prepare()).toBe(RUNNER_WAIT.reloading);
    await settle();
    await settle();
    expect(host.stops).toBe(1);
    expect(host.starts).toBe(2);
    expect(r.prepare()).toBeNull();
  });

  it("says why it did not start, and tries again only after a while", async () => {
    host.fail = "the editor is already running for this project";
    const r = make();
    r.prepare();
    await settle();
    expect(r.prepare()).toBe(RUNNER_WAIT.failed("the editor is already running for this project"));
    expect(r.event().runner?.error).toBe("the editor is already running for this project");
    expect(host.starts).toBe(1);
    host.fail = null;
    now = 2000;
    expect(r.prepare()).toBe(RUNNER_WAIT.starting);
    await settle();
    expect(r.prepare()).toBeNull();
  });

  it("stops after a while idle, never while its lease is held", async () => {
    const r = make({ idleMs: 20 });
    r.prepare();
    await settle();
    r.lease.take({ purpose: "Run all: A", planRunId: "p", item: 0, work: "run" });
    await wait(40);
    expect(host.stops).toBe(0);
    r.lease.release();
    await wait(40);
    expect(host.stops).toBe(1);
    expect(r.event().runner?.state).toBe("stopped");
  });

  it("is lost when its editor goes without a word, and stops once idle when turned off", async () => {
    const r = make();
    r.prepare();
    await settle();
    host.up = false;
    expect(r.tick()).toBe(true);
    expect(r.event().runner?.state).toBe("stopped");
    r.prepare();
    await settle();
    enabled = false;
    expect(r.tick()).toBe(false);
    await settle();
    expect(host.stops).toBe(1);
  });
});

describe("PlanQueue with a runner", () => {
  let root: string;
  let runs: Map<string, QaRun>;
  let pieEnds: string[];
  let runnerOn: boolean;
  const workspace = new EditorLease(WORKSPACE);
  const runnerLease = new EditorLease(RUNNER);

  const qa = (runId: string, state: string): QaRun => ({
    ...qaRunFromAnswer({ run_id: runId, script: "/Game/A", script_name: "A", state, steps: [{ index: 0, instruction: "s", judge: "auto", status: state === "finished" ? "passed" : "running" }] }, { sessionId: "s", seenAt: "2026-11-23T00:00:00.000Z" })!,
    pieStarted: true,
  });

  const runner = (): QueueRunner => ({
    connected: (editor) => (editor === RUNNER ? runnerOn : true),
    occupied: () => null,
    leaseFor: (p) => (runnerOn && !p.options.attended ? runnerLease : workspace),
    start: async () => {
      const id = `run${runs.size}`;
      runs.set(id, qa(id, "running"));
      return { runId: id };
    },
    run: (id) => runs.get(id),
    stop: async () => {},
    refresh: async () => {},
    stopFix: async () => {},
    endPie: async (editor) => void pieEnds.push(editor),
  });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "hub-runner-"));
    runs = new Map();
    pieEnds = [];
    runnerOn = true;
    workspace.release();
    runnerLease.release();
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("plays an unattended plan under the runner's lease and leaves the workspace lease alone", async () => {
    const q = new PlanQueue({ dataDir: root, runner: runner(), lease: workspace });
    q.enqueue(plan({ attended: false }));
    await settle();
    expect(q.heldBy()).toBe(RUNNER);
    expect(runnerLease.get()?.runId).toBe("run0");
    expect(workspace.get()).toBeNull();
    expect(q.state().lease).toBeNull();
    // The workspace editor going says nothing about the runner's item.
    q.editorLost("crashed", WORKSPACE);
    expect(q.state().current?.items[0].state).toBe("running");
    q.observe(qa("run0", "finished"));
    await settle();
    expect(pieEnds).toEqual([RUNNER]);
    expect(runnerLease.get()).toBeNull();
    expect(q.state().recent[0].items[0].state).toBe("passed");
  });

  it("plays an attended plan on the workspace editor", async () => {
    const q = new PlanQueue({ dataDir: root, runner: runner(), lease: workspace });
    q.enqueue(plan({ attended: true }));
    await settle();
    expect(q.heldBy()).toBe(WORKSPACE);
    expect(workspace.get()?.runId).toBe("run0");
    expect(runnerLease.get()).toBeNull();
  });

  it("puts the runner's item back when the runner goes", async () => {
    const q = new PlanQueue({ dataDir: root, runner: runner(), lease: workspace });
    q.enqueue(plan({ attended: false }));
    await settle();
    q.editorLost(undefined, RUNNER);
    expect(q.state().current?.items[0].state).toBe("queued");
    expect(runnerLease.get()).toBeNull();
    expect(q.heldBy()).toBeNull();
  });
});

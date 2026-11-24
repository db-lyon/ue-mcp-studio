/**
 * Start playtest ends the Play In Editor session its run started, whichever
 * way the run ends: passed, failed, error, no verdict, aborted, stopped from
 * the card, or Studio stopping with the daemon. PIE that was playing before
 * the run, PIE that ended the run, PIE another session's call is using, and
 * a plan run the Playtest Hub ends itself are left alone.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ActionResult } from "ue-mcp/daemon";
import { qaDraftId, type BusyCall, type QaRun } from "@ue-mcp-studio/shared";
import { SessionStore } from "../src/sessions.js";
import { QaBroker, type QaHost } from "../src/qa.js";
import { until } from "./loop-fakes.js";

const PATH = "/Game/PIEStudio/Scripts/DoorOpens";
const RUN = "script_DoorOpens_1";
const STEPS = [
  { instruction: "Walk up to the door", judge: "auto", expect: { value: "Door.Distance", op: "decreasing" } },
  { instruction: "It looks right", judge: "manual" },
];
const ok = (body: Record<string, unknown>): ActionResult => ({ isError: false, content: [{ type: "text", text: JSON.stringify({ success: true, ...body }) }] });
const steps = (statuses: string[]) => STEPS.map((s, index) => ({ ...s, index, status: statuses[index] }));

let root: string;
let calls: Array<{ category: string; action: string; args: Record<string, unknown> }>;
/** PIE plays in the fake editor, whoever started it. */
let pie: boolean;
/** script_run's PIE start is still queued when it answers. */
let pieLate: boolean;
/** script_run throws instead of answering, after starting the run. */
let lose: boolean;
/** The run as the fake editor reports it. */
let status: Record<string, unknown>;
let busy: BusyCall[];

const stops = () => calls.filter((c) => c.action === "play_in_editor" && c.args.pieAction === "stop").length;

const host = (): QaHost => ({
  projectDir: path.join(root, "project"),
  callAction: async (category: string, action: string, args: Record<string, unknown> = {}) => {
    calls.push({ category, action, args });
    switch (action) {
      case "script_run": {
        // As ue-mcp does: start_pie starts PIE only when none plays, and says whether it did.
        const started = args.start_pie === true && !pie;
        if (started && !pieLate) pie = true;
        status = { run_id: RUN, script: PATH, script_name: "DoorOpens", state: "armed", steps: steps(["pending", "pending"]), awaiting: [], last_seq: 1, pie_started: started };
        if (lose) throw new Error("the bridge closed before the answer");
        return ok(status);
      }
      case "script_status":
      case "script_results":
        return ok(status);
      case "script_stop":
        status = { ...status, state: "stopped", stop_reason: args.reason };
        return ok({ stopped: true });
      case "play_in_editor":
        if (args.pieAction === "status") return ok({ isPlaying: pie });
        if (args.pieAction === "stop") {
          if (!pie) return ok({ success: false, error: "No PIE session active", alreadyStopped: true });
          pie = false;
        }
        return ok({});
      default:
        return ok({});
    }
  },
  editors: () => [{ connected: true }],
  events: { publish: () => undefined, subscribe: () => () => {} },
  log: { warn() {} },
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-pie-end-"));
  calls = [];
  pie = false;
  pieLate = false;
  lose = false;
  status = {};
  busy = [];
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

async function setup() {
  const store = new SessionStore(path.join(root, "data"));
  const broker = new QaBroker({ host: host(), store, busy: () => ({ now: Date.now(), calls: busy }), pieWaits: { startMs: 200, inUseMs: 200, pollMs: 5 }, now: () => "2026-11-24T12:00:00.000Z" });
  const s = store.create();
  await broker.drafted(s.id, { path: PATH, name: "DoorOpens", steps: STEPS });
  return { broker, s };
}

/** The run ends as the fake editor reports it, and Studio reads it. */
async function end(broker: QaBroker, patch: Record<string, unknown>): Promise<QaRun | null> {
  status = { ...status, ...patch, last_seq: 9 };
  const r = await broker.status(RUN);
  return "run" in r ? r.run : null;
}

const settle = () => new Promise((r) => setTimeout(r, 300));

describe("Start playtest ends the PIE its run started", () => {
  it.each([
    ["passed", { state: "finished", steps: steps(["passed", "passed"]) }],
    ["failed", { state: "finished", steps: steps(["failed", "skipped"]) }],
    ["error", { state: "finished", steps: steps(["pending", "pending"]), stop_reason: "observation ended" }],
    ["no verdict", { state: "stopped", steps: steps(["passed", "awaiting_verdict"]), stop_reason: "no verdict" }],
    ["aborted", { state: "stopped", steps: steps(["passed", "pending"]), stop_reason: "aborted" }],
  ])("when the run ends %s", async (_how, patch) => {
    const { broker } = await setup();
    const r = await broker.runScript(qaDraftId(PATH), {});
    expect("run" in r && r.run.pieStarted).toBe(true);
    expect(pie).toBe(true);
    await end(broker, { state: "running" });
    await end(broker, patch);
    await until(() => stops() === 1);
    expect(stops()).toBe(1);
    expect(pie).toBe(false);
  });

  it("when the card's Stop ends the run, once", async () => {
    const { broker } = await setup();
    await broker.runScript(qaDraftId(PATH), {});
    await end(broker, { state: "running" });
    expect("run" in (await broker.stopRun(RUN))).toBe(true);
    await settle();
    expect(stops()).toBe(1);
    expect(pie).toBe(false);
  });

  it("when its PIE comes up only after the run ended", async () => {
    pieLate = true;
    const { broker } = await setup();
    await broker.runScript(qaDraftId(PATH), {});
    setTimeout(() => (pie = true), 30);
    await end(broker, { state: "stopped", stop_reason: "Stopped from its card" });
    await until(() => stops() === 1);
    expect(stops()).toBe(1);
    expect(pie).toBe(false);
  });

  it("when the call's answer is lost after the editor started PIE", async () => {
    lose = true;
    const { broker } = await setup();
    const r = await broker.runScript(qaDraftId(PATH), {});
    expect("error" in r).toBe(true);
    await until(() => stops() === 1);
    expect(stops()).toBe(1);
    expect(pie).toBe(false);
  });

  it("after another session's PIE call finishes, and not at all while one outlasts the wait", async () => {
    const { broker } = await setup();
    await broker.runScript(qaDraftId(PATH), {});
    busy = [{ id: 1, category: "pie", action: "inject_input", startedAt: 0, source: "client", client: "other", stopped: false }];
    setTimeout(() => (busy = []), 50);
    await end(broker, { state: "finished", steps: steps(["passed", "passed"]) });
    await until(() => stops() === 1);
    expect(stops()).toBe(1);

    // The card runs again; another chat's play_in_editor call does not finish in time.
    await broker.runScript(RUN, {});
    busy = [{ id: 2, category: "editor", action: "play_in_editor", startedAt: 0, source: "studio", sessionId: "other-chat", stopped: false }];
    await end(broker, { state: "finished", steps: steps(["passed", "passed"]) });
    await settle();
    expect(stops()).toBe(1);
    expect(pie).toBe(true);
  });

  it("when Studio stops with the daemon mid-run", async () => {
    const { broker } = await setup();
    await broker.runScript(qaDraftId(PATH), {});
    await broker.shutdown();
    expect(calls.filter((c) => c.action === "script_stop").map((c) => c.args)).toEqual([{ run_id: RUN, reason: "Studio stopped" }]);
    expect(stops()).toBe(1);
    expect(pie).toBe(false);
  });
});

describe("Start playtest leaves PIE alone", () => {
  it("when PIE was playing before the run", async () => {
    pie = true;
    const { broker } = await setup();
    await broker.runScript(qaDraftId(PATH), {});
    await end(broker, { state: "finished", steps: steps(["passed", "passed"]) });
    await settle();
    expect(stops()).toBe(0);
    expect(pie).toBe(true);
  });

  it("when PIE ending is what ended the run", async () => {
    const { broker } = await setup();
    await broker.runScript(qaDraftId(PATH), {});
    await end(broker, { state: "running" });
    // Someone stopped PIE and started their own before Studio read the run's end.
    await end(broker, { state: "finished", steps: steps(["passed", "pending"]), stop_reason: "PIE ended" });
    await settle();
    expect(stops()).toBe(0);
  });

  it("when the Playtest Hub runs it, since the hub ends its plan runs' PIE itself", async () => {
    const { broker } = await setup();
    await broker.runScript(qaDraftId(PATH), { startPie: true, endPie: false });
    await end(broker, { state: "finished", steps: steps(["passed", "passed"]) });
    await settle();
    expect(stops()).toBe(0);
    expect(calls.some((c) => c.action === "play_in_editor" && c.args.pieAction === "status")).toBe(false);
  });

  it("when Studio stops with nothing running", async () => {
    const { broker } = await setup();
    await broker.shutdown();
    expect(calls).toEqual([]);
  });
});

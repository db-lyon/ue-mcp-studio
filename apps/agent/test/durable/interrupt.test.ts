/**
 * A message sent while the main agent replies on the durable runtime reaches
 * it in that reply: an answer in progress (a long think) stops and the model
 * replies to the message at once, with what came before kept; a tool call in
 * progress finishes first, and the message lands after it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runHarness } from "../../src/durable/harness-main.js";
import { answeringTask } from "../../src/durable/pi.js";
import { durableRunner, editorCalls, until, type DurableRig } from "./helpers.js";
import { startFakeAnthropic, type FakeAnthropic } from "./fake-anthropic.js";

let dir: string;
let fake: FakeAnthropic;
let harness: { close(): Promise<void> } | null;
let rig: DurableRig;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-interrupt-"));
  fs.mkdirSync(path.join(dir, "project"));
  fs.mkdirSync(path.join(dir, "data"));
  harness = null;
});

afterEach(async () => {
  rig?.runner.dispose();
  await harness?.close();
  await fake?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const start = async (launch: Parameters<typeof runHarness>[0]) => {
  harness = await runHarness(launch);
};

const users = (sessionId: string) => rig.store.get(sessionId)!.transcript.filter((e) => e.kind === "user").map((e) => (e.kind === "user" ? e.text : ""));

describe("which run task a steer may stop", () => {
  it("is the run's task only while the model answers", () => {
    expect(answeringTask(undefined)).toBeNull();
    expect(answeringTask({})).toBeNull();
    expect(answeringTask({ run: { taskId: 7 }, generation: { attempt: 1 } })).toBe(7);
    expect(answeringTask({ run: { taskId: 7 }, generation: { attempt: 2, retry: { at: 1, error: "overloaded" } } })).toBe(7);
    // A tool round runs: the steer waits for it.
    expect(answeringTask({ run: { taskId: 7 }, tools: [{ callId: "a" }] })).toBeNull();
    expect(answeringTask({ run: { taskId: 7 }, generation: { attempt: 1 }, tools: [{ callId: "a" }] })).toBeNull();
    // Between requests, or after the answer while after-run work drains.
    expect(answeringTask({ run: { taskId: 7 } })).toBeNull();
    expect(answeringTask({ run: { taskId: 7, afterRun: {} }, generation: { attempt: 1 } })).toBeNull();
  });
});

describe("a message during a durable reply", () => {
  it("stops a long think and is answered at once, in the same turn", async () => {
    fake = await startFakeAnthropic(({ userText }) => (userText.includes("speak plain")
      ? { text: "Plainly: still checking." }
      : { thinking: "Weighing every actor in the level one by one. ".repeat(120), text: "Done thinking.", paceMs: 40 }));
    rig = durableRunner({ projectDir: path.join(dir, "project"), dataDir: path.join(dir, "data"), base: fake.base, start });
    const s = rig.store.create("t");
    await rig.runner.send(s.id, "check the level");
    await until(() => rig.host.published.some((p) => p.type === "turn.thinking" && p.data?.sessionId === s.id), 30_000, "the think to stream");

    const sent = Date.now();
    await rig.runner.send(s.id, "speak plain");
    // Not queued behind the turn: it reached the harness.
    expect(rig.store.get(s.id)!.queue ?? []).toEqual([]);
    await until(() => fake.requests.some((r) => r.userText.includes("speak plain")), 10_000, "the message's request");
    // The think would have run about 15 s more.
    expect(Date.now() - sent).toBeLessThan(5000);

    await until(() => rig.store.get(s.id)!.status === "idle" && rig.store.get(s.id)!.transcript.some((e) => e.kind === "assistant" && e.text === "Plainly: still checking."), 30_000, "the reply");
    // One turn: it never went idle between the stopped answer and the reply.
    expect(rig.host.published.filter((p) => p.type === "session.changed" && p.data?.sessionId === s.id).map((p) => p.data?.status).filter((x, i, a) => x !== a[i - 1])).toEqual(["running", "idle"]);
    expect(users(s.id)).toEqual(["check the level", "speak plain"]);
    expect(rig.store.get(s.id)!.error ?? null).toBeNull();
    // The first message is in the context the reply was asked on.
    const asked = fake.requests.find((r) => r.userText.includes("speak plain"))!;
    expect(asked.userText).toContain("check the level");
    expect(rig.store.get(s.id)!.transcript.some((e) => e.kind === "assistant" && e.text === "Done thinking.")).toBe(false);
  }, 60_000);

  it("lets a running tool call finish, then lands after it", async () => {
    fake = await startFakeAnthropic(({ toolResults, userText }) => {
      if (toolResults === 0) return { tool: { name: "ue_mcp", input: { action: "call", category: "level", method: "get_info", args: {} } } };
      return { text: userText.includes("also count them") ? "Listed and counted." : "Listed." };
    });
    rig = durableRunner({ projectDir: path.join(dir, "project"), dataDir: path.join(dir, "data"), base: fake.base, start });
    rig.host.callMs = 1500;
    const s = rig.store.create("t");
    await rig.runner.send(s.id, "look at the level");
    await until(() => editorCalls(path.join(dir, "data")).some((c) => c.category === "level"), 20_000, "the tool call");

    await rig.runner.send(s.id, "also count them");
    await until(() => rig.store.get(s.id)!.status === "idle", 30_000, "the turn to end");
    const t = rig.store.get(s.id)!.transcript;
    const call = t.find((e) => e.kind === "tool" && e.call.name === "ue_mcp");
    // The call was not stopped.
    expect(call?.kind === "tool" && call.call.outcome).toBe("done");
    expect(t.some((e) => e.kind === "assistant" && e.text === "Listed and counted.")).toBe(true);
    // One model request after the tool round, carrying both the call's result and the message.
    const after = fake.requests.filter((r) => r.toolResults === 1);
    expect(after).toHaveLength(1);
    expect(after[0].userText).toContain("also count them");
    expect(users(s.id)).toEqual(["look at the level", "also count them"]);
  }, 60_000);

  it("keeps a /command queued for the turn's end", async () => {
    fake = await startFakeAnthropic(() => ({ text: "A long answer that takes its time to stream. ".repeat(20), paceMs: 40 }));
    rig = durableRunner({ projectDir: path.join(dir, "project"), dataDir: path.join(dir, "data"), base: fake.base, start });
    const s = rig.store.create("t");
    await rig.runner.send(s.id, "write something long");
    await until(() => rig.host.published.some((p) => p.type === "turn.delta" && p.data?.sessionId === s.id), 30_000, "the answer to stream");
    rig.runner.enqueue(s.id, "/compact", []);
    expect((rig.store.get(s.id)!.queue ?? []).map((q) => q.text)).toEqual(["/compact"]);
  }, 60_000);
});

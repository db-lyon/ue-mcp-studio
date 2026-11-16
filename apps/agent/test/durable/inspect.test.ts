/**
 * Inspecting the durable runtime: its live tasks and queued messages by
 * Studio session, read without starting anything.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runHarness } from "../../src/durable/harness-main.js";
import { durableRunner, until, type DurableRig } from "./helpers.js";
import { startFakeAnthropic, type FakeAnthropic } from "./fake-anthropic.js";

let dir: string;
let fake: FakeAnthropic;
let harness: { close(): Promise<void> } | null;
let rig: DurableRig;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-inspect-"));
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

describe("durable runtime inspect", () => {
  it("says nothing is running before the first reply, without starting a runtime", async () => {
    fake = await startFakeAnthropic(() => ({ text: "Hi." }));
    rig = durableRunner({ projectDir: path.join(dir, "project"), dataDir: path.join(dir, "data"), base: fake.base, start });
    const seen = await rig.runner.durableInspect();
    expect(seen.running).toBe(false);
    expect(seen.running === false && seen.note).toContain("starts with the next reply");
    expect(harness).toBeNull();
  });

  it("lists a turn's live tasks under its Studio session while a call waits, and none once it ends", async () => {
    fake = await startFakeAnthropic(({ toolResults }) => toolResults === 0
      ? { tool: { name: "shell", input: { command: "echo inspect" } } }
      : { text: "Ran it." });
    rig = durableRunner({ projectDir: path.join(dir, "project"), dataDir: path.join(dir, "data"), base: fake.base, start, extra: { askBeforeChanges: () => true } });
    const s = rig.store.create("t");
    await rig.runner.send(s.id, "run echo");
    await until(() => (rig.store.get(s.id)!.approvals ?? []).length === 1, 30_000, "the approval");

    const waiting = await rig.runner.durableInspect();
    expect(waiting.running).toBe(true);
    if (!waiting.running) return;
    expect(waiting.version).toBe("0.0.0-test");
    const mine = waiting.tasks.filter((t) => t.sessionId === s.id);
    expect(mine.map((t) => t.kind)).toEqual(expect.arrayContaining(["pi.generation", "pi.tool"]));
    expect(mine.find((t) => t.kind === "pi.tool")?.parent).toBeNull();

    rig.runner.answerApproval(s.id, rig.store.get(s.id)!.approvals![0].id, "allow");
    await until(() => rig.store.get(s.id)!.status === "idle", 30_000, "the turn to end");
    const after = await rig.runner.durableInspect();
    expect(after.running && after.tasks.filter((t) => t.sessionId === s.id)).toEqual([]);
  }, 60_000);

  it("says how to go on when the running runtime is from an older Studio and does not answer", async () => {
    fake = await startFakeAnthropic(() => ({ text: "Hi." }));
    rig = durableRunner({ projectDir: path.join(dir, "project"), dataDir: path.join(dir, "data"), base: fake.base, start });
    const s = rig.store.create("t");
    await rig.runner.send(s.id, "hello");
    await until(() => rig.store.get(s.id)!.status === "idle", 30_000, "the turn to end");
    const client = (rig.runner as unknown as { durable: { client: { call: (...a: unknown[]) => Promise<unknown> } } }).durable.client;
    client.call = () => Promise.reject(new Error("the durable harness did not answer inspect"));
    await expect(rig.runner.durableInspect()).rejects.toThrow(/replaced by this Studio's once no reply is running; ask again/);
  }, 60_000);
});

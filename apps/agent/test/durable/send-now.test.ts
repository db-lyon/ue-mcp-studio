/**
 * Send now on the durable runtime: the running reply stops and the new
 * message is answered at once, not after a fixed wait for the stopped run's
 * end, and that end is never taken for the new reply's.
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-sendnow-"));
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

describe("durable send now", () => {
  it("answers the new message without waiting out the stopped run", async () => {
    fake = await startFakeAnthropic(({ userText }) => (userText.includes("instead")
      ? { text: "Doing that instead." }
      : { text: "A long answer that takes its time to stream. ".repeat(20), paceMs: 40 }));
    rig = durableRunner({ projectDir: path.join(dir, "project"), dataDir: path.join(dir, "data"), base: fake.base, start });
    const s = rig.store.create("t");
    await rig.runner.send(s.id, "write something long");
    await until(() => rig.host.published.some((p) => p.type === "turn.delta" && p.data?.sessionId === s.id), 30_000, "the first answer to stream");

    const sent = Date.now();
    await rig.runner.sendNow(s.id, "do this instead");
    await until(() => fake.requests.some((r) => r.userText.includes("instead")), 10_000, "the new message's request");
    // A fixed wait for the stopped run's end took 3 s; the settled stop answers once that end is sent.
    expect(Date.now() - sent).toBeLessThan(2500);

    await until(() => rig.store.get(s.id)!.status === "idle" && rig.store.get(s.id)!.transcript.some((e) => e.kind === "assistant" && e.text === "Doing that instead."), 30_000, "the new reply");
    const t = rig.store.get(s.id)!.transcript;
    expect(t.filter((e) => e.kind === "user").map((e) => e.kind === "user" && e.text)).toEqual(["write something long", "do this instead"]);
    expect(rig.store.get(s.id)!.error ?? null).toBeNull();
  }, 60_000);

  it("does not wait for an end that never comes when the stop found nothing running", async () => {
    fake = await startFakeAnthropic(({ userText }) => ({ text: userText.includes("second") ? "Second." : "First." }));
    rig = durableRunner({ projectDir: path.join(dir, "project"), dataDir: path.join(dir, "data"), base: fake.base, start });
    const s = rig.store.create("t");
    await rig.runner.send(s.id, "first");
    await until(() => rig.store.get(s.id)!.status === "idle", 30_000, "the first turn");
    // A stop that reaches the harness after the run ended on its own: no run end follows it.
    const durable = (rig.runner as unknown as { durable: { stop(s: unknown, children: boolean): void } }).durable;
    durable.stop(rig.store.get(s.id)!, false);
    const sent = Date.now();
    await rig.runner.send(s.id, "second");
    await until(() => fake.requests.some((r) => r.userText.includes("second")), 10_000, "the second request");
    expect(Date.now() - sent).toBeLessThan(2000);
    await until(() => rig.store.get(s.id)!.status === "idle" && rig.store.get(s.id)!.transcript.some((e) => e.kind === "assistant" && e.text === "Second."), 30_000, "the second reply");
  }, 60_000);
});

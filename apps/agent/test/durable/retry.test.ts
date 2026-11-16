/** A passing fault from the provider (an overloaded 529, a 503) is retried by the harness, and the reply goes on. */
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-retry-"));
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

describe("a passing fault from the provider", () => {
  it("is retried, and the reply answers instead of ending", async () => {
    let n = 0;
    fake = await startFakeAnthropic(() => (++n <= 2 ? { status: n === 1 ? 529 : 503 } : { text: "Here is the answer." }));
    rig = durableRunner({ projectDir: path.join(dir, "project"), dataDir: path.join(dir, "data"), base: fake.base, start: async (l) => void (harness = await runHarness(l)) });
    const s = rig.store.create("t");
    await rig.runner.send(s.id, "hello");
    await until(() => ["idle", "error"].includes(rig.store.get(s.id)!.status), 60_000, "the reply to end");
    const after = rig.store.get(s.id)!;
    expect(after.status).toBe("idle");
    expect(after.transcript.filter((e) => e.kind === "assistant").map((e) => (e as { text: string }).text)).toEqual(["Here is the answer."]);
    expect(n).toBe(3);
  }, 90_000);
});

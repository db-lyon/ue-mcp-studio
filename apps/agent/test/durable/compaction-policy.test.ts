/**
 * The durable runtime compacts where the context meter says: at 85% of the
 * window the meter shows, not at Pi Durable's default of the window less 16k
 * tokens (about 98% of a 1M window).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AUTO_COMPACT_FRACTION } from "@ue-mcp-studio/shared";
import { runHarness } from "../../src/durable/harness-main.js";
import { COMPACT_FRACTION, backgroundFor, reserveFor } from "../../src/durable/pi.js";
import { durableRunner, until, type DurableRig } from "./helpers.js";
import { startFakeAnthropic, type FakeAnthropic } from "./fake-anthropic.js";

describe("reserveFor", () => {
  it("is the meter's fraction", () => {
    expect(COMPACT_FRACTION).toBe(AUTO_COMPACT_FRACTION);
  });

  it("puts the threshold at 85% of the window", () => {
    expect(1_000_000 - reserveFor(1_000_000)).toBe(850_000);
    expect(200_000 - reserveFor(200_000)).toBe(170_000);
  });

  it("follows the smaller of the model's window and the one the meter shows", () => {
    expect(1_000_000 - reserveFor(1_000_000, 200_000)).toBe(170_000);
    expect(200_000 - reserveFor(200_000, 1_000_000)).toBe(170_000);
  });

  it("keeps room for the summary request on a small window", () => {
    expect(reserveFor(32_000)).toBe(16_384);
  });

  it("starts a background compaction at most 5% of the window early", () => {
    expect(backgroundFor(1_000_000)).toBe(32_768);
    expect(backgroundFor(100_000)).toBe(5_000);
  });
});

let dir: string;
let fake: FakeAnthropic;
let harness: { close(): Promise<void> } | null;
let rig: DurableRig;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-compact-"));
  fs.mkdirSync(path.join(dir, "project"));
  fs.mkdirSync(path.join(dir, "data"));
  harness = null;
});

afterEach(async (ctx) => {
  if (ctx.task.result?.state === "fail") {
    const log = path.join(dir, "data", "durable", "harness.log");
    console.log("HARNESS LOG\n", fs.existsSync(log) ? fs.readFileSync(log, "utf-8") : "(none)");
    console.log("REQUESTS", JSON.stringify(fake?.requests.map((r) => r.tools.length)));
    for (const s of rig?.store.all() ?? []) console.log("SESSION", JSON.stringify(s.transcript).slice(0, 1500));
  }
  rig?.runner.dispose();
  await harness?.close();
  await fake?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Words enough that a message is more than Pi Durable keeps verbatim (20k tokens), so a compaction has something to summarize. */
const LONG = " the level's lighting and its actors".repeat(3000);

/**
 * Three turns on long messages: the second answer reports `filled` tokens of
 * context, so the third request is where a compaction would go.
 */
async function threeTurns(shownWindow: number, filled: number) {
  fake = await startFakeAnthropic(({ userText }) => (userText.includes("third message") ? { text: "Done." } : userText.includes("second message") ? { text: "Second answer.", inputTokens: filled } : { text: "First answer." }));
  rig = durableRunner({
    projectDir: path.join(dir, "project"),
    dataDir: path.join(dir, "data"),
    base: fake.base,
    start: async (launch) => {
      harness = await runHarness(launch);
    },
    extra: { contextWindow: () => shownWindow },
  });
  const s = rig.store.create("t");
  const answered = (text: string) => () => rig.store.get(s.id)!.status === "idle" && rig.store.get(s.id)!.transcript.some((e) => e.kind === "assistant" && e.text === text);
  await rig.runner.send(s.id, `first message${LONG}`);
  await until(answered("First answer."), 30_000, "the first turn to end");
  await rig.runner.send(s.id, `second message${LONG}`);
  await until(answered("Second answer."), 30_000, "the second turn to end");
  await rig.runner.send(s.id, "third message");
  await until(answered("Done."), 30_000, "the third turn to end");
  return rig.store.get(s.id)!.transcript;
}

describe("durable compaction threshold", () => {
  it("compacts a conversation past 85% of the window the meter shows", async () => {
    const t = await threeTurns(100_000, 90_000);
    expect(t.some((e) => e.kind === "compaction")).toBe(true);
  }, 60_000);

  it("leaves one below it alone", async () => {
    const t = await threeTurns(100_000, 70_000);
    expect(t.some((e) => e.kind === "compaction")).toBe(false);
  }, 60_000);
});

/**
 * A flow agent step's one-off completion, answered by the durable harness on
 * the session route: one request with the system prompt and the prompt, no
 * tools, nothing stored as a conversation.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runHarness } from "../../src/durable/harness-main.js";
import { studioFlowModel } from "../../src/flow-model.js";
import { durableRunner, type DurableRig } from "./helpers.js";
import { startFakeAnthropic, type FakeAnthropic } from "./fake-anthropic.js";

let dir: string;
let fake: FakeAnthropic;
let harness: { close(): Promise<void> } | null;
let rig: DurableRig;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-complete-"));
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

describe("a flow agent step's completion", () => {
  it("is one request on the route with the system prompt and the prompt, and no tools", async () => {
    fake = await startFakeAnthropic(() => ({ text: "unused" }));
    rig = durableRunner({ projectDir: path.join(dir, "project"), dataDir: path.join(dir, "data"), base: fake.base, start });
    const text = await rig.runner.complete("You write scripts.", "Write one.", "medium");
    // The stand-in answers a request without Studio's tools with "ok".
    expect(text).toBe("ok");
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].system).toContain("You write scripts.");
    expect(fake.requests[0].tools).toEqual([]);
    expect(JSON.stringify(fake.requests[0].messages)).toContain("Write one.");
    expect(fake.requests[0].model).toBe("claude-opus-5-5");
  }, 30_000);

  it("answers through the flow model hook, with the JSON parsed", async () => {
    fake = await startFakeAnthropic(() => ({ text: "unused" }));
    rig = durableRunner({ projectDir: path.join(dir, "project"), dataDir: path.join(dir, "data"), base: fake.base, start });
    const model = studioFlowModel({ model: () => "claude-opus-5-5", effort: () => "high", complete: (s, p, e, sig) => rig.runner.complete(s, p, e, sig) });
    const r = await model.complete({ prompt: "Say ok." });
    expect(r.text).toBe("ok");
    expect(r.model).toBe("claude-opus-5-5");
  }, 30_000);

  it("stops waiting when the step is aborted", async () => {
    fake = await startFakeAnthropic(() => ({ text: "unused" }));
    rig = durableRunner({ projectDir: path.join(dir, "project"), dataDir: path.join(dir, "data"), base: fake.base, start });
    const c = new AbortController();
    c.abort();
    await expect(rig.runner.complete("s", "p", "high", c.signal)).rejects.toThrow(/Stopped before the model answered/);
  }, 30_000);
});

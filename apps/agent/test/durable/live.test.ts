/**
 * What a running turn shows before it lands in the transcript: the model's
 * thinking as turn.thinking, and a running command's output as tool.output.
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-live-"));
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

const published = (type: string, sessionId: string) => rig.host.published.filter((p) => p.type === type && p.data?.sessionId === sessionId);

describe("live parts of a durable turn", () => {
  it("streams the model's thinking as turn.thinking, and keeps it out of the transcript", async () => {
    fake = await startFakeAnthropic(() => ({ thinking: "The level has three actors, so check each one.", text: "All three are fine.", paceMs: 20 }));
    rig = durableRunner({ projectDir: path.join(dir, "project"), dataDir: path.join(dir, "data"), base: fake.base, start });
    const s = rig.store.create("t");
    await rig.runner.send(s.id, "check the actors");
    await until(() => rig.store.get(s.id)!.status === "idle" && rig.store.get(s.id)!.transcript.some((e) => e.kind === "assistant"), 30_000, "the turn");
    const thought = published("turn.thinking", s.id).map((p) => String(p.data?.text ?? "")).join("");
    expect(thought).toBe("The level has three actors, so check each one.");
    expect(JSON.stringify(rig.store.get(s.id)!.transcript)).not.toContain("three actors, so check");
  }, 60_000);

  it("streams a running command's output as tool.output under its call", async () => {
    fake = await startFakeAnthropic(({ toolResults }) => toolResults === 0
      ? { tool: { name: "shell", input: { command: "echo first line && echo second line" } } }
      : { text: "Ran it." });
    rig = durableRunner({ projectDir: path.join(dir, "project"), dataDir: path.join(dir, "data"), base: fake.base, start });
    const s = rig.store.create("t");
    await rig.runner.send(s.id, "run it");
    await until(() => rig.store.get(s.id)!.status === "idle" && rig.store.get(s.id)!.transcript.some((e) => e.kind === "assistant" && e.text === "Ran it."), 30_000, "the turn");
    const call = rig.store.get(s.id)!.transcript.find((e) => e.kind === "tool");
    const out = published("tool.output", s.id);
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((p) => call?.kind === "tool" && p.data?.callId === call.call.id)).toBe(true);
    const text = out.map((p) => String(p.data?.text ?? "")).join("");
    expect(text).toContain("first line");
    expect(text).toContain("second line");
  }, 60_000);
});

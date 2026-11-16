/**
 * #463 L5: a background subagent's report is delivered by a durable reporter
 * task, and subagent conversations are owned by the session's anchor task.
 * Both are visible in the runtime's inspection like any other task.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runHarness } from "../../src/durable/harness-main.js";
import { durableRunner, until, type DurableRig } from "./helpers.js";
import { startFakeAnthropic, type FakeAnthropic } from "./fake-anthropic.js";

let dir: string;
let fake: FakeAnthropic | undefined;
let harness: { close(): Promise<void> } | null;
let rig: DurableRig | undefined;

const start = async (launch: Parameters<typeof runHarness>[0]) => {
  harness = await runHarness(launch);
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-l5-"));
  fs.mkdirSync(path.join(dir, "project"));
  fs.mkdirSync(path.join(dir, "data"));
  harness = null;
  fake = undefined;
  rig = undefined;
});

afterEach(async () => {
  rig?.runner.dispose();
  await harness?.close();
  await fake?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("subagents on Pi Durable tasks", () => {
  it("delivers an assigned subagent's report through a reporter task, under the session's anchor, once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    fake = await startFakeAnthropic(({ toolResults, system }) => {
      if (system.includes("You are a subagent")) return toolResults === 0 ? { tool: { name: "ue_mcp", input: { action: "call", category: "level", method: "play", args: {} } } } : { text: "Report: done." };
      return { text: "The main agent should not run." };
    });
    rig = durableRunner({ projectDir: path.join(dir, "project"), dataDir: path.join(dir, "data"), base: fake.base, start });
    // The subagent's editor call waits, so the tasks can be looked at while it runs.
    const calls = rig.host.callAction.bind(rig.host);
    rig.host.callAction = async (c, a, args) => {
      if (c === "level") await gate;
      return calls(c, a, args);
    };
    const s = rig.store.create("t");
    const { done } = rig.runner.assignSubagent(s.id, "Playtest the door", "Open the door in PIE.");

    let kinds: string[] = [];
    for (const end = Date.now() + 30_000; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
      const seen = await rig.runner.durableInspect();
      kinds = seen.running ? seen.tasks.filter((t) => t.sessionId === s.id).map((t) => t.kind) : [];
      if (kinds.includes("studio.reporter") && kinds.includes("studio.subagents")) break;
    }
    expect(kinds).toContain("studio.reporter");
    expect(kinds).toContain("studio.subagents");

    release();
    expect(await done).toMatchObject({ text: "Report: done.", isError: false });
    // Reported once, and its reporter is done; the anchor stays for the session's next subagent.
    await until(() => rig!.store.get(s.id)!.notes.join("\n").includes("Report: done."), 30_000, "the report");
    let after: string[] = [];
    for (const end = Date.now() + 10_000; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
      const seen = await rig.runner.durableInspect();
      after = seen.running ? seen.tasks.map((t) => t.kind) : [];
      if (!after.includes("studio.reporter")) break;
    }
    expect(after).not.toContain("studio.reporter");
    expect(after).toContain("studio.subagents");
    expect(rig.store.get(s.id)!.notes.join("\n").match(/Report: done\./g)?.length).toBe(1);
  }, 90_000);
});

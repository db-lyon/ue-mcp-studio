/**
 * #463 L4: code mode on the durable runtime. One script makes many editor
 * calls through Studio's own ue_mcp tool (each through the daemon's editor
 * wait and gate), and only its output goes back to the model.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runHarness } from "../../src/durable/harness-main.js";
import { durableRunner, editorCalls, until, type DurableRig } from "./helpers.js";
import { startFakeAnthropic, type FakeAnthropic } from "./fake-anthropic.js";

let dir: string;
let fake: FakeAnthropic | undefined;
let harness: { close(): Promise<void> } | null;
let rig: DurableRig | undefined;

const start = async (launch: Parameters<typeof runHarness>[0]) => {
  harness = await runHarness(launch);
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-l4-"));
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
  // A bundled harness runs detached: the one this test started is stopped here. (In-process, its record names this process.)
  try {
    const pid = (JSON.parse(fs.readFileSync(path.join(dir, "data", "durable", "harness.json"), "utf-8")) as { pid: number }).pid;
    if (process.env.STUDIO_BUNDLED_HARNESS && pid !== process.pid) process.kill(pid);
  } catch {
    // Gone.
  }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

const SCRIPT = [
  "const out = [];",
  "for (const method of [\"get_info\", \"list_actors\", \"get_selection\"]) {",
  "  out.push(await tools.ue_mcp({ action: \"call\", category: \"level\", method, args: {} }));",
  "}",
  "return out.join(\"\\n\");",
].join("\n");

describe("code mode on the durable runtime", () => {
  it("offers the codemode tool, runs a script's editor calls through Studio's tool, and gives the model only its output", async () => {
    fake = await startFakeAnthropic(({ toolResults }) => toolResults === 0
      ? { tool: { name: "codemode", input: { code: SCRIPT } } }
      : { text: "Three calls, one result." });
    // STUDIO_BUNDLED_HARNESS=<dist/durable-harness.js> runs it on the bundled harness in its own process, which checks
    // that the sandbox's worker and QuickJS ship beside it.
    const bundled = process.env.STUDIO_BUNDLED_HARNESS;
    rig = durableRunner({ projectDir: path.join(dir, "project"), dataDir: path.join(dir, "data"), base: fake.base, ...(bundled ? { script: bundled } : { start }) });
    const s = rig.store.create("t");
    await rig.runner.send(s.id, "check the level three ways");
    await until(() => rig!.store.get(s.id)!.status === "idle", 60_000, "the turn to end");

    expect(fake.requests[0].tools).toContain("codemode");
    expect(fake.requests[0].tools).toContain("ue_mcp");
    // The script's calls ran in the editor, each once, through the daemon.
    expect(editorCalls(path.join(dir, "data")).filter((c) => c.category === "level").map((c) => c.action)).toEqual(["get_info", "list_actors", "get_selection"]);
    const t = rig.store.get(s.id)!.transcript;
    const tools = t.filter((e) => e.kind === "tool");
    expect(tools).toHaveLength(1);
    const cm = tools[0];
    expect(cm.kind === "tool" && cm.call.name).toBe("codemode");
    expect(cm.kind === "tool" && cm.call.outcome).toBe("done");
    expect(cm.kind === "tool" && cm.call.result).toContain("level.get_selection");
    expect(t.at(-1)).toMatchObject({ kind: "assistant", text: "Three calls, one result." });
    // One model request for the script, one for the answer: no round trip per editor call.
    expect(fake.requests).toHaveLength(2);
  }, 90_000);
});

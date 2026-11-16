/**
 * #463 L3: Studio's local tools run in the durable harness, with the daemon's
 * approval gate as a beforeTool hook. The kill suite's "mid tool call, shell
 * side" case shows what it buys: a daemon that dies mid-command no longer
 * makes the outcome unknown.
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-l3-"));
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

const project = () => path.join(dir, "project");
const rigWith = (base: string, ask: boolean) => durableRunner({ projectDir: project(), dataDir: path.join(dir, "data"), base, start, extra: { askBeforeChanges: () => ask } });
const toolEntry = (r: DurableRig, id: string) => r.store.get(id)!.transcript.find((e) => e.kind === "tool");

describe("local tools in the durable harness", () => {
  it("blocks a call the user declines through the approval hook: it never runs, and the model is told why", async () => {
    fake = await startFakeAnthropic(({ toolResults }) => toolResults === 0
      ? { tool: { name: "write_file", input: { path: "declined.txt", content: "no" } } }
      : { text: "Understood." });
    rig = rigWith(fake.base, true);
    const s = rig.store.create("t");
    await rig.runner.send(s.id, "write a file");
    await until(() => (rig!.store.get(s.id)!.approvals ?? []).length === 1, 30_000, "the approval");
    rig.runner.answerApproval(s.id, rig.store.get(s.id)!.approvals![0].id, "deny");
    await until(() => rig!.store.get(s.id)!.status === "idle", 30_000, "the turn to end");
    const t = toolEntry(rig, s.id);
    expect(t?.kind === "tool" && t.call.outcome).toBe("declined");
    expect(fs.existsSync(path.join(project(), "declined.txt"))).toBe(false);
    // The harness's blocked result carried the daemon's words to the model.
    expect(fake.requests.at(-1)!.userText).toMatch(/declin|did not allow|denied/i);
  }, 60_000);

  it("runs an allowed command in the harness, streams what it prints, and records it as every route does", async () => {
    fake = await startFakeAnthropic(({ toolResults }) => toolResults === 0
      ? { tool: { name: "shell", input: { command: "echo harness-side" } } }
      : { text: "Ran it." });
    rig = rigWith(fake.base, false);
    const s = rig.store.create("t");
    await rig.runner.send(s.id, "run echo");
    await until(() => rig!.store.get(s.id)!.status === "idle", 30_000, "the turn to end");
    const t = toolEntry(rig, s.id);
    expect(t?.kind === "tool" && t.call.outcome).toBe("done");
    expect(t?.kind === "tool" && t.call.result).toContain("harness-side");
    const printed = rig.host.published.filter((p) => p.type === "tool.output").map((p) => String(p.data?.text ?? "")).join("");
    expect(printed).toContain("harness-side");
    // A command counts as a change in the turn's facts.
    expect(rig.store.get(s.id)!.turn?.mutations ?? 0).toBeGreaterThan(0);
  }, 60_000);

  it("refuses bad input before anything runs (the harness's schema check, ahead of the gate's own)", async () => {
    fake = await startFakeAnthropic(({ toolResults }) => toolResults === 0
      ? { tool: { name: "write_file", input: { path: "x.txt" } } }
      : { text: "I see." });
    rig = rigWith(fake.base, false);
    const s = rig.store.create("t");
    await rig.runner.send(s.id, "write");
    await until(() => rig!.store.get(s.id)!.status === "idle", 30_000, "the turn to end");
    const t = toolEntry(rig, s.id);
    expect(t?.kind === "tool" && t.call.outcome).toBe("error");
    expect(t?.kind === "tool" && t.call.result).toMatch(/Validation failed|Invalid input/);
    expect(fs.existsSync(path.join(project(), "x.txt"))).toBe(false);
  }, 60_000);
});

/**
 * Editing a message and forking a session on the durable runtime: the next
 * reply goes on in a fork of the durable conversation taken just before the
 * message, so the model still has every tool call and result before it, not
 * a text summary of them.
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-fork-"));
  fs.mkdirSync(path.join(dir, "project"));
  fs.mkdirSync(path.join(dir, "data"));
  harness = null;
});

afterEach(async (ctx) => {
  if (ctx.task.result?.state === "fail") {
    const log = path.join(dir, "data", "durable", "harness.log");
    console.log("HOST LOG\n", rig?.host.logged.join("\n"));
    console.log("HARNESS LOG\n", fs.existsSync(log) ? fs.readFileSync(log, "utf-8") : "(none)");
  }
  rig?.runner.dispose();
  await harness?.close();
  await fake?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const answered = (id: string, text: string) => () => rig.store.get(id)!.status === "idle" && rig.store.get(id)!.transcript.some((e) => e.kind === "assistant" && e.text === text);

/** A session with an editor call in its first turn, and a plain second turn. Returns it and the index of its second message. */
async function twoTurns(): Promise<{ id: string; second: number }> {
  fake = await startFakeAnthropic(({ toolResults, userText }) => userText.includes("edited")
    ? { text: "Edited answer." }
    : userText.includes("second question")
      ? { text: "Second answer." }
      : toolResults === 0
        ? { text: "Looking.", tool: { name: "ue_mcp", input: { action: "call", category: "level", method: "get_info", args: {} } } }
        : { text: "First answer." });
  rig = durableRunner({
    projectDir: path.join(dir, "project"),
    dataDir: path.join(dir, "data"),
    base: fake.base,
    start: async (launch) => {
      harness = await runHarness(launch);
    },
  });
  const s = rig.store.create("t");
  await rig.runner.send(s.id, "first question");
  await until(answered(s.id, "First answer."), 30_000, "the first turn");
  await rig.runner.send(s.id, "second question");
  await until(answered(s.id, "Second answer."), 30_000, "the second turn");
  const second = rig.store.get(s.id)!.transcript.findIndex((e) => e.kind === "user" && e.text === "second question");
  return { id: s.id, second };
}

/** The request that answered the edited message. */
const editedRequest = () => fake.requests.filter((r) => r.userText.includes("edited")).at(-1)!;

describe("durable edit and fork", () => {
  it("an edited message goes on from a fork that keeps the earlier editor call and its result", async () => {
    const { id, second } = await twoTurns();
    const before = rig.store.get(id)!.durable!.key;
    expect(await rig.runner.editMessage(id, second, "second question, edited")).toBe(true);
    await until(answered(id, "Edited answer."), 30_000, "the edited turn");
    const req = editedRequest();
    // The editor call's result went to the model as a tool result, not folded into text.
    expect(req.toolResults).toBe(1);
    expect(req.userText).not.toContain("Second answer.");
    expect(req.userText).not.toMatch(/"second question"/);
    const s = rig.store.get(id)!;
    expect(s.durable!.key).not.toBe(before);
    // Nothing the fork took from the first conversation shows twice.
    expect(s.transcript.map((e) => e.kind)).toEqual(["user", "assistant", "tool", "assistant", "user", "assistant"]);
  }, 60_000);

  it("a fork goes on the same way in the new session and leaves the original as it was", async () => {
    const { id, second } = await twoTurns();
    const forked = await rig.runner.forkAt(id, second, "second question, edited");
    expect(forked).toBeTruthy();
    await until(answered(forked!, "Edited answer."), 30_000, "the fork's turn");
    expect(editedRequest().toolResults).toBe(1);
    expect(rig.store.get(forked!)!.transcript.map((e) => e.kind)).toEqual(["user", "assistant", "tool", "assistant", "user", "assistant"]);
    expect(rig.store.get(id)!.transcript.some((e) => e.kind === "assistant" && e.text === "Second answer.")).toBe(true);
  }, 60_000);

  it("falls back to Studio's copy when the runtime cannot fork, as one from an older Studio cannot", async () => {
    const { id, second } = await twoTurns();
    const client = (rig.runner as unknown as { durable: { client: { call: (t: string, ...a: unknown[]) => Promise<unknown> } } }).durable.client;
    const call = client.call.bind(client);
    client.call = (t: string, ...a: unknown[]) => (t === "fork" ? Promise.reject(new Error("the durable harness did not answer fork")) : call(t, ...a));
    expect(await rig.runner.editMessage(id, second, "second question, edited")).toBe(true);
    await until(answered(id, "Edited answer."), 30_000, "the edited turn");
    // Seeded from text: the earlier call is in the context as words, without a tool result.
    expect(editedRequest().toolResults).toBe(0);
    expect(editedRequest().userText).toContain("First answer.");
  }, 60_000);
});

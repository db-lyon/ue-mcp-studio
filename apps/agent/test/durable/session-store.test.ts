/**
 * #463 L1: a session on the durable runtime keeps its conversation in the
 * harness only. Studio holds no copy in s.messages, and rebuilds one from the
 * harness's entries when the session leaves the runtime.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runHarness } from "../../src/durable/harness-main.js";
import { historyOf } from "../../src/durable/pi.js";
import { hasConversation } from "../../src/sessions.js";
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-l1-"));
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

const rigOn = (base: string) => durableRunner({ projectDir: path.join(dir, "project"), dataDir: path.join(dir, "data"), base, start });
/** The route's setting turned off: the next reply runs on Studio's loop. */
const settingOff = (r: DurableRig) => {
  (r.runner as unknown as { o: { durable: { route: () => string | null } } }).o.durable.route = () => null;
};
const blocks = (m: { content: unknown }) => (Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : []);

describe("the durable runtime as the only store of a session's conversation", () => {
  it("keeps no copy of the conversation in the session, while the transcript shows it all", async () => {
    fake = await startFakeAnthropic(({ toolResults }) => toolResults === 0
      ? { text: "Looking.", tool: { name: "ue_mcp", input: { action: "call", category: "level", method: "get_info", args: {} } } }
      : { text: "All fine." });
    rig = rigOn(fake.base);
    const s = rig.store.create("t");
    await rig.runner.send(s.id, "check the level");
    await until(() => rig!.store.get(s.id)!.status === "idle", 30_000, "the turn to end");
    const after = rig.store.get(s.id)!;
    expect(after.messages).toEqual([]);
    expect(after.durable?.only).toBe(true);
    expect(after.transcript.map((e) => e.kind)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(hasConversation(after)).toBe(true);
    // Saved that way too.
    const file = JSON.parse(fs.readFileSync(path.join(dir, "data", "sessions", `${s.id}.json`), "utf-8"));
    expect(file.messages).toEqual([]);
  }, 60_000);

  it("rebuilds the conversation from the harness, tool calls and results included, when the session leaves the runtime", async () => {
    fake = await startFakeAnthropic(({ toolResults }) => toolResults === 0
      ? { text: "Looking.", tool: { name: "ue_mcp", input: { action: "call", category: "level", method: "get_info", args: {} } } }
      : { text: "All fine." });
    rig = rigOn(fake.base);
    const s = rig.store.create("t");
    await rig.runner.send(s.id, "check the level");
    await until(() => rig!.store.get(s.id)!.status === "idle", 30_000, "the turn to end");

    settingOff(rig);
    // Studio's loop has no provider in this rig: the reply fails there, after the move back.
    await rig.runner.send(s.id, "and the lights?");
    await until(() => rig!.store.get(s.id)!.status !== "running", 30_000, "the reply on Studio's loop to end");
    const back = rig.store.get(s.id)!;
    expect(back.durable).toBeUndefined();
    const m = back.messages;
    expect(m.map((x) => x.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    expect(blocks(m[0])).toEqual([{ type: "text", text: expect.stringContaining("check the level") }]);
    expect(blocks(m[1]).map((b) => b.type)).toEqual(["text", "tool_use"]);
    const call = blocks(m[1])[1];
    expect(call).toMatchObject({ name: "ue_mcp", input: { action: "call", category: "level", method: "get_info" } });
    expect(blocks(m[2])[0]).toMatchObject({ type: "tool_result", tool_use_id: call.id });
    expect(blocks(m[3])).toEqual([{ type: "text", text: "All fine." }]);
    expect(JSON.stringify(blocks(m[4]))).toContain("and the lights?");
  }, 60_000);

  it("rebuilds it from the transcript when the harness cannot answer", async () => {
    fake = await startFakeAnthropic(() => ({ text: "Hello." }));
    rig = rigOn(fake.base);
    const s = rig.store.create("t");
    await rig.runner.send(s.id, "hi");
    await until(() => rig!.store.get(s.id)!.status === "idle", 30_000, "the turn to end");
    const client = (rig.runner as unknown as { durable: { client: { harness: { features: string[] } } } }).durable.client;
    client.harness.features = client.harness.features.filter((f) => f !== "history");
    settingOff(rig);
    await rig.runner.send(s.id, "again");
    await until(() => rig!.store.get(s.id)!.status !== "running", 30_000, "the reply on Studio's loop to end");
    const m = rig.store.get(s.id)!.messages;
    expect(m.map((x) => x.role)).toEqual(["user", "assistant", "user"]);
    expect(blocks(m[1])).toEqual([{ type: "text", text: "Hello." }]);
  }, 60_000);

  it("empties an earlier Studio's copy on the session's next reply, without seeding it again", async () => {
    fake = await startFakeAnthropic(({ userText }) => ({ text: userText.includes("blue cube") ? "The blue cube." : "No idea." }));
    rig = rigOn(fake.base);
    const s = rig.store.create("t");
    await rig.runner.send(s.id, "remember the blue cube");
    await until(() => rig!.store.get(s.id)!.status === "idle", 30_000, "the first turn to end");
    // As an earlier Studio left it: the copy kept beside the harness, no `only`.
    const old = rig.store.get(s.id)!;
    delete old.durable!.only;
    old.messages = [{ role: "user", content: [{ type: "text", text: "remember the blue cube" }] }, { role: "assistant", content: [{ type: "text", text: "The blue cube." }] }] as never;
    rig.store.save(old);
    const requests = fake.requests.length;
    await rig.runner.send(s.id, "what did I ask about?");
    await until(() => rig!.store.get(s.id)!.status === "idle", 30_000, "the second turn to end");
    const now = rig.store.get(s.id)!;
    expect(now.messages).toEqual([]);
    expect(now.durable?.only).toBe(true);
    expect(now.transcript.at(-1)).toMatchObject({ kind: "assistant", text: "The blue cube." });
    // One request: the harness had the conversation; nothing was written into it twice.
    expect(fake.requests.length).toBe(requests + 1);
    expect(JSON.stringify(fake.requests.at(-1)).match(/remember the blue cube/g)?.length).toBe(1);
  }, 60_000);

  it("retries a failed reply by asking the model to go on, never sending the message to the harness twice", async () => {
    let fail = true;
    fake = await startFakeAnthropic(() => (fail ? { status: 400, error: "bad request" } : { text: "Done now." }) as never);
    rig = rigOn(fake.base);
    const s = rig.store.create("t");
    await rig.runner.send(s.id, "do the thing");
    await until(() => rig!.store.get(s.id)!.status !== "running", 30_000, "the failed reply to end");
    fail = false;
    await rig.runner.retry(s.id);
    await until(() => rig!.store.get(s.id)!.status === "idle" && rig!.store.get(s.id)!.transcript.at(-1)?.kind === "assistant", 30_000, "the retried reply");
    const last = JSON.stringify(fake.requests.at(-1));
    expect(last.match(/do the thing/g)?.length).toBe(1);
    expect(last).toContain("Continue from where it stopped");
  }, 60_000);
});

describe("historyOf", () => {
  const user = (text: string) => ({ kind: "pi.user", model: [{ role: "user", content: text }] });
  const assistant = (content: unknown[]) => ({ kind: "pi.assistant", model: [{ role: "assistant", content }] });

  it("starts from the latest compaction's summary and answers a call that never got its result", () => {
    const h = historyOf([
      user("old"), assistant([{ type: "text", text: "old answer" }]),
      { kind: "pi.compaction", data: { summary: "The user asked about the old thing." } },
      user("new"),
      assistant([{ type: "text", text: "Calling." }, { type: "toolCall", id: "c1", name: "shell", arguments: { command: "dir" } }]),
    ]);
    expect(h).toEqual([
      { role: "user", content: [{ type: "text", text: expect.stringContaining("The user asked about the old thing.") }, { type: "text", text: "new" }] },
      { role: "assistant", content: [{ type: "text", text: "Calling." }, { type: "tool_use", id: "c1", name: "shell", input: { command: "dir" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: [{ type: "text", text: expect.stringContaining("interrupted") }], is_error: true }] },
    ]);
  });

  it("keeps images, merges a migrated block of messages, and drops thinking", () => {
    const h = historyOf([
      { kind: "studio.migrated", model: [{ role: "user", content: "a" }, { role: "assistant", content: [{ type: "text", text: "b" }] }] },
      { kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: "AAA", mimeType: "image/png" }] }] },
      assistant([{ type: "thinking", thinking: "hm" }, { type: "text", text: "A cube." }]),
    ]);
    expect(h.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(h[2].content[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } });
    expect(h[3].content).toEqual([{ type: "text", text: "A cube." }]);
  });
});

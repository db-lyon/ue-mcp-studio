/** Cards an extension posts into a session: kept and published, never sent to a model. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentRunner, carryOver } from "../src/runner.js";
import { SessionStore } from "../src/sessions.js";
import { runHarness } from "../src/durable/harness-main.js";
import { FakeHost, durableRunner, until } from "./durable/helpers.js";
import { startFakeAnthropic, type FakeAnthropic } from "./durable/fake-anthropic.js";

const SECRET = "card-data-the-model-never-sees";
let root: string;
let host: FakeHost;
let store: SessionStore;
let fake: FakeAnthropic | null;
let harness: { close(): Promise<void> } | null;
let made: AgentRunner[];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-cards-"));
  fs.mkdirSync(path.join(root, "project"), { recursive: true });
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  host = new FakeHost(path.join(root, "project"), path.join(root, "data"));
  store = new SessionStore(host.dataDir);
  fake = null;
  harness = null;
  made = [];
});

afterEach(async () => {
  for (const r of made) r.dispose();
  await harness?.close();
  await fake?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** A runner for the cases that never reach a model. */
const runner = () => {
  const r = new AgentRunner({ host, store, model: () => "claude-opus-5-5" });
  made.push(r);
  return r;
};

describe("cards.post", () => {
  it("appends a card entry, keeps it across a restart, and shows it in the session's detail", () => {
    const s = store.create();
    const entry = runner().cards.post(s.id, { ext: "pro", type: "plan", data: { left: 3, note: SECRET } });
    expect(entry).toEqual({ kind: "card", ext: "pro", type: "plan", data: { left: 3, note: SECRET }, at: expect.any(String) });
    expect(SessionStore.detail(store.get(s.id)!).transcript).toEqual([entry]);
    expect(new SessionStore(host.dataDir).get(s.id)!.transcript).toEqual([entry]);
  });

  it("publishes transcript.added for the session, which the daemon names studio.transcript.added", () => {
    const s = store.create();
    const entry = runner().cards.post(s.id, { ext: "pro", type: "plan", data: [1, 2] });
    expect(host.published.filter((e) => e.type === "transcript.added")).toEqual([{ type: "transcript.added", data: { sessionId: s.id, entry } }]);
  });

  it("copies the data, so a later change by the caller does not reach the transcript", () => {
    const s = store.create();
    const data = { n: 1 };
    runner().cards.post(s.id, { ext: "pro", type: "plan", data });
    data.n = 2;
    expect(store.get(s.id)!.transcript[0]).toMatchObject({ data: { n: 1 } });
  });

  it("never enters the model's messages, the carried-over conversation or a later turn's request", async () => {
    let replies = 0;
    fake = await startFakeAnthropic(() => ({ text: ++replies === 1 ? "first reply" : "second reply" }));
    const rig = durableRunner({
      projectDir: host.projectDir,
      dataDir: host.dataDir,
      base: fake.base,
      host,
      store,
      start: async (launch) => {
        harness = await runHarness(launch);
      },
    });
    made.push(rig.runner);
    const r = rig.runner;
    const s = store.create();
    await r.send(s.id, "hello");
    await until(() => store.get(s.id)!.status === "idle", 30_000, "the first reply");
    const messages = JSON.stringify(store.get(s.id)!.messages);
    r.cards.post(s.id, { ext: "pro", type: "plan", data: { note: SECRET } });
    expect(JSON.stringify(store.get(s.id)!.messages)).toBe(messages);
    expect(carryOver(store.get(s.id)!.messages)).not.toContain(SECRET);
    await r.send(s.id, "and again");
    await until(() => store.get(s.id)!.status === "idle" && store.get(s.id)!.transcript.length === 5, 30_000, "the second reply");
    expect(fake.requests).toHaveLength(2);
    expect(JSON.stringify(fake.requests[1].body)).not.toContain(SECRET);
    expect(JSON.stringify(fake.requests[1].body)).not.toContain("\"card\"");
    expect(store.get(s.id)!.transcript.map((t) => t.kind)).toEqual(["user", "assistant", "card", "user", "assistant"]);
  }, 60_000);

  it("refuses an unknown session, a name the client cannot match, data that is not JSON, and data over the cap", () => {
    const s = store.create();
    const r = runner();
    expect(() => r.cards.post("nope", { ext: "pro", type: "plan", data: 1 })).toThrow(/no session/);
    expect(() => r.cards.post(s.id, { ext: "pro x", type: "plan", data: 1 })).toThrow(/extension/);
    expect(() => r.cards.post(s.id, { ext: "pro", type: "a:b", data: 1 })).toThrow(/card type/);
    expect(() => r.cards.post(s.id, { ext: "pro", type: "plan", data: undefined })).toThrow(/JSON/);
    expect(() => r.cards.post(s.id, { ext: "pro", type: "plan", data: () => 1 })).toThrow(/JSON/);
    expect(() => r.cards.post(s.id, { ext: "pro", type: "plan", data: { n: 1n } })).toThrow(/JSON/);
    expect(() => r.cards.post(s.id, { ext: "pro", type: "plan", data: "x".repeat(70_000) })).toThrow(/over/);
    expect(store.get(s.id)!.transcript).toEqual([]);
    expect(host.published).toEqual([]);
  });
});

/**
 * After the cutover every conversation runs in the durable harness. Without
 * one (a build missing it, or no route for the model) a reply and an assigned
 * subagent fail and say why instead of running anywhere else, and a turn
 * saved mid-run by a Studio from before the cutover (Studio's loop or a turn
 * host) ends on recovery, saying what cut it off.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentRunner } from "../../src/runner.js";
import { SessionStore } from "../../src/sessions.js";
import { FakeHost } from "./helpers.js";

let dir: string;
let host: FakeHost;
let store: SessionStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-cutover-"));
  fs.mkdirSync(path.join(dir, "project"));
  fs.mkdirSync(path.join(dir, "data"));
  host = new FakeHost(path.join(dir, "project"), path.join(dir, "data"));
  store = new SessionStore(host.dataDir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A runner whose harness script does not exist, so the durable runtime is unavailable. */
const noHarness = (route: string | null = "key:anthropic") => new AgentRunner({
  host,
  store,
  model: () => "claude-opus-5-5",
  askBeforeChanges: () => false,
  durable: {
    route: () => route,
    routeSpec: (model) => ({ route: "key:anthropic", provider: "anthropic", api: "anthropic-messages", model, baseUrl: "http://127.0.0.1:1", auth: "apiKey" }),
    credential: async () => "test-key",
    harness: { dataDir: host.dataDir, projectDir: host.projectDir, version: "0.0.0-test", script: path.join(dir, "missing-harness.js"), extensionFile: null },
  },
});

describe("a reply with no durable harness", () => {
  it("fails, saying the build has none, and runs nowhere else", async () => {
    const runner = noHarness();
    const s = store.create("t");
    await runner.send(s.id, "hello");
    const after = store.get(s.id)!;
    expect(after.status).toBe("error");
    expect(after.error).toMatch(/no durable harness/);
    expect(after.transcript.filter((t) => t.kind === "assistant")).toHaveLength(0);
  });

  it("fails the same way without the durable option at all", async () => {
    const runner = new AgentRunner({ host, store, model: () => "claude-opus-5-5", askBeforeChanges: () => false });
    const s = store.create("t");
    await runner.send(s.id, "hello");
    expect(store.get(s.id)!.error).toMatch(/no durable harness/);
  });
});

describe("an assigned subagent with no durable harness", () => {
  it("ends at once, its card answered with why it could not start", async () => {
    const runner = noHarness();
    const s = store.create("t");
    const { callId, done } = runner.assignSubagent(s.id, "Playtest the door", "run the door playtest");
    const r = await done;
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/could not start: this Studio build has no durable harness/);
    const entry = store.get(s.id)!.transcript.find((t) => t.kind === "tool" && t.call.id === callId);
    expect(entry?.kind === "tool" && entry.call.outcome).toBe("error");
  });
});

describe("a turn saved mid-run before the cutover", () => {
  it("ends on recovery, its calls answered and the cause told, so the next message starts it in the harness", () => {
    const s = store.create("t");
    s.status = "running";
    s.messages.push({ role: "user", content: [{ type: "text", text: "build it" }] } as never);
    s.transcript.push({ kind: "user", text: "build it", at: new Date().toISOString() });
    s.transcript.push({ kind: "tool", call: { id: "c1", name: "ue_mcp", input: { action: "call", category: "level", method: "get_info" }, outcome: "pending", startedAt: new Date().toISOString() } });
    s.hostTurn = { seq: 3, lastId: null, background: [] };
    s.agentRuns = { a1: { background: true, assigned: false } } as never;
    store.save(s);
    store.flush();

    const runner = noHarness();
    runner.recover();
    const after = store.get(s.id)!;
    expect(after.status).toBe("error");
    expect(after.error).toMatch(/The turn ended because Studio's daemon restarted/);
    const call = after.transcript.find((t) => t.kind === "tool" && t.call.id === "c1");
    expect(call?.kind === "tool" && call.call.outcome).toBe("unknown");
    expect(after.hostTurn).toBeUndefined();
    expect(after.agentRuns).toBeUndefined();
    expect(runner.pinnedSessions()).toEqual([]);
  });
});

describe("GET /runtime's harness state with no harness", () => {
  it("answers unavailable", () => {
    expect(noHarness().durableHarness()).toMatchObject({ available: false, connected: false });
  });
});

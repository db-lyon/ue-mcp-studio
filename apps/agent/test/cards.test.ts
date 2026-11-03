/** Cards an extension posts into a session: kept and published, never sent to a model. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ActionResult, EditorStatus } from "ue-mcp/daemon";
import { AgentRunner, carryOver } from "../src/runner.js";
import { SessionStore } from "../src/sessions.js";
import type { ModelProvider, ModelRequest, ModelTurn } from "../src/providers.js";
import type { AgentHost } from "../src/tools.js";

class FakeHost implements AgentHost {
  published: Array<{ type: string; data?: Record<string, unknown> }> = [];
  log = { info() {}, warn() {} };
  events = { publish: (type: string, data?: Record<string, unknown>) => void this.published.push({ type, data }), subscribe: () => () => {} };
  constructor(public projectDir: string, public dataDir: string) {}
  async callAction(): Promise<ActionResult> {
    return { isError: false, content: [{ type: "text", text: "{\"success\":true}" }] };
  }
  editors(): EditorStatus[] {
    return [{ name: "P", connected: true, port: 1, pid: 1, lastDisconnect: null }];
  }
  async editorOperation(op: string) {
    return { op, steps: [] };
  }
  setBusy(): void {}
}

class ScriptedModel implements ModelProvider {
  requests: ModelRequest[] = [];
  constructor(private readonly turns: string[]) {}
  async run(req: ModelRequest): Promise<ModelTurn> {
    this.requests.push(JSON.parse(JSON.stringify(req)));
    return { content: [{ type: "text", text: this.turns.shift() ?? "ok", citations: null } as never], stopReason: "end_turn" };
  }
}

const SECRET = "card-data-the-model-never-sees";
let root: string;
let host: FakeHost;
let store: SessionStore;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-cards-"));
  fs.mkdirSync(path.join(root, "project"), { recursive: true });
  host = new FakeHost(path.join(root, "project"), path.join(root, "data"));
  store = new SessionStore(host.dataDir);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const runner = (model = new ScriptedModel([])) => new AgentRunner({ host, store, provider: () => model, model: () => "claude-opus-5-5" });

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
    const model = new ScriptedModel(["first reply", "second reply"]);
    const r = runner(model);
    const s = store.create();
    await r.send(s.id, "hello");
    const messages = JSON.stringify(store.get(s.id)!.messages);
    r.cards.post(s.id, { ext: "pro", type: "plan", data: { note: SECRET } });
    expect(JSON.stringify(store.get(s.id)!.messages)).toBe(messages);
    expect(carryOver(store.get(s.id)!.messages)).not.toContain(SECRET);
    await r.send(s.id, "and again");
    expect(model.requests).toHaveLength(2);
    expect(JSON.stringify(model.requests[1])).not.toContain(SECRET);
    expect(JSON.stringify(model.requests[1])).not.toContain("\"card\"");
    expect(store.get(s.id)!.transcript.map((t) => t.kind)).toEqual(["user", "assistant", "card", "user", "assistant"]);
  });

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

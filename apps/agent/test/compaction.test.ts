/**
 * Context and compaction: the helpers that measure and summarise a
 * conversation, the windows the vendors' model lists give, and what Compact
 * now refuses. Compaction itself runs in the durable harness, covered by the
 * durable tests.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ActionResult, EditorStatus } from "ue-mcp/daemon";
import { AgentRunner } from "../src/runner.js";
import { SessionStore } from "../src/sessions.js";
import type { MessageParam } from "../src/messages.js";
import { knownWindow, listedWindow, rememberWindow } from "../src/context-windows.js";
import { compactedMessages, conversationText, estimateMessagesTokens, isCompactedSummary, isContextOverflow, summaryRequest } from "../src/compaction.js";

class Host {
  connected = true;
  published: Array<{ type: string; data?: Record<string, unknown> }> = [];
  log = { info() {}, warn() {} };
  events = {
    publish: (type: string, data?: Record<string, unknown>) => void this.published.push({ type, data }),
    subscribe: () => () => {},
  };
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

let dir: string;
let host: Host;
let store: SessionStore;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-compaction-"));
  fs.mkdirSync(path.join(dir, "project"));
  host = new Host(path.join(dir, "project"), path.join(dir, "data"));
  store = new SessionStore(host.dataDir);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("the compaction helpers", () => {
  const user = (t: string): MessageParam => ({ role: "user", content: [{ type: "text", text: t }] } as MessageParam);
  const assistant = (t: string): MessageParam => ({ role: "assistant", content: [{ type: "text", text: t }] } as MessageParam);
  const results: MessageParam = { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } as MessageParam;

  it("estimates text at four characters a token and an image as a fixed size", () => {
    expect(estimateMessagesTokens([user("x".repeat(400))])).toBe(100);
    expect(estimateMessagesTokens([{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(90_000) } }] } as MessageParam])).toBe(1600);
  });

  it("asks for the summary in the user's turn when the conversation ends with one, so turns still alternate", () => {
    const after = summaryRequest([user("a"), assistant("b"), results]);
    expect(after).toHaveLength(3);
    expect((after[2].content as Array<{ type: string }>).map((b) => b.type)).toEqual(["tool_result", "text"]);
    expect(summaryRequest([user("a"), assistant("b")])).toHaveLength(3);
    expect(summaryRequest([user("a"), assistant("b")], "the door paths").at(-1)!.content).toEqual([expect.objectContaining({ text: expect.stringContaining("keep: the door paths") })]);
  });

  it("leaves a summary the next message follows in turn, carries on mid-turn, and keeps a waiting message", () => {
    const idle = compactedMessages([user("a"), assistant("b")], "S", 1000);
    expect(idle.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(isCompactedSummary(idle[0])).toBe(true);
    const mid = compactedMessages([user("a"), assistant("b"), results], "S", 1000);
    expect(mid).toHaveLength(1);
    expect(JSON.stringify(mid[0].content)).toContain("Continue the task where it stopped");
    const waiting = compactedMessages([user("a"), assistant("b"), user("now this")], "S", 1000);
    expect(waiting).toHaveLength(1);
    expect((waiting[0].content as Array<{ text?: string }>).map((b) => b.text)).toEqual([expect.stringMatching(/^\[Studio\] This conversation was compacted/), "now this"]);
  });

  it("keeps the most recent part when the conversation is longer than the text allowed", () => {
    const t = conversationText([user("first ".repeat(100)), assistant("last")], 40);
    expect(t).toContain("left out");
    expect(t.endsWith("Assistant: last")).toBe(true);
  });

  it("knows each provider's way of saying a request was too long", () => {
    expect(isContextOverflow(new Error("prompt is too long: 210000 tokens > 200000 maximum"))).toBe(true);
    expect(isContextOverflow(new Error("This model's maximum context length is 128000 tokens"))).toBe(true);
    expect(isContextOverflow(new Error("context_length_exceeded"))).toBe(true);
    expect(isContextOverflow(new Error("rate limited"))).toBe(false);
  });
});

describe("windows from the vendors' model lists", () => {
  it("reads the field each kind of list states its window in, and keeps it by model", () => {
    expect(listedWindow({ id: "claude-x", max_input_tokens: 1_000_000 })).toBe(1_000_000);
    expect(listedWindow({ slug: "gpt-x", context_window: 272_000 })).toBe(272_000);
    expect(listedWindow({ id: "qwen", max_model_len: 32_768 })).toBe(32_768);
    expect(listedWindow({ id: "or", top_provider: { context_length: 131_072 } })).toBe(131_072);
    expect(listedWindow({ id: "none" })).toBeNull();
    rememberWindow("models/local-test-model", { context_length: 65_536 });
    expect(knownWindow("local-test-model")).toBe(65_536);
  });
});

describe("context", () => {
  it("estimates an older session's context from its messages until a request measures it", () => {
    const s = store.create();
    s.messages = [{ role: "user", content: [{ type: "text", text: "x".repeat(4000) }] } as MessageParam];
    store.save(s);
    expect(SessionStore.detail(s).context!.main).toMatchObject({ input: 1000, estimated: true });
  });
});

describe("Compact", () => {
  const runner = () => new AgentRunner({ host, store, model: () => "claude-haiku-4-5", askBeforeChanges: () => false });

  it("refuses while a turn runs, or with nothing to compact", async () => {
    const r = runner();
    const s = store.create();
    await expect(r.compact(s.id)).rejects.toThrow("nothing to compact");
    store.get(s.id)!.status = "running";
    store.get(s.id)!.messages.push({ role: "user", content: "a" } as MessageParam);
    await expect(r.compact(s.id)).rejects.toThrow("in progress");
  });

  it("refuses a conversation that has not moved into the durable harness yet", async () => {
    const r = runner();
    const s = store.create();
    s.messages.push({ role: "user", content: "a" } as MessageParam, { role: "assistant", content: "b" } as MessageParam);
    store.save(s);
    await expect(r.compact(s.id)).rejects.toThrow("moves to the durable runtime with its next message");
  });
});

/**
 * Context and compaction on the routes Studio runs the loop for: what a
 * request measures, when the conversation is summarised, what the model is
 * sent after, and that the transcript the user sees keeps everything.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ActionResult, EditorStatus } from "ue-mcp/daemon";
import { COMPACTED_PREFIX, DEFAULT_USAGE, type TranscriptEntry } from "@ue-mcp-studio/shared";
import { AgentRunner } from "../src/runner.js";
import { SessionStore } from "../src/sessions.js";
import type { MessageParam, ModelProvider, ModelRequest, ModelTurn } from "../src/providers.js";
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

const text = (t: string, input = 0, output = 0, cacheRead = 0): ModelTurn =>
  ({ content: [{ type: "text", text: t, citations: null } as never], stopReason: "end_turn", usage: { input, output, cacheRead } });

/** The summary request: its last message carries the instruction to write the summary. */
const asksForSummary = (req: ModelRequest): boolean => {
  const last = req.messages[req.messages.length - 1];
  return Array.isArray(last.content) && (last.content as Array<{ type: string; text?: string }>).some((b) => b.type === "text" && (b.text ?? "").includes("about to be compacted"));
};

class Model implements ModelProvider {
  requests: ModelRequest[] = [];
  constructor(private readonly answer: (req: ModelRequest, n: number) => ModelTurn | Error) {}
  async run(req: ModelRequest): Promise<ModelTurn> {
    this.requests.push(JSON.parse(JSON.stringify(req)));
    const r = this.answer(req, this.requests.length);
    if (r instanceof Error) throw r;
    return r;
  }
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

const runnerOn = (model: Model, id = "claude-haiku-4-5") => new AgentRunner({ host, store, provider: () => model, model: () => id, askBeforeChanges: () => false });
const marks = (id: string) => store.get(id)!.transcript.filter((t): t is Extract<TranscriptEntry, { kind: "compaction" }> => t.kind === "compaction");

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

describe("context on the API routes", () => {
  it("is the latest request's whole prompt and answer, while the totals add every request up", async () => {
    const model = new Model((_r, n) => text(`reply ${n}`, 1000 * n, 100, 50_000 * n));
    const runner = runnerOn(model, "claude-sonnet-5-5");
    const s = store.create();
    await runner.send(s.id, "one");
    await runner.send(s.id, "two");
    const d = SessionStore.detail(store.get(s.id)!);
    expect(d.context!.main).toMatchObject({ input: 102_000, cached: 100_000, output: 100, model: "claude-sonnet-5-5" });
    expect(d.totals).toMatchObject({ input: 3000, cacheRead: 150_000, output: 200, requests: 2 });
    expect(host.published.some((e) => e.type === "context.changed")).toBe(true);
  });

  it("estimates an older session's context from its messages until a request measures it", () => {
    const s = store.create();
    s.messages = [{ role: "user", content: [{ type: "text", text: "x".repeat(4000) }] } as MessageParam];
    store.save(s);
    expect(SessionStore.detail(s).context!.main).toMatchObject({ input: 1000, estimated: true });
  });
});

describe("compaction on the API routes", () => {
  it("summarises before a request once the context reaches 85% of the window, and the transcript keeps every line", async () => {
    // Haiku 4.5's window is 200k: the first answer measures 180k.
    const model = new Model((req, n) => (asksForSummary(req) ? text("The door swings; the trigger is next.", 500, 300) : text(`reply ${n}`, 179_000, 1000)));
    const runner = runnerOn(model);
    const s = store.create();
    await runner.send(s.id, "make the door swing");
    await runner.send(s.id, "now the trigger");
    expect(model.requests).toHaveLength(3);
    expect(asksForSummary(model.requests[1])).toBe(true);
    // The request after starts from the summary, with the waiting message kept.
    const sent = model.requests[2].messages;
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0].content)).toContain(COMPACTED_PREFIX);
    expect(JSON.stringify(sent[0].content)).toContain("now the trigger");
    const [mark] = marks(s.id);
    expect(mark).toMatchObject({ trigger: "auto", state: "done", method: "summary", summary: "The door swings; the trigger is next.", before: expect.any(Number), after: expect.any(Number) });
    expect(mark.before).toBeGreaterThanOrEqual(180_000);
    expect(mark.after).toBeLessThan(10_000);
    const t = store.get(s.id)!.transcript;
    expect(t.filter((x) => x.kind === "user").map((x) => (x as { text: string }).text)).toEqual(["make the door swing", "now the trigger"]);
    expect(t.filter((x) => x.kind === "assistant")).toHaveLength(2);
  });

  it("does not compact below the threshold", async () => {
    const model = new Model((_r, n) => text(`reply ${n}`, 20_000, 100));
    const runner = runnerOn(model);
    const s = store.create();
    await runner.send(s.id, "one");
    await runner.send(s.id, "two");
    expect(marks(s.id)).toHaveLength(0);
    expect(model.requests.every((r) => !asksForSummary(r))).toBe(true);
  });

  it("compacts and sends once more when a request is refused as too long, as after a switch to a smaller window", async () => {
    let refused = false;
    const model = new Model((req, n) => {
      if (asksForSummary(req)) return text("Summary.", 100, 50);
      if (n === 2 && !refused) {
        refused = true;
        return new Error("prompt is too long: 230000 tokens > 200000 maximum");
      }
      return text(`reply ${n}`, 5_000, 100);
    });
    const runner = runnerOn(model);
    const s = store.create();
    await runner.send(s.id, "one");
    await runner.send(s.id, "two");
    expect(store.get(s.id)!.status).toBe("idle");
    expect(marks(s.id)[0]).toMatchObject({ trigger: "overflow", state: "done" });
    expect(JSON.stringify(model.requests.at(-1)!.messages[0].content)).toContain(COMPACTED_PREFIX);
  });

  it("cuts the oldest part and keeps the most recent as text when the summary cannot be had", async () => {
    const model = new Model((req, n) => (asksForSummary(req) ? new Error("overloaded") : text(`reply ${n}`, 179_000, 1000)));
    const runner = runnerOn(model);
    const s = store.create();
    await runner.send(s.id, "one");
    await runner.send(s.id, "two");
    expect(marks(s.id)[0]).toMatchObject({ state: "done", method: "truncated", error: "overloaded" });
    expect(store.get(s.id)!.status).toBe("idle");
  });

  it("compacts on request with what the user asked it to keep, and the next message follows the summary", async () => {
    const model = new Model((req, n) => (asksForSummary(req) ? text("Summary.", 10, 5) : text(`reply ${n}`, 3000, 100)));
    const runner = runnerOn(model);
    const s = store.create();
    await runner.send(s.id, "one");
    await runner.send(s.id, "/compact the door paths");
    expect(JSON.stringify(model.requests[1].messages.at(-1)!.content)).toContain("keep: the door paths");
    expect(marks(s.id)[0]).toMatchObject({ trigger: "manual", instructions: "the door paths", state: "done" });
    expect(store.get(s.id)!.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    // /compact is not a message: the transcript has no user line for it.
    expect(store.get(s.id)!.transcript.filter((t) => t.kind === "user")).toHaveLength(1);
    await runner.send(s.id, "two");
    expect(model.requests.at(-1)!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("refuses to compact while a turn runs, or with nothing to compact", async () => {
    const runner = runnerOn(new Model(() => text("x")));
    const s = store.create();
    await expect(runner.compact(s.id)).rejects.toThrow("nothing to compact");
    store.get(s.id)!.status = "running";
    store.get(s.id)!.messages.push({ role: "user", content: "a" } as MessageParam);
    await expect(runner.compact(s.id)).rejects.toThrow("in progress");
  });

  it("keeps an edit after a compaction precise, and rebuilds from the transcript for an edit from before it", async () => {
    const model = new Model((req, n) => (asksForSummary(req) ? text("Summary.", 10, 5) : text(`reply ${n}`, 3000, 100)));
    const runner = runnerOn(model);
    const s = store.create();
    await runner.send(s.id, "one");
    await runner.compact(s.id);
    await runner.send(s.id, "two");
    await runner.send(s.id, "three");
    const at = (msg: string) => store.get(s.id)!.transcript.findIndex((t) => t.kind === "user" && t.text === msg);
    // "three" is after the compaction: the conversation is cut back to just before it.
    const stored = store.get(s.id)!;
    SessionStore.truncateAt(stored, at("three"));
    expect(stored.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(isCompactedSummary(stored.messages[0])).toBe(true);
    // "one" is inside the summary: the model starts again from the transcript up to it.
    SessionStore.truncateAt(stored, at("one"));
    expect(stored.messages).toEqual([]);
  });
});

describe("compaction of a subagent's own conversation", () => {
  it("marks the compaction in the subagent's thread and goes on", async () => {
    const isSub = (req: ModelRequest) => req.system.some((b) => b.text.includes("You are a subagent"));
    let subTurns = 0;
    const model = new Model((req) => {
      if (asksForSummary(req)) return text("Subagent summary.", 10, 5);
      if (isSub(req)) {
        subTurns++;
        if (subTurns === 1) return { content: [{ type: "tool_use", id: "c1", name: "ue_mcp", input: { action: "call", category: "level", method: "get_outliner" } } as never], stopReason: "tool_use", usage: { input: 179_000, output: 500 } };
        return text("Report.", 2000, 100);
      }
      if (req.messages.length === 1) return { content: [{ type: "tool_use", id: "a1", name: "agent", input: { description: "Look", prompt: "look around" } } as never], stopReason: "tool_use", usage: { input: 1000, output: 10 } };
      return text("Done.", 1500, 10);
    });
    const runner = new AgentRunner({ host, store, provider: () => model, model: () => "claude-sonnet-5-5", subagentModel: () => "claude-haiku-4-5", askBeforeChanges: () => false, usage: () => ({ ...DEFAULT_USAGE, subagents: "automatic", subagentsPerTurn: 2 }) });
    const s = store.create();
    await runner.send(s.id, "look around with a subagent");
    const [mark] = marks(s.id);
    expect(mark).toMatchObject({ parent: "a1", state: "done", summary: "Subagent summary." });
    expect(SessionStore.detail(store.get(s.id)!).context!.a1).toMatchObject({ model: "claude-haiku-4-5" });
    expect(store.get(s.id)!.status).toBe("idle");
  });
});

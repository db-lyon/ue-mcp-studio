/**
 * The durable runtime end to end in one process: a real harness on SQLite
 * storage, pi-ai's Anthropic wire code against a local stand-in, and
 * AgentRunner's own tool path on a fake daemon host.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionDetail, TranscriptEntry } from "@ue-mcp-studio/shared";
import { runHarness } from "../../src/durable/harness-main.js";
import { AgentRunner } from "../../src/runner.js";
import { SessionStore } from "../../src/sessions.js";
import type { ModelProvider, ModelTurn } from "../../src/providers.js";
import { syncOf } from "../../src/session-delta.js";
import { DetailLoader as Build40Loader } from "../fixtures/build40-session-sync.js";
import { FakeHost, durableRunner, editorCalls, until, type DurableRig } from "./helpers.js";
import { startFakeAnthropic, type FakeAnthropic, type FakeTurn } from "./fake-anthropic.js";

let dir: string;
let fake: FakeAnthropic;
let harness: { close(): Promise<void> } | null;
let rig: DurableRig;

const start = async (launch: Parameters<typeof runHarness>[0]) => {
  harness = await runHarness(launch);
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-durable-"));
  fs.mkdirSync(path.join(dir, "project"));
  fs.mkdirSync(path.join(dir, "data"));
  harness = null;
});

afterEach(async (ctx) => {
  if (ctx.task.result?.state === "fail") {
    const log = path.join(dir, "data", "durable", "harness.log");
    console.log("HOST LOG\n", rig?.host.logged.join("\n"));
    console.log("HARNESS LOG\n", fs.existsSync(log) ? fs.readFileSync(log, "utf-8") : "(none)");
    console.log("REQUESTS", JSON.stringify(fake?.requests.map((r) => r.toolResults)));
    for (const s of rig?.store.all() ?? []) console.log("SESSION", s.status, s.error, JSON.stringify(s.transcript).slice(0, 1500));
  }
  rig?.runner.dispose();
  await harness?.close();
  await fake?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const transcript = (store: SessionStore, id: string) => store.get(id)!.transcript;

describe("durable runtime", () => {
  it("runs a turn with an editor call and streams the answer, as every route shows it", async () => {
    fake = await startFakeAnthropic(({ toolResults }) => toolResults === 0
      ? { text: "Looking at the level.", tool: { name: "ue_mcp", input: { action: "call", category: "level", method: "get_info", args: {} } } }
      : { text: "The level is fine, and nothing in it needs saving.", paceMs: 60 });
    rig = durableRunner({ projectDir: path.join(dir, "project"), dataDir: path.join(dir, "data"), base: fake.base, start });
    const s = rig.store.create("t");
    await rig.runner.send(s.id, "check the level");
    await until(() => rig.store.get(s.id)!.status === "idle", 30_000, "the turn to end");
    const t = transcript(rig.store, s.id);
    expect(t.map((e) => e.kind)).toEqual(["user", "assistant", "tool", "assistant"]);
    const tool = t[2];
    expect(tool.kind === "tool" && tool.call.outcome).toBe("done");
    expect(tool.kind === "tool" && tool.call.result).toContain("level.get_info");
    expect(editorCalls(path.join(dir, "data")).filter((c) => c.category === "level")).toHaveLength(1);
    // The answer streamed as turn.delta, as on every route.
    const deltas = rig.host.published.filter((p) => p.type === "turn.delta").map((p) => p.data?.text).join("");
    expect(deltas).toContain("The level is fine");
    // The model was sent Studio's tools and prompt.
    expect(fake.requests[0].tools).toContain("ue_mcp");
    expect(fake.requests[0].system).toContain("Unreal Editor");
    // Spend is counted for the meter.
    expect(rig.store.get(s.id)!.totals?.requests).toBe(2);
    expect(rig.store.get(s.id)!.durable?.seeded).toBe(true);
  }, 60_000);

  it("waits for the user's approval of a command, and runs it once allowed", async () => {
    fake = await startFakeAnthropic(({ toolResults }) => toolResults === 0
      ? { tool: { name: "shell", input: { command: "echo durable" } } }
      : { text: "Ran it." });
    rig = durableRunner({ projectDir: path.join(dir, "project"), dataDir: path.join(dir, "data"), base: fake.base, start, extra: { askBeforeChanges: () => true } });
    const s = rig.store.create("t");
    await rig.runner.send(s.id, "run echo");
    await until(() => (rig.store.get(s.id)!.approvals ?? []).length === 1, 30_000, "the approval");
    const a = rig.store.get(s.id)!.approvals![0];
    expect(rig.runner.answerApproval(s.id, a.id, "allow")).toBe(true);
    await until(() => rig.store.get(s.id)!.status === "idle", 30_000, "the turn to end");
    const tool = transcript(rig.store, s.id).find((e) => e.kind === "tool");
    expect(tool?.kind === "tool" && tool.call.outcome).toBe("done");
    expect(tool?.kind === "tool" && tool.call.result).toContain("durable");
  }, 60_000);

  it("runs a subagent through Studio's agent tool, with its thread under the agent call", async () => {
    fake = await startFakeAnthropic(({ toolResults, system }) => {
      const sub = system.includes("You are a subagent");
      if (sub) return toolResults === 0 ? { tool: { name: "ue_mcp", input: { action: "call", category: "asset", method: "list", args: {} } } } : { text: "Report: listed the assets." };
      return toolResults === 0 ? { tool: { name: "agent", input: { description: "List assets", prompt: "List the assets." } } } : { text: "The subagent listed them." };
    });
    rig = durableRunner({ projectDir: path.join(dir, "project"), dataDir: path.join(dir, "data"), base: fake.base, start });
    const s = rig.store.create("t");
    await rig.runner.send(s.id, "list assets with a subagent");
    await until(() => rig.store.get(s.id)!.status === "idle", 40_000, "the turn to end");
    const t = transcript(rig.store, s.id);
    const agent = t.find((e) => e.kind === "tool" && e.call.name === "agent");
    expect(agent?.kind === "tool" && agent.call.outcome).toBe("done");
    expect(agent?.kind === "tool" && agent.call.result).toContain("Report: listed the assets.");
    const id = agent?.kind === "tool" ? agent.call.id : "";
    expect(t.filter((e) => e.parent === id).map((e) => e.kind)).toEqual(["tool", "assistant"]);
    expect(t[t.length - 1]).toMatchObject({ kind: "assistant", text: "The subagent listed them." });
  }, 60_000);

  it("shows the same conversation as Studio's loop does, and Android build 40's loader reads it", async () => {
    const script = ({ toolResults }: { toolResults: number }): FakeTurn => toolResults === 0
      ? { text: "Placing it.", tool: { name: "ue_mcp", input: { action: "call", category: "level", method: "place_actor", args: { class: "Cube" } } } }
      : { text: "Placed a cube." };
    fake = await startFakeAnthropic(script);
    rig = durableRunner({ projectDir: path.join(dir, "project"), dataDir: path.join(dir, "data"), base: fake.base, start });
    const s = rig.store.create("t");
    await rig.runner.send(s.id, "place a cube");
    await until(() => rig.store.get(s.id)!.status === "idle", 30_000, "the durable turn");

    // The same script on Studio's own loop, with the setting off.
    const loopData = path.join(dir, "loop");
    fs.mkdirSync(loopData);
    const loopHost = new FakeHost(path.join(dir, "project"), loopData);
    const loopStore = new SessionStore(loopData);
    const model: ModelProvider = {
      run: async (req) => {
        const n = req.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => (b as { type?: string }).type === "tool_result").length;
        const turn = script({ toolResults: n });
        const content: unknown[] = [];
        if (turn.text) content.push({ type: "text", text: turn.text, citations: null });
        if (turn.tool) content.push({ type: "tool_use", id: `toolu_${n}_${turn.tool.name}`, name: turn.tool.name, input: turn.tool.input });
        return { content, stopReason: turn.tool ? "tool_use" : "end_turn" } as ModelTurn;
      },
    };
    const loop = new AgentRunner({ host: loopHost, store: loopStore, provider: () => model, model: () => "claude-opus-5-5", askBeforeChanges: () => false });
    const l = loopStore.create("t");
    await loop.send(l.id, "place a cube");
    await until(() => loopStore.get(l.id)!.status === "idle", 10_000, "the loop turn");
    loop.dispose();
    const shape = (t: TranscriptEntry[]) => t.map((e) => (e.kind === "tool" ? { kind: e.kind, parent: e.parent, name: e.call.name, input: e.call.input, outcome: e.call.outcome, result: e.call.result, id: e.call.id } : { kind: e.kind, parent: e.parent, text: (e as { text?: string }).text }));
    expect(shape(transcript(rig.store, s.id))).toEqual(shape(loopStore.get(l.id)!.transcript));

    // An old phone's loader gets the chat from the durable session as from any other.
    const detail = SessionStore.detail(rig.store.get(s.id)!);
    const shown: SessionDetail[] = [];
    const failed: Error[] = [];
    const loader = new Build40Loader(async (_id, have, page) => syncOf(detail, have, page), (d) => shown.push(d), (e) => failed.push(e), { tail: 50 });
    await loader.load(s.id);
    expect(failed).toEqual([]);
    expect(shown.at(-1)!.transcript.map((e) => e.kind)).toEqual(["user", "assistant", "tool", "assistant"]);
    const page = syncOf(detail, undefined, { tail: 50 }) as unknown as Record<string, unknown>;
    for (const k of ["id", "title", "status", "createdAt", "updatedAt", "hashes"]) expect(typeof page[k], k).toBe("string");
    for (const k of ["transcript", "touched", "seen", "dismissed", "queue", "approvals"]) expect(Array.isArray(page[k]), k).toBe(true);
    expect(page).not.toHaveProperty("durable");
  }, 60_000);

  it("delivers the user's message to a running subagent, and marks it read when it reads it", async () => {
    fake = await startFakeAnthropic(({ toolResults, system, userText }) => {
      if (system.includes("You are a subagent")) {
        if (toolResults === 0) return { tool: { name: "ue_mcp", input: { action: "call", category: "asset", method: "list", args: {} } } };
        return { text: userText.includes("also count them") ? "Report: listed and counted." : "Report: listed." };
      }
      return toolResults === 0 ? { tool: { name: "agent", input: { description: "List assets", prompt: "List the assets." } } } : { text: "Done." };
    });
    rig = durableRunner({ projectDir: path.join(dir, "project"), dataDir: path.join(dir, "data"), base: fake.base, start });
    rig.host.callMs = 1500;
    const s = rig.store.create("t");
    await rig.runner.send(s.id, "list assets with a subagent");
    await until(() => editorCalls(path.join(dir, "data")).some((c) => c.category === "asset"), 20_000, "the subagent's call");
    const agent = transcript(rig.store, s.id).find((e) => e.kind === "tool" && e.call.name === "agent");
    const callId = agent?.kind === "tool" ? agent.call.id : "";
    expect(rig.runner.canMessage(rig.store.get(s.id)!, callId)).toBe(true);
    expect(await rig.runner.messageSubagent(s.id, callId, "also count them")).toBe(true);
    const told = () => transcript(rig.store, s.id).find((e) => e.kind === "user" && e.parent === callId);
    expect(told()).toMatchObject({ delivery: "waiting" });
    await until(() => rig.store.get(s.id)!.status === "idle", 30_000, "the turn to end");
    expect(told()).toMatchObject({ delivery: "read" });
    const done = transcript(rig.store, s.id).find((e) => e.kind === "tool" && e.call.id === callId);
    expect(done?.kind === "tool" && done.call.result).toContain("listed and counted");
  }, 60_000);

  it("stops one subagent and lets the turn go on", async () => {
    fake = await startFakeAnthropic(({ toolResults, system }) => {
      if (system.includes("You are a subagent")) return { tool: { name: "ue_mcp", input: { action: "call", category: "asset", method: "list", args: {} } } };
      return toolResults === 0 ? { tool: { name: "agent", input: { description: "Loop", prompt: "Keep listing." } } } : { text: "It was stopped." };
    });
    rig = durableRunner({ projectDir: path.join(dir, "project"), dataDir: path.join(dir, "data"), base: fake.base, start });
    rig.host.callMs = 300;
    const s = rig.store.create("t");
    await rig.runner.send(s.id, "start a subagent");
    await until(() => editorCalls(path.join(dir, "data")).filter((c) => c.category === "asset").length >= 2, 20_000, "the subagent working");
    const agent = transcript(rig.store, s.id).find((e) => e.kind === "tool" && e.call.name === "agent");
    const callId = agent?.kind === "tool" ? agent.call.id : "";
    expect(rig.runner.stopSubagent(s.id, callId)).toBe(true);
    await until(() => rig.store.get(s.id)!.status === "idle", 30_000, "the turn to end");
    const done = transcript(rig.store, s.id).find((e) => e.kind === "tool" && e.call.id === callId);
    expect(done?.kind === "tool" && done.call.outcome).toBe("stopped");
    expect(transcript(rig.store, s.id).at(-1)).toMatchObject({ kind: "assistant", text: "It was stopped." });
  }, 60_000);

  it("goes on through a daemon restart: the call cut off is unknown and never runs twice, and the turn finishes", async () => {
    fake = await startFakeAnthropic(({ toolResults }) => toolResults === 0
      ? { tool: { name: "ue_mcp", input: { action: "call", category: "level", method: "save", args: {} } } }
      : { text: "Checked after the restart." });
    const data = path.join(dir, "data");
    rig = durableRunner({ projectDir: path.join(dir, "project"), dataDir: data, base: fake.base, start });
    rig.host.callMs = 2000;
    const s = rig.store.create("t");
    await rig.runner.send(s.id, "save the level");
    await until(() => editorCalls(data).length === 1, 20_000, "the editor call");
    // The daemon goes down mid-call; the harness keeps the turn.
    rig.runner.dispose();
    rig.store.flush();
    const next = durableRunner({ projectDir: path.join(dir, "project"), dataDir: data, base: fake.base, start });
    rig = next;
    next.runner.recover();
    await until(() => next.store.get(s.id)!.status === "idle", 30_000, "the turn to end in the next daemon");
    const tool = transcript(next.store, s.id).find((e) => e.kind === "tool");
    expect(tool?.kind === "tool" && tool.call.outcome).toBe("unknown");
    expect(editorCalls(data).filter((c) => c.category === "level")).toHaveLength(1);
    expect(transcript(next.store, s.id).at(-1)).toMatchObject({ kind: "assistant", text: "Checked after the restart." });
  }, 60_000);

  it("pauses an editor call while the editor is down, showing the session as waiting, and goes on when it is back", async () => {
    fake = await startFakeAnthropic(({ toolResults }) => toolResults === 0
      ? { tool: { name: "ue_mcp", input: { action: "call", category: "level", method: "get_info", args: {} } } }
      : { text: "The editor is back." });
    rig = durableRunner({ projectDir: path.join(dir, "project"), dataDir: path.join(dir, "data"), base: fake.base, start });
    rig.host.connected = false;
    const s = rig.store.create("t");
    await rig.runner.send(s.id, "check the level");
    await until(() => rig.store.get(s.id)!.status === "waiting", 20_000, "the session to wait for the editor");
    expect(editorCalls(path.join(dir, "data"))).toHaveLength(0);
    rig.host.connected = true;
    rig.host.emit("editor.connected");
    await until(() => rig.store.get(s.id)!.status === "idle", 30_000, "the turn to end");
    expect(editorCalls(path.join(dir, "data")).filter((c) => c.category === "level")).toHaveLength(1);
    expect(transcript(rig.store, s.id).at(-1)).toMatchObject({ kind: "assistant", text: "The editor is back." });
  }, 60_000);

  it("moves a saved session onto the durable runtime with its conversation so far", async () => {
    fake = await startFakeAnthropic(({ userText }) => ({ text: userText.includes("the blue cube") ? "You asked about the blue cube." : "I do not know." }));
    rig = durableRunner({ projectDir: path.join(dir, "project"), dataDir: path.join(dir, "data"), base: fake.base, start });
    const s = rig.store.create("t");
    s.messages.push({ role: "user", content: [{ type: "text", text: "remember the blue cube" }] }, { role: "assistant", content: [{ type: "text", text: "Noted." }] } as never);
    s.transcript.push({ kind: "user", text: "remember the blue cube", at: new Date().toISOString() }, { kind: "assistant", text: "Noted.", at: new Date().toISOString() });
    rig.store.save(s);
    await rig.runner.send(s.id, "what did I ask about?");
    await until(() => rig.store.get(s.id)!.status === "idle", 30_000, "the turn to end");
    expect(transcript(rig.store, s.id).at(-1)).toMatchObject({ kind: "assistant", text: "You asked about the blue cube." });
  }, 60_000);
});

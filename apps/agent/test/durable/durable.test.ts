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
import { loadout } from "../../src/native.js";
import { composeNative, type NativeRun } from "../../src/native-runtime.js";
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

  it("sets no turn limit on a subagent: one past the old 200 steps still reports", async () => {
    const STEPS = 205;
    fake = await startFakeAnthropic(({ toolResults, system }) => {
      const sub = system.includes("You are a subagent");
      if (sub) return toolResults < STEPS ? { tool: { name: "ue_mcp", input: { action: "call", category: "asset", method: "list", args: { page: toolResults } } }, paceMs: 0 } : { text: "Report: listed every page." };
      return toolResults === 0 ? { tool: { name: "agent", input: { description: "List pages", prompt: "List every page." } } } : { text: "Done." };
    });
    rig = durableRunner({ projectDir: path.join(dir, "project"), dataDir: path.join(dir, "data"), base: fake.base, start });
    const s = rig.store.create("t");
    await rig.runner.send(s.id, "list every page with a subagent");
    await until(() => rig.store.get(s.id)!.status === "idle" || rig.store.get(s.id)!.status === "error", 150_000, "the turn to end");
    const agent = transcript(rig.store, s.id).find((e) => e.kind === "tool" && e.call.name === "agent");
    expect(agent?.kind === "tool" && agent.call.outcome).toBe("done");
    expect(agent?.kind === "tool" && agent.call.result).toContain("Report: listed every page.");
    expect(agent?.kind === "tool" && agent.call.result).not.toMatch(/turn_limit/);
    expect(editorCalls(path.join(dir, "data")).filter((c) => c.action === "list")).toHaveLength(STEPS);
  }, 180_000);

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

  it("runs a subagent the user assigned from a card in the harness, beside the main agent, and keeps its report for the next turn", async () => {
    fake = await startFakeAnthropic(({ toolResults, system }) => {
      if (system.includes("You are a subagent")) return toolResults === 0 ? { tool: { name: "ue_mcp", input: { action: "call", category: "level", method: "play", args: {} } } } : { text: "Report: the playtest passed." };
      return { text: "The main agent should not run." };
    });
    rig = durableRunner({ projectDir: path.join(dir, "project"), dataDir: path.join(dir, "data"), base: fake.base, start });
    const s = rig.store.create("t");
    const { callId, done } = rig.runner.assignSubagent(s.id, "Playtest the door", "Open the door in PIE.");
    const r = await done;
    expect(r).toMatchObject({ text: "Report: the playtest passed.", isError: false });
    const t = transcript(rig.store, s.id);
    const call = t.find((e) => e.kind === "tool" && e.call.id === callId);
    expect(call?.kind === "tool" && call.call.outcome).toBe("done");
    expect(t.filter((e) => e.parent === callId).map((e) => e.kind)).toEqual(["tool", "assistant"]);
    // It ran in the harness, made one editor call, and never woke the main agent.
    expect(rig.store.get(s.id)!.durable).toBeTruthy();
    expect(editorCalls(path.join(dir, "data")).filter((c) => c.category === "level")).toHaveLength(1);
    expect(fake.requests.every((q) => q.system.includes("You are a subagent"))).toBe(true);
    expect(rig.store.get(s.id)!.notes.join("\n")).toContain("Report: the playtest passed.");
    expect(rig.store.get(s.id)!.status).not.toBe("running");
  }, 60_000);

  it("resumes a stopped subagent in its kept conversation, from the list and through the agent tool", async () => {
    let lastSub = "";
    fake = await startFakeAnthropic(({ toolResults, system, userText }) => {
      if (system.includes("You are a subagent")) {
        lastSub = userText;
        if (userText.includes("The user resumed you") || userText.includes("carry on with the door")) return { text: "Report: the door is done." };
        return toolResults === 0 ? { tool: { name: "ue_mcp", input: { action: "call", category: "level", method: "build_door", args: {} } } } : { text: "unused" };
      }
      // The main agent resumes the second subagent by its call id.
      return toolResults === 0 ? { tool: { name: "agent", input: { description: "Door again", prompt: "carry on with the door", resume: resumeTarget } } } : { text: "Resumed it." };
    });
    let resumeTarget = "";
    rig = durableRunner({ projectDir: path.join(dir, "project"), dataDir: path.join(dir, "data"), base: fake.base, start });
    rig.host.callMs = 60_000;
    const s = rig.store.create("t");

    // From the list: a subagent stopped mid-call goes on in its own conversation under a new call.
    const first = rig.runner.assignSubagent(s.id, "Build the door", "Build the door in the level.");
    await until(() => editorCalls(path.join(dir, "data")).length === 1, 30_000, "the first call");
    expect(rig.runner.stopSubagent(s.id, first.callId)).toBe(true);
    expect((await first.done).stopped).toBe(true);
    rig.host.callMs = 0;
    const again = rig.runner.resumeSubagent(s.id, first.callId);
    expect(await again.done).toMatchObject({ text: "Report: the door is done.", isError: false });
    // The same conversation: what it was first told and the call it made are in the request that resumed it.
    expect(lastSub).toContain("Build the door in the level.");
    expect(lastSub).toContain("build_door");
    const entry = transcript(rig.store, s.id).find((e) => e.kind === "tool" && e.call.id === again.callId);
    expect(entry?.kind === "tool" && entry.call.input).toMatchObject({ resume: first.callId });

    // Through the agent tool: the main agent names the call to resume.
    rig.host.callMs = 60_000;
    const second = rig.runner.assignSubagent(s.id, "Build the gate", "Build the gate in the level.");
    await until(() => editorCalls(path.join(dir, "data")).length === 2, 30_000, "the second call");
    rig.runner.stopSubagent(s.id, second.callId);
    await second.done;
    rig.host.callMs = 0;
    resumeTarget = second.callId;
    await rig.runner.send(s.id, "resume the gate subagent");
    await until(() => rig.store.get(s.id)!.status === "idle", 40_000, "the turn to end");
    const agent = transcript(rig.store, s.id).find((e) => e.kind === "tool" && e.call.name === "agent" && (e.call.input as { resume?: string }).resume === second.callId && !e.call.id.startsWith("studio_"));
    expect(agent?.kind === "tool" && agent.call.result).toContain("Report: the door is done.");
    expect(lastSub).toContain("Build the gate in the level.");
  }, 120_000);

  it("refuses to resume a subagent that is running, unknown, or from before the durable runtime", async () => {
    fake = await startFakeAnthropic(() => ({ text: "ok" }));
    rig = durableRunner({ projectDir: path.join(dir, "project"), dataDir: path.join(dir, "data"), base: fake.base, start });
    const s = rig.store.create("t");
    expect(() => rig.runner.resumeSubagent(s.id, "nope")).toThrow(/no subagent nope/);
    s.transcript.push({ kind: "tool", call: { id: "old", name: "agent", input: { description: "Old", prompt: "x" }, outcome: "error", startedAt: new Date().toISOString() } });
    rig.store.save(s);
    expect(() => rig.runner.resumeSubagent(s.id, "old")).toThrow(/not kept/);
  }, 30_000);

  it("runs a helper on its own vendor's model, on that model's route", async () => {
    fake = await startFakeAnthropic(({ toolResults, system }) => {
      if (system.includes("You are a subagent")) return { text: "Report from the reviewer." };
      return toolResults === 0 ? { tool: { name: "agent", input: { description: "Review", prompt: "Review it.", helper: "reviewer" } } } : { text: "Reviewed." };
    });
    const projectDir = path.join(dir, "project");
    const l = loadout("claude", projectDir, path.join(dir, "home"), new Map(), dir);
    const asked: Array<{ model: string; on?: { route: string; vendor: string } }> = [];
    const native: NativeRun = {
      convention: "claude", loadout: l, composed: composeNative(l), skills: l.skills, sdkLoads: false,
      helpers: [{ name: "reviewer", description: "Reviews", prompt: "Review carefully.", allowed: null, maxTurns: null, effort: null, run: { provider: () => { throw new Error("unused"); }, model: "gpt-review", vendor: "openai", route: "key" } }],
    };
    rig = durableRunner({ projectDir, dataDir: path.join(dir, "data"), base: fake.base, start, extra: { native: () => native } });
    // The rig's routes, with the helper's own route recorded: both reach the stand-in.
    const durable = (rig.runner as unknown as { o: { durable: { routeSpec: (m: string, on?: { route: string; vendor: string }) => unknown } } }).o.durable;
    const base = durable.routeSpec;
    durable.routeSpec = (m, on) => {
      asked.push({ model: m, ...(on ? { on } : {}) });
      return on ? { route: "key:openai", provider: "other-vendor", api: "anthropic-messages", model: m, baseUrl: fake.base, auth: "apiKey" } : base(m);
    };
    const s = rig.store.create("t");
    await rig.runner.send(s.id, "review with the helper");
    await until(() => rig.store.get(s.id)!.status === "idle", 40_000, "the turn to end");
    expect(asked).toContainEqual({ model: "gpt-review", on: { route: "key", vendor: "openai" } });
    expect(fake.requests.find((q) => q.system.includes("You are a subagent"))?.model).toBe("gpt-review");
    expect(fake.requests.filter((q) => !q.system.includes("You are a subagent")).every((q) => q.model === "claude-opus-5-5")).toBe(true);
  }, 60_000);

  it("sends the provider's own web search with each request on a route that has one", async () => {
    fake = await startFakeAnthropic(() => ({ text: "Searched." }));
    rig = durableRunner({ projectDir: path.join(dir, "project"), dataDir: path.join(dir, "data"), base: fake.base, start, search: true });
    const s = rig.store.create("t");
    await rig.runner.send(s.id, "what is new in UE 5.9?");
    await until(() => rig.store.get(s.id)!.status === "idle", 30_000, "the turn to end");
    expect(fake.requests[0].serverTools).toContain("web_search_20250305");
    // Studio's own search tool is not offered beside the provider's.
    expect(fake.requests[0].tools.filter((t) => t === "web_search")).toHaveLength(1);
  }, 60_000);

  it("offers Studio's own web_search tool on a route whose provider has none", async () => {
    fake = await startFakeAnthropic(() => ({ text: "Searched." }));
    rig = durableRunner({ projectDir: path.join(dir, "project"), dataDir: path.join(dir, "data"), base: fake.base, start });
    const s = rig.store.create("t");
    await rig.runner.send(s.id, "what is new in UE 5.9?");
    await until(() => rig.store.get(s.id)!.status === "idle", 30_000, "the turn to end");
    expect(fake.requests[0].serverTools).toEqual([]);
    expect(fake.requests[0].tools).toContain("web_search");
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

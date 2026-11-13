/**
 * Subagents are Studio's on every route. The same scenarios run on Studio's
 * own loop (a scripted provider) and on the Claude sign-in (the scripted
 * runtime binary of fake-sdk.ts, each conversation in a turn host in this
 * process), and must behave the same: spawn, the limit and its queue, the
 * background, stopping one, stopping all, messaging a running subagent, the
 * finished-subagent fallback, the main agent taking messages while they run,
 * and a daemon restart mid-subagent.
 *
 * One script drives both: the main agent starts a subagent per task, then
 * says what it was given; each subagent makes one editor call (which a test
 * can hold) and reports, naming anything the user wrote to it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_USAGE } from "@ue-mcp-studio/shared";
import { Host, assistant, results, sdk, sleep, toolUse, until, use, type FakeBinary } from "./fake-sdk.js";
import type { ModelProvider, ModelRequest, ModelTurn } from "../src/providers.js";

vi.mock("../src/runtime.js", () => ({ ensureRuntime: async () => "claude.exe", installedRuntime: () => "claude.exe" }));
vi.mock("../src/claude-auth.js", async (actual) => {
  const login = { method: "claude.ai", subscription: "max", keySource: null };
  return { ...(await actual<typeof import("../src/claude-auth.js")>()), claudeLogin: () => login, refreshClaudeLogin: async () => login };
});
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./fake-sdk.js")).fakeSdk);

const { AgentRunner } = await import("../src/runner.js");
const { SessionStore } = await import("../src/sessions.js");
const { TurnHosts } = await import("../src/hosted-turn.js");
const { TurnHost } = await import("../src/turn-host.js");
const { runSubscriptionTurn } = await import("../src/subscription.js");

type Task = { id: string; description: string; prompt: string };

/** What the scripted agents do and saw, shared by both routes. */
let world: {
  tasks: Task[];
  started: string[];
  /** Everything the main agent was handed, as text. */
  mainSaw: string[];
  /** Editor calls held until a test opens them, by the name they create. */
  held: Map<string, { p: Promise<void>; open: () => void }>;
  calls: string[];
};
let root: string;
let host: Host;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-parity-"));
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  fs.mkdirSync(path.join(root, "project", "Content"), { recursive: true });
  host = new Host(path.join(root, "project"), path.join(root, "data"));
  world = { tasks: [], started: [], mainSaw: [], held: new Map(), calls: [] };
  host.callAction = (async (category: string, action: string, args?: Record<string, unknown>) => {
    const name = String(args?.name ?? "");
    world.calls.push(name);
    await world.held.get(name)?.p;
    return { isError: false, content: [{ type: "text", text: JSON.stringify({ success: true, created: name, category, action }) }] };
  }) as Host["callAction"];
  sdk.prompts = [];
  sdk.options = [];
  sdk.script = claudeScript;
});

afterEach(async () => {
  for (const h of world.held.values()) h.open();
  await sleep(50);
  fs.rmSync(root, { recursive: true, force: true });
});

/** Hold the editor call that creates `name` until open() is called. */
function hold(name: string): () => void {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  world.held.set(name, { p, open });
  return open;
}

const isSubagentPrompt = (system: string) => system.includes("You are a subagent");
const heardIn = (texts: string[]) => texts.filter((t) => t.startsWith("The user writes to you")).map((t) => t.split("\n\n").slice(1).join(" "));
const reportOf = (prompt: string, heard: string[]) => `${prompt} done${heard.length ? ` (heard: ${heard.join("; ")})` : ""}`;

/** What the main agent says to what it was handed last. */
function mainReply(texts: string[], toolResults: string[]): string {
  const report = texts.find((t) => /has ended/.test(t));
  if (report) return `Main got report: ${/The subagent "([^"]+)"/.exec(report)?.[1] ?? "?"}`;
  const own = texts.filter((t) => !t.startsWith("[Studio]"));
  if (own.length) return `Main heard: ${own.join(" ")}`;
  return `Reports: ${toolResults.join(" | ")}`;
}

/** Studio's loop: one provider for the main agent and every subagent, told apart by the system prompt. */
const loopProvider: ModelProvider = {
  async run(req: ModelRequest): Promise<ModelTurn> {
    const system = req.system.map((b) => b.text).join("\n");
    const blocks = (m: ModelRequest["messages"][number]) => (typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as Array<{ type: string; text?: string; content?: unknown }>));
    const say = (text: string): ModelTurn => ({ content: [{ type: "text", text, citations: null } as never], stopReason: "end_turn" });
    if (isSubagentPrompt(system)) {
      const prompt = String(req.messages[0].content);
      const steps = req.messages.filter((m) => m.role === "assistant").length;
      if (steps === 0) {
        world.started.push(prompt);
        return { content: [{ type: "tool_use", id: `c-${prompt}`, name: "ue_mcp", input: { action: "call", category: "asset", method: "create", args: { name: prompt } } } as never], stopReason: "tool_use" };
      }
      const texts = req.messages.filter((m) => m.role === "user").flatMap((m) => blocks(m)).filter((b) => b.type === "text").map((b) => b.text ?? "");
      return say(reportOf(prompt, heardIn(texts)));
    }
    world.mainSaw.push(JSON.stringify(req.messages));
    if (req.messages.length === 1 && world.tasks.length) {
      return { content: world.tasks.map((t) => ({ type: "tool_use", id: t.id, name: "agent", input: { description: t.description, prompt: t.prompt } })) as never, stopReason: "tool_use" };
    }
    const last = blocks(req.messages[req.messages.length - 1]);
    const texts = last.filter((b) => b.type === "text").map((b) => b.text ?? "");
    const toolResults = last.filter((b) => b.type === "tool_result").map((b) => (typeof b.content === "string" ? b.content : JSON.stringify(b.content)));
    return say(mainReply(texts, toolResults));
  },
};

/** The Claude sign-in: the same agents as runtime conversations, the main agent calling Studio's agent tool. */
async function claudeScript(b: FakeBinary): Promise<void> {
  const prompt = await b.first();
  const done = (text: string) => {
    b.emit(assistant(`m_${Math.random().toString(36).slice(2)}`, [{ type: "text", text }]));
    b.emit({ type: "result", subtype: "success", is_error: false, session_id: "sdk" });
  };
  if (isSubagentPrompt(String(b.options.systemPrompt))) {
    const task = prompt.split("\n\n")[0];
    world.started.push(task);
    await use(b, `c-${task}`, "ue_mcp", { action: "call", category: "asset", method: "create", args: { name: task } });
    // What was streamed into its input meanwhile is read at this step.
    await sleep(20);
    done(reportOf(task, heardIn(b.said.map(String))));
    return;
  }
  world.mainSaw.push(prompt);
  const paragraphs = prompt.split("\n\n");
  if (/^go\b/.test(prompt) && world.tasks.length) {
    b.emit(assistant("m_agents", world.tasks.map((t) => toolUse(t.id, "agent", { description: t.description, prompt: t.prompt }))));
    const answers = await Promise.all(world.tasks.map((t) => b.call("agent", { description: t.description, prompt: t.prompt })));
    world.tasks.forEach((t, i) => b.emit(results(t.id, answers[i])));
    if (answers.some((a) => /keeps working in the background/.test(a.text))) {
      // Its subagents went on in the background because the user wrote: the message follows their calls' answers.
      await until(() => b.said.length > 0 || b.signal.aborted, 5000).catch(() => undefined);
      if (b.signal.aborted) return;
      const said = b.said.map(String);
      world.mainSaw.push(...said);
      done(mainReply(said.flatMap((x) => x.split("\n\n")), []));
      return;
    }
    done(mainReply([], answers.map((a) => a.text)));
    return;
  }
  done(mainReply(paragraphs, []));
}

/** Turn hosts in this process: the real TurnHost and conversation code, over a real socket. */
const hostsOn = () =>
  new TurnHosts({
    dataDir: host.dataDir,
    projectDir: host.projectDir,
    version: "test",
    script: null,
    log: host.log,
    reconnectMs: 500,
    launch: (file) => {
      const launch = JSON.parse(fs.readFileSync(file, "utf-8"));
      fs.rmSync(file, { force: true });
      const h = new TurnHost({ launch, run: runSubscriptionTurn, endAckMs: 2000 });
      let gone = false;
      void h.start().then(() => h.done).finally(() => void (gone = true));
      return { exited: () => gone, kill: () => {} };
    },
  });

interface RouteCase {
  name: string;
  daemon(limit?: number): { runner: InstanceType<typeof AgentRunner>; store: InstanceType<typeof SessionStore> };
}

const routes: RouteCase[] = [
  {
    name: "Studio's loop (an API route)",
    daemon: (limit = 4) => {
      const store = new SessionStore(host.dataDir);
      return { store, runner: new AgentRunner({ host, store, provider: () => loopProvider, model: () => "gpt-6", askBeforeChanges: () => false, usage: () => ({ ...DEFAULT_USAGE, subagents: "automatic", subagentsPerTurn: limit }) }) };
    },
  },
  {
    name: "the Claude sign-in",
    daemon: (limit = 4) => {
      const store = new SessionStore(host.dataDir);
      return { store, runner: new AgentRunner({ host, store, provider: () => { throw new Error("the API route is not used"); }, model: () => "claude-opus-5-5", subscription: () => true, askBeforeChanges: () => false, turnHosts: hostsOn(), usage: () => ({ ...DEFAULT_USAGE, subagents: "automatic", subagentsPerTurn: limit }) }) };
    },
  },
];

type Session = ReturnType<InstanceType<typeof SessionStore>["get"]> & object;
const agentCall = (s: Session, id: string) => s.transcript.find((t) => t.kind === "tool" && t.call.id === id && t.call.name === "agent") as { call: { outcome: string; result?: string; queued?: boolean } } | undefined;
const call = (s: Session, id: string) => s.transcript.find((t) => t.kind === "tool" && t.call.id === id) as { call: { outcome: string; result?: string }; parent?: string } | undefined;
const mainSaid = (s: Session) => s.transcript.filter((t) => t.kind === "assistant" && !t.parent).map((t) => (t as { text: string }).text);
const queued = (s: Session) => s.transcript.flatMap((t) => (t.kind === "tool" && t.call.queued ? [t.call.id] : []));
const T = 15_000;

describe.each(routes)("subagents on $name", (route) => {
  it("start one per task, run at the same time, and answer their calls with their reports", async () => {
    world.tasks = [{ id: "door", description: "Build the door", prompt: "door" }, { id: "hall", description: "Light the hall", prompt: "hall" }];
    const open = [hold("door"), hold("hall")];
    const { runner, store } = route.daemon();
    const s = store.create();
    void runner.send(s.id, "go build");
    await until(() => world.calls.includes("door") && world.calls.includes("hall"), T);
    // Both are in their editor call at once.
    expect(store.get(s.id)!.transcript.filter((t) => t.kind === "tool" && t.call.name === "agent").every((t) => t.kind === "tool" && t.call.outcome === "pending")).toBe(true);
    open.forEach((o) => o());
    await until(() => store.get(s.id)!.status === "idle", T);
    const fin = store.get(s.id)!;
    expect(agentCall(fin, "door")!.call).toMatchObject({ outcome: "done", result: "door done" });
    expect(agentCall(fin, "hall")!.call).toMatchObject({ outcome: "done", result: "hall done" });
    expect(call(fin, "c-door")).toMatchObject({ parent: "door", call: { outcome: "done" } });
    expect(mainSaid(fin).at(-1)).toBe("Reports: door done | hall done");
  }, 30_000);

  it("run as many at once as the limit says; the rest wait to start, shown queued, and still report (#164)", async () => {
    world.tasks = ["a", "b", "c"].map((p) => ({ id: p, description: p, prompt: p }));
    const open = { a: hold("a"), b: hold("b"), c: hold("c") };
    const { runner, store } = route.daemon(1);
    const s = store.create();
    void runner.send(s.id, "go three");
    await until(() => world.started.length === 1 && queued(store.get(s.id)!).length === 2, T);
    expect(world.started).toEqual(["a"]);
    open.a();
    await until(() => world.started.length === 2, T);
    expect(queued(store.get(s.id)!)).toEqual(["c"]);
    open.b();
    await until(() => world.started.length === 3, T);
    open.c();
    await until(() => store.get(s.id)!.status === "idle", T);
    const fin = store.get(s.id)!;
    expect(world.started).toEqual(["a", "b", "c"]);
    expect(queued(fin)).toEqual([]);
    expect(mainSaid(fin).at(-1)).toBe("Reports: a done | b done | c done");
  }, 30_000);

  it("stop one subagent: its call and the call in flight end as stopped, and the turn goes on", async () => {
    world.tasks = [{ id: "door", description: "Build the door", prompt: "door" }, { id: "hall", description: "Light the hall", prompt: "hall" }];
    hold("door");
    const openHall = hold("hall");
    const { runner, store } = route.daemon();
    const s = store.create();
    void runner.send(s.id, "go build");
    await until(() => world.calls.includes("door") && world.calls.includes("hall"), T);
    expect(runner.stopSubagent(s.id, "door")).toBe(true);
    await until(() => agentCall(store.get(s.id)!, "door")?.call.outcome === "stopped", T);
    expect(call(store.get(s.id)!, "c-door")!.call.outcome).toBe("stopped");
    openHall();
    await until(() => store.get(s.id)!.status === "idle", T);
    const fin = store.get(s.id)!;
    expect(agentCall(fin, "hall")!.call.outcome).toBe("done");
    expect(mainSaid(fin).at(-1)).toMatch(/^Reports: The user stopped this subagent.*\| hall done$/);
  }, 30_000);

  it("Stop all ends the turn and every subagent in it", async () => {
    world.tasks = [{ id: "door", description: "Build the door", prompt: "door" }, { id: "hall", description: "Light the hall", prompt: "hall" }];
    hold("door");
    hold("hall");
    const { runner, store } = route.daemon();
    const s = store.create();
    void runner.send(s.id, "go build");
    await until(() => world.calls.length === 2, T);
    runner.stopAll(s.id);
    const fin = store.get(s.id)!;
    expect(fin.status).toBe("stopped");
    expect([agentCall(fin, "door")!.call.outcome, agentCall(fin, "hall")!.call.outcome]).toEqual(["stopped", "stopped"]);
    await until(() => !runner.keepsSubagents(s.id), T);
  }, 30_000);

  it("a first Stop ends only the main agent's reply: the subagent goes on in the background, and its report wakes the main agent", async () => {
    world.tasks = [{ id: "door", description: "Build the door", prompt: "door" }];
    const open = hold("door");
    const { runner, store } = route.daemon();
    const s = store.create();
    void runner.send(s.id, "go build");
    await until(() => world.calls.includes("door"), T);
    expect(runner.stopKeepsSubagents(s.id)).toBe(true);
    runner.stop(s.id);
    let now = store.get(s.id)!;
    expect(now.status).toBe("running");
    expect(now.mainFree).toBe(true);
    expect(agentCall(now, "door")!.call.outcome).toBe("pending");
    open();
    await until(() => store.get(s.id)!.status === "idle", T);
    now = store.get(s.id)!;
    expect(agentCall(now, "door")!.call).toMatchObject({ outcome: "done", result: "door done" });
    expect(mainSaid(now).at(-1)).toBe("Main got report: Build the door");
  }, 30_000);

  it("a message to a running subagent reaches it at its next step, and only it", async () => {
    world.tasks = [{ id: "door", description: "Build the door", prompt: "door" }];
    const open = hold("door");
    const { runner, store } = route.daemon();
    const s = store.create();
    void runner.send(s.id, "go build");
    await until(() => world.calls.includes("door") && runner.canMessage(store.get(s.id)!, "door"), T);
    expect(await runner.messageSubagent(s.id, "door", "make it red")).toBe(true);
    expect(store.get(s.id)!.transcript.at(-1)).toMatchObject({ kind: "user", text: "make it red", parent: "door" });
    open();
    await until(() => store.get(s.id)!.status === "idle", T);
    const fin = store.get(s.id)!;
    // Its report, and what the user wrote to it, so the main agent knows the instruction was the user's.
    expect(agentCall(fin, "door")!.call.result).toMatch(/^door done \(heard: make it red\)\n\n\[Studio\] While it worked, the user wrote to this subagent from its thread[\s\S]*make it red$/);
    // Nothing stopped, and the main agent saw the message only with that report.
    expect(world.mainSaw.some((m) => m.includes("make it red") && !m.includes("door done"))).toBe(false);
    expect(fin.transcript.some((t) => t.kind === "note" && /ended before it read/.test((t as { text: string }).text))).toBe(false);
  }, 30_000);

  it("a message written in a finished subagent's thread goes to the main agent, saying whose thread it was", async () => {
    world.tasks = [{ id: "door", description: "Build the door", prompt: "door" }];
    const { runner, store } = route.daemon();
    const s = store.create();
    await runner.send(s.id, "go build");
    await until(() => store.get(s.id)!.status === "idle", T);
    expect(runner.canMessage(store.get(s.id)!, "door")).toBe(false);
    expect(await runner.messageSubagent(s.id, "door", "and the color?")).toBe(false);
    await runner.send(s.id, "and the color?", [], "door");
    await until(() => store.get(s.id)!.status === "idle" && mainSaid(store.get(s.id)!).length === 2, T);
    expect(world.mainSaw.at(-1)).toMatch(/while looking at the thread of the subagent \\?"Build the door\\?"/);
    expect(mainSaid(store.get(s.id)!).at(-1)).toMatch(/Main heard: .*and the color\?/);
  }, 30_000);

  it("the main agent takes the user's message while its subagent runs: the subagent goes on in the background and reports later", async () => {
    world.tasks = [{ id: "door", description: "Build the door", prompt: "door" }];
    const open = hold("door");
    const { runner, store } = route.daemon();
    const s = store.create();
    void runner.send(s.id, "go build");
    await until(() => world.calls.includes("door") && runner.mainFree(s.id), T);
    expect(store.get(s.id)!.mainFree).toBe(true);
    await runner.send(s.id, "how is it going?");
    await until(() => mainSaid(store.get(s.id)!).includes("Main heard: how is it going?"), T);
    // The subagent is still working, and was never stopped.
    expect(agentCall(store.get(s.id)!, "door")!.call.outcome).toBe("pending");
    open();
    await until(() => store.get(s.id)!.status === "idle", T);
    const fin = store.get(s.id)!;
    expect(agentCall(fin, "door")!.call).toMatchObject({ outcome: "done", result: "door done" });
    expect(mainSaid(fin).at(-1)).toBe("Main got report: Build the door");
  }, 30_000);

  it("a daemon restart mid-subagent: the subagent goes on in the next daemon and its report answers its call", async () => {
    world.tasks = [{ id: "door", description: "Build the door", prompt: "door" }];
    hold("door");
    const d1 = route.daemon();
    const s = d1.store.create();
    void d1.runner.send(s.id, "go build");
    await until(() => world.calls.includes("door"), T);
    await sleep(50);
    d1.runner.dispose();
    const d2 = route.daemon();
    d2.runner.recover();
    await until(() => d2.store.get(s.id)!.status === "idle", T);
    const fin = d2.store.get(s.id)!;
    // The call it was making when the daemon went down is never run again: its outcome is unknown.
    expect(world.calls.filter((c) => c === "door")).toHaveLength(1);
    expect(call(fin, "c-door")!.call.outcome).toBe("unknown");
    expect(agentCall(fin, "door")!.call).toMatchObject({ outcome: "done", result: "door done" });
    expect(mainSaid(fin).at(-1)).toBe("Reports: door done");
    expect(fin.agentRuns ?? {}).toEqual({});
  }, 30_000);
});

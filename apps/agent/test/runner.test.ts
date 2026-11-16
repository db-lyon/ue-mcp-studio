/**
 * Studio's sessions on the durable runtime against a stand-in Messages API and
 * a fake daemon: a real harness in process, no network beyond loopback, no
 * editor. Each case scripts what the model answers per request and reads what
 * the model was sent from the stand-in.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ActionResult } from "ue-mcp/daemon";
import { AgentRunner, type RunnerOptions } from "../src/runner.js";
import { BusyTracker } from "../src/busy.js";
import { SessionStore } from "../src/sessions.js";
import { SettingsStore } from "../src/settings.js";
import { validateInput } from "../src/tools.js";
import { pngBytes } from "./image-fixtures.js";
import { DEFAULT_USAGE, type UsageSettings } from "@ue-mcp-studio/shared";
import { loadout } from "../src/native.js";
import { composeNative, type NativeRun } from "../src/native-runtime.js";
import { setRipgrep } from "../src/local-tools.js";
import { registerQueueRoutes } from "../src/queue-routes.js";
import { AttachmentStore } from "../src/attachments.js";
import { runHarness } from "../src/durable/harness-main.js";
import { FakeHost, durableRunner, until } from "./durable/helpers.js";
import { startFakeAnthropic, type FakeAnthropic, type FakeRequest, type FakeScriptRequest, type FakeTurn } from "./durable/fake-anthropic.js";

type Script = (req: FakeScriptRequest) => FakeTurn | Promise<FakeTurn>;
type Block = { type: string; text?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };

const text = (t: string): FakeTurn => ({ text: t });
const use = (id: string, name: string, input: Record<string, unknown>): FakeTurn => ({ tool: { id, name, input } });
const call = (id: string, category: string, method: string, args: Record<string, unknown> = {}): FakeTurn => use(id, "ue_mcp", { action: "call", category, method, args });

/** Answers one turn per request, in order. */
const seq = (turns: Array<FakeTurn | Script>): Script => (req) => {
  const next = turns.shift();
  if (!next) return text("(the script is exhausted)");
  return typeof next === "function" ? next(req) : next;
};

/** A request's messages' content as blocks. */
const blocks = (m: { content: unknown }): Block[] => (typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as Block[]));
/** A tool result's text, however it was sent. */
const resultText = (b: Block | null | undefined): string => {
  if (!b) return "";
  const c = b.content;
  return typeof c === "string" ? c : Array.isArray(c) ? (c as Block[]).filter((x) => x.type === "text").map((x) => x.text ?? "").join("") : "";
};
/** The tool result for a call in one request, if it holds one. */
const resultIn = (req: FakeRequest | undefined, id: string): Block | null => {
  for (const m of req?.messages ?? []) for (const b of blocks(m)) if (b.type === "tool_result" && b.tool_use_id === id) return b;
  return null;
};
/** The text of each user message that is not only tool results. */
const userTexts = (req: FakeRequest) => req.messages.filter((m) => m.role === "user").map((m) => blocks(m).filter((b) => b.type === "text").map((b) => b.text).join(" ")).filter(Boolean);
/** A subagent's task: the text of its first message. */
const taskOf = (req: FakeRequest): string => blocks(req.messages[0]).filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
const said = (req: FakeRequest) => JSON.stringify(req.messages);
/** The last user message a request carries (pi-ai follows it with its effort marker). */
const lastUser = (req: FakeRequest) => req.messages.filter((m) => m.role === "user").at(-1)!;
/** The conversation's turns, without pi-ai's effort markers. */
const roles = (req: FakeRequest) => req.messages.map((m) => m.role).filter((r) => r !== "system");
/** The tools a request offered, without the harness's own placeholder. */
const toolsOf = (req: FakeRequest) => req.tools.filter((t) => !t.startsWith("__pi_"));
/** The effort a request ran at: pi-ai's last effort marker. */
const effortOf = (req: FakeRequest) => (req.messages.filter((m) => m.role === "system").at(-1) as { output_config?: { effort?: string } } | undefined)?.output_config?.effort;

let root: string;
let host: FakeHost;
let store: SessionStore;
let fake: FakeAnthropic | null;
let script: Script;
let harness: { close(): Promise<void> } | null;
let runners: AgentRunner[];

const ok = (t = "{\"success\":true}"): ActionResult => ({ isError: false, content: [{ type: "text", text: t }] });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-agent-"));
  fs.mkdirSync(path.join(root, "project", "Content"), { recursive: true });
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  host = new FakeHost(path.join(root, "project"), path.join(root, "data"));
  host.handler = async () => ok();
  store = new SessionStore(host.dataDir);
  fake = null;
  harness = null;
  runners = [];
  script = () => text("ok");
});

afterEach(async (ctx) => {
  if (ctx.task.result?.state === "fail" && process.env.DEBUG_RUNNER) {
    for (const r of fake?.requests ?? []) console.log("REQUEST", r.model, r.sub, JSON.stringify(r.tools), JSON.stringify(r.messages).slice(0, 3000), JSON.stringify([r.body.thinking, r.body.output_config]));
    console.log("HOST LOG\n", host.logged.join("\n"));
    for (const s of store.all()) console.log("SESSION", s.status, s.error, JSON.stringify(s.queue), JSON.stringify(s.transcript).slice(0, 3000));
  }
  for (const r of runners) r.dispose();
  await harness?.close();
  await fake?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * A runner on the durable harness, its model answering through `s`. Asks
 * before commands and file changes, as Studio does by default, unless `extra`
 * says otherwise.
 */
async function runnerWith(s: Script, extra: Partial<RunnerOptions> = {}, sessions = store): Promise<AgentRunner> {
  script = s;
  fake ??= await startFakeAnthropic((req) => script(req));
  const { runner } = durableRunner({
    projectDir: host.projectDir,
    dataDir: host.dataDir,
    base: fake.base,
    host,
    store: sessions,
    start: async (launch) => {
      harness ??= await runHarness(launch);
    },
    extra: { askBeforeChanges: undefined, ...extra },
  });
  runners.push(runner);
  return runner;
}

const statusOf = (id: string, sessions = store) => sessions.get(id)!.status;
const idle = (id: string, sessions = store) => until(() => statusOf(id, sessions) === "idle", 30_000, "the turn to end");
const T = 60_000;

/** The project's own Claude Code files as chat-routes reads them, bounded to the test's folder. */
function nativeClaude(): NativeRun {
  const l = loadout("claude", host.projectDir, path.join(root, "home"), new Map(), root);
  return { convention: "claude", loadout: l, composed: composeNative(l), helpers: [], skills: l.skills };
}

const WORK = ["ue_mcp", "editor_restart", "shell", "read_file", "write_file", "edit_file", "glob", "grep", "web_fetch"];

describe("a turn", () => {
  it("runs a tool call in process and returns its result to the model in one message", async () => {
    const runner = await runnerWith(seq([call("t1", "level", "get_outliner"), { text: "Done: the level holds what the outliner listed.", paceMs: 60 }]));
    const s = store.create();
    await runner.send(s.id, "what is in the level");
    await idle(s.id);

    expect(host.calls).toEqual([{ category: "level", action: "get_outliner", args: {} }]);
    expect(store.get(s.id)!.transcript.map((t) => t.kind)).toEqual(["user", "tool", "assistant"]);
    expect(host.published.some((e) => e.type === "turn.delta")).toBe(true);
    // The call's result goes back in one message, as the call's tool result.
    expect(blocks(lastUser(fake!.requests[1])).filter((b) => b.type === "tool_result").map((b) => b.tool_use_id)).toEqual(["t1"]);
    // The model is sent the work tools, the agent tool, and Studio's own web search on a route without one.
    expect(toolsOf(fake!.requests[0])).toEqual([...WORK, "agent", "web_search"]);
  }, T);

  it("finds and describes actions through ue-mcp's own discovery actions", async () => {
    const runner = await runnerWith(seq([
      use("s", "ue_mcp", { action: "search", query: "spawn a light" }),
      use("d", "ue_mcp", { action: "describe", category: "level", method: "spawn_light" }),
      text("ok"),
    ]));
    const s = store.create();
    await runner.send(s.id, "light it");
    await idle(s.id);
    expect(host.calls).toEqual([
      { category: "project", action: "search_tools", args: { query: "spawn a light", limit: 15 } },
      { category: "project", action: "describe_action", args: { name: "level.spawn_light" } },
    ]);
  }, T);
});

describe("attachments in a message", () => {
  it("go to the model before the text, and into the transcript by name", async () => {
    const runner = await runnerWith(seq([text("Seen.")]));
    const s = store.create();
    const file = path.join(root, "ref.png");
    fs.writeFileSync(file, pngBytes(4, 4));
    await runner.send(s.id, "use this", [{ id: "a1", name: "ref.png", type: "image/png", size: 3, path: file }]);
    await idle(s.id);
    const sent = blocks(fake!.requests[0].messages[0]);
    expect(sent.map((b) => b.type)).toEqual(["text", "image", "text"]);
    expect(sent.at(-1)!.text).toBe("use this");
    const entry = store.get(s.id)!.transcript[0];
    expect(entry.kind === "user" && entry.attachments).toEqual([{ id: "a1", name: "ref.png", type: "image/png", size: 3 }]);
  }, T);
});

describe("images a tool shows the model", () => {
  it("go to the model in the tool result, and into the transcript as the session's files", async () => {
    fs.writeFileSync(path.join(host.projectDir, "shot.png"), pngBytes(12, 6));
    const runner = await runnerWith(seq([use("r1", "read_file", { path: "shot.png" }), text("A flat orange picture.")]));
    const s = store.create();
    await runner.send(s.id, "what is in shot.png");
    await idle(s.id);
    const sent = resultIn(fake!.requests[1], "r1")!;
    expect((sent.content as Block[]).map((b) => b.type)).toEqual(["text", "image"]);
    const entry = store.get(s.id)!.transcript.find((t) => t.kind === "tool");
    const images = entry?.kind === "tool" ? entry.call.images : undefined;
    expect(images).toEqual([expect.objectContaining({ name: "shot.png", type: "image/png" })]);
    // The panel fetches it by id from the session's files.
    const kept = fs.readdirSync(path.join(host.dataDir, "attachments", s.id));
    expect(kept).toContain(`${images![0].id}-shot.png`);
  }, T);

  it("reach a subagent's model too", async () => {
    fs.writeFileSync(path.join(host.projectDir, "a.png"), pngBytes(4, 4));
    const runner = await runnerWith((req) => {
      if (req.sub) return req.toolResults === 0 ? use("r2", "read_file", { path: "a.png" }) : text("It is orange.");
      return req.toolResults === 0 ? use("ag", "agent", { description: "look", prompt: "look at a.png" }) : text("Done.");
    });
    const s = store.create();
    await runner.send(s.id, "check a.png");
    await idle(s.id);
    const sub = fake!.requests.find((r) => r.sub && r.toolResults === 1)!;
    expect((resultIn(sub, "r2")!.content as Block[]).map((b) => b.type)).toEqual(["text", "image"]);
  }, T);
});

describe("archived sessions", () => {
  it("are listed as archived, and come back when the user sends to one", async () => {
    const s = store.create();
    s.archived = true;
    store.save(s);
    expect(SessionStore.summary(store.get(s.id)!).archived).toBe(true);
    const runner = await runnerWith(seq([text("Hi.")]));
    await runner.send(s.id, "hello again");
    expect(SessionStore.summary(store.get(s.id)!).archived).toBe(false);
    await idle(s.id);
  }, T);
});

describe("subagents", () => {
  it("runs each agent call as its own conversation, at the same time, and returns each report", async () => {
    let running = 0;
    let most = 0;
    const runner = await runnerWith(async (req) => {
      if (!req.sub) {
        return req.toolResults === 0
          ? { tools: [{ id: "a1", name: "agent", input: { description: "Red material", prompt: "make red" } }, { id: "a2", name: "agent", input: { description: "Blue material", prompt: "make blue" } }] }
          : text("Both made.");
      }
      const task = taskOf(req);
      if (req.toolResults === 0) {
        running++;
        most = Math.max(most, running);
        await new Promise((r) => setTimeout(r, 300));
        running--;
        return call(`c_${task.split(" ")[1]}`, "material", "create", { name: task });
      }
      return text(`Report: ${task} done.`);
    });
    const s = store.create();
    await runner.send(s.id, "make two materials");
    await idle(s.id);

    const fin = store.get(s.id)!;
    expect(most).toBe(2);
    // A subagent gets the work tools and its reply to the user, so it cannot start subagents of its own.
    const subReq = fake!.requests.find((r) => r.sub)!;
    expect(toolsOf(subReq)).toEqual([...WORK, "reply", "web_search"]);
    // Both prompts ask for assets as markdown links to their full object path.
    const link = "markdown link to its full object path";
    expect(subReq.system).toContain(link);
    expect(fake!.requests.find((r) => !r.sub)!.system).toContain(link);
    const main = fake!.requests.filter((r) => !r.sub).at(-1)!;
    expect([resultText(resultIn(main, "a1")), resultText(resultIn(main, "a2"))]).toEqual(["Report: make red done.", "Report: make blue done."]);
    // Their steps are in the transcript under the call that started them.
    expect(fin.transcript.filter((t) => t.parent === "a1").map((t) => t.kind)).toEqual(["tool", "assistant"]);
    expect(fin.transcript.filter((t) => t.parent === "a2").map((t) => t.kind)).toEqual(["tool", "assistant"]);
    expect(fin.transcript.filter((t) => !t.parent).map((t) => t.kind)).toEqual(["user", "tool", "tool", "assistant"]);
  }, T);
});

describe("messaging a running subagent from its thread", () => {
  /** A main agent that starts door and hall; the door subagent holds its first step until `release`. */
  async function doorAndHall() {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const runner = await runnerWith(async (req) => {
      if (!req.sub) {
        return req.toolResults === 0
          ? { tools: [{ id: "door", name: "agent", input: { description: "Build the door", prompt: "door" } }, { id: "hall", name: "agent", input: { description: "Light the hall", prompt: "hall" } }] }
          : text("Both done.");
      }
      const task = taskOf(req);
      if (req.toolResults === 0) {
        // The door subagent is mid-step when the user writes to it.
        if (task === "door") await gate;
        return call(`c_${task}`, "asset", "create", { name: task });
      }
      return text(said(req).includes("make it red") ? "Door built, red as you asked." : `${task} done.`);
    });
    return { runner, release };
  }

  it("adds the message to that subagent's conversation before its next model call, and to no one else's", async () => {
    const { runner, release } = await doorAndHall();
    const s = store.create();
    await runner.send(s.id, "door and hall");
    await until(() => runner.canMessage(store.get(s.id)!, "door"), 30_000, "the door subagent");
    expect(await runner.messageSubagent(s.id, "door", "make it red")).toBe(true);
    expect(store.get(s.id)!.transcript.at(-1)).toMatchObject({ kind: "user", text: "make it red", parent: "door" });
    release();
    await idle(s.id);

    const fin = store.get(s.id)!;
    const door = fake!.requests.filter((r) => r.sub && taskOf(r) === "door");
    expect(said(door[0])).not.toMatch(/make it red/);
    expect(said(door.at(-1)!)).toMatch(/make it red/);
    // The hall subagent never sees it; the main agent only with the door's report.
    expect(fake!.requests.filter((r) => r.sub && taskOf(r) === "hall").some((r) => said(r).includes("make it red"))).toBe(false);
    expect(fake!.requests.filter((r) => !r.sub).some((r) => said(r).includes("make it red") && !said(r).includes("Door built"))).toBe(false);
    const main = fake!.requests.filter((r) => !r.sub).at(-1)!;
    expect(resultText(resultIn(main, "door"))).toMatch(/^Door built, red as you asked\./);
    expect(fin.transcript.find((t) => t.kind === "user" && t.parent === "door")).toMatchObject({ delivery: "read" });
    expect(fin.transcript.filter((t) => t.kind === "tool" && t.call.name === "agent").map((t) => (t as { call: { outcome: string } }).call.outcome)).toEqual(["done", "done"]);
  }, T);

  it("frames the message as the user's, as the subagent's prompt says, and names it in the report the main agent gets", async () => {
    const { runner, release } = await doorAndHall();
    const s = store.create();
    await runner.send(s.id, "door and hall");
    await until(() => runner.canMessage(store.get(s.id)!, "door"), 30_000, "the door subagent");
    expect(await runner.messageSubagent(s.id, "door", "make it red")).toBe(true);
    release();
    await idle(s.id);
    const door = fake!.requests.filter((r) => r.sub && taskOf(r) === "door");
    expect(door[0].system).toContain("The user writes to you from your thread");
    expect(door[0].system).not.toMatch(/key [0-9a-f]{10}/);
    // A user message in its own conversation, framed as the system prompt says: no relay key or trust mark.
    const told = door.at(-1)!.messages.flatMap(blocks).find((b) => b.type === "text" && b.text?.includes("make it red"));
    expect(told?.text?.startsWith("The user writes to you from your thread")).toBe(true);
    const main = fake!.requests.filter((r) => !r.sub).at(-1)!;
    expect(resultText(resultIn(main, "door"))).toMatch(/^Door built, red as you asked\.\n\n\[Studio\] While it worked, the user wrote to this subagent from its thread[\s\S]*make it red$/);
  }, T);

  it("keeps a subagent going when the message comes as it writes its report", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const runner = await runnerWith(async (req) => {
      if (!req.sub) return req.toolResults === 0 ? use("rep", "agent", { description: "Write the report", prompt: "report" }) : text("Done.");
      if (!said(req).includes("in French")) {
        await gate;
        return text("Report in English.");
      }
      return text("Rapport en francais.");
    });
    const s = store.create();
    await runner.send(s.id, "report");
    await until(() => runner.canMessage(store.get(s.id)!, "rep") && fake!.requests.some((r) => r.sub), 30_000, "the subagent writing");
    expect(await runner.messageSubagent(s.id, "rep", "write it in French")).toBe(true);
    release();
    await idle(s.id);
    const fin = store.get(s.id)!;
    const main = fake!.requests.filter((r) => !r.sub).at(-1)!;
    expect(resultText(resultIn(main, "rep"))).toMatch(/^Rapport en francais\./);
    // A finished subagent takes no more messages.
    expect(runner.canMessage(fin, "rep")).toBe(false);
    expect(await runner.messageSubagent(s.id, "rep", "again")).toBe(false);
  }, T);
});

/** A script turn that holds until the request is dropped (its conversation was stopped). */
const never = (req: FakeScriptRequest): Promise<FakeTurn> => new Promise((_r, reject) => req.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));

describe("stopping one subagent", () => {
  it("stops that subagent, lets the other finish, and tells the main agent the user stopped it", async () => {
    const runner = await runnerWith((req) => {
      if (!req.sub) {
        return req.toolResults === 0
          ? { tools: [{ id: "slow", name: "agent", input: { description: "Slow", prompt: "slow" } }, { id: "fast", name: "agent", input: { description: "Fast", prompt: "fast" } }] }
          : text("Carried on.");
      }
      // The slow one waits until it is stopped.
      return taskOf(req) === "fast" ? text("Fast done.") : never(req);
    });
    const s = store.create();
    await runner.send(s.id, "two");
    await until(() => store.get(s.id)!.transcript.some((t) => t.kind === "tool" && t.call.id === "fast" && t.call.outcome === "done"), 30_000, "the fast subagent");
    expect(SessionStore.summary(store.get(s.id)!).agents).toEqual({ total: 2, running: 1 });
    expect(runner.stopSubagent(s.id, "slow")).toBe(true);
    await idle(s.id);

    const fin = store.get(s.id)!;
    const slow = fin.transcript.find((t) => t.kind === "tool" && t.call.id === "slow");
    expect(slow?.kind === "tool" && slow.call.outcome).toBe("stopped");
    const main = fake!.requests.filter((r) => !r.sub).at(-1)!;
    expect(resultText(resultIn(main, "slow"))).toMatch(/user stopped this subagent/);
    expect(resultText(resultIn(main, "fast"))).toBe("Fast done.");
    expect(runner.stopSubagent(s.id, "slow")).toBe(false);
    expect(SessionStore.summary(fin).agents).toEqual({ total: 2, running: 0 });
  }, T);

  it("marks every running call stopped when the whole turn is stopped", async () => {
    const runner = await runnerWith((req) => (req.sub ? never(req) : use("a", "agent", { description: "A", prompt: "a" })));
    const s = store.create();
    await runner.send(s.id, "go");
    await until(() => fake!.requests.some((r) => r.sub), 30_000, "the subagent to start");
    // A first Stop ends only the main agent's reply, its subagent going on in the background; a second ends it too.
    runner.stop(s.id);
    expect(store.get(s.id)!.status).toBe("running");
    expect(store.get(s.id)!.mainFree).toBe(true);
    runner.stop(s.id);
    const fin = store.get(s.id)!;
    expect(fin.status).toBe("stopped");
    expect(fin.transcript.filter((t) => t.kind === "tool").map((t) => t.kind === "tool" && t.call.outcome)).toEqual(["stopped"]);
    await until(() => !runner.keepsSubagents(s.id), 30_000, "the subagent to end");
  }, T);
});

describe("the editor going away", () => {
  it("pauses at the tool call and resumes when the editor is back", async () => {
    host.connected = false;
    const runner = await runnerWith(seq([call("t1", "level", "get_outliner"), text("Back.")]));
    const s = store.create();
    host.emit("editor.disconnected", { cause: "closed" });
    await runner.send(s.id, "go");
    await until(() => statusOf(s.id) === "waiting", 30_000, "the session to wait");

    expect(store.get(s.id)!.waitingCause).toBe("the editor was closed");
    expect(host.calls).toHaveLength(0);
    expect(host.busy()).toBe(true);

    host.connected = true;
    host.emit("editor.connected");
    await idle(s.id);
    expect(host.calls).toHaveLength(1);
    expect(host.busy()).toBe(false);
  }, T);

  it("never reruns a call whose outcome is unknown, and tells the model to verify", async () => {
    host.handler = async () => {
      host.connected = false;
      host.emit("editor.disconnected", { cause: "crashed" });
      throw new Error("Bridge connection lost (close code 1006)");
    };
    const runner = await runnerWith(seq([call("t1", "blueprint", "create", { assetPath: "/Game/BP_Door" }), text("I will check first.")]));
    const s = store.create();
    await runner.send(s.id, "make a door");
    await until(() => fake!.requests.length === 2, 30_000, "the model to hear the outcome");
    host.handler = async () => ok("{}");
    host.connected = true;
    host.emit("editor.connected");
    await idle(s.id);
    expect(host.calls.filter((c) => c.action === "create")).toHaveLength(1);
    const entry = store.get(s.id)!.transcript.find((t) => t.kind === "tool");
    expect(entry && entry.kind === "tool" && entry.call.outcome).toBe("unknown");
    const told = resultText(resultIn(fake!.requests[1], "t1"));
    expect(told).toMatch(/Outcome unknown: the editor went away \(the editor crashed\)/);
    expect(told).toMatch(/On disk now: \/Game\/BP_Door does not exist/);
  }, T);

  it("after a crash, lists what the session changed and never saved before the model continues", async () => {
    host.handler = async (_c, action) => ok(action === "create" ? "{\"created\":true}" : "{\"created\":true,\"saved\":true}");
    fs.mkdirSync(path.join(host.projectDir, "Content", "Kept"), { recursive: true });
    fs.writeFileSync(path.join(host.projectDir, "Content", "Kept", "BP_Saved.uasset"), "x");
    const runner = await runnerWith(seq([
      { tools: [
        { id: "a", name: "ue_mcp", input: { action: "call", category: "blueprint", method: "create", args: { assetPath: "/Game/BP_Unsaved" } } },
        { id: "b", name: "ue_mcp", input: { action: "call", category: "blueprint", method: "create_and_save", args: { assetPath: "/Game/Kept/BP_Saved" } } },
      ] },
      text("Made two."),
      text("Redoing it."),
    ]));
    const s = store.create();
    await runner.send(s.id, "make two");
    await idle(s.id);
    host.emit("editor.disconnected", { cause: "crashed" });
    await runner.send(s.id, "continue");
    await until(() => statusOf(s.id) === "idle" && fake!.requests.length === 3, 30_000, "the second turn");
    const first = blocks(lastUser(fake!.requests[2])).find((b) => b.type === "text")!;
    expect(first.text).toMatch(/The editor crashed\. These changes are gone/);
    expect(first.text).toMatch(/asset \/Game\/BP_Unsaved \(not saved\)/);
    expect(first.text).not.toMatch(/BP_Saved/);
    const fin = store.get(s.id)!;
    expect(fin.transcript.some((t) => t.kind === "note")).toBe(true);
    expect(fin.touched).toEqual([{ kind: "asset", path: "/Game/Kept/BP_Saved", saved: true }]);
  }, T);

  it("an editor killed mid-turn leaves a disconnect note and lists what it lost, and leaves other sessions' dates alone (#144)", async () => {
    const other = store.create();
    other.touched.push({ kind: "asset", path: "/Game/Old/BP_Old", saved: false });
    other.transcript.push({ kind: "user", text: "old work", at: "2026-10-25T05:00:00.000Z" });
    store.save(other);
    other.updatedAt = "2026-10-25T05:00:00.000Z";
    store.save(other, { touch: false });

    let crashed = false;
    host.handler = async (_c, action) => {
      if (action === "list_dirty_packages") return ok(JSON.stringify({ success: true, content: [], maps: [{ package: "/Game/Playtest/L_Playtest" }] }));
      if (action === "place_actor") return ok(JSON.stringify({ success: true, created: true, actorLabel: "K1" }));
      if (!crashed) {
        // The editor is killed once the change is in and the editor has listed what is unsaved.
        await until(() => host.calls.some((c) => c.action === "list_dirty_packages"), 3000).catch(() => undefined);
        await new Promise((r) => setTimeout(r, 5));
        crashed = true;
        host.connected = false;
        host.emit("editor.disconnected", { cause: "crashed" });
        throw new Error("Bridge connection lost (close code 1006)");
      }
      return ok();
    };
    // The model's answer after the crash waits for the editor to be back, so the turn is still running when it is.
    const runner = await runnerWith(seq([
      call("p", "level", "place_actor", { actorClass: "StaticMeshActor", label: "K1" }),
      call("d", "level", "get_actor_details", { actorLabel: "K1" }),
      async () => {
        await until(() => host.connected, 30_000);
        return text("Carrying on.");
      },
    ]));
    const s = store.create();
    await runner.send(s.id, "place K1");
    await until(() => fake!.requests.length === 3, 30_000, "the model to hear of the crash");

    host.connected = true;
    host.emit("editor.connected");
    await idle(s.id);
    const notes = store.get(s.id)!.transcript.flatMap((t) => (t.kind === "note" ? [t.text] : []));
    expect(notes).toContain("The editor disconnected during this turn: the editor crashed.");
    const lost = notes.find((n) => n.startsWith("The editor crashed."));
    expect(lost).toMatch(/package \/Game\/Playtest\/L_Playtest \(unsaved in the editor\)/);
    expect(lost).toMatch(/actor K1 \(not saved\)/);
    expect(store.get(other.id)!.updatedAt).toBe("2026-10-25T05:00:00.000Z");
    expect(store.get(other.id)!.crashed).toBe(true);
  }, T);

  it("a restart tool call waits for the editor and then continues", async () => {
    host.editorOperation = async (op: string) => {
      host.connected = false;
      return { op, steps: [{ step: "editor.restart_editor", ok: true }] };
    };
    const runner = await runnerWith(seq([use("r", "editor_restart", { operation: "restart", reason: "plugin enabled" }), text("Restarted.")]));
    const s = store.create();
    await runner.send(s.id, "restart");
    await until(() => statusOf(s.id) === "waiting", 30_000, "the session to wait");
    host.connected = true;
    host.emit("editor.connected");
    await idle(s.id);
    expect(store.get(s.id)!.transcript.at(-1)).toMatchObject({ kind: "assistant", text: "Restarted." });
  }, T);
});

describe("the editor gone with nothing bringing it back (#1384)", () => {
  const busyOn = () => new BusyTracker((type, data) => host.emit(`studio.${type}`, data), Date.now, () => host.connected);
  const restart = (op: string): FakeTurn => use("r", "editor_restart", { operation: op, reason: "C++ changed" });

  it("a rebuild whose build failed is an error, not a wait", async () => {
    const busy = busyOn();
    host.editorOperation = async (op: string) => {
      host.connected = false;
      return { op, steps: [
        { step: "editor.stop_editor", ok: true, result: JSON.stringify({ success: true }) },
        { step: "project.build", ok: false, result: JSON.stringify({ success: false, exitCode: 6, message: "Build failed with exit code 6" }) },
      ] };
    };
    const runner = await runnerWith(seq([restart("rebuild"), text("The build failed.")]), { busy });
    const s = store.create();
    await runner.send(s.id, "rebuild");
    await idle(s.id);
    const result = resultIn(fake!.requests[1], "r")!;
    expect(result).toMatchObject({ is_error: true });
    expect(resultText(result)).toMatch(/^rebuild failed at project.build/);
    expect(busy.state().failure).toMatchObject({ op: "rebuild", step: "project.build", reason: "Build failed with exit code 6" });
  }, T);

  it("an editor call goes ahead with no restart running once the idle wait runs out, and the cause says what is true", async () => {
    const busy = busyOn();
    host.connected = false;
    host.handler = async () => ({ isError: true, content: [{ type: "text", text: "Error [NOT_CONNECTED]: the editor is not running" }] });
    const runner = await runnerWith(seq([call("t1", "feedback", "submit", { title: "x" }), text("Noted.")]), { busy });
    host.emit("editor.disconnected", { cause: "rebuild" });
    const s = store.create();
    await runner.send(s.id, "file it");
    await until(() => statusOf(s.id) === "waiting", 30_000, "the session to wait");
    expect(store.get(s.id)!.waitingCause).toBe("the editor is not running");
    await until(() => statusOf(s.id) === "idle", 90_000, "the call to go ahead");
    expect(host.calls.map((c) => `${c.category}.${c.action}`)).toEqual(["feedback.submit"]);
  }, 120_000);

  it("a paused turn resumes when the wait for the editor to attach runs out", async () => {
    const busy = new BusyTracker((type, data) => host.emit(`studio.${type}`, data), Date.now, () => host.connected, 50);
    host.editorOperation = async (op: string) => {
      host.connected = false;
      host.emit("editor.operation", { op, step: "editor.restart_editor", phase: "started" });
      host.emit("editor.operation", { op, step: "editor.restart_editor", phase: "done" });
      return { op, steps: [{ step: "editor.restart_editor", ok: true, result: JSON.stringify({ success: true }) }] };
    };
    const unobserve = host.events.subscribe((e) => busy.observe(e));
    const runner = await runnerWith(seq([restart("restart"), text("It did not come back.")]), { busy });
    const s = store.create();
    await runner.send(s.id, "restart");
    await until(() => statusOf(s.id) === "waiting", 30_000, "the session to wait");
    expect(store.get(s.id)!.waitingCause).toBe("the editor is restarting");
    await until(() => statusOf(s.id) === "idle", 90_000, "the turn to go on");
    expect(store.get(s.id)!.transcript.at(-1)).toMatchObject({ kind: "assistant", text: "It did not come back." });
    unobserve();
  }, 120_000);
});

describe("persistence", () => {
  it("survives a daemon restart mid-turn: a call that was running becomes unknown, then the turn finishes", async () => {
    host.handler = (_c, action) => (action === "list_dirty_packages" ? Promise.resolve(ok()) : new Promise<ActionResult>(() => {}));
    const runner1 = await runnerWith((req) => (req.toolResults === 0 ? call("t1", "level", "spawn_actor", { actorLabel: "Lamp" }) : text("Checked.")));
    const s = store.create();
    await runner1.send(s.id, "add a lamp");
    await until(() => host.calls.some((c) => c.action === "spawn_actor"), 30_000, "the call to run");
    runner1.dispose();
    store.flush();

    // A new daemon: fresh store and runner over the same files.
    const store2 = new SessionStore(host.dataDir);
    host.handler = async () => ok("{}");
    const runner2 = await runnerWith(script, {}, store2);
    runner2.recover();
    await idle(s.id, store2);
    expect(resultText(resultIn(fake!.requests.at(-1), "t1"))).toMatch(/restarted while this call was running, so whether it took effect is unknown/);
    expect(store2.get(s.id)!.transcript.find((t) => t.kind === "tool")).toMatchObject({ call: { outcome: "unknown" } });
    expect(host.calls.filter((c) => c.action === "spawn_actor")).toHaveLength(1);
    expect(store2.get(s.id)!.transcript[0]).toMatchObject({ kind: "user", text: "add a lamp" });
  }, T);

  it("a Stop during editor_restart says the rebuild goes on, and the next message carries that to the model", async () => {
    let finish: (() => void) | null = null;
    host.editorOperation = (op: string) => new Promise((resolve) => {
      host.connected = false;
      finish = () => resolve({ op, steps: [{ step: "project.build", ok: true }] });
    });
    const runner = await runnerWith(seq([use("r", "editor_restart", { operation: "rebuild", reason: "C++" }), text("The rebuild was still going.")]));
    const s = store.create();
    await runner.send(s.id, "rebuild");
    await until(() => finish !== null, 30_000, "the rebuild to start");
    runner.stop(s.id);
    finish!();
    const stopped = store.get(s.id)!;
    expect(stopped.status).toBe("stopped");
    const tool = stopped.transcript.find((t) => t.kind === "tool");
    expect(tool).toMatchObject({ call: { outcome: "stopped" } });
    expect(tool?.kind === "tool" && tool.call.result).toMatch(/^Stopped by the user while this was running.*the rebuild goes on in the daemon/);
    host.connected = true;
    await runner.send(s.id, "what happened?");
    await until(() => statusOf(s.id) === "idle" && fake!.requests.length === 2, 30_000, "the next turn");
    const sent = blocks(lastUser(fake!.requests[1])).find((b) => b.type === "text")!;
    expect(sent.text).toMatch(/^\[Studio\] The user pressed Stop.*editor_restart \(rebuild\) was running/);
  }, T);

  it("stopping answers the unanswered calls so the conversation stays valid", async () => {
    host.connected = false;
    const runner = await runnerWith(seq([call("t1", "level", "get_outliner"), text("Next.")]));
    const s = store.create();
    await runner.send(s.id, "go");
    await until(() => statusOf(s.id) === "waiting", 30_000, "the call to wait for the editor");
    runner.stop(s.id);
    const fin = store.get(s.id)!;
    expect(fin.status).toBe("stopped");
    expect(fin.transcript.find((t) => t.kind === "tool")).toMatchObject({ call: { outcome: "stopped" } });
    // The next message goes on from a valid conversation.
    host.connected = true;
    await runner.send(s.id, "carry on");
    await until(() => statusOf(s.id) === "idle" && store.get(s.id)!.transcript.at(-1)?.kind === "assistant", 30_000, "the next turn");
    expect(host.calls).toHaveLength(0);
  }, T);
});

describe("stopping while the editor is busy", () => {
  it("ends the turn at once, keeps it stopped when the call returns, and the busy state follows the call", async () => {
    let finish: () => void = () => {};
    host.handler = () => new Promise((resolve) => (finish = () => resolve(ok())));
    const busy = new BusyTracker();
    // Python asks as a shell command; allowed here, so the call runs and holds the editor.
    const runner = await runnerWith(seq([call("t1", "editor", "execute_python", { code: "import time; time.sleep(20)" }), text("never")]), {
      busy,
      approvals: () => ({ shell: "allow", files: "ask", editorRestart: "ask", destructive: "ask" }),
    });
    const s = store.create();
    await runner.send(s.id, "block the editor");
    await until(() => busy.state().calls.length === 1, 30_000, "the call to hold the editor");
    expect(busy.state().calls[0]).toMatchObject({ category: "editor", action: "execute_python", sessionId: s.id });

    expect(busy.stop((id) => runner.stop(id))).toEqual([s.id]);
    expect(store.get(s.id)!.status).toBe("stopped");

    finish();
    await until(() => busy.state().calls.length === 0, 30_000, "the call to end");
    await new Promise((r) => setTimeout(r, 300));
    expect(store.get(s.id)!.status).toBe("stopped");
    expect(fake!.requests).toHaveLength(1);
  }, T);
});

describe("inputs and settings", () => {
  it("refuses malformed tool input before running it", () => {
    expect(validateInput("ue_mcp", { action: "call", category: "level" })).toMatch(/needs category and method/);
    expect(validateInput("ue_mcp", { action: "search" })).toMatch(/needs query/);
    expect(validateInput("editor_restart", { operation: "reboot" })).toMatch(/restart or rebuild/);
    expect(validateInput("ue_mcp", { action: "call", category: "a", method: "b", args: {} })).toBeNull();
  });

  it("stores each provider's key apart from the settings and never reports it back", () => {
    const settings = new SettingsStore(path.join(root, "settings"), path.join(root, "keys"));
    settings.update({ keys: { openai: "sk-test-123" }, provider: "openai", model: "gpt-6-sol" });
    const view = settings.view();
    expect(view).toMatchObject({ provider: "openai", model: "gpt-6-sol", keys: { openai: true, anthropic: false, google: false } });
    expect(JSON.stringify(view)).not.toContain("sk-test-123");
    expect(fs.readFileSync(path.join(root, "settings", "settings.json"), "utf-8")).not.toContain("sk-test-123");
    expect(settings.key("openai")).toBe("sk-test-123");
    settings.update({ keys: { openai: "" } });
    expect(settings.view().keys.openai).toBe(false);
    expect(() => settings.update({ gatewayUrl: "ftp://x" })).toThrow(/http/);
    expect(() => settings.update({ keys: { studio: "x" } as never })).toThrow(/no key provider/);
  });
});

/** The tool result the model got for a call, in any request. */
const resultOf = (id: string): Block | null => {
  for (const r of fake?.requests ?? []) {
    const b = resultIn(r, id);
    if (b) return b;
  }
  return null;
};
const toolEntry = (sid: string, id: string) => {
  const e = store.get(sid)!.transcript.find((t) => t.kind === "tool" && t.call.id === id);
  return e?.kind === "tool" ? e.call : undefined;
};

describe("asking before a command or a file change", () => {
  const write = (id: string, file: string) => use(id, "write_file", { path: file, content: "hello" });
  const waiting = (sid: string) => () => (store.get(sid)!.approvals ?? []).length > 0;

  it("holds the call until the user allows it, then runs it", async () => {
    const runner = await runnerWith(seq([write("w1", "out.txt"), text("Written.")]));
    const s = store.create();
    await runner.send(s.id, "write it");
    await until(waiting(s.id), 30_000, "the approval");

    const a = SessionStore.detail(store.get(s.id)!).approvals[0];
    expect(a).toMatchObject({ tool: "write_file", toolUseId: "w1", parent: null, creates: true, path: path.join(host.projectDir, "out.txt"), diff: [{ op: "+", text: "hello" }] });
    expect(SessionStore.summary(store.get(s.id)!).awaiting).toBe(1);
    expect(host.published.some((e) => e.type === "approval.requested" && e.data?.approvalId === a.id)).toBe(true);
    expect(fs.existsSync(path.join(host.projectDir, "out.txt"))).toBe(false);

    expect(runner.answerApproval(s.id, a.id, "allow")).toBe(true);
    await idle(s.id);
    expect(fs.readFileSync(path.join(host.projectDir, "out.txt"), "utf-8")).toBe("hello");
    expect(resultOf("w1")?.is_error).toBeFalsy();
    expect(store.get(s.id)!.approvals).toEqual([]);
    expect(runner.answerApproval(s.id, a.id, "allow")).toBe(false);
  }, T);

  it("tells the model the user declined, and never runs the call", async () => {
    const runner = await runnerWith(seq([write("w1", "no.txt"), text("Understood.")]));
    const s = store.create();
    await runner.send(s.id, "write it");
    await until(waiting(s.id), 30_000, "the approval");
    runner.answerApproval(s.id, store.get(s.id)!.approvals![0].id, "deny");
    await idle(s.id);

    expect(fs.existsSync(path.join(host.projectDir, "no.txt"))).toBe(false);
    const r = resultOf("w1")!;
    expect(r.is_error).toBe(true);
    expect(resultText(r)).toMatch(/user declined this file change/);
    expect(toolEntry(s.id, "w1")?.outcome).toBe("declined");
  }, T);

  it("asks a command once when the user allows commands for the session", async () => {
    const runner = await runnerWith(seq([use("c1", "shell", { command: "echo one" }), use("c2", "shell", { command: "echo two" }), text("Ran both.")]));
    const s = store.create();
    await runner.send(s.id, "run");
    await until(waiting(s.id), 30_000, "the approval");
    const a = store.get(s.id)!.approvals![0];
    expect(a).toMatchObject({ tool: "shell", command: "echo one", cwd: host.projectDir });
    runner.answerApproval(s.id, a.id, "session");
    await idle(s.id);
    expect(resultText(resultOf("c1"))).toContain("one");
    expect(resultText(resultOf("c2"))).toMatch(/two\s+Exit code: 0/);
    expect(host.published.filter((e) => e.type === "approval.requested")).toHaveLength(1);
    expect(store.get(s.id)!.allowed).toEqual(["shell"]);
  }, T);

  it("does not ask for reads, or at all when the setting is off", async () => {
    fs.writeFileSync(path.join(host.projectDir, "r.txt"), "x");
    const runner = await runnerWith(seq([use("r1", "read_file", { path: "r.txt" }), write("w1", "free.txt"), text("ok")]), { askBeforeChanges: () => false });
    const s = store.create();
    await runner.send(s.id, "go");
    await idle(s.id);
    expect(resultText(resultOf("r1"))).toBe("1\tx");
    expect(fs.existsSync(path.join(host.projectDir, "free.txt"))).toBe(true);
    expect(host.published.some((e) => e.type === "approval.requested")).toBe(false);
  }, T);

  it("asks for a subagent's call, naming the subagent, and runs it once allowed", async () => {
    const runner = await runnerWith((req) => {
      if (!req.sub) return req.toolResults === 0 ? use("a1", "agent", { description: "Write notes", prompt: "write notes" }) : text("Done.");
      return req.toolResults === 0 ? write("sw1", "Docs/notes.md") : text("Wrote Docs/notes.md.");
    });
    const s = store.create();
    await runner.send(s.id, "notes");
    await until(waiting(s.id), 30_000, "the approval");
    const a = store.get(s.id)!.approvals![0];
    expect(a).toMatchObject({ toolUseId: "sw1", parent: "a1", subagent: "Write notes", tool: "write_file" });
    runner.answerApproval(s.id, a.id, "allow");
    await idle(s.id);
    expect(fs.readFileSync(path.join(host.projectDir, "Docs", "notes.md"), "utf-8")).toBe("hello");
    expect(resultText(resultOf("a1"))).toBe("Wrote Docs/notes.md.");
  }, T);

  it("drops a waiting approval when the turn is stopped", async () => {
    const runner = await runnerWith(seq([use("c1", "shell", { command: "echo never" })]));
    const s = store.create();
    await runner.send(s.id, "run");
    await until(waiting(s.id), 30_000, "the approval");
    runner.stop(s.id);
    await until(() => toolEntry(s.id, "c1")?.outcome !== "pending", 30_000, "the call to be answered");
    const fin = store.get(s.id)!;
    expect(fin.status).toBe("stopped");
    expect(fin.approvals).toEqual([]);
    expect(toolEntry(s.id, "c1")?.result).toMatch(/Stopped by the user/);
  }, T);

  it("forgets approvals a previous daemon was holding", () => {
    const s = store.create();
    s.approvals = [{ id: "old", toolUseId: "t", tool: "shell", parent: null, command: "ls", at: new Date().toISOString() }];
    store.save(s);
    const runner = new AgentRunner({ host, store, model: () => "claude-opus-5-5" });
    runners.push(runner);
    runner.recover();
    expect(store.get(s.id)!.approvals).toEqual([]);
  });
});

/** A model whose turns each wait until the test lets them finish, or until the request is dropped. */
function gated() {
  const gates: Array<() => void> = [];
  let n = 0;
  const s: Script = (req) => new Promise<FakeTurn>((resolve, reject) => {
    const go = () => resolve(text(`answer ${++n}`));
    gates.push(go);
    req.signal.addEventListener("abort", () => {
      const i = gates.indexOf(go);
      if (i >= 0) gates.splice(i, 1);
      reject(new Error("aborted"));
    }, { once: true });
  });
  return {
    script: s,
    release: () => gates.shift()?.(),
    get waiting() {
      return gates.length;
    },
  };
}

const lastUserText = (req: FakeRequest) => userTexts(req).at(-1) ?? "";

describe("queued messages", () => {
  it("wait for the running turn, then go one by one, in order", async () => {
    const model = gated();
    const runner = await runnerWith(model.script);
    const s = store.create();
    await runner.send(s.id, "one");
    await until(() => model.waiting === 1, 30_000, "the first turn");
    runner.enqueue(s.id, "two", []);
    runner.enqueue(s.id, "three", []);
    expect(store.get(s.id)!.queue!.map((q) => q.text)).toEqual(["two", "three"]);
    model.release();
    await until(() => model.waiting === 1 && store.get(s.id)!.queue!.length === 1, 30_000, "the second turn");
    model.release();
    await until(() => model.waiting === 1 && store.get(s.id)!.queue!.length === 0, 30_000, "the third turn");
    model.release();
    await until(() => statusOf(s.id) === "idle" && fake!.requests.length === 3, 30_000, "the queue to drain");
    expect(store.get(s.id)!.transcript.filter((t) => t.kind === "user").map((t) => t.kind === "user" && t.text)).toEqual(["one", "two", "three"]);
  }, T);

  it("can be changed or removed before they go, and wait after a Stop until asked", async () => {
    const model = gated();
    const runner = await runnerWith(model.script);
    const s = store.create();
    await runner.send(s.id, "one");
    await until(() => model.waiting === 1, 30_000, "the first turn");
    const a = runner.enqueue(s.id, "two", []);
    const b = runner.enqueue(s.id, "three", []);
    expect(runner.editQueued(s.id, a.id, "two, changed")).toBe(true);
    expect(runner.editQueued(s.id, b.id, null)).toBe(true);
    expect(runner.editQueued(s.id, b.id, "gone")).toBe(false);
    runner.stop(s.id);
    await new Promise((r) => setTimeout(r, 300));
    expect(store.get(s.id)!.queue!.map((q) => q.text)).toEqual(["two, changed"]);
    expect(fake!.requests).toHaveLength(1);
    void runner.sendQueued(s.id);
    await until(() => model.waiting === 1 && fake!.requests.length === 2, 30_000, "the queued message");
    expect(lastUserText(fake!.requests[1])).toContain("two, changed");
    model.release();
    await idle(s.id);
  }, T);

  it("send now stops the running turn and sends ahead of the queue", async () => {
    const model = gated();
    const runner = await runnerWith(model.script);
    const s = store.create();
    await runner.send(s.id, "one");
    await until(() => model.waiting === 1, 30_000, "the first turn");
    runner.enqueue(s.id, "later", []);
    void runner.sendNow(s.id, "urgent");
    await until(() => fake!.requests.length === 2 && model.waiting === 1, 30_000, "the urgent message");
    expect(lastUserText(fake!.requests[1])).toContain("urgent");
    expect(store.get(s.id)!.queue!.map((q) => q.text)).toEqual(["later"]);
    model.release();
    await until(() => fake!.requests.length === 3 && model.waiting === 1, 30_000, "the queued message");
    expect(lastUserText(fake!.requests[2])).toContain("later");
    model.release();
    await idle(s.id);
  }, T);
});

type QueueHandler = (req: { params: Record<string, string>; body?: unknown }) => Promise<{ status?: number; body?: unknown }>;

/** The queue's routes against a real runner and a fake daemon API. */
function queueRoutes(runner: AgentRunner) {
  const routes = new Map<string, QueueHandler>();
  const stops: string[] = [];
  const api = { route: (m: string, p: string, h: QueueHandler) => void routes.set(`${m} ${p}`, h), log: host.log };
  registerQueueRoutes(api as never, {
    store,
    runner,
    messageBody: (_id, body) => ({ text: (body as { text: string }).text, files: [] }),
    stopSide: (id) => void stops.push(id),
  });
  const now = (id: string, qid: string) => routes.get("POST /sessions/:id/queue/:qid/now")!({ params: { id, qid } });
  return { now, stops };
}

describe("send now on a queued message", () => {
  it("stops the running turn, sends that message with its files, and the rest go after it in order", async () => {
    const model = gated();
    const runner = await runnerWith(model.script);
    const { now, stops } = queueRoutes(runner);
    const s = store.create();
    await runner.send(s.id, "one");
    await until(() => model.waiting === 1, 30_000, "the first turn");
    const file = new AttachmentStore(host.dataDir).keep(s.id, "ref.png", "image/png", pngBytes(4, 4));
    runner.enqueue(s.id, "two", []);
    const three = runner.enqueue(s.id, "three", [{ id: file.id, name: file.name, type: file.type, size: file.size }]);
    runner.enqueue(s.id, "four", []);
    expect(await now(s.id, three.id)).toEqual({ status: 202, body: { sessionId: s.id } });
    expect(stops).toEqual([s.id]);
    expect(store.get(s.id)!.queue!.map((q) => q.text)).toEqual(["two", "four"]);
    await until(() => fake!.requests.length === 2 && model.waiting === 1, 30_000, "the message sent now");
    const sent = blocks(lastUser(fake!.requests[1]));
    expect(sent.map((b) => b.type)).toContain("image");
    expect(sent.at(-1)!.text).toBe("three");
    const entry = store.get(s.id)!.transcript.filter((t) => t.kind === "user").at(-1)!;
    expect(entry.kind === "user" && entry.attachments?.map((a) => a.name)).toEqual(["ref.png"]);
    // The same message again: it went once.
    expect((await now(s.id, three.id)).status).toBe(404);
    model.release();
    await until(() => fake!.requests.length === 3 && model.waiting === 1, 30_000, "two");
    expect(lastUserText(fake!.requests[2])).toContain("two");
    model.release();
    await until(() => fake!.requests.length === 4 && model.waiting === 1, 30_000, "four");
    expect(lastUserText(fake!.requests[3])).toContain("four");
    model.release();
    await until(() => statusOf(s.id) === "idle" && store.get(s.id)!.queue!.length === 0, 30_000, "the queue to drain");
    expect(store.get(s.id)!.transcript.filter((t) => t.kind === "user").map((t) => t.kind === "user" && t.text)).toEqual(["one", "three", "two", "four"]);
  }, T);

  it("when idle, sends that message and stops nothing; the queue it skipped goes after it", async () => {
    const model = gated();
    const runner = await runnerWith(model.script);
    const { now, stops } = queueRoutes(runner);
    const s = store.create();
    await runner.send(s.id, "one");
    await until(() => model.waiting === 1, 30_000, "the first turn");
    runner.enqueue(s.id, "two", []);
    const three = runner.enqueue(s.id, "three", []);
    runner.stop(s.id);
    await until(() => statusOf(s.id) === "stopped", 30_000, "the stop");
    expect(await now(s.id, three.id)).toEqual({ status: 202, body: { sessionId: s.id } });
    expect(stops).toEqual([]);
    await until(() => fake!.requests.length === 2 && model.waiting === 1, 30_000, "three");
    expect(lastUserText(fake!.requests[1])).toContain("three");
    expect(store.get(s.id)!.queue!.map((q) => q.text)).toEqual(["two"]);
    model.release();
    await until(() => fake!.requests.length === 3 && model.waiting === 1, 30_000, "two");
    expect(lastUserText(fake!.requests[2])).toContain("two");
    model.release();
    await until(() => statusOf(s.id) === "idle" && store.get(s.id)!.queue!.length === 0, 30_000, "the queue to drain");
  }, T);

  it("answers 404 for a message that is not queued, or a session that does not exist, and changes nothing", async () => {
    const model = gated();
    const runner = await runnerWith(model.script);
    const { now, stops } = queueRoutes(runner);
    const s = store.create();
    await runner.send(s.id, "one");
    await until(() => model.waiting === 1, 30_000, "the first turn");
    runner.enqueue(s.id, "two", []);
    expect(await now(s.id, "not-a-message")).toEqual({ status: 404, body: { error: "that message is not queued any more" } });
    expect((await now("no-such-session", "q")).status).toBe(404);
    expect(stops).toEqual([]);
    expect(store.get(s.id)!.status).toBe("running");
    expect(store.get(s.id)!.queue!.map((q) => q.text)).toEqual(["two"]);
    expect(runner.sendQueuedNow(s.id, "not-a-message")).toBe(false);
    model.release();
    await until(() => fake!.requests.length === 2 && model.waiting === 1, 30_000, "two");
    model.release();
    await idle(s.id);
  }, T);
});

// The turn that took Studio down searched a large folder with grep and no ripgrep: every queue
// request waited until the search ended, 15 minutes later (#165). Each step here runs from its own
// timer, as a request would, and must land while that search is still running.
describe("the queue while a turn searches a large folder", () => {
  beforeEach(() => {
    setRipgrep(null);
    for (let d = 0; d < 20; d++) {
      fs.mkdirSync(path.join(host.projectDir, "Source", `Folder${d}`), { recursive: true });
      for (let f = 0; f < 10; f++) fs.writeFileSync(path.join(host.projectDir, "Source", `Folder${d}`, `File${f}.h`), `// line\n`.repeat(50));
    }
  });
  afterEach(() => setRipgrep(undefined));

  const searching = (): FakeTurn => use("g1", "grep", { pattern: "needle", path: "." });
  const grepRunning = (sid: string) => toolEntry(sid, "g1")?.outcome === "pending";

  /** Run each step from a timer once the grep has started, and say whether each landed while it still ran. */
  async function duringSearch(runner: AgentRunner, sid: string, steps: Array<() => void>): Promise<boolean[]> {
    const landed: boolean[] = [];
    const publish = host.events.publish;
    let started = false;
    host.events.publish = (type, data) => {
      publish(type, data);
      const entry = data?.entry as { kind?: string; call?: { id?: string } } | undefined;
      if (started || type !== "transcript.added" || entry?.kind !== "tool" || entry.call?.id !== "g1") return;
      started = true;
      const next = (i: number) => setTimeout(() => {
        steps[i]();
        landed.push(grepRunning(sid));
        if (i + 1 < steps.length) next(i + 1);
      }, 0);
      next(0);
    };
    await runner.send(sid, "find it");
    await until(() => landed.length === steps.length && !grepRunning(sid), 30_000, "the search and its steps");
    host.events.publish = publish;
    return landed;
  }

  it("takes a message queued while it searches, and sends it after", async () => {
    const runner = await runnerWith(seq([searching(), text("Not found."), text("answer two")]));
    const s = store.create();
    expect(await duringSearch(runner, s.id, [() => runner.enqueue(s.id, "two", [])])).toEqual([true]);
    await until(() => fake!.requests.length === 3 && statusOf(s.id) === "idle", 30_000, "the queued message");
    expect(lastUserText(fake!.requests[2])).toContain("two");
  }, T);

  it("takes another message behind one already queued", async () => {
    const runner = await runnerWith(seq([searching(), text("Not found."), text("answer two"), text("answer three")]));
    const s = store.create();
    const landed = await duringSearch(runner, s.id, [() => runner.enqueue(s.id, "two", []), () => runner.enqueue(s.id, "three", [])]);
    expect(landed).toEqual([true, true]);
    await until(() => fake!.requests.length === 4 && statusOf(s.id) === "idle", 30_000, "the queued messages");
    expect(store.get(s.id)!.transcript.filter((t) => t.kind === "user").map((t) => t.kind === "user" && t.text)).toEqual(["find it", "two", "three"]);
  }, T);

  it("changes a queued message while it searches", async () => {
    const runner = await runnerWith(seq([searching(), text("Not found."), text("answer")]));
    const s = store.create();
    let id = "";
    const landed = await duringSearch(runner, s.id, [() => (id = runner.enqueue(s.id, "two", []).id), () => expect(runner.editQueued(s.id, id, "two, changed")).toBe(true)]);
    expect(landed).toEqual([true, true]);
    await until(() => fake!.requests.length === 3 && statusOf(s.id) === "idle", 30_000, "the queued message");
    expect(lastUserText(fake!.requests[2])).toContain("two, changed");
  }, T);

  it("removes a queued message while it searches", async () => {
    const runner = await runnerWith(seq([searching(), text("Not found."), text("answer three")]));
    const s = store.create();
    let id = "";
    const landed = await duringSearch(runner, s.id, [
      () => (id = runner.enqueue(s.id, "two", []).id),
      () => runner.enqueue(s.id, "three", []),
      () => expect(runner.editQueued(s.id, id, null)).toBe(true),
    ]);
    expect(landed).toEqual([true, true, true]);
    await until(() => fake!.requests.length === 3 && statusOf(s.id) === "idle", 30_000, "the queued message");
    expect(store.get(s.id)!.transcript.filter((t) => t.kind === "user").map((t) => t.kind === "user" && t.text)).toEqual(["find it", "three"]);
  }, T);
});

describe("a queued message that cannot be sent", () => {
  it("is logged, and never rejects where nobody waits for it", async () => {
    const warned: string[] = [];
    host.log = { info() {}, warn: (m: string) => void warned.push(m) } as never;
    const model = gated();
    const runner = await runnerWith(model.script);
    const s = store.create();
    await runner.send(s.id, "one");
    await until(() => model.waiting === 1, 30_000, "the first turn");
    runner.enqueue(s.id, "two", []);
    runner.stop(s.id);
    // The save that takes the message off the queue fails, as a locked file does on Windows.
    const save = store.save.bind(store);
    store.save = () => {
      throw new Error("EPERM: operation not permitted, rename");
    };
    await expect(runner.sendQueued(s.id)).resolves.toBeUndefined();
    store.save = save;
    expect(warned.some((m) => m.includes(`a queued message in session ${s.id} failed`))).toBe(true);
  }, T);
});

describe("editing a sent message", () => {
  it("cuts the model's conversation back to that message and sends the new text", async () => {
    const runner = await runnerWith(seq([text("A."), call("t1", "level", "get_outliner"), text("B."), text("C.")]));
    const s = store.create();
    await runner.send(s.id, "first");
    await idle(s.id);
    await runner.send(s.id, "second");
    await until(() => statusOf(s.id) === "idle" && fake!.requests.length === 3, 30_000, "the second turn");
    expect(store.get(s.id)!.transcript.map((t) => t.kind)).toEqual(["user", "assistant", "user", "tool", "assistant"]);
    const index = store.get(s.id)!.transcript.findIndex((t) => t.kind === "user" && t.text === "second");
    expect(await runner.editMessage(s.id, index, "second, edited")).toBe(true);
    await until(() => statusOf(s.id) === "idle" && fake!.requests.length === 4, 30_000, "the edited turn");
    const sent = fake!.requests[3];
    // first, its answer, and the edited message: nothing of the turn it replaced.
    expect(roles(sent)).toEqual(["user", "assistant", "user"]);
    expect(said(sent)).not.toContain("get_outliner");
    expect(lastUserText(sent)).toContain("second, edited");
    expect(lastUserText(sent)).toContain("Nothing done after it in the earlier version was undone");
    const fin = store.get(s.id)!;
    expect(fin.transcript.map((t) => t.kind === "user" ? `u:${t.text}` : t.kind)).toEqual(["u:first", "assistant", "u:second, edited", "assistant"]);
  }, T);

  it("forks: a copy up to that message continues from the new text, and the original is left as it was", async () => {
    const runner = await runnerWith(seq([text("A."), call("t1", "level", "get_outliner"), text("B."), text("C.")]));
    const s = store.create("Light the level");
    await runner.send(s.id, "first");
    await idle(s.id);
    await runner.send(s.id, "second");
    await until(() => statusOf(s.id) === "idle" && fake!.requests.length === 3, 30_000, "the second turn");
    const before = JSON.stringify(store.get(s.id)!.transcript);
    const index = store.get(s.id)!.transcript.findIndex((t) => t.kind === "user" && t.text === "second");
    const forked = await runner.forkAt(s.id, index, "second, edited");
    expect(forked).toBeTruthy();
    expect(forked).not.toBe(s.id);
    await until(() => store.get(forked!)!.transcript.some((t) => t.kind === "assistant" && t.text === "C."), 30_000, "the fork's turn");
    const sent = fake!.requests[3];
    expect(roles(sent)).toEqual(["user", "assistant", "user"]);
    expect(said(sent)).not.toContain("get_outliner");
    expect(lastUserText(sent)).toContain("second, edited");
    const fork = store.get(forked!)!;
    expect(fork.title).toBe("Light the level (fork)");
    expect(fork.transcript.map((t) => t.kind === "user" ? `u:${t.text}` : t.kind)).toEqual(["u:first", "assistant", "u:second, edited", "assistant"]);
    expect(fork.sdkPast ?? []).toEqual([]);
    // The original is untouched.
    expect(JSON.stringify(store.get(s.id)!.transcript)).toBe(before);
  }, T);

  it("refuses to fork from an index that is not one of the user's messages", async () => {
    const runner = await runnerWith(seq([text("A.")]));
    const s = store.create();
    await runner.send(s.id, "first");
    await idle(s.id);
    expect(await runner.forkAt(s.id, 1, "x")).toBeNull();
  }, T);

  it("refuses an index that is not one of the user's messages", async () => {
    const runner = await runnerWith(seq([text("A.")]));
    const s = store.create();
    await runner.send(s.id, "first");
    await idle(s.id);
    expect(await runner.editMessage(s.id, 1, "x")).toBe(false);
    expect(await runner.editMessage(s.id, 9, "x")).toBe(false);
  }, T);
});

describe("stopping a subagent with a call in flight", () => {
  it("lets that call go at once, marks it stopped, and the main turn and the other subagent go on", async () => {
    let release: (() => void) | null = null;
    host.handler = async (_c, action) => {
      if (action === "slow_build") await new Promise<void>((r) => (release = r));
      return ok();
    };
    const runner = await runnerWith((req) => {
      if (!req.sub) {
        return req.toolResults === 0
          ? { tools: [{ id: "busy", name: "agent", input: { description: "Busy", prompt: "busy" } }, { id: "calm", name: "agent", input: { description: "Calm", prompt: "calm" } }] }
          : text("Carried on without it.");
      }
      if (taskOf(req) === "calm") return text("Calm done.");
      return req.toolResults === 0 ? call("c1", "asset", "slow_build") : text("never");
    });
    const s = store.create();
    await runner.send(s.id, "go");
    await until(() => release !== null, 30_000, "the slow call");
    expect(runner.stopSubagent(s.id, "busy")).toBe(true);
    // Answered now, not when the editor call returns.
    expect(toolEntry(s.id, "c1")?.outcome).toBe("stopped");
    expect(toolEntry(s.id, "c1")?.result).toMatch(/Stopped by the user while this was running/);
    await until(() => statusOf(s.id) === "idle" && store.get(s.id)!.transcript.at(-1)?.kind === "assistant" && !store.get(s.id)!.transcript.at(-1)!.parent, 30_000, "the main turn to end");
    expect(toolEntry(s.id, "busy")?.outcome).toBe("stopped");
    const main = fake!.requests.filter((r) => !r.sub).at(-1)!;
    expect(resultText(resultIn(main, "busy"))).toMatch(/user stopped this subagent/);
    expect(resultText(resultIn(main, "calm"))).toBe("Calm done.");
    expect(store.get(s.id)!.transcript.at(-1)).toMatchObject({ kind: "assistant", text: "Carried on without it." });
    // The call's late result changes nothing that was already answered.
    release!();
    await new Promise((r) => setTimeout(r, 200));
    expect(toolEntry(s.id, "c1")?.outcome).toBe("stopped");
  }, T);
});

describe("Settings > Agent > Usage", () => {
  const withUsage = (u: Partial<UsageSettings>) => ({ ...DEFAULT_USAGE, ...u });

  /** A main agent that starts `n` subagents in one message, then answers; each subagent reports at once. */
  const fanOut = (n: number, tokens?: number): Script => (req) => {
    const usage = tokens !== undefined ? { usage: { input: tokens, output: 0 } } : {};
    if (req.sub) return { ...text(`Report: ${taskOf(req)}`), ...usage };
    if (req.toolResults === 0) return { tools: Array.from({ length: n }, (_, i) => ({ id: `a${i}`, name: "agent", input: { description: `Part ${i}`, prompt: `part ${i}` } })), ...usage };
    return { ...text("Done."), ...usage };
  };

  it("offers no agent tool and says nothing of subagents while they are off", async () => {
    const runner = await runnerWith(seq([text("ok")]), { usage: () => withUsage({ subagents: "off" }) });
    const s = store.create();
    await runner.send(s.id, "hi");
    await idle(s.id);
    expect(fake!.requests[0].tools).not.toContain("agent");
    expect(fake!.requests[0].system).not.toContain("with the agent tool");
  }, T);

  it("tells the agent to start subagents only when asked, by default", async () => {
    const runner = await runnerWith(seq([text("ok")]), { usage: () => DEFAULT_USAGE });
    const s = store.create();
    await runner.send(s.id, "hi");
    await idle(s.id);
    const prompt = fake!.requests[0].system;
    expect(prompt).toContain("only when the user asks for one");
    expect(prompt).not.toContain("several in one message");
    expect(prompt).toContain("4 subagents run at once");
  }, T);

  /**
   * A main agent that starts `n` subagents in one message. Each subagent holds
   * until the test lets it go, so the queue can be watched; `live` counts the
   * ones running now and `most` the highest that count reached.
   */
  function held(n: number) {
    const gates = new Map<string, () => void>();
    const track = { live: 0, most: 0, started: [] as string[], main: null as FakeRequest | null };
    const s: Script = async (req) => {
      if (req.sub) {
        const task = taskOf(req);
        track.started.push(task);
        track.live++;
        track.most = Math.max(track.most, track.live);
        try {
          await new Promise<void>((resolve, reject) => {
            gates.set(task, resolve);
            req.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        } finally {
          track.live--;
        }
        return text(`Report: ${task}`);
      }
      if (req.toolResults === 0) return { tools: Array.from({ length: n }, (_, i) => ({ id: `a${i}`, name: "agent", input: { description: `Part ${i}`, prompt: `part ${i}` } })) };
      track.main = req;
      return text("Done.");
    };
    const finish = (task: string) => {
      const go = gates.get(task);
      gates.delete(task);
      go?.();
    };
    const results = () => Array.from({ length: n }, (_, i) => resultIn(track.main!, `a${i}`)!);
    return { script: s, track, finish, results };
  }
  const queuedIds = (id: string) => store.get(id)!.transcript.flatMap((t) => (t.kind === "tool" && t.call.queued ? [t.call.id] : []));

  it("runs 2 of 5 subagents at once, queues the other 3, and returns all 5 reports (#164)", async () => {
    const h = held(5);
    const runner = await runnerWith(h.script, { usage: () => withUsage({ subagents: "automatic", subagentsPerTurn: 2 }) });
    const s = store.create();
    await runner.send(s.id, "five parts");
    await until(() => h.track.started.length === 2 && queuedIds(s.id).length === 3, 30_000, "two running and three queued");
    expect(h.track.live).toBe(2);
    expect(queuedIds(s.id)).toEqual(["a2", "a3", "a4"]);
    expect(SessionStore.summary(store.get(s.id)!).agents).toEqual({ total: 5, running: 2 });
    // Each one that finishes lets the next waiting one start.
    h.finish(h.track.started[0]);
    await until(() => h.track.started.length === 3, 30_000, "the third to start");
    expect(queuedIds(s.id)).toHaveLength(2);
    for (let i = 1; i < 5; i++) {
      await until(() => h.track.started.length > i, 30_000, `subagent ${i}`);
      h.finish(h.track.started[i]);
    }
    await idle(s.id);

    expect(h.track.most).toBe(2);
    expect([...h.track.started].sort()).toEqual(["part 0", "part 1", "part 2", "part 3", "part 4"]);
    expect(queuedIds(s.id)).toEqual([]);
    expect(h.results().map((r, i) => [`a${i}`, resultText(r), !!r.is_error])).toEqual([0, 1, 2, 3, 4].map((i) => [`a${i}`, `Report: part ${i}`, false]));
    expect(store.get(s.id)!.transcript.filter((t) => t.kind === "tool" && t.call.name === "agent").map((t) => t.kind === "tool" && t.call.outcome)).toEqual(["done", "done", "done", "done", "done"]);
  }, T);

  it("with no limit (-1), runs all 5 subagents at once and queues none (#173)", async () => {
    const h = held(5);
    const runner = await runnerWith(h.script, { usage: () => withUsage({ subagents: "automatic", subagentsPerTurn: -1 }) });
    const s = store.create();
    await runner.send(s.id, "five parts");
    await until(() => h.track.started.length === 5, 30_000, "all five to start");
    expect(h.track.live).toBe(5);
    expect(queuedIds(s.id)).toEqual([]);
    for (let i = 0; i < 5; i++) h.finish(`part ${i}`);
    await idle(s.id);
    expect(h.track.most).toBe(5);
    expect(h.results().map((r) => resultText(r))).toEqual([0, 1, 2, 3, 4].map((i) => `Report: part ${i}`));
  }, T);

  it("tells the model there is no limit when concurrency is -1 (#173)", async () => {
    const runner = await runnerWith(seq([text("ok")]), { usage: () => withUsage({ subagents: "automatic", subagentsPerTurn: -1 }) });
    const s = store.create();
    await runner.send(s.id, "hi");
    await idle(s.id);
    const prompt = fake!.requests[0].system;
    expect(prompt).toContain("no limit on how many run at once");
    expect(prompt).not.toContain("wait and start");
  }, T);

  it("tells the model how many subagents run at once and that more wait, never to do the work itself (#164)", async () => {
    const runner = await runnerWith(fanOut(7), { usage: () => withUsage({ subagents: "automatic", subagentsPerTurn: 6 }) });
    const s = store.create();
    await runner.send(s.id, "seven parts");
    await idle(s.id);
    const fin = store.get(s.id)!;
    expect(fake!.requests[0].system).toContain("6 subagents run at once; any more wait and start as running ones finish");
    expect(fake!.requests.filter((r) => r.sub)).toHaveLength(7);
    const main = fake!.requests.filter((r) => !r.sub).at(-1)!;
    const results = Array.from({ length: 7 }, (_, i) => resultIn(main, `a${i}`)!);
    expect(results.filter((r) => r.is_error)).toEqual([]);
    expect(results.map((r) => resultText(r))).toEqual(Array.from({ length: 7 }, (_, i) => `Report: part ${i}`));
    expect(said(main)).not.toMatch(/yourself|Settings > Agents > Worker allows/);
    expect(fin.turn?.agents).toBe(7);
  }, T);

  it("cancels the waiting subagents when the turn is stopped (#164)", async () => {
    const h = held(5);
    const runner = await runnerWith(h.script, { usage: () => withUsage({ subagents: "automatic", subagentsPerTurn: 2 }) });
    const s = store.create();
    await runner.send(s.id, "five parts");
    await until(() => h.track.started.length === 2 && queuedIds(s.id).length === 3, 30_000, "two running and three queued");
    // Stop everything: the main agent's reply and every subagent, running or waiting.
    runner.stopAll(s.id);
    // Nothing waiting starts after the stop.
    await new Promise((r) => setTimeout(r, 500));
    expect(h.track.started).toHaveLength(2);
    const fin = store.get(s.id)!;
    expect(fin.status).toBe("stopped");
    expect(fin.transcript.filter((t) => t.kind === "tool" && t.call.name === "agent").map((t) => t.kind === "tool" && t.call.outcome)).toEqual(["stopped", "stopped", "stopped", "stopped", "stopped"]);
    expect(queuedIds(s.id)).toEqual([]);
  }, T);

  it("stops one waiting subagent on its own, and the rest still run (#164)", async () => {
    const h = held(3);
    const runner = await runnerWith(h.script, { usage: () => withUsage({ subagents: "automatic", subagentsPerTurn: 1 }) });
    const s = store.create();
    await runner.send(s.id, "three parts");
    await until(() => h.track.started.length === 1 && queuedIds(s.id).length === 2, 30_000, "one running and two queued");
    const first = h.track.started[0];
    const waiting = queuedIds(s.id);
    expect(runner.stopSubagent(s.id, waiting[0])).toBe(true);
    h.finish(first);
    await until(() => h.track.started.length === 2, 30_000, "the other waiting one to start");
    h.finish(h.track.started[1]);
    await idle(s.id);
    expect(h.track.started).toHaveLength(2);
    const stoppedId = waiting[0];
    const stopped = resultIn(h.track.main!, stoppedId)!;
    expect(stopped).toMatchObject({ is_error: true });
    expect(resultText(stopped)).toContain("stopped this subagent before it started");
    expect(h.results().filter((r) => !r.is_error).map((r) => resultText(r)).sort()).toEqual([`Report: ${first}`, `Report: ${h.track.started[1]}`].sort());
  }, T);

  it("runs subagents on the chosen model and effort", async () => {
    const runner = await runnerWith(fanOut(1), {
      effort: () => "high",
      subagentModel: () => "claude-haiku-5-5",
      usage: () => withUsage({ subagents: "automatic", subagentEffort: "low" }),
    });
    const s = store.create();
    await runner.send(s.id, "one part");
    await idle(s.id);
    const sub = fake!.requests.find((r) => r.sub)!;
    const main = fake!.requests.find((r) => !r.sub)!;
    expect(sub.model).toBe("claude-haiku-5-5");
    expect(main.model).toBe("claude-opus-5-5");
    expect([effortOf(sub), effortOf(main)]).toEqual(["low", "high"]);
  }, T);

  it("keeps what each agent spent in the session: the main agent and each subagent apart", async () => {
    const runner = await runnerWith(fanOut(2, 1000), { usage: () => withUsage({ subagents: "automatic" }) });
    const s = store.create();
    await runner.send(s.id, "two parts");
    await idle(s.id);
    const fin = store.get(s.id)!;
    const { main, ...subs } = SessionStore.detail(fin).tokens!;
    expect(main).toBe(2000);
    expect(Object.values(subs)).toEqual([1000, 1000]);
    const agentCalls = fin.transcript.flatMap((t) => (t.kind === "tool" && t.call.name === "agent" ? [t.call.id] : []));
    expect(Object.keys(subs).sort()).toEqual(agentCalls.sort());
    expect(fin.transcript.some((t) => (t as { kind: string }).kind === "usage")).toBe(false);
  }, T);

  it("puts the project's CLAUDE.md in the prompt as Claude Code reads it, and nothing while the project's own files are off", async () => {
    fs.writeFileSync(path.join(host.projectDir, "CLAUDE.md"), "Blueprints live under /Game/BP.");
    const on = await runnerWith(seq([text("ok")]), { usage: () => DEFAULT_USAGE, native: nativeClaude });
    const s = store.create();
    await on.send(s.id, "hi");
    await idle(s.id);
    expect(fake!.requests[0].system).toContain("## From CLAUDE.md\nBlueprints live under /Game/BP.");
    on.dispose();
    const off = await runnerWith(seq([text("ok")]), { usage: () => withUsage({ projectInstructions: false }), native: () => null });
    const t = store.create();
    await off.send(t.id, "hi");
    await idle(t.id);
    expect(fake!.requests.at(-1)!.system).not.toContain("Blueprints live under");
  }, T);
});

describe("a call's result", () => {
  it("reaches the model without indentation and stays as ue-mcp answered in the transcript", async () => {
    const answer = JSON.stringify({ success: true, actors: [{ label: "Sun", class: "DirectionalLight" }] }, null, 2);
    host.handler = async () => ok(answer);
    const runner = await runnerWith(seq([call("t1", "level", "get_outliner"), text("Done.")]));
    const s = store.create();
    await runner.send(s.id, "what is in the level");
    await idle(s.id);
    expect(resultText(resultIn(fake!.requests[1], "t1"))).toBe(JSON.stringify(JSON.parse(answer)));
    expect(toolEntry(s.id, "t1")?.result).toBe(answer);
  }, T);
});

describe("select and omit on a call", () => {
  it("go to ue-mcp beside the action's parameters, which takes them off before the action runs", async () => {
    const runner = await runnerWith(seq([
      use("c", "ue_mcp", { action: "call", category: "level", method: "get_outliner", args: { filter: "Light" }, select: ["actors.label"], omit: ["actors.transform"] }),
      use("d", "ue_mcp", { action: "call", category: "level", method: "get_outliner", select: [] }),
      text("ok"),
    ]));
    const s = store.create();
    await runner.send(s.id, "list the lights");
    await idle(s.id);
    expect(host.calls).toEqual([
      { category: "level", action: "get_outliner", args: { filter: "Light", select: ["actors.label"], omit: ["actors.transform"] } },
      // An empty list selects nothing, so it is not sent.
      { category: "level", action: "get_outliner", args: {} },
    ]);
  }, T);
});

describe("approval rows: editor restarts and ue-mcp actions that delete or overwrite", () => {
  const effects = {
    destructive: (c: string, m: string) => (c === "asset" && m === "delete" ? true : c === "asset" || c === "level" ? false : null),
    readOnly: () => null,
  };
  const rows = (over: Partial<Record<"shell" | "files" | "editorRestart" | "destructive", "ask" | "project" | "allow">>) => () =>
    ({ shell: "allow", files: "allow", editorRestart: "allow", destructive: "allow", ...over } as const);
  const waiting = (sid: string) => () => (store.get(sid)!.approvals ?? []).length > 0;
  const editorActions = () => host.calls.filter((c) => c.action !== "list_dirty_packages").map((c) => c.action);

  it("asks before a destructive ue-mcp action, from ue-mcp's metadata, and runs the rest without asking", async () => {
    const runner = await runnerWith(seq([call("r1", "asset", "list", { path: "/Game" }), call("d1", "asset", "delete", { assetPath: "/Game/Old" }), text("Deleted.")]), { approvals: rows({ destructive: "ask" }), effects });
    const s = store.create();
    await runner.send(s.id, "clean up");
    await until(waiting(s.id), 30_000, "the approval");
    const a = store.get(s.id)!.approvals![0];
    expect(a).toMatchObject({ tool: "ue_mcp", toolUseId: "d1", call: { category: "asset", method: "delete", args: { assetPath: "/Game/Old" } } });
    expect(editorActions()).toEqual(["list"]);
    runner.answerApproval(s.id, a.id, "allow");
    await idle(s.id);
    expect(editorActions()).toEqual(["list", "delete"]);
  }, T);

  it("asks before an editor restart, by the tool or by the editor action, and keeps a session allowance apart from commands", async () => {
    const runner = await runnerWith(seq([use("e1", "editor_restart", { operation: "rebuild", reason: "new C++ class" }), call("e2", "editor", "restart_editor"), text("Back.")]), { approvals: rows({ editorRestart: "ask" }), effects });
    const s = store.create();
    await runner.send(s.id, "rebuild");
    await until(waiting(s.id), 30_000, "the approval");
    const a = store.get(s.id)!.approvals![0];
    expect(a).toMatchObject({ tool: "editor_restart", operation: "rebuild", reason: "new C++ class" });
    runner.answerApproval(s.id, a.id, "session");
    await idle(s.id);
    // The second restart was allowed for the session: asked once.
    expect(host.published.filter((e) => e.type === "approval.requested")).toHaveLength(1);
    expect(store.get(s.id)!.allowed).toEqual(["restart"]);
  }, T);

  it("does not ask about a kind set to allow, and cannot ask about destructive actions without ue-mcp's metadata", async () => {
    const runner = await runnerWith(seq([call("d1", "asset", "delete", { assetPath: "/Game/Old" }), use("e1", "editor_restart", { operation: "restart", reason: "r" }), text("ok")]), { approvals: rows({ destructive: "ask", editorRestart: "allow" }) });
    const s = store.create();
    await runner.send(s.id, "go");
    await idle(s.id);
    expect(host.published.some((e) => e.type === "approval.requested")).toBe(false);
  }, T);

  it("follows the shell and file rows separately", async () => {
    const runner = await runnerWith(seq([use("w1", "write_file", { path: "a.txt", content: "x" }), use("c1", "shell", { command: "echo hi" }), text("ok")]), { approvals: rows({ shell: "ask" }) });
    const s = store.create();
    await runner.send(s.id, "go");
    await until(waiting(s.id), 30_000, "the approval");
    expect(fs.readFileSync(path.join(host.projectDir, "a.txt"), "utf-8")).toBe("x");
    expect(store.get(s.id)!.approvals![0]).toMatchObject({ tool: "shell", command: "echo hi" });
    runner.answerApproval(s.id, store.get(s.id)!.approvals![0].id, "deny");
    await idle(s.id);
  }, T);

  it("runs commands and file changes inside the project without asking under In project, and asks about the rest", async () => {
    const elsewhere = path.join(path.dirname(host.projectDir), "elsewhere.txt");
    const runner = await runnerWith(seq([
      use("w1", "write_file", { path: "a.txt", content: "x" }),
      use("c1", "shell", { command: "echo hi" }),
      use("w2", "write_file", { path: elsewhere, content: "y" }),
      text("ok"),
    ]), { approvals: rows({ shell: "project", files: "project" }) });
    const s = store.create();
    await runner.send(s.id, "go");
    await until(waiting(s.id), 30_000, "the approval");
    expect(fs.readFileSync(path.join(host.projectDir, "a.txt"), "utf-8")).toBe("x");
    expect(host.published.filter((e) => e.type === "approval.requested")).toHaveLength(1);
    expect(store.get(s.id)!.approvals![0]).toMatchObject({ tool: "write_file", path: elsewhere });
    runner.answerApproval(s.id, store.get(s.id)!.approvals![0].id, "deny");
    await idle(s.id);
    expect(fs.existsSync(elsewhere)).toBe(false);
  }, T);
});

describe("instruction files that join as the agent works", () => {
  it("adds a subfolder's CLAUDE.md to the first result that touches the folder, once, as Claude Code loads it on demand", async () => {
    fs.mkdirSync(path.join(host.projectDir, "Source", "Game"), { recursive: true });
    fs.writeFileSync(path.join(host.projectDir, "Source", "Game", "CLAUDE.md"), "Use the Game module's logging category.");
    fs.writeFileSync(path.join(host.projectDir, "Source", "Game", "A.cpp"), "int a;");
    fs.writeFileSync(path.join(host.projectDir, "CLAUDE.md"), "Root rules.");
    const runner = await runnerWith(seq([use("r1", "read_file", { path: "Source/Game/A.cpp" }), use("r2", "read_file", { path: "Source/Game/A.cpp" }), text("ok")]), { native: nativeClaude });
    const s = store.create();
    await runner.send(s.id, "read it");
    await idle(s.id);
    expect(fake!.requests[0].system).toContain("## From CLAUDE.md\nRoot rules.");
    expect(fake!.requests[0].system).not.toContain("logging category");
    expect(resultText(resultOf("r1"))).toContain("Instructions from Source/Game/CLAUDE.md apply to this work in Source/Game");
    expect(resultText(resultOf("r2"))).not.toContain("Instructions from Source/Game/CLAUDE.md");
  }, T);
});

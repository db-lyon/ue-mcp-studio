/**
 * The main agent's agent_list, agent_read, agent_message and agent_stop: what
 * each answers from a session's transcript, and that the runner's versions
 * steer a subagent through the same paths as the chat's cards.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ActionResult, EditorStatus } from "ue-mcp/daemon";
import type { TranscriptEntry } from "@ue-mcp-studio/shared";
import { AgentRunner } from "../src/runner.js";
import { SessionStore } from "../src/sessions.js";
import type { ModelProvider, ModelRequest, ModelTurn } from "../src/providers.js";
import type { AgentHost } from "../src/tools.js";
import { toolOptions } from "../src/subscription.js";
import { messagesIn, toSubagent } from "../src/subagent-inbox.js";
import { AGENT_STOPPED, SUBAGENT_CANNOT_MANAGE, SUBAGENT_TOOL_NAMES, fromAgent, runSubagentTool, type SubagentControl } from "../src/subagent-tools.js";

const AT = "2026-11-22T10:00:00.000Z";
const agentCall = (id: string, description: string, outcome: "pending" | "done" | "stopped", result?: string): TranscriptEntry => ({
  kind: "tool",
  call: { id, name: "agent", input: { description, prompt: `do ${description}` }, outcome, startedAt: AT, ...(outcome !== "pending" ? { endedAt: AT } : {}), ...(result !== undefined ? { result } : {}) },
});

function control(transcript: TranscriptEntry[], o: Partial<SubagentControl> = {}): SubagentControl & { sent: string[]; stopped: string[] } {
  const sent: string[] = [];
  const stopped: string[] = [];
  return {
    transcript,
    status: "running",
    asked: new Set(),
    canMessage: () => true,
    assigned: () => false,
    message: async (id, text) => {
      sent.push(`${id}:${text}`);
      return true;
    },
    stop: (id) => {
      stopped.push(id);
      return true;
    },
    sent,
    stopped,
    ...o,
  };
}

const session = (): TranscriptEntry[] => [
  { kind: "user", text: "build two things", at: AT },
  agentCall("door", "Build the door", "pending"),
  { kind: "tool", parent: "door", call: { id: "c1", name: "ue_mcp", input: { action: "call", category: "asset", method: "create", args: { name: "Door" } }, outcome: "done", result: "created /Game/Door", startedAt: AT, endedAt: AT } },
  { kind: "assistant", parent: "door", text: "Made the door asset.", at: AT },
  { kind: "tool", parent: "door", call: { id: "c2", name: "ue_mcp", input: { action: "call", category: "level", method: "spawn_actor", args: {} }, outcome: "pending", startedAt: AT } },
  agentCall("hall", "Light the hall", "done", "The hall has three lights."),
];

describe("agent_list", () => {
  it("lists every subagent with its id, task, state and steps", async () => {
    const r = await runSubagentTool("agent_list", {}, null, control(session()));
    expect(r.isError).toBe(false);
    expect(r.text).toContain("2 subagents:");
    expect(r.text).toContain(`door: "Build the door", working on ue_mcp level.spawn_actor, 2 steps, started ${AT}`);
    expect(r.text).toContain(`hall: "Light the hall", finished, 0 steps, started ${AT}, ended ${AT}`);
  });

  it("says when the session has none, and names the ones the user started", async () => {
    expect((await runSubagentTool("agent_list", {}, null, control([]))).text).toBe("This session has no subagents.");
    const r = await runSubagentTool("agent_list", {}, null, control(session(), { assigned: (id) => id === "hall" }));
    expect(r.text).toMatch(/hall: .*started by the user/);
  });
});

describe("agent_read", () => {
  it("reads a running subagent's newest entries", async () => {
    const r = await runSubagentTool("agent_read", { id: "door", entries: 2 }, null, control(session()));
    expect(r.isError).toBe(false);
    expect(r.text).toContain('"Build the door" (door): working. Task: do Build the door');
    expect(r.text).toContain("Entries 2 to 3 of 3:");
    expect(r.text).toContain("[it wrote] Made the door asset.");
    expect(r.text).toContain("[call ue_mcp level.spawn_actor, pending]");
    expect(r.text).not.toContain("created /Game/Door");
    expect(r.text).not.toContain("Its report");
  });

  it("gives a finished subagent's report, and refuses an id the session does not have", async () => {
    const done = await runSubagentTool("agent_read", { id: "hall" }, null, control(session()));
    expect(done.text).toContain("Its thread has no entries yet.");
    expect(done.text).toContain("Its report:\nThe hall has three lights.");
    const missing = await runSubagentTool("agent_read", { id: "nope" }, null, control(session()));
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/No subagent of this session has the id nope\. Call agent_list/);
  });

  it("shows which messages came from the main agent and which from the user", async () => {
    const t = [...session(), { kind: "user" as const, parent: "door", text: fromAgent("use oak"), at: AT }, { kind: "user" as const, parent: "door", text: "make it red", at: AT }];
    const r = await runSubagentTool("agent_read", { id: "door" }, null, control(t));
    expect(r.text).toContain("[your message] use oak");
    expect(r.text).toContain("[the user's message] make it red");
  });
});

describe("agent_message", () => {
  it("steers the message into a running subagent", async () => {
    const c = control(session());
    const r = await runSubagentTool("agent_message", { id: "door", text: " use oak " }, null, c);
    expect(r).toEqual({ text: 'Sent. "Build the door" (door) reads it at its next step.', isError: false });
    expect(c.sent).toEqual(["door:use oak"]);
  });

  it("refuses a finished subagent, one the user started, and one that cannot take a message, each with a way on", async () => {
    const ended = await runSubagentTool("agent_message", { id: "hall", text: "more" }, null, control(session()));
    expect(ended.isError).toBe(true);
    expect(ended.text).toMatch(/has ended \(done\).*resume set to hall/);
    const theirs = await runSubagentTool("agent_message", { id: "door", text: "x" }, null, control(session(), { assigned: () => true }));
    expect(theirs.text).toMatch(/only the user can message it\. Ask them/);
    const c = control(session(), { canMessage: () => false });
    const cannot = await runSubagentTool("agent_message", { id: "door", text: "x" }, null, c);
    expect(cannot.text).toMatch(/Stop it with agent_stop/);
    expect(c.sent).toEqual([]);
    expect((await runSubagentTool("agent_message", { id: "door", text: "  " }, null, control(session()))).isError).toBe(true);
  });
});

describe("agent_stop", () => {
  it("stops a running subagent", async () => {
    const c = control(session());
    const r = await runSubagentTool("agent_stop", { id: "door" }, null, c);
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/^Stopped "Build the door" \(door\)\. .*resume set to door/);
    expect(c.stopped).toEqual(["door"]);
  });

  it("leaves a finished subagent and one the user started alone", async () => {
    const c = control(session(), { assigned: (id) => id === "door" });
    expect(await runSubagentTool("agent_stop", { id: "hall" }, null, c)).toEqual({ text: '"Light the hall" (hall) has already ended (done).', isError: false });
    expect((await runSubagentTool("agent_stop", { id: "door" }, null, c)).text).toMatch(/only the user can stop it/);
    expect(c.stopped).toEqual([]);
  });
});

describe("a subagent's call", () => {
  it("is refused for every one of the tools", async () => {
    for (const name of SUBAGENT_TOOL_NAMES) {
      const c = control(session());
      expect(await runSubagentTool(name, { id: "hall", text: "x" }, "door", c)).toEqual({ text: SUBAGENT_CANNOT_MANAGE, isError: true });
      expect(c.stopped.length + c.sent.length).toBe(0);
    }
  });
});

describe("the main agent's message in a subagent's conversation", () => {
  it("goes in as written beside the user's, and counts as a message taken in", () => {
    const both = toSubagent(["make it red", fromAgent("use oak")]);
    expect(both.startsWith("The user writes to you from your thread")).toBe(true);
    expect(both).toContain("make it red");
    expect(both.endsWith("Message from the main agent:\n\nuse oak")).toBe(true);
    expect(toSubagent([fromAgent("use oak")])).toBe("Message from the main agent:\n\nuse oak");
    expect(messagesIn(both)).toBe(2);
  });
});

describe("on the Claude sign-in", () => {
  it("allows the tools only to a conversation that has the agent tool", () => {
    const main = toolOptions({ agent: true, skills: false });
    for (const n of SUBAGENT_TOOL_NAMES) expect(main.allowedTools).toContain(`mcp__studio__${n}`);
    const sub = toolOptions({ agent: false, reply: true, skills: false });
    for (const n of SUBAGENT_TOOL_NAMES) expect(sub.allowedTools).not.toContain(`mcp__studio__${n}`);
  });
});

class FakeHost implements AgentHost {
  log = { info() {}, warn() {} };
  events = { publish() {}, subscribe: () => () => {} };
  constructor(public projectDir: string, public dataDir: string) {}
  setBusy(): void {}
  async callAction(): Promise<ActionResult> {
    return { isError: false, content: [{ type: "text", text: "{\"success\":true}" }] };
  }
  editors(): EditorStatus[] {
    return [{ name: "P", connected: true, port: 1, pid: 1, lastDisconnect: null }];
  }
  async editorOperation(op: string) {
    return { op, steps: [{ step: `editor.${op}_editor`, ok: true }] };
  }
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("the runner's tools, on Studio's own loop", () => {
  let root: string;
  let host: FakeHost;
  let store: SessionStore;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-subtools-"));
    fs.mkdirSync(path.join(root, "project"), { recursive: true });
    host = new FakeHost(path.join(root, "project"), path.join(root, "data"));
    store = new SessionStore(host.dataDir);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const sub = (req: ModelRequest) => req.system.some((b) => b.text.includes("You are a subagent"));
  const names = (req: ModelRequest) => req.tools.map((t) => (t as { name: string }).name);
  const text = (t: string): ModelTurn => ({ content: [{ type: "text", text: t, citations: null } as never], stopReason: "end_turn" });
  type Tool = (sessionId: string, callId: string, name: string, input: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;
  const toolOf = (runner: AgentRunner): Tool => (runner as unknown as { subagentTool: Tool }).subagentTool.bind(runner);

  /** A main agent that starts one subagent, which waits until `gate` opens or it is stopped. */
  function scripted(gate: Promise<void>) {
    const requests: ModelRequest[] = [];
    let mainCalls = 0;
    const model: ModelProvider = {
      async run(req, _onText, signal) {
        requests.push(JSON.parse(JSON.stringify(req)));
        if (!sub(req)) {
          mainCalls++;
          return mainCalls === 1 ? { content: [{ type: "tool_use", id: "door", name: "agent", input: { description: "Build the door", prompt: "door" } }] as never, stopReason: "tool_use" } : text("Carried on.");
        }
        if (req.messages.length === 1) {
          await Promise.race([gate, new Promise((_r, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))))]);
          return { content: [{ type: "tool_use", id: "c-door", name: "ue_mcp", input: { action: "call", category: "asset", method: "create", args: {} } }] as never, stopReason: "tool_use" };
        }
        return text(JSON.stringify(req.messages).includes("use oak") ? "Door built in oak." : "Door built.");
      },
    };
    return { model, requests };
  }

  it("gives the main agent the tools and its subagents none of them", async () => {
    let open!: () => void;
    const { model, requests } = scripted(new Promise<void>((r) => (open = r)));
    const runner = new AgentRunner({ host, store, provider: () => model, model: () => "claude-opus-5-5" });
    const s = store.create();
    const turn = runner.send(s.id, "door");
    await until(() => runner.canMessage(store.get(s.id)!, "door"));
    open();
    await turn;
    expect(names(requests.find((r) => !sub(r))!)).toEqual(expect.arrayContaining(["agent", ...SUBAGENT_TOOL_NAMES]));
    for (const n of ["agent", ...SUBAGENT_TOOL_NAMES]) expect(names(requests.find(sub)!)).not.toContain(n);
  });

  it("agent_message reaches the subagent as the main agent's, and its report does not call it the user's", async () => {
    let open!: () => void;
    const { model, requests } = scripted(new Promise<void>((r) => (open = r)));
    const runner = new AgentRunner({ host, store, provider: () => model, model: () => "claude-opus-5-5" });
    const s = store.create();
    const turn = runner.send(s.id, "door");
    await until(() => runner.canMessage(store.get(s.id)!, "door"));
    const r = await toolOf(runner)(s.id, "main-call", "agent_message", { id: "door", text: "use oak" });
    expect(r.isError).toBe(false);
    expect(store.get(s.id)!.transcript.at(-1)).toMatchObject({ kind: "user", parent: "door", text: "Message from the main agent:\n\nuse oak" });
    open();
    await turn;
    const door = requests.filter(sub);
    const last = door[1].messages.at(-1)!.content as Array<{ type: string; text?: string }>;
    expect(last.at(-1)!.text).toBe("Message from the main agent:\n\nuse oak");
    const results = store.get(s.id)!.messages[2].content as Array<{ tool_use_id: string; content: string }>;
    expect(results[0].content).toBe("Door built in oak.");
  });

  it("agent_stop stops the subagent as the card's Stop does, and its report says the main agent stopped it", async () => {
    const { model, requests } = scripted(new Promise<void>(() => {}));
    const runner = new AgentRunner({ host, store, provider: () => model, model: () => "claude-opus-5-5" });
    const s = store.create();
    const turn = runner.send(s.id, "door");
    await until(() => runner.canMessage(store.get(s.id)!, "door"));
    const listed = await toolOf(runner)(s.id, "main-call", "agent_list", {});
    expect(listed.text).toContain('door: "Build the door", working');
    expect((await toolOf(runner)(s.id, "main-call", "agent_stop", { id: "door" })).isError).toBe(false);
    await turn;
    const fin = store.get(s.id)!;
    const door = fin.transcript.find((t) => t.kind === "tool" && t.call.id === "door");
    expect(door?.kind === "tool" && door.call.outcome).toBe("stopped");
    expect(door?.kind === "tool" && door.call.result).toBe(AGENT_STOPPED);
    expect(JSON.stringify(requests.filter((r) => !sub(r)).at(-1)!.messages)).toContain(AGENT_STOPPED);
    // Stopped once: the user's Stop now finds nothing running.
    expect(runner.stopSubagent(s.id, "door")).toBe(false);
  });
});

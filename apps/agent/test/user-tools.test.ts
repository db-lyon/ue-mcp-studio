/**
 * The main agent's ask_user and notify_user: ask_user raises a FormBroker card
 * and returns the user's answer, notify_user emits through the Notifier under
 * the project's settings and is capped per turn, and the runner gives both to
 * the main agent on its own loop and to no subagent.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ActionResult, EditorStatus } from "ue-mcp/daemon";
import { DEFAULT_PROJECT_NOTIFY, applyProjectNotify, askUserForm, type Notice, type ProjectNotifyPrefs, type TranscriptEntry } from "@ue-mcp-studio/shared";
import { FormBroker } from "../src/forms.js";
import { Notifier } from "../src/notify.js";
import { AgentRunner } from "../src/runner.js";
import { SessionStore } from "../src/sessions.js";
import type { ModelProvider, ModelRequest, ModelTurn } from "../src/providers.js";
import type { AgentHost } from "../src/tools.js";
import { toolOptions } from "../src/subscription.js";
import { NOTICES_PER_TURN, NoticeLimit, SUBAGENT_CANNOT_REACH_USER, USER_TOOL_NAMES, runUserTool, type UserToolControl } from "../src/user-tools.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

function asking() {
  const events: string[] = [];
  const broker = new FormBroker((type) => events.push(type));
  const control: UserToolControl = { ask: (p, signal) => broker.ask("s1", "ask_user", p, signal), takeNotice: () => true };
  return { broker, control, events };
}

describe("ask_user", () => {
  it("puts the question to the user as a card and returns the option they chose", async () => {
    const { broker, control } = asking();
    const call = runUserTool("ask_user", { question: "Which door?", options: ["Oak", "Steel", "Glass"] }, null, control, new AbortController().signal);
    await tick();
    const [form] = broker.list("s1");
    expect(form).toMatchObject({ call: "ask_user", message: "Which door?", required: ["choice"] });
    expect(askUserForm(form)).toEqual({ question: "Which door?", options: ["Oak", "Steel", "Glass"], other: false });
    expect(broker.answer(form.id, { action: "accept", content: { choice: "Steel" } })).toBeNull();
    expect(await call).toEqual({ text: "The user chose: Steel", isError: false });
    expect(broker.list("s1")).toEqual([]);
  });

  it("takes an answer in the user's own words when the question allows one", async () => {
    const { broker, control } = asking();
    const call = runUserTool("ask_user", { question: "Which door?", options: ["Oak", "Steel"], allow_other: true }, null, control, new AbortController().signal);
    await tick();
    const [form] = broker.list("s1");
    expect(askUserForm(form)?.other).toBe(true);
    broker.answer(form.id, { action: "accept", content: { choice: "Oak", other: "  a bead curtain " } });
    expect(await call).toEqual({ text: "The user answered in their own words: a bead curtain", isError: false });
  });

  it("says when the user declined", async () => {
    const { broker, control } = asking();
    const call = runUserTool("ask_user", { question: "Which door?", options: ["Oak", "Steel"] }, null, control, new AbortController().signal);
    await tick();
    broker.answer(broker.list("s1")[0].id, { action: "decline" });
    expect((await call).text).toMatch(/^The user declined/);
  });

  it("withdraws the card when the turn is stopped", async () => {
    const { broker, control, events } = asking();
    const stop = new AbortController();
    const call = runUserTool("ask_user", { question: "Which door?", options: ["Oak", "Steel"] }, null, control, stop.signal);
    await tick();
    expect(broker.list("s1")).toHaveLength(1);
    stop.abort();
    expect(await call).toMatchObject({ isError: true, text: expect.stringContaining("withdrawn") });
    expect(broker.list("s1")).toEqual([]);
    expect(events.filter((e) => e === "form.changed")).toHaveLength(2);
  });

  it("refuses a question without two to six distinct options, and raises no card", async () => {
    const { broker, control } = asking();
    const signal = new AbortController().signal;
    for (const options of [["Oak"], ["Oak", " Oak "], ["a", "b", "c", "d", "e", "f", "g"], "Oak"]) {
      expect((await runUserTool("ask_user", { question: "Which door?", options }, null, control, signal)).isError).toBe(true);
    }
    expect((await runUserTool("ask_user", { question: " ", options: ["Oak", "Steel"] }, null, control, signal)).isError).toBe(true);
    expect(broker.list()).toEqual([]);
  });
});

function notifying(prefs: ProjectNotifyPrefs = DEFAULT_PROJECT_NOTIFY) {
  const published: Notice[] = [];
  const traces: Array<Record<string, unknown>> = [];
  const p = { prefs };
  const notifier = new Notifier({
    project: "Vale",
    session: () => ({ title: "Bake the lights", transcript: [] }),
    prefs: () => p.prefs,
    publish: (type, data) => (type === "notify" ? published.push(data as unknown as Notice) : traces.push(data)),
  });
  const limit = new NoticeLimit();
  const transcript: TranscriptEntry[] = [{ kind: "user", text: "bake", at: "x" }];
  const control: UserToolControl = {
    notify: (title, text) => notifier.emit("agent.notice", "s1", title, text, { sessionId: "s1" }),
    takeNotice: () => limit.take("s1", transcript),
  };
  return { notifier, published, traces, p, control, transcript };
}

describe("notify_user", () => {
  const signal = new AbortController().signal;

  it("publishes a studio.notify notice for the session through the Notifier", async () => {
    const { published, control } = notifying();
    const r = await runUserTool("notify_user", { title: "Lighting build finished", text: "Two warnings, no errors." }, null, control, signal);
    expect(r).toMatchObject({ isError: false, text: expect.stringMatching(/^Sent/) });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ kind: "agent.notice", project: "Vale", sessionId: "s1", title: "Lighting build finished", text: "Two warnings, no errors.", target: { sessionId: "s1" } });
  });

  it("is dropped and traced like any notice when the session is muted or its event is off", async () => {
    const { published, traces, p, control } = notifying(applyProjectNotify(DEFAULT_PROJECT_NOTIFY, { mute: ["s1"] }));
    const r = await runUserTool("notify_user", { title: "Cook done", text: "Ready." }, null, control, signal);
    expect(r).toMatchObject({ isError: false, text: expect.stringMatching(/^Not sent/) });
    p.prefs = applyProjectNotify(DEFAULT_PROJECT_NOTIFY, { events: { "agent.notice": false } });
    await runUserTool("notify_user", { title: "Cook done", text: "Ready." }, null, control, signal);
    expect(published).toEqual([]);
    expect(traces.map((t) => [t.kind, t.decision, t.rule])).toEqual([["agent.notice", "suppressed", "session-muted"], ["agent.notice", "suppressed", "event"]]);
  });

  it(`sends at most ${NOTICES_PER_TURN} per turn, and counts again from the user's next message`, async () => {
    const { published, control, transcript } = notifying();
    const results = [];
    for (let i = 0; i < NOTICES_PER_TURN + 2; i++) results.push(await runUserTool("notify_user", { title: `Step ${i}`, text: "Done." }, null, control, signal));
    expect(published).toHaveLength(NOTICES_PER_TURN);
    expect(results.slice(NOTICES_PER_TURN).every((r) => r.isError && r.text.includes("this turn"))).toBe(true);
    transcript.push({ kind: "assistant", text: "ok", at: "x" }, { kind: "user", text: "again", at: "y" });
    expect((await runUserTool("notify_user", { title: "Again", text: "Done." }, null, control, signal)).isError).toBe(false);
    expect(published).toHaveLength(NOTICES_PER_TURN + 1);
  });

  it("needs a title and a text", async () => {
    const { published, control } = notifying();
    expect((await runUserTool("notify_user", { title: "Done" }, null, control, signal)).isError).toBe(true);
    expect(published).toEqual([]);
  });
});

describe("a subagent's call", () => {
  it("is refused for both tools, with nothing asked or sent", async () => {
    const { broker, control } = asking();
    const { published, control: n } = notifying();
    const input = { question: "Which door?", options: ["Oak", "Steel"], title: "Done", text: "Done." };
    for (const name of USER_TOOL_NAMES) {
      expect(await runUserTool(name, input, "door", { ...control, notify: n.notify, takeNotice: n.takeNotice }, new AbortController().signal)).toEqual({ text: SUBAGENT_CANNOT_REACH_USER, isError: true });
    }
    expect(broker.list()).toEqual([]);
    expect(published).toEqual([]);
  });
});

describe("on the Claude sign-in", () => {
  it("allows the tools only to the main agent's conversation, with or without subagents", () => {
    for (const agent of [true, false]) {
      const main = toolOptions({ agent, user: true, skills: false });
      for (const n of USER_TOOL_NAMES) expect(main.allowedTools).toContain(`mcp__studio__${n}`);
    }
    const sub = toolOptions({ agent: false, reply: true, skills: false });
    for (const n of USER_TOOL_NAMES) expect(sub.allowedTools).not.toContain(`mcp__studio__${n}`);
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

describe("the runner, on Studio's own loop", () => {
  let root: string;
  let host: FakeHost;
  let store: SessionStore;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-usertools-"));
    fs.mkdirSync(path.join(root, "project"), { recursive: true });
    host = new FakeHost(path.join(root, "project"), path.join(root, "data"));
    store = new SessionStore(host.dataDir);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const sub = (req: ModelRequest) => req.system.some((b) => b.text.includes("You are a subagent"));
  const names = (req: ModelRequest) => req.tools.map((t) => (t as { name: string }).name);
  const text = (t: string): ModelTurn => ({ content: [{ type: "text", text: t, citations: null } as never], stopReason: "end_turn" });

  it("asks through the chat's form card and hands the answer back as the call's result; subagents never get the tools", async () => {
    const requests: ModelRequest[] = [];
    let main = 0;
    const model: ModelProvider = {
      async run(req) {
        requests.push(JSON.parse(JSON.stringify(req)));
        if (sub(req)) return text("Looked.");
        main++;
        if (main === 1) return { content: [{ type: "tool_use", id: "look", name: "agent", input: { description: "Look", prompt: "look" } }] as never, stopReason: "tool_use" };
        if (main === 2) return { content: [{ type: "tool_use", id: "q", name: "ask_user", input: { question: "Which door?", options: ["Oak", "Steel"] } }] as never, stopReason: "tool_use" };
        return text("Going with it.");
      },
    };
    const forms = new FormBroker(() => {});
    const runner = new AgentRunner({ host, store, forms, provider: () => model, model: () => "claude-opus-5-5" });
    const s = store.create();
    const turn = runner.send(s.id, "make a door");
    await until(() => forms.list(s.id).length === 1);
    forms.answer(forms.list(s.id)[0].id, { action: "accept", content: { choice: "Oak" } });
    await turn;
    const call = store.get(s.id)!.transcript.find((t) => t.kind === "tool" && t.call.id === "q");
    expect(call?.kind === "tool" && call.call).toMatchObject({ name: "ask_user", outcome: "done", result: "The user chose: Oak" });
    expect(names(requests.find((r) => !sub(r))!)).toEqual(expect.arrayContaining([...USER_TOOL_NAMES]));
    for (const n of USER_TOOL_NAMES) expect(names(requests.find(sub)!)).not.toContain(n);
  });
});

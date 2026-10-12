import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ActionResult } from "ue-mcp/daemon";
import { isDestructiveAnswer, safeButton, type DialogPolicy } from "@ue-mcp-studio/shared";
import { DialogBroker, PROMPT_FEATURE, WAIT_POLICY_CALL_MS, type CallOptions, type DialogPromptRequest, type DialogPromptResult } from "../src/dialogs.js";
import { dialogAnswerOf } from "../src/dialog-routes.js";
import { SessionStore } from "../src/sessions.js";
import type { AgentHost } from "../src/tools.js";

const ok = (text = "{}"): ActionResult => ({ isError: false, content: [{ type: "text", text }] });
const BUTTONS = ["Save Selected", "Don't Save", "Cancel"];

type Listener = (e: { type: string; data: Record<string, unknown> }) => void;

/** A daemon: callAction records each call and its options; events are a list and a bus. */
function daemon(features: string[] | null = [PROMPT_FEATURE, "events.dialog"]) {
  const calls: Array<{ category: string; action: string; args?: Record<string, unknown>; opts?: CallOptions }> = [];
  const published: Array<{ type: string; data: Record<string, unknown> }> = [];
  const listeners = new Set<Listener>();
  let next: (category: string, action: string, opts?: CallOptions) => Promise<ActionResult> = async () => ok();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-dialogs-"));
  const host: AgentHost & { callAction: (c: string, a: string, args?: Record<string, unknown>, opts?: CallOptions) => Promise<ActionResult>; features?: string[] } = {
    projectDir: "C:/Game",
    dataDir,
    ...(features ? { features } : {}),
    callAction: (category, action, args, opts) => {
      calls.push({ category, action, args, opts });
      return next(category, action, opts);
    },
    editors: () => [],
    editorOperation: async () => ({}),
    events: {
      publish: (type, data = {}) => {
        published.push({ type, data });
        return undefined;
      },
      subscribe: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    },
    setBusy: () => {},
    log: { info: () => {}, warn: () => {} },
  };
  const emit = (type: string, data: Record<string, unknown>) => {
    for (const l of listeners) l({ type, data });
  };
  return { host, calls, published, emit, dataDir, setNext: (f: typeof next) => (next = f) };
}

function request(over: Partial<DialogPromptRequest["dialog"]> = {}): DialogPromptRequest {
  return {
    message: "Unreal is blocked: Save Content",
    requestedSchema: { type: "object", properties: { button: { type: "string" } }, required: ["button"] },
    dialog: { editor: "Scratch", title: "Save Content", message: "Save these?", buttons: BUTTONS, subject: "editor.stop_editor", minHumanMs: 1000, ...over },
  };
}

let policy: DialogPolicy = { kind: "agent", minutes: 2 };

function setup(features?: string[] | null) {
  const d = daemon(features);
  const store = new SessionStore(d.dataDir);
  const broker = new DialogBroker({ host: d.host, store, policy: () => policy, holdMs: 10_000 });
  const s = store.create();
  s.transcript.push({ kind: "tool", call: { id: "tu1", name: "ue_mcp", input: { action: "call", category: "editor", method: "stop_editor" }, outcome: "pending", startedAt: "now" } });
  store.save(s);
  return { ...d, store, broker, s };
}

beforeEach(() => {
  vi.useFakeTimers();
  policy = { kind: "agent", minutes: 2 };
});
afterEach(() => vi.useRealTimers());

describe("a Studio call's dialog", () => {
  it("passes the prompt with each call when the daemon offers it, and waits past the policy's deadline", async () => {
    const { host, calls, broker } = setup();
    await broker.wrap(host, "s").callAction("level", "spawn_actor", {});
    expect(typeof calls[0].opts?.dialogPrompt).toBe("function");
    expect(calls[0].opts?.dialogWaitMs).toBe(2 * 60_000 + 15_000);
    policy = { kind: "wait" };
    await broker.wrap(host, "s").callAction("level", "spawn_actor", {});
    expect(calls[1].opts?.dialogWaitMs).toBe(WAIT_POLICY_CALL_MS);
  });

  it("passes nothing to an older daemon, so calls go through as before", async () => {
    const { host, calls, broker } = setup(null);
    expect(broker.supported()).toBe(false);
    await broker.wrap(host, "s").callAction("level", "spawn_actor", {});
    expect(calls[0].opts).toBeUndefined();
    expect(broker.state().supported).toBe(false);
  });

  it("shows the dialog as a card naming the call that met it, and a line in the transcript", async () => {
    const { broker, store, s, published } = setup();
    void broker.prompt(s.id, "editor", "stop_editor", request());
    const [d] = broker.state().dialogs;
    expect(d).toMatchObject({ title: "Save Content", message: "Save these?", buttons: BUTTONS, sessionId: s.id, toolUseId: "tu1", call: "editor.stop_editor", mode: "interactive" });
    expect(d.asking).toMatchObject({ minHumanMs: 1000, policy: { kind: "agent", minutes: 2 }, safeButton: "Cancel" });
    expect(store.get(s.id)!.transcript.at(-1)).toMatchObject({ kind: "dialog", dialog: { id: d.id } });
    expect(published.map((p) => p.type)).toEqual(expect.arrayContaining(["transcript.added", "dialog.changed"]));
  });

  it("names the subagent whose call met it", async () => {
    const { broker, store, s } = setup();
    const st = store.get(s.id)!;
    st.transcript.unshift({ kind: "tool", call: { id: "a1", name: "agent", input: { description: "Tidy the level", prompt: "x" }, outcome: "pending", startedAt: "now" } });
    st.transcript.push({ kind: "tool", call: { id: "tu2", name: "ue_mcp", input: { action: "call", category: "level", method: "save" }, outcome: "pending", startedAt: "now" }, parent: "a1" });
    store.save(st);
    void broker.prompt(s.id, "level", "save", request());
    expect(broker.state().dialogs[0]).toMatchObject({ toolUseId: "tu2", parent: "a1", subagent: "Tidy the level" });
  });

  it("presses the button the user picked, with the rows they ticked, once they have had time to read it", async () => {
    const { broker, s } = setup();
    const items = [{ index: 0, label: "L_Test", cells: ["L_Test", "/Game/L_Test", "/Script/Engine.World"], checked: true }, { index: 1, label: "M_A", cells: ["M_A", "/Game/M_A", "/Script/Engine.Material"], checked: true }];
    const answer = broker.prompt(s.id, "editor", "stop_editor", request({ items }));
    const id = broker.state().dialogs[0].id;
    expect(await broker.answer(id, { answer: "press", button: "Save Selected" })).toBe("Read the dialog first.");
    vi.advanceTimersByTime(1000);
    expect(await broker.answer(id, { answer: "press", button: "Save Selected", items: [{ index: 1, checked: false }] })).toBeNull();
    await expect(answer).resolves.toEqual({ action: "accept", content: { button: "Save Selected", items: ["item_0"] } });
    expect(broker.state().dialogs).toEqual([]);
  });

  it("refuses a button the dialog does not have", async () => {
    const { broker, s } = setup();
    void broker.prompt(s.id, "editor", "stop_editor", request());
    vi.advanceTimersByTime(1000);
    expect(await broker.answer(broker.state().dialogs[0].id, { answer: "press", button: "Delete Everything" })).toMatch(/no button/);
  });

  it("hands the dialog to the agent when the user says so", async () => {
    const { broker, s, store } = setup();
    const answer = broker.prompt(s.id, "editor", "stop_editor", request());
    vi.advanceTimersByTime(1000);
    const id = broker.state().dialogs[0].id;
    expect(await broker.answer(id, { answer: "delegate" })).toBeNull();
    await expect(answer).resolves.toEqual({ action: "delegate" });
    const line = store.get(s.id)!.transcript.at(-1);
    expect(line?.kind === "dialog" && line.dialog.outcome).toMatchObject({ kind: "delegated", by: "you" });
  });
});

describe("the policy timers", () => {
  it("lets the agent decide after N minutes", async () => {
    const { broker, s } = setup();
    let result: DialogPromptResult | null = null;
    void broker.prompt(s.id, "editor", "stop_editor", request()).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(2 * 60_000 - 1);
    expect(result).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toEqual({ action: "delegate" });
  });

  it("presses the safe default after N minutes", async () => {
    policy = { kind: "safe", minutes: 1 };
    const { broker, s, store } = setup();
    const answer = broker.prompt(s.id, "editor", "stop_editor", request({ buttons: ["Keep", "Revert"] }));
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(answer).resolves.toEqual({ action: "accept", content: { button: "Keep" } });
    const line = store.get(s.id)!.transcript.at(-1);
    expect(line?.kind === "dialog" && line.dialog.outcome).toMatchObject({ kind: "pressed", button: "Keep", by: "policy" });
  });

  it("waits for the user when the safe policy has no safe button to press", async () => {
    policy = { kind: "safe", minutes: 1 };
    const { broker, s } = setup();
    let settled = false;
    void broker.prompt(s.id, "editor", "stop_editor", request({ buttons: ["Yes", "No"] })).then(() => (settled = true));
    expect(broker.state().dialogs[0].asking?.deadline).toBeNull();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(settled).toBe(false);
  });

  it("waits indefinitely under the wait policy, and stops asking once the dialog closes", async () => {
    policy = { kind: "wait" };
    const { broker, s, emit } = setup();
    const answer = broker.prompt(s.id, "editor", "stop_editor", request());
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(broker.state().dialogs).toHaveLength(1);
    emit("dialog.closed", { editor: "Scratch", title: "Save Content", buttons: BUTTONS });
    await expect(answer).resolves.toEqual({ action: "cancel" });
    expect(broker.state().dialogs).toEqual([]);
  });

  it("cancels the timer when the user answers first", async () => {
    const { broker, s } = setup();
    const answer = broker.prompt(s.id, "editor", "stop_editor", request());
    vi.advanceTimersByTime(1000);
    await broker.answer(broker.state().dialogs[0].id, { answer: "press", button: "Cancel" });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await expect(answer).resolves.toEqual({ action: "accept", content: { button: "Cancel" } });
  });
});

describe("the agent's answer in auto mode", () => {
  function openAuto(emit: (type: string, data: Record<string, unknown>) => void) {
    emit("dialog.opened", { editor: "Scratch", title: "Save Content", message: "Save these?", buttons: BUTTONS, mode: "auto" });
  }

  it("presses an answer that keeps work at once, and shows who pressed it", async () => {
    const { host, broker, calls, emit, s, store } = setup();
    const call = broker.wrap(host, s.id).callAction("editor", "stop_editor", {});
    openAuto(emit);
    expect(broker.state().dialogs[0]).toMatchObject({ mode: "auto", sessionId: s.id, call: "editor.stop_editor" });
    await call;
    await broker.wrap(host, s.id).callAction("editor", "respond_to_dialog", { buttonLabel: "Save Selected" });
    expect(calls.at(-1)).toMatchObject({ action: "respond_to_dialog", args: { buttonLabel: "Save Selected" } });
    emit("dialog.answered", { editor: "Scratch", title: "Save Content", buttons: BUTTONS, button: "Save Selected", via: "action" });
    const line = store.get(s.id)!.transcript.find((t) => t.kind === "dialog");
    expect(line?.kind === "dialog" && line.dialog.outcome).toMatchObject({ kind: "pressed", button: "Save Selected", by: "agent" });
  });

  it("holds an answer that discards work for the countdown, then presses it", async () => {
    const { host, broker, calls, emit, s } = setup();
    openAuto(emit);
    let done = false;
    const press = broker.wrap(host, s.id).callAction("editor", "respond_to_dialog", { buttonLabel: "Don't Save" }).then((r) => ((done = true), r));
    expect(broker.state().dialogs[0].held).toMatchObject({ button: "Don't Save" });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(done).toBe(false);
    expect(calls.some((c) => c.action === "respond_to_dialog")).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await press;
    expect(calls.at(-1)).toMatchObject({ action: "respond_to_dialog", args: { buttonLabel: "Don't Save" } });
  });

  it("presses the user's override instead, and tells the agent", async () => {
    const { host, broker, calls, emit, s } = setup();
    openAuto(emit);
    const press = broker.wrap(host, s.id).callAction("editor", "respond_to_dialog", { buttonIndex: 1 });
    expect(broker.state().dialogs[0].held).toMatchObject({ button: "Don't Save" });
    expect(await broker.answer(broker.state().dialogs[0].id, { answer: "press", button: "Cancel" })).toBeNull();
    const r = await press;
    expect(calls.at(-1)).toMatchObject({ action: "respond_to_dialog", args: { buttonLabel: "Cancel" } });
    expect(r.content[0].text).toMatch(/overrode your choice: "Cancel" was pressed instead of "Don't Save"/);
  });

  it("shows the countdown on a dialog the user handed to the agent", async () => {
    const { host, broker, calls, s } = setup();
    void broker.prompt(s.id, "editor", "stop_editor", request());
    vi.advanceTimersByTime(1000);
    await broker.answer(broker.state().dialogs[0].id, { answer: "delegate" });
    expect(broker.state().dialogs).toEqual([]);
    const press = broker.wrap(host, s.id).callAction("editor", "respond_to_dialog", { buttonLabel: "Don't Save" });
    expect(broker.state().dialogs[0]).toMatchObject({ held: { button: "Don't Save" }, outcome: null });
    await vi.advanceTimersByTimeAsync(10_000);
    await press;
    expect(calls.at(-1)).toMatchObject({ args: { buttonLabel: "Don't Save" } });
  });

  it("presses the held answer at once on Press now", async () => {
    const { host, broker, calls, emit, s } = setup();
    openAuto(emit);
    const press = broker.wrap(host, s.id).callAction("editor", "respond_to_dialog", { buttonLabel: "Don't Save" });
    await broker.answer(broker.state().dialogs[0].id, { answer: "release" });
    await press;
    expect(calls.at(-1)).toMatchObject({ args: { buttonLabel: "Don't Save" } });
  });

  it("presses nothing when the dialog closes during the countdown", async () => {
    const { host, broker, calls, emit, s } = setup();
    openAuto(emit);
    const press = broker.wrap(host, s.id).callAction("editor", "respond_to_dialog", { buttonLabel: "Don't Save" });
    emit("dialog.closed", { editor: "Scratch", title: "Save Content", buttons: BUTTONS });
    const r = await press;
    expect(r.isError).toBe(true);
    expect(calls.some((c) => c.action === "respond_to_dialog")).toBe(false);
  });

  it("holds a destructive press on an older daemon too, where it has no events", async () => {
    const { host, broker, calls, s } = setup(null);
    const press = broker.wrap(host, s.id).callAction("editor", "respond_to_dialog", { buttonLabel: "Delete" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5_000);
    await press;
    expect(calls).toHaveLength(1);
  });
});

describe("dialogs Studio was not asked about", () => {
  it("shows one another client's call met, without a session", () => {
    const { broker, emit } = setup();
    emit("dialog.opened", { editor: "Scratch", title: "Message", message: "Hi", buttons: ["OK"], mode: "defer" });
    expect(broker.state().dialogs[0]).toMatchObject({ title: "Message", sessionId: null, mode: "defer", asking: null });
  });

  it("will not answer one that nobody put to Studio, outside auto", async () => {
    const { broker, emit } = setup();
    emit("dialog.opened", { editor: "Scratch", title: "Message", message: "Hi", buttons: ["OK"], mode: "defer" });
    expect(await broker.answer(broker.state().dialogs[0].id, { answer: "press", button: "OK" })).toMatch(/in the editor/);
  });
});

describe("answers and buttons", () => {
  it("knows which answers discard work", () => {
    for (const b of ["Don't Save", "Don\u2019t Save", "Dont Save", "Delete", "Force Delete", "Discard", "Revert", "Discard Changes"]) expect(isDestructiveAnswer(b)).toBe(true);
    for (const b of ["Save Selected", "Cancel", "Keep", "Save All", "OK"]) expect(isDestructiveAnswer(b)).toBe(false);
  });

  it("picks Cancel, else Keep, as the safe default, and never a guess", () => {
    expect(safeButton(BUTTONS)).toBe("Cancel");
    expect(safeButton(["Keep Current", "Revert"])).toBe("Keep Current");
    expect(safeButton(["OK"])).toBe("OK");
    expect(safeButton(["Yes", "No"])).toBeNull();
  });

  it("reads a route body as an answer", () => {
    expect(dialogAnswerOf({ answer: "press", button: "Cancel" })).toEqual({ answer: "press", button: "Cancel" });
    expect(dialogAnswerOf({ answer: "press", button: "Save", items: [{ index: 0, checked: false, x: 1 }] })).toEqual({ answer: "press", button: "Save", items: [{ index: 0, checked: false }] });
    expect(dialogAnswerOf({ answer: "delegate" })).toEqual({ answer: "delegate" });
    expect(dialogAnswerOf({ answer: "press" })).toBeNull();
    expect(dialogAnswerOf({ answer: "press", button: "x", items: [{ index: "0" }] })).toBeNull();
  });
});

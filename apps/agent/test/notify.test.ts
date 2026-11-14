import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_NOTIFY, applyProjectNotify, type Notice, type ProjectNotifyPrefs } from "@ue-mcp-studio/shared";
import { Notifier, NotifyPrefsStore, PRESENCE_TTL_MS, registerNotifications, type NotifySession } from "../src/notify.js";

function setup(sessions: Record<string, NotifySession> = {}, prefs: ProjectNotifyPrefs = DEFAULT_PROJECT_NOTIFY) {
  const published: Notice[] = [];
  let t = Date.parse("2026-11-04T12:00:00Z");
  const p = { prefs };
  const n = new Notifier({
    project: "Vale",
    session: (id) => sessions[id],
    prefs: () => p.prefs,
    publish: (type, data) => type === "notify" && published.push(data as unknown as Notice),
    window: () => 200_000,
    now: () => t,
  });
  const ev = (type: string, data: Record<string, unknown>) => n.observe({ type: `studio.${type}`, data });
  return { n, ev, published, p, tick: (ms: number) => (t += ms) };
}

const session = (over: Partial<NotifySession> = {}): NotifySession => ({ title: "Fix the door", transcript: [], ...over });

describe("Notifier", () => {
  it("a turn that ends idle is turn.finished: the session, ready for review, and no excerpt of the reply", () => {
    const { ev, published } = setup({ s1: session({ transcript: [{ kind: "assistant", text: "Next is [#95](https://git.example/95), then **#102**.", at: "x" }] }) });
    ev("session.changed", { sessionId: "s1", status: "running" });
    ev("session.changed", { sessionId: "s1", status: "idle" });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ kind: "turn.finished", project: "Vale", sessionId: "s1", sessionTitle: "Fix the door", title: "Fix the door", text: "Ready for your review", target: { sessionId: "s1" } });
  });

  it("an idle session that was never running does not notify", () => {
    const { ev, published } = setup({ s1: session() });
    ev("session.changed", { sessionId: "s1", status: "idle" });
    expect(published).toHaveLength(0);
  });

  it("an error is turn.failed; the owner's own stop notifies nothing", () => {
    const { ev, published } = setup({ s1: session({ error: "rate limited" }) });
    ev("session.changed", { sessionId: "s1", status: "running" });
    ev("session.changed", { sessionId: "s1", status: "error" });
    ev("session.changed", { sessionId: "s1", status: "waiting" });
    ev("session.changed", { sessionId: "s1", status: "stopped" });
    expect(published.map((p) => [p.kind, p.title, p.text])).toEqual([["turn.failed", "Fix the door", "Stopped on an error"]]);
  });

  it("a subagent the owner stopped notifies nothing", () => {
    const sessions = { s1: session({ transcript: [{ kind: "tool", call: { id: "c1", name: "agent", input: { description: "Audit" }, outcome: "stopped" } } as never] }) };
    const { ev, published } = setup(sessions, applyProjectNotify(DEFAULT_PROJECT_NOTIFY, { events: { "subagent.finished": true } }));
    ev("tool.finished", { sessionId: "s1", toolUseId: "c1", outcome: "stopped" });
    expect(published).toHaveLength(0);
  });

  it("sends nothing about a session the owner has open on a device in use, but still the editor's dialogs", () => {
    const { n, ev, published, tick } = setup({ s1: session(), s2: session({ title: "Other" }) });
    n.presence.report("win", "desktop", true, 1_000, "s1");
    ev("session.changed", { sessionId: "s1", status: "running" });
    ev("session.changed", { sessionId: "s1", status: "idle" });
    ev("approval.requested", { sessionId: "s1", approvalId: "a1", tool: "shell" });
    ev("dialog.changed", { now: 1, dialogs: [{ id: "d1", title: "Save Content", message: "Save?", asking: { since: 1 }, outcome: null, sessionId: "s1" }] });
    // Another session still notifies.
    ev("session.changed", { sessionId: "s2", status: "running" });
    ev("session.changed", { sessionId: "s2", status: "idle" });
    expect(published.map((p) => [p.kind, p.sessionId])).toEqual([["dialog.waiting", "s1"], ["turn.finished", "s2"]]);
    // Open but not in use (idle or unfocused), or the report gone stale: it notifies again.
    n.presence.report("win", "desktop", false, 600_000, "s1");
    ev("session.changed", { sessionId: "s1", status: "running" });
    ev("session.changed", { sessionId: "s1", status: "idle" });
    n.presence.report("win", "desktop", true, 1_000, "s1");
    tick(PRESENCE_TTL_MS + 1);
    ev("session.changed", { sessionId: "s1", status: "running" });
    ev("session.changed", { sessionId: "s1", status: "idle" });
    expect(published.slice(2).map((p) => [p.kind, p.sessionId])).toEqual([["turn.finished", "s1"], ["turn.finished", "s1"]]);
  });

  it("approval and dialog waiting, each dialog once", () => {
    const { ev, published } = setup({ s1: session() });
    ev("approval.requested", { sessionId: "s1", approvalId: "a1", tool: "shell" });
    const dialog = { id: "d1", title: "Save Content", message: "Save 3 assets?", asking: { since: 1 }, outcome: null, sessionId: "s1" };
    ev("dialog.changed", { now: 1, dialogs: [dialog] });
    ev("dialog.changed", { now: 2, dialogs: [dialog] });
    expect(published.map((p) => [p.kind, p.target])).toEqual([
      ["approval.waiting", { sessionId: "s1", approvalId: "a1" }],
      ["dialog.waiting", { sessionId: "s1", dialogId: "d1" }],
    ]);
  });

  it("a native Windows dialog is news as it opens, with no session and nobody asked, once", () => {
    const { ev, published } = setup({});
    const gpu = { id: "d9", title: "Error", message: "GPU Crashed", asking: null, outcome: null, sessionId: null, mode: "defer", native: { hwnd: "1", pid: 2, kind: "gpu-crash", summary: "lost" } };
    ev("dialog.changed", { now: 1, dialogs: [gpu] });
    ev("dialog.changed", { now: 2, dialogs: [gpu] });
    // A Slate dialog nobody put to Studio is not.
    ev("dialog.changed", { now: 3, dialogs: [{ ...gpu, id: "d10", native: undefined }] });
    expect(published.map((p) => [p.kind, p.title, p.text, p.target])).toEqual([
      ["dialog.waiting", "Error", "The editor lost its GPU device and exits when OK is pressed", { dialogId: "d9" }],
    ]);
  });

  it("playtests: a verdict needed, a loop that needs you, and a finished run", () => {
    const { ev, published } = setup({ s1: session() });
    const run = (state: string, steps: Array<{ index: number; status: string }>) => ({ runId: "r1", scriptName: "Door test", state, steps, sessionId: "s1", summary: { failed: steps.filter((s) => s.status === "failed").length } });
    ev("qa.changed", { runId: "r1", run: run("running", [{ index: 0, status: "running" }]) });
    ev("qa.changed", { runId: "r1", run: run("awaiting_verdict", [{ index: 0, status: "awaiting_verdict" }]) });
    ev("qa.attention", { sessionId: "s1", runId: "r1", title: "Playtest needs you", text: "The door never opened." });
    ev("qa.changed", { runId: "r1", run: run("finished", [{ index: 0, status: "failed" }]) });
    expect(published.map((p) => [p.kind, p.title, p.text, p.target.runId])).toEqual([
      ["playtest.needs-you", "Door test", "Step 1 needs your verdict", "r1"],
      ["playtest.needs-you", "Fix the door", "A playtest loop needs you", "r1"],
      ["playtest.finished", "Door test", "Failed, 1 step", "r1"],
    ]);
  });

  it("a subagent finishing notifies only when its event is on", () => {
    const sessions = { s1: session({ transcript: [{ kind: "tool", call: { id: "c1", name: "agent", input: { description: "Audit the level" }, outcome: "done" } } as never] }) };
    const { ev, published, p } = setup(sessions);
    ev("tool.finished", { sessionId: "s1", toolUseId: "c1", outcome: "done" });
    expect(published).toHaveLength(0);
    p.prefs = applyProjectNotify(DEFAULT_PROJECT_NOTIFY, { events: { "subagent.finished": true } });
    ev("tool.finished", { sessionId: "s1", toolUseId: "c1", outcome: "done" });
    expect(published[0]).toMatchObject({ kind: "subagent.finished", title: "Fix the door", text: "Subagent finished: Audit the level" });
  });

  it("context near the limit once per crossing, and a failed compaction once", () => {
    const s = session({ model: "m", context: { main: { input: 190_000, cached: 0, output: 0, model: "m", at: "x" } } });
    const { ev, published, p } = setup({ s1: s }, applyProjectNotify(DEFAULT_PROJECT_NOTIFY, { events: { "context.limit": true } }));
    ev("context.changed", { sessionId: "s1", agent: "main" });
    ev("context.changed", { sessionId: "s1", agent: "main" });
    s.transcript.push({ kind: "compaction", at: "t1", trigger: "auto", state: "failed", before: 190_000, error: "The summary request failed." } as never);
    ev("context.changed", { sessionId: "s1", agent: "main" });
    expect(published.map((x) => [x.title, x.text])).toEqual([["Fix the door", "Context 95% full"], ["Fix the door", "Compaction failed"]]);
    expect(p.prefs.events["context.limit"]).toBe(true);
  });

  it("names the subject in plain words: markdown links, code marks and emphasis dropped, names with underscores kept", async () => {
    const { plainLine } = await import("../src/notify.js");
    expect(plainLine("**Wire** [BP_Hero](https://x/y) `jump`")).toBe("Wire BP_Hero jump");
    expect(plainLine("## Fix M_Door_Wood")).toBe("Fix M_Door_Wood");
    expect(plainLine("x".repeat(80))).toHaveLength(60);
  });

  it("approval and dialog say the state plainly", () => {
    const { ev, published } = setup({ s1: session() });
    ev("approval.requested", { sessionId: "s1", approvalId: "a1", tool: "shell" });
    ev("dialog.changed", { now: 1, dialogs: [{ id: "d1", title: "Save Content", message: "Save 3 assets?", asking: { since: 1 }, outcome: null, sessionId: "s1" }] });
    expect(published.map((p) => [p.title, p.text])).toEqual([
      ["Fix the door", "Needs your approval"],
      ["Save Content", "An editor dialog needs your answer"],
    ]);
  });

  it("a muted session is dropped at the source", () => {
    const { ev, published } = setup({ s1: session() }, applyProjectNotify(DEFAULT_PROJECT_NOTIFY, { mute: ["s1"] }));
    ev("approval.requested", { sessionId: "s1", approvalId: "a1", tool: "shell" });
    expect(published).toHaveLength(0);
  });

  it("names the devices in use, and forgets one that stopped reporting", () => {
    const { n, ev, published, tick } = setup({ s1: session() });
    n.presence.report("win", "desktop", true);
    n.presence.report("tab", "browser", false);
    ev("approval.requested", { sessionId: "s1", approvalId: "a1", tool: "shell" });
    tick(PRESENCE_TTL_MS + 1);
    ev("approval.requested", { sessionId: "s1", approvalId: "a2", tool: "shell" });
    expect(published.map((p) => p.active)).toEqual([["desktop"], []]);
  });

  it("logs each device's state and input age with every notice sent", () => {
    const lines: string[] = [];
    let t = Date.parse("2026-11-04T12:00:00Z");
    const n = new Notifier({ project: "Vale", session: () => session(), prefs: () => DEFAULT_PROJECT_NOTIFY, publish: () => true, window: () => 200_000, now: () => t, log: (l) => lines.push(l) });
    n.presence.report("win", "desktop", false, 3_780_000);
    n.presence.report("ph", "phone", true, 5_000);
    t += 2_000;
    n.observe({ type: "studio.approval.requested", data: { sessionId: "s1", approvalId: "a1", tool: "shell" } });
    expect(lines.at(-1)).toContain("sent active=phone presence=[desktop idle input=63m02s, phone active input=7s]");
  });

  it("keeps the latest notices for a device opened from a push", () => {
    const { n, ev } = setup({ s1: session() });
    for (let i = 0; i < 25; i++) ev("approval.requested", { sessionId: "s1", approvalId: `a${i}`, tool: "shell" });
    expect(n.recent()).toHaveLength(20);
    expect(n.recent().at(-1)?.target.approvalId).toBe("a24");
  });
});

describe("NotifyPrefsStore", () => {
  it("keeps the project's settings on disk", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-"));
    const store = new NotifyPrefsStore(dir);
    expect(store.get().events["turn.finished"]).toBe(true);
    store.update({ events: { "turn.finished": false }, mute: ["s9"] });
    const again = new NotifyPrefsStore(dir).get();
    expect(again.events["turn.finished"]).toBe(false);
    expect(again.mutedSessions).toEqual(["s9"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("the notification routes", () => {
  function api() {
    const routes = new Map<string, (req: { body?: unknown }) => { status?: number; body?: unknown }>();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-routes-"));
    const fake = {
      dataDir,
      events: { publish: () => ({}), subscribe: () => () => undefined },
      log: { info: () => undefined, warn: () => undefined },
      route: (method: string, p: string, h: (req: { body?: unknown }) => { status?: number; body?: unknown }) => void routes.set(`${method} ${p}`, h),
    };
    const { notifier } = registerNotifications(fake as never, { project: "Vale", session: () => undefined, window: () => 200_000 });
    const call = (key: string, body?: unknown) => routes.get(key)!({ body });
    return { call, notifier, dataDir };
  }

  it("takes a device's input age with its presence, and refuses a bad one", () => {
    const { call, notifier } = api();
    expect(call("POST /notifications/presence", { id: "win", device: "desktop", active: false, inputAgeMs: 3_600_000 }).status).toBe(204);
    expect(notifier.presence.describe()).toBe("desktop idle input=60m00s");
    expect(call("POST /notifications/presence", { id: "ph", device: "phone", active: true, inputAgeMs: -5 }).status).toBe(204);
    expect(notifier.presence.describe()).toContain("phone active input=unknown");
    expect(notifier.presence.active()).toEqual(["phone"]);
    expect(call("POST /notifications/presence", { id: "x", device: "tv", active: true }).status).toBe(400);
  });

  it("keeps the computer's own device settings across restarts", () => {
    const { call, dataDir } = api();
    expect(call("GET /notifications/desktop").body).toEqual({ prefs: null });
    expect(call("PUT /notifications/desktop", { onlyWhenAway: false }).status).toBe(204);
    expect((call("GET /notifications/desktop").body as { prefs: { onlyWhenAway: boolean } }).prefs.onlyWhenAway).toBe(false);
    expect(fs.existsSync(path.join(dataDir, "notify-desktop.json"))).toBe(true);
    expect(call("PUT /notifications/desktop", [1]).status).toBe(400);
  });
});

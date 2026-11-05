import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_NOTIFY, applyProjectNotify, type Notice, type ProjectNotifyPrefs } from "@ue-mcp-studio/shared";
import { Notifier, NotifyPrefsStore, PRESENCE_TTL_MS, type NotifySession } from "../src/notify.js";

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
  it("a turn that ends idle is turn.finished, with the last reply and the session as its target", () => {
    const { ev, published } = setup({ s1: session({ transcript: [{ kind: "assistant", text: "The door opens now.", at: "x" }] }) });
    ev("session.changed", { sessionId: "s1", status: "running" });
    ev("session.changed", { sessionId: "s1", status: "idle" });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ kind: "turn.finished", project: "Vale", sessionId: "s1", sessionTitle: "Fix the door", title: "Done: Fix the door", text: "The door opens now.", target: { sessionId: "s1" } });
  });

  it("an idle session that was never running does not notify", () => {
    const { ev, published } = setup({ s1: session() });
    ev("session.changed", { sessionId: "s1", status: "idle" });
    expect(published).toHaveLength(0);
  });

  it("error and stopped are turn.failed", () => {
    const { ev, published } = setup({ s1: session({ error: "rate limited" }) });
    ev("session.changed", { sessionId: "s1", status: "running" });
    ev("session.changed", { sessionId: "s1", status: "error" });
    ev("session.changed", { sessionId: "s1", status: "waiting" });
    ev("session.changed", { sessionId: "s1", status: "stopped" });
    expect(published.map((p) => [p.kind, p.title])).toEqual([["turn.failed", "Failed: Fix the door"], ["turn.failed", "Stopped: Fix the door"]]);
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

  it("playtests: a verdict needed, a loop that needs you, and a finished run", () => {
    const { ev, published } = setup({ s1: session() });
    const run = (state: string, steps: Array<{ index: number; status: string }>) => ({ runId: "r1", scriptName: "Door test", state, steps, sessionId: "s1", summary: { failed: steps.filter((s) => s.status === "failed").length } });
    ev("qa.changed", { runId: "r1", run: run("running", [{ index: 0, status: "running" }]) });
    ev("qa.changed", { runId: "r1", run: run("awaiting_verdict", [{ index: 0, status: "awaiting_verdict" }]) });
    ev("qa.attention", { sessionId: "s1", runId: "r1", title: "Playtest needs you", text: "The door never opened." });
    ev("qa.changed", { runId: "r1", run: run("finished", [{ index: 0, status: "failed" }]) });
    expect(published.map((p) => [p.kind, p.title, p.target.runId])).toEqual([
      ["playtest.needs-you", "Verdict needed", "r1"],
      ["playtest.needs-you", "Playtest needs you", "r1"],
      ["playtest.finished", "Playtest failed", "r1"],
    ]);
  });

  it("a subagent finishing notifies only when its event is on", () => {
    const sessions = { s1: session({ transcript: [{ kind: "tool", call: { id: "c1", name: "agent", input: { description: "Audit the level" }, outcome: "done" } } as never] }) };
    const { ev, published, p } = setup(sessions);
    ev("tool.finished", { sessionId: "s1", toolUseId: "c1", outcome: "done" });
    expect(published).toHaveLength(0);
    p.prefs = applyProjectNotify(DEFAULT_PROJECT_NOTIFY, { events: { "subagent.finished": true } });
    ev("tool.finished", { sessionId: "s1", toolUseId: "c1", outcome: "done" });
    expect(published[0]).toMatchObject({ kind: "subagent.finished", text: "Audit the level finished." });
  });

  it("context near the limit once per crossing, and a failed compaction once", () => {
    const s = session({ model: "m", context: { main: { input: 190_000, cached: 0, output: 0, model: "m", at: "x" } } });
    const { ev, published, p } = setup({ s1: s }, applyProjectNotify(DEFAULT_PROJECT_NOTIFY, { events: { "context.limit": true } }));
    ev("context.changed", { sessionId: "s1", agent: "main" });
    ev("context.changed", { sessionId: "s1", agent: "main" });
    s.transcript.push({ kind: "compaction", at: "t1", trigger: "auto", state: "failed", before: 190_000, error: "The summary request failed." } as never);
    ev("context.changed", { sessionId: "s1", agent: "main" });
    expect(published.map((x) => x.title)).toEqual(["Context near the limit", "Compaction failed"]);
    expect(p.prefs.events["context.limit"]).toBe(true);
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

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionResult } from "ue-mcp/daemon";
import { BusyTracker } from "../src/busy.js";
import type { AgentHost } from "../src/tools.js";

const ok: ActionResult = { isError: false, content: [{ type: "text", text: "{}" }] };

/** A host whose editor calls finish only when the test says so. */
function slowHost() {
  const waiting: Array<() => void> = [];
  const host: AgentHost = {
    projectDir: "C:/Game",
    dataDir: "C:/data",
    callAction: (category) => (category === "project" ? Promise.resolve(ok) : new Promise((resolve) => waiting.push(() => resolve(ok)))),
    editors: () => [],
    editorOperation: async () => ({}),
    events: { publish: () => undefined, subscribe: () => () => {} },
    setBusy: () => {},
    log: { info: () => {}, warn: () => {} },
  };
  return { host, release: () => waiting.shift()?.() };
}

describe("the editor's busy state", () => {
  it("lists a turn's editor call while it runs, with when it started", async () => {
    let clock = 1000;
    const published: unknown[] = [];
    const busy = new BusyTracker((type, data) => published.push({ type, data }), () => clock);
    const { host, release } = slowHost();
    const call = busy.wrap(host, "s1").callAction("pcg", "generate", {});
    clock = 1500;
    expect(busy.state()).toEqual({ now: 1500, calls: [{ id: 1, category: "pcg", action: "generate", source: "studio", sessionId: "s1", startedAt: 1000, stopped: false }] });
    release();
    await call;
    expect(busy.state().calls).toEqual([]);
    expect(published.map((p) => (p as { type: string }).type)).toEqual(["busy.changed", "busy.changed"]);
  });

  it("leaves out the lookups the daemon answers itself", async () => {
    const busy = new BusyTracker();
    const { host } = slowHost();
    await busy.wrap(host, "s1").callAction("project", "search_tools", { query: "x" });
    expect(busy.state().calls).toEqual([]);
  });

  it("clears a call that failed", async () => {
    const busy = new BusyTracker();
    const { host } = slowHost();
    const failing: AgentHost = { ...host, callAction: () => Promise.reject(new Error("editor went away")) };
    await expect(busy.wrap(failing, "s1").callAction("level", "spawn_actor")).rejects.toThrow("editor went away");
    expect(busy.state().calls).toEqual([]);
  });

  it("follows other MCP clients' calls from the daemon's events", () => {
    const busy = new BusyTracker(undefined, () => 5);
    busy.observe({ type: "call.started", data: { client: "claude-code", category: "editor", action: "execute_python" } });
    busy.observe({ type: "call.started", data: { client: "claude-code", category: "project", action: "describe_action" } });
    expect(busy.state().calls).toMatchObject([{ category: "editor", action: "execute_python", source: "client", client: "claude-code" }]);
    busy.observe({ type: "call.finished", data: { client: "cursor", category: "editor", action: "execute_python" } });
    expect(busy.state().calls).toHaveLength(1);
    busy.observe({ type: "call.finished", data: { client: "claude-code", category: "editor", action: "execute_python", ok: true } });
    expect(busy.state().calls).toEqual([]);
  });

  it("forgets every call when the daemon stops", () => {
    const busy = new BusyTracker();
    busy.observe({ type: "call.started", data: { client: "c", category: "editor", action: "x" } });
    busy.observe({ type: "daemon.stopping", data: {} });
    expect(busy.state().calls).toEqual([]);
  });

  it("stops the turns waiting on the editor, once each, and keeps the call until the editor returns", async () => {
    const busy = new BusyTracker();
    const { host, release } = slowHost();
    const a = busy.wrap(host, "s1").callAction("editor", "execute_python");
    const b = busy.wrap(host, "s1").callAction("editor", "execute_python");
    busy.observe({ type: "call.started", data: { client: "c", category: "pcg", action: "generate" } });
    const stopped: string[] = [];
    expect(busy.stop((id) => stopped.push(id))).toEqual(["s1"]);
    expect(stopped).toEqual(["s1"]);
    expect(busy.state().calls.filter((c) => c.source === "studio").every((c) => c.stopped)).toBe(true);
    expect(busy.stop((id) => stopped.push(id))).toEqual([]);
    release();
    release();
    await Promise.all([a, b]);
    expect(busy.state().calls.map((c) => c.source)).toEqual(["client"]);
  });
});

describe("an editor operation", () => {
  const op = (o: string, step: string, phase: string) => ({ type: "editor.operation", data: { op: o, step, phase } });

  it("shows a rebuild step by step, then waits for the editor to attach", () => {
    let clock = 0;
    let connected = false;
    const busy = new BusyTracker(() => {}, () => clock, () => connected);
    busy.observe(op("rebuild", "editor.stop_editor", "started"));
    expect(busy.state().operation).toEqual({ op: "rebuild", step: "editor.stop_editor", startedAt: 0, stepStartedAt: 0 });
    clock = 4000;
    busy.observe(op("rebuild", "editor.stop_editor", "done"));
    busy.observe(op("rebuild", "project.build", "started"));
    expect(busy.state().operation).toEqual({ op: "rebuild", step: "project.build", startedAt: 0, stepStartedAt: 4000 });
    clock = 60_000;
    busy.observe(op("rebuild", "project.build", "done"));
    busy.observe(op("rebuild", "editor.start_editor", "started"));
    clock = 90_000;
    busy.observe(op("rebuild", "editor.start_editor", "done"));
    expect(busy.state().operation).toMatchObject({ step: "connect", startedAt: 0, stepStartedAt: 90_000 });
    connected = true;
    busy.observe({ type: "editor.connected", data: {} });
    expect(busy.state().operation).toBeUndefined();
  });

  it("ends on a failed step, and a stop ends when the editor is down", () => {
    const busy = new BusyTracker();
    busy.observe(op("rebuild", "project.build", "started"));
    busy.observe(op("rebuild", "project.build", "failed"));
    expect(busy.state().operation).toBeUndefined();
    busy.observe(op("stop", "editor.stop_editor", "started"));
    busy.observe(op("stop", "editor.stop_editor", "done"));
    expect(busy.state().operation).toBeUndefined();
  });

  it("keeps why a step failed until the next operation starts", () => {
    const busy = new BusyTracker(() => {}, () => 7);
    busy.observe(op("rebuild", "project.build", "started"));
    busy.observe({ type: "editor.operation", data: { op: "rebuild", step: "project.build", phase: "failed", reason: "Build failed: Foo.cpp(169): error C4458" } });
    expect(busy.state().operation).toBeUndefined();
    expect(busy.state().failure).toEqual({ op: "rebuild", step: "project.build", reason: "Build failed: Foo.cpp(169): error C4458", at: 7 });
    busy.observe(op("start", "editor.start_editor", "started"));
    expect(busy.state().failure).toBeUndefined();
  });

  it("clears a failure when the editor connects", () => {
    const busy = new BusyTracker();
    busy.observe(op("start", "editor.start_editor", "failed"));
    expect(busy.state().failure).toMatchObject({ op: "start", reason: "editor.start_editor failed." });
    busy.observe({ type: "editor.connected", data: {} });
    expect(busy.state().failure).toBeUndefined();
  });
});

describe("waiting for a started editor to attach (#1384)", () => {
  const op = (o: string, step: string, phase: string) => ({ type: "editor.operation", data: { op: o, step, phase } });
  afterEach(() => vi.useRealTimers());

  it("is bounded: past the limit the operation ends and says the editor never connected", () => {
    vi.useFakeTimers();
    const published: Array<{ type: string; data: Record<string, unknown> }> = [];
    const busy = new BusyTracker((type, data) => published.push({ type, data }), Date.now, () => false, 90_000);
    busy.observe(op("rebuild", "editor.start_editor", "started"));
    busy.observe(op("rebuild", "editor.start_editor", "done"));
    expect(busy.state().operation).toMatchObject({ step: "connect" });
    vi.advanceTimersByTime(89_000);
    expect(busy.state().operation).toMatchObject({ step: "connect" });
    vi.advanceTimersByTime(2000);
    expect(busy.state().operation).toBeUndefined();
    expect(busy.state().failure).toMatchObject({ op: "rebuild", step: "connect", reason: expect.stringMatching(/did not connect within 90 seconds/) });
    expect(published.at(-1)?.data.failure).toBeDefined();
  });

  it("ends on Stop, while a step the daemon is still running stays", () => {
    const busy = new BusyTracker();
    busy.observe(op("rebuild", "project.build", "started"));
    busy.stop(() => {});
    expect(busy.state().operation).toMatchObject({ step: "project.build" });
    busy.observe(op("rebuild", "project.build", "done"));
    busy.observe(op("rebuild", "editor.start_editor", "started"));
    busy.observe(op("rebuild", "editor.start_editor", "done"));
    expect(busy.state().operation).toMatchObject({ step: "connect" });
    busy.stop(() => {});
    expect(busy.state().operation).toBeUndefined();
  });

  it("ends with the reason when an older daemon reported a failed launch as done", async () => {
    const busy = new BusyTracker();
    const { host } = slowHost();
    const launch = JSON.stringify({ success: false, message: "Editor launched but did not become ready: still not ready after 300s." }, null, 2);
    const older: AgentHost = {
      ...host,
      editorOperation: async (o) => {
        busy.observe(op(o, "editor.start_editor", "started"));
        busy.observe(op(o, "editor.start_editor", "done"));
        return { op: o, steps: [{ step: "editor.start_editor", ok: true, result: `${launch}
served by editor P` }] };
      },
    };
    await busy.wrap(older, "s1").editorOperation("start");
    expect(busy.state().operation).toBeUndefined();
    expect(busy.state().failure).toEqual({ op: "start", step: "editor.start_editor", reason: "Editor launched but did not become ready: still not ready after 300s.", at: expect.any(Number) });
  });
});

import { describe, expect, it } from "vitest";
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

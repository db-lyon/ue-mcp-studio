/**
 * What Studio hands the daemon's hub: only where the daemon offers the hub,
 * and Studio's own settings, account and fix loop as the hub's pieces.
 */
import { describe, expect, it, vi } from "vitest";
import type { DaemonExtensionApi, HubClientOptions } from "ue-mcp/daemon";
import { configureHub, type HubBridgeOptions } from "../src/hub-bridge.js";

function setup(features: string[], hub = true) {
  let given: HubClientOptions | null = null;
  const off = vi.fn();
  const api = {
    features,
    ...(hub ? { hub: { configure: (o: HubClientOptions) => ((given = o), off) } } : {}),
    events: { publish: vi.fn() },
    callAction: vi.fn(),
  } as unknown as DaemonExtensionApi;
  const run = { runId: "r1", script: "/Game/T/Door", assignment: { state: "running", sessionId: "s1" } };
  const qa = {
    all: () => [run],
    cancel: vi.fn(() => ({ run })),
    onSaved: vi.fn(() => () => {}),
  };
  const o = {
    api,
    qa,
    store: { create: vi.fn(() => ({ id: "s9", status: "idle" })), get: vi.fn(), save: vi.fn() },
    writePlaytests: vi.fn(async () => {}),
    playtestRuns: () => "manual" as const,
    agentFixes: () => true,
    signer: () => "dev",
    enabled: () => true,
    inputAgeMs: () => 5,
    busy: () => ({
      now: 0,
      calls: [
        { id: 1, category: "asset", action: "list", startedAt: 0, source: "studio", sessionId: "s1", stopped: false },
        { id: 2, category: "level", action: "save", startedAt: 0, source: "client", client: "cli", stopped: false },
      ],
    }),
  } as unknown as HubBridgeOptions;
  return { given: () => given, off, qa, o };
}

describe("configureHub", () => {
  it("hands the daemon's hub Studio's pieces, and gives them back", async () => {
    const t = setup(["hub"]);
    const back = configureHub(t.o);
    const c = t.given()!;
    expect(c.signer?.()).toBe("dev");
    expect(c.enabled?.()).toBe(true);
    expect(c.playtestRuns?.()).toBe("manual");
    expect(c.inputAgeMs?.()).toBe(5);
    // Only Studio's own agents' calls: the daemon already sees other MCP clients'.
    expect(c.agentCalls?.()).toEqual([{ id: 1, category: "asset", action: "list", startedAt: 0, source: "agent", sessionId: "s1", stopped: false }]);
    expect(c.broker && c.fixer && c.writePlaytests && c.replay).toBeTruthy();
    back();
    expect(t.off).toHaveBeenCalled();
  });

  it("does nothing where the daemon has no hub", () => {
    const t = setup(["flows.stepApproval"]);
    configureHub(t.o)();
    expect(t.given()).toBeNull();
    const none = setup(["hub"], false);
    configureHub(none.o)();
    expect(none.given()).toBeNull();
  });

  it("runs the /playtest flow in a session of its own for a goal", async () => {
    const t = setup(["hub"]);
    configureHub(t.o);
    const w = t.given()!.writePlaytests!({ title: "Playtests for Tutorial", text: "write one" });
    expect(w.sessionId).toBe("s9");
    await w.done;
    expect((t.o as unknown as { writePlaytests: ReturnType<typeof vi.fn> }).writePlaytests).toHaveBeenCalledWith("s9", "write one");
  });

  it("names the scripts whose fix loops run, and stops one by its item", () => {
    const t = setup(["hub"]);
    configureHub(t.o);
    const fixer = t.given()!.fixer!;
    expect([...fixer.running()]).toEqual(["/Game/T/Door"]);
    const item = { check: { kind: "script", target: "/Game/T/Door" }, name: "Door", sessionId: "s1" } as never;
    expect(fixer.stop(item)).toBeNull();
    expect(t.qa.cancel).toHaveBeenCalledWith("r1");
  });
});

/**
 * Which session the hub's work lands in. A fake store and broker: sessions by
 * id, and cards that move to the session drafting them, as QaBroker's do.
 */
function world(agentFixes = true) {
  const sessions = new Map<string, { id: string; title: string; status: string; waitingCause: null; archived?: boolean; hubKey?: string }>();
  let n = 0;
  const store = {
    create: vi.fn((title: string) => {
      const s = { id: `new${++n}`, title, status: "idle", waitingCause: null };
      sessions.set(s.id, s);
      return s;
    }),
    get: (id: string) => sessions.get(id),
    save: vi.fn((s: { id: string }) => void sessions.set(s.id, s as never)),
  };
  const runs: Array<{ runId: string; script: string; sessionId: string | null; seenAt: string; deleted?: boolean; assignment?: unknown }> = [];
  const card = (runId: string, script: string, sessionId: string, seenAt: string) => {
    const at = runs.findIndex((r) => r.runId === runId);
    const r = { runId, script, sessionId, seenAt };
    if (at >= 0) runs[at] = r;
    else runs.push(r);
    return r;
  };
  const qa = {
    all: () => runs,
    drafted: vi.fn(async (sid: string, body: { path: string }) => card(`draft:${body.path}`, body.path, sid, "2026-11-24T12:00:00Z")),
    assign: vi.fn(async (runId: string) => ({ run: runs.find((r) => r.runId === runId)! })),
    runScript: vi.fn(async (runId: string) => ({ run: runs.find((r) => r.runId === runId)! })),
    wrap: vi.fn(() => ({ callAction: vi.fn(async () => ({ content: [{ type: "text", text: "{}" }] })) })),
    onSaved: vi.fn(() => () => {}),
    cancel: vi.fn(),
  };
  // The hub's clients as HubHolder keeps them: the newest configure's options, until taken back.
  const clients = new Set<HubClientOptions>();
  const given = () => [...clients].pop() ?? null;
  const api = {
    features: ["hub"],
    hub: { configure: (o: HubClientOptions) => (clients.add(o), () => void clients.delete(o)) },
    events: { publish: vi.fn() },
    callAction: vi.fn(async (_c: string, _a: string, args: { path: string }) => ({ content: [{ type: "text", text: JSON.stringify({ path: args.path, steps: [{ do: "open" }] }) }] })),
  } as unknown as DaemonExtensionApi;
  let fixes = agentFixes;
  const listeners = new Set<(on: boolean) => void>();
  const setFixes = (on: boolean) => {
    fixes = on;
    for (const l of listeners) l(on);
  };
  const o = {
    api, qa, store, writePlaytests: vi.fn(async () => {}), playtestRuns: () => "automatic", signer: () => null, enabled: () => true, inputAgeMs: () => null, busy: () => ({ now: 0, calls: [] }),
    agentFixes: () => fixes,
    onAgentFixes: (l: (on: boolean) => void) => (listeners.add(l), () => void listeners.delete(l)),
  } as unknown as HubBridgeOptions;
  const off = configureHub(o);
  const user = (id: string, archived = false) => sessions.set(id, { id, title: "Mine", status: "idle", waitingCause: null, ...(archived ? { archived } : {}) });
  return { sessions, runs, card, qa, store, user, hub: () => given()!, clients, setFixes, off };
}

const DOOR = "/Game/T/Door";
const plan = (id: string) => ({ id, title: "Fix Door", work: "fix", items: [] }) as never;
const doorItem = (sessionId?: string) => ({ check: { kind: "script", target: DOOR }, name: "Door", state: "queued", ...(sessionId ? { sessionId } : {}) }) as never;

describe("the sessions the hub works in", () => {
  it("fixes in a new session when an archived session holds the newest card of the playtest", async () => {
    const w = world();
    w.user("old", true);
    w.card("run-old", DOOR, "old", "2026-11-24T11:00:00Z");
    const r = await w.hub().fixer!.start(doorItem(), plan("p1"));
    expect(r).toEqual({ runId: "draft:/Game/T/Door", sessionId: "new1" });
    expect(w.sessions.get("new1")).toMatchObject({ title: "Fix Door", hubKey: `fix:p1:${DOOR}` });
    expect(w.qa.assign).toHaveBeenCalledWith("draft:/Game/T/Door", {});
    expect(w.sessions.get("old")!.archived).toBe(true);
  });

  it("fixes in a new session when a session the user made holds the newest card", async () => {
    const w = world();
    w.user("mine");
    w.card("run-mine", DOOR, "mine", "2026-11-24T11:00:00Z");
    // Even an item that names the user's session, as a plan from before this fix recorded, does not go back there.
    const r = await w.hub().fixer!.start(doorItem("mine"), plan("p1"));
    expect(r).toMatchObject({ sessionId: "new1" });
    expect(w.qa.assign).not.toHaveBeenCalledWith("run-mine", expect.anything());
  });

  it("goes back to the item's own session when a release puts it back in the same plan", async () => {
    const w = world();
    const first = await w.hub().fixer!.start(doorItem(), plan("p1"));
    expect(first).toMatchObject({ sessionId: "new1" });
    const again = await w.hub().fixer!.start(doorItem("new1"), plan("p1"));
    expect(again).toMatchObject({ sessionId: "new1" });
    expect(w.store.create).toHaveBeenCalledTimes(1);
  });

  it("starts a new session for a released item whose session was archived, or for the same item in a later plan", async () => {
    const w = world();
    await w.hub().fixer!.start(doorItem(), plan("p1"));
    w.sessions.get("new1")!.archived = true;
    expect(await w.hub().fixer!.start(doorItem("new1"), plan("p1"))).toMatchObject({ sessionId: "new2" });
    expect(await w.hub().fixer!.start(doorItem("new2"), plan("p2"))).toMatchObject({ sessionId: "new3" });
  });

  it("runs a plan's playtests in the plan's own session, never a user's or an archived one", async () => {
    const w = world();
    w.user("mine");
    w.user("old", true);
    w.card("run-mine", DOOR, "mine", "2026-11-24T10:00:00Z");
    w.card("run-old", DOOR, "old", "2026-11-24T11:00:00Z");
    const r = await w.hub().broker!.startScript(DOOR, { planRunId: "plan-1", title: "Run Door" });
    expect(r).toMatchObject({ run: { sessionId: "new1" } });
    expect(w.sessions.get("new1")!.hubKey).toBe("plan:plan-1");
    await w.hub().broker!.startScript("/Game/T/Lift", { planRunId: "plan-1", title: "Run Door" });
    expect(w.store.create).toHaveBeenCalledTimes(1);
  });

  it("replays through the hub's own replay session", async () => {
    const w = world();
    w.user("old", true);
    w.card("run-old", DOOR, "old", "2026-11-24T11:00:00Z");
    await w.hub().replay!(DOOR, { path: DOOR });
    expect(w.qa.wrap).toHaveBeenCalledWith(expect.anything(), "new1", { assigned: true });
    expect(w.sessions.get("new1")!.hubKey).toBe(`replay:${DOOR}`);
  });
});

describe("Fix failing playtests with an agent", () => {
  it("gives the hub no fixer while it is off, so a fix request answers 409", () => {
    const w = world(false);
    expect(w.hub().fixer).toBeUndefined();
    expect(w.hub().broker).toBeTruthy();
  });

  it("gives the fixer when it is turned on, and takes it back when it is turned off", async () => {
    const w = world(false);
    w.setFixes(true);
    expect(w.clients.size).toBe(1);
    expect(await w.hub().fixer!.start(doorItem(), plan("p1"))).toMatchObject({ sessionId: "new1" });
    w.setFixes(false);
    expect(w.clients.size).toBe(1);
    expect(w.hub().fixer).toBeUndefined();
    w.off();
    expect(w.clients.size).toBe(0);
  });

  it("stops the fix loops the hub started when it is turned off, and leaves the user's own", async () => {
    const w = world(true);
    w.user("mine");
    await w.hub().fixer!.start(doorItem(), plan("p1"));
    w.runs[0].assignment = { state: "running", sessionId: "new1" };
    w.runs.push({ runId: "run-mine", script: "/Game/T/Lift", sessionId: "mine", seenAt: "", assignment: { state: "running", sessionId: "mine" } });
    w.setFixes(false);
    expect(w.qa.cancel).toHaveBeenCalledTimes(1);
    expect(w.qa.cancel).toHaveBeenCalledWith("draft:/Game/T/Door");
  });
});

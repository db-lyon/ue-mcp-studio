import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtensionHandler, ExtensionRequest } from "ue-mcp/daemon";
import type { QuickThread, SessionDetail, ToolCallRecord, TranscriptEntry } from "@ue-mcp-studio/shared";
import { formatQuickMessage, mapOf, NO_MODEL, parseQuickRequest, QUICK_STEPS, quickThread, quickTitle, registerQuickRoute, stepLabel, windowLocationFile } from "../src/quick.js";

function setup(connected = true) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-quick-"));
  const table = new Map<string, ExtensionHandler>();
  const created: string[] = [];
  const sent: Array<{ id: string; text: string }> = [];
  const events: Array<{ type: string; data: unknown }> = [];
  const listeners: Array<(e: { type: string; data: unknown }) => void> = [];
  const sessions = new Map<string, SessionDetail>();
  registerQuickRoute(
    {
      projectDir,
      route: (method, p, handler) => void table.set(`${method} ${p}`, handler),
      events: {
        publish: (type: string, data: unknown) => void events.push({ type, data }),
        subscribe: (l: (e: { type: string; data: unknown }) => void) => (listeners.push(l), () => {}),
      } as never,
      log: { info: () => {}, warn: () => {}, error: () => {} } as never,
    },
    {
      connected: () => connected,
      create: (title) => (created.push(title), { id: `s${created.length}` }),
      send: async (id, text) => void sent.push({ id, text }),
      detail: (id) => sessions.get(id),
    },
  );
  const call = async (method: string, route: string, params: Record<string, string>, body?: unknown) => {
    const req: ExtensionRequest = { method, path: route, params, query: {}, headers: {}, body } as ExtensionRequest;
    return (await table.get(`${method} ${route}`)!(req))!;
  };
  const post = (body: unknown) => call("POST", "/quick", {}, body);
  const emit = (type: string, data: unknown) => listeners.forEach((l) => l({ type, data }));
  return { projectDir, created, sent, events, post, call, emit, sessions };
}

function session(over: Partial<SessionDetail> = {}): SessionDetail {
  return {
    id: "s1", title: "t", status: "running", createdAt: "", updatedAt: "", waitingCause: null, archived: false,
    agents: { total: 0, running: 0 }, awaiting: 0, transcript: [], touched: [], draft: "", seen: [], error: null, approvals: [], ...over,
  };
}

const tool = (id: string, category: string, method: string, outcome: ToolCallRecord["outcome"], parent?: string): TranscriptEntry => ({
  kind: "tool", call: { id, name: "ue_mcp", input: { action: "call", category, method }, outcome, startedAt: "" }, ...(parent ? { parent } : {}),
});

describe("the pill's thread", () => {
  it("lists the main thread's steps by action with their state, newest last, and counts the ones left out", () => {
    const steps = Array.from({ length: QUICK_STEPS + 2 }, (_, i) => tool(`t${i}`, "level", `step_${i}`, "done"));
    const t = quickThread(session({ transcript: [{ kind: "user", text: "go", at: "" }, ...steps, tool("x", "level", "place_actor", "pending"), tool("sub", "asset", "list", "done", "agent1")] }));
    expect(t.steps).toHaveLength(QUICK_STEPS);
    expect(t.steps[t.steps.length - 1]).toEqual({ label: "level.place_actor", state: "running" });
    expect(t.earlier).toBe(3);
    expect(t.steps.some((s) => s.label === "asset.list")).toBe(false);
  });

  it("shows the reply as it streams, then the finished message", () => {
    const s = setup();
    s.sessions.set("s1", session({ transcript: [{ kind: "assistant", text: "Earlier answer.", at: "" }] }));
    s.emit("studio.turn.delta", { sessionId: "s1", text: "Placing " });
    s.emit("studio.turn.delta", { sessionId: "s1", text: "the chest" });
    return s.call("GET", "/quick/:id", { id: "s1" }).then(async (r) => {
      expect((r.body as QuickThread).reply).toBe("Placing the chest");
      s.emit("studio.transcript.added", { sessionId: "s1" });
      expect(((await s.call("GET", "/quick/:id", { id: "s1" })).body as QuickThread).reply).toBe("Earlier answer.");
    });
  });

  it("says what waits on the user, which only the panel can answer", () => {
    const approval = { id: "a", tool: "shell", summary: "", input: {} } as unknown as SessionDetail["approvals"][number];
    expect(quickThread(session({ approvals: [approval] })).needsYou).toMatch(/approval/);
    expect(quickThread(session({ status: "waiting", waitingCause: "the editor was closed" })).needsYou).toBe("the editor was closed");
    expect(quickThread(session({ status: "idle" })).needsYou).toBeNull();
    expect(quickThread(session({ status: "error", error: "boom" })).error).toBe("boom");
  });

  it("continues in the panel: the window's location and the focus event name the session", async () => {
    const s = setup();
    s.sessions.set("s1", session());
    expect((await s.call("POST", "/quick/:id/continue", { id: "s1" })).status).toBe(204);
    expect(fs.readFileSync(windowLocationFile(s.projectDir), "utf-8").trim()).toBe("#/chat/s1");
    expect(s.events).toContainEqual({ type: "session.focus", data: { sessionId: "s1" } });
    expect((await s.call("POST", "/quick/:id/continue", { id: "nope" })).status).toBe(404);
    expect((await s.call("GET", "/quick/:id", { id: "nope" })).status).toBe(404);
  });

  it("labels a shell step as shell", () => {
    expect(stepLabel({ name: "Bash", input: { command: "ls" } })).toBe("shell");
  });
});

describe("formatQuickMessage", () => {
  it("puts each map's actors and the assets ahead of the text, with their object paths", () => {
    const text = formatQuickMessage({
      text: "  why is this dark?  ",
      context: [
        { kind: "actor", label: "Terrain", class: "Landscape", path: "/Game/Maps/L_Meadow.L_Meadow:PersistentLevel.Terrain" },
        { kind: "actor", label: "Sun", class: "DirectionalLight", path: "/Game/Maps/L_Meadow.L_Meadow:PersistentLevel.Sun" },
        { kind: "asset", label: "M_Grass", class: "Material", path: "/Game/Materials/M_Grass.M_Grass" },
      ],
    });
    expect(text).toBe(
      "Context: actors in /Game/Maps/L_Meadow: Terrain (Landscape) at /Game/Maps/L_Meadow.L_Meadow:PersistentLevel.Terrain; Sun (DirectionalLight) at /Game/Maps/L_Meadow.L_Meadow:PersistentLevel.Sun\n" +
        "Context: asset: M_Grass (Material) at /Game/Materials/M_Grass.M_Grass\n\nwhy is this dark?",
    );
  });

  it("gives the point under the cursor first, as what \"here\" means", async () => {
    const at = "X=1200.0 Y=-340.5 Z=88.0, surface normal X=0.00 Y=0.00 Z=1.00";
    const parsed = parseQuickRequest({ text: "put a BP_Chest here", context: [
      { kind: "location", label: "", class: "/Game/Maps/L_Meadow", path: at },
      { kind: "actor", label: "Sun", class: "DirectionalLight", path: "/Game/Maps/L_Meadow.L_Meadow:PersistentLevel.Sun" },
    ] });
    expect(typeof parsed).not.toBe("string");
    expect(formatQuickMessage(parsed as never)).toBe(
      `Context: the point under the cursor in /Game/Maps/L_Meadow: ${at}. "Here" means this point.\n` +
        "Context: actor in /Game/Maps/L_Meadow: Sun (DirectionalLight) at /Game/Maps/L_Meadow.L_Meadow:PersistentLevel.Sun\n\nput a BP_Chest here",
    );
    expect(formatQuickMessage({ text: "here", context: [{ kind: "location", label: "Terrain", class: "/Game/Maps/L", path: at }] })).toContain(", on Terrain: ");
    expect(parseQuickRequest({ text: "x", context: [{ kind: "elsewhere", path: "p" }] })).toMatch(/one of actor, asset, location, graph, node/);
  });

  it("names the graph with the cursor's position in it, the node under the cursor, and the selected ones apart", () => {
    const parsed = parseQuickRequest({ text: "add a delay after this", context: [
      { kind: "graph", label: "EventGraph", class: "/Game/BP_Chest", path: "/Game/BP_Chest.BP_Chest:EventGraph", at: "X=420 Y=-96" },
      { kind: "node", label: "Print String", class: "K2Node_CallFunction", path: "/Game/BP_Chest.BP_Chest:EventGraph.K2Node_CallFunction_3", at: "under the cursor" },
      { kind: "node", label: "Event BeginPlay", class: "K2Node_Event", path: "/Game/BP_Chest.BP_Chest:EventGraph.K2Node_Event_0", at: "selected" },
    ] });
    expect(formatQuickMessage(parsed as never)).toBe(
      'Context: the graph EventGraph in /Game/BP_Chest (/Game/BP_Chest.BP_Chest:EventGraph), cursor at graph position X=420 Y=-96; "here" in the graph means that position.\n' +
        "Context: node under the cursor: Print String (K2Node_CallFunction) at /Game/BP_Chest.BP_Chest:EventGraph.K2Node_CallFunction_3\n" +
        "Context: selected node: Event BeginPlay (K2Node_Event) at /Game/BP_Chest.BP_Chest:EventGraph.K2Node_Event_0\n\nadd a delay after this",
    );
    // Nothing under the cursor: a selected node is not called the one under it.
    expect(formatQuickMessage({ text: "x", context: [{ kind: "node", label: "Root", class: "MaterialGraphNode_Root", path: "p", at: "selected" }] })).not.toContain("under the cursor");
  });

  it("is the text alone without context", () => {
    expect(formatQuickMessage({ text: "hello\n" })).toBe("hello");
  });

  it("names the map from an actor path", () => {
    expect(mapOf("/Game/Maps/L.L:PersistentLevel.A")).toBe("/Game/Maps/L");
  });
});

describe("parseQuickRequest", () => {
  it("refuses an empty text, a bad kind and a missing path", () => {
    expect(parseQuickRequest({ text: "  " })).toMatch(/with text/);
    expect(parseQuickRequest({ text: "x", context: [{ kind: "thing", path: "/Game/A.A" }] })).toMatch(/kind/);
    expect(parseQuickRequest({ text: "x", context: [{ kind: "asset", label: "A" }] })).toMatch(/path/);
  });

  it("keeps labels and paths to one line and labels an item by its path when it has none", () => {
    expect(parseQuickRequest({ text: "x", context: [{ kind: "asset", path: "/Game/A.A\n" }, { kind: "actor", label: "a\nb", path: "/Game/M.M:PersistentLevel.B" }] })).toEqual({
      text: "x",
      context: [
        { kind: "asset", label: "A", path: "/Game/A.A" },
        { kind: "actor", label: "a b", path: "/Game/M.M:PersistentLevel.B" },
      ],
    });
  });
});

describe("quickTitle", () => {
  it("is the first line of the text, capped at 60", () => {
    expect(quickTitle("  fix the lights\nthey flicker")).toBe("fix the lights");
    expect(quickTitle("a".repeat(80))).toHaveLength(60);
  });
});

describe("POST /quick", () => {
  it("creates a session titled from the text, sends the context message and sends the UI to it", async () => {
    const { projectDir, created, sent, events, post } = setup();
    const res = await post({ text: "what is this?", context: [{ kind: "asset", label: "Rock", path: "/Game/Rock.Rock" }] });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ sessionId: "s1" });
    expect(created).toEqual(["what is this?"]);
    expect(sent).toEqual([{ id: "s1", text: "Context: asset: Rock at /Game/Rock.Rock\n\nwhat is this?" }]);
    expect(events).toEqual([{ type: "session.focus", data: { sessionId: "s1" } }]);
    expect(fs.readFileSync(windowLocationFile(projectDir), "utf-8")).toBe("#/chat/s1\n");
  });

  it("answers 409 and creates nothing when no model is connected", async () => {
    const { created, events, post } = setup(false);
    const res = await post({ text: "hello" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: NO_MODEL });
    expect(created).toEqual([]);
    expect(events).toEqual([]);
  });

  it("answers 400 for a bad body", async () => {
    expect((await setup().post({})).status).toBe(400);
  });
});

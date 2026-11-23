/**
 * Editor consent's pieces without a harness: which calls are disruptive, the
 * participant state a conversation reports, the gate's answers, and how an
 * editor operation the other sessions refused reads to the model and the
 * busy banner.
 */
import { describe, expect, it } from "vitest";
import {
  ConsentParticipants,
  GO_AFTER_SUBAGENTS,
  REPLY_BUSY,
  disruptiveCallOf,
  gateCall,
  needsConsent,
  participantLabel,
  refusalText,
  steerText,
  voteCallOf,
  withParams,
  type ConsentLedger,
  type DisruptionView,
  type RunState,
} from "../src/consent.js";
import { BusyTracker } from "../src/busy.js";
import { executeTool, type AgentHost } from "../src/tools.js";

const view = (over: Partial<DisruptionView> = {}): DisruptionView => ({
  id: "r-1",
  op: "rebuild",
  action: "POST /v1/disruptions",
  requester: { id: "studio:s1", label: "Studio: t" },
  state: "approved",
  createdAt: "2026-11-23T00:00:00.000Z",
  expiresAt: "2026-11-23T00:15:00.000Z",
  answers: [],
  self: { attestationRequired: true, attested: "none", inflight: [] },
  ...over,
});

/** A ledger that records what it was sent and answers requests with `answer`. */
function fakeLedger(answer: () => DisruptionView | Error = () => view()) {
  const sent: Array<{ what: string; args: unknown[] }> = [];
  const ledger = {
    report: async (...args: unknown[]) => void sent.push({ what: "report", args }),
    remove: async (...args: unknown[]) => void sent.push({ what: "remove", args }),
    request: async (...args: unknown[]) => {
      sent.push({ what: "request", args });
      const a = answer();
      if (a instanceof Error) throw a;
      return a;
    },
    vote: async (...args: unknown[]) => void sent.push({ what: "vote", args }),
    hold: async (...args: unknown[]) => void sent.push({ what: "hold", args }),
    release: async (...args: unknown[]) => void sent.push({ what: "release", args }),
  };
  return { ledger: ledger as unknown as ConsentLedger, sent };
}

function participants(states: Record<string, RunState | null>, ledger: ConsentLedger, now = { t: 0 }) {
  return new ConsentParticipants({ ledger, state: (id) => states[id] ?? null, sessions: () => Object.keys(states), now: () => now.t });
}

describe("which calls go through the gate", () => {
  it("reads the disruptive operation off editor_restart, ue_mcp calls and projected category tools", () => {
    expect(disruptiveCallOf("editor_restart", { operation: "rebuild", reason: "C++" })).toEqual({ op: "rebuild", reason: "C++" });
    expect(disruptiveCallOf("ue_mcp", { action: "call", category: "editor", method: "stop_editor", args: {} })).toEqual({ op: "stop" });
    expect(disruptiveCallOf("ue_mcp", { action: "call", category: "project", method: "build" })).toEqual({ op: "build", whileRunning: true });
    expect(disruptiveCallOf("ue_mcp", { action: "call", category: "project", method: "live_coding_compile" })).toEqual({ op: "live_coding" });
    expect(disruptiveCallOf("ue_mcp", { action: "call", category: "editor", method: "execute_command", args: { command: "QUIT_EDITOR" } })).toEqual({ op: "stop" });
    expect(disruptiveCallOf("ue_mcp", { action: "call", category: "editor", method: "execute_command", args: { command: "stat fps" } })).toBeNull();
    expect(disruptiveCallOf("editor", { action: "restart_editor" })).toEqual({ op: "restart" });
    expect(disruptiveCallOf("ue_mcp", { action: "describe", category: "editor", method: "stop_editor" })).toBeNull();
    expect(disruptiveCallOf("shell", { command: "UnrealEditor.exe -quit" })).toBeNull();
  });

  it("reads a vote, and rewrites one in the shape the model sent it", () => {
    const micro = { action: "call", category: "editor", method: "disruption_vote", args: { requestId: "r-2", vote: GO_AFTER_SUBAGENTS } };
    expect(voteCallOf("ue_mcp", micro)).toEqual({ requestId: "r-2", vote: GO_AFTER_SUBAGENTS, reason: "" });
    expect(needsConsent("ue_mcp", micro)).toBe(true);
    expect(withParams("ue_mcp", micro, { vote: "go" })).toMatchObject({ args: { requestId: "r-2", vote: "go" } });
    expect(withParams("editor", { action: "disruption_vote", requestId: "r-2", vote: "go" }, { vote: "block" })).toEqual({ action: "disruption_vote", requestId: "r-2", vote: "block" });
    expect(needsConsent("ue_mcp", { action: "call", category: "blueprint", method: "create" })).toBe(false);
  });

  it("names a conversation by its title", () => {
    expect(participantLabel("Fix the door")).toBe("Studio: Fix the door");
    expect(participantLabel("")).toBe("Studio");
  });
});

describe("a conversation as a participant", () => {
  const busy: RunState = { title: "t", replying: true, subagents: [{ callId: "a1", description: "Playtest" }, { callId: "a2", description: "Materials" }] };

  it("reports its reply and running subagents, only when they change, and is let go once idle a while", async () => {
    const { ledger, sent } = fakeLedger();
    const states: Record<string, RunState | null> = { s1: busy };
    const now = { t: 0 };
    const p = participants(states, ledger, now);
    await p.syncAll();
    expect(sent).toEqual([{ what: "report", args: ["studio:s1", { label: "Studio: t", busy: [REPLY_BUSY, 'subagent "Playtest"', 'subagent "Materials"'] }] }]);
    await p.syncAll();
    expect(sent).toHaveLength(1);
    states.s1 = { title: "t", replying: false, subagents: [] };
    await p.syncAll();
    expect(sent.at(-1)).toEqual({ what: "report", args: ["studio:s1", { label: "Studio: t", busy: [] }] });
    now.t = 11 * 60_000;
    await p.syncAll();
    expect(sent.at(-1)).toEqual({ what: "remove", args: ["studio:s1"] });
    expect(p.reported("s1")).toBe(false);
  });

  it("removes a conversation that was deleted", async () => {
    const { ledger, sent } = fakeLedger();
    const states: Record<string, RunState | null> = { s1: busy };
    const p = participants(states, ledger);
    await p.syncAll();
    states.s1 = null;
    await p.sync("s1");
    expect(sent.at(-1)).toEqual({ what: "remove", args: ["studio:s1"] });
  });

  it("takes a disruptive call's caller off its own busy list, and attests none only when no other subagent runs", () => {
    const { ledger } = fakeLedger();
    const p = participants({ s1: busy }, ledger);
    p.begin("s1", "call-1", "a1");
    expect(p.busyOf("s1")).toEqual(['subagent "Materials"']);
    expect(p.attestation("s1")).toBeUndefined();
    p.begin("s1", "call-2", "a2");
    expect(p.busyOf("s1")).toEqual([]);
    expect(p.attestation("s1")).toBe("none");
    p.end("s1", "call-1");
    p.end("s1", "call-2");
    expect(p.busyOf("s1")).toEqual([REPLY_BUSY, 'subagent "Playtest"', 'subagent "Materials"']);
  });

  it("lets an exemption lapse when its call never ran", () => {
    const { ledger } = fakeLedger();
    const now = { t: 0 };
    const p = participants({ s1: busy }, ledger, now);
    p.begin("s1", "call-1", null);
    expect(p.busyOf("s1")).not.toContain(REPLY_BUSY);
    now.t = 11 * 60_000;
    expect(p.busyOf("s1")).toContain(REPLY_BUSY);
  });
});

describe("the gate", () => {
  const idle: RunState = { title: "t", replying: true, subagents: [] };
  const deps = (ledger: ConsentLedger, p: ConsentParticipants, editorRunning = true) => ({ ledger, participants: p, editorRunning: () => editorRunning });
  const restart = { name: "editor_restart", input: { operation: "rebuild", reason: "C++ changed" } };

  it("lets an approved rebuild run, asked as the conversation with no subagents and its reply exempt", async () => {
    const { ledger, sent } = fakeLedger();
    const p = participants({ s1: idle }, ledger);
    const g = await gateCall(deps(ledger, p), { sessionId: "s1", callId: "c1", parent: null, ...restart, canWait: true });
    expect(g).toEqual({ allow: true });
    expect(sent.find((x) => x.what === "report")?.args).toEqual(["studio:s1", { label: "Studio: t", busy: [] }]);
    expect(sent.find((x) => x.what === "request")?.args).toEqual(["studio:s1", "rebuild", { reason: "C++ changed", subagents: "none" }]);
    // Exempt until the call ends.
    expect(p.busyOf("s1")).toEqual([]);
    p.end("s1", "c1");
    expect(p.busyOf("s1")).toEqual([REPLY_BUSY]);
  });

  it("refuses a pending rebuild with each holder's answer, and drops the exemption", async () => {
    const { ledger } = fakeLedger(() => view({
      state: "pending",
      answers: [
        { session: "mcp-1", label: "Claude Code", answer: "wait_until_released", reason: "busy (blueprint.add_variable)", auto: true },
        { session: "mcp-2", label: "Cursor", answer: "go", reason: "idle for 400s", auto: true },
      ],
    }));
    const p = participants({ s1: idle }, ledger);
    const g = await gateCall(deps(ledger, p), { sessionId: "s1", callId: "c1", parent: null, ...restart, canWait: true });
    expect(g.allow).toBe(false);
    const text = (g as { text: string }).text;
    expect(text).toContain("'Claude Code': wait, busy (blueprint.add_variable)");
    expect(text).not.toContain("Cursor");
    expect(text).toContain("ue-mcp editor approve r-1");
    expect(p.busyOf("s1")).toEqual([REPLY_BUSY]);
  });

  it("does not attest while the conversation's other subagents run, and says so", async () => {
    const { ledger, sent } = fakeLedger(() => view({ state: "confirm", self: { attestationRequired: true, attested: null, inflight: ['subagent "Materials"'] } }));
    const p = participants({ s1: idle }, ledger);
    const subagents = [{ callId: "a1", description: "Caller" }, { callId: "a2", description: "Materials" }];
    const g = await gateCall(deps(ledger, p), { sessionId: "s1", callId: "c1", parent: "a1", ...restart, subagents, canWait: true });
    expect(sent.find((x) => x.what === "request")?.args).toEqual(["studio:s1", "rebuild", { reason: "C++ changed" }]);
    expect(sent.find((x) => x.what === "report")?.args).toEqual(["studio:s1", { label: "Studio: t", busy: ['subagent "Materials"'] }]);
    expect((g as { text: string }).text).toContain('"Materials" (a2)');
  });

  it("lets a build run unasked when no editor runs, and any call run when the ledger cannot be reached", async () => {
    const { ledger, sent } = fakeLedger(() => new Error("connection refused"));
    const p = participants({ s1: idle }, ledger);
    const build = { name: "ue_mcp", input: { action: "call", category: "project", method: "build", args: {} } };
    expect(await gateCall(deps(ledger, p, false), { sessionId: "s1", callId: "c1", parent: null, ...build, canWait: true })).toEqual({ allow: true });
    expect(sent).toEqual([]);
    expect(await gateCall(deps(ledger, p), { sessionId: "s1", callId: "c2", parent: null, ...restart, canWait: true })).toEqual({ allow: true });
  });

  it("turns go while its subagents run into a wait vote and a hold, with the subagents to wait for", async () => {
    const { ledger, sent } = fakeLedger();
    const p = participants({ s1: idle }, ledger);
    const vote = { name: "ue_mcp", input: { action: "call", category: "editor", method: "disruption_vote", args: { requestId: "r-5", vote: "go", reason: "saved" } } };
    const g = await gateCall(deps(ledger, p), { sessionId: "s1", callId: "c1", parent: null, ...vote, subagents: [{ callId: "a1", description: "Playtest" }], canWait: true });
    expect(g).toMatchObject({ allow: true, waitFor: ["a1"], arguments: { args: { requestId: "r-5", vote: "wait_until_released" } } });
    expect(String((g as { arguments: { args: { reason: string } } }).arguments.args.reason)).toContain("Playtest");
    expect(sent.find((x) => x.what === "hold")?.args[0]).toBe("studio:s1");
  });

  it("makes go_after_subagents a plain go with none running, and refuses it where nothing can wait", async () => {
    const { ledger } = fakeLedger();
    const p = participants({ s1: idle }, ledger);
    const vote = { name: "ue_mcp", input: { action: "call", category: "editor", method: "disruption_vote", args: { requestId: "r-5", vote: GO_AFTER_SUBAGENTS } } };
    expect(await gateCall(deps(ledger, p), { sessionId: "s1", callId: "c1", parent: null, ...vote, subagents: [], canWait: true })).toMatchObject({ allow: true, arguments: { args: { vote: "go" } } });
    const refused = await gateCall(deps(ledger, p), { sessionId: "s1", callId: "c2", parent: null, ...vote, subagents: [{ callId: "a1", description: "Playtest" }], canWait: false });
    expect(refused.allow).toBe(false);
  });

  it("words the steer for a replying conversation, offering go_after_subagents only with subagents running", () => {
    const v = view({ id: "r-3", requester: { id: "http:x", label: "the user in Studio" }, state: "pending", reason: "plugin update" });
    expect(steerText(v, [])).toContain('[Studio] Editor disruption request r-3: \'the user in Studio\' asks to rebuild');
    expect(steerText(v, [])).not.toContain(GO_AFTER_SUBAGENTS);
    expect(steerText(v, [{ callId: "a1", description: "Playtest" }])).toContain(GO_AFTER_SUBAGENTS);
    expect(refusalText(view({ state: "denied" }), [])).toContain("a person denied");
  });
});

describe("an editor operation the other sessions refused", () => {
  const refused = { op: "rebuild", steps: [{ step: "consent", ok: false, result: "Not run yet: ...", reason: "Not run yet: request r-1 is waiting on 'Claude Code'." }] };

  it("reads to the model as not run, with the daemon's reason", async () => {
    const host = { editorOperation: async () => refused, editors: () => [], projectDir: ".", dataDir: "." } as unknown as AgentHost;
    const r = await executeTool(host, "editor_restart", { operation: "rebuild", reason: "x" });
    expect(r).toMatchObject({ isError: true, outcome: "error" });
    expect(r.text).toBe("rebuild did not run: Not run yet: request r-1 is waiting on 'Claude Code'.");
  });

  it("leaves the busy banner alone: the editor never went away", () => {
    const published: Array<{ type: string; data: Record<string, unknown> }> = [];
    const b = new BusyTracker((type, data) => published.push({ type, data }));
    b.observe({ type: "editor.operation", data: { op: "rebuild", step: "consent", phase: "failed", reason: "Not run yet" } });
    expect(b.state().failure).toBeUndefined();
    expect(published).toEqual([]);
  });
});

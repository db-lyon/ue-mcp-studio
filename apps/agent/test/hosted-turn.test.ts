/**
 * Claude sign-in turns run in turn hosts, end to end through the runner: the
 * Agent SDK is the scripted binary (fake-sdk.ts), each host a TurnHost in this
 * process over a real socket, and a daemon restart is one runner disposed and
 * a new one, on a fresh session store, recovering.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Host, assistant, results, sdk, until, use, type FakeBinary } from "./fake-sdk.js";

vi.mock("../src/runtime.js", () => ({ ensureRuntime: async () => "claude.exe", installedRuntime: () => "claude.exe" }));
vi.mock("../src/claude-auth.js", async (actual) => {
  const login = { method: "claude.ai", subscription: "max", keySource: null };
  return { ...(await actual<typeof import("../src/claude-auth.js")>()), claudeLogin: () => login, refreshClaudeLogin: async () => login };
});
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./fake-sdk.js")).fakeSdk);

const { AgentRunner } = await import("../src/runner.js");
const { SessionStore } = await import("../src/sessions.js");
const { TurnHosts } = await import("../src/hosted-turn.js");
const { TurnHost } = await import("../src/turn-host.js");
const { runSubscriptionTurn } = await import("../src/subscription.js");
const { listRecords } = await import("../src/turn-host-protocol.js");
const { UpdateQueue } = await import("../src/update-queue.js");

let root: string;
let host: Host;
let hostsStarted: number;
const env = { ...process.env };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-hosted-"));
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  fs.mkdirSync(path.join(root, "project", "Content"), { recursive: true });
  host = new Host(path.join(root, "project"), path.join(root, "data"));
  sdk.prompts = [];
  sdk.interrupts = 0;
  sdk.backgrounded = 0;
  sdk.stopTask = null;
  hostsStarted = 0;
});

afterEach(() => {
  process.env = { ...env };
  fs.rmSync(root, { recursive: true, force: true });
});

/** Turn hosts that run in this process: the real TurnHost and turn code, started from the launch file the daemon writes. */
const hostsOn = (o: { fail?: boolean } = {}) =>
  new TurnHosts({
    dataDir: host.dataDir,
    projectDir: host.projectDir,
    version: "test",
    script: null,
    log: host.log,
    reconnectMs: 500,
    launch: (file) => {
      if (o.fail) throw new Error("spawn failed");
      const launch = JSON.parse(fs.readFileSync(file, "utf-8"));
      fs.rmSync(file, { force: true });
      const h = new TurnHost({ launch, run: runSubscriptionTurn, endAckMs: 2000 });
      let gone = false;
      hostsStarted++;
      void h.start().then(() => h.done).finally(() => void (gone = true));
      return { exited: () => gone, kill: () => {} };
    },
  });

/** One daemon: a runner on its own session store, loaded from disk as a new daemon loads it. */
const daemon = (o: { ask?: boolean; fail?: boolean; subscription?: () => boolean; ready?: () => Promise<void> | null } = {}) => {
  const store = new SessionStore(host.dataDir);
  const runner = new AgentRunner({ host, store, provider: () => { throw new Error("the API route is not used"); }, model: () => "claude-opus-5-5", subscription: o.subscription ?? (() => true), ready: o.ready, askBeforeChanges: () => !!o.ask, turnHosts: hostsOn(o) });
  return { store, runner };
};

/**
 * The daemon dies without going down (an uncaught exception): its connections
 * to the hosts drop, and nothing of its own is ended or saved.
 */
const crash = (runner: InstanceType<typeof AgentRunner>) => {
  const r = runner as unknown as { disposed: boolean; unsubscribe(): void; hosted: Map<string, { detach(): void }>; runs: Map<string, { hosted?: { detach(): void } | null }> };
  r.disposed = true;
  r.unsubscribe();
  for (const run of r.hosted.values()) run.detach();
  for (const run of r.runs.values()) run.hosted?.detach();
};

const texts = (s: { transcript: Array<{ kind: string; text?: string; parent?: string }> }) => s.transcript.filter((t) => t.kind === "assistant" && !t.parent).map((t) => t.text);
const outcome = (s: { transcript: Array<{ kind: string; call?: { id: string; outcome: string; result?: string } }> }, id: string) => s.transcript.find((t) => t.kind === "tool" && t.call?.id === id)?.call;

describe("a turn in a host process across a daemon restart", () => {
  it("goes on while no daemon is there, and the next daemon replays what it missed and carries on", async () => {
    const gates: Array<() => void> = [];
    const gate = () => new Promise<void>((r) => gates.push(r));
    sdk.script = async (b) => {
      b.emit({ type: "system", subtype: "init", session_id: "sdk-h1" });
      b.emit(assistant("m1", [{ type: "text", text: "Starting." }]));
      await gate();
      // Said while no daemon is connected: it waits in the journal.
      b.emit(assistant("m2", [{ type: "text", text: "Said while the daemon was away." }]));
      await gate();
      await use(b, "s1", "shell", { command: "echo back again" });
      b.emit(assistant("m3", [{ type: "text", text: "Done." }]));
      b.emit({ type: "result", subtype: "success", is_error: false, session_id: "sdk-h1" });
    };
    const d1 = daemon();
    const s = d1.store.create();
    const turn = d1.runner.send(s.id, "go");
    await until(() => texts(d1.store.get(s.id)!).includes("Starting."));
    expect(hostsStarted).toBe(1);
    // Hosted: running, but nothing a daemon restart would end.
    expect(d1.runner.activeSessions()).toEqual([s.id]);
    expect(d1.runner.pinnedSessions()).toEqual([]);

    // The daemon goes down: the turn is let go, not ended.
    d1.runner.dispose();
    await turn;
    expect(new SessionStore(host.dataDir).get(s.id)!.status).toBe("running");
    gates.shift()!();
    await until(() => gates.length === 1);

    // The next daemon reattaches.
    const d2 = daemon();
    d2.runner.recover();
    await until(() => texts(d2.store.get(s.id)!).includes("Said while the daemon was away."));
    expect(d2.runner.activeSessions()).toEqual([s.id]);
    await until(() => d2.runner.pinnedSessions().length === 0);
    gates.shift()!();
    await until(() => d2.store.get(s.id)!.status === "idle");
    const fin = d2.store.get(s.id)!;
    // Each event once: nothing the first daemon applied came again.
    expect(texts(fin)).toEqual(["Starting.", "Said while the daemon was away.", "Done."]);
    expect(outcome(fin, "s1")).toMatchObject({ outcome: "done" });
    expect(outcome(fin, "s1")!.result).toMatch(/back again/);
    expect(fin.sdkSession).toBe("sdk-h1");
    expect(fin.hostTurn).toBeUndefined();
    await until(() => listRecords(host.dataDir).length === 0);
  }, 20_000);

  it("a call waiting for approval asks again in the next daemon, and the answer there runs it", async () => {
    let got: Awaited<ReturnType<FakeBinary["call"]>> | null = null;
    sdk.script = async (b) => {
      b.emit({ type: "system", subtype: "init", session_id: "sdk-h2" });
      got = await use(b, "w1", "shell", { command: "echo approved-after-restart" });
      b.emit({ type: "result", subtype: "success", is_error: false, session_id: "sdk-h2" });
    };
    const d1 = daemon({ ask: true });
    const s = d1.store.create();
    const turn = d1.runner.send(s.id, "run it");
    await until(() => (d1.store.get(s.id)!.approvals ?? []).length === 1);
    d1.runner.dispose();
    await turn;

    const d2 = daemon({ ask: true });
    d2.runner.recover();
    await until(() => (d2.store.get(s.id)!.approvals ?? []).length === 1);
    const approval = d2.store.get(s.id)!.approvals![0];
    expect(approval.toolUseId).toBe("w1");
    expect(d2.runner.answerApproval(s.id, approval.id, "allow")).toBe(true);
    await until(() => d2.store.get(s.id)!.status === "idle");
    expect(got!.isError).toBe(false);
    expect(got!.text).toMatch(/approved-after-restart/);
    expect(outcome(d2.store.get(s.id)!, "w1")).toMatchObject({ outcome: "done" });
  }, 20_000);

  it("a call that was running when the daemon went down is reported with an unknown outcome, and never run twice", async () => {
    let calls = 0;
    host.callAction = async (category: string, action: string) => {
      calls++;
      await new Promise(() => {});
      return { isError: false, content: [{ type: "text", text: JSON.stringify({ category, action }) }] };
    };
    let got: Awaited<ReturnType<FakeBinary["call"]>> | null = null;
    sdk.script = async (b) => {
      b.emit({ type: "system", subtype: "init", session_id: "sdk-h3" });
      got = await use(b, "u1", "ue_mcp", { action: "call", category: "asset", method: "slow", args: {} });
      b.emit({ type: "result", subtype: "success", is_error: false, session_id: "sdk-h3" });
    };
    const d1 = daemon();
    const s = d1.store.create();
    const turn = d1.runner.send(s.id, "slow");
    await until(() => calls === 1);
    d1.runner.dispose();
    await turn;

    const d2 = daemon();
    d2.runner.recover();
    await until(() => d2.store.get(s.id)!.status === "idle");
    expect(calls).toBe(1);
    expect(got!.isError).toBe(true);
    expect(got!.text).toMatch(/restarted while this call was running/);
    expect(outcome(d2.store.get(s.id)!, "u1")).toMatchObject({ outcome: "unknown" });
  }, 20_000);

  it("a turn that ended while no daemon was there ends with what its journal says", async () => {
    let release: (() => void) | null = null;
    sdk.script = async (b) => {
      b.emit({ type: "system", subtype: "init", session_id: "sdk-h4" });
      await new Promise<void>((r) => (release = r));
      b.emit(assistant("m1", [{ type: "text", text: "Finished alone." }]));
      b.emit({ type: "result", subtype: "success", is_error: false, session_id: "sdk-h4" });
    };
    const d1 = daemon();
    const s = d1.store.create();
    const turn = d1.runner.send(s.id, "go");
    await until(() => release !== null && d1.store.get(s.id)!.sdkSession === "sdk-h4");
    d1.runner.dispose();
    await turn;
    release!();
    // The host ends without a daemon: its record says so, and the journal holds the end.
    await until(() => listRecords(host.dataDir)[0]?.ended === true);

    const d2 = daemon();
    d2.runner.recover();
    await until(() => d2.store.get(s.id)!.status === "idle");
    expect(texts(d2.store.get(s.id)!)).toEqual(["Finished alone."]);
    expect(listRecords(host.dataDir)).toEqual([]);
  }, 20_000);
});

describe("steering on the Claude sign-in through host processes", () => {
  const sub = (b: FakeBinary) => String(b.options.systemPrompt).includes("You are a subagent");

  it("runs a subagent in a host of its own: the user's message is streamed into its session, and stopping it stops only it", async () => {
    let subBinary: FakeBinary | null = null;
    sdk.script = async (b) => {
      if (sub(b)) {
        subBinary = b;
        b.emit({ type: "system", subtype: "init", session_id: "sdk-sub" });
        // Working until it is stopped, reading what is streamed in.
        await new Promise<void>((r) => b.signal.addEventListener("abort", () => r(), { once: true }));
        return;
      }
      b.emit({ type: "system", subtype: "init", session_id: "sdk-main" });
      b.emit(assistant("m_a", [{ type: "tool_use", id: "ag", name: "mcp__studio__agent", input: { description: "Build", prompt: "build" } }]));
      const r = await b.call("agent", { description: "Build", prompt: "build" });
      b.emit(results("ag", r));
      b.emit(assistant("m_end", [{ type: "text", text: `Agent said: ${r.text.slice(0, 40)}` }]));
      b.emit({ type: "result", subtype: "success", is_error: false, session_id: "sdk-main" });
    };
    const d = daemon();
    const s = d.store.create();
    const turn = d.runner.send(s.id, "build it");
    await until(() => hostsStarted === 2 && !!subBinary && d.runner.canMessage(d.store.get(s.id)!, "ag"));
    // Each conversation in its own host, neither pinning an update.
    expect(listRecords(host.dataDir).map((r) => r.session).sort()).toEqual([s.id, `${s.id}#ag`].sort());
    await until(() => d.runner.pinnedSessions().length === 0);
    expect(await d.runner.messageSubagent(s.id, "ag", "make it oak")).toBe(true);
    await until(() => subBinary!.said.length === 1);
    expect(String(subBinary!.said[0])).toMatch(/^The user writes to you from your thread[\s\S]*make it oak$/);
    expect(d.runner.stopSubagent(s.id, "ag")).toBe(true);
    await turn;
    await until(() => d.store.get(s.id)!.status === "idle");
    const fin = d.store.get(s.id)!;
    expect(outcome(fin, "ag")).toMatchObject({ outcome: "stopped" });
    expect(texts(fin).at(-1)).toMatch(/^Agent said: The user stopped this subagent/);
    expect(sdk.interrupts).toBe(1);
    await until(() => listRecords(host.dataDir).length === 0);
  }, 20_000);

  it("streams the user's message into the main agent's reply while it waits on a subagent, which goes on in the background", async () => {
    let release: (() => void) | null = null;
    let mainBinary: FakeBinary | null = null;
    sdk.script = async (b) => {
      if (sub(b)) {
        await new Promise<void>((r) => (release = r));
        b.emit(assistant("s_end", [{ type: "text", text: "Gate built." }]));
        b.emit({ type: "result", subtype: "success", is_error: false, session_id: "sdk-sub" });
        return;
      }
      const first = await b.first();
      if (first.includes("has ended")) {
        b.emit(assistant("m_r", [{ type: "text", text: "The gate is done." }]));
        b.emit({ type: "result", subtype: "success", is_error: false, session_id: "sdk-main" });
        return;
      }
      mainBinary = b;
      b.emit({ type: "system", subtype: "init", session_id: "sdk-main" });
      b.emit(assistant("m_a", [{ type: "tool_use", id: "ag", name: "mcp__studio__agent", input: { description: "Build the gate", prompt: "gate" } }]));
      const r = await b.call("agent", { description: "Build the gate", prompt: "gate" });
      b.emit(results("ag", r));
      await until(() => b.said.length === 1);
      b.emit(assistant("m_b", [{ type: "text", text: "Still on it." }]));
      b.emit({ type: "result", subtype: "success", is_error: false, session_id: "sdk-main" });
    };
    const d = daemon();
    const s = d.store.create();
    void d.runner.send(s.id, "build the gate");
    await until(() => !!release && d.runner.mainFree(s.id));
    await d.runner.send(s.id, "how is it going?");
    await until(() => texts(d.store.get(s.id)!).includes("Still on it."));
    expect(mainBinary!.said).toEqual(["how is it going?"]);
    expect(outcome(d.store.get(s.id)!, "ag")).toMatchObject({ outcome: "pending" });
    release!();
    await until(() => d.store.get(s.id)!.status === "idle");
    const fin = d.store.get(s.id)!;
    // Its host ran it to the end, possibly before this daemon reached it: it ran once, never again in the daemon.
    expect(sdk.prompts.filter((p) => p === "gate")).toHaveLength(1);
    expect(outcome(fin, "ag")).toMatchObject({ outcome: "done", result: "Gate built." });
    expect(texts(fin).at(-1)).toBe("The gate is done.");
    // The report started a reply of the same runtime session.
    expect(sdk.resumes.at(-1)).toBe("sdk-main");
  }, 20_000);

  // The crash a refused session save caused: the main agent's reply had ended beside a background subagent in its host.
  it.each([
    ["the restart waits for the sign-ins", true],
    ["the report arrives before the sign-ins are read, and the reply it starts waits", false],
  ])("after a crash, the subagent is taken over, the ended reply gets no note, and its report wakes the main agent on the Claude sign-in: %s", async (_name, recoverWaits) => {
    let release: (() => void) | null = null;
    sdk.script = async (b) => {
      if (sub(b)) {
        await new Promise<void>((r) => (release = r));
        b.emit(assistant("s_end", [{ type: "text", text: "Gate built." }]));
        b.emit({ type: "result", subtype: "success", is_error: false, session_id: "sdk-sub" });
        return;
      }
      const first = await b.first();
      if (first.includes("has ended")) {
        b.emit(assistant("m_r", [{ type: "text", text: "The gate is done." }]));
        b.emit({ type: "result", subtype: "success", is_error: false, session_id: "sdk-main" });
        return;
      }
      b.emit({ type: "system", subtype: "init", session_id: "sdk-main" });
      b.emit(assistant("m_a", [{ type: "tool_use", id: "ag", name: "mcp__studio__agent", input: { description: "Build the gate", prompt: "gate" } }]));
      const r = await b.call("agent", { description: "Build the gate", prompt: "gate" });
      b.emit(results("ag", r));
      await until(() => b.said.length === 1);
      b.emit(assistant("m_b", [{ type: "text", text: "Still on it." }]));
      b.emit({ type: "result", subtype: "success", is_error: false, session_id: "sdk-main" });
    };
    const d1 = daemon();
    const s = d1.store.create();
    void d1.runner.send(s.id, "build the gate");
    await until(() => !!release && d1.runner.mainFree(s.id));
    await d1.runner.send(s.id, "how is it going?");
    // The reply ended; only the subagent works, in its host.
    const subLinked = () => !!(d1.runner as unknown as { runs: Map<string, { hosted?: unknown }> }).runs.get("ag")?.hosted;
    await until(() => texts(d1.store.get(s.id)!).includes("Still on it.") && d1.store.get(s.id)!.mainFree === true && listRecords(host.dataDir).length === 1 && subLinked());
    crash(d1.runner);
    // It reports while no daemon is there.
    release!();
    // Ended, or already gone once no daemon acknowledged its end: either way its journal holds the report.
    await until(() => listRecords(host.dataDir).every((r) => r.ended));

    // The next daemon starts before `claude auth status` has answered: until then nothing reads as the Claude sign-in.
    let signedIn = false;
    let read!: () => void;
    const readyP = new Promise<void>((r) => (read = r));
    let calls = 0;
    const d2 = daemon({
      subscription: () => signedIn,
      ready: () => (signedIn ? null : recoverWaits || calls++ > 0 ? readyP : null),
    });
    d2.runner.recover();
    await new Promise((r) => setTimeout(r, 300));
    expect(d2.store.get(s.id)!.error ?? null).toBeNull();
    signedIn = true;
    read();
    await until(() => texts(d2.store.get(s.id)!).includes("The gate is done.") && d2.store.get(s.id)!.status === "idle");
    const fin = d2.store.get(s.id)!;
    expect(fin.error ?? null).toBeNull();
    expect(outcome(fin, "ag")).toMatchObject({ outcome: "done", result: "Gate built." });
    // Nothing of the main agent's was cut off, so no turn ended.
    expect(fin.transcript.filter((t) => t.kind === "note" && /Turn ended/.test(String((t as { text?: string }).text)))).toEqual([]);
    expect(sdk.resumes.at(-1)).toBe("sdk-main");
    expect(sdk.prompts.filter((p) => p === "gate")).toHaveLength(1);
  }, 20_000);
});

describe("compatibility with a turn host from before protocol 3", () => {
  it("keeps a turn an older Studio started working through this daemon: its own subagents report, stop and free the main agent as before", async () => {
    const { STUDIO_SUBAGENTS_PROTOCOL, journalFile, recordFile, onLines, sendLine, socketPathFor, writeJsonAtomic } = await import("../src/turn-host-protocol.js");
    const net = await import("node:net");
    const store = new SessionStore(host.dataDir);
    const s = store.create();
    // The session as the older daemon left it: a turn in a host, an agent call of the runtime's own in the background.
    Object.assign(s, { status: "running", hostTurn: { seq: 4, lastId: null, background: ["ag"] }, mainFree: true });
    s.transcript.push({ kind: "user", text: "go", at: new Date().toISOString() }, { kind: "tool", call: { id: "ag", name: "agent", input: { description: "Old build", prompt: "build" }, outcome: "pending", startedAt: new Date().toISOString() } });
    store.save(s);
    const hostId = "00000000-0000-4000-8000-000000000001";
    const token = "legacy-token";
    const socket = socketPathFor(hostId);
    let seq = 4;
    let daemonSock: import("node:net").Socket | null = null;
    const ops: string[] = [];
    const server = net.createServer((sock) => {
      onLines(sock, (msg) => {
        if (msg.t === "hello") {
          daemonSock = sock;
          sendLine(sock, { t: "hello", protocol: 2, version: "0.1.35-beta.25", pid: process.pid, session: s.id, host: hostId, last: seq });
          sendLine(sock, { t: "state", live: true, open: true, free: true, background: 1, stoppers: ["ag"] });
        } else if (msg.t === "op") {
          ops.push(String(msg.op));
          sendLine(sock, { t: "ret", id: msg.id, value: true });
          if (msg.op === "stopTask") {
            sendLine(sock, { seq: ++seq, t: "task", toolUseId: "ag", status: "stopped", detail: { summary: "" } });
            sendLine(sock, { t: "state", live: true, open: false, free: true, background: 0, stoppers: [] });
            sendLine(sock, { seq: ++seq, t: "end", error: null });
          }
        }
      });
    });
    await new Promise<void>((r) => server.listen(socket, () => r()));
    expect(2).toBeLessThan(STUDIO_SUBAGENTS_PROTOCOL);
    writeJsonAtomic(recordFile(host.dataDir, hostId), { protocol: 2, version: "0.1.35-beta.25", host: hostId, pid: process.pid, session: s.id, socket, token, startedAt: new Date().toISOString() });
    fs.writeFileSync(journalFile(host.dataDir, hostId), "");
    try {
      const d = daemon();
      d.runner.recover();
      await until(() => !!daemonSock && d.runner.mainFree(s.id));
      expect(d.runner.keepsSubagents(s.id)).toBe(true);
      // The runtime's own subagent cannot take a message from its thread: the route sends it to the main agent instead.
      expect(d.runner.canMessage(d.store.get(s.id)!, "ag")).toBe(false);
      expect(d.runner.stopSubagent(s.id, "ag")).toBe(true);
      await until(() => d.store.get(s.id)!.status === "idle");
      expect(ops).toContain("stopTask");
      expect(outcome(d.store.get(s.id)!, "ag")).toMatchObject({ outcome: "stopped" });
    } finally {
      server.close();
    }
  }, 20_000);
});

describe("updates while a turn runs in a host process", () => {
  const queueFor = (runner: InstanceType<typeof AgentRunner>, ran: string[], interrupted: { n: number }) =>
    new UpdateQueue({
      dataDir: host.dataDir,
      busy: () => runner.activeSessions().length > 0,
      pinned: () => runner.pinnedSessions().length > 0,
      run: async (step) => {
        ran.push(step);
        return { ok: true, started: step !== "plugin" };
      },
      interruptTurns: () => void interrupted.n++,
      pollMs: 60_000,
    });

  it("installs Studio at once without ending the turn; the plugin still waits for it", async () => {
    let release: (() => void) | null = null;
    sdk.script = async (b) => {
      b.emit({ type: "system", subtype: "init", session_id: "sdk-u" });
      await new Promise<void>((r) => (release = r));
      b.emit({ type: "result", subtype: "success", is_error: false, session_id: "sdk-u" });
    };
    const d = daemon();
    const s = d.store.create();
    const turn = d.runner.send(s.id, "long work");
    await until(() => release !== null && d.runner.pinnedSessions().length === 0 && d.runner.activeSessions().length === 1);
    const ran: string[] = [];
    const interrupted = { n: 0 };
    const q = queueFor(d.runner, ran, interrupted);
    expect(await q.request("studio")).toMatchObject({ ok: true, started: true });
    expect(await q.request("restart")).toMatchObject({ ok: true, started: true });
    expect(await q.request("plugin")).toEqual({ ok: true, deferred: ["plugin"] });
    expect(ran).toEqual(["studio", "restart"]);
    expect(interrupted.n).toBe(0);
    expect(d.store.get(s.id)!.status).toBe("running");
    release!();
    await turn;
    await q.tick();
    expect(ran).toEqual(["studio", "restart", "plugin"]);
    q.stop();
  }, 20_000);

  it("runs the turn in the daemon when no host can start, and then Studio waits for it", async () => {
    let release: (() => void) | null = null;
    sdk.script = async (b) => {
      b.emit({ type: "system", subtype: "init", session_id: "sdk-f" });
      b.emit(assistant("m1", [{ type: "text", text: "In the daemon." }]));
      await new Promise<void>((r) => (release = r));
      b.emit({ type: "result", subtype: "success", is_error: false, session_id: "sdk-f" });
    };
    const d = daemon({ fail: true });
    const s = d.store.create();
    const turn = d.runner.send(s.id, "go");
    await until(() => release !== null);
    expect(hostsStarted).toBe(0);
    expect(d.runner.pinnedSessions()).toEqual([s.id]);
    const ran: string[] = [];
    const q = queueFor(d.runner, ran, { n: 0 });
    expect(await q.request("studio")).toEqual({ ok: true, deferred: ["studio"] });
    expect(ran).toEqual([]);
    release!();
    await turn;
    expect(texts(d.store.get(s.id)!)).toEqual(["In the daemon."]);
    expect(d.store.get(s.id)!.status).toBe("idle");
    await q.tick();
    expect(ran).toEqual(["studio"]);
    q.stop();
  }, 20_000);
});

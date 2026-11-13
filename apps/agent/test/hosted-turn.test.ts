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
const daemon = (o: { ask?: boolean; fail?: boolean } = {}) => {
  const store = new SessionStore(host.dataDir);
  const runner = new AgentRunner({ host, store, provider: () => { throw new Error("the API route is not used"); }, model: () => "claude-opus-5-5", subscription: () => true, askBeforeChanges: () => !!o.ask, turnHosts: hostsOn(o) });
  return { store, runner };
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

describe("steering a turn in a host process", () => {
  it("forwards a message, Stop's move to the background and interrupt, and stopping one subagent", async () => {
    let finish: (() => void) | null = null;
    sdk.stopTask = (taskId) => {
      expect(taskId).toBe("task-bg");
      finish?.();
    };
    let binary: FakeBinary | null = null;
    sdk.script = async (b) => {
      binary = b;
      b.emit({ type: "system", subtype: "init", session_id: "sdk-steer" });
      b.emit(assistant("m_a", [{ type: "tool_use", id: "ag", name: "Agent", input: { description: "Build", prompt: "build", run_in_background: true } }]));
      b.emit({ type: "system", subtype: "task_started", tool_use_id: "ag", task_id: "task-bg", is_backgrounded: true });
      b.emit(results("ag", { text: "Started in the background.", isError: false }));
      b.emit({ type: "result", subtype: "success", is_error: false, session_id: "sdk-steer" });
      // The user's message reaches the binary's input through the host.
      await until(() => b.said.length === 1);
      b.emit(assistant("m_c", [{ type: "text", text: "Working on your message." }]));
      await new Promise<void>((r) => (finish = r));
      b.emit({ type: "system", subtype: "task_notification", tool_use_id: "ag", task_id: "task-bg", status: "stopped", summary: "" });
      b.emit({ type: "result", subtype: "success", is_error: false, session_id: "sdk-steer" });
    };
    const d = daemon();
    const s = d.store.create();
    const turn = d.runner.send(s.id, "build in the background");
    await until(() => d.runner.mainFree(s.id));
    // tell: the main agent is free beside the background subagent.
    await d.runner.send(s.id, "how is it going?");
    await until(() => binary!.said.length === 1);
    expect(binary!.said).toEqual(["how is it going?"]);
    await until(() => texts(d.store.get(s.id)!).includes("Working on your message.") && !d.runner.mainFree(s.id));
    // Stop with the subagent working: foreground work moves to the background (keep), then only the reply stops.
    expect(d.runner.stopKeepsSubagents(s.id)).toBe(true);
    d.runner.stop(s.id);
    await until(() => sdk.backgrounded === 1 && sdk.interrupts === 1);
    // Stopping the subagent alone reaches the binary's stopTask.
    expect(d.runner.stopSubagent(s.id, "ag")).toBe(true);
    await turn;
    await until(() => d.store.get(s.id)!.status === "idle");
    expect(outcome(d.store.get(s.id)!, "ag")).toMatchObject({ outcome: "stopped" });
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

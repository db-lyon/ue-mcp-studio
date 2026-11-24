/**
 * Editor consent on the durable runtime (ue-mcp "editor.consent"): the
 * beforeTool hook routes disruptive calls through the daemon's ledger, each
 * conversation takes part as a participant, another session's request is
 * steered into a replying conversation, and "go after my subagents stop" is a
 * hold that a durable task releases once they end. The ledger is a fake HTTP
 * server; the harness and the model are the same as every durable test's.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { runHarness } from "../../src/durable/harness-main.js";
import { ConsentLedger, type DisruptionView } from "../../src/consent.js";
import { durableRunner, until, type DurableRig } from "./helpers.js";
import { startFakeAnthropic, type FakeAnthropic } from "./fake-anthropic.js";

interface LedgerCall {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

/** The daemon's ledger routes, answering every request with `state`. */
async function startLedger(answer: () => Partial<DisruptionView>) {
  const calls: LedgerCall[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf-8");
      const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      calls.push({ method: req.method ?? "", path: req.url ?? "", body });
      const view: DisruptionView = {
        id: "r-1",
        op: (body.op as DisruptionView["op"]) ?? "rebuild",
        action: "POST /v1/disruptions",
        requester: { id: String(body.participant ?? "x"), label: "Studio: t" },
        state: "approved",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        answers: [],
        self: { attestationRequired: true, attested: (body.subagents as "none") ?? null, inflight: [] },
        ...answer(),
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url === "/v1/disruptions" ? view : {}));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { calls, ledger: new ConsentLedger(() => ({ port, token: "t" })), close: () => new Promise<void>((r) => server.close(() => r())) };
}

const FEATURES = ["editor.consent", "callAction.session"];

let dir: string;
let fake: FakeAnthropic | undefined;
let harness: { close(): Promise<void> } | null;
let rig: DurableRig | undefined;
let ledger: Awaited<ReturnType<typeof startLedger>> | undefined;

const start = async (launch: Parameters<typeof runHarness>[0]) => {
  harness = await runHarness(launch);
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-consent-"));
  fs.mkdirSync(path.join(dir, "project"));
  fs.mkdirSync(path.join(dir, "data"));
  harness = null;
  fake = undefined;
  rig = undefined;
  ledger = undefined;
});

afterEach(async () => {
  rig?.runner.dispose();
  await harness?.close();
  await fake?.close();
  await ledger?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const rigWith = (base: string) => durableRunner({
  projectDir: path.join(dir, "project"),
  dataDir: path.join(dir, "data"),
  base,
  start,
  features: FEATURES,
  extra: { consent: ledger!.ledger },
});

describe("editor consent on the durable runtime", () => {
  it("blocks a rebuild the other sessions have not agreed to, tells the model who holds it, and never touches the editor", async () => {
    ledger = await startLedger(() => ({
      state: "pending",
      answers: [{ session: "mcp-1", label: "Claude Code", answer: "wait_until_released", reason: "busy (blueprint.add_variable)", auto: true }],
    }));
    fake = await startFakeAnthropic(({ toolResults }) => toolResults === 0
      ? { tool: { name: "editor_restart", input: { operation: "rebuild", reason: "C++ changed" } } }
      : { text: "Waiting on Claude Code." });
    rig = rigWith(fake.base);
    const ops: string[] = [];
    rig.host.editorOperation = async (op: string) => {
      ops.push(op);
      return { op, steps: [] };
    };
    const s = rig.store.create("t");
    await rig.runner.send(s.id, "rebuild");
    await until(() => rig!.store.get(s.id)!.status === "idle", 30_000, "the turn to end");

    expect(ops).toEqual([]);
    const asked = ledger.calls.find((c) => c.path === "/v1/disruptions");
    expect(asked?.body).toMatchObject({ participant: `studio:${s.id}`, op: "rebuild", reason: "C++ changed", subagents: "none" });
    // The conversation was registered by name before it asked, with its own reply off its busy list.
    const registered = ledger.calls.find((c) => c.method === "PUT" && c.path === `/v1/disruptions/participants/studio%3A${s.id}`);
    expect(registered?.body).toMatchObject({ label: "Studio: t", busy: [] });
    const told = fake.requests.at(-1)!.userText;
    expect(told).toContain("Claude Code");
    expect(told).toContain("busy (blueprint.add_variable)");
    const t = rig.store.get(s.id)!.transcript.find((e) => e.kind === "tool");
    expect(t?.kind === "tool" && t.call.outcome).not.toBe("done");
  }, 60_000);

  it("runs an approved rebuild as the conversation, with its subagents attested", async () => {
    ledger = await startLedger(() => ({ state: "approved" }));
    fake = await startFakeAnthropic(({ toolResults }) => toolResults === 0
      ? { tool: { name: "editor_restart", input: { operation: "restart", reason: "plugin enabled" } } }
      : { text: "Restarted." });
    rig = rigWith(fake.base);
    const ops: Array<{ op: string; opts?: Record<string, unknown> }> = [];
    rig.host.editorOperation = (async (op: string, opts?: Record<string, unknown>) => {
      ops.push({ op, opts });
      return { op, steps: [{ step: "editor.restart_editor", ok: true }] };
    }) as never;
    const s = rig.store.create("t");
    await rig.runner.send(s.id, "restart");
    await until(() => rig!.store.get(s.id)!.status === "idle", 30_000, "the turn to end");
    expect(ops).toEqual([{ op: "restart", opts: { session: { id: `studio:${s.id}`, label: "Studio: t" }, subagents: "none" } }]);
  }, 60_000);

  it("steers another session's request into a replying conversation, whose vote is attributed to it", async () => {
    ledger = await startLedger(() => ({ state: "approved" }));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    fake = await startFakeAnthropic(({ toolResults, userText }) => {
      if (toolResults === 0) return { tool: { name: "ue_mcp", input: { action: "call", category: "level", method: "play", args: {} } } };
      if (userText.includes("Editor disruption request r-7") && toolResults === 1) {
        return { tool: { name: "ue_mcp", input: { action: "call", category: "editor", method: "disruption_vote", args: { requestId: "r-7", vote: "go", reason: "saved" } } } };
      }
      return { text: "Done." };
    });
    rig = rigWith(fake.base);
    const seen: Array<{ c: string; a: string; opts?: Record<string, unknown> }> = [];
    const calls = rig.host.callAction.bind(rig.host);
    rig.host.callAction = (async (c: string, a: string, args?: Record<string, unknown>, opts?: Record<string, unknown>) => {
      seen.push({ c, a, opts });
      if (c === "level") await gate;
      return calls(c, a, args);
    }) as never;
    const s = rig.store.create("t");
    await rig.runner.send(s.id, "play");
    await until(() => seen.some((x) => x.c === "level"), 30_000, "the editor call");
    rig.host.emit("disruption.requested", {
      id: "r-7", op: "rebuild", action: "POST /v1/editor/rebuild", requester: { id: "http:the user in Studio", label: "the user in Studio" },
      state: "pending", createdAt: "", expiresAt: "", answers: [], self: { attestationRequired: false, attested: null, inflight: [] },
    });
    await new Promise((r) => setTimeout(r, 300));
    release();
    await until(() => seen.some((x) => x.a === "disruption_vote"), 30_000, "the vote");
    const vote = seen.find((x) => x.a === "disruption_vote");
    expect(vote?.opts?.session).toEqual({ id: `studio:${s.id}`, label: "Studio: t" });
    expect(seen.find((x) => x.c === "level")?.opts?.session).toEqual({ id: `studio:${s.id}`, label: "Studio: t" });
  }, 60_000);

  it("answers go after its subagents stop with a wait vote and a hold, released by a durable task once they end", async () => {
    ledger = await startLedger(() => ({ state: "approved" }));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    fake = await startFakeAnthropic(({ toolResults, system }) => {
      if (system.includes("You are a subagent")) return toolResults === 0 ? { tool: { name: "ue_mcp", input: { action: "call", category: "level", method: "play", args: {} } } } : { text: "Report: done." };
      return toolResults === 0
        ? { tool: { name: "ue_mcp", input: { action: "call", category: "editor", method: "disruption_vote", args: { requestId: "r-9", vote: "go_after_subagents", reason: "finishing a playtest" } } } }
        : { text: "Voted." };
    });
    rig = rigWith(fake.base);
    const votes: Array<Record<string, unknown> | undefined> = [];
    const calls = rig.host.callAction.bind(rig.host);
    rig.host.callAction = (async (c: string, a: string, args?: Record<string, unknown>) => {
      if (a === "disruption_vote") votes.push(args);
      if (c === "level") await gate;
      return calls(c, a, args);
    }) as never;
    const s = rig.store.create("t");
    const { done } = rig.runner.assignSubagent(s.id, "Playtest the door", "Open the door in PIE.");
    // The subagent is running (its editor call waits) when the main agent votes.
    for (const end = Date.now() + 30_000; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
      const seen = await rig.runner.durableInspect();
      if (seen.running && seen.tasks.some((t) => t.kind === "studio.reporter")) break;
    }
    await rig.runner.send(s.id, "someone wants to rebuild");
    await until(() => votes.length === 1, 30_000, "the vote");
    expect(votes[0]).toMatchObject({ requestId: "r-9", vote: "wait_until_released" });
    expect(String(votes[0]?.reason)).toContain("Playtest the door");
    const hold = ledger.calls.find((c) => c.path === `/v1/disruptions/participants/studio%3A${s.id}/hold`);
    expect(String(hold?.body.reason)).toContain("Playtest the door");
    expect(ledger.calls.some((c) => c.path.endsWith("/release"))).toBe(false);

    release();
    expect(await done).toMatchObject({ isError: false });
    await until(() => ledger!.calls.some((c) => c.path === `/v1/disruptions/participants/studio%3A${s.id}/release`), 30_000, "the release");
  }, 90_000);
});

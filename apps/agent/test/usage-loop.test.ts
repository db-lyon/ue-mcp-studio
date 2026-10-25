/**
 * The ledger and the per-day budgets on Studio's loop: one record per model
 * call with the agent, vendor and route it ran on, and a budget past its limit
 * asking or stopping before the next call goes on. Mixed vendors: the main
 * agent on OpenAI over the ChatGPT sign-in, a project helper on Anthropic over
 * a key.
 */
import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ActionResult, EditorStatus } from "ue-mcp/daemon";
import { DEFAULT_BUDGETS, type Budgets, type TokenKinds } from "@ue-mcp-studio/shared";
import { AgentRunner } from "../src/runner.js";
import { SessionStore } from "../src/sessions.js";
import type { ModelProvider, ModelRequest, ModelTurn } from "../src/providers.js";
import type { AgentHost } from "../src/tools.js";
import { Ledger } from "../src/ledger.js";
import { loadout } from "../src/native.js";
import { composeNative, toolsFor, type NativeHelper, type NativeRun } from "../src/native-runtime.js";

class Host implements AgentHost {
  calls: Array<{ category: string; action: string }> = [];
  published: Array<{ type: string; data?: Record<string, unknown> }> = [];
  log = { info() {}, warn() {} };
  events = { publish: (type: string, data?: Record<string, unknown>) => void this.published.push({ type, data }), subscribe: () => () => {} };
  constructor(public projectDir: string, public dataDir: string) {}
  async callAction(category: string, action: string): Promise<ActionResult> {
    this.calls.push({ category, action });
    return { isError: false, content: [{ type: "text", text: "{\"success\":true}" }] };
  }
  editors(): EditorStatus[] {
    return [{ name: "P", connected: true, port: 1, pid: 1, lastDisconnect: null }];
  }
  async editorOperation(op: string) {
    return { op, steps: [] };
  }
  setBusy(): void {}
}

class Scripted implements ModelProvider {
  requests: ModelRequest[] = [];
  constructor(private readonly turns: Array<() => ModelTurn>) {}
  async run(req: ModelRequest): Promise<ModelTurn> {
    this.requests.push(req);
    const next = this.turns.shift();
    if (!next) throw new Error("script exhausted");
    return next();
  }
}

const kinds = (input: number, output: number, cacheRead: number | null = null, cacheWrite: number | null = null): TokenKinds => ({ input, cacheRead, cacheWrite, output });
const withUsage = (t: ModelTurn, k: TokenKinds): ModelTurn => ({ ...t, usage: { input: (k.input ?? 0) + (k.cacheWrite ?? 0), output: k.output ?? 0, kinds: k } });
const text = (t: string, k = kinds(100, 10)): ModelTurn => withUsage({ content: [{ type: "text", text: t, citations: null } as never], stopReason: "end_turn" }, k);
const use = (id: string, name: string, input: Record<string, unknown>, k = kinds(100, 10)): ModelTurn => withUsage({ content: [{ type: "tool_use", id, name, input } as never], stopReason: "tool_use" }, k);

let root: string;
let project: string;
let host: Host;
let store: SessionStore;
let ledger: Ledger;
let budgets: Budgets;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-usage-loop-"));
  project = path.join(root, "Game");
  fs.mkdirSync(path.join(project, ".git"), { recursive: true });
  fs.mkdirSync(path.join(root, "home"), { recursive: true });
  host = new Host(project, path.join(root, "data"));
  store = new SessionStore(host.dataDir);
  ledger = new Ledger(host.dataDir);
  budgets = structuredClone(DEFAULT_BUDGETS);
});

function codexWithHelper(helper: ModelProvider): () => NativeRun {
  fs.mkdirSync(path.join(project, ".codex", "agents"), { recursive: true });
  fs.writeFileSync(path.join(project, ".codex", "agents", "dresser.toml"), 'name = "dresser"\ndescription = "Dresses levels"\ndeveloper_instructions = "Dress it."\nmodel = "gpt-6-luna"\n');
  return () => {
    const l = loadout("codex", project, path.join(root, "home"), new Map(), root);
    const helpers: NativeHelper[] = l.subagents.map((a) => ({ name: a.name, description: a.description, prompt: a.prompt, allowed: toolsFor(a).allowed, maxTurns: a.maxTurns, effort: a.effort, run: { provider: () => helper, model: "claude-sonnet-5-5", vendor: "anthropic", route: "key" } }));
    return { convention: "codex", loadout: l, composed: composeNative(l), helpers, skills: l.skills, sdkLoads: false };
  };
}

function runner(main: ModelProvider, native?: () => NativeRun): AgentRunner {
  return new AgentRunner({
    host,
    store,
    provider: () => main,
    model: () => "gpt-6-sol",
    ledger,
    budgets: () => budgets,
    callRoute: () => ({ vendor: "openai", route: "chatgpt" }),
    approvals: () => ({ shell: "allow", files: "allow", editorRestart: "allow", destructive: "allow" }),
    ...(native ? { native } : {}),
  });
}

const all = () => ledger.records(new Date(0), new Date(Date.now() + 86_400_000));

describe("the ledger on Studio's loop", () => {
  it("writes one record per call, the helper's on its own vendor and route under its own name", async () => {
    const helper = new Scripted([() => use("h1", "ue_mcp", { action: "call", category: "level", method: "get_outliner", args: {} }, kinds(500, 50, 2000, 100)), () => text("Dressed.", kinds(300, 40, 2500, 0))]);
    const main = new Scripted([() => use("a1", "agent", { helper: "dresser", description: "dress", prompt: "Dress the cave" }, kinds(1000, 80, null, null)), () => text("Done.", kinds(1200, 20))]);
    const r = runner(main, codexWithHelper(helper));
    const s = store.create();
    await r.send(s.id, "dress the cave");

    const recs = all();
    expect(recs).toHaveLength(4);
    expect(recs.every((x) => x.source === "chat")).toBe(true);
    expect(recs.filter((x) => x.agentId === "dresser").map((x) => [x.parentAgentId, x.vendor, x.model, x.route])).toEqual([["main", "anthropic", "claude-sonnet-5-5", "key"], ["main", "anthropic", "claude-sonnet-5-5", "key"]]);
    expect(recs.filter((x) => x.agentId === "main").map((x) => [x.parentAgentId, x.vendor, x.model, x.route])).toEqual([[null, "openai", "gpt-6-sol", "chatgpt"], [null, "openai", "gpt-6-sol", "chatgpt"]]);
    // The kinds the vendor did not report stay unreported, not zero.
    expect(recs.find((x) => x.agentId === "main")!.tokens).toEqual(kinds(1000, 80, null, null));
    expect(recs.find((x) => x.agentId === "dresser")!.tokens).toEqual(kinds(500, 50, 2000, 100));
    expect(new Set(recs.map((x) => x.sessionId))).toEqual(new Set([s.id]));
    expect(ledger.today().byAgent.get("dresser")).toBe(500 + 50 + 100 + 300 + 40);
  });

  it("counts the quick ask apart from the chat", async () => {
    const r = runner(new Scripted([() => text("Hi.")]));
    const s = store.create();
    s.source = "quick";
    store.save(s);
    await r.send(s.id, "hello");
    expect(all().map((x) => x.source)).toEqual(["quick"]);
  });
});

describe("per-day budgets", () => {
  const spend = (agentId: string, n: number) => ledger.append({ sessionId: null, turnId: null, agentId, parentAgentId: null, source: "chat", vendor: "openai", model: "gpt-6-sol", route: "chatgpt", tokens: kinds(n, 0), durationMs: 0 });

  it("asks before the next call once the team's day is spent, and Allow for this session covers the rest of the day", async () => {
    budgets.team = { perDayTokens: 1000, perMonthTokens: null, onLimit: "ask" };
    spend("main", 1000);
    const r = runner(new Scripted([
      () => use("c1", "ue_mcp", { action: "call", category: "level", method: "get_outliner", args: {} }),
      () => use("c2", "ue_mcp", { action: "call", category: "level", method: "get_outliner", args: {} }),
      () => text("Done."),
    ]));
    const s = store.create();
    const turn = r.send(s.id, "look");
    const end = Date.now() + 2000;
    while (!(store.get(s.id)!.approvals ?? []).length) {
      if (Date.now() > end) throw new Error("no approval");
      await new Promise((x) => setTimeout(x, 5));
    }
    const a = store.get(s.id)!.approvals![0];
    expect(a).toMatchObject({ tool: "budget", toolUseId: "c1", budget: { scope: "team-day", spent: 1110, limit: 1000, onLimit: "ask" } });
    expect(host.calls).toEqual([]);
    r.answerApproval(s.id, a.id, "session");
    await turn;
    // Both calls ran, and only the first asked.
    expect(host.calls).toHaveLength(2);
    expect(host.published.filter((e) => e.type === "approval.requested")).toHaveLength(1);
    expect(store.get(s.id)!.allowed?.some((k) => k.startsWith("budget:team-day:"))).toBe(true);
  });

  it("ends the turn when the user denies going past", async () => {
    budgets.team = { perDayTokens: 1000, perMonthTokens: null, onLimit: "ask" };
    spend("main", 1200);
    const r = runner(new Scripted([() => use("c1", "ue_mcp", { action: "call", category: "level", method: "get_outliner", args: {} }), () => text("never")]));
    const s = store.create();
    const turn = r.send(s.id, "look");
    const end = Date.now() + 2000;
    while (!(store.get(s.id)!.approvals ?? []).length) {
      if (Date.now() > end) throw new Error("no approval");
      await new Promise((x) => setTimeout(x, 5));
    }
    r.answerApproval(s.id, store.get(s.id)!.approvals![0].id, "deny");
    await turn;
    expect(host.calls).toEqual([]);
    expect(store.get(s.id)!.status).not.toBe("running");
  });

  it("stops at an agent's own day when its budget says stop, and leaves other agents alone", async () => {
    budgets.agents.main = { perRunTokens: null, perRunMinutes: null, perDayTokens: 500, onLimit: "stop-and-report" };
    spend("main", 600);
    spend("dresser", 99_999);
    const r = runner(new Scripted([() => use("c1", "ue_mcp", { action: "call", category: "level", method: "get_outliner", args: {} }), () => text("never")]));
    const s = store.create();
    await r.send(s.id, "look");
    expect(host.calls).toEqual([]);
    const said = JSON.stringify(store.get(s.id)!.transcript);
    expect(said).toContain("ended because the main agent's budget for today (710 of 500 tokens) in Usage > Budgets was reached");
  });

  it("lets calls through under every budget", async () => {
    budgets.team = { perDayTokens: 1_000_000, perMonthTokens: 10_000_000, onLimit: "stop" };
    spend("main", 10);
    const r = runner(new Scripted([() => use("c1", "ue_mcp", { action: "call", category: "level", method: "get_outliner", args: {} }), () => text("Done.")]));
    const s = store.create();
    await r.send(s.id, "look");
    expect(host.calls).toHaveLength(1);
  });
});

/**
 * The settings routes grouped by decision: instructions, budgets and the
 * context strategy other MCP clients get, against a fake daemon API.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DaemonExtensionApi } from "ue-mcp/daemon";
import { envStrategy, PHASE1_AGENTS, registerComposerRoutes, withStrategy, ymlStrategy } from "../src/composer-routes.js";
import { SettingsStore } from "../src/settings.js";
import { BudgetStore } from "../src/budgets.js";
import { PlaytestStore } from "../src/playtest-store.js";
import { PUBLISHED_SEEDS, type ClientContextStrategy, type InstructionsView } from "@ue-mcp-studio/shared";

type Handler = (req: { body?: unknown; query?: Record<string, string> }) => Promise<{ status?: number; body?: unknown }> | { status?: number; body?: unknown };
let root: string;
let routes: Map<string, Handler>;
let restarts: number;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-composer-"));
  routes = new Map();
  restarts = 0;
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function setup(extra: Record<string, unknown> = {}) {
  const data = path.join(root, "data");
  const published: string[] = [];
  const api = {
    projectDir: root,
    route: (m: string, p: string, h: Handler) => void routes.set(`${m} ${p}`, h),
    events: { publish: (t: string) => void published.push(t) },
    ...extra,
  } as unknown as DaemonExtensionApi;
  const settings = new SettingsStore(data, path.join(data, "keys"));
  const playtests = new PlaytestStore(data);
  const budgets = new BudgetStore(data, {
    turnTokenLimit: () => settings.usage().turnTokenLimit,
    setTurnTokenLimit: (n) => settings.update({ usage: { turnTokenLimit: n } }),
    playtestBudget: () => playtests.budget(),
    setPlaytestBudget: (b) => playtests.setBudget(b),
  });
  registerComposerRoutes(api, { settings, budgets, restartUeMcp: async () => void restarts++, agents: () => PHASE1_AGENTS(settings.usage().projectInstructions) });
  const call = async (key: string, body?: unknown, query: Record<string, string> = {}) => {
    const h = routes.get(key);
    if (!h) throw new Error(`no route ${key}`);
    return h({ body, query });
  };
  return { call, settings, published };
}

describe("context strategy for other clients", () => {
  it("reads ue-mcp.yml, with micro when it names none", async () => {
    const { call } = setup();
    expect((await call("GET /context-strategy")).body).toEqual({ strategy: "micro", fromFile: false, envOverride: null, seeds: PUBLISHED_SEEDS, seedSource: "ue-mcp's published figures" });
    fs.writeFileSync(path.join(root, "ue-mcp.yml"), "# mine\ncontext:\n  strategy: Lean\n");
    expect(((await call("GET /context-strategy")).body as ClientContextStrategy).strategy).toBe("lean");
  });

  it("writes the key with the file's comments kept, and restarts ue-mcp so clients get it", async () => {
    fs.writeFileSync(path.join(root, "ue-mcp.yml"), "# keep me\ndisable:\n  - feedback\n");
    const { call } = setup();
    const r = await call("PUT /context-strategy", { strategy: "full" });
    expect(r.body).toMatchObject({ strategy: "full", fromFile: true, restarting: true });
    const text = fs.readFileSync(path.join(root, "ue-mcp.yml"), "utf-8");
    expect(text).toContain("# keep me");
    expect(text).toContain("feedback");
    expect(ymlStrategy(text)).toBe("full");
    expect(restarts).toBe(1);
    // The same choice again changes nothing and restarts nothing.
    await call("PUT /context-strategy", { strategy: "full" });
    expect(restarts).toBe(1);
  });

  it("writes micro as no setting, as ue-mcp init does", () => {
    expect(withStrategy("context:\n  strategy: full\nport: 1\n", "micro")).toBe("port: 1\n");
    expect(withStrategy("context:\n  strategy: full\n  other: 1\n", "micro")).toContain("other: 1");
  });

  it("names the environment override ue-mcp honours over the file", () => {
    expect(envStrategy({ UE_MCP_CONTEXT_STRATEGY: "FULL" })).toBe("full");
    expect(envStrategy({ UE_MCP_CONTEXT_STRATEGY: "huge" })).toBeNull();
    expect(envStrategy({})).toBeNull();
  });

  it("refuses a strategy it does not know", async () => {
    expect((await setup().call("PUT /context-strategy", { strategy: "tiny" })).status).toBe(400);
  });

  it("measures each strategy with the daemon's projection when it has one", async () => {
    const tokens = { micro: 2100, lean: 18500, full: 50200 };
    const { call } = setup({ context: { project: ({ strategy }: { strategy: keyof typeof tokens }) => ({ seedTokens: tokens[strategy] }) } });
    expect((await call("GET /context-strategy")).body).toMatchObject({ seeds: tokens, seedSource: "measured by this ue-mcp" });
  });
});

describe("instruction routes", () => {
  it("lists files, turns one off, and previews what the main agent gets", async () => {
    fs.writeFileSync(path.join(root, "AGENTS.md"), "Shared rules.");
    fs.writeFileSync(path.join(root, "GEMINI.md"), "Gemini only.");
    const { call } = setup();
    let v = (await call("GET /instructions")).body as InstructionsView;
    expect(v.files.map((f) => [f.path, f.readBy])).toEqual([["GEMINI.md", ["main", "playtest-runner"]], ["AGENTS.md", ["main", "playtest-runner"]]]);
    v = (await call("PUT /instructions", { off: ["GEMINI.md"] })).body as InstructionsView;
    expect(v.files.find((f) => f.path === "GEMINI.md")).toMatchObject({ on: false, readBy: [] });
    const p = (await call("GET /instructions/preview", undefined, { agent: "main" })).body as { text: string };
    expect(p.text).toContain("Shared rules.");
    expect(p.text).not.toContain("Gemini only.");
    expect((await call("GET /instructions/preview", undefined, { agent: "nobody" })).status).toBe(404);
    expect((await call("PUT /instructions", { off: "GEMINI.md" })).status).toBe(400);
  });

  it("follows the old switch: none when the agent was told not to read the project's files", async () => {
    fs.writeFileSync(path.join(root, "AGENTS.md"), "Shared rules.");
    const { call, settings } = setup();
    settings.update({ usage: { projectInstructions: false } });
    expect(((await call("GET /instructions/preview")).body as { text: string }).text).toBe("");
  });

  it("creates AGENTS.md once", async () => {
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "Claude rules.");
    const { call, published } = setup();
    const r = await call("POST /instructions/agents-md", { point: ["CLAUDE.md"] });
    expect(r.status).toBe(201);
    expect((r.body as { view: InstructionsView }).view.hasAgentsMd).toBe(true);
    expect(published).toContain("instructions.changed");
    expect((await call("POST /instructions/agents-md", {})).status).toBe(409);
  });
});

describe("budget routes", () => {
  it("give the definition and the rows, and save a change", async () => {
    const { call, published } = setup();
    const g = (await call("GET /budgets")).body as { definition: string; agents: Array<{ id: string }>; budgets: { agents: Record<string, unknown> } };
    expect(g.definition).toMatch(/Cached reads are left out/);
    expect(g.agents.map((a) => a.id)).toEqual(["main", "playtest-runner"]);
    const r = await call("PUT /budgets", { agents: { main: { perRunTokens: 400_000 } } });
    expect((r.body as { budgets: { agents: { main: { perRunTokens: number } } } }).budgets.agents.main.perRunTokens).toBe(400_000);
    expect(published).toContain("budgets.changed");
    expect((await call("PUT /budgets", { agents: { main: { perRunTokens: 3 } } })).status).toBe(400);
  });
});

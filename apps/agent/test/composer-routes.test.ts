/**
 * The settings routes grouped by decision: the context strategy other MCP clients get, against a fake daemon API.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DaemonExtensionApi } from "ue-mcp/daemon";
import { envStrategy, registerComposerRoutes, withStrategy, ymlStrategy } from "../src/composer-routes.js";
import { ContextSurfaces, contextApiOf } from "../src/context-surface.js";
import { SettingsStore } from "../src/settings.js";
import type { ClientContextStrategy } from "@ue-mcp-studio/shared";

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

const SEEDS = { micro: 2100, lean: 18500, full: 50200 };
const CONTEXT = {
  project: (o: { strategy: "micro" | "lean" | "full" }) => ({ strategy: o.strategy, categories: [], instructions: "", tools: [], seedTokens: SEEDS[o.strategy] }),
  call: async () => ({ isError: false, content: [] }),
};

function setup(extra: Record<string, unknown> = {}) {
  const data = path.join(root, "data");
  const published: string[] = [];
  const api = {
    projectDir: root,
    route: (m: string, p: string, h: Handler) => void routes.set(`${m} ${p}`, h),
    events: { publish: (t: string) => void published.push(t) },
    context: CONTEXT,
    ...extra,
  } as unknown as DaemonExtensionApi;
  const settings = new SettingsStore(data, path.join(data, "keys"));
  // Studio's own agent's strategy reads back through the same surfaces chat-routes builds.
  const surfaces = new ContextSurfaces(contextApiOf(api), () => settings.usage().contextStrategy, () => settings.provider(), () => null);
  registerComposerRoutes(api, { settings, restartUeMcp: async () => void restarts++, agentContext: surfaces });
  const call = async (key: string, body?: unknown, query: Record<string, string> = {}) => {
    const h = routes.get(key);
    if (!h) throw new Error(`no route ${key}`);
    return h({ body, query });
  };
  return { call, settings, published };
}

describe("context strategy for Studio's own agent", () => {
  it("is kept in Studio's settings, never in ue-mcp.yml", async () => {
    const { call, settings } = setup();
    expect((await call("GET /context-strategy/agent")).body).toMatchObject({ strategy: "micro", effective: "micro", measurement: null });
    const r = await call("PUT /context-strategy/agent", { strategy: "lean" });
    expect(r.body).toMatchObject({ strategy: "lean", effective: "lean", note: null });
    expect(settings.usage().contextStrategy).toBe("lean");
    expect(fs.existsSync(path.join(root, "ue-mcp.yml"))).toBe(false);
  });

  it("refuses an unknown strategy, and Auto while no measurement ships", async () => {
    const { call } = setup();
    expect((await call("PUT /context-strategy/agent", { strategy: "warp" })).status).toBe(400);
    expect((await call("PUT /context-strategy/agent", { strategy: "auto" })).body).toEqual({ error: "auto needs a measurement, and none ships with this Studio" });
  });

  it("shows each strategy's seed tokens from the daemon's projection", async () => {
    const { call } = setup();
    expect((await call("PUT /context-strategy/agent", { strategy: "full" })).body).toMatchObject({ strategy: "full", effective: "full", seeds: SEEDS, note: null });
  });
});

describe("context strategy for other clients", () => {
  it("reads ue-mcp.yml, with micro when it names none", async () => {
    const { call } = setup();
    expect((await call("GET /context-strategy")).body).toEqual({ strategy: "micro", fromFile: false, envOverride: null, seeds: SEEDS });
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

});


import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DaemonExtensionApi } from "ue-mcp/daemon";
import { registerAgentSettings } from "../src/agent-settings.js";
import { PlaytestStore } from "../src/playtest-store.js";

type Handler = (req: { body?: unknown }) => Promise<{ status?: number; body?: unknown }> | { status?: number; body?: unknown };
let root: string;
let routes: Map<string, Handler>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-runs-"));
  routes = new Map();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function setup() {
  const api = { projectDir: root, route: (m: string, p: string, h: Handler) => void routes.set(`${m} ${p}`, h) } as unknown as DaemonExtensionApi;
  const store = new PlaytestStore(path.join(root, "data"));
  registerAgentSettings(api, async () => {}, store);
  return { get: () => routes.get("GET /agent-settings")!({}), put: (body: unknown) => routes.get("PUT /agent-settings")!({ body }) };
}

describe("the Playtest runs setting", () => {
  it("is Manual for a project that never chose", async () => {
    expect(((await setup().get()).body as { playtestRuns: string }).playtestRuns).toBe("manual");
  });

  it("saves Automatic and Manual for this project, kept across a restart", async () => {
    const s = setup();
    expect(((await s.put({ playtestRuns: "automatic" })).body as { playtestRuns: string }).playtestRuns).toBe("automatic");
    expect(new PlaytestStore(path.join(root, "data")).runs()).toBe("automatic");
    expect(((await setup().get()).body as { playtestRuns: string }).playtestRuns).toBe("automatic");
    await s.put({ playtestRuns: "manual" });
    expect(new PlaytestStore(path.join(root, "data")).runs()).toBe("manual");
  });

  it("refuses a mode it does not know", async () => {
    expect((await setup().put({ playtestRuns: "always" })).status).toBe(400);
  });
});

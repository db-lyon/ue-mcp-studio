import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { DaemonExtensionApi } from "ue-mcp/daemon";
import { floorRefusal, registerRefusal } from "../src/floor.js";

describe("Studio's ue-mcp floor", () => {
  it("refuses a ue-mcp older than the floor", () => {
    expect(floorRefusal("1.4.11-beta.6", "1.4.11-beta.5", {})).toEqual({ needs: "1.4.11-beta.6", have: "1.4.11-beta.5" });
    expect(floorRefusal("1.4.11-beta.6", "1.4.10", {})).toEqual({ needs: "1.4.11-beta.6", have: "1.4.10" });
  });

  it("runs on the floor and anything newer", () => {
    expect(floorRefusal("1.4.11-beta.6", "1.4.11-beta.6", {})).toBeNull();
    expect(floorRefusal("1.4.11-beta.6", "1.4.11-beta.10", {})).toBeNull();
    expect(floorRefusal("1.4.11-beta.6", "1.4.11", {})).toBeNull();
  });

  it("runs anyway under UE_MCP_EXTENSION_FLOOR=warn, as ue-mcp does", () => {
    expect(floorRefusal("1.4.11-beta.6", "1.4.10", { UE_MCP_EXTENSION_FLOOR: "warn" })).toBeNull();
  });

  it("registers only the refusal routes: what Studio needs, and the update that meets it", async () => {
    const { api, routes, warnings } = refusedApi();
    registerRefusal(api, { needs: "1.4.11-beta.6", have: "1.4.10" });
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /refusal", "POST /refusal/update"]);
    expect(await routes[0].handler({})).toEqual({ body: { needs: "1.4.11-beta.6", have: "1.4.10" } });
    expect(warnings[0]).toContain("needs ue-mcp 1.4.11-beta.6");
  });

  it("updates through the target release's own CLI, not this daemon's apply", async () => {
    const { api, routes } = refusedApi();
    const asked: string[] = [];
    registerRefusal(api, { needs: "1.4.11-beta.6", have: "1.4.10" }, async (v) => (asked.push(v), { ok: true }));
    const update = routes.find((r) => r.path === "/refusal/update")!;
    expect(await update.handler({ body: { version: "1.4.11-beta.8" } })).toEqual({ body: { ok: true, version: "1.4.11-beta.8" } });
    expect(asked).toEqual(["1.4.11-beta.8"]);
  });

  it("answers the CLI's own error, and one update at a time", async () => {
    const { api, routes } = refusedApi();
    let finish: (r: { ok: boolean; error?: string }) => void = () => {};
    registerRefusal(api, { needs: "1.4.11-beta.6", have: "1.4.10" }, () => new Promise((r) => (finish = r)));
    const update = routes.find((r) => r.path === "/refusal/update")!;
    const first = update.handler({ body: { version: "1.4.11-beta.8" } });
    expect(await update.handler({ body: { version: "1.4.11-beta.8" } })).toEqual({ status: 409, body: { ok: false, error: "an update is already running" } });
    const said = "ue-mcp 1.4.11-beta.8 update exited with 1:\nno prebuilt bridge for UE 5.7";
    finish({ ok: false, error: said });
    expect(await first).toEqual({ status: 500, body: { ok: false, error: said } });
  });

  it("refuses a version that is not one, through the updater, before anything runs", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-floor-"));
    fs.writeFileSync(path.join(dir, "Game.uproject"), "{}");
    const { api, routes } = refusedApi(dir);
    registerRefusal(api, { needs: "1.4.11-beta.6", have: "1.4.10" });
    const update = routes.find((r) => r.path === "/refusal/update")!;
    expect(await update.handler({ body: { version: "latest && calc" } })).toEqual({ status: 500, body: { ok: false, error: "not a version: latest && calc" } });
  });
});

function refusedApi(projectDir = os.tmpdir()) {
  const routes: Array<{ method: string; path: string; handler: (req: { body?: unknown }) => unknown }> = [];
  const warnings: string[] = [];
  const api = {
    projectDir,
    route: (method: string, path: string, handler: (req: { body?: unknown }) => unknown) => void routes.push({ method, path, handler }),
    log: { info: () => {}, warn: (m: string) => void warnings.push(m) },
  } as unknown as DaemonExtensionApi;
  return { api, routes, warnings };
}

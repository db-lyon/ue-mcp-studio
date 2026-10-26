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

  it("registers only the refusal route, which says what Studio needs", async () => {
    const routes: Array<{ method: string; path: string; handler: () => unknown }> = [];
    const warnings: string[] = [];
    const api = {
      route: (method: string, path: string, handler: () => unknown) => void routes.push({ method, path, handler }),
      log: { info: () => {}, warn: (m: string) => void warnings.push(m) },
    } as unknown as DaemonExtensionApi;
    registerRefusal(api, { needs: "1.4.11-beta.6", have: "1.4.10" });
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /refusal"]);
    expect(await routes[0].handler()).toEqual({ body: { needs: "1.4.11-beta.6", have: "1.4.10" } });
    expect(warnings[0]).toContain("needs ue-mcp 1.4.11-beta.6");
  });
});

/**
 * What Studio hands the daemon's hub: only where the daemon offers the hub,
 * and only signals (the switch, presence and its own agents' editor calls).
 */
import { describe, expect, it, vi } from "vitest";
import type { DaemonExtensionApi, HubClientOptions } from "ue-mcp/daemon";
import { configureHub, type HubBridgeOptions } from "../src/hub-bridge.js";

function setup(features: string[], hub = true) {
  let given: HubClientOptions | null = null;
  const off = vi.fn();
  const api = {
    features,
    ...(hub ? { hub: { configure: (o: HubClientOptions) => ((given = o), off) } } : {}),
  } as unknown as DaemonExtensionApi;
  const o: HubBridgeOptions = {
    api,
    enabled: () => true,
    inputAgeMs: () => 5,
    busy: () => ({
      now: 0,
      calls: [
        { id: 1, category: "asset", action: "list", startedAt: 0, source: "studio", sessionId: "s1", stopped: false },
        { id: 2, category: "level", action: "save", startedAt: 0, source: "client", client: "cli", stopped: false },
      ],
    }) as never,
  };
  return { given: () => given, off, o };
}

describe("configureHub", () => {
  it("hands the hub Studio's signals and takes them back", () => {
    const t = setup(["hub"]);
    const back = configureHub(t.o);
    const c = t.given()!;
    expect(c.enabled?.()).toBe(true);
    expect(c.inputAgeMs?.()).toBe(5);
    // Only Studio's own agents' calls: the daemon already sees other MCP clients'.
    expect(c.agentCalls?.()).toEqual([{ id: 1, category: "asset", action: "list", startedAt: 0, source: "agent", sessionId: "s1", stopped: false }]);
    expect(Object.keys(c).sort()).toEqual(["agentCalls", "enabled", "inputAgeMs"]);
    back();
    expect(t.off).toHaveBeenCalled();
  });

  it("does nothing where the daemon has no hub", () => {
    const t = setup(["flows.stepApproval"]);
    configureHub(t.o)();
    expect(t.given()).toBeNull();
    const none = setup(["hub"], false);
    configureHub(none.o)();
    expect(none.given()).toBeNull();
  });
});

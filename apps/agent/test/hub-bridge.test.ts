/**
 * What Studio hands the daemon's hub: only where the daemon offers the hub,
 * and Studio's own settings, account and fix loop as the hub's pieces.
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
    events: { publish: vi.fn() },
    callAction: vi.fn(),
  } as unknown as DaemonExtensionApi;
  const run = { runId: "r1", script: "/Game/T/Door", assignment: { state: "running", sessionId: "s1" } };
  const qa = {
    all: () => [run],
    cancel: vi.fn(() => ({ run })),
    onSaved: vi.fn(() => () => {}),
  };
  const o = {
    api,
    qa,
    store: { create: vi.fn(() => ({ id: "s9", status: "idle" })), get: vi.fn() },
    writePlaytests: vi.fn(async () => {}),
    playtestRuns: () => "manual" as const,
    signer: () => "dev",
    enabled: () => true,
    inputAgeMs: () => 5,
  } as unknown as HubBridgeOptions;
  return { given: () => given, off, qa, o };
}

describe("configureHub", () => {
  it("hands the daemon's hub Studio's pieces, and gives them back", async () => {
    const t = setup(["hub"]);
    const back = configureHub(t.o);
    const c = t.given()!;
    expect(c.signer?.()).toBe("dev");
    expect(c.enabled?.()).toBe(true);
    expect(c.playtestRuns?.()).toBe("manual");
    expect(c.inputAgeMs?.()).toBe(5);
    expect(c.broker && c.fixer && c.writePlaytests && c.replay).toBeTruthy();
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

  it("runs the /playtest flow in a session of its own for a goal", async () => {
    const t = setup(["hub"]);
    configureHub(t.o);
    const w = t.given()!.writePlaytests!({ title: "Playtests for Tutorial", text: "write one" });
    expect(w.sessionId).toBe("s9");
    await w.done;
    expect((t.o as unknown as { writePlaytests: ReturnType<typeof vi.fn> }).writePlaytests).toHaveBeenCalledWith("s9", "write one");
  });

  it("names the scripts whose fix loops run, and stops one by its item", () => {
    const t = setup(["hub"]);
    configureHub(t.o);
    const fixer = t.given()!.fixer!;
    expect([...fixer.running()]).toEqual(["/Game/T/Door"]);
    const item = { check: { kind: "script", target: "/Game/T/Door" }, name: "Door", sessionId: "s1" } as never;
    expect(fixer.stop(item)).toBeNull();
    expect(t.qa.cancel).toHaveBeenCalledWith("r1");
  });
});

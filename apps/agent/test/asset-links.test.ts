import { describe, expect, it, vi } from "vitest";
import type { ActionResult } from "ue-mcp/daemon";
import { classifyAssetToken, type TranscriptEntry } from "@ue-mcp-studio/shared";
import { AssetResolver, BUSY_AFTER_MS, LOOKUPS_PER_REQUEST, MISSING_TTL_MS, knownPaths, openAsset } from "../src/asset-links.js";

const json = (v: unknown): ActionResult => ({ isError: false, content: [{ type: "text", text: JSON.stringify(v) }] });
const fail = (text: string): ActionResult => ({ isError: true, content: [{ type: "text", text }] });

/** A disk of package paths, answered the way list_content_assets does. */
function disk(paths: string[]) {
  const callAction = vi.fn(async (_c: string, _a: string, args: Record<string, unknown> = {}) => {
    const root = String(args.contentPath ?? "/Game");
    const pattern = typeof args.namePattern === "string" ? args.namePattern.toLowerCase() : "";
    const assets = paths
      .filter((p) => p.startsWith(`${root}/`) && (args.recursive !== false || !p.slice(root.length + 1).includes("/")))
      .map((p) => ({ assetPath: p, name: p.slice(p.lastIndexOf("/") + 1) }))
      .filter((a) => a.name.toLowerCase().includes(pattern));
    return json({ contentPath: root, count: assets.length, truncated: false, assets });
  });
  return { callAction };
}

describe("which tokens name an asset", () => {
  it("takes asset-style names and object paths, and leaves plain words and code alone", () => {
    expect(classifyAssetToken("SG_PlaceAssembly")).toEqual({ kind: "name", name: "SG_PlaceAssembly" });
    expect(classifyAssetToken("PlaceAssembly")).toEqual({ kind: "name", name: "PlaceAssembly" });
    expect(classifyAssetToken("BP_AI")).toEqual({ kind: "name", name: "BP_AI" });
    expect(classifyAssetToken("/Game/PCG/SG_PlaceAssembly")).toMatchObject({ kind: "path", packagePath: "/Game/PCG/SG_PlaceAssembly", name: "SG_PlaceAssembly" });
    expect(classifyAssetToken("/MyPlugin/Maps/L_Test.L_Test")).toMatchObject({ kind: "path", packagePath: "/MyPlugin/Maps/L_Test" });
    for (const t of ["Owner", "owner", "MAX_SIZE", "UE_LOG", "AActor", "FVector", "UObject", "npm run build", "foo()", "Build.cs",
      "/Game/Foo/Bar.uasset", "/usr/bin/env", "/C/Users/me", "/Script/Engine.Actor", "assetPath", "x"]) {
      expect(classifyAssetToken(t), t).toBeNull();
    }
  });
});

describe("resolving asset names", () => {
  it("finds a bare name on disk by its exact name, not a longer one", async () => {
    const host = disk(["/Game/PCG/SG_PlaceAssembly", "/Game/PCG/SG_PlaceAssemblyOld"]);
    const r = new AssetResolver(host);
    expect(await r.resolve(["SG_PlaceAssembly", "Owner"])).toEqual({
      SG_PlaceAssembly: { status: "resolved", paths: ["/Game/PCG/SG_PlaceAssembly.SG_PlaceAssembly"] },
      Owner: { status: "unresolved" },
    });
    expect(host.callAction).toHaveBeenCalledWith("project", "list_content_assets", { contentPath: "/Game", namePattern: "SG_PlaceAssembly", maxResults: 500 });
  });

  it("returns every match for a name used twice, for the chooser", async () => {
    const r = new AssetResolver(disk(["/Game/A/M_Rock", "/Game/B/M_Rock"]));
    expect(await r.resolve(["M_Rock"])).toEqual({ M_Rock: { status: "resolved", paths: ["/Game/A/M_Rock.M_Rock", "/Game/B/M_Rock.M_Rock"] } });
  });

  it("starts from the paths the session already knows, with no lookup", async () => {
    const host = disk([]);
    const r = new AssetResolver(host);
    expect(await r.resolve(["BP_Door"], ["/Game/Doors/BP_Door"])).toEqual({ BP_Door: { status: "resolved", paths: ["/Game/Doors/BP_Door.BP_Door"] } });
    expect(host.callAction).not.toHaveBeenCalled();
  });

  it("checks full paths against their folder, one listing for every path in it", async () => {
    const host = disk(["/Game/PCG/SG_A", "/Game/PCG/SG_B"]);
    const r = new AssetResolver(host);
    expect(await r.resolve(["/Game/PCG/SG_A", "/Game/PCG/SG_B.SG_B", "/Game/PCG/Missing"])).toEqual({
      "/Game/PCG/SG_A": { status: "resolved", paths: ["/Game/PCG/SG_A.SG_A"] },
      "/Game/PCG/SG_B.SG_B": { status: "resolved", paths: ["/Game/PCG/SG_B.SG_B"] },
      "/Game/PCG/Missing": { status: "unresolved" },
    });
    expect(host.callAction).toHaveBeenCalledTimes(1);
  });

  it("caches answers, asks again for a miss after a while or after a call finishes", async () => {
    let clock = 0;
    const paths = ["/Game/X/BP_Old"];
    const host = disk(paths);
    const r = new AssetResolver(host, () => clock);
    await r.resolve(["BP_Old", "BP_New"]);
    await r.resolve(["BP_Old", "BP_New"]);
    expect(host.callAction).toHaveBeenCalledTimes(2);
    paths.push("/Game/X/BP_New");
    r.forgetMissing();
    expect((await r.resolve(["BP_New"])).BP_New).toEqual({ status: "resolved", paths: ["/Game/X/BP_New.BP_New"] });
    expect(host.callAction).toHaveBeenCalledTimes(3);
    await r.resolve(["BP_Gone"]);
    await r.resolve(["BP_Gone"]);
    expect(host.callAction).toHaveBeenCalledTimes(4);
    clock += MISSING_TTL_MS + 1;
    await r.resolve(["BP_Old", "BP_New", "BP_Gone"]);
    // The finds are still trusted; only the miss is asked again.
    expect(host.callAction).toHaveBeenCalledTimes(5);
  });

  it("answers retry, not unresolved, when a lookup fails, and caches nothing", async () => {
    const callAction = vi.fn(async () => { throw new Error("daemon busy"); });
    const r = new AssetResolver({ callAction });
    expect(await r.resolve(["BP_Door"])).toEqual({ BP_Door: { status: "retry" } });
    callAction.mockImplementation(async () => json({ assets: [{ assetPath: "/Game/BP_Door", name: "BP_Door" }] }));
    expect(await r.resolve(["BP_Door"])).toEqual({ BP_Door: { status: "resolved", paths: ["/Game/BP_Door.BP_Door"] } });
  });

  it("caps the lookups one request starts and how many run at once", async () => {
    let running = 0;
    let most = 0;
    const callAction = vi.fn(async () => {
      most = Math.max(most, ++running);
      await new Promise((res) => setTimeout(res, 1));
      running--;
      return json({ assets: [] });
    });
    const r = new AssetResolver({ callAction });
    const tokens = Array.from({ length: LOOKUPS_PER_REQUEST + 5 }, (_, i) => `BP_Thing${i}`);
    const out = await r.resolve(tokens);
    expect(callAction).toHaveBeenCalledTimes(LOOKUPS_PER_REQUEST);
    expect(Object.values(out).filter((x) => x.status === "retry")).toHaveLength(5);
    expect(most).toBeLessThanOrEqual(2);
  });

  it("reads known paths from what a session touched and what its calls named", () => {
    const transcript: TranscriptEntry[] = [
      { kind: "tool", call: { id: "1", name: "ue_mcp", input: { action: "call", category: "pcg", method: "read", args: { assetPath: "/Game/PCG/SG_A" } }, outcome: "done", startedAt: "" } },
    ];
    expect(knownPaths({ touched: [{ kind: "asset", path: "/Game/B" }, { kind: "actor", path: "Cube" }], transcript }).sort()).toEqual(["/Game/B", "/Game/PCG/SG_A"]);
  });
});

describe("opening an asset", () => {
  const idle = () => ({ now: 10_000, calls: [] });
  const base = (callAction: (c: string, a: string, args?: Record<string, unknown>) => Promise<ActionResult>) => ({
    host: { callAction: vi.fn(callAction) },
    connected: () => true,
    busy: idle,
    track: <T>(f: () => Promise<T>) => f(),
  });

  it("opens the object path through editor.open_asset", async () => {
    const o = base(async () => json({ success: true, alreadyOpen: false }));
    expect(await openAsset(o, "/Game/PCG/SG_A")).toEqual({ status: 200, body: { path: "/Game/PCG/SG_A.SG_A", alreadyOpen: false } });
    expect(o.host.callAction).toHaveBeenCalledWith("editor", "open_asset", { assetPath: "/Game/PCG/SG_A.SG_A" });
  });

  it("refuses without calling while the editor is down or busy", async () => {
    const o = base(async () => json({ success: true }));
    expect(await openAsset({ ...o, connected: () => false }, "/Game/A")).toEqual({ status: 503, body: { error: "Editor not running" } });
    const busy = () => ({ now: 10_000, calls: [{ id: 1, category: "pcg", action: "generate", source: "studio" as const, startedAt: 10_000 - BUSY_AFTER_MS, stopped: false }] });
    expect(await openAsset({ ...o, busy }, "/Game/A")).toEqual({ status: 409, body: { error: "Editor busy" } });
    expect(o.host.callAction).not.toHaveBeenCalled();
  });

  it("says Asset not found for a path the editor cannot load", async () => {
    const o = base(async () => fail("Failed to load asset at '/Game/Gone.Gone'"));
    expect(await openAsset(o, "/Game/Gone")).toEqual({ status: 404, body: { error: "Asset not found" } });
  });

  it("refuses what is not an object path", async () => {
    const o = base(async () => json({}));
    expect((await openAsset(o, "SG_A")).status).toBe(400);
    expect((await openAsset(o, 5)).status).toBe(400);
  });
});

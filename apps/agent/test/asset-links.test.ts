import { describe, expect, it, vi } from "vitest";
import type { ActionResult } from "ue-mcp/daemon";
import { assetLinkTarget, classifyAssetToken, type AssetRef, type ToolCallRecord, type TranscriptEntry } from "@ue-mcp-studio/shared";
import { AssetResolver, BUSY_AFTER_MS, LOOKUPS_PER_REQUEST, MISSING_TTL_MS, callRefs, missLine, openAsset, traceName, type Trace } from "../src/asset-links.js";

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

/** Resolve bare tokens with no message anchor, results keyed by token. */
async function byToken(r: AssetResolver, tokens: string[], trace?: (name: string, at?: number) => Trace) {
  const out = await r.resolve(tokens.map((token) => ({ token })), trace);
  return Object.fromEntries(tokens.map((t, i) => [t, out[i]]));
}

describe("markdown asset links", () => {
  it("take every path form and nothing else", () => {
    expect(assetLinkTarget("/Game/Env/PCG/Library/SG_A.SG_A")).toBe("/Game/Env/PCG/Library/SG_A.SG_A");
    expect(assetLinkTarget("/Game/Env/PCG/Library/SG_A")).toBe("/Game/Env/PCG/Library/SG_A.SG_A");
    expect(assetLinkTarget("/Game/Env/BP_Door.BP_Door:Mesh")).toBe("/Game/Env/BP_Door.BP_Door");
    expect(assetLinkTarget("/MyPlugin/Maps/L_Test")).toBe("/MyPlugin/Maps/L_Test.L_Test");
    for (const u of ["https://example.com/Game/A", "//Game/A/B", "/Game/A/B.uasset", "/Script/Engine.Actor", "SG_A", "/Game/A/B.C", "mailto:x"]) {
      expect(assetLinkTarget(u), u).toBeNull();
    }
  });
});

const call = (id: string, input: unknown, result?: string, outcome: ToolCallRecord["outcome"] = "done"): TranscriptEntry =>
  ({ kind: "tool", call: { id, name: "ue_mcp", input, result, outcome, startedAt: "" } });
const ue = (category: string, method: string, args: Record<string, unknown>) => ({ action: "call", category, method, args });
const LIB = "/Game/Environment/PCG/Library/SG_PlaceChildAssembly";
const REG = "/Game/Environment/PCG/Region/SG_PlaceChildAssembly";
const say = (text: string): TranscriptEntry => ({ kind: "assistant", text, at: "" });
const user = (text: string): TranscriptEntry => ({ kind: "user", text, at: "" });

describe("tracing a name through the session", () => {
  it("links the one of two same-named assets the session touched", () => {
    const t = [user("fix it"), call("1", ue("pcg", "get_graph", { assetPath: LIB }), '{"nodes":[]}'), say("`SG_PlaceChildAssembly` is fixed.")];
    expect(traceName(t, "SG_PlaceChildAssembly", 2)).toEqual({ status: "found", paths: [`${LIB}.SG_PlaceChildAssembly`] });
  });

  it("takes a duplicate's copy as its own path, over its source", () => {
    const dup = call("1", ue("asset", "duplicate", { sourcePath: LIB, destinationPath: REG }), JSON.stringify({ created: true, sourcePath: LIB, destinationPath: REG }));
    expect(callRefs((dup as { call: ToolCallRecord }).call, "SG_PlaceChildAssembly")).toEqual([`${REG}.SG_PlaceChildAssembly`]);
    const made = call("2", ue("asset", "duplicate", { sourcePath: "/Game/Environment/PCG/Library/SG_PlaceAssembly", destinationPath: LIB }), '{"created":true}');
    const t = [user("copy it"), made, say("Made `SG_PlaceChildAssembly` from `SG_PlaceAssembly`.")];
    expect(traceName(t, "SG_PlaceChildAssembly", 2)).toEqual({ status: "found", paths: [`${LIB}.SG_PlaceChildAssembly`] });
    expect(traceName(t, "SG_PlaceAssembly", 2)).toEqual({ status: "found", paths: ["/Game/Environment/PCG/Library/SG_PlaceAssembly.SG_PlaceAssembly"] });
  });

  it("lets the most recent reference before the message win", () => {
    const t = [
      call("1", ue("pcg", "get_graph", { assetPath: REG })),
      call("2", ue("pcg", "get_graph", { assetPath: `${LIB}.SG_PlaceChildAssembly` })),
      say("`SG_PlaceChildAssembly`"),
      call("3", ue("pcg", "get_graph", { assetPath: REG })),
      say("`SG_PlaceChildAssembly`"),
    ];
    expect(traceName(t, "SG_PlaceChildAssembly", 2)).toEqual({ status: "found", paths: [`${LIB}.SG_PlaceChildAssembly`] });
    expect(traceName(t, "SG_PlaceChildAssembly", 4)).toEqual({ status: "found", paths: [`${REG}.SG_PlaceChildAssembly`] });
  });

  it("finds paths in results, and counts a subagent's calls", () => {
    const sub: TranscriptEntry = { ...call("s1", ue("asset", "search", { query: "child" }), JSON.stringify({ assets: [{ path: LIB }, { path: "/Game/X/BP_Other" }] })), parent: "a1" };
    const t = [user("find it"), call("a1", { prompt: "find the child assembly" }), sub, say("Found `SG_PlaceChildAssembly`.")];
    expect(traceName(t, "SG_PlaceChildAssembly", 3)).toEqual({ status: "found", paths: [`${LIB}.SG_PlaceChildAssembly`] });
  });

  it("looks at the rest of the message's turn when nothing came before it, and waits while that turn runs", () => {
    const t = [user("go"), say("Opening `SG_PlaceChildAssembly`."), call("1", ue("editor", "open_asset", { assetPath: LIB })), user("next"), call("2", ue("editor", "open_asset", { assetPath: REG }))];
    expect(traceName(t, "SG_PlaceChildAssembly", 1)).toEqual({ status: "found", paths: [`${LIB}.SG_PlaceChildAssembly`] });
    expect(traceName([user("go"), say("`SG_PlaceChildAssembly`")], "SG_PlaceChildAssembly", 1, true)).toEqual({ status: "open" });
    expect(traceName([user("go"), say("`SG_PlaceChildAssembly`")], "SG_PlaceChildAssembly", 1, false)).toEqual({ status: "none" });
  });

  it("gives every path one call names when that call does not say which, and ignores declined calls", () => {
    const listed = call("1", ue("project", "list_content_assets", { namePattern: "SG_PlaceChildAssembly" }), JSON.stringify({ assets: [{ assetPath: LIB }, { assetPath: REG }] }));
    expect(traceName([listed, say("x")], "SG_PlaceChildAssembly", 1)).toEqual({ status: "found", paths: [`${LIB}.SG_PlaceChildAssembly`, `${REG}.SG_PlaceChildAssembly`] });
    const declined = call("2", ue("asset", "delete", { assetPath: LIB }), undefined, "declined");
    expect(traceName([declined, say("x")], "SG_PlaceChildAssembly", 1)).toEqual({ status: "none" });
  });
});

describe("resolving asset names", () => {
  const traced = (t: TranscriptEntry[]) => (name: string, at?: number) => traceName(t, name, at);

  it("resolves a traced name with no project lookup, even when the project has two", async () => {
    const host = disk([LIB, REG]);
    const r = new AssetResolver(host);
    const t = [call("1", ue("pcg", "get_graph", { assetPath: LIB })), say("`SG_PlaceChildAssembly`")];
    expect(await r.resolve([{ token: "SG_PlaceChildAssembly", at: 1 }], traced(t))).toEqual([{ status: "resolved", paths: [`${LIB}.SG_PlaceChildAssembly`] }]);
    expect(host.callAction).not.toHaveBeenCalled();
  });

  it("links an untraced name on exactly one project match", async () => {
    const host = disk(["/Game/PCG/SG_PlaceAssembly", "/Game/PCG/SG_PlaceAssemblyOld"]);
    const r = new AssetResolver(host);
    expect(await byToken(r, ["SG_PlaceAssembly", "Owner"])).toEqual({
      SG_PlaceAssembly: { status: "resolved", paths: ["/Game/PCG/SG_PlaceAssembly.SG_PlaceAssembly"] },
      Owner: { status: "unresolved" },
    });
    expect(host.callAction).toHaveBeenCalledWith("project", "list_content_assets", { contentPath: "/Game", namePattern: "SG_PlaceAssembly", maxResults: 500 });
  });

  it("returns every project match for an untraced name used twice, for the chooser", async () => {
    const r = new AssetResolver(disk([LIB, REG]));
    expect(await byToken(r, ["SG_PlaceChildAssembly"])).toEqual({ SG_PlaceChildAssembly: { status: "resolved", paths: [`${LIB}.SG_PlaceChildAssembly`, `${REG}.SG_PlaceChildAssembly`] } });
  });

  it("asks again later for a name whose turn is still running", async () => {
    const host = disk([LIB]);
    const r = new AssetResolver(host);
    expect(await r.resolve([{ token: "SG_PlaceChildAssembly", at: 1 }], () => ({ status: "open" }))).toEqual([{ status: "retry" }]);
    expect(host.callAction).not.toHaveBeenCalled();
  });

  it("answers the same name per message, in request order", async () => {
    const r = new AssetResolver(disk([]));
    const t = [call("1", ue("pcg", "get_graph", { assetPath: REG })), say("a"), call("2", ue("pcg", "get_graph", { assetPath: LIB })), say("b")];
    const refs: AssetRef[] = [{ token: "SG_PlaceChildAssembly", at: 3 }, { token: "SG_PlaceChildAssembly", at: 1 }];
    expect(await r.resolve(refs, traced(t))).toEqual([
      { status: "resolved", paths: [`${LIB}.SG_PlaceChildAssembly`] },
      { status: "resolved", paths: [`${REG}.SG_PlaceChildAssembly`] },
    ]);
  });

  it("checks full paths against their folder, one listing for every path in it", async () => {
    const host = disk(["/Game/PCG/SG_A", "/Game/PCG/SG_B"]);
    const r = new AssetResolver(host);
    expect(await byToken(r, ["/Game/PCG/SG_A", "/Game/PCG/SG_B.SG_B", "/Game/PCG/Missing"])).toEqual({
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
    await byToken(r, ["BP_Old", "BP_New"]);
    await byToken(r, ["BP_Old", "BP_New"]);
    expect(host.callAction).toHaveBeenCalledTimes(2);
    paths.push("/Game/X/BP_New");
    r.forgetMissing();
    expect((await byToken(r, ["BP_New"])).BP_New).toEqual({ status: "resolved", paths: ["/Game/X/BP_New.BP_New"] });
    expect(host.callAction).toHaveBeenCalledTimes(3);
    await byToken(r, ["BP_Gone"]);
    await byToken(r, ["BP_Gone"]);
    expect(host.callAction).toHaveBeenCalledTimes(4);
    clock += MISSING_TTL_MS + 1;
    await byToken(r, ["BP_Old", "BP_New", "BP_Gone"]);
    // The finds are still trusted; only the miss is asked again.
    expect(host.callAction).toHaveBeenCalledTimes(5);
  });

  it("answers retry, not unresolved, when a lookup fails, and caches nothing", async () => {
    const callAction = vi.fn(async () => { throw new Error("daemon busy"); });
    const r = new AssetResolver({ callAction });
    expect(await byToken(r, ["BP_Door"])).toEqual({ BP_Door: { status: "retry" } });
    callAction.mockImplementation(async () => json({ assets: [{ assetPath: "/Game/BP_Door", name: "BP_Door" }] }));
    expect(await byToken(r, ["BP_Door"])).toEqual({ BP_Door: { status: "resolved", paths: ["/Game/BP_Door.BP_Door"] } });
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
    const out = await byToken(r, tokens);
    expect(callAction).toHaveBeenCalledTimes(LOOKUPS_PER_REQUEST);
    expect(Object.values(out).filter((x) => x.status === "retry")).toHaveLength(5);
    expect(most).toBeLessThanOrEqual(2);
  });

  it("logs a shown chooser as a miss, and nothing for a bad report", () => {
    expect(missLine({ name: "SG_PlaceChildAssembly", candidates: 2 })).toBe("asset chooser shown for SG_PlaceChildAssembly, 2 candidates, no link or trace");
    for (const b of [{ name: "x\ny", candidates: 2 }, { name: "SG_A", candidates: 1 }, { name: "SG_A" }, null]) expect(missLine(b)).toBeNull();
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

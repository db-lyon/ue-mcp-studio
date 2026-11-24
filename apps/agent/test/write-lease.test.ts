/**
 * The fix loop's per-package write lease: its agents never save a package the
 * person has unsaved changes in.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { ActionResult } from "ue-mcp/daemon";
import { WriteLease, packageOf } from "../src/write-lease.js";
import type { AgentHost } from "../src/tools.js";

describe("WriteLease", () => {
  const answer = (body: unknown): ActionResult => ({ isError: false, content: [{ type: "text", text: JSON.stringify(body) }] });
  let dirty: string[];
  let level: string;
  let reached: string[];
  const writes = () => new WriteLease(async (_c, action) => {
    if (action === "list_dirty_packages") return answer({ success: true, content: dirty.filter((p) => !p.includes("/Maps/")).map((p) => ({ package: p })), maps: dirty.filter((p) => p.includes("/Maps/")).map((p) => ({ package: p })) });
    if (action === "get_world_state") return answer({ success: true, persistentLevelPackage: level });
    return answer({ success: true });
  });
  const host = (): AgentHost => ({ callAction: async (c: string, a: string) => (reached.push(`${c}.${a}`), answer({ success: true })) } as unknown as AgentHost);
  const refusedText = (r: ActionResult) => JSON.parse(r.content[0].text!) as { blocked?: boolean; reason?: string };

  beforeEach(() => {
    dirty = ["/Game/BP/BP_Door", "/Game/Maps/L_Town"];
    level = "/Game/Maps/L_Arena";
    reached = [];
  });

  it("refuses an attempt's save of a package the person has unsaved changes in, and lets its own through", async () => {
    const w = writes();
    await w.begin("fix");
    const h = w.wrap(host(), "fix");
    const r = await h.callAction("asset", "save", { assetPath: "/Game/BP/BP_Door.BP_Door" });
    expect(r.isError).toBe(true);
    expect(refusedText(r)).toMatchObject({ blocked: true, reason: expect.stringContaining("/Game/BP/BP_Door") });
    await h.callAction("asset", "save", { assetPath: "/Game/BP/BP_Lamp" });
    await h.callAction("blueprint", "add_variable", { blueprintPath: "/Game/BP/BP_Door", save: true }).then((x) => expect(x.isError).toBe(true));
    await h.callAction("blueprint", "add_variable", { blueprintPath: "/Game/BP/BP_Door" });
    expect(reached).toEqual(["asset.save", "blueprint.add_variable"]);
  });

  it("refuses a save of everything while the person's packages are still dirty, and a level save of their level", async () => {
    const w = writes();
    await w.begin("fix");
    const h = w.wrap(host(), "fix");
    expect((await h.callAction("editor", "save_dirty", {})).isError).toBe(true);
    expect((await h.callAction("level", "save", {})).isError).toBeFalsy();
    level = "/Game/Maps/L_Town";
    expect((await h.callAction("level", "save", {})).isError).toBe(true);
    // The person saved their work: saving everything is the attempt's own again.
    dirty = ["/Game/BP/BP_Lamp"];
    expect((await h.callAction("asset", "save_all_dirty", {})).isError).toBeFalsy();
  });

  it("holds nothing outside an attempt, or for another session", async () => {
    const w = writes();
    expect((await w.wrap(host(), "fix").callAction("asset", "save", { assetPath: "/Game/BP/BP_Door" })).isError).toBeFalsy();
    await w.begin("fix");
    expect((await w.wrap(host(), "chat").callAction("asset", "save", { assetPath: "/Game/BP/BP_Door" })).isError).toBeFalsy();
    w.end("fix");
    expect(w.held("fix")).toBeUndefined();
  });

  it("names packages without their object", () => {
    expect(packageOf("/Game/A/B.B")).toBe("/Game/A/B");
    expect(packageOf("/Game/A/B")).toBe("/Game/A/B");
  });
});

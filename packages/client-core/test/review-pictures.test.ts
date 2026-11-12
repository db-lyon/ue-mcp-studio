import { describe, expect, it } from "vitest";
import type { AssetDiff, AssetVersion } from "@ue-mcp-studio/shared";
import { diffPictures, isBlankPicture, isFlatPicture, isPlaceholderPicture, isVisualAsset, pictureSides } from "../src/index.js";

const pic = (id: string): AssetVersion["thumbnail"] => ({ id: id.repeat(40), url: "", source: "rendered" });
const version = (cls: string, thumbnail?: AssetVersion["thumbnail"]): AssetVersion => ({ class: cls, facts: [], ...(thumbnail ? { thumbnail } : {}) });
const diff = (cls: string, before: AssetVersion | null, after: AssetVersion | null, status: AssetDiff["status"] = "modified"): AssetDiff => ({
  state: "ready", status, assetClass: cls, before, after, summary: "", nativeDiff: { available: true },
});

describe("which asset kinds show pictures", () => {
  it("is the kinds whose change is visual", () => {
    for (const cls of ["Material", "MaterialInstanceConstant", "Texture2D", "StaticMesh", "SkeletalMesh", "World", "NiagaraSystem"]) expect(isVisualAsset(cls), cls).toBe(true);
  });
  it("is never a Blueprint, a data asset, a sound or an input action", () => {
    for (const cls of ["Blueprint", "WidgetBlueprint", "AnimBlueprint", "DataTable", "PrimaryDataAsset", "SoundWave", "InputAction"]) expect(isVisualAsset(cls), cls).toBe(false);
  });
  it("falls back to the file name where no class came", () => {
    expect(isVisualAsset(undefined, "L_Gate.umap")).toBe(true);
    expect(isVisualAsset(undefined, "M_Rock.uasset")).toBe(true);
    expect(isVisualAsset(undefined, "BP_ValeEnemy_Humanoid.uasset")).toBe(false);
  });
});

describe("which pictures a review item shows", () => {
  it("shows Before and After for a changed visual asset only when both are real", () => {
    expect(pictureSides({ visual: true, status: "modified", before: true, after: true })).toEqual([{ side: "before", label: "Before" }, { side: "after", label: "After" }]);
    expect(pictureSides({ visual: true, status: "modified", before: false, after: true })).toEqual([]);
    expect(pictureSides({ visual: true, status: "modified", before: true, after: false })).toEqual([]);
  });
  it("shows a new visual asset's picture as New, and a deleted one's as Deleted", () => {
    expect(pictureSides({ visual: true, status: "added", before: false, after: true })).toEqual([{ side: "after", label: "New" }]);
    expect(pictureSides({ visual: true, status: "added", before: false, after: false })).toEqual([]);
    expect(pictureSides({ visual: true, status: "deleted", before: true, after: false })).toEqual([{ side: "before", label: "Deleted" }]);
  });
  it("shows nothing for a kind whose change is not visual, whatever pictures it has", () => {
    for (const status of ["added", "modified", "deleted"] as const) expect(pictureSides({ visual: false, status, before: true, after: true })).toEqual([]);
  });
});

describe("an engine diff's pictures", () => {
  it("shows none for a Blueprint that added a component, though both versions have a thumbnail", () => {
    const bp = diff("Blueprint", version("Blueprint", pic("a")), version("Blueprint", pic("b")));
    expect(diffPictures(bp, "modified", "BP_ValeEnemy_Humanoid.uasset")).toEqual([]);
  });
  it("shows both sides of a changed material, each with its thumbnail", () => {
    const m = diff("Material", version("Material", pic("a")), version("Material", pic("b")));
    expect(diffPictures(m, "modified", "M_Rock.uasset").map((p) => [p.label, p.thumbnail.id])).toEqual([["Before", "a".repeat(40)], ["After", "b".repeat(40)]]);
  });
  it("shows neither side where one is missing, failed in the editor, or failed in the client", () => {
    const err = diff("Material", version("Material", pic("a")), version("Material", { error: "no renderer" }));
    expect(diffPictures(err, "modified", "M_Rock.uasset")).toEqual([]);
    const none = diff("Material", version("Material", pic("a")), version("Material"));
    expect(diffPictures(none, "modified", "M_Rock.uasset")).toEqual([]);
    const both = diff("Material", version("Material", pic("a")), version("Material", pic("b")));
    expect(diffPictures(both, "modified", "M_Rock.uasset", { after: "blank" })).toEqual([]);
    expect(diffPictures(both, "modified", "M_Rock.uasset", { before: "unreadable" })).toEqual([]);
  });
  it("shows a new mesh's picture as New, and nothing once it turns out blank", () => {
    const added = diff("StaticMesh", null, version("StaticMesh", pic("c")), "added");
    expect(diffPictures(added, "added", "SM_Box.uasset").map((p) => p.label)).toEqual(["New"]);
    expect(diffPictures(added, "added", "SM_Box.uasset", { after: "blank" })).toEqual([]);
  });
  it("reads the class off a version when the diff names none", () => {
    const m: AssetDiff = { ...diff("x", version("Texture2D", pic("a")), version("Texture2D", pic("b"))), assetClass: undefined };
    expect(diffPictures(m, "modified", "unnamed.uasset")).toHaveLength(2);
  });
});

describe("a blank picture", () => {
  const grid = (n: number, at: (x: number, y: number) => number[]) => {
    const px: number[] = [];
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) px.push(...at(x, y));
    return px;
  };
  const checker = grid(64, (x, y) => ((Math.floor(x / 8) + Math.floor(y / 8)) % 2 ? [96, 96, 96, 255] : [160, 160, 160, 255]));
  const shaded = grid(64, (x, y) => [40 + x * 3, 40 + y * 2, 60 + ((x + y) % 50), 255]);
  const greyRender = grid(64, (x, y) => { const v = 60 + Math.round(Math.hypot(x - 32, y - 32) * 3); return [v, v, v, 255]; });
  it("is one flat colour", () => {
    expect(isFlatPicture(grid(8, () => [0, 0, 0, 255]))).toBe(true);
    expect(isBlankPicture(grid(8, () => [0, 0, 0, 255]))).toBe(true);
  });
  it("is Unreal's grey checkerboard placeholder", () => {
    expect(isPlaceholderPicture(checker)).toBe(true);
    expect(isBlankPicture(checker)).toBe(true);
  });
  it("is never a rendered asset, in colour or in grey shading", () => {
    expect(isBlankPicture(shaded)).toBe(false);
    expect(isBlankPicture(greyRender)).toBe(false);
  });
  it("is not a two-colour picture that is not grey", () => {
    expect(isPlaceholderPicture(grid(64, (x) => (x < 32 ? [200, 30, 30, 255] : [30, 30, 200, 255])))).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { assetFamily, changeCounts, tileFacts } from "./AssetTile";

describe("an asset's family", () => {
  it("comes from its class", () => {
    expect(assetFamily("World")).toBe("level");
    expect(assetFamily("WidgetBlueprint")).toBe("blueprint");
    expect(assetFamily("MaterialInstanceConstant")).toBe("material");
    expect(assetFamily("StaticMesh")).toBe("mesh");
    expect(assetFamily("Texture2D")).toBe("texture");
    expect(assetFamily("SoundWave")).toBe("sound");
    expect(assetFamily("NiagaraSystem")).toBe("effect");
    expect(assetFamily("DataTable")).toBe("data");
    expect(assetFamily("InputAction")).toBe("input");
    expect(assetFamily("AnimMontage")).toBe("animation");
    expect(assetFamily("SomethingNew")).toBe("file");
  });

  it("falls back to the file's name where no class came", () => {
    expect(assetFamily(undefined, "L_Meadow.umap")).toBe("level");
    expect(assetFamily(undefined, "BP_Door.uasset")).toBe("blueprint");
    expect(assetFamily(undefined, "IA_Jump.uasset")).toBe("input");
    expect(assetFamily(undefined, "Readme.uasset")).toBe("file");
  });
});

describe("what a diff changed", () => {
  it("counts records by what they change and how, leaving out hidden ones", () => {
    expect(changeCounts([
      { category: "Graph", kind: "graph", engineSource: "", entries: [
        { displayString: "Added Node Branch", diffType: "NODE_ADDED", category: "ADDITION" },
        { displayString: "Added Node Print", diffType: "NODE_ADDED", category: "ADDITION" },
        { displayString: "Removed Node Delay", diffType: "NODE_REMOVED", category: "SUBTRACTION" },
        { displayString: "Moved", diffType: "NODE_MOVED", category: "MINOR" },
      ] },
      { category: "Details", kind: "properties", engineSource: "", entries: [
        { displayString: "Speed", diffType: "PropertyValueChanged" },
        { displayString: "Guid", diffType: "PropertyValueChanged", hidden: true },
      ] },
    ]).map((c) => c.text)).toEqual(["2 nodes added", "1 node removed", "1 node moved", "1 property changed"]);
    expect(changeCounts(undefined)).toEqual([]);
  });

  it("lists the facts that changed first, with their old value", () => {
    const before = { class: "StaticMesh", facts: [{ name: "LODs", value: "3" }, { name: "Triangles", value: "1200" }] };
    const after = { class: "StaticMesh", facts: [{ name: "LODs", value: "3" }, { name: "Triangles", value: "900" }] };
    expect(tileFacts(before, after)).toEqual([{ name: "Triangles", value: "900", was: "1200" }, { name: "LODs", value: "3" }]);
    expect(tileFacts(null, after, 1)).toEqual([{ name: "LODs", value: "3" }]);
  });
});

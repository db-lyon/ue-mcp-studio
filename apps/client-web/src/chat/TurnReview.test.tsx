// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { AssetDiff, TimelineMark, TurnReview } from "@ue-mcp-studio/shared";

const m = vi.hoisted(() => ({
  reviewKeep: vi.fn(),
  reviewRevert: vi.fn(),
  reviewUndo: vi.fn(),
  reviewDiff: vi.fn(),
  reviewStatus: vi.fn(),
  setSessionReview: vi.fn(),
  timelineRestore: vi.fn(),
  timelineUndo: vi.fn(),
  reviewNativeDiff: vi.fn(),
  reviewImageUrl: (name: string) => `/v1/ext/studio/review/images/${name}`,
  reviewThumbnailUrl: (id: string) => `/v1/ext/studio/review/thumbnails/${id}`,
}));
vi.mock("../api", () => ({ api: m }));
import { ItemDiff, ReviewPanel, TurnReviewCard } from "./TurnReview";
import { SessionIdContext } from "./attachments";
import { isFlatPicture, numberStruct } from "./AssetDiff";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const REVIEW: TurnReview = {
  id: "r1",
  turn: 0,
  before: "a".repeat(40),
  after: "b".repeat(40),
  at: "2026-10-24T10:00:00.000Z",
  items: [
    { path: "Config/DefaultGame.ini", status: "modified", kind: "config", group: "config", state: "pending", summary: "1 line added, 1 removed", native: { available: false, reason: "Unreal's diff view opens assets only." } },
    { path: "Content/BP_Door.uasset", status: "modified", kind: "package", group: "blueprint", state: "pending", asset: "/Game/BP_Door.BP_Door", summary: "2 changes: Open Angle 0.0 to 90.0; Added Node Branch", native: { available: true } },
    { path: "Content/SM_Box.uasset", status: "added", kind: "package", group: "asset", state: "pending", asset: "/Game/SM_Box.SM_Box", summary: "New StaticMesh", native: { available: true } },
  ],
};
const none = { restored: [], conflicts: [], missing: [] };
const withItem = (path: string, patch: Partial<TurnReview["items"][number]>): TurnReview => ({ ...REVIEW, items: REVIEW.items.map((i) => (i.path === path ? { ...i, ...patch } : i)) });

const card = (review = REVIEW) => render(<SessionIdContext.Provider value="s1"><TurnReviewCard review={review} /></SessionIdContext.Provider>);
const row = (path: string) => document.querySelector(`[data-path="${path}"]`) as HTMLElement;

describe("the turn card", () => {
  it("lists each change under its group, with Keep and Revert per item and Revert all", () => {
    card();
    expect(screen.getByText("Config")).toBeTruthy();
    expect(screen.getByText("Blueprints")).toBeTruthy();
    expect(screen.getByText("Assets")).toBeTruthy();
    for (const it of REVIEW.items) {
      expect(within(row(it.path)).getByRole("button", { name: "Keep" })).toBeTruthy();
      expect(within(row(it.path)).getByRole("button", { name: "Revert" })).toBeTruthy();
    }
    expect(screen.getByRole("button", { name: "Revert all" })).toBeTruthy();
  });

  it("reverts one item and shows it reverted with Undo revert, the others still open", async () => {
    m.reviewRevert.mockResolvedValue({ review: withItem("Config/DefaultGame.ini", { state: "reverted", undo: "c".repeat(40) }), outcome: { ...none, restored: ["Config/DefaultGame.ini"] } });
    card();
    await act(async () => void fireEvent.click(within(row("Config/DefaultGame.ini")).getByRole("button", { name: "Revert" })));
    expect(m.reviewRevert).toHaveBeenCalledWith("s1", "r1", ["Config/DefaultGame.ini"], false);
    expect(within(row("Config/DefaultGame.ini")).getByText("Reverted")).toBeTruthy();
    expect(within(row("Config/DefaultGame.ini")).getByRole("button", { name: "Undo revert" })).toBeTruthy();
    expect(within(row("Content/BP_Door.uasset")).getByRole("button", { name: "Revert" })).toBeTruthy();

    m.reviewUndo.mockResolvedValue({ review: REVIEW, outcome: { ...none, restored: ["Config/DefaultGame.ini"] } });
    await act(async () => void fireEvent.click(within(row("Config/DefaultGame.ini")).getByRole("button", { name: "Undo revert" })));
    expect(m.reviewUndo).toHaveBeenCalledWith("s1", "r1", "Config/DefaultGame.ini");
    expect(within(row("Config/DefaultGame.ini")).getByRole("button", { name: "Revert" })).toBeTruthy();
  });

  it("keeps an item", async () => {
    m.reviewKeep.mockResolvedValue({ review: withItem("Content/BP_Door.uasset", { state: "kept" }) });
    card();
    await act(async () => void fireEvent.click(within(row("Content/BP_Door.uasset")).getByRole("button", { name: "Keep" })));
    expect(m.reviewKeep).toHaveBeenCalledWith("s1", "r1", ["Content/BP_Door.uasset"]);
    expect(within(row("Content/BP_Door.uasset")).getByText("Kept")).toBeTruthy();
  });

  it("Revert all sends every item not reverted yet", async () => {
    m.reviewRevert.mockResolvedValue({ review: REVIEW, outcome: none });
    card(withItem("Content/SM_Box.uasset", { state: "reverted", undo: "c".repeat(40) }));
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Revert all" })));
    expect(m.reviewRevert).toHaveBeenCalledWith("s1", "r1", ["Config/DefaultGame.ini", "Content/BP_Door.uasset"], false);
  });

  it("shows a file the user edited after the agent, and reverts it only after a confirmed second click", async () => {
    card(withItem("Config/DefaultGame.ini", { conflict: true }));
    const r = row("Config/DefaultGame.ini");
    expect(within(r).getByRole("alert").textContent).toMatch(/This file was changed outside the agent/);
    expect(within(r).queryByRole("button", { name: "Revert" })).toBeNull();
    fireEvent.click(within(r).getByRole("button", { name: "Revert anyway" }));
    expect(m.reviewRevert).not.toHaveBeenCalled();
    m.reviewRevert.mockResolvedValue({ review: withItem("Config/DefaultGame.ini", { state: "reverted" }), outcome: { ...none, restored: ["Config/DefaultGame.ini"] } });
    await act(async () => void fireEvent.click(within(r).getByRole("button", { name: "Revert and lose those changes" })));
    expect(m.reviewRevert).toHaveBeenCalledWith("s1", "r1", ["Config/DefaultGame.ini"], true);
  });

  it("gives every item its one-line summary, and opens Unreal's diff where the engine has one", async () => {
    card();
    expect(within(row("Content/BP_Door.uasset")).getByText("2 changes: Open Angle 0.0 to 90.0; Added Node Branch")).toBeTruthy();
    expect(within(row("Config/DefaultGame.ini")).getByText("1 line added, 1 removed")).toBeTruthy();
    const ini = within(row("Config/DefaultGame.ini")).getByRole("button", { name: "Open in Unreal diff" }) as HTMLButtonElement;
    expect(ini.disabled).toBe(true);
    expect(ini.title).toMatch(/diff view opens assets only/);
    expect((within(row("Content/SM_Box.uasset")).getByRole("button", { name: "Open in Unreal diff" }) as HTMLButtonElement).disabled).toBe(false);
    m.reviewNativeDiff.mockResolvedValue({ opened: "window", windowTitle: "Diff of BP_Door" });
    await act(async () => void fireEvent.click(within(row("Content/BP_Door.uasset")).getByRole("button", { name: "Open in Unreal diff" })));
    expect(m.reviewNativeDiff).toHaveBeenCalledWith("s1", "r1", "Content/BP_Door.uasset");
    expect(within(row("Content/BP_Door.uasset")).getByRole("status").textContent).toBe("Unreal's diff window is open (Diff of BP_Door).");
  });

  it("shows why Unreal could not open its diff", async () => {
    m.reviewNativeDiff.mockRejectedValue(new Error("Unreal has no in-editor diff view for World"));
    card();
    await act(async () => void fireEvent.click(within(row("Content/BP_Door.uasset")).getByRole("button", { name: "Open in Unreal diff" })));
    expect(within(row("Content/BP_Door.uasset")).getByRole("status").textContent).toBe("Unreal has no in-editor diff view for World");
  });

  it("opens the diff of a turn's only file with the card, and leaves a longer list closed", async () => {
    m.reviewDiff.mockResolvedValue({ change: { path: "Content/BP_Door.uasset", status: "modified", kind: "package" } });
    const one: TurnReview = { ...REVIEW, items: [REVIEW.items[1]] };
    await act(async () => void card(one));
    expect(row("Content/BP_Door.uasset").querySelector(".review-item-name")!.getAttribute("aria-expanded")).toBe("true");
    expect(m.reviewDiff).toHaveBeenCalledWith("s1", "r1", "Content/BP_Door.uasset");
    cleanup();
    m.reviewDiff.mockClear();
    card();
    expect(document.querySelectorAll(".review-item-name[aria-expanded='true']")).toHaveLength(0);
    expect(m.reviewDiff).not.toHaveBeenCalled();
  });

  it("says Reverting on the item in place of its controls while the revert runs", async () => {
    let finish: (v: unknown) => void = () => undefined;
    m.reviewRevert.mockReturnValue(new Promise((r) => (finish = r)));
    card();
    fireEvent.click(within(row("Content/BP_Door.uasset")).getByRole("button", { name: "Revert" }));
    const r = row("Content/BP_Door.uasset");
    expect(within(r).getByRole("status").textContent).toBe("Reverting");
    expect(within(r).queryByRole("button", { name: "Keep" })).toBeNull();
    expect((within(row("Config/DefaultGame.ini")).getByRole("button", { name: "Revert" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => void finish({ review: withItem("Content/BP_Door.uasset", { state: "reverted" }), outcome: none }));
    expect(within(row("Content/BP_Door.uasset")).getByText("Reverted")).toBeTruthy();
  });

  it("shows a failed revert under its item, and a failed Revert all under the card", async () => {
    m.reviewRevert.mockRejectedValue(new Error("the file is locked by another process"));
    card();
    await act(async () => void fireEvent.click(within(row("Content/BP_Door.uasset")).getByRole("button", { name: "Revert" })));
    expect(within(row("Content/BP_Door.uasset")).getByRole("alert").textContent).toBe("the file is locked by another process");
    expect(within(row("Content/BP_Door.uasset")).getByRole("button", { name: "Revert" })).toBeTruthy();
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Revert all" })));
    expect(within(row("Content/BP_Door.uasset")).queryByRole("alert")).toBeNull();
    expect(screen.getByRole("alert").closest("li")).toBeNull();
  });

  it("says what a revert left alone", async () => {
    m.reviewRevert.mockResolvedValue({ review: withItem("Config/DefaultGame.ini", { conflict: true }), outcome: { ...none, conflicts: ["Config/DefaultGame.ini"] } });
    card();
    await act(async () => void fireEvent.click(within(row("Config/DefaultGame.ini")).getByRole("button", { name: "Revert" })));
    expect(screen.getByText("1 file was changed outside the agent and left as they are.")).toBeTruthy();
  });
});

describe("the diff view", () => {
  const diffOf = async (item: TurnReview["items"][number]) => {
    await act(async () => void render(<ItemDiff sessionId="s1" reviewId="r1" item={item} />));
  };

  /** The tree grid's row whose name reads `label`, levels joined by " \u203a ". */
  const treeRow = (label: string, inside: ParentNode = document) => {
    const r = [...inside.querySelectorAll<HTMLElement>("[role='treegrid'] [role='row']")].find((x) => x.querySelector(".dt-label")?.textContent === label);
    if (!r) throw new Error(`no row ${label}: ${[...inside.querySelectorAll(".dt-label")].map((x) => x.textContent).join(" | ")}`);
    return r;
  };
  const cellsOf = (label: string) => [...treeRow(label).children] as HTMLElement[];
  const labels = () => [...document.querySelectorAll(".dt-label")].map((x) => x.textContent);

  it("shows a text diff for config and source", async () => {
    m.reviewDiff.mockResolvedValue({ change: { path: "Config/DefaultGame.ini", status: "modified", kind: "config", diff: "@@ -1,1 +1,1 @@\n-Speed=1\n+Speed=2" } });
    await diffOf(REVIEW.items[0]);
    const pre = screen.getByLabelText("Diff of Config/DefaultGame.ini");
    expect(pre.textContent).toContain("- Speed=1");
    expect(pre.textContent).toContain("+ Speed=2");
  });

  it("shows the Blueprint diff for a Blueprint", async () => {
    m.reviewDiff.mockResolvedValue({ change: { path: "Content/BP_Door.uasset", status: "modified", kind: "package", blueprintDiff: { variables: { added: ["OpenAngle"] }, graphs: [] } } });
    await diffOf(REVIEW.items[1]);
    const list = screen.getByLabelText("Blueprint diff");
    expect(list.textContent).toContain("variables");
    expect(list.textContent).toContain("OpenAngle");
  });

  const material: AssetDiff = {
    state: "ready",
    status: "modified",
    assetClass: "Material",
    engine: { tool: "SMaterialDiff", note: "the material graph through FGraphDiffControl::DiffGraphs", native: "window", nativeAvailable: true },
    before: { class: "Material", facts: [{ name: "Blend mode", value: "BLEND_Opaque" }], thumbnail: { id: "a".repeat(40), url: "", source: "rendered" } },
    after: { class: "Material", facts: [{ name: "Blend mode", value: "BLEND_Masked" }], thumbnail: { error: "Unreal has no thumbnail renderer for Material" } },
    sections: [
      { category: "Material Graph", kind: "graph", engineSource: "FGraphDiffControl::DiffGraphs", entries: [
        { displayString: "Added Node Constant", diffType: "NODE_ADDED", category: "ADDITION" },
        { displayString: "Property Changed: Default Value", diffType: "NODE_PROPERTY", category: "MODIFICATION", properties: [{ displayString: "Default Value changed value in Roughness", diffType: "PropertyValueChanged", path: "Default Value", before: "0.200000", after: "0.700000" }] },
      ] },
      { category: "Details", kind: "properties", engineSource: "DiffUtils::CompareUnrelatedObjects", entries: [
        { displayString: "Two Sided changed value in M", diffType: "PropertyValueChanged", path: "Two Sided", before: "False", after: "True" },
        { displayString: "Lighting Guid changed value in M", diffType: "PropertyValueChanged", path: "Lighting Guid", before: "A1", after: "B2", hidden: true },
        { displayString: "State Id changed value in M", diffType: "PropertyValueChanged", path: "State Id", before: "C3", after: "D4", hidden: true },
      ], hiddenChanges: 2 },
    ],
    summary: "3 changes",
    nativeDiff: { available: true },
  };

  it("opens a material instance's parameter list into a row per parameter that changed, the engine's text on hover", async () => {
    const raw = (v: string) => `((ParameterInfo=(Name="Roughness",Association=GlobalParameter,Index=-1),ParameterValue=${v},ExpressionGUID=00000000000000000000000000000000),(ParameterInfo=(Name="Moss",Association=GlobalParameter,Index=-1),ParameterValue=0.300000,ExpressionGUID=00000000000000000000000000000000))`;
    const mi: AssetDiff = { ...material, assetClass: "MaterialInstanceConstant", sections: [{ category: "Details", kind: "properties", engineSource: "", entries: [{ displayString: "", diffType: "PropertyValueChanged", path: "Scalar Parameter Values", before: raw("0.500000"), after: raw("0.800000") }] }] };
    m.reviewDiff.mockResolvedValue({ change: { path: "Content/BP_Door.uasset", status: "modified", kind: "package", assetDiff: mi } });
    await diffOf(REVIEW.items[1]);
    // Only Roughness changed, so the list and its one parameter are one row.
    const name = "Scalar Parameter Values \u203a Roughness";
    expect(treeRow(name).className).toContain("mod");
    expect(cellsOf(name).slice(1).map((c) => c.textContent)).toEqual(["0.5", "0.8"]);
    expect(cellsOf(name)[2].getAttribute("title")).toBe("0.800000");
    // Moss is the same in both versions: no row.
    expect(labels()).not.toContain("Moss");
  });

  it("shows what an added node holds as its rows, under After only", async () => {
    const added = { displayString: "Added Node Constant", diffType: "NODE_ADDED", category: "ADDITION", node1: { guid: "1", name: "N", class: "MaterialGraphNode", title: "Constant", fullTitle: "0.35", pins: [{ name: "B", displayName: "B", defaultValue: "0.5", linked: false }, { name: "A", displayName: "A", defaultValue: "1", linked: true }], properties: [{ name: "R", displayName: "Value", value: "0.350000", isDefault: false }, { name: "Desc", displayName: "Desc", value: "", isDefault: true }] } };
    const graph = (e: unknown): AssetDiff => ({ ...material, sections: [{ category: "Material Graph", kind: "graph", engineSource: "", entries: [e as never] }] });
    m.reviewDiff.mockResolvedValue({ change: { path: "Content/BP_Door.uasset", status: "modified", kind: "package", assetDiff: graph(added) } });
    await diffOf(REVIEW.items[1]);
    const node = treeRow("Constant");
    expect(node.className).toContain("add");
    expect(node.querySelector(".dt-glyph")!.textContent).toBe("+Added");
    expect(node.getAttribute("aria-expanded")).toBe("true");
    // No Before cell says it was not there: an added row has After only.
    const [, vb, va] = cellsOf("Value");
    expect([vb.textContent, va.textContent]).toEqual(["", "0.35"]);
    expect(vb.className).toContain("dt-blank");
    expect(cellsOf("B")[2].textContent).toBe("0.5");
    // Collapsing the node hides its values.
    fireEvent.click(within(node).getByRole("button"));
    expect(labels()).not.toContain("Value");
  });

  it("puts every graph record under its node, one row each: a removed node's values under Before, a property's values side by side, links as was and now", async () => {
    const removed = { displayString: "Removed Node Print String", diffType: "NODE_REMOVED", category: "SUBTRACTION", node1: { guid: "1", name: "N", class: "K2Node_CallFunction", title: "Print String", fullTitle: "Print String\nTarget is Kismet System Library", pins: [{ name: "Duration", displayName: "Duration", defaultValue: "2.0", linked: false }, { name: "TextColor", displayName: "Text Color", defaultValue: "(R=0.000000,G=0.660000,B=1.000000,A=1.000000)", linked: false }] } };
    const links = { displayString: "Pin 'then' has more links (was 0 now 1)", diffType: "PIN_LINKEDTO_NUM_INC", category: "MODIFICATION" };
    const moved = { displayString: "Node moved", diffType: "NODE_MOVED", category: "MINOR" };
    const prop = { displayString: "Property Changed: Default Value", diffType: "NODE_PROPERTY", category: "MODIFICATION", node2: { guid: "4", name: "N4", class: "MaterialGraphNode", title: "Roughness" }, properties: [{ displayString: "Default Value", diffType: "PropertyValueChanged", path: "Default Value", before: "0.200000", after: "0.700000" }] };
    const pin = { displayString: "Pin Default Value Changed: Speed", diffType: "PIN_DEFAULT_VALUE", category: "MODIFICATION", pin1: { name: "Speed", direction: "input", defaultValue: "600.0", linkedTo: [] }, pin2: { name: "Speed", direction: "input", defaultValue: "450.0", linkedTo: [] } };
    const graph: AssetDiff = { ...material, sections: [{ category: "EventGraph", kind: "graph", engineSource: "", entries: [removed, links, moved, prop, pin] as never }] };
    m.reviewDiff.mockResolvedValue({ change: { path: "Content/BP_Door.uasset", status: "modified", kind: "package", assetDiff: graph } });
    await diffOf(REVIEW.items[1]);
    // Every row has its three cells.
    for (const r of document.querySelectorAll("[role='treegrid'] [role='row']")) expect(r.children).toHaveLength(3);
    expect(treeRow("EventGraph").getAttribute("aria-level")).toBe("1");
    const node = treeRow("Print String");
    expect(node.className).toContain("del");
    expect(node.getAttribute("aria-level")).toBe("2");
    expect(node.querySelector(".dt-note")!.textContent).toBe("Print String, Target is Kismet System Library");
    const [, cb, ca] = cellsOf("Text Color");
    // A colour keeps its text, with a swatch beside it, under Before only.
    expect(cb.querySelector(".cmp-swatch")!.getAttribute("style")).toContain("rgb(0, 212, 255)");
    expect(cb.textContent!.replace(/\u00a0/g, " ")).toBe("R 0, G 0.66, B 1, A 1");
    expect(cb.getAttribute("title")).toBe("(R=0.000000,G=0.660000,B=1.000000,A=1.000000)");
    expect(ca.textContent).toBe("");
    // The link count's was and now are its values.
    expect(cellsOf("then \u203a Links").slice(1).map((c) => c.textContent)).toEqual(["0", "1"]);
    expect(treeRow("Moved").className).toContain("minor");
    expect(treeRow("Moved").className).toContain("dt-bare");
    // A graph record that only says its node's properties changed is those properties, under the node: once, with values.
    expect(screen.queryByText(/Property Changed/)).toBeNull();
    expect(cellsOf("Roughness \u203a Default Value").slice(1).map((c) => c.textContent)).toEqual(["0.2", "0.7"]);
    expect(cellsOf("Speed").slice(1).map((c) => c.textContent)).toEqual(["600", "450"]);
  });

  it("opens a long or many-line value in place, both sides of its row together", async () => {
    const text: AssetDiff = { ...material, sections: [{ category: "Details", kind: "properties", engineSource: "", entries: [{ displayString: "", diffType: "PropertyValueChanged", path: "Allowed Biomes", before: '("Forest","Swamp")', after: '("Forest","Swamp","Tundra")' }] }] };
    m.reviewDiff.mockResolvedValue({ change: { path: "Content/BP_Door.uasset", status: "modified", kind: "package", assetDiff: text } });
    await diffOf(REVIEW.items[1]);
    const [, before, after] = cellsOf("Allowed Biomes");
    expect([before.textContent, after.textContent]).toEqual(["Forest, Swamp", "Forest, Swamp, Tundra"]);
    fireEvent.click(after);
    expect([before.getAttribute("aria-expanded"), after.getAttribute("aria-expanded")]).toEqual(["true", "true"]);
    expect([...after.querySelectorAll(".dt-line")].map((l) => l.textContent)).toEqual(["Forest", "Swamp", "Tundra"]);
    fireEvent.keyDown(before, { key: "Enter" });
    expect(after.getAttribute("aria-expanded")).toBe("false");
  });

  it("lets a long engine name wrap only between its parts", () => {
    card(withItem("Content/BP_Door.uasset", { path: "Content/Characters/BP_PlayerCharacterMovementComponent.uasset" }));
    const name = document.querySelector(".review-item-name")!;
    expect(name.textContent).toBe("BP_PlayerCharacterMovementComponent.uasset");
    expect(name.querySelectorAll("wbr").length).toBeGreaterThanOrEqual(4);
  });

  /** The material with a picture of both versions. */
  const pictured: AssetDiff = { ...material, after: { ...material.after!, thumbnail: { id: "b".repeat(40), url: "", source: "rendered" } } };

  it("shows a package's engine diff: a changed material's Before and After pictures, then one tree of each category's records with before and after, and the facts", async () => {
    m.reviewDiff.mockResolvedValue({ change: { path: "Content/BP_Door.uasset", status: "modified", kind: "package", assetDiff: pictured } });
    await diffOf(REVIEW.items[1]);
    expect((screen.getByAltText("BP_Door.uasset before") as HTMLImageElement).src).toContain(`/v1/ext/studio/review/thumbnails/${"a".repeat(40)}`);
    expect((screen.getByAltText("BP_Door.uasset after") as HTMLImageElement).src).toContain(`/v1/ext/studio/review/thumbnails/${"b".repeat(40)}`);
    expect([...document.querySelectorAll(".review-pictures figcaption")].map((c) => c.textContent)).toEqual(["Before", "After"]);
    expect(screen.getAllByRole("treegrid")).toHaveLength(1);
    expect([...screen.getByRole("treegrid").querySelectorAll("[role='columnheader']")].map((c) => c.textContent)).toEqual(["Property", "Before", "After"]);
    expect(treeRow("Material Graph").querySelector(".dt-count")!.textContent).toBe("2");
    expect(treeRow("Node Constant").className).toContain("add");
    expect(cellsOf("Default Value").slice(1).map((c) => c.textContent)).toEqual(["0.2", "0.7"]);
    expect(cellsOf("Two Sided").slice(1).map((c) => c.textContent)).toEqual(["False", "True"]);
    // What the details panel does not show is a group of its own, open like the rest.
    const hidden = treeRow("Not in the details panel");
    expect(hidden.querySelector(".dt-count")!.textContent).toBe("2");
    expect(cellsOf("Lighting Guid")[2].textContent).toBe("B2");
    fireEvent.click(within(hidden).getByRole("button"));
    expect(labels()).not.toContain("Lighting Guid");
    // The fact that differs is compared at once; none is the same, so there is no unchanged line.
    expect(cellsOf("Blend mode").slice(1).map((c) => c.textContent)).toEqual(["BLEND_Opaque", "BLEND_Masked"]);
    expect(screen.queryByText(/unchanged fact/)).toBeNull();
    // Which engine API produced the records is not the user's concern.
    expect(screen.queryByText(/SMaterialDiff/)).toBeNull();
  });

  /** WBP_GameHUD as ue-mcp 1.4.13 diffs it: one widget property changed in the widget tree, every fact the same. */
  const widget: AssetDiff = {
    state: "ready",
    status: "modified",
    assetClass: "WidgetBlueprint",
    engine: { tool: "SBlueprintDiff", note: "The Blueprint diff.", native: "window", nativeAvailable: true, blueprintTypeDiff: true },
    before: { class: "WidgetBlueprint", facts: [{ name: "Parent class", value: "ValeHUDWidget" }, { name: "Blueprint type", value: "BPTYPE_Normal" }, { name: "Variables", value: "0" }, { name: "Graphs", value: "1" }, { name: "Components", value: "0" }], thumbnail: { id: "c".repeat(40), url: "", source: "rendered" } },
    after: { class: "WidgetBlueprint", facts: [{ name: "Parent class", value: "ValeHUDWidget" }, { name: "Blueprint type", value: "BPTYPE_Normal" }, { name: "Variables", value: "0" }, { name: "Graphs", value: "1" }, { name: "Components", value: "0" }], thumbnail: { id: "d".repeat(40), url: "", source: "rendered" } },
    sections: [{
      category: "Widget Blueprint", kind: "properties", engineSource: "UBlueprint::FindDiffs",
      notes: ["Warning: This may be missing changes to Animations and Bindings"],
      entries: [{ displayString: "bHideWhenFull changed value in WardMeter", diffType: "PropertyValueChanged", group: "Widget WardMeter", path: "bHideWhenFull", label: "Hide when Full", property: "bHideWhenFull", before: "False", after: "True" }],
      hiddenChanges: 0,
    }],
    blueprint: { summary: "no structural change" },
    summary: "1 difference: Widget WardMeter > Hide when Full: False to True",
    nativeDiff: { available: true },
  };
  const widgetItem = { ...REVIEW.items[1], path: "Content/UI/HUD/WBP_GameHUD.uasset", asset: "/Game/UI/HUD/WBP_GameHUD.WBP_GameHUD", summary: widget.summary };

  it("shows a widget's changed property as one row, the widget and its details panel label folded into one name, and only the facts that differ", async () => {
    m.reviewDiff.mockResolvedValue({ change: { path: widgetItem.path, status: "modified", kind: "package", assetDiff: widget } });
    await diffOf(widgetItem);
    expect(labels()).toEqual(["Widget Blueprint", "Widget WardMeter \u203a Hide when Full"]);
    const [name, before, after] = cellsOf("Widget WardMeter \u203a Hide when Full");
    expect(name.querySelector(".dt-glyph")!.textContent).toBe("~Changed");
    expect([before.textContent, after.textContent]).toEqual(["False", "True"]);
    // No badge, no boxed group, no tinted Before and After blocks.
    expect(document.querySelector(".diff-kind, .diff-table, .diff-section-head")).toBeNull();
    // The engine's own caveat is on the section's hover, not a line of its own.
    expect(treeRow("Widget Blueprint").querySelector(".dt-label")!.getAttribute("title")).toContain("Warning: This may be missing changes to Animations and Bindings");
    // Every fact is the same: none of them is shown, not even folded.
    expect(labels()).not.toContain("Facts");
    expect(screen.queryByText(/unchanged fact/)).toBeNull();
    expect(screen.queryByText("ValeHUDWidget")).toBeNull();
    // The summary is the card's line above; the body does not say it again, and has no raw structure dump.
    expect(screen.queryByText(/no difference/)).toBeNull();
    expect(screen.queryByText(/Structure/)).toBeNull();
  });

  it("shows no unchanged facts for a Widget Blueprint whose widget tree was not compared, and never says no difference", async () => {
    const old: AssetDiff = { ...widget, engine: { ...widget.engine!, blueprintTypeDiff: undefined }, sections: [], before: { ...widget.before!, thumbnail: { error: "x" } }, after: { ...widget.after!, thumbnail: { error: "x" } }, summary: "Widget Blueprint changed. This ue-mcp bridge cannot compare widget properties. Open in Unreal diff to see them." };
    m.reviewDiff.mockResolvedValue({ change: { path: widgetItem.path, status: "modified", kind: "package", assetDiff: old } });
    await diffOf({ ...widgetItem, summary: old.summary });
    expect(document.querySelector(".asset-tile")).toBeNull();
    expect(document.querySelector(".review-pictures")).toBeNull();
    expect(screen.queryByText(/unchanged fact/)).toBeNull();
    expect(screen.queryByText("ValeHUDWidget")).toBeNull();
    expect(screen.queryByText(/no difference/)).toBeNull();
  });

  it("shows no thumbnails for a Blueprint, though both versions have one: the tree carries the change", async () => {
    m.reviewDiff.mockResolvedValue({ change: { path: widgetItem.path, status: "modified", kind: "package", assetDiff: widget } });
    await diffOf(widgetItem);
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector(".review-pictures")).toBeNull();
    expect(document.querySelector(".asset-tile")).toBeNull();
    expect(screen.queryByText(/No picture/)).toBeNull();
    expect(treeRow("Widget Blueprint")).toBeTruthy();
  });

  const canvasReturns = (data: Uint8ClampedArray) => vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: () => undefined, getImageData: () => ({ data }) } as unknown as CanvasRenderingContext2D);

  it("drops both pictures when one is one flat colour, so a renderer that drew nothing shows no black panel and no lone side", async () => {
    const getContext = canvasReturns(new Uint8ClampedArray(64 * 64 * 4).map((_, i) => (i % 4 === 3 ? 255 : 0)));
    try {
      m.reviewDiff.mockResolvedValue({ change: { path: "Content/BP_Door.uasset", status: "modified", kind: "package", assetDiff: pictured } });
      await diffOf(REVIEW.items[1]);
      const before = screen.getByAltText("BP_Door.uasset before");
      expect(before.className).toBe("picture-pending");
      fireEvent.load(before);
      // No frame, no tile, no error: the records are the change.
      expect(document.querySelector("img")).toBeNull();
      expect(document.querySelector(".review-pictures")).toBeNull();
      expect(document.querySelector(".asset-tile")).toBeNull();
      expect(screen.queryByText(/No picture/)).toBeNull();
      expect(treeRow("Material Graph")).toBeTruthy();
    } finally {
      getContext.mockRestore();
    }
  });

  it("drops the pictures when one is Unreal's grey checkerboard placeholder", async () => {
    const checker = new Uint8ClampedArray(64 * 64 * 4).map((_, i) => {
      const p = i >> 2;
      return i % 4 === 3 ? 255 : (Math.floor((p % 64) / 8) + Math.floor(p / 64 / 8)) % 2 ? 96 : 160;
    });
    const getContext = canvasReturns(checker);
    try {
      m.reviewDiff.mockResolvedValue({ change: { path: "Content/BP_Door.uasset", status: "modified", kind: "package", assetDiff: pictured } });
      await diffOf(REVIEW.items[1]);
      fireEvent.load(screen.getByAltText("BP_Door.uasset after"));
      expect(document.querySelector(".review-pictures")).toBeNull();
    } finally {
      getContext.mockRestore();
    }
  });

  it("shows the pair once both pictures are known to show something, and not one side before", async () => {
    const getContext = canvasReturns(new Uint8ClampedArray(64 * 64 * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 7) % 256)));
    try {
      m.reviewDiff.mockResolvedValue({ change: { path: "Content/BP_Door.uasset", status: "modified", kind: "package", assetDiff: pictured } });
      await diffOf(REVIEW.items[1]);
      const before = screen.getByAltText("BP_Door.uasset before");
      const after = screen.getByAltText("BP_Door.uasset after");
      fireEvent.load(before);
      expect(before.className).toBe("picture-pending");
      fireEvent.load(after);
      expect([before.className, after.className]).toEqual(["", ""]);
    } finally {
      getContext.mockRestore();
    }
  });

  it("shows no picture of a changed material where only one version has one", async () => {
    m.reviewDiff.mockResolvedValue({ change: { path: "Content/BP_Door.uasset", status: "modified", kind: "package", assetDiff: material } });
    await diffOf(REVIEW.items[1]);
    expect(document.querySelector("img")).toBeNull();
    expect(screen.queryByText(/No picture/)).toBeNull();
    expect(treeRow("Material Graph")).toBeTruthy();
  });

  it("shows a new mesh's picture alone, labelled New", async () => {
    const mesh: AssetDiff = { ...material, status: "added", assetClass: "StaticMesh", before: null, after: { class: "StaticMesh", facts: [{ name: "Triangles", value: "12" }], thumbnail: { id: "e".repeat(40), url: "", source: "rendered" } }, sections: [] };
    m.reviewDiff.mockResolvedValue({ change: { path: "Content/SM_Box.uasset", status: "added", kind: "package", assetDiff: mesh } });
    await diffOf(REVIEW.items[2]);
    expect((screen.getByAltText("SM_Box.uasset new") as HTMLImageElement).src).toContain("e".repeat(40));
    expect([...document.querySelectorAll(".review-pictures figcaption")].map((c) => c.textContent)).toEqual(["New"]);
    expect(screen.queryByText("Did not exist before this turn")).toBeNull();
  });

  it("shows an added asset's facts with no tile, a deleted one's last picture labelled Deleted, and a tile for an asset with neither", async () => {
    const added: AssetDiff = { ...material, status: "added", before: null, sections: [] };
    m.reviewDiff.mockResolvedValue({ change: { path: "Content/SM_Box.uasset", status: "added", kind: "package", assetDiff: added } });
    await diffOf(REVIEW.items[2]);
    // No tile beside a grid that lists its facts: the item line names it and says Added.
    expect(document.querySelector(".asset-tile")).toBeNull();
    // Its facts are the grid's rows, After only, open.
    expect(treeRow("Details of this version").getAttribute("aria-expanded")).toBe("true");
    expect(cellsOf("Blend mode").slice(1).map((c) => c.textContent)).toEqual(["", "BLEND_Masked"]);
    cleanup();
    const deleted: AssetDiff = { ...material, status: "deleted", after: null, sections: [] };
    m.reviewDiff.mockResolvedValue({ change: { path: "Content/SM_Box.uasset", status: "deleted", kind: "package", assetDiff: deleted } });
    await diffOf({ ...REVIEW.items[2], status: "deleted" });
    expect((screen.getByAltText("SM_Box.uasset deleted") as HTMLImageElement).src).toContain("a".repeat(40));
    expect([...document.querySelectorAll(".review-pictures figcaption")].map((c) => c.textContent)).toEqual(["Deleted"]);
    cleanup();
    // An added asset with no facts at all gets its tile, to say what it is.
    m.reviewDiff.mockResolvedValue({ change: { path: "Content/SM_Box.uasset", status: "added", kind: "package", assetDiff: { ...added, after: { ...added.after!, facts: [] } } } });
    await diffOf(REVIEW.items[2]);
    expect(within(screen.getByRole("group", { name: "Material SM_Box.uasset" })).getByText("New in this turn")).toBeTruthy();
    expect(document.querySelector("[role='treegrid']")).toBeNull();
  });

  it("gives a changed asset with records no tile where neither version has a picture, and compares only the facts that differ", async () => {
    const level: AssetDiff = {
      state: "ready", status: "modified", assetClass: "World", summary: "3 differences", nativeDiff: { available: true },
      before: { class: "World", facts: [{ name: "Actors", value: "41" }, { name: "Streaming", value: "World Partition" }] },
      after: { class: "World", facts: [{ name: "Actors", value: "42" }, { name: "Streaming", value: "World Partition" }] },
      sections: [{ category: "Actors", kind: "components", engineSource: "DiffUtils::CompareUnrelatedSCS", entries: [
        { displayString: "Added actor SM_Crate_2", diffType: "OBJECT_ADDED", group: "SM_Crate_2" },
        { displayString: "Relative Location", diffType: "PropertyValueChanged", path: "Relative Location", before: "(X=0)", after: "(X=10)", group: "Gate" },
        { displayString: "Hidden", diffType: "PropertyValueChanged", path: "Hidden", before: "A", after: "B", hidden: true },
      ] }],
    };
    m.reviewDiff.mockResolvedValue({ change: { path: "Content/Maps/L_Gate.umap", status: "modified", kind: "package", assetDiff: level } });
    await diffOf({ ...REVIEW.items[1], path: "Content/Maps/L_Gate.umap", asset: "/Game/Maps/L_Gate.L_Gate", group: "level" });
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector(".review-pictures")).toBeNull();
    expect(document.querySelector(".asset-tile")).toBeNull();
    expect(treeRow("Actors").className).toContain("dt-section");
    expect(cellsOf("SM_Crate_2")[0].querySelector(".dt-glyph")!.textContent).toBe("+Added");
    expect(cellsOf("Gate › Relative Location").slice(1).map((c) => c.textContent!.replace(/\u00a0/g, " "))).toEqual(["X 0", "X 10"]);
    // The Actors section and the Actors fact are two rows.
    const named = [...document.querySelectorAll<HTMLElement>("[role='row']")].filter((r) => r.querySelector(".dt-label")?.textContent === "Actors");
    expect(named.map((r) => r.textContent)).toEqual(["▾Actors2", "~ChangedActors4142"]);
    expect(screen.queryByText("Streaming")).toBeNull();
    expect(screen.queryByText(/unchanged fact/)).toBeNull();
  });

  it("shows a changed asset with no records and no picture as the facts that differ, in the grid, with no tile", async () => {
    const sound: AssetDiff = {
      state: "ready", status: "modified", assetClass: "SoundWave", summary: "SoundWave changed. Duration: 1.250 s to 0.980 s", nativeDiff: { available: true }, sections: [],
      before: { class: "SoundWave", facts: [{ name: "Duration", value: "1.250 s" }, { name: "Channels", value: "2" }], thumbnail: { error: "Unreal has no thumbnail renderer for SoundWave" } },
      after: { class: "SoundWave", facts: [{ name: "Duration", value: "0.980 s" }, { name: "Channels", value: "2" }], thumbnail: { error: "Unreal has no thumbnail renderer for SoundWave" } },
    };
    m.reviewDiff.mockResolvedValue({ change: { path: "Content/Audio/SW_Chime.uasset", status: "modified", kind: "package", assetDiff: sound } });
    await diffOf({ ...REVIEW.items[1], path: "Content/Audio/SW_Chime.uasset", asset: "/Game/Audio/SW_Chime.SW_Chime", group: "asset" });
    // No tile: the line above names the asset, and the fact that changed is a row of the grid.
    expect(document.querySelector(".asset-tile")).toBeNull();
    expect(cellsOf("Duration").slice(1).map((c) => c.textContent)).toEqual(["1.250 s", "0.980 s"]);
    expect(treeRow("Duration").className).toContain("mod");
    expect(screen.queryByText(/unchanged fact/)).toBeNull();
    expect(screen.queryByText("Channels")).toBeNull();
    // Why a changed asset has no picture is not news.
    expect(screen.queryByText(/No picture/)).toBeNull();
  });

  it("drops both pictures when one side's thumbnail fails to load", async () => {
    m.reviewDiff.mockResolvedValue({ change: { path: "Content/BP_Door.uasset", status: "modified", kind: "package", assetDiff: pictured } });
    await diffOf(REVIEW.items[1]);
    fireEvent.error(screen.getByAltText("BP_Door.uasset after"));
    expect(document.querySelector("img")).toBeNull();
    expect(screen.queryByText(/No picture/)).toBeNull();
    expect(document.querySelector(".review-pictures")).toBeNull();
    expect(treeRow("Material Graph")).toBeTruthy();
  });

  it("shows why the engine could not diff a package", async () => {
    m.reviewDiff.mockResolvedValue({ change: { path: "Content/BP_Door.uasset", status: "modified", kind: "package", assetDiff: { state: "error", error: "the package could not be loaded for diff: bad header", summary: "", nativeDiff: { available: false } } } });
    await diffOf(REVIEW.items[1]);
    const alert = screen.getByRole("alert").textContent!;
    expect(alert).toContain("Unreal could not load this asset to diff it");
    expect(alert).toContain("the package could not be loaded for diff: bad header");
    expect(alert).toContain("Revert puts the file back exactly as it was before this turn");
  });

  it("keeps the pictures an older review captured", async () => {
    m.reviewDiff.mockResolvedValue({ change: { path: "Content/SM_Box.uasset", status: "added", kind: "package" }, after: "abc-def-1.png" });
    await diffOf({ ...REVIEW.items[2], visual: true });
    expect((screen.getByAltText("SM_Box.uasset after the turn") as HTMLImageElement).src).toContain("/v1/ext/studio/review/images/abc-def-1.png");
    expect([...document.querySelectorAll(".review-pictures figcaption")].map((c) => c.textContent)).toEqual(["New"]);
    expect(screen.queryByText("Did not exist before this turn")).toBeNull();
  });

  it("shows an older review's changed asset with one captured picture as its tile, not a lone side", async () => {
    m.reviewDiff.mockResolvedValue({ change: { path: "Content/SM_Box.uasset", status: "modified", kind: "package" }, after: "abc-def-1.png" });
    await diffOf({ ...REVIEW.items[2], status: "modified", visual: true });
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByRole("group", { name: "Asset SM_Box.uasset" })).toBeTruthy();
  });

  it("shows the tile for an older review that captured no picture", async () => {
    m.reviewDiff.mockResolvedValue({ change: { path: "Content/SM_Box.uasset", status: "added", kind: "package" } });
    await diffOf({ ...REVIEW.items[2], visual: true });
    expect(document.querySelector("img")).toBeNull();
    const tile = screen.getByRole("group", { name: "Asset SM_Box.uasset" });
    expect(tile.getAttribute("data-family")).toBe("mesh");
    expect(tile.textContent).toContain("/Game/SM_Box.SM_Box");
    expect(tile.textContent).toContain("No picture was captured for this asset.");
  });
});

describe("a flat picture", () => {
  const px = (...rgba: number[][]) => rgba.flat();
  it("is one colour within a small tolerance, or nothing opaque at all", () => {
    expect(isFlatPicture(px([0, 0, 0, 255], [0, 0, 0, 255]))).toBe(true);
    expect(isFlatPicture(px([8, 8, 8, 255], [12, 11, 9, 255]))).toBe(true);
    expect(isFlatPicture(px([0, 0, 0, 0], [200, 10, 10, 0]))).toBe(true);
    expect(isFlatPicture(px([8, 8, 8, 255], [120, 60, 20, 255]))).toBe(false);
    // A transparent pixel does not count against the opaque ones.
    expect(isFlatPicture(px([8, 8, 8, 255], [250, 250, 250, 0]))).toBe(true);
  });
});

describe("a struct of numbers", () => {
  it("reads as its fields and short numbers, and any other text is left alone", () => {
    expect(numberStruct("(X=1200.000000,Y=-280.000000,Z=0.000000)")).toBe("X 1200, Y -280, Z 0");
    expect(numberStruct("(R=0.500000,G=0.100000,B=0.000000,A=1.000000)")).toBe("R 0.5, G 0.1, B 0, A 1");
    expect(numberStruct("(Name=\"Tint\",Value=1)")).toBeNull();
    expect(numberStruct("600.000000")).toBeNull();
  });
});

describe("the timeline", () => {
  const MARKS: TimelineMark[] = [
    { checkpoint: "1".repeat(40), label: "Make the door", at: "2026-10-24T10:00:00.000Z", kind: "turn", turn: 0 },
    { checkpoint: "2".repeat(40), label: "Fix the hinge", at: "2026-10-24T10:05:00.000Z", kind: "turn", turn: 4 },
    { checkpoint: "3".repeat(40), label: "Restored to: Make the door", at: "2026-10-24T10:06:00.000Z", kind: "restore", undo: "4".repeat(40) },
  ];
  const panel = async (review: boolean | null = null, onChanged = vi.fn()) => {
    m.reviewStatus.mockResolvedValue({ default: true });
    await act(async () => void render(<ReviewPanel sessionId="s1" review={review} timeline={MARKS} onChanged={onChanged} />));
    return onChanged;
  };

  it("lists the marks newest first, a restore with Undo and each turn with Restore to here", async () => {
    await panel();
    const items = screen.getAllByRole("listitem");
    expect(items.map((li) => li.querySelector(".timeline-label")?.textContent)).toEqual(["Restored to: Make the door", "Fix the hinge", "Make the door"]);
    expect(within(items[0]).getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(within(items[1]).getByRole("button", { name: "Restore to here" })).toBeTruthy();
  });

  it("restores to a turn after a confirming click, and undoes a restore", async () => {
    m.timelineRestore.mockResolvedValue({ timeline: MARKS, outcome: { ...none, restored: ["Config/DefaultGame.ini"] } });
    m.timelineUndo.mockResolvedValue({ timeline: MARKS, outcome: none });
    const changed = await panel();
    const items = screen.getAllByRole("listitem");
    fireEvent.click(within(items[2]).getByRole("button", { name: "Restore to here" }));
    expect(m.timelineRestore).not.toHaveBeenCalled();
    await act(async () => void fireEvent.click(within(items[2]).getByRole("button", { name: "Restore every file" })));
    expect(m.timelineRestore).toHaveBeenCalledWith("s1", "1".repeat(40), false);
    await act(async () => void fireEvent.click(within(screen.getAllByRole("listitem")[0]).getByRole("button", { name: "Undo" })));
    expect(m.timelineUndo).toHaveBeenCalledWith("s1", "3".repeat(40));
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("offers to restore the files edited outside the agent too, with force", async () => {
    m.timelineRestore.mockResolvedValueOnce({ timeline: MARKS, outcome: { ...none, conflicts: ["Config/DefaultGame.ini"] } });
    await panel();
    fireEvent.click(within(screen.getAllByRole("listitem")[1]).getByRole("button", { name: "Restore to here" }));
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Restore every file" })));
    m.timelineRestore.mockResolvedValueOnce({ timeline: MARKS, outcome: none });
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Restore those too" })));
    expect(m.timelineRestore).toHaveBeenLastCalledWith("s1", "2".repeat(40), true);
  });

  it("switches review for the session, back to the default as null", async () => {
    m.setSessionReview.mockResolvedValue({ review: false });
    await panel();
    const box = screen.getByRole("checkbox") as HTMLInputElement;
    expect(box.checked).toBe(true);
    await act(async () => void fireEvent.click(box));
    expect(m.setSessionReview).toHaveBeenCalledWith("s1", false);
    cleanup();
    await panel(false);
    await act(async () => void fireEvent.click(screen.getByRole("checkbox")));
    expect(m.setSessionReview).toHaveBeenLastCalledWith("s1", null);
  });
});

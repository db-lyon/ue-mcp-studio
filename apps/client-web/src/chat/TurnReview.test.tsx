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
import { isFlatPicture } from "./AssetDiff";

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
    { path: "Config/DefaultGame.ini", status: "modified", kind: "config", group: "config", state: "pending", summary: "1 line added, 1 removed", native: { available: false, reason: "Config and source files have no diff view in Unreal; the text diff here is the whole change." } },
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
    expect(within(r).getByRole("alert").textContent).toMatch(/You edited this file after the agent/);
    expect(within(r).queryByRole("button", { name: "Revert" })).toBeNull();
    fireEvent.click(within(r).getByRole("button", { name: "Revert anyway" }));
    expect(m.reviewRevert).not.toHaveBeenCalled();
    m.reviewRevert.mockResolvedValue({ review: withItem("Config/DefaultGame.ini", { state: "reverted" }), outcome: { ...none, restored: ["Config/DefaultGame.ini"] } });
    await act(async () => void fireEvent.click(within(r).getByRole("button", { name: "Revert and lose my edits" })));
    expect(m.reviewRevert).toHaveBeenCalledWith("s1", "r1", ["Config/DefaultGame.ini"], true);
  });

  it("gives every item its one-line summary, and opens Unreal's diff where the engine has one", async () => {
    card();
    expect(within(row("Content/BP_Door.uasset")).getByText("2 changes: Open Angle 0.0 to 90.0; Added Node Branch")).toBeTruthy();
    expect(within(row("Config/DefaultGame.ini")).getByText("1 line added, 1 removed")).toBeTruthy();
    const ini = within(row("Config/DefaultGame.ini")).getByRole("button", { name: "Open in Unreal diff" }) as HTMLButtonElement;
    expect(ini.disabled).toBe(true);
    expect(ini.title).toMatch(/no diff view in Unreal/);
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

  it("says what a revert left alone", async () => {
    m.reviewRevert.mockResolvedValue({ review: withItem("Config/DefaultGame.ini", { conflict: true }), outcome: { ...none, conflicts: ["Config/DefaultGame.ini"] } });
    card();
    await act(async () => void fireEvent.click(within(row("Config/DefaultGame.ini")).getByRole("button", { name: "Revert" })));
    expect(screen.getByText("1 file was edited after the agent and left as they are.")).toBeTruthy();
  });
});

describe("the diff view", () => {
  const diffOf = async (item: TurnReview["items"][number]) => {
    await act(async () => void render(<ItemDiff sessionId="s1" reviewId="r1" item={item} />));
  };

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

  it("shows a material instance's parameters in words, the engine's text on hover", async () => {
    const raw = (v: string) => `((ParameterInfo=(Name="Roughness",Association=GlobalParameter,Index=-1),ParameterValue=${v},ExpressionGUID=00000000000000000000000000000000))`;
    const mi: AssetDiff = { ...material, assetClass: "MaterialInstanceConstant", sections: [{ category: "Details", kind: "properties", engineSource: "", entries: [{ displayString: "", diffType: "PropertyValueChanged", path: "Scalar Parameter Values", before: raw("0.500000"), after: raw("0.800000") }] }] };
    m.reviewDiff.mockResolvedValue({ change: { path: "Content/BP_Door.uasset", status: "modified", kind: "package", assetDiff: mi } });
    await diffOf(REVIEW.items[1]);
    const after = screen.getByText((_, el) => el?.classList.contains("diff-value") === true && el.textContent?.replace(/ /g, " ") === "Roughness = 0.8");
    expect(after.getAttribute("title")).toBe(raw("0.800000"));
  });

  it("shows what an added or removed node holds", async () => {
    const added = { displayString: "Added Node Constant", diffType: "NODE_ADDED", category: "ADDITION", node1: { guid: "1", name: "N", class: "MaterialGraphNode", title: "Constant", fullTitle: "0.35", pins: [{ name: "B", displayName: "B", defaultValue: "0.5", linked: false }, { name: "A", displayName: "A", defaultValue: "1", linked: true }], properties: [{ name: "R", displayName: "Value", value: "0.350000", isDefault: false }, { name: "Desc", displayName: "Desc", value: "", isDefault: true }] } };
    const graph = (e: unknown): AssetDiff => ({ ...material, sections: [{ category: "Material Graph", kind: "graph", engineSource: "", entries: [e as never] }] });
    m.reviewDiff.mockResolvedValue({ change: { path: "Content/BP_Door.uasset", status: "modified", kind: "package", assetDiff: graph(added) } });
    await diffOf(REVIEW.items[1]);
    // The added node's values sit under After, one pin per line; Before says it was not there.
    const row = screen.getByText("Added Node Constant").closest("tr")!;
    const [change, before, after] = [...row.children] as HTMLElement[];
    expect(row.children).toHaveLength(3);
    expect(change.textContent).toBe("AddedAdded Node Constant");
    expect(before.className).toContain("cmp-absent");
    expect(before.textContent).toBe("not there");
    expect([...after.querySelectorAll(".cmp-kv > div")].map((d) => d.textContent)).toEqual(["Value0.35", "B0.5"]);
  });

  it("keeps every record's cells in their columns: a removed node's values under Before, a property's values side by side, a graph record's properties as rows of their own", async () => {
    const removed = { displayString: "Removed Node Print String", diffType: "NODE_REMOVED", category: "SUBTRACTION", node1: { guid: "1", name: "N", class: "K2Node_CallFunction", title: "Print String", fullTitle: "Print String\nTarget is Kismet System Library", pins: [{ name: "Duration", displayName: "Duration", defaultValue: "2.0", linked: false }, { name: "TextColor", displayName: "Text Color", defaultValue: "(R=0.000000,G=0.660000,B=1.000000,A=1.000000)", linked: false }] } };
    const links = { displayString: "Pin 'then' has more links (was 0 now 1)", diffType: "PIN_LINKEDTO_NUM_INC", category: "MODIFICATION" };
    const moved = { displayString: "Node moved", diffType: "NODE_MOVED", category: "MINOR" };
    const prop = { displayString: "Property Changed: Default Value", diffType: "NODE_PROPERTY", category: "MODIFICATION", properties: [{ displayString: "Default Value", diffType: "PropertyValueChanged", path: "Default Value", before: "0.200000", after: "0.700000" }] };
    const graph: AssetDiff = { ...material, sections: [{ category: "EventGraph", kind: "graph", engineSource: "", entries: [removed, links, moved, prop] as never }] };
    m.reviewDiff.mockResolvedValue({ change: { path: "Content/BP_Door.uasset", status: "modified", kind: "package", assetDiff: graph } });
    await diffOf(REVIEW.items[1]);
    const table = screen.getByRole("region", { name: "EventGraph" }).querySelector("table")!;
    expect(table.querySelector("[colspan]")).toBeNull();
    for (const tr of table.querySelectorAll("tbody tr")) expect(tr.children).toHaveLength(3);
    const cells = (text: string) => [...screen.getByText(text).closest("tr")!.children] as HTMLElement[];
    const [rc, rb, ra] = cells("Removed Node Print String");
    expect(rc.querySelector(".cmp-subtitle")!.textContent).toBe("Print String, Target is Kismet System Library");
    expect([...rb.querySelectorAll(".cmp-kv dt")].map((d) => d.textContent)).toEqual(["Duration", "Text Color"]);
    // A colour keeps its text, with a swatch beside it.
    expect(rb.querySelector(".cmp-swatch")!.getAttribute("style")).toContain("rgb(0, 212, 255)");
    expect(rb.textContent).toContain("(R=0.000000,G=0.660000,B=1.000000,A=1.000000)");
    expect(ra.textContent).toBe("gone");
    // The link row's own was/now text stays in Change, and both sides are empty.
    const [, lb, la] = cells("Pin 'then' has more links (was 0 now 1)");
    expect(lb.className).toContain("cmp-empty");
    expect(la.className).toContain("cmp-empty");
    expect(screen.getByText("Pin 'then' has more links (was 0 now 1)").closest("tr")!.className).toContain("bare");
    expect(screen.getByText("Node moved").closest("tr")!.className).toContain("minor");
    // The property under the graph record is a row of its own, before and after on the same line.
    const sub = screen.getByText("Default Value").closest("tr")!;
    expect(sub.className).toContain("sub");
    expect([...sub.children].map((c) => c.textContent)).toEqual(["ChangedDefault Value", "0.2", "0.7"]);
  });

  it("lets a long engine name wrap only between its parts", () => {
    card(withItem("Content/BP_Door.uasset", { path: "Content/Characters/BP_PlayerCharacterMovementComponent.uasset" }));
    const name = document.querySelector(".review-item-name")!;
    expect(name.textContent).toBe("BP_PlayerCharacterMovementComponent.uasset");
    expect(name.querySelectorAll("wbr").length).toBeGreaterThanOrEqual(4);
  });

  it("shows a package's engine diff: pictures, each category's records with before and after, and the facts", async () => {
    m.reviewDiff.mockResolvedValue({ change: { path: "Content/BP_Door.uasset", status: "modified", kind: "package", assetDiff: material } });
    await diffOf(REVIEW.items[1]);
    expect((screen.getByAltText("BP_Door.uasset before") as HTMLImageElement).src).toContain(`/v1/ext/studio/review/thumbnails/${"a".repeat(40)}`);
    expect(screen.getByText(/No picture: Unreal has no thumbnail renderer for Material/)).toBeTruthy();
    const graph = screen.getByRole("region", { name: "Material Graph" });
    expect(within(graph).getByText("Added Node Constant")).toBeTruthy();
    expect(within(graph).getByText("0.2")).toBeTruthy();
    expect(within(graph).getByText("0.7")).toBeTruthy();
    const details = screen.getByRole("region", { name: "Details" });
    const two = within(details).getByText("Two Sided").closest("tr")!;
    expect(two.textContent).toContain("False");
    expect(two.textContent).toContain("True");
    expect(within(details).queryByText("Lighting Guid")).toBeNull();
    fireEvent.click(within(details).getByRole("button", { name: "Show 2 more differences in properties the details panel does not show" }));
    expect(within(details).getByText("Lighting Guid").closest("tr")!.textContent).toContain("B2");
    // The fact that differs is compared at once; none is the same, so there is no unchanged line.
    const facts = screen.getByRole("region", { name: "Facts" });
    expect(within(facts).getByText("Blend mode").closest("tr")!.textContent).toContain("BLEND_Masked");
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

  it("shows a widget's changed property under the widget, by its details panel label, and only the facts that differ", async () => {
    m.reviewDiff.mockResolvedValue({ change: { path: widgetItem.path, status: "modified", kind: "package", assetDiff: widget } });
    await diffOf(widgetItem);
    const tree = screen.getByRole("region", { name: "Widget Blueprint" });
    expect(within(tree).getByText("Widget WardMeter")).toBeTruthy();
    const row = within(tree).getByText("Hide when Full").closest("tr")!;
    expect(row.querySelector("td[data-label='Before']")!.textContent).toBe("False");
    expect(row.querySelector("td[data-label='After']")!.textContent).toBe("True");
    expect(within(tree).getByText("Warning: This may be missing changes to Animations and Bindings")).toBeTruthy();
    // Every fact is the same: no Before and After for them, one folded line that counts them.
    expect(screen.queryByRole("region", { name: "Facts" })).toBeNull();
    const same = screen.getByText("5 unchanged facts").closest("details")!;
    expect(same.open).toBe(false);
    const listed = screen.getByText("ValeHUDWidget").closest("tr")!;
    expect(listed.querySelector("td[data-label]")).toBeNull();
    // The summary is the card's line above; the body does not say it again, and has no raw structure dump.
    expect(screen.queryByText(/no difference/)).toBeNull();
    expect(screen.queryByText(/Structure/)).toBeNull();
  });

  it("shows nothing but the folded facts for a Widget Blueprint whose widget tree was not compared, and never says no difference", async () => {
    const old: AssetDiff = { ...widget, engine: { ...widget.engine!, blueprintTypeDiff: undefined }, sections: [], before: { ...widget.before!, thumbnail: { error: "x" } }, after: { ...widget.after!, thumbnail: { error: "x" } }, summary: "Widget Blueprint changed. This ue-mcp bridge cannot compare widget properties. Open in Unreal diff to see them." };
    m.reviewDiff.mockResolvedValue({ change: { path: widgetItem.path, status: "modified", kind: "package", assetDiff: old } });
    await diffOf({ ...widgetItem, summary: old.summary });
    expect(document.querySelector(".asset-tile")).toBeNull();
    expect(document.querySelector(".review-pictures")).toBeNull();
    expect(screen.getByText("5 unchanged facts")).toBeTruthy();
    expect(screen.queryByText(/no difference/)).toBeNull();
  });

  it("hides a picture that is one flat colour, so a renderer that drew nothing shows no black panel", async () => {
    const flat = new Uint8ClampedArray(64 * 64 * 4).map((_, i) => (i % 4 === 3 ? 255 : 0));
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: () => undefined, getImageData: () => ({ data: flat }) } as unknown as CanvasRenderingContext2D);
    try {
      m.reviewDiff.mockResolvedValue({ change: { path: widgetItem.path, status: "modified", kind: "package", assetDiff: widget } });
      await diffOf(widgetItem);
      const before = screen.getByAltText("WBP_GameHUD.uasset before");
      expect(before.className).toBe("picture-pending");
      fireEvent.load(before);
      fireEvent.load(screen.getByAltText("WBP_GameHUD.uasset after"));
      // Neither version has a picture now, and the records are the change: no frame, no tile, no error.
      expect(document.querySelector("img")).toBeNull();
      expect(document.querySelector(".review-pictures")).toBeNull();
      expect(document.querySelector(".asset-tile")).toBeNull();
      expect(screen.queryByText(/No picture/)).toBeNull();
      expect(screen.getByRole("region", { name: "Widget Blueprint" })).toBeTruthy();
    } finally {
      getContext.mockRestore();
    }
  });

  it("shows a picture once it is known to show something", async () => {
    const shaded = new Uint8ClampedArray(64 * 64 * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 7) % 256));
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: () => undefined, getImageData: () => ({ data: shaded }) } as unknown as CanvasRenderingContext2D);
    try {
      m.reviewDiff.mockResolvedValue({ change: { path: widgetItem.path, status: "modified", kind: "package", assetDiff: widget } });
      await diffOf(widgetItem);
      const before = screen.getByAltText("WBP_GameHUD.uasset before");
      fireEvent.load(before);
      expect(before.className).toBe("");
    } finally {
      getContext.mockRestore();
    }
  });

  it("says an added asset did not exist before, and a deleted one is gone", async () => {
    const added: AssetDiff = { ...material, status: "added", before: null, sections: [] };
    m.reviewDiff.mockResolvedValue({ change: { path: "Content/SM_Box.uasset", status: "added", kind: "package", assetDiff: added } });
    await diffOf(REVIEW.items[2]);
    // Neither version has a picture, so the tile says it is new.
    expect(within(screen.getByRole("group", { name: "Material SM_Box.uasset" })).getByText("New in this turn")).toBeTruthy();
    cleanup();
    const deleted: AssetDiff = { ...material, status: "deleted", after: null, sections: [] };
    m.reviewDiff.mockResolvedValue({ change: { path: "Content/SM_Box.uasset", status: "deleted", kind: "package", assetDiff: deleted } });
    await diffOf({ ...REVIEW.items[2], status: "deleted" });
    expect(screen.getByText("Deleted in this turn")).toBeTruthy();
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
    expect(screen.getByRole("region", { name: "Actors" })).toBeTruthy();
    const facts = screen.getByRole("region", { name: "Facts" });
    expect(within(facts).getByText("Actors").closest("tr")!.textContent).toBe("Actors4142");
    expect(within(facts).queryByText("Streaming")).toBeNull();
    expect(screen.getByText("1 unchanged fact").closest("details")!.open).toBe(false);
  });

  it("puts the asset's type, path and facts where neither version has a picture and no record says what changed", async () => {
    const sound: AssetDiff = {
      state: "ready", status: "modified", assetClass: "SoundWave", summary: "SoundWave changed. Duration: 1.250 s to 0.980 s", nativeDiff: { available: true }, sections: [],
      before: { class: "SoundWave", facts: [{ name: "Duration", value: "1.250 s" }, { name: "Channels", value: "2" }], thumbnail: { error: "Unreal has no thumbnail renderer for SoundWave" } },
      after: { class: "SoundWave", facts: [{ name: "Duration", value: "0.980 s" }, { name: "Channels", value: "2" }], thumbnail: { error: "Unreal has no thumbnail renderer for SoundWave" } },
    };
    m.reviewDiff.mockResolvedValue({ change: { path: "Content/Audio/SW_Chime.uasset", status: "modified", kind: "package", assetDiff: sound } });
    await diffOf({ ...REVIEW.items[1], path: "Content/Audio/SW_Chime.uasset", asset: "/Game/Audio/SW_Chime.SW_Chime", group: "asset" });
    const tile = screen.getByRole("group", { name: "SoundWave SW_Chime.uasset" });
    expect(tile.getAttribute("data-family")).toBe("sound");
    expect(tile.querySelector("svg.asset-icon")).toBeTruthy();
    expect(tile.textContent).toContain("Changed in this turn");
    expect(tile.textContent).toContain("/Game/Audio/SW_Chime.SW_Chime");
    // The tile names the fact that changed, with its old value; the one that did not is counted on a folded line.
    const facts = [...tile.querySelectorAll(".asset-tile-facts > div")].map((d) => d.textContent);
    expect(facts).toEqual(["Duration1.250 s to 0.980 s"]);
    expect(screen.queryByRole("region", { name: "Facts" })).toBeNull();
    expect(screen.getByText("1 unchanged fact").closest("details")!.open).toBe(false);
    expect(tile.textContent).toContain("No picture: Unreal has no thumbnail renderer for SoundWave");
  });

  it("says why a side's thumbnail failed to load, and drops the pictures when neither loads", async () => {
    const both: AssetDiff = { ...material, after: { ...material.after!, thumbnail: { id: "b".repeat(40), url: "", source: "rendered" } } };
    m.reviewDiff.mockResolvedValue({ change: { path: "Content/BP_Door.uasset", status: "modified", kind: "package", assetDiff: both } });
    await diffOf(REVIEW.items[1]);
    fireEvent.error(screen.getByAltText("BP_Door.uasset after"));
    expect(screen.getByText("No picture: the file could not be read.")).toBeTruthy();
    fireEvent.error(screen.getByAltText("BP_Door.uasset before"));
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector(".review-pictures")).toBeNull();
    expect(screen.getByRole("region", { name: "Material Graph" })).toBeTruthy();
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
    expect(screen.getByText("Did not exist before this turn")).toBeTruthy();
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

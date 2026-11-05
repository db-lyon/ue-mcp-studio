import { describe, expect, it } from "vitest";
import { diffTree, diffValue, inlineChange, inlineFits, pathLevels, sectionRow, treeLines, type DiffTreeRow } from "../src/diff-tree.js";
import type { AssetDiff, AssetDiffSection } from "../src/review.js";

/** Each line as "depth|glyph tone|label|before|after", to compare a tree at a glance. */
const lines = (roots: DiffTreeRow[], toggled = new Set<string>()) =>
  treeLines(roots, toggled).map(({ row, depth }) => [depth, row.tone ?? "", row.label.join(" > "), row.before?.text ?? (row.beforeNone ? "none" : ""), row.after?.text ?? (row.afterNone ? "none" : "")].join("|"));

const section = (s: Partial<AssetDiffSection>): AssetDiffSection => ({ category: "Details", kind: "properties", engineSource: "X", entries: [], ...s });

describe("the diff tree", () => {
  it("folds a widget's one changed property into one row under its section", () => {
    const s = sectionRow(section({ category: "Widget Blueprint", notes: ["Warning: may miss Animations"], entries: [
      { group: "Widget WardMeter", path: "bHideWhenFull", label: "Hide when Full", diffType: "PropertyValueChanged", displayString: "bHideWhenFull changed value in WardMeter", before: "False", after: "True" },
    ] }));
    expect(lines([s])).toEqual(["0||Widget Blueprint||", "1|mod|Widget WardMeter > Hide when Full|False|True"]);
    expect(s.count).toBe(1);
    expect(s.title).toContain("Warning: may miss Animations");
    // The engine's message and the property's own name are on the hover.
    expect(s.children[0].title).toContain("bHideWhenFull");
  });

  it("keeps a group with several changes as a node, with its count, and splits property paths into levels", () => {
    const s = sectionRow(section({ entries: [
      { group: "Gate", path: "Relative Location", diffType: "PropertyValueChanged", displayString: "", before: "(X=1200.000000,Y=-280.000000,Z=0.000000)", after: "(X=1180.000000,Y=-280.000000,Z=0.000000)" },
      { group: "Gate", path: "Body Instance.Collision Profile Name", diffType: "PropertyValueChanged", displayString: "", before: "BlockAll", after: "OverlapAll" },
      { group: "Gate", path: "Body Instance.Mass In Kg", diffType: "PropertyValueChanged", displayString: "", before: "10.000000", after: "12.500000" },
      { path: "Waves[0].Spawns[2].Count", diffType: "PropertyValueChanged", displayString: "", before: "3", after: "5" },
    ] }));
    expect(lines([s])).toEqual([
      "0||Details||",
      "1||Gate||",
      "2|mod|Relative Location|X 1200, Y -280, Z 0|X 1180, Y -280, Z 0",
      "2||Body Instance||",
      "3|mod|Collision Profile Name|BlockAll|OverlapAll",
      "3|mod|Mass In Kg|10|12.5",
      "1|mod|Waves[0] > Spawns[2] > Count|3|5",
    ]);
    expect(s.children[0].count).toBe(3);
    expect(s.count).toBe(4);
  });

  it("shows an added row's After only and a removed row's Before only", () => {
    const s = sectionRow(section({ category: "My Blueprint", entries: [
      { group: "bCanWallRun", path: "bCanWallRun", diffType: "PropertyAddedToB", displayString: "Added Variable bCanWallRun", before: null, after: "bool = true" },
      { group: "OldSpeed", path: "OldSpeed", diffType: "PropertyAddedToA", displayString: "Removed Variable OldSpeed", before: "real = 2", after: null },
    ] }));
    expect(lines([s])).toEqual(["0||My Blueprint||", "1|add|bCanWallRun||bool = true", "1|del|OldSpeed|real = 2|"]);
    expect(inlineChange(s.children[0])).toBe("bool = true");
  });

  it("puts graph records under their node, an added node's values as its details, and reads was and now as values", () => {
    const s = sectionRow(section({ category: "Graph: EventGraph", kind: "graph", entries: [
      { displayString: "Added Node 'PrintString'", diffType: "NODE_ADDED", category: "ADDITION", node1: { guid: "5", name: "N5", class: "K2Node_CallFunction", title: "PrintString", fullTitle: "Print String", pins: [
        { name: "InString", displayName: "In String", defaultValue: "Hello", linked: false },
        { name: "Duration", displayName: "Duration", defaultValue: "2.000000", linked: false },
      ] } },
      { displayString: "Node moved", diffType: "NODE_MOVED", category: "MINOR", node1: { guid: "5", name: "N5", class: "K2Node_CallFunction", title: "PrintString" } },
      { displayString: "Pin 'then' has more links (was 0 now 1)", diffType: "PIN_LINKEDTO_NUM_INC", category: "MODIFICATION", node1: { guid: "6", name: "N6", class: "K2Node_Event", title: "Event ActorBeginOverlap" } },
      { displayString: "Pin Default Value Changed: Speed", diffType: "PIN_DEFAULT_VALUE", category: "MODIFICATION", node1: { guid: "7", name: "N7", class: "K2Node_CallFunction", title: "SetSpeed" }, pin1: { name: "Speed", direction: "input", defaultValue: "600.0", linkedTo: [] }, pin2: { name: "Speed", direction: "input", defaultValue: "450.0", linkedTo: [] } },
      { displayString: "Property Changed: Default Value", diffType: "NODE_PROPERTY", category: "MODIFICATION", node2: { guid: "4", name: "N4", class: "MaterialGraphNode", title: "Roughness" }, properties: [{ displayString: "Default Value", diffType: "PropertyValueChanged", path: "Default Value", before: "0.200000", after: "0.700000" }] },
      { displayString: "Removed Node Delay", diffType: "NODE_REMOVED", category: "SUBTRACTION", node1: { guid: "8", name: "N8", class: "K2Node_CallFunction", title: "Delay", pins: [{ name: "Duration", displayName: "Duration", defaultValue: "0.2", linked: false }] } },
    ] }));
    expect(lines([s])).toEqual([
      "0||Graph: EventGraph||",
      "1|add|PrintString||",
      "2||In String||Hello",
      "2||Duration||2",
      "2|minor|Moved||",
      "1|mod|Event ActorBeginOverlap > then > Links|0|1",
      "1|mod|SetSpeed > Speed|600|450",
      "1|mod|Roughness > Default Value|0.2|0.7",
      "1|del|Delay||",
      "2||Duration|0.2|",
    ]);
    // An added node with a move under it is two changes; its values are not changes.
    expect(s.children[0].count).toBe(2);
    expect(s.count).toBe(6);
    expect(s.children[0].note).toBeUndefined();
  });

  it("keeps what the details panel does not show in a closed group of its own", () => {
    const s = sectionRow(section({ entries: [
      { path: "Two Sided", diffType: "PropertyValueChanged", displayString: "", before: "False", after: "True" },
      { path: "Lighting Guid", diffType: "PropertyValueChanged", displayString: "", before: "A1", after: "B2", hidden: true },
    ] }));
    expect(lines([s])).toEqual(["0||Details||", "1|mod|Two Sided|False|True", "1||Not in the details panel||"]);
    expect(lines([s], new Set(["s:Details/hidden"]))).toContain("2|mod|Lighting Guid|A1|B2");
    expect(s.count).toBe(1);
  });

  it("closes a group when it is toggled", () => {
    const s = sectionRow(section({ entries: [{ group: "A", path: "X", diffType: "PropertyValueChanged", displayString: "", before: "1", after: "2" }, { group: "A", path: "Y", diffType: "PropertyValueChanged", displayString: "", before: "1", after: "2" }] }));
    expect(lines([s], new Set(["s:Details/g:A"]))).toEqual(["0||Details||", "1||A||"]);
  });

  it("adds the facts that differ and no record shows, and a one-version asset's facts closed beside its tile", () => {
    const d: AssetDiff = {
      state: "ready", summary: "", nativeDiff: { available: true }, sections: [],
      before: { class: "SoundWave", facts: [{ name: "Duration", value: "1.25 s" }, { name: "Channels", value: "2" }] },
      after: { class: "SoundWave", facts: [{ name: "Duration", value: "0.98 s" }, { name: "Channels", value: "2" }] },
    };
    expect(lines(diffTree(d))).toEqual(["0||Facts||", "1|mod|Duration|1.25 s|0.98 s"]);
    // The tile lists it already.
    expect(diffTree(d, { shown: true, facts: 4 })).toEqual([]);
    const added: AssetDiff = { ...d, before: null, after: { class: "X", facts: [1, 2, 3, 4, 5].map((n) => ({ name: `F${n}`, value: String(n) })) } };
    const [one] = diffTree(added, { shown: true, facts: 4 });
    expect(one.closed).toBe(true);
    expect(lines([one], new Set([one.id]))[1]).toBe("1||F1||1");
  });

  it("puts a value in words, keeps several lines or items for the cell opened in place, and marks a long one", () => {
    expect(diffValue("0.500000")).toMatchObject({ text: "0.5", lines: null, long: false });
    expect(diffValue("Line one\nLine two")).toMatchObject({ text: "Line one ↵ Line two", lines: ["Line one", "Line two"], long: true });
    expect(diffValue('("Goblin","Orc","Troll")')).toMatchObject({ lines: ["Goblin", "Orc", "Troll"], long: true });
    expect(diffValue("(R=1.000000,G=0.000000,B=0.000000,A=1.000000)").color).toBe("rgba(255, 0, 0, 1)");
    expect(diffValue("x".repeat(60)).long).toBe(true);
    expect(diffValue("/Script/Engine.BlueprintGeneratedClass'/Game/Enemies/BP_Orc.BP_Orc_C'").text).toBe("/Game/Enemies/BP_Orc");
    expect(diffValue("/Script/Engine.Texture2D'/Game/T_Rock.T_Rock'").text).toBe("/Game/T_Rock");
    const params = `((ParameterInfo=(Name="Roughness",Association=GlobalParameter,Index=-1),ParameterValue=0.550000,ExpressionGUID=0),(ParameterInfo=(Name="Moss",Association=GlobalParameter,Index=-1),ParameterValue=0.300000,ExpressionGUID=0))`;
    expect(diffValue(params).lines).toEqual(["Roughness = 0.55", "Moss = 0.3"]);
  });

  it("opens a parameter list, a struct and a list of structs into rows: only what differs when both versions have it, every field on an added or removed one's side", () => {
    const scalar = (name: string, v: string) => `(ParameterInfo=(Name="${name}",Association=GlobalParameter,Index=-1),ParameterValue=${v},ExpressionGUID=0)`;
    const s = sectionRow(section({ entries: [
      { path: "Scalar Parameter Values", diffType: "PropertyValueChanged", displayString: "", before: `(${scalar("Roughness", "0.550000")},${scalar("Moss", "0.300000")},${scalar("Wet", "1.000000")})`, after: `(${scalar("Roughness", "0.800000")},${scalar("Moss", "0.650000")},${scalar("Wet", "1.000000")})` },
      { path: "Waves[2]", diffType: "PropertyAddedToA", displayString: "", before: "(Spawns=((EnemyClass=None,Count=1)),DelayBeforeStart=4.000000)", after: null },
      { path: "Spawn Point Tag", diffType: "PropertyAddedToB", displayString: "", before: null, after: '(TagName="Spawn.Gate.North")' },
      { path: "Tags", diffType: "PropertyValueChanged", displayString: "", before: '("Gate")', after: '("Gate","Destructible")' },
      { path: "Light Color", diffType: "PropertyValueChanged", displayString: "", before: "(B=40,G=120,R=255,A=255)", after: "(B=20,G=90,R=255,A=255)" },
    ] }));
    expect(lines([s])).toEqual([
      "0||Details||",
      "1|mod|Scalar Parameter Values||",
      "2|mod|Roughness|0.55|0.8",
      "2|mod|Moss|0.3|0.65",
      "1|del|Waves[2]||",
      "2||Spawns||",
      "3||[0]||",
      "4||EnemyClass|None|",
      "4||Count|1|",
      "2||DelayBeforeStart|4|",
      "1|add|Spawn Point Tag||Spawn.Gate.North",
      "1|mod|Tags|Gate|Gate, Destructible",
      "1|mod|Light Color|R\u00a0255, G\u00a0120, B\u00a040, A\u00a0255|R\u00a0255, G\u00a090, B\u00a020, A\u00a0255",
    ]);
    // A parameter list is one change, not three.
    expect(s.count).toBe(5);
  });

  it("splits a path at its levels, never inside an index or a number", () => {
    expect(pathLevels("Waves[0].Spawns[2].Enemy Class")).toEqual(["Waves[0]", "Spawns[2]", "Enemy Class"]);
    expect(pathLevels("LOD 1.5 Screen Size")).toEqual(["LOD 1.5 Screen Size"]);
    expect(pathLevels("Body Instance > Mass")).toEqual(["Body Instance", "Mass"]);
  });

  it("says a row's change on one line for a narrow card", () => {
    expect(inlineChange({ before: diffValue("False"), after: diffValue("True") })).toBe("False → True");
    expect(inlineChange({ before: diffValue("0.2") })).toBe("0.2");
    expect(inlineChange({ beforeNone: true, after: diffValue("") })).toBe("none → empty");
  });

  it("keeps a short row's values on its name's line on a narrow card, and a long one under it", () => {
    const short = { id: "a", label: ["Mobility"], tone: "mod" as const, children: [], count: 1, before: diffValue("Static"), after: diffValue("Movable") };
    expect(inlineFits(short, 1, 340)).toBe(true);
    expect(inlineFits({ ...short, label: ["BP_SpawnPoint_North_UpperBattlements_01", "Relative Location"] }, 1, 340)).toBe(false);
    expect(inlineFits({ ...short, before: undefined, after: undefined }, 1, 340)).toBe(false);
  });
});

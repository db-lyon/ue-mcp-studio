/**
 * Review card states for the visual QA harness: one turn's changes, every
 * item state, and the diffs the agent answers when an item opens. The diffs
 * are the shapes ue-mcp's asset diff sends, passed through the agent's own
 * refineAssetDiff as the agent does.
 */
import { refineAssetDiff, reviewItemOf, type AssetDiff, type CheckpointChange, type SessionDetail, type TurnReview } from "@ue-mcp-studio/shared";
import type { Scenario } from "./fixtures";

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const SESSION_ID = "qa-session";

const scalar = (name: string, v: string) => `(ParameterInfo=(Name="${name}",Association=GlobalParameter,Index=-1),ParameterValue=${v},ExpressionGUID=5A1F0C2E4B7D9E3F8A6B1C0D2E4F6A8B)`;
const tint = (r: string) => `(ParameterInfo=(Name="MossTint",Association=GlobalParameter,Index=-1),ParameterValue=(R=${r},G=0.420000,B=0.180000,A=1.000000),ExpressionGUID=0B2C4D6E8F0A1B2C3D4E5F6A7B8C9D0E)`;

const PATHS = {
  bp: "Content/Characters/Player/BP_PlayerCharacterMovementComponent.uasset",
  mi: "Content/Environment/Materials/MI_RockMossyCliffFace_Variant02.uasset",
  material: "Content/Environment/Materials/M_RockMaster.uasset",
  config: "Config/DefaultEngine.ini",
  level: "Content/Maps/L_Playtest.umap",
  crate: "Content/Props/SM_CrateWoodenLarge.uasset",
  input: "Content/Input/Actions/IA_WallRunWhileCrouched.uasset",
  widget: "Content/UI/HUD/WBP_GameHUD.uasset",
  widgetOld: "Content/UI/HUD/WBP_PauseMenu.uasset",
  sound: "Content/Audio/SW_WardChime.uasset",
  waves: "Content/Data/DA_EnemyWaves_ShrineDefenseEncounter.uasset",
  arena: "Content/Maps/L_ShrineArena.umap",
};

/** A rendered thumbnail; the harness draws one for any id, 404s an id with "unreadable" in it, and draws flat black for one with "blank" in it. */
const shot = (id: string) => ({ id, url: "", source: "rendered" as const });

const ready = (d: Partial<AssetDiff>): AssetDiff => refineAssetDiff({ state: "ready", status: "modified", summary: "", nativeDiff: { available: true }, ...d } as AssetDiff);

const BLUEPRINT = ready({
  assetClass: "Blueprint",
  engine: { tool: "SBlueprintDiff", note: "Graphs through FGraphDiffControl::DiffGraphs, components through DiffUtils::CompareUnrelatedSCS, variables and class defaults through DiffUtils::CompareUnrelatedStructs.", native: "window", nativeAvailable: true },
  before: { class: "Blueprint", thumbnail: shot("bp-before"), facts: [{ name: "Parent class", value: "Character" }, { name: "Variables", value: "3" }, { name: "Variable MaxSprintSpeedMultiplier", value: "real = 1.5" }] },
  after: { class: "Blueprint", thumbnail: shot("bp-after"), facts: [{ name: "Parent class", value: "Character" }, { name: "Variables", value: "4" }, { name: "Variable MaxSprintSpeedMultiplier", value: "real = 1.8" }, { name: "Variable bCanWallRunWhileCrouched", value: "bool = true" }] },
  summary: "5 differences: Removed ...",
  sections: [
    { category: "Graph: EventGraph", kind: "graph", engineSource: "FGraphDiffControl::DiffGraphs", entries: [
      { displayString: "Added Node Branch", diffType: "NODE_ADDED", category: "ADDITION", node2: { guid: "1", name: "K2Node_IfThenElse_3", class: "K2Node_IfThenElse", title: "Branch" } },
      { displayString: "Pin Default Value Changed: InSpeedMultiplierForCharacterMovementComponent", diffType: "PIN_DEFAULT_VALUE", category: "MODIFICATION", pin1: { name: "InSpeedMultiplierForCharacterMovementComponent", direction: "input", defaultValue: "1.5", linkedTo: [] }, pin2: { name: "InSpeedMultiplierForCharacterMovementComponent", direction: "input", defaultValue: "1.8", linkedTo: [] }, node1: { guid: "2", name: "K2Node_CallFunction_7", class: "K2Node_CallFunction", title: "SetMaxWalkSpeedFromSprintMultiplier" } },
      { displayString: "Added Node 'PrintString'", diffType: "NODE_ADDED", category: "ADDITION", node1: { guid: "5", name: "K2Node_CallFunction_9", class: "K2Node_CallFunction", title: "PrintString", fullTitle: "Print String", pins: [
        { name: "InString", displayName: "In String", defaultValue: "Wall run started while crouched", linked: false },
        { name: "bPrintToScreen", displayName: "Print to Screen", defaultValue: "true", linked: false },
        { name: "bPrintToLog", displayName: "Print to Log", defaultValue: "true", linked: false },
        { name: "TextColor", displayName: "Text Color", defaultValue: "(R=0.000000,G=0.660000,B=1.000000,A=1.000000)", linked: false },
        { name: "Duration", displayName: "Duration", defaultValue: "2.000000", linked: false },
        { name: "Key", displayName: "Key", defaultValue: "None", linked: false },
      ] } },
      { displayString: "Pin 'then' has more links (was 0 now 1)", diffType: "PIN_LINKEDTO_NUM_INC", category: "MODIFICATION", node1: { guid: "6", name: "K2Node_Event_0", class: "K2Node_Event", title: "Event ActorBeginOverlap" } },
      { displayString: "Node moved", diffType: "NODE_MOVED", category: "MINOR", node1: { guid: "1", name: "K2Node_IfThenElse_3", class: "K2Node_IfThenElse", title: "Branch" } },
    ] },
    { category: "Components", kind: "components", engineSource: "DiffUtils::CompareUnrelatedSCS", entries: [
      { group: "CharacterMovement", path: "MaxWalkSpeedCrouched", diffType: "NODE_PROPERTY_CHANGED", displayString: "MaxWalkSpeedCrouched changed on CharacterMovement", before: "300.000000", after: "260.000000" },
    ] },
    { category: "My Blueprint", kind: "properties", engineSource: "DiffUtils::CompareUnrelatedStructs", entries: [
      { group: "bCanWallRunWhileCrouched", diffType: "PropertyAddedToB", displayString: "Added Variable bCanWallRunWhileCrouched", before: null, after: "bool = true", path: "bCanWallRunWhileCrouched" },
      { group: "MaxSprintSpeedMultiplier", path: "Default Value", property: "DefaultValue", diffType: "PropertyValueChanged", displayString: "Default Value", before: "1.5", after: "1.8" },
    ] },
    { category: "Defaults", kind: "properties", engineSource: "DiffUtils::CompareUnrelatedObjects", entries: [
      { path: "bCanWallRunWhileCrouched", property: "bCanWallRunWhileCrouched", diffType: "PropertyAddedToB", displayString: "bCanWallRunWhileCrouched", before: null, after: "True" },
      { path: "MaxSprintSpeedMultiplier", property: "MaxSprintSpeedMultiplier", diffType: "PropertyValueChanged", displayString: "MaxSprintSpeedMultiplier", before: "1.500000", after: "1.800000" },
      { path: "Jump Max Hold Time", property: "JumpMaxHoldTime", diffType: "PropertyValueChanged", displayString: "Jump Max Hold Time", before: "0.000000", after: "0.250000" },
    ] },
  ],
});

const MATERIAL_INSTANCE = ready({
  assetClass: "MaterialInstanceConstant",
  engine: { tool: "SMaterialInstanceDiff", note: "The instance's details through DiffUtils::CompareUnrelatedObjects.", native: "details", nativeAvailable: true },
  before: { class: "MaterialInstanceConstant", thumbnail: shot("mi-before"), facts: [{ name: "Parent", value: "/Game/Environment/Materials/M_RockMaster.M_RockMaster" }, { name: "Scalar parameter Roughness", value: "0.55" }] },
  after: { class: "MaterialInstanceConstant", thumbnail: { error: "the thumbnail render timed out after 5 s" }, facts: [{ name: "Parent", value: "/Game/Environment/Materials/M_RockMaster.M_RockMaster" }, { name: "Scalar parameter Roughness", value: "0.8" }] },
  summary: "2 differences: Scalar Parameter Values ((ParameterInfo=(Name=\"Roughness\",Associat...",
  sections: [{ category: "Details", kind: "properties", engineSource: "DiffUtils::CompareUnrelatedObjects", entries: [
    { path: "Scalar Parameter Values", property: "ScalarParameterValues", diffType: "PropertyValueChanged", displayString: "Scalar Parameter Values", before: `(${scalar("Roughness", "0.550000")},${scalar("MossCoverage", "0.300000")})`, after: `(${scalar("Roughness", "0.800000")},${scalar("MossCoverage", "0.650000")})` },
    { path: "Vector Parameter Values", property: "VectorParameterValues", diffType: "PropertyValueChanged", displayString: "Vector Parameter Values", before: `(${tint("0.210000")})`, after: `(${tint("0.330000")})` },
  ] }],
});

/** The material's facts and its graph, the added node before its values are filled in below. */
const MATERIAL_BASE = ready({
  assetClass: "Material",
  engine: { tool: "SMaterialDiff", note: "The material graph through FGraphDiffControl::DiffGraphs, and its details through DiffUtils::CompareUnrelatedObjects.", native: "window", nativeAvailable: true },
  before: { class: "Material", facts: [{ name: "Blend mode", value: "BLEND_Opaque" }, { name: "Expressions", value: "14" }] },
  after: { class: "Material", thumbnail: shot("material-after-unreadable"), facts: [{ name: "Blend mode", value: "BLEND_Opaque" }, { name: "Expressions", value: "15" }] },
  summary: "2 differences: Added Node Constant; Roughness Default Value 0.2 to 0.7",
  sections: [{ category: "Material Graph", kind: "graph", engineSource: "FGraphDiffControl::DiffGraphs", entries: [
    { displayString: "Added Node Constant", diffType: "NODE_ADDED", category: "ADDITION", node2: { guid: "3", name: "MaterialGraphNode_15", class: "MaterialGraphNode", title: "Constant" } },
    { displayString: "Property Changed: Default Value", diffType: "NODE_PROPERTY", category: "MODIFICATION", node2: { guid: "4", name: "MaterialGraphNode_4", class: "MaterialGraphNode", title: "Roughness" }, properties: [{ displayString: "Default Value changed value in Roughness", diffType: "PropertyValueChanged", path: "Default Value", before: "0.200000", after: "0.700000" }] },
  ] }],
});

/** The material: added and removed nodes carry their values. */
const MATERIAL: AssetDiff = {
  ...MATERIAL_BASE,
  summary: "3 differences: Removed Node Multiply; Added Node Constant; Roughness Default Value 0.2 to 0.7",
  sections: [{ ...MATERIAL_BASE.sections![0], entries: [
    { displayString: "Removed Node Multiply", diffType: "NODE_REMOVED", category: "SUBTRACTION", node1: { guid: "5", name: "MaterialGraphNode_9", class: "MaterialGraphNode", title: "Multiply", propertiesOf: "MaterialExpressionMultiply",
      pins: [{ name: "A", displayName: "A", defaultValue: "", linked: true }, { name: "B", displayName: "B", defaultValue: "0.5", linked: false }],
      properties: [{ name: "ConstA", displayName: "Const A", value: "0.000000", isDefault: true }, { name: "ConstB", displayName: "Const B", value: "0.500000", isDefault: false }] } },
    { displayString: "Added Node Constant", diffType: "NODE_ADDED", category: "ADDITION", node1: { guid: "3", name: "MaterialGraphNode_15", class: "MaterialGraphNode", title: "Constant", fullTitle: "0.35", propertiesOf: "MaterialExpressionConstant",
      pins: [], properties: [{ name: "R", displayName: "Value", value: "0.350000", isDefault: false }, { name: "Desc", displayName: "Desc", value: "", isDefault: true }] } },
    ...MATERIAL_BASE.sections![0].entries.slice(1),
  ] }],
};

/** A level: Unreal keeps no thumbnail for a World, so the tile takes the picture's place. */
const LEVEL = ready({
  assetClass: "World",
  packageName: "/Game/Maps/L_Playtest",
  engine: { tool: "SLevelDiff", note: "Actors through DiffUtils::CompareUnrelatedSCS and their properties through DiffUtils::CompareUnrelatedObjects.", native: "window", nativeAvailable: true },
  before: { class: "World", facts: [{ name: "Actors", value: "41" }, { name: "Streaming", value: "World Partition" }, { name: "Game mode override", value: "BP_PlaytestGameMode_C" }] },
  after: { class: "World", facts: [{ name: "Actors", value: "42" }, { name: "Streaming", value: "World Partition" }, { name: "Game mode override", value: "BP_PlaytestGameMode_C" }] },
  summary: "2 differences: Added actor SM_CrateWoodenLarge_PlacedNearTheGate; ShrineGate Relative Location",
  sections: [{ category: "Actors", kind: "components", engineSource: "DiffUtils::CompareUnrelatedSCS", entries: [
    { group: "SM_CrateWoodenLarge_PlacedNearTheGate", displayString: "Added actor SM_CrateWoodenLarge_PlacedNearTheGate", diffType: "OBJECT_ADDED", facts: [{ name: "Class", value: "StaticMeshActor" }, { name: "Location", value: "(X=1240, Y=-310, Z=0)" }] },
    { group: "ShrineGate", path: "Relative Location", diffType: "PropertyValueChanged", displayString: "Relative Location", before: "(X=1200.000000,Y=-280.000000,Z=0.000000)", after: "(X=1180.000000,Y=-280.000000,Z=0.000000)" },
  ] }],
});

/** An Input Action added in the turn: no thumbnail and no earlier version. */
const INPUT_ACTION = ready({
  status: "added",
  assetClass: "InputAction",
  packageName: "/Game/Input/Actions/IA_WallRunWhileCrouched",
  engine: { tool: "SDetailsDiff", note: "Its details through DiffUtils::CompareUnrelatedObjects.", native: "details", nativeAvailable: true },
  before: null,
  after: { class: "InputAction", facts: [{ name: "Value type", value: "Digital (bool)" }, { name: "Triggers", value: "Pressed" }, { name: "Consume input", value: "true" }] },
  summary: "New InputAction",
  sections: [],
});

const HUD_FACTS = [{ name: "Parent class", value: "ValeHUDWidget" }, { name: "Blueprint type", value: "BPTYPE_Normal" }, { name: "Variables", value: "0" }, { name: "Graphs", value: "1" }, { name: "Components", value: "0" }];

/**
 * WBP_GameHUD as ue-mcp diffs it with UBlueprint::FindDiffs: one property of a
 * widget in the widget tree changed, every fact the same, and both rendered
 * thumbnails black (the Widget Blueprint renderer draws nothing for a Blueprint
 * loaded for diff), as an older bridge sent them.
 */
const WIDGET = ready({
  assetClass: "WidgetBlueprint",
  packageName: "/Game/UI/HUD/WBP_GameHUD",
  engine: { tool: "SBlueprintDiff", note: "The Blueprint diff: the Blueprint type's own differences (a Widget Blueprint's widget tree) through UBlueprint::FindDiffs, graphs through FGraphDiffControl::DiffGraphs, components through DiffUtils::CompareUnrelatedSCS, My Blueprint variables, Defaults on the class default object and Class Settings, the last three through DiffUtils::CompareUnrelatedStructs.", native: "window", nativeAvailable: true, blueprintTypeDiff: true },
  before: { class: "WidgetBlueprint", thumbnail: shot("hud-before-blank"), facts: HUD_FACTS },
  after: { class: "WidgetBlueprint", thumbnail: shot("hud-after-blank"), facts: HUD_FACTS },
  summary: "1 difference: Widget WardMeter > Hide when Full False to True",
  sections: [{ category: "Widget Blueprint", kind: "properties", engineSource: "UBlueprint::FindDiffs", notes: ["Warning: This may be missing changes to Animations and Bindings"], hiddenChanges: 0, entries: [
    { group: "Widget WardMeter", path: "bHideWhenFull", label: "Hide when Full", property: "bHideWhenFull", diffType: "PropertyValueChanged", displayString: "bHideWhenFull changed value in WardMeter", before: "False", after: "True" },
  ] }],
});

/** A Widget Blueprint diffed by a bridge that does not compare the widget tree: never "no difference". */
const WIDGET_OLD = ready({
  assetClass: "WidgetBlueprint",
  packageName: "/Game/UI/HUD/WBP_PauseMenu",
  engine: { tool: "SBlueprintDiff", note: "The Blueprint diff: graphs through FGraphDiffControl::DiffGraphs, components through DiffUtils::CompareUnrelatedSCS, My Blueprint variables, Defaults on the class default object and Class Settings, the last three through DiffUtils::CompareUnrelatedStructs.", native: "window", nativeAvailable: true },
  before: { class: "WidgetBlueprint", thumbnail: shot("pause-before-blank"), facts: HUD_FACTS },
  after: { class: "WidgetBlueprint", thumbnail: shot("pause-after-blank"), facts: HUD_FACTS },
  summary: "WidgetBlueprint: the file changed, and Unreal's diff finds no difference",
  sections: [],
});

/** A binary asset Unreal diffs as a whole file: no records, only facts about each version. */
const SOUND = ready({
  assetClass: "SoundWave",
  packageName: "/Game/Audio/SW_WardChime",
  engine: { tool: "DiffUtils::CompareUnrelatedObjects", note: "Unreal has no diff view of its own for SoundWave: its asset diff exports both versions as text for an external diff tool. These records are the details-panel property diff.", native: "details", nativeAvailable: true },
  before: { class: "SoundWave", thumbnail: { error: "Unreal has no thumbnail renderer for SoundWave; and this version's package has no saved thumbnail" }, facts: [{ name: "Duration", value: "1.250 s" }, { name: "Channels", value: "2" }, { name: "Sample rate", value: "48000" }] },
  after: { class: "SoundWave", thumbnail: { error: "Unreal has no thumbnail renderer for SoundWave; and this version's package has no saved thumbnail" }, facts: [{ name: "Duration", value: "0.980 s" }, { name: "Channels", value: "2" }, { name: "Sample rate", value: "48000" }] },
  summary: "SoundWave: the file changed, and Unreal's diff finds no difference",
  sections: [],
});

const cls = (bp: string) => `/Script/Engine.BlueprintGeneratedClass'/Game/Enemies/${bp}.${bp}_C'`;

/** A data asset with deep property paths, added and removed array entries, long and many-line values. */
const WAVES = ready({
  assetClass: "PrimaryDataAsset",
  packageName: "/Game/Data/DA_EnemyWaves_ShrineDefenseEncounter",
  engine: { tool: "SDetailsDiff", note: "Its details through DiffUtils::CompareUnrelatedObjects.", native: "details", nativeAvailable: true },
  before: { class: "EnemyWaveSet", facts: [{ name: "Waves", value: "3" }] },
  after: { class: "EnemyWaveSet", facts: [{ name: "Waves", value: "2" }] },
  summary: "10 differences: Waves[0].Spawns[0].Count: 3 to 5; Waves[2] removed; and 8 more; plus 1 difference in properties the details panel does not show",
  sections: [{ category: "Details", kind: "properties", engineSource: "DiffUtils::CompareUnrelatedObjects", entries: [
    { path: "Waves[0].Spawns[0].Enemy Class", diffType: "PropertyValueChanged", displayString: "Enemy Class", before: cls("BP_GoblinSkirmisher"), after: cls("BP_OrcBerserkerWithShieldAndTorch") },
    { path: "Waves[0].Spawns[0].Count", diffType: "PropertyValueChanged", displayString: "Count", before: "3", after: "5" },
    { path: "Waves[0].Spawns[1].Count", diffType: "PropertyValueChanged", displayString: "Count", before: "2", after: "4" },
    { path: "Waves[0].Delay Before Start", diffType: "PropertyValueChanged", displayString: "Delay Before Start", before: "1.500000", after: "2.000000" },
    { path: "Waves[1].Spawns[0].Spawn Point Tag", diffType: "PropertyAddedToB", displayString: "Spawn Point Tag", before: null, after: "(TagName=\"Spawn.Gate.North.UpperBattlements\")" },
    { path: "Waves[2]", diffType: "PropertyAddedToA", displayString: "Waves[2]", before: `(Spawns=((EnemyClass=${cls("BP_TrollChieftain")},Count=1)),DelayBeforeStart=4.000000)`, after: null },
    { path: "Description", diffType: "PropertyValueChanged", displayString: "Description", before: "Two waves at the shrine gate.", after: "Two waves at the shrine gate.\nThe second wave comes over the north battlements, so the player has to climb the stairs to meet it.\nNo troll this time." },
    { path: "Allowed Biomes", diffType: "PropertyValueChanged", displayString: "Allowed Biomes", before: "(\"Forest\",\"Swamp\")", after: "(\"Forest\",\"Swamp\",\"Tundra\",\"Volcanic Ash Plains\")" },
    { path: "Difficulty.Curve.Keys[3].Value", diffType: "PropertyValueChanged", displayString: "Value", before: "1.250000", after: "1.600000" },
    { path: "Difficulty.Curve.Keys[3].Interp Mode", diffType: "PropertyValueChanged", displayString: "Interp Mode", before: "RCIM_Linear", after: "RCIM_Cubic" },
    { path: "Cached Spawn Budget", diffType: "PropertyValueChanged", displayString: "Cached Spawn Budget", before: "18", after: "27", hidden: true },
  ] }],
});

const actor = (name: string, of: string, at: string) => ({ group: name, displayString: `Added actor ${name}`, diffType: "OBJECT_ADDED", facts: [{ name: "Class", value: of }, { name: "Location", value: at }] });
const moved = (name: string, before: string, after: string) => ({ group: name, path: "Relative Location", diffType: "PropertyValueChanged", displayString: "Relative Location", before, after });

/** A level with many changes in one asset: actors added, removed and moved, several properties on one actor. */
const ARENA = ready({
  assetClass: "World",
  packageName: "/Game/Maps/L_ShrineArena",
  engine: { tool: "SLevelDiff", note: "Actors through DiffUtils::CompareUnrelatedSCS and their properties through DiffUtils::CompareUnrelatedObjects.", native: "window", nativeAvailable: true },
  before: { class: "World", facts: [{ name: "Actors", value: "88" }] },
  after: { class: "World", facts: [{ name: "Actors", value: "91" }] },
  summary: "14 differences: Added actor BP_SpawnPoint_North_UpperBattlements_01; Removed actor BP_SpawnPoint_South_01; and 12 more",
  sections: [{ category: "Actors", kind: "components", engineSource: "DiffUtils::CompareUnrelatedSCS", entries: [
    actor("BP_SpawnPoint_North_UpperBattlements_01", "BP_SpawnPoint_C", "(X=2040, Y=-1310, Z=640)"),
    actor("BP_SpawnPoint_North_UpperBattlements_02", "BP_SpawnPoint_C", "(X=2240, Y=-1310, Z=640)"),
    actor("PointLight_Brazier_East", "PointLight", "(X=880, Y=410, Z=120)"),
    actor("SM_Barricade_Stairs", "StaticMeshActor", "(X=1520, Y=-900, Z=0)"),
    { group: "BP_SpawnPoint_South_01", displayString: "Removed actor BP_SpawnPoint_South_01", diffType: "OBJECT_REMOVED", facts: [{ name: "Class", value: "BP_SpawnPoint_C" }, { name: "Location", value: "(X=-1200, Y=900, Z=0)" }] },
    moved("ShrineGate", "(X=1200.000000,Y=-280.000000,Z=0.000000)", "(X=1180.000000,Y=-280.000000,Z=0.000000)"),
    { group: "ShrineGate", path: "Relative Rotation", diffType: "PropertyValueChanged", displayString: "Relative Rotation", before: "(Pitch=0.000000,Yaw=90.000000,Roll=0.000000)", after: "(Pitch=0.000000,Yaw=75.000000,Roll=0.000000)" },
    { group: "ShrineGate", path: "Mobility", diffType: "PropertyValueChanged", displayString: "Mobility", before: "Static", after: "Movable" },
    { group: "ShrineGate", path: "Tags", diffType: "PropertyValueChanged", displayString: "Tags", before: "(\"Gate\")", after: "(\"Gate\",\"Destructible\",\"Objective\")" },
    moved("Torch_West_01", "(X=-300.000000,Y=120.000000,Z=80.000000)", "(X=-320.000000,Y=120.000000,Z=80.000000)"),
    moved("Torch_West_02", "(X=-300.000000,Y=420.000000,Z=80.000000)", "(X=-320.000000,Y=420.000000,Z=80.000000)"),
    { group: "PointLight_Brazier_West", path: "Light Color", diffType: "PropertyValueChanged", displayString: "Light Color", before: "(B=40,G=120,R=255,A=255)", after: "(B=20,G=90,R=255,A=255)" },
    { group: "PointLight_Brazier_West", path: "Intensity", diffType: "PropertyValueChanged", displayString: "Intensity", before: "5000.000000", after: "8000.000000" },
    { group: "PostProcessVolume_Arena", path: "Settings.Bloom Intensity", diffType: "PropertyValueChanged", displayString: "Bloom Intensity", before: "0.675000", after: "0.900000" },
  ] }],
});

/** Assets only their own scenarios open, not on the every-state card. */
export const EXTRA: CheckpointChange[] = [
  { path: PATHS.waves, status: "modified", kind: "package", assetDiff: WAVES },
  { path: PATHS.arena, status: "modified", kind: "package", assetDiff: ARENA },
];

const CONFIG_DIFF = "--- a/Config/DefaultEngine.ini\n+++ b/Config/DefaultEngine.ini\n@@ -12,3 +12,4 @@\n [/Script/Engine.RendererSettings]\n-r.DefaultFeature.AutoExposure=True\n+r.DefaultFeature.AutoExposure=False\n+r.Lumen.HardwareRayTracing.LightingMode=2\n r.ReflectionMethod=1\n";

export const CHANGES: CheckpointChange[] = [
  { path: PATHS.bp, status: "modified", kind: "package", assetDiff: BLUEPRINT },
  { path: PATHS.mi, status: "modified", kind: "package", assetDiff: MATERIAL_INSTANCE },
  { path: PATHS.material, status: "modified", kind: "package", assetDiff: MATERIAL },
  { path: PATHS.level, status: "modified", kind: "package", assetDiff: LEVEL },
  { path: PATHS.input, status: "added", kind: "package", assetDiff: INPUT_ACTION },
  { path: PATHS.config, status: "modified", kind: "config", diff: CONFIG_DIFF },
  { path: PATHS.widget, status: "modified", kind: "package", assetDiff: WIDGET },
  { path: PATHS.widgetOld, status: "modified", kind: "package", assetDiff: WIDGET_OLD },
  { path: PATHS.sound, status: "modified", kind: "package", assetDiff: SOUND },
  { path: PATHS.crate, status: "modified", kind: "package", assetDiff: { state: "error", error: "Failed to load /Game/Props/SM_CrateWoodenLarge: the package was saved by a newer engine version", summary: "Could not diff: Failed to load /Game/Props/SM_CrateWoodenLarge: the package was saved by a newer engine version", nativeDiff: { available: false, reason: "Unreal could not load it." } } },
];

const items = CHANGES.map(reviewItemOf);
const set = (path: string, o: Partial<TurnReview["items"][number]>) => {
  const it = items.find((i) => i.path === path)!;
  Object.assign(it, o);
};
set(PATHS.material, { state: "kept" });
set(PATHS.config, { state: "reverted", undo: "c".repeat(40) });
set(PATHS.level, { conflict: true, untracked: true });

const reviewOf = (list: TurnReview["items"]): TurnReview => ({ id: "review-1", turn: 0, before: "a".repeat(40), after: "b".repeat(40), at: ago(4), items: list });

const sessionOf = (review: TurnReview, ask: string, reply: string): SessionDetail => ({
  id: SESSION_ID, title: "Sprint and wall run tuning", status: "idle", createdAt: ago(30), updatedAt: ago(3), waitingCause: null, archived: false, agents: { total: 0, running: 0 }, awaiting: 0,
  transcript: [
    { kind: "user", text: ask, at: ago(12) },
    { kind: "assistant", text: reply, at: ago(5) },
    { kind: "review", review },
  ],
  touched: [], draft: "", seen: [], dismissed: [], queue: [], error: null, approvals: [], review: null,
  timeline: [{ checkpoint: "b".repeat(40), label: ask, at: ago(4), kind: "turn", turn: 0 }],
} as unknown as SessionDetail);

const SESSION = sessionOf(
  reviewOf(items),
  "Make sprinting feel snappier, let the player wall run while crouched, and make the cliff rock look wetter and mossier.",
  "Done. I raised the sprint multiplier, added the wall run switch, and tuned the rock material and its mossy instance. The card below lists every file.",
);

/** A turn that changed one file, in the state given: its diff opens with the card. */
const single = (key: keyof typeof PATHS, o: Partial<TurnReview["items"][number]> = {}): SessionDetail => {
  const change = [...CHANGES, ...EXTRA].find((c) => c.path === PATHS[key])!;
  return sessionOf(reviewOf([{ ...reviewItemOf(change), ...o }]), "Hide the ward meter on the HUD once it is full.", "Done. The card below shows the change.");
};

const diffAnswer = (url: URL): unknown => {
  const path = url.searchParams.get("path");
  const change = [...CHANGES, ...EXTRA].find((c) => c.path === path);
  return change ? { change } : undefined;
};

const card = (title: string, open?: keyof typeof PATHS, scroll?: string): Scenario => ({
  title,
  hash: `#/chat/${SESSION_ID}`,
  session: SESSION,
  index: { playtests: [], listed: true },
  height: 1500,
  get: (p, url) => (/\/reviews\/[^/]+\/diff$/.test(p) ? diffAnswer(url) : undefined),
  ...(open ? { clicks: [`[data-path='${PATHS[open]}'] .review-item-name`], scroll: scroll ?? `[data-path='${PATHS[open]}']` } : {}),
});

/** A one-file turn: the card at the top of the shot, its diff open. */
const one = (title: string, session: SessionDetail, o: Partial<Scenario> = {}): Scenario => ({
  title,
  hash: `#/chat/${SESSION_ID}`,
  session,
  index: { playtests: [], listed: true },
  height: 1100,
  get: (p, url) => (/\/reviews\/[^/]+\/diff$/.test(p) ? diffAnswer(url) : undefined),
  scroll: ".review-card",
  ...o,
});

const revertButton = (key: keyof typeof PATHS) => `[data-path='${PATHS[key]}'] .review-actions button:text-is('Revert')`;

export const REVIEW_SCENARIOS: Record<string, Scenario> = {
  "review-card": card("Review card: every item state (pending, kept, reverted, edited outside the agent, a failed diff) with long engine names"),
  "review-blueprint": card("Review card, a Blueprint opened: the new variable and its changed default counted once, graph and component records", "bp"),
  "review-blueprint-variables": card("Review card, the same Blueprint scrolled to My Blueprint and Defaults: each variable once", "bp", "[data-id='s:My Blueprint']"),
  "review-material-instance": card("Review card, a material instance opened: its parameters in words, not the engine's struct text", "mi"),
  "review-material": card("Review card, a material opened: the added Constant shows its value, the removed Multiply its set constant", "material"),
  "review-level": card("Review card, a level opened: no thumbnail for a World, so its records and the fact that differs, with no tile", "level"),
  "review-input-action": card("Review card, an added Input Action opened: no thumbnail and no earlier version", "input"),
  "review-widget": card("Review card, a Widget Blueprint opened: one widget property changed, its black thumbnails hidden, no unchanged facts", "widget"),
  "review-widget-old-bridge": card("Review card, a Widget Blueprint diffed by a bridge that does not compare the widget tree: says so, never no difference", "widgetOld"),
  "review-binary": card("Review card, a sound wave opened: no structured diff, only the fact that differs", "sound"),
  "review-config": card("Review card, a reverted config file opened: its text diff", "config"),
  "review-one-widget": one("One file: a Widget Blueprint with one widget property changed, its diff open with the card", single("widget")),
  "review-one-blueprint": one("One file: a Blueprint with changes in its graph, components, variables and defaults", single("bp")),
  "review-one-binary": one("One file: a sound wave, a binary asset with no structured diff, only the fact that differs", single("sound")),
  "review-one-old-bridge": one("One file: a Widget Blueprint diffed by a bridge that does not compare the widget tree", single("widgetOld")),
  "review-one-old-bridge-remote": one("A paired browser: the same Widget Blueprint from an older bridge", single("widgetOld"), { remotePage: true }),
  "review-one-kept": one("One file kept: its state and Revert at the end of its name line", single("widget", { state: "kept" })),
  "review-one-reverted": one("One file reverted: its state and Undo revert", single("widget", { state: "reverted", undo: "c".repeat(40) })),
  "review-one-reverting": one("One file while its revert runs: Reverting in place of its controls", single("widget"), { clicks: [revertButton("widget")], hold: /\/revert$/ }),
  "review-one-revert-failed": one("One file whose revert failed: the reason under the file", single("widget"), {
    clicks: [revertButton("widget")],
    post: (p) => (p.endsWith("/revert") ? { status: 500, body: { error: "Could not restore Content/UI/HUD/WBP_GameHUD.uasset: the file is locked by another process." } } : undefined),
  }),
  "review-one-many": one("One file with many changes: a level's actors added, removed and moved, several properties on one actor", single("arena"), { height: 1300 }),
  "review-one-deep": one("One file with deep property paths: array entries added and removed, nested structs, long and many-line values", single("waves"), { height: 1300 }),
  "review-one-long-open": one("The same data asset with its many-line Description and its array opened in place", single("waves"), { height: 1300, clicks: ["[data-id='s:Details/p:Description'] .dt-after", "[data-id='s:Details/p:Allowed Biomes'] .dt-after"] }),
  "review-one-collapsed": one("The same data asset with Waves[0] collapsed to its count", single("waves"), { height: 1300, clicks: ["[data-id='s:Details/p:Waves[0]'] .dt-toggle"] }),
  "review-card-remote": { ...card("A paired browser: every item state"), remotePage: true },
};

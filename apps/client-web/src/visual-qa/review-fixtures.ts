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
  materialOlder: "Content/Environment/Materials/M_RockMasterLegacy.uasset",
  config: "Config/DefaultEngine.ini",
  level: "Content/Maps/L_Playtest.umap",
  crate: "Content/Props/SM_CrateWoodenLarge.uasset",
};

const ready = (d: Partial<AssetDiff>): AssetDiff => refineAssetDiff({ state: "ready", status: "modified", summary: "", nativeDiff: { available: true }, ...d } as AssetDiff);

const BLUEPRINT = ready({
  assetClass: "Blueprint",
  engine: { tool: "SBlueprintDiff", note: "Graphs through FGraphDiffControl::DiffGraphs, components through DiffUtils::CompareUnrelatedSCS, variables and class defaults through DiffUtils::CompareUnrelatedStructs.", native: "window", nativeAvailable: true },
  before: { class: "Blueprint", facts: [{ name: "Parent class", value: "Character" }, { name: "Variables", value: "3" }, { name: "Variable MaxSprintSpeedMultiplier", value: "real = 1.5" }] },
  after: { class: "Blueprint", facts: [{ name: "Parent class", value: "Character" }, { name: "Variables", value: "4" }, { name: "Variable MaxSprintSpeedMultiplier", value: "real = 1.8" }, { name: "Variable bCanWallRunWhileCrouched", value: "bool = true" }] },
  summary: "5 differences: Removed ...",
  sections: [
    { category: "Graph: EventGraph", kind: "graph", engineSource: "FGraphDiffControl::DiffGraphs", entries: [
      { displayString: "Added Node Branch", diffType: "NODE_ADDED", category: "ADDITION", node2: { guid: "1", name: "K2Node_IfThenElse_3", class: "K2Node_IfThenElse", title: "Branch" } },
      { displayString: "Pin Default Value Changed: InSpeedMultiplierForCharacterMovementComponent", diffType: "PIN_DEFAULT_VALUE", category: "MODIFICATION", node1: { guid: "2", name: "K2Node_CallFunction_7", class: "K2Node_CallFunction", title: "SetMaxWalkSpeedFromSprintMultiplier" } },
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
  before: { class: "MaterialInstanceConstant", facts: [{ name: "Parent", value: "/Game/Environment/Materials/M_RockMaster.M_RockMaster" }, { name: "Scalar parameter Roughness", value: "0.55" }] },
  after: { class: "MaterialInstanceConstant", facts: [{ name: "Parent", value: "/Game/Environment/Materials/M_RockMaster.M_RockMaster" }, { name: "Scalar parameter Roughness", value: "0.8" }] },
  summary: "2 differences: Scalar Parameter Values ((ParameterInfo=(Name=\"Roughness\",Associat...",
  sections: [{ category: "Details", kind: "properties", engineSource: "DiffUtils::CompareUnrelatedObjects", entries: [
    { path: "Scalar Parameter Values", property: "ScalarParameterValues", diffType: "PropertyValueChanged", displayString: "Scalar Parameter Values", before: `(${scalar("Roughness", "0.550000")},${scalar("MossCoverage", "0.300000")})`, after: `(${scalar("Roughness", "0.800000")},${scalar("MossCoverage", "0.650000")})` },
    { path: "Vector Parameter Values", property: "VectorParameterValues", diffType: "PropertyValueChanged", displayString: "Vector Parameter Values", before: `(${tint("0.210000")})`, after: `(${tint("0.330000")})` },
  ] }],
});

/** The material as an older daemon sends it: an added node with its title only. */
const MATERIAL_OLDER = ready({
  assetClass: "Material",
  engine: { tool: "SMaterialDiff", note: "The material graph through FGraphDiffControl::DiffGraphs, and its details through DiffUtils::CompareUnrelatedObjects.", native: "window", nativeAvailable: true },
  before: { class: "Material", facts: [{ name: "Blend mode", value: "BLEND_Opaque" }, { name: "Expressions", value: "14" }] },
  after: { class: "Material", facts: [{ name: "Blend mode", value: "BLEND_Opaque" }, { name: "Expressions", value: "15" }] },
  summary: "2 differences: Added Node Constant; Roughness Default Value 0.2 to 0.7",
  sections: [{ category: "Material Graph", kind: "graph", engineSource: "FGraphDiffControl::DiffGraphs", entries: [
    { displayString: "Added Node Constant", diffType: "NODE_ADDED", category: "ADDITION", node2: { guid: "3", name: "MaterialGraphNode_15", class: "MaterialGraphNode", title: "Constant" } },
    { displayString: "Property Changed: Default Value", diffType: "NODE_PROPERTY", category: "MODIFICATION", node2: { guid: "4", name: "MaterialGraphNode_4", class: "MaterialGraphNode", title: "Roughness" }, properties: [{ displayString: "Default Value changed value in Roughness", diffType: "PropertyValueChanged", path: "Default Value", before: "0.200000", after: "0.700000" }] },
  ] }],
});

/** The same material from a daemon on asset diff format 2: added and removed nodes carry their values. */
const MATERIAL: AssetDiff = {
  ...MATERIAL_OLDER,
  summary: "3 differences: Removed Node Multiply; Added Node Constant; Roughness Default Value 0.2 to 0.7",
  sections: [{ ...MATERIAL_OLDER.sections![0], entries: [
    { displayString: "Removed Node Multiply", diffType: "NODE_REMOVED", category: "SUBTRACTION", node1: { guid: "5", name: "MaterialGraphNode_9", class: "MaterialGraphNode", title: "Multiply", fullTitle: "Multiply(,0.5)", propertiesOf: "MaterialExpressionMultiply",
      pins: [{ name: "A", displayName: "A", defaultValue: "", linked: true }, { name: "B", displayName: "B", defaultValue: "0.5", linked: false }],
      properties: [{ name: "ConstA", displayName: "Const A", value: "0.000000", isDefault: true }, { name: "ConstB", displayName: "Const B", value: "0.500000", isDefault: false }] } },
    { displayString: "Added Node Constant", diffType: "NODE_ADDED", category: "ADDITION", node1: { guid: "3", name: "MaterialGraphNode_15", class: "MaterialGraphNode", title: "Constant", fullTitle: "0.35", propertiesOf: "MaterialExpressionConstant",
      pins: [], properties: [{ name: "R", displayName: "Value", value: "0.350000", isDefault: false }, { name: "Desc", displayName: "Desc", value: "", isDefault: true }] } },
    ...MATERIAL_OLDER.sections![0].entries.slice(1),
  ] }],
};

const CONFIG_DIFF = "--- a/Config/DefaultEngine.ini\n+++ b/Config/DefaultEngine.ini\n@@ -12,3 +12,4 @@\n [/Script/Engine.RendererSettings]\n-r.DefaultFeature.AutoExposure=True\n+r.DefaultFeature.AutoExposure=False\n+r.Lumen.HardwareRayTracing.LightingMode=2\n r.ReflectionMethod=1\n";

const CHANGES: CheckpointChange[] = [
  { path: PATHS.bp, status: "modified", kind: "package", assetDiff: BLUEPRINT },
  { path: PATHS.mi, status: "modified", kind: "package", assetDiff: MATERIAL_INSTANCE },
  { path: PATHS.material, status: "modified", kind: "package", assetDiff: MATERIAL },
  { path: PATHS.materialOlder, status: "modified", kind: "package", assetDiff: MATERIAL_OLDER },
  { path: PATHS.level, status: "modified", kind: "package", assetDiff: ready({ assetClass: "World", summary: "1 difference: Added actor SM_CrateWoodenLarge_PlacedNearTheGate", sections: [] }) },
  { path: PATHS.config, status: "modified", kind: "config", diff: CONFIG_DIFF },
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

const REVIEW: TurnReview = { id: "review-1", turn: 0, before: "a".repeat(40), after: "b".repeat(40), at: ago(4), items };

const SESSION: SessionDetail = {
  id: SESSION_ID, title: "Sprint and wall run tuning", status: "idle", createdAt: ago(30), updatedAt: ago(3), waitingCause: null, archived: false, agents: { total: 0, running: 0 }, awaiting: 0,
  transcript: [
    { kind: "user", text: "Make sprinting feel snappier, let the player wall run while crouched, and make the cliff rock look wetter and mossier.", at: ago(12) },
    { kind: "assistant", text: "Done. I raised the sprint multiplier, added the wall run switch, and tuned the rock material and its mossy instance. The card below lists every file.", at: ago(5) },
    { kind: "review", review: REVIEW },
  ],
  touched: [], draft: "", seen: [], dismissed: [], queue: [], error: null, approvals: [], review: null,
  timeline: [{ checkpoint: "b".repeat(40), label: "Make sprinting feel snappier", at: ago(4), kind: "turn", turn: 0 }],
} as unknown as SessionDetail;

const diffAnswer = (url: URL): unknown => {
  const path = url.searchParams.get("path");
  const change = CHANGES.find((c) => c.path === path);
  return change ? { change } : undefined;
};

const card = (title: string, open?: keyof typeof PATHS, scroll?: string): Scenario => ({
  title,
  hash: `#/chat/${SESSION_ID}`,
  session: SESSION,
  index: { playtests: [], listed: true },
  height: 1500,
  get: (p, url) => (/\/reviews\/[^/]+\/diff$/.test(p) ? diffAnswer(url) : undefined),
  ...(open ? { clicks: [`[data-path='${PATHS[open]}'] .review-item-name`] } : {}),
  ...(scroll ? { scroll } : {}),
});

export const REVIEW_SCENARIOS: Record<string, Scenario> = {
  "review-card": card("Review card: every item state (pending, kept, reverted, edited outside the agent, a failed diff) with long engine names"),
  "review-blueprint": card("Review card, a Blueprint opened: the new variable and its changed default counted once, graph and component records", "bp"),
  "review-blueprint-variables": card("Review card, the same Blueprint scrolled to My Blueprint and Defaults: each variable once", "bp", "section[aria-label='My Blueprint']"),
  "review-material-instance": card("Review card, a material instance opened: its parameters in words, not the engine's struct text", "mi"),
  "review-material": card("Review card, a material opened: the added Constant shows its value, the removed Multiply its set constant", "material"),
  "review-material-older": card("Review card, a material from an older daemon: the added Constant has its title only, nothing breaks", "materialOlder"),
  "review-config": card("Review card, a reverted config file opened: its text diff", "config"),
};

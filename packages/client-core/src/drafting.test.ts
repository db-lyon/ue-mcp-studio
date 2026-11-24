/**
 * The playtest editor's rules: which operators suit which value, the sentence
 * a step reads as, the steps as ue-mcp's script format, the checks before
 * ue-mcp is asked, and ue-mcp's findings anchored to the step and field they
 * are about.
 */
import { describe, expect, it } from "vitest";
import {
  DRAFT_COPY,
  EMPTY_CATALOG,
  anchorFindings,
  applyCandidate,
  assetNameOf,
  choiceOf,
  draftAct,
  draftCatalogOf,
  draftCheckId,
  draftFromScript,
  draftKey,
  draftOfStored,
  draftPayload,
  draftProblems,
  draftStatus,
  draftStep,
  draftStepOut,
  duplicateDraftStep,
  emptyDraft,
  findingText,
  inPieHelps,
  moveDraftStep,
  opChoices,
  refusalProblems,
  removeDraftStep,
  scriptPathOf,
  searchSubjects,
  sentenceText,
  shownProblems,
  stepSentence,
  withAutoInstructions,
  withChoice,
  withSubject,
  type Draft,
  type DraftStep,
} from "./drafting.js";
import { hubPath, parseHubPath } from "./hub.js";
import { formatLocation, parseLocation } from "./location.js";

const RAW = {
  values: {
    pawn: { class: "/Game/Chars/BP_Hero.BP_Hero_C", source: "player 0" },
    pawn_channels: ["pos_z", "speed2d"],
    values: [
      { path: "JumpCurrentCount", kind: "integer", type: "int32" },
      { path: "Stamina", kind: "number", type: "float" },
      { path: "bIsCrouched", kind: "boolean", type: "bool" },
      { path: "CharacterMovement.MovementMode", kind: "enum", type: "EMovementMode", values: [{ name: "MOVE_Walking", value: 1 }, { name: "MOVE_Falling", value: 3 }] },
      { path: "Broken.Enum", kind: "enum", type: "EBroken", values: [] },
    ],
    profile_values: ["Door.OpenAngle"],
    actors: ["BP_Door", "PlayerStart"],
    spawned_classes: ["BP_Wisp"],
    widgets: ["WBP_PauseMenu"],
    truncated: true,
  },
  inputActions: ["/Game/Input/IA_Jump", "/Game/Input/IA_Interact.IA_Interact"],
  levels: [{ path: "/Game/Maps/L_Zeta", name: "L_Zeta" }, { path: "/Game/Maps/L_Arena.L_Arena", name: "L_Arena" }],
  currentLevel: "/Game/Maps/L_Arena",
  gaps: [],
};
const CAT = draftCatalogOf(RAW);

/** An observer step as typed in the editor. */
const auto = (patch: Partial<DraftStep>): DraftStep => ({ ...draftStep("auto"), ...patch });
const text = (s: DraftStep, within = 5000) => sentenceText(stepSentence(s, CAT, within));

describe("the catalog", () => {
  it("lists every value with its kind and type, grouped as the picker shows them", () => {
    expect(CAT.subjects.find((s) => s.path === "JumpCurrentCount")).toMatchObject({ kind: "integer", group: "pawn", type: "int32" });
    expect(CAT.subjects.find((s) => s.path === "pos_z")).toMatchObject({ kind: "number", group: "channel", type: "position z" });
    expect(CAT.subjects.find((s) => s.path === "Door.OpenAngle")).toMatchObject({ group: "profile" });
    expect(CAT.subjects.find((s) => s.path === "BP_Wisp")).toMatchObject({ kind: "actor", type: "spawned" });
    expect(CAT.subjects.find((s) => s.path === "WBP_PauseMenu")).toMatchObject({ kind: "widget" });
    expect(CAT.subjects.find((s) => s.path === "CharacterMovement.MovementMode")?.enumValues).toHaveLength(2);
  });

  it("reads an enum without values as an integer, since no value of it can be picked", () => {
    expect(CAT.subjects.find((s) => s.path === "Broken.Enum")?.kind).toBe("integer");
  });

  it("names Input Actions by package path and short name, and sorts the levels", () => {
    expect(CAT.inputActions.map((s) => [s.path, s.label])).toEqual([["/Game/Input/IA_Jump", "Jump"], ["/Game/Input/IA_Interact", "Interact"]]);
    expect(CAT.levels.map((l) => l.path)).toEqual(["/Game/Maps/L_Arena", "/Game/Maps/L_Zeta"]);
    expect(CAT.currentLevel).toBe("/Game/Maps/L_Arena");
    expect(CAT.truncated).toBe(true);
    expect(CAT.pawnClass).toBe("/Game/Chars/BP_Hero.BP_Hero_C");
  });

  it("is empty, not broken, for an answer it cannot read", () => {
    expect(draftCatalogOf(null)).toEqual(EMPTY_CATALOG);
    expect(draftCatalogOf({ values: { values: [{ kind: "number" }] } }).subjects).toEqual([]);
  });

  it("finds by any part, and by letters in order", () => {
    expect(searchSubjects(CAT.subjects, "jump").map((s) => s.path)).toEqual(["JumpCurrentCount", "/Game/Input/IA_Jump"]);
    expect(searchSubjects(CAT.subjects, "jcc").map((s) => s.path)).toEqual(["JumpCurrentCount"]);
    expect(searchSubjects(CAT.subjects, "").length).toBe(CAT.subjects.length);
  });
});

describe("operators suit the value", () => {
  it("offers each kind only what ue-mcp accepts for it", () => {
    const labels = (k: Parameters<typeof opChoices>[0]) => opChoices(k).map((c) => c.label);
    expect(labels("number")).toEqual(["is greater than", "is less than", "equals", "increases", "decreases"]);
    expect(labels("integer")).toEqual(labels("number"));
    expect(labels("boolean")).toEqual(["is true", "is false"]);
    expect(labels("enum")).toEqual(["is"]);
    expect(labels("widget")).toEqual(["is visible", "is hidden"]);
    expect(labels("actor")).toEqual(["exists", "is gone"]);
    expect(labels("input")).toEqual(["is triggered"]);
    expect(labels(null)).toContain("is triggered");
  });

  it("reads a saved op and target back as its choice", () => {
    expect(choiceOf({ op: "eq", target: "true" }, "boolean")?.id).toBe("is-true");
    expect(choiceOf({ op: "eq", target: "0" }, "boolean")?.id).toBe("is-false");
    expect(choiceOf({ op: "eq", target: "5" }, "boolean")).toBeNull();
    expect(choiceOf({ op: "visible", target: "" }, "widget")?.id).toBe("visible");
    expect(choiceOf({ op: "visible", target: "false" }, "widget")?.id).toBe("hidden");
    expect(choiceOf({ op: "gt", target: "1" }, "boolean")).toBeNull();
    expect(choiceOf({ op: "eq", target: "5" }, "number")?.id).toBe("eq");
  });

  it("gives a picked value its kind's operator, and keeps one that still fits", () => {
    const sub = (p: string) => CAT.subjects.find((s) => s.path === p && s.kind !== "input") ?? null;
    let s = withSubject(auto({}), "Stamina", sub("Stamina"));
    expect([s.op, s.target]).toEqual(["gt", ""]);
    s = withSubject({ ...s, op: "lt", target: "20" }, "JumpCurrentCount", sub("JumpCurrentCount"));
    expect([s.op, s.target]).toEqual(["lt", "20"]);
    s = withSubject(s, "bIsCrouched", sub("bIsCrouched"));
    expect([s.op, s.target]).toEqual(["eq", "true"]);
    s = withSubject(s, "CharacterMovement.MovementMode", sub("CharacterMovement.MovementMode"));
    expect([s.op, s.target]).toEqual(["eq", "1"]);
    s = withSubject(s, "WBP_PauseMenu", CAT.subjects.find((x) => x.kind === "widget")!);
    expect([s.op, s.target]).toEqual(["visible", "true"]);
    s = withSubject(s, "/Game/Input/IA_Jump", CAT.inputActions[0]);
    expect([s.op, s.target]).toEqual(["triggered", ""]);
  });

  it("starts an integer on equals, the usual check for a count", () => {
    expect(withSubject(auto({}), "JumpCurrentCount", CAT.subjects[0]).op).toBe("eq");
  });

  it("clears a target the new operator cannot use", () => {
    const s = auto({ value: "Stamina", op: "gt", target: "20" });
    expect(withChoice(s, opChoices("number")[3], null).target).toBe("20");
    expect(withChoice({ ...s, target: "lots" }, opChoices("number")[0], null).target).toBe("");
  });

  it("marks a typed value only when asked, and clears that once it is picked from the list", () => {
    const typed = withSubject(auto({}), "Spawned.Thing", null);
    expect(typed.resolveInPie).toBe(false);
    expect(withSubject(auto({ resolveInPie: true }), "Spawned.Thing", null, { inPie: true }).resolveInPie).toBe(true);
    expect(withSubject(auto({ resolveInPie: true }), "Stamina", CAT.subjects[1]).resolveInPie).toBe(false);
  });
});

describe("a step reads as a sentence", () => {
  it("reads the action, then the check and its time limit", () => {
    const s = auto({ acts: [{ ...draftAct("press"), action: "/Game/Input/IA_Jump" }], value: "JumpCurrentCount", op: "gt", target: "0", within: "1" });
    expect(text(s)).toBe("Press Jump, then JumpCurrentCount is greater than 0 within 1 s");
  });

  it("uses the playtest's default time limit when the step has none", () => {
    expect(text(auto({ value: "Stamina", op: "decreasing" }), 2500)).toBe("Stamina decreases within 2.5 s");
    expect(text(auto({ value: "Stamina", op: "increasing", target: "10" }))).toBe("Stamina increases by at least 10 within 5 s");
  });

  it("names enum values and fixed targets in words", () => {
    expect(text(auto({ value: "CharacterMovement.MovementMode", op: "eq", target: "3" }))).toBe("CharacterMovement.MovementMode is MOVE_Falling within 5 s");
    expect(text(auto({ value: "bIsCrouched", op: "eq", target: "false" }))).toBe("bIsCrouched is false within 5 s");
    expect(text(auto({ value: "WBP_PauseMenu", op: "visible", target: "false" }))).toBe("WBP_PauseMenu is hidden within 5 s");
    expect(text(auto({ value: "BP_Door", op: "exists", target: "false" }))).toBe("BP_Door is gone within 5 s");
  });

  it("keeps a name as written at the start, and capitalises words", () => {
    expect(text(auto({ value: "pos_z", op: "increasing" }))).toBe("pos_z increases within 5 s");
    expect(text(auto({ acts: [{ ...draftAct("wait"), seconds: "0.5" }], value: "pos_z", op: "increasing" }))).toBe("Wait 0.5 s, then pos_z increases within 5 s");
  });

  it("waits for the player's input with no limit unless one is set", () => {
    expect(text(auto({ value: "/Game/Input/IA_Interact", op: "triggered" }))).toBe("The player triggers Interact");
    expect(text(auto({ value: "/Game/Input/IA_Interact", op: "triggered", within: "10" }))).toBe("The player triggers Interact within 10 s");
  });

  it("reads every action the editor draws", () => {
    const acts = [
      { ...draftAct("place"), at: "BP_Door" },
      { ...draftAct("hold"), action: "/Game/Input/IA_Jump", seconds: "2", value: "0, 1" },
      { ...draftAct("console"), command: "stat fps" },
    ];
    expect(text(auto({ acts, value: "Stamina", op: "lt", target: "5" }))).toBe("Place the player at BP_Door, hold Jump at 0, 1 for 2 s, run stat fps, then Stamina is less than 5 within 5 s");
  });

  it("reads a person's step as what they judge", () => {
    const s: DraftStep = { ...draftStep("manual"), instruction: "The door opens without a pop", agentJudgeable: false };
    expect(text(s)).toBe("A person judges: The door opens without a pop (a person only)");
  });

  it("marks what is not chosen yet", () => {
    const parts = stepSentence(auto({ acts: [draftAct("press")] }), CAT);
    expect(sentenceText(parts)).toBe("Press an input, then a value is checked within 5 s");
    expect(parts.filter((p) => "missing" in p && p.missing).map((p) => ("token" in p ? p.role : ""))).toEqual(["action", "value"]);
    expect(sentenceText(stepSentence(auto({ value: "Stamina", op: "gt" }), CAT))).toBe("Stamina is greater than a number within 5 s");
  });
});

describe("saving writes ue-mcp's script format", () => {
  it("writes each target as the type ue-mcp reads", () => {
    const out = (p: Partial<DraftStep>) => (draftStepOut(auto(p), CAT).expect as Record<string, unknown>);
    expect(out({ value: "Stamina", op: "gt", target: "20", within: "1.5" })).toEqual({ value: "Stamina", op: "gt", target: 20, within_ms: 1500 });
    expect(out({ value: "bIsCrouched", op: "eq", target: "true" })).toEqual({ value: "bIsCrouched", op: "eq", target: true });
    expect(out({ value: "CharacterMovement.MovementMode", op: "eq", target: "3" })).toEqual({ value: "CharacterMovement.MovementMode", op: "eq", target: 3 });
    expect(out({ value: "WBP_PauseMenu", op: "visible", target: "true" })).toEqual({ value: "WBP_PauseMenu", op: "visible" });
    expect(out({ value: "WBP_PauseMenu", op: "visible", target: "false" })).toEqual({ value: "WBP_PauseMenu", op: "visible", target: false });
    expect(out({ value: "Stamina", op: "decreasing", target: "" })).toEqual({ value: "Stamina", op: "decreasing" });
    expect(out({ value: "/Game/Input/IA_Jump", op: "triggered", target: "x" })).toEqual({ value: "/Game/Input/IA_Jump", op: "triggered" });
  });

  it("gives an observer step its sentence as the instruction when none is written", () => {
    const s = auto({ value: "Stamina", op: "gt", target: "1" });
    expect(draftStepOut(s, CAT).instruction).toBe("Stamina is greater than 1 within 5 s");
    expect(draftStepOut({ ...s, instruction: "Sprint up the hill" }, CAT).instruction).toBe("Sprint up the hill");
  });

  it("writes actions in ue-mcp's shape", () => {
    const out = draftStepOut(auto({
      acts: [
        { ...draftAct("press"), action: "/Game/Input/IA_Jump" },
        { ...draftAct("hold"), action: "/Game/Input/IA_Jump", seconds: "1.25", value: "0, 1" },
        { ...draftAct("wait"), seconds: "0.5" },
        { ...draftAct("place"), at: "BP_Door" },
        { ...draftAct("console"), command: " stat fps " },
      ],
    }), CAT);
    expect(out.act).toEqual([
      { press: { action: "/Game/Input/IA_Jump" } },
      { hold: { action: "/Game/Input/IA_Jump", value: [0, 1], ms: 1250 } },
      { wait_ms: 500 },
      { place: { at: "BP_Door" } },
      { console: "stat fps" },
    ]);
  });

  it("writes a person step without an expectation, and only says so when an agent may not judge it", () => {
    const m: DraftStep = { ...draftStep("manual"), instruction: "Looks right", value: "Stamina", op: "gt", target: "1" };
    expect(draftStepOut(m, CAT)).toEqual({ instruction: "Looks right", judge: "manual" });
    expect(draftStepOut({ ...m, agentJudgeable: false }, CAT).agent_judgeable).toBe(false);
  });

  it("keeps what the editor does not draw, so a saved script comes back as it was", () => {
    const script = {
      path: "/Game/Tests/PT_Door",
      name: "PT_Door",
      map: "/Game/Maps/L_Arena.L_Arena",
      default_within_ms: 3000,
      steps: [
        {
          instruction: "Open the door",
          judge: "auto",
          resolve_in_pie: true,
          arrange: [{ kind: "set", target: "BP_Door", path: "OpenAngle", value: 0 }],
          act: [{ client: 1, press: { action: "/Game/Input/IA_Interact.IA_Interact", frames: 2 } }, { place: { at: "BP_Door", offset: [-150, 0, 0] } }, { tape: { action: "/Game/Input/IA_Move", values: [[0, 1]] } }],
          expect: { value: "Door.OpenAngle", op: "gt", target: 80, within_ms: 3000, client: 1 },
        },
        { instruction: "No pop", judge: "manual", agent_judgeable: false },
      ],
    };
    const d = draftFromScript(script, { 0: "host" });
    expect(d).toMatchObject({ name: "PT_Door", path: "/Game/Tests/PT_Door", map: "/Game/Maps/L_Arena", defaultWithinMs: 3000 });
    expect(d.steps[0].acts.map((a) => a.verb)).toEqual(["press", "place", "other"]);
    expect(d.steps[0].within).toBe("3");
    const back = draftPayload(d, CAT);
    expect(back.steps[0]).toEqual({ ...script.steps[0], act: [{ client: 1, press: { action: "/Game/Input/IA_Interact", frames: 2 } }, script.steps[0].act![1], script.steps[0].act![2]], player: "host" });
    expect(back.steps[1]).toEqual(script.steps[1]);
    expect(back.map).toBe("/Game/Maps/L_Arena");
    expect(back.manual_only).toBe(false);
  });

  it("says a playtest is judged by people only when every step is a person's", () => {
    const d: Draft = { ...emptyDraft(null), steps: [{ ...draftStep("manual"), instruction: "a" }] };
    expect(draftPayload(d, CAT).manual_only).toBe(true);
  });

  it("names the asset from what is typed", () => {
    expect(assetNameOf(" PT door-opens! ")).toBe("PT_door_opens");
    expect(scriptPathOf("PT Door")).toBe("/Game/PIEStudio/Scripts/PT_Door");
    expect(draftCheckId({ path: null, name: "PT Door" })).toBe("script:/Game/PIEStudio/Scripts/PT_Door");
    expect(draftCheckId({ path: "/Game/Tests/PT_X", name: "PT_X" })).toBe("script:/Game/Tests/PT_X");
  });

  it("drops an instruction that only repeats the step's sentence, so it follows the step", () => {
    const d = draftFromScript({ path: "/Game/T/PT", steps: [
      { instruction: "Stamina is greater than 1 within 5 s", judge: "auto", expect: { value: "Stamina", op: "gt", target: 1 } },
      { instruction: "Sprint up the hill", judge: "auto", expect: { value: "Stamina", op: "gt", target: 1 } },
    ] });
    const auto2 = withAutoInstructions(d, CAT);
    expect(auto2.steps.map((s) => s.instruction)).toEqual(["", "Sprint up the hill"]);
  });
});

describe("editing", () => {
  const three = (): Draft => ({ ...emptyDraft(null), steps: [auto({ value: "a" }), auto({ value: "b" }), auto({ value: "c" })] });

  it("moves, duplicates and removes steps by id", () => {
    const d = three();
    const [a, b, c] = d.steps.map((s) => s.id);
    expect(moveDraftStep(d, b, -1).steps.map((s) => s.id)).toEqual([b, a, c]);
    expect(moveDraftStep(d, a, -1)).toBe(d);
    expect(moveDraftStep(d, c, 1)).toBe(d);
    const dup = duplicateDraftStep(d, a);
    expect(dup.draft.steps.map((s) => s.value)).toEqual(["a", "a", "b", "c"]);
    expect(dup.id).not.toBe(a);
    expect(removeDraftStep(d, b).steps.map((s) => s.value)).toEqual(["a", "c"]);
  });

  it("tells a changed draft from the one opened, whatever its ids", () => {
    const d = three();
    const copy = { ...d, steps: d.steps.map((s, i) => ({ ...s, id: `other${i}` })) };
    expect(draftKey(copy)).toBe(draftKey(d));
    expect(draftKey({ ...d, map: "/Game/Maps/L_Zeta" })).not.toBe(draftKey(d));
    expect(draftKey({ ...d, steps: d.steps.slice(1) })).not.toBe(draftKey(d));
  });

  it("reads a kept draft back with fresh ids, and refuses anything else", () => {
    const d = three();
    const back = draftOfStored(JSON.parse(JSON.stringify(d)));
    expect(back && draftKey(back)).toBe(draftKey(d));
    expect(back?.steps[0].id).not.toBe(d.steps[0].id);
    expect(draftOfStored({ name: 1 })).toBeNull();
    expect(draftOfStored(null)).toBeNull();
  });
});

describe("problems before ue-mcp is asked", () => {
  it("asks for a name that is free and a valid asset name", () => {
    const d = emptyDraft(null);
    expect(draftProblems(d, CAT).find((p) => p.field === "name")?.message).toBe(DRAFT_COPY.needsName);
    expect(draftProblems({ ...d, name: "9lives" }, CAT).find((p) => p.field === "name")?.kind).toBe("invalid");
    const taken = new Set(["/Game/PIEStudio/Scripts/PT_Door"]);
    expect(draftProblems({ ...d, name: "PT Door" }, CAT, { taken }).find((p) => p.field === "name")?.message).toBe(DRAFT_COPY.nameTaken("PT_Door"));
    expect(draftProblems({ ...d, path: "/Game/Old/X", name: "" }, CAT).some((p) => p.field === "name")).toBe(false);
  });

  it("finds each part of a step not filled in, on that part", () => {
    const steps = [
      auto({}),
      auto({ value: "Stamina", op: "gt", target: "" }),
      auto({ value: "Stamina", op: "gt", target: "lots", within: "-1" }),
      { ...draftStep("manual") },
      auto({ value: "Stamina", op: "decreasing", acts: [draftAct("press"), { ...draftAct("wait"), seconds: "x" }, draftAct("place"), draftAct("console")] }),
    ];
    const d: Draft = { ...emptyDraft(null), name: "PT_X", steps };
    const found = draftProblems(d, CAT).map((p) => [steps.findIndex((s) => s.id === p.stepId), p.field.replace(/^act:.*/, "act"), p.kind]);
    expect(found).toEqual([
      [0, "value", "incomplete"],
      [1, "target", "incomplete"],
      [2, "target", "invalid"],
      [2, "within", "invalid"],
      [3, "instruction", "incomplete"],
      [4, "act", "incomplete"],
      [4, "act", "invalid"],
      [4, "act", "incomplete"],
      [4, "act", "incomplete"],
    ]);
  });

  it("finds nothing wrong with a finished draft", () => {
    const d: Draft = { ...emptyDraft(null), name: "PT_X", steps: [auto({ value: "Stamina", op: "gt", target: "1" })] };
    expect(draftProblems(d, CAT)).toEqual([]);
  });
});

describe("ue-mcp's findings", () => {
  const press = { ...draftAct("press"), action: "/Game/Input/IA_Jmp" };
  const steps = [auto({ value: "JumpCurentCount", op: "gt", target: "0" }), auto({ acts: [draftAct("wait"), press], value: "Stamina", op: "gt", target: "1" })];

  it("puts each finding on its step and field", () => {
    const found = anchorFindings([
      { step: 0, field: "expect.value", message: "steps[0].expect.value: 'JumpCurentCount' cannot be read: no such property. If it only exists once PIE is running, set resolve_in_pie: true on the step.", candidates: ["JumpCurrentCount"] },
      { step: 1, field: "act[1].press.action", message: "steps[1].act[1].press.action: Input Action '/Game/Input/IA_Jmp' not found", candidates: ["/Game/Input/IA_Jump"] },
      { step: 1, field: "expect.op", message: "steps[1].expect.op 'x' is unknown" },
      { step: 1, field: "expect.target", message: "t" },
      { step: 1, field: "arrange[0].target", message: "a" },
      { step: null, field: "map", message: "map 'L_Aren' is not a level asset", candidates: ["/Game/Maps/L_Arena"] },
      { step: null, field: "steps", message: "A script needs an auto step", candidates: ["manual_only"] },
      { step: 7, field: "expect.value", message: "gone" },
    ], steps);
    expect(found.map((p) => [p.stepId, p.field])).toEqual([
      [steps[0].id, "value"],
      [steps[1].id, `act:${press.id}`],
      [steps[1].id, "op"],
      [steps[1].id, "target"],
      [steps[1].id, "setup"],
      [null, "map"],
      [null, "steps"],
      [null, "steps"],
    ]);
    expect(found[0].message).toBe("'JumpCurentCount' cannot be read: no such property.");
    expect(found[2].message).toBe("'x' is unknown");
    expect(found[6].candidates).toEqual([]);
    expect(found.every((p) => p.kind === "editor")).toBe(true);
  });

  it("stays on the step it was about after the steps move", () => {
    const [p] = anchorFindings([{ step: 0, field: "expect.value", message: "m" }], steps);
    const moved = moveDraftStep({ ...emptyDraft(null), steps }, steps[0].id, 1);
    expect(moved.steps[1].id).toBe(p.stepId);
  });

  it("strips ue-mcp's field prefix only", () => {
    expect(findingText("steps[12].act[0].press.action: not found")).toBe("not found");
    expect(findingText("map 'x' is not a level asset")).toBe("map 'x' is not a level asset");
  });

  it("puts a candidate where its finding is", () => {
    const d: Draft = { ...emptyDraft("/Game/Maps/L_Aren"), steps };
    const [value, action] = anchorFindings([{ step: 0, field: "expect.value", message: "" }, { step: 1, field: "act[1].press.action", message: "" }], steps);
    const fixed = applyCandidate(applyCandidate(d, value, "JumpCurrentCount", CAT), action, "/Game/Input/IA_Jump.IA_Jump", CAT);
    expect(fixed.steps[0]).toMatchObject({ value: "JumpCurrentCount", op: "gt", target: "0" });
    expect(fixed.steps[1].acts[1].action).toBe("/Game/Input/IA_Jump");
    expect(applyCandidate(d, { stepId: null, field: "map" }, "/Game/Maps/L_Arena.L_Arena", CAT).map).toBe("/Game/Maps/L_Arena");
  });

  it("offers It exists only in PIE for a value or an actor, never an Input Action", () => {
    const [value, action] = anchorFindings([{ step: 0, field: "expect.value", message: "" }, { step: 1, field: "act[1].press.action", message: "" }], steps);
    expect(inPieHelps(value, steps[0])).toBe(true);
    expect(inPieHelps(value, { ...steps[0], resolveInPie: true })).toBe(false);
    expect(inPieHelps(action, steps[1])).toBe(false);
    expect(inPieHelps(value, { ...steps[0], op: "triggered" })).toBe(false);
  });

  it("reads a refused save's findings", () => {
    const e = Object.assign(new Error("not saved"), { body: { errors: [{ step: 0, field: "expect.op", message: "bad op" }], warnings: [{ step: 1, field: "expect.value", message: "unknown" }] } });
    expect(refusalProblems(e, steps).map((p) => p.field)).toEqual(["op", "value"]);
    expect(refusalProblems(new Error("x"), steps)).toEqual([]);
  });
});

describe("what is shown, and the status line", () => {
  const local = draftProblems({ ...emptyDraft(null), name: "PT_X", steps: [auto({})] }, CAT);
  const whole = anchorFindings([{ step: null, field: "steps", message: "A script needs an auto step" }], []);

  it("keeps unfilled parts quiet until Save, and ue-mcp's word on a script still being filled in", () => {
    expect(shownProblems(local, whole, false)).toEqual([]);
    expect(shownProblems(local, whole, true).map((p) => p.field)).toEqual(["value"]);
    expect(shownProblems([], whole, false)).toEqual(whole);
  });

  it("says what is going on, most pressing first", () => {
    const base = { checking: false, checkError: null, local: [], editor: [], checkedLevel: "/Game/Maps/L_Arena", saving: null };
    expect(draftStatus(base)).toEqual({ tone: "ok", text: "No problems found in L_Arena" });
    expect(draftStatus({ ...base, checking: true }).tone).toBe("busy");
    expect(draftStatus({ ...base, checkError: "the editor is not connected" }).text).toBe("Not checked: the editor is not connected");
    expect(draftStatus({ ...base, editor: whole }).text).toBe("1 problem to fix before it runs");
    expect(draftStatus({ ...base, local }).text).toBe("1 part is not filled in");
    expect(draftStatus({ ...base, saving: "wait", savedName: "PT_X" }).text).toBe("Saved PT_X. Opening it once the hub lists it.");
  });
});

describe("the editor's address", () => {
  it("has a link for a new playtest, one added to a goal, and an edit", () => {
    for (const r of [{ screen: "draft" as const }, { screen: "draft" as const, goalId: "combat" }, { screen: "draft" as const, checkId: "script:/Game/T/PT_A" }]) {
      expect(parseHubPath(hubPath(r))).toEqual(r);
    }
    expect(hubPath({ screen: "draft", checkId: "script:/Game/T/PT_A" })).toBe("checks/script%3A%2FGame%2FT%2FPT_A/edit");
    expect(parseHubPath("checks/script%3A%2FGame%2FT%2FPT_A")).toEqual({ screen: "check", checkId: "script:/Game/T/PT_A" });
  });

  it("survives the panel's hash, and nothing longer does", () => {
    const sub = hubPath({ screen: "draft", checkId: "script:/Game/T/PT_A" });
    expect(parseLocation(formatLocation({ tab: "Playtests", session: null, section: null, sub })).sub).toBe(sub);
    expect(parseLocation("#/playtests/checks/new").sub).toBe("checks/new");
    expect(parseLocation("#/playtests/goals/combat/new").sub).toBe("goals/combat/new");
    expect(parseLocation("#/playtests/checks/x/delete").sub).toBeUndefined();
    expect(parseLocation("#/playtests/checks/x/edit/more").sub).toBeUndefined();
  });
});

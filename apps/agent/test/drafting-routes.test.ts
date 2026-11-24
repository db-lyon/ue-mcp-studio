/**
 * The hub's playtest editor routes: the catalog read in one go from
 * pie(script_values), the Input Actions and levels; a saved script as
 * written; pie(script_validate) and pie(script_create) with each step's
 * player taken out and kept by Studio.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { ActionResult } from "ue-mcp/daemon";
import { Drafting } from "../src/drafting-routes.js";

const ok = (body: Record<string, unknown>): ActionResult => ({ isError: false, content: [{ type: "text", text: JSON.stringify({ success: true, ...body }) }] });
const refused = (body: Record<string, unknown>): ActionResult => ({ isError: false, content: [{ type: "text", text: JSON.stringify({ success: false, ...body }) }] });

let calls: Array<{ category: string; action: string; args: Record<string, unknown> }>;
let answers: Record<string, ActionResult | Error>;
let connected: boolean;
let players: Map<string, Record<number, string>>;
let created: number;

const drafting = () => new Drafting({
  host: {
    callAction: async (category, action, args = {}) => {
      calls.push({ category, action, args });
      const a = answers[`${category}.${action}${action === "list" ? `:${String((args.classPaths as string[])[0])}` : ""}`];
      if (a instanceof Error) throw a;
      return a ?? ok({});
    },
    editors: () => [{ connected }],
  },
  players: { players: (s) => players.get(s) ?? {}, setPlayers: (s, p) => void players.set(s, p) },
  created: () => void created++,
});

beforeEach(() => {
  calls = [];
  answers = {};
  connected = true;
  players = new Map();
  created = 0;
});

describe("the catalog", () => {
  it("reads values, Input Actions, levels and the open level together", async () => {
    answers["pie.script_values"] = ok({ values: [{ path: "Stamina", kind: "number", type: "float" }], actors: ["BP_Door"] });
    answers["asset.list:/Script/EnhancedInput.InputAction"] = ok({ assets: [{ path: "/Game/Input/IA_Jump", name: "IA_Jump", className: "InputAction" }] });
    answers["asset.list:/Script/Engine.World"] = ok({ assets: [{ path: "/Game/Maps/L_Arena", name: "L_Arena" }] });
    answers["level.get_current"] = ok({ levelName: "L_Arena", mapPackagePath: "/Game/Maps/L_Arena" });
    const r = await drafting().catalog();
    expect(r.status).toBeUndefined();
    expect(r.body).toEqual({
      values: { success: true, values: [{ path: "Stamina", kind: "number", type: "float" }], actors: ["BP_Door"] },
      inputActions: ["/Game/Input/IA_Jump"],
      inputContexts: [],
      levels: [{ path: "/Game/Maps/L_Arena", name: "L_Arena" }],
      currentLevel: "/Game/Maps/L_Arena",
      gaps: [],
    });
    expect(calls.find((c) => c.action === "script_values")?.args).toEqual({ limit: 1000 });
  });

  it("lists Input Actions from every content root and the contexts that map them", async () => {
    answers["gameplay.list_input_assets"] = ok({
      inputActions: [{ path: "/Game/Input/IA_Jump.IA_Jump" }, { path: "/Hero/Input/IA_Dash.IA_Dash" }],
      inputMappingContexts: [{ path: "/Hero/Input/IMC_Hero.IMC_Hero" }],
    });
    answers["gameplay.read_imc"] = ok({ mappings: [{ inputAction: "/Hero/Input/IA_Dash.IA_Dash" }, { inputAction: { objectPath: "/Hero/Input/IA_Dash.IA_Dash" } }] });
    const r = await drafting().catalog();
    expect(r.body).toMatchObject({
      inputActions: ["/Game/Input/IA_Jump", "/Hero/Input/IA_Dash"],
      inputContexts: [{ path: "/Hero/Input/IMC_Hero", name: "IMC_Hero", actions: ["/Hero/Input/IA_Dash"] }],
      gaps: [],
    });
    expect(calls.find((c) => c.action === "read_imc")?.args).toEqual({ imcPath: "/Hero/Input/IMC_Hero" });
  });

  it("names what it could not read and still answers with the rest", async () => {
    answers["pie.script_values"] = refused({ error: "Profile not found" });
    answers["asset.list:/Script/EnhancedInput.InputAction"] = new Error("socket closed");
    answers["asset.list:/Script/Engine.World"] = ok({ assets: [] });
    const r = await drafting().catalog();
    expect(r.body).toMatchObject({ values: null, inputActions: [], currentLevel: null, gaps: ["values: Profile not found", "inputActions"] });
  });

  it("needs the editor", async () => {
    connected = false;
    expect((await drafting().catalog()).status).toBe(409);
    expect(calls).toEqual([]);
  });
});

describe("a saved script", () => {
  it("comes back as written, with Studio's players", async () => {
    const script = { path: "/Game/Tests/PT_Door", name: "PT_Door", steps: [{ instruction: "Open", judge: "auto", resolve_in_pie: true }] };
    answers["pie.script_read"] = ok(script);
    players.set("/Game/Tests/PT_Door", { 0: "host" });
    const r = await drafting().script("/Game/Tests/PT_Door.PT_Door");
    expect(calls[0].args).toEqual({ path: "/Game/Tests/PT_Door" });
    expect(r.body).toEqual({ script: { success: true, ...script }, players: { 0: "host" } });
    expect((await drafting().script("PT_Door")).status).toBe(400);
  });
});

describe("checking a draft", () => {
  it("asks pie(script_validate) without players, and answers its findings", async () => {
    const errors = [{ step: 0, field: "expect.value", message: "cannot be read", candidates: ["Stamina"] }];
    answers["pie.script_validate"] = ok({ valid: false, errors, summary: "1 problem" });
    const r = await drafting().validate({ steps: [{ instruction: "a", judge: "auto", player: "host" }], map: "/Game/Maps/L_Arena", manual_only: false });
    expect(calls[0].args).toEqual({ steps: [{ instruction: "a", judge: "auto" }], map: "/Game/Maps/L_Arena" });
    expect(r.body).toEqual({ valid: false, errors, summary: "1 problem" });
  });

  it("passes manual_only and leaves out an empty level", async () => {
    answers["pie.script_validate"] = ok({ valid: true, errors: [] });
    await drafting().validate({ steps: [{ instruction: "a", judge: "manual" }], map: "", manual_only: true });
    expect(calls[0].args).toEqual({ steps: [{ instruction: "a", judge: "manual" }], manual_only: true });
  });

  it("refuses no steps, and says when the check itself failed", async () => {
    expect((await drafting().validate({ steps: [] })).status).toBe(400);
    answers["pie.script_validate"] = refused({ error: "steps is required" });
    expect(await drafting().validate({ steps: [{ instruction: "a" }] })).toEqual({ status: 409, body: { error: "steps is required" } });
  });
});

describe("creating a playtest", () => {
  it("never overwrites, keeps the players, and lets the Playtests list read again", async () => {
    answers["pie.script_create"] = ok({ created: true, path: "/Game/PIEStudio/Scripts/PT_Door", steps: [], warnings: [{ step: 0, field: "expect.value", message: "w" }] });
    const r = await drafting().create({ name: "PT_Door", steps: [{ instruction: "a", judge: "auto", player: "client 1" }], map: "/Game/Maps/L_Arena", manual_only: false });
    expect(calls[0].args).toEqual({ name: "PT_Door", steps: [{ instruction: "a", judge: "auto" }], map: "/Game/Maps/L_Arena", onConflict: "error" });
    expect(r.body).toEqual({ path: "/Game/PIEStudio/Scripts/PT_Door", warnings: [{ step: 0, field: "expect.value", message: "w" }] });
    expect(players.get("/Game/PIEStudio/Scripts/PT_Door")).toEqual({ 0: "client 1" });
    expect(created).toBe(1);
  });

  it("answers a refusal with ue-mcp's findings, for the editor to put on their fields", async () => {
    const errors = [{ step: 0, field: "expect.op", message: "unknown op" }];
    answers["pie.script_create"] = refused({ errorCode: "INVALID_SCRIPT_STEPS", error: "The script cannot be saved", errors, warnings: [] });
    const r = await drafting().create({ name: "PT_Door", steps: [{ instruction: "a" }] });
    expect(r).toEqual({ status: 409, body: { error: "The script cannot be saved", errors, warnings: [] } });
    expect(created).toBe(0);
  });

  it("refuses a name that is no asset name, and an editor that is not there", async () => {
    expect((await drafting().create({ name: "PT Door", steps: [{}] })).status).toBe(400);
    connected = false;
    expect((await drafting().create({ name: "PT_Door", steps: [{}] })).status).toBe(409);
    expect(calls).toEqual([]);
  });
});

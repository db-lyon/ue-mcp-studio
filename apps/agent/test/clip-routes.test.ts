/**
 * The timeline's routes over ue-mcp's pie clip_* actions: the params each
 * sends, refusals as 409 with findings and candidates, clip_edit's rollback
 * as clip_update params, and clip_runs missing from an older ue-mcp.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { ActionResult } from "ue-mcp/daemon";
import { Clips } from "../src/clip-routes.js";

const ok = (body: Record<string, unknown>): ActionResult => ({ isError: false, content: [{ type: "text", text: JSON.stringify({ success: true, ...body }) }] });
const refused = (body: Record<string, unknown>): ActionResult => ({ isError: false, content: [{ type: "text", text: JSON.stringify({ success: false, ...body }) }] });
const failed = (text: string): ActionResult => ({ isError: true, content: [{ type: "text", text }] });

const PATH = "/Game/PIEStudio/Clips/CL_Door";
let calls: Array<{ action: string; args: Record<string, unknown> }>;
let answers: Record<string, ActionResult | Error>;
let connected: boolean;

const clips = () => new Clips({
  host: {
    callAction: async (_category, action, args = {}) => {
      calls.push({ action, args });
      const a = answers[action];
      if (a instanceof Error) throw a;
      return a ?? ok({});
    },
    editors: () => [{ connected }],
  },
});

beforeEach(() => {
  calls = [];
  answers = {};
  connected = true;
});

describe("reading and saving", () => {
  it("reads the clip with the warnings clip_validate gives", async () => {
    answers.clip_read = ok({ clip: { rate: 60, tracks: [] }, text: "clip rate=60" });
    answers.clip_validate = ok({ valid: false, saveable: true, errors: [{ id: "c1", field: "expect.value", message: "No value Speed2", candidates: ["speed2d"] }] });
    const r = await clips().read(PATH);
    expect(r.body).toEqual({ path: PATH, clip: { rate: 60, tracks: [] }, text: "clip rate=60", warnings: [{ id: "c1", field: "expect.value", message: "No value Speed2", candidates: ["speed2d"] }] });
    expect(calls.map((c) => c.action)).toEqual(["clip_read", "clip_validate"]);
  });

  it("refuses a path that is not an asset path, and every call while the editor is closed", async () => {
    expect((await clips().read("CL_Door")).status).toBe(400);
    connected = false;
    expect(await clips().read(PATH)).toEqual({ status: 409, body: { error: "the editor is not connected" } });
    expect(calls).toEqual([]);
  });

  it("creates an empty clip at 60 frames per second and refuses a taken name", async () => {
    answers.clip_create = ok({ path: PATH });
    expect((await clips().create({ name: "CL_Door" })).body).toEqual({ path: PATH, warnings: [] });
    expect(calls[0].args).toEqual({ name: "CL_Door", clip: { rate: 60 }, onConflict: "error" });
    expect((await clips().create({ name: "CL Door" })).status).toBe(400);
  });

  it("sends a rollback back through clip_update and answers with the clip and its own rollback", async () => {
    answers.clip_update = ok({ clip: { rate: 60 }, rollback: { method: "pie_clip_update", payload: { path: PATH, clip: { rate: 30 } } } });
    const r = await clips().update({ path: PATH, clip: { rate: 60 } });
    expect(calls[0]).toEqual({ action: "clip_update", args: { path: PATH, clip: { rate: 60 } } });
    expect(r.body).toMatchObject({ clip: { rate: 60 }, rollback: { path: PATH, clip: { rate: 30 } } });
  });
});

describe("editing", () => {
  it("passes the ops through and answers with changed ids, warnings and the rollback", async () => {
    answers.clip_edit = ok({
      changed: ["n2"],
      clip: { rate: 60, tracks: [{ action: "/Game/Input/IA_Jump.IA_Jump", type: "bool", notes: [{ id: "n2", start: 140, length: 6 }] }] },
      text: "...",
      warnings: [{ id: "c1", message: "resolves only in PIE" }],
      rollback: { method: "pie_clip_update", payload: { path: PATH, clip: { rate: 60, tracks: [] } } },
    });
    const ops = [{ op: "add", kind: "note", track: "/Game/Input/IA_Jump", start: 140, length: 6 }];
    const r = await clips().edit({ path: PATH, ops });
    expect(calls[0]).toEqual({ action: "clip_edit", args: { path: PATH, ops } });
    expect(r.body).toMatchObject({ changed: ["n2"], warnings: [{ id: "c1", message: "resolves only in PIE" }], rollback: { path: PATH, clip: { rate: 60, tracks: [] } } });
  });

  it("answers a refused edit with 409, its reason and the findings with candidates", async () => {
    answers.clip_edit = refused({ error: "The edit was not applied", errors: [{ id: "n9", message: "No note n9", candidates: ["n1", "n2"] }], warnings: [] });
    const r = await clips().edit({ path: PATH, ops: [{ op: "delete", id: "n9" }] });
    expect(r).toEqual({ status: 409, body: { error: "The edit was not applied", errors: [{ id: "n9", message: "No note n9", candidates: ["n1", "n2"] }], warnings: [] } });
  });

  it("needs at least one op", async () => {
    expect((await clips().edit({ path: PATH, ops: [] })).status).toBe(400);
  });
});

describe("transport", () => {
  it("plays a clip or one region, starting PIE", async () => {
    answers.clip_run = ok({ run_id: "clip-1", state: "running" });
    expect((await clips().run({ path: PATH, region: "r2" })).body).toMatchObject({ run_id: "clip-1" });
    expect(calls[0].args).toEqual({ path: PATH, start_pie: true, region: "r2" });
  });

  it("records from a region or a hold check with the armed tracks, never both punch-ins", async () => {
    await clips().record({ path: PATH, from_check: "c2", armed: ["/Game/Input/IA_Move.IA_Move", 4, "L2", ""] });
    expect(calls[0]).toEqual({ action: "clip_record", args: { path: PATH, from_check: "c2", armed: ["/Game/Input/IA_Move.IA_Move", "L2"] } });
    expect((await clips().record({ path: PATH, region: "r1", from_check: "c2" })).status).toBe(400);
  });

  it("sends a person's verdict as human and refuses an unknown verdict", async () => {
    await clips().verdict({ check: "c3", verdict: "pass", note: "Door opened smoothly" });
    expect(calls[0]).toEqual({ action: "clip_verdict", args: { check: "c3", verdict: "pass", source: "human", note: "Door opened smoothly" } });
    expect((await clips().verdict({ check: "c3", verdict: "maybe" })).status).toBe(400);
  });

  it("reads a finished run's status with the editor closed", async () => {
    connected = false;
    answers.clip_status = ok({ run_id: "clip-1", state: "finished", passed: true });
    expect((await clips().status("clip-1")).body).toMatchObject({ run_id: "clip-1", passed: true });
    expect(calls[0].args).toEqual({ run_id: "clip-1" });
  });
});

describe("run history", () => {
  it("lists one clip's runs, newest first, with a limit", async () => {
    answers.clip_runs = ok({ runs: [{ run_id: "clip-2" }, { run_id: "clip-1" }], total: 7 });
    const r = await clips().runs({ path: PATH, limit: "20" });
    expect(calls[0].args).toEqual({ path: PATH, limit: 20 });
    expect(r.body).toEqual({ runs: [{ run_id: "clip-2" }, { run_id: "clip-1" }], total: 7 });
  });

  it("answers runs: null when ue-mcp has no clip_runs, as a thrown or answered refusal", async () => {
    answers.clip_runs = new Error("Unknown action 'clip_runs' on 'pie'.");
    expect((await clips().runs({})).body).toEqual({ runs: null });
    answers.clip_runs = failed("Unknown action \"clip_runs\" on pie.");
    expect((await clips().runs({})).body).toEqual({ runs: null });
    answers.clip_runs = failed("Saved folder not readable");
    expect((await clips().runs({})).status).toBe(409);
  });
});

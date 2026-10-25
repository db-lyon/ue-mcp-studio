import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ActionResult } from "ue-mcp/daemon";
import { RESULT_KEEP_CHARS, compactJson, keepForModel, saveResult, shrinkJson } from "../src/model-text.js";
import { executeTool, forModel, type AgentHost } from "../src/tools.js";

const pretty = (v: unknown) => JSON.stringify(v, null, 2);

let dataDir = "";
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-results-"));
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const outliner = (n: number) => ({
  success: true,
  worldName: "L_Big",
  actors: Array.from({ length: n }, (_, i) => ({ label: `Actor_${i}`, class: "StaticMeshActor", location: { x: i * 100, y: 0, z: 0 }, components: [{ name: "StaticMeshComponent0", class: "StaticMeshComponent" }] })),
  totalActors: n,
});

const hostAnswering = (text: string): AgentHost => ({
  projectDir: "",
  dataDir,
  callAction: async (): Promise<ActionResult> => ({ isError: false, content: [{ type: "text", text }] }),
  editors: () => [{ name: "P", connected: true, port: 1, pid: 1, lastDisconnect: null }],
  editorOperation: async () => ({}),
  events: { publish: () => undefined, subscribe: () => () => undefined },
  setBusy: () => undefined,
  log: { info: () => undefined, warn: () => undefined },
});

describe("a JSON answer for the model", () => {
  it("loses its indentation and keeps every value", () => {
    const v = { success: true, actors: [{ label: "Sun", location: { x: 0, y: 0, z: 1000 } }], note: "a\nb" };
    const out = compactJson(pretty(v));
    expect(out).toBe(JSON.stringify(v));
    expect(JSON.parse(out)).toEqual(v);
    expect(out.length).toBeLessThan(pretty(v).length * 0.7);
  });

  it("leaves text that is not JSON, or already on one line, as it came", () => {
    expect(compactJson("Saved 3 packages.\nDone.")).toBe("Saved 3 packages.\nDone.");
    expect(compactJson("{ not json\n}")).toBe("{ not json\n}");
    expect(compactJson("{\"a\":1}")).toBe("{\"a\":1}");
  });
});

describe("a large result cut down for the model", () => {
  it("keeps every field and the first items of the longest list, and says how many were left out", () => {
    const v = outliner(400);
    const out = shrinkJson(v, 6000);
    expect(out.length).toBeLessThanOrEqual(6000);
    const back = JSON.parse(out) as { worldName: string; totalActors: number; actors: unknown[] };
    expect(back.worldName).toBe("L_Big");
    expect(back.totalActors).toBe(400);
    expect(back.actors[0]).toEqual(v.actors[0]);
    expect(back.actors[back.actors.length - 1]).toBe(`... ${400 - (back.actors.length - 1)} more of 400`);
  });

  it("shortens long strings when lists alone cannot make it fit", () => {
    const out = shrinkJson({ log: "x".repeat(50_000), ok: true }, 2000);
    expect(JSON.parse(out)).toEqual({ log: `${"x".repeat(400)}... (50000 chars)`, ok: true });
  });

  it("is left whole when it fits", () => {
    const text = JSON.stringify(outliner(3));
    expect(keepForModel(text, () => { throw new Error("nothing is saved"); })).toBe(text);
  });

  it("is saved whole, and the note says where and how to read the rest", () => {
    const text = JSON.stringify(outliner(400));
    let saved = "";
    const out = keepForModel(text, () => (saved = saveResult(dataDir, "level.get_outliner", text) ?? ""));
    const [head, note] = out.split("\n[Studio] ");
    expect(head.length).toBeLessThanOrEqual(RESULT_KEEP_CHARS);
    expect(note).toContain(`This result is ${text.length} characters`);
    expect(note).toContain(`saved in ${saved}`);
    expect(note).toMatch(/read_file .*select or omit/);
    expect(JSON.parse(fs.readFileSync(saved, "utf-8"))).toEqual(outliner(400));
    // Indented, so read_file can page it by lines.
    expect(fs.readFileSync(saved, "utf-8").split("\n").length).toBeGreaterThan(400);
  });

  it("still goes out cut down when it cannot be saved", () => {
    const out = keepForModel("y".repeat(RESULT_KEEP_CHARS * 2), () => null);
    expect(out).toMatch(/^y+\.\.\.\n\[Studio\] .*Call again with select or omit/);
  });

  it("drops saved results older than a week when another is saved", () => {
    const now = Date.now();
    const old = saveResult(dataDir, "a.b", "{}", now)!;
    fs.utimesSync(old, new Date(now - 8 * 864e5), new Date(now - 8 * 864e5));
    const fresh = saveResult(dataDir, "a.b", "{}", now)!;
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });
});

describe("an editor call's result", () => {
  it("over the limit reaches the model cut down, with the whole of it in the transcript and on disk", async () => {
    const answer = JSON.stringify(outliner(400), null, 2);
    const exec = await executeTool(hostAnswering(answer), "ue_mcp", { action: "call", category: "level", method: "get_outliner" });
    expect(exec.text).toBe(answer);
    expect(exec.modelText!.length).toBeLessThan(RESULT_KEEP_CHARS + 600);
    const file = /saved in (.+?): read_file/.exec(exec.modelText!)![1];
    expect(path.dirname(file)).toBe(path.join(dataDir, "results"));
    expect(path.basename(file)).toMatch(/level\.get_outliner/);
  });

  it("goes to the model without indentation while the transcript keeps ue-mcp's text", async () => {
    const answer = pretty({ success: true, worldName: "L_Work", actors: [{ label: "Floor" }] });
    const exec = await executeTool(hostAnswering(answer), "ue_mcp", { action: "call", category: "level", method: "get_outliner" });
    expect(exec.text).toBe(answer);
    expect(exec.modelText).toBe(JSON.stringify(JSON.parse(answer)));
    expect(forModel(exec)).toBe(exec.modelText);
  });

  it("has no separate model text when there is nothing to take out", async () => {
    const exec = await executeTool(hostAnswering("{\"success\":true}"), "ue_mcp", { action: "call", category: "level", method: "save" });
    expect(exec.modelText).toBeUndefined();
    expect(forModel(exec)).toBe("{\"success\":true}");
  });
});

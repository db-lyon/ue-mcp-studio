import { describe, expect, it } from "vitest";
import type { ActionResult } from "ue-mcp/daemon";
import { compactJson } from "../src/model-text.js";
import { compactDescribe } from "../src/discovery.js";
import { executeTool, forModel, type AgentHost } from "../src/tools.js";

const pretty = (v: unknown) => JSON.stringify(v, null, 2);

const hostAnswering = (text: string): AgentHost => ({
  projectDir: "",
  dataDir: "",
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

  it("is what one action's describe answers", () => {
    const schema = { tool: "level", action: "spawn_light", params: [{ name: "lightType", required: true }] };
    expect(compactDescribe(pretty(schema))).toBe(JSON.stringify(schema));
  });
});

describe("an editor call's result", () => {
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

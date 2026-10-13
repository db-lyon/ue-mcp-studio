import { describe, expect, it } from "vitest";
import { refused } from "../src/runner.js";

describe("a call ue-mcp answered without doing it", () => {
  it("is a refusal when the result says so, whatever the call", () => {
    expect(refused(JSON.stringify({ blocked: true, reason: "missing_task_summary" }))).toBe(true);
    expect(refused(JSON.stringify({ success: false, message: "Editor is already running" }))).toBe(true);
    expect(refused(JSON.stringify({ success: false, dialogBlocking: true, refusedMethod: "editor.stop_editor" }))).toBe(true);
  });

  it("is not one for a result that did its work, or one that is not JSON", () => {
    expect(refused(JSON.stringify({ success: true, created: true }))).toBe(false);
    expect(refused(JSON.stringify({ actors: [] }))).toBe(false);
    expect(refused("3 actors")).toBe(false);
    expect(refused("{ not json")).toBe(false);
    expect(refused(undefined)).toBe(false);
  });
});

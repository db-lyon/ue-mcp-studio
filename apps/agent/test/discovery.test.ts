/** ue_mcp search and describe answers, as the model is sent them. */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { compactDescribe, compactSearch, paramList, summary } from "../src/discovery.js";

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf-8");

describe("search answers", () => {
  it("go out as one signature line per hit, far smaller than ue-mcp's JSON", () => {
    const raw = fixture("search-tools.json");
    const out = compactSearch(raw);
    const hits = (JSON.parse(raw) as { results: unknown[] }).results.length;
    expect(out.split("\n")).toHaveLength(hits + 1);
    expect(out).toContain("material.create_instance(parentPath, name, packagePath?, onConflict?): Create an instance of a parameterized master material");
    expect(out.length).toBeLessThan(raw.length / 3.5);
  });

  it("say so when nothing matched", () => {
    expect(compactSearch(JSON.stringify({ query: "x", resultCount: 0, results: [], hint: "No dedicated action matched." }))).toBe("No matches. No dedicated action matched.");
  });

  it("leave text that is not search_tools' JSON as it came", () => {
    expect(compactSearch("Unknown action")).toBe("Unknown action");
  });
});

describe("category answers", () => {
  it("drop the JSON around ue-mcp's signature lines", () => {
    const raw = fixture("describe-category.json");
    const out = compactDescribe(raw);
    const lines = out.split("\n");
    expect(lines[0]).toMatch(/^material: \d+ actions/);
    expect(lines[1]).toBe("read(assetPath|path|materialPath)");
    expect(out.length).toBeLessThan(raw.length);
  });

  it("turn an older ue-mcp's per-action schemas into one line each", () => {
    const raw = JSON.stringify({
      tool: "level",
      actionCount: 2,
      actions: [
        { tool: "level", action: "get_outliner", description: "List the level's actors. Params: filter? (#12)", class: "read", params: [{ name: "filter", required: false }] },
        { tool: "level", action: "spawn_light", description: "Spawn a light.", class: "mutate", params: [{ name: "lightType", required: true }, { name: "location", required: false }] },
      ],
    }, null, 2);
    expect(compactDescribe(raw)).toBe([
      "level: 2 actions. Describe one (category + method) for its full parameters.",
      "get_outliner(filter?): List the level's actors.",
      "spawn_light(lightType, location?) [mutate]: Spawn a light.",
    ].join("\n"));
  });

  it("leave one action's schema as it came", () => {
    const one = JSON.stringify({ tool: "level", action: "spawn_light", params: [] });
    expect(compactDescribe(one)).toBe(one);
  });
});

describe("descriptions", () => {
  it("lose their parameter list and issue references, and are cut at a word", () => {
    expect(summary("Spawns a light (#42). Params: a, b?")).toBe("Spawns a light.");
    expect(summary("one two three four", 12)).toBe("one two...");
  });

  it("give their parameter names to the signature", () => {
    expect(paramList("Do it. Params: parentPath, name, packagePath? (default /Game), onConflict?")).toBe("parentPath, name, packagePath?, onConflict?");
    expect(paramList("Measure. Params: none (#704)")).toBe("");
  });
});

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
  it("name every action of the category on one line, far smaller than a line per action", () => {
    const raw = fixture("describe-category.json");
    const out = compactDescribe(raw);
    const [head, names] = out.split("\n");
    expect(head).toBe("material: 58 actions. Describe one (category + method) for its parameters, or search by intent.");
    expect(names.split(", ")).toHaveLength(58);
    expect(names.startsWith("read, list_parameters, set_parameter, ")).toBe(true);
    const signatures = (JSON.parse(raw) as { signatures: string[] }).signatures.join("\n");
    expect(out.length).toBeLessThan(signatures.length / 4);
  });

  it("name an older ue-mcp's per-action schemas the same way", () => {
    const raw = JSON.stringify({
      tool: "level",
      actionCount: 2,
      actions: [
        { tool: "level", action: "get_outliner", description: "List the level's actors. Params: filter? (#12)", class: "read", params: [{ name: "filter", required: false }] },
        { tool: "level", action: "spawn_light", description: "Spawn a light.", class: "mutate", params: [{ name: "lightType", required: true }, { name: "location", required: false }] },
      ],
    }, null, 2);
    expect(compactDescribe(raw)).toBe("level: 2 actions. Describe one (category + method) for its parameters, or search by intent.\nget_outliner, spawn_light");
  });

  it("say how many there are when the answer holds only some", () => {
    const raw = JSON.stringify({ category: "animation", count: 341, signatures: ["play(a)", "stop()"], nextOffset: 2 });
    expect(compactDescribe(raw).split("\n")[0]).toMatch(/^animation: 2 actions of 341\./);
  });

  it("leave JSON they do not recognise as unindented JSON", () => {
    expect(compactDescribe(JSON.stringify({ error: "Unknown category" }, null, 2))).toBe("{\"error\":\"Unknown category\"}");
  });
});

const perCall = [
  { name: "omit", type: "string|string[]", required: false, description: "Drop these result fields", sources: ["declared"] },
  { name: "select", type: "string|string[]", required: false, description: "Keep only these result fields", sources: ["declared"] },
  { name: "timeoutMs", type: "integer", required: false, minimum: 0, maximum: 3600000, description: "How long to wait", sources: ["declared"] },
];

describe("one action's answer", () => {
  it("goes out as a line per parameter with its fields indented under it", () => {
    const raw = JSON.stringify({
      tool: "level", action: "spawn_light", class: "mutate", classSource: "declared", bridge: "spawn_light", local: false, drift: [],
      description: "Place light (#331/#310). Params: lightType, location?",
      params: [
        { name: "lightType", type: "string", required: true, description: "point | spot", sources: ["documented"] },
        { name: "location", type: "object", required: false, description: "World location", properties: { x: { type: "number", required: true }, y: { type: "number", required: true } } },
        { name: "color", type: "object", required: false, items: { type: "any", required: false } },
        ...perCall,
      ],
    }, null, 2);
    expect(compactDescribe(raw)).toBe([
      "level.spawn_light [mutate]: Place light.",
      "- lightType: string - point | spot",
      "- location?: object - World location",
      "  - x: number",
      "  - y: number",
      "- color?: {[key]: any}",
      "Every call also takes select?, omit? and timeoutMs?.",
    ].join("\n"));
    expect(compactDescribe(raw).length).toBeLessThan(raw.length / 3);
  });

  it("keeps aliases, allowed values, ranges, variants, alternatives and anything else a field says", () => {
    const raw = JSON.stringify({
      tool: "animation", action: "edit", class: "mutate", description: "Edit.", timeoutMs: 300000,
      alternatives: [{ branches: [["assetPath"], ["assetPaths"]], required: true }],
      params: [
        { name: "assetPath", type: "string", required: false, aliases: ["path"] },
        { name: "assetPaths", type: "string[]", required: false, items: { type: "string", required: true } },
        { name: "mode", type: "string", required: false, enumValues: ["fixed", "local_delta"], default: "fixed" },
        { name: "frames", type: "array", required: false, items: { type: "integer", required: true }, minimum: 0 },
        { name: "names", type: "string|string[]", required: false, variants: [{ type: "string" }, { type: "string[]" }] },
        {
          name: "operations", type: "object[]", required: true,
          items: { type: "object", required: true, discriminator: "op", variants: [
            { type: "object", description: "Set one key", properties: { op: { type: "literal", required: true }, value: { type: "number", required: true } } },
            { type: "object", description: "Offset (#12)", properties: { op: { type: "literal", required: true } } },
          ] },
        },
      ],
    });
    expect(compactDescribe(raw).split("\n")).toEqual([
      "animation.edit [mutate]: Edit.",
      "- assetPath? (or path): string",
      "- assetPaths?: string[]",
      "- mode?: string (one of fixed|local_delta; default \"fixed\")",
      "- frames?: integer[] (0..)",
      "- names?: string | string[]",
      "- operations: object[]",
      "  variant 1: Set one key",
      "    - op: literal",
      "    - value: number",
      "  variant 2: Offset",
      "    - op: literal",
      "Give one of: assetPath | assetPaths",
      "Waits up to 300000 ms unless timeoutMs says otherwise.",
      "Every call also takes select?, omit? and timeoutMs?.",
    ]);
  });

  it("goes out once per category when a bare name matches several", () => {
    const one = (tool: string) => ({ tool, action: "read", description: "Read it.", params: [{ name: "assetPath", type: "string", required: true }] });
    const raw = JSON.stringify({ name: "read", matchCount: 2, hint: "'read' is provided by 2 categories.", matches: [one("material"), one("blueprint")] });
    expect(compactDescribe(raw).split("\n\n")).toEqual([
      "'read' is provided by 2 categories.",
      "material.read: Read it.\n- assetPath: string\nEvery call also takes select?, omit? and timeoutMs?.",
      "blueprint.read: Read it.\n- assetPath: string\nEvery call also takes select?, omit? and timeoutMs?.",
    ]);
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

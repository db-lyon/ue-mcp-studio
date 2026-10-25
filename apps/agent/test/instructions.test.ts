/** Scoped instruction files joining a conversation as the agent works where they apply. */
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { applies, conditionalFor, globRegex, pathsOf, type Composed } from "../src/instructions.js";

const project = path.join(os.tmpdir(), "studio-instr-project");
const composed: Composed = {
  text: "always",
  tokens: 1,
  files: 1,
  conditional: [
    { path: "Source/Game/CLAUDE.md", scope: { kind: "folder", folder: "Source/Game" }, body: "Module rules." },
    { path: ".claude/rules/bp.md", scope: { kind: "globs", globs: ["Content/Blueprints/**"] }, body: "Blueprint rule." },
  ],
};

describe("scoped files joining as the agent works", () => {
  it("adds a subfolder's file once the agent reads there, and only once per conversation", () => {
    const sent = new Set<string>();
    expect(conditionalFor(composed, pathsOf(project, "read_file", { path: "README.md" }), sent)).toBeNull();
    const first = conditionalFor(composed, pathsOf(project, "read_file", { path: "Source/Game/Player.cpp" }), sent);
    expect(first).toBe("[Studio] Instructions from Source/Game/CLAUDE.md apply to this work in Source/Game:\nModule rules.");
    expect(conditionalFor(composed, pathsOf(project, "edit_file", { path: path.join(project, "Source", "Game", "Other.cpp") }), sent)).toBeNull();
  });

  it("adds a rule with globs when an editor call names an asset under it", () => {
    const paths = pathsOf(project, "ue_mcp", { action: "call", category: "blueprint", method: "add_node", args: { assetPath: "/Game/Blueprints/BP_Player.BP_Player" } });
    expect(paths).toEqual(["Content/Blueprints/BP_Player.uasset"]);
    expect(conditionalFor(composed, paths, new Set())).toContain("Blueprint rule.");
  });

  it("reads a search's folder, and nothing outside the project", () => {
    expect(pathsOf(project, "glob", { pattern: "Source/Game/**/*.h" })).toEqual(["Source/Game"]);
    expect(pathsOf(project, "read_file", { path: path.join(os.tmpdir(), "elsewhere.txt") })).toEqual([]);
  });

  it("matches globs the way editors read them, and folders by prefix only at a separator", () => {
    expect(globRegex("Content/Blueprints/**").test("Content/Blueprints/A/B.uasset")).toBe(true);
    expect(globRegex("*.cpp").test("Source/X/Y.cpp")).toBe(true);
    expect(globRegex("Source/*.h").test("Source/X/Y.h")).toBe(false);
    expect(applies({ kind: "folder", folder: "Source/X" }, "Source/Xy/a.cpp")).toBe(false);
    expect(applies({ kind: "folder", folder: "Source/X" }, "Source/X/a.cpp")).toBe(true);
  });
});

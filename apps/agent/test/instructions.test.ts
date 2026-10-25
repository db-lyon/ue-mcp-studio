/**
 * Project instructions across every convention: order, duplicates, imports,
 * scoped rules, the user's switches and added files, and what an agent is given.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_INSTRUCTION_SETTINGS } from "@ue-mcp-studio/shared";
import { applies, compose, conditionalFor, createAgentsMd, cursorRule, globRegex, importsIn, instructionsView, pathsOf, preview } from "../src/instructions.js";

let project: string;
let home: string;
const write = (rel: string, text: string, root = project) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), "studio-instr-"));
  home = fs.mkdtempSync(path.join(os.tmpdir(), "studio-home-"));
});

/** A project using every convention at once. */
function everything(): void {
  write(".ue-mcp/studio/instructions.md", "Keep reports short.", home);
  write(".github/copilot-instructions.md", "C++ follows the engine standard.");
  write(".cursor/rules/blueprints.mdc", "---\ndescription: graphs\nglobs: Content/Blueprints/**\n---\nCollapse graphs over 40 nodes.");
  write(".cursor/rules/always.mdc", "---\nalwaysApply: true\n---\nName things plainly.");
  write(".cursorrules", "Prefer data assets.");
  write("GEMINI.md", "Gemini notes.");
  write("CLAUDE.md", "@AGENTS.md\n");
  write("AGENTS.md", "Hollowreach is a UE 5.7 survival game.");
  write("Source/Hollowreach/AGENTS.md", "Gameplay code lives in modules.");
  write("CLAUDE.local.md", "My local override.");
  write("Saved/AGENTS.md", "never read");
  write("Content/AGENTS.md", "never read either");
}

describe("discovery", () => {
  it("reads every convention in the documented order, and skips generated folders", () => {
    everything();
    const v = instructionsView(project, DEFAULT_INSTRUCTION_SETTINGS, undefined, home);
    expect(v.files.map((f) => f.path)).toEqual([
      "~/.ue-mcp/studio/instructions.md",
      ".github/copilot-instructions.md",
      ".cursor/rules/always.mdc",
      ".cursor/rules/blueprints.mdc",
      ".cursorrules",
      "GEMINI.md",
      "CLAUDE.md",
      "AGENTS.md",
      "Source/Hollowreach/AGENTS.md",
      "CLAUDE.local.md",
    ]);
    expect(v.files.map((f) => f.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(v.hasAgentsMd).toBe(true);
  });

  it("folds a file that only imports another into it, and counts it once", () => {
    everything();
    const v = instructionsView(project, DEFAULT_INSTRUCTION_SETTINGS, undefined, home);
    const claude = v.files.find((f) => f.path === "CLAUDE.md")!;
    expect(claude).toMatchObject({ sameAs: "AGENTS.md", tokens: 0, imports: ["AGENTS.md"] });
  });

  it("folds identical text into the later file, which is the one that wins", () => {
    write("GEMINI.md", "Same words.");
    write("AGENTS.md", "Same words.");
    const v = instructionsView(project, DEFAULT_INSTRUCTION_SETTINGS, undefined, home);
    expect(v.files.find((f) => f.path === "GEMINI.md")).toMatchObject({ sameAs: "AGENTS.md", tokens: 0 });
    expect(compose(project, DEFAULT_INSTRUCTION_SETTINGS, "all", home).text!.match(/Same words\./g)).toHaveLength(1);
  });

  it("follows an import of a file outside the list one level", () => {
    write("docs/style.md", "Use British spelling.\n@docs/deeper.md");
    write("docs/deeper.md", "too deep");
    write("CLAUDE.md", "Rules:\n@docs/style.md");
    const text = compose(project, DEFAULT_INSTRUCTION_SETTINGS, "all", home).text!;
    expect(text).toContain("Use British spelling.");
    expect(text).not.toContain("too deep");
  });

  it("scopes a rule with globs, and a subfolder's file to its folder", () => {
    everything();
    const v = instructionsView(project, DEFAULT_INSTRUCTION_SETTINGS, undefined, home);
    expect(v.files.find((f) => f.path === ".cursor/rules/blueprints.mdc")!.scope).toEqual({ kind: "globs", globs: ["Content/Blueprints/**"] });
    expect(v.files.find((f) => f.path === ".cursor/rules/always.mdc")!.scope).toEqual({ kind: "always" });
    expect(v.files.find((f) => f.path === "Source/Hollowreach/AGENTS.md")!.scope).toEqual({ kind: "folder", folder: "Source/Hollowreach" });
    // Only always-read files count toward what every call carries.
    const always = v.files.filter((f) => f.scope.kind === "always" && !f.sameAs).reduce((n, f) => n + f.tokens, 0);
    expect(v.alwaysTokens).toBe(always);
  });

  it("places an added file where the user put it, and marks one that is gone", () => {
    write("AGENTS.md", "a");
    write("docs/design.md", "The design doc.");
    const v = instructionsView(project, { off: [], added: [{ path: "docs/design.md", after: null }, { path: "docs/gone.md", after: "AGENTS.md" }] }, undefined, home);
    expect(v.files.map((f) => [f.path, f.convention, !!f.missing])).toEqual([
      ["docs/design.md", "added", false],
      ["AGENTS.md", "agents", false],
      ["docs/gone.md", "added", true],
    ]);
  });

  it("names who reads each file when it is told the team", () => {
    write("AGENTS.md", "a");
    write("GEMINI.md", "g");
    const v = instructionsView(project, { off: ["GEMINI.md"], added: [] }, (f) => (f.on ? ["main"] : []), home);
    expect(v.files.find((f) => f.path === "AGENTS.md")!.readBy).toEqual(["main"]);
    expect(v.files.find((f) => f.path === "GEMINI.md")!).toMatchObject({ on: false, readBy: [] });
  });
});

describe("what an agent is given", () => {
  it("is the always-read files in order, each under its heading, with the precedence rule stated once", () => {
    everything();
    const c = compose(project, DEFAULT_INSTRUCTION_SETTINGS, "all", home);
    const text = c.text!;
    expect(text).toMatch(/Where two disagree, the later file wins\./);
    const order = ["## From ~/.ue-mcp/studio/instructions.md", "## From .github/copilot-instructions.md", "## From .cursor/rules/always.mdc", "## From .cursorrules", "## From GEMINI.md", "## From AGENTS.md", "## From CLAUDE.local.md"];
    const at = order.map((h) => text.indexOf(h));
    expect(at.every((x) => x >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // Frontmatter is not part of what is read; scoped files wait.
    expect(text).not.toContain("alwaysApply");
    expect(text).not.toContain("Collapse graphs");
    expect(text).not.toContain("Gameplay code lives in modules");
    expect(c.conditional.map((x) => x.path)).toEqual([".cursor/rules/blueprints.mdc", "Source/Hollowreach/AGENTS.md"]);
  });

  it("leaves out files that are off, and gives nothing for none", () => {
    everything();
    const c = compose(project, { off: ["GEMINI.md", "CLAUDE.local.md"], added: [] }, "all", home);
    expect(c.text).not.toContain("Gemini notes");
    expect(c.text).not.toContain("My local override");
    expect(compose(project, DEFAULT_INSTRUCTION_SETTINGS, "none", home)).toMatchObject({ text: null, files: 0 });
  });

  it("gives only the files an agent chose", () => {
    everything();
    const c = compose(project, DEFAULT_INSTRUCTION_SETTINGS, { only: ["AGENTS.md"] }, home);
    expect(c.files).toBe(1);
    expect(c.text).toContain("UE 5.7 survival");
    expect(c.text).not.toContain("Keep reports short");
  });

  it("previews the same text with its scoped files listed", () => {
    everything();
    const p = preview(project, DEFAULT_INSTRUCTION_SETTINGS, "main", "all", home);
    expect(p.text).toBe(compose(project, DEFAULT_INSTRUCTION_SETTINGS, "all", home).text);
    expect(p.conditional.map((c) => c.path)).toEqual([".cursor/rules/blueprints.mdc", "Source/Hollowreach/AGENTS.md"]);
  });
});

describe("scoped files joining as the agent works", () => {
  it("adds a subfolder's file once the agent reads there, and only once per conversation", () => {
    everything();
    const c = compose(project, DEFAULT_INSTRUCTION_SETTINGS, "all", home);
    const sent = new Set<string>();
    expect(conditionalFor(c, pathsOf(project, "read_file", { path: "README.md" }), sent)).toBeNull();
    const first = conditionalFor(c, pathsOf(project, "read_file", { path: "Source/Hollowreach/Player.cpp" }), sent);
    expect(first).toContain("Instructions from Source/Hollowreach/AGENTS.md apply to this work in Source/Hollowreach");
    expect(first).toContain("Gameplay code lives in modules.");
    expect(conditionalFor(c, pathsOf(project, "edit_file", { path: path.join(project, "Source", "Hollowreach", "Other.cpp") }), sent)).toBeNull();
  });

  it("adds a glob rule when an editor call names an asset under it", () => {
    everything();
    const c = compose(project, DEFAULT_INSTRUCTION_SETTINGS, "all", home);
    const paths = pathsOf(project, "ue_mcp", { action: "call", category: "blueprint", method: "add_node", args: { assetPath: "/Game/Blueprints/BP_Player.BP_Player" } });
    expect(paths).toEqual(["Content/Blueprints/BP_Player.uasset"]);
    expect(conditionalFor(c, paths, new Set())).toContain("Collapse graphs over 40 nodes.");
  });

  it("matches globs the way editors read them", () => {
    expect(globRegex("Content/Blueprints/**").test("Content/Blueprints/A/B.uasset")).toBe(true);
    expect(globRegex("*.cpp").test("Source/X/Y.cpp")).toBe(true);
    expect(globRegex("Source/*.h").test("Source/X/Y.h")).toBe(false);
    expect(applies({ kind: "folder", folder: "Source/X" }, "Source/Xy/a.cpp")).toBe(false);
    expect(applies({ kind: "folder", folder: "Source/X" }, "Source/X/a.cpp")).toBe(true);
  });
});

describe("file formats", () => {
  it("reads a rule's globs as a list or a comma string, and treats unreadable frontmatter as always", () => {
    expect(cursorRule("---\nglobs: [\"a/**\", \"b/*.h\"]\n---\nx").scope).toEqual({ kind: "globs", globs: ["a/**", "b/*.h"] });
    expect(cursorRule("---\nglobs: a/**, b/*.h\n---\nx").scope).toEqual({ kind: "globs", globs: ["a/**", "b/*.h"] });
    expect(cursorRule("---\n: : :\n---\nbody").scope).toEqual({ kind: "always" });
  });

  it("finds @imports outside code only", () => {
    expect(importsIn("See @AGENTS.md and @docs/x.md.\nmail me@example.com")).toEqual(["AGENTS.md", "docs/x.md"]);
    expect(importsIn("`@not.md`\n```\n@fenced.md\n```")).toEqual([]);
  });
});

describe("creating AGENTS.md", () => {
  it("prefills it from the shared files and points CLAUDE.md at it, so nothing is read twice", () => {
    write("CLAUDE.md", "Claude rules.");
    write("GEMINI.md", "Gemini rules.");
    write(".github/copilot-instructions.md", "Copilot rules.");
    const r = createAgentsMd(project, DEFAULT_INSTRUCTION_SETTINGS, ["CLAUDE.md"], home);
    expect(r).toEqual({ written: "AGENTS.md", pointed: ["CLAUDE.md"] });
    const agents = fs.readFileSync(path.join(project, "AGENTS.md"), "utf-8");
    expect(agents).toContain("## From CLAUDE.md\n\nClaude rules.");
    expect(agents).toContain("Gemini rules.");
    expect(fs.readFileSync(path.join(project, "CLAUDE.md"), "utf-8")).toBe("@AGENTS.md\n");
    expect(fs.readFileSync(path.join(project, "GEMINI.md"), "utf-8")).toBe("Gemini rules.");
    const text = compose(project, DEFAULT_INSTRUCTION_SETTINGS, "all", home).text!;
    expect(text.match(/Claude rules\./g)).toHaveLength(1);
    expect(() => createAgentsMd(project, DEFAULT_INSTRUCTION_SETTINGS, [], home)).toThrow(/exists already/);
  });
});

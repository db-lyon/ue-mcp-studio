/**
 * Each vendor's own files, found as its tools find them: Claude Code, Codex,
 * Gemini CLI, and AGENTS.md for custom endpoints.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { appliesTo, claudeInstructions, codexInstructions, findSkills, findSubagents, geminiInstructions, geminiNames, loadout, parseCodexSubagent, repoRoot, CODEX_MAX_BYTES } from "../src/native.js";

let top: string;
let repo: string;
let project: string;
let home: string;
const write = (root: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};

beforeEach(() => {
  top = fs.mkdtempSync(path.join(os.tmpdir(), "studio-native-"));
  repo = path.join(top, "repo");
  project = path.join(repo, "Game");
  home = path.join(top, "home");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
});

const paths = (fs: Array<{ path: string }>) => fs.map((f) => f.path);

describe("Claude Code's files", () => {
  it("reads the user's file and rules, then CLAUDE.md, .claude/CLAUDE.md and CLAUDE.local.md from the root down, with imports", () => {
    write(home, ".claude/CLAUDE.md", "Mine.");
    write(home, ".claude/rules/style.md", "Short replies.");
    write(repo, "CLAUDE.md", "Repo rules. See @docs/more.md");
    write(repo, "docs/more.md", "Imported text.");
    write(project, "CLAUDE.md", "Game rules.");
    write(project, ".claude/CLAUDE.md", "Hidden rules.");
    write(project, ".claude/rules/bp.md", "---\npaths: Content/Blueprints/**\n---\nBlueprint rule.");
    write(project, "CLAUDE.local.md", "Local.");
    write(project, "AGENTS.md", "Not read: a CLAUDE.md exists.");
    write(project, "Source/Game/CLAUDE.md", "Module rules.");
    const files = claudeInstructions(project, home, top);
    expect(paths(files)).toEqual(["~/.claude/CLAUDE.md", "~/.claude/rules/style.md", "../CLAUDE.md", "CLAUDE.md", ".claude/CLAUDE.md", ".claude/rules/bp.md", "CLAUDE.local.md", "Source/Game/CLAUDE.md"]);
    const repoFile = files.find((f) => f.path === "../CLAUDE.md")!;
    expect(repoFile.text).toContain("Imported text.");
    expect(repoFile.imports).toEqual(["docs/more.md"]);
    expect(files.find((f) => f.path === ".claude/rules/bp.md")!.scope).toEqual({ kind: "globs", globs: ["Content/Blueprints/**"] });
    expect(files.find((f) => f.path === "Source/Game/CLAUDE.md")!.scope).toEqual({ kind: "folder", folder: "Source/Game" });
    expect(files.some((f) => f.path === "AGENTS.md")).toBe(false);
  });

  it("reads AGENTS.md only when there is no CLAUDE.md at all, as Claude Code does", () => {
    write(project, "AGENTS.md", "Shared.");
    write(project, ".claude/AGENTS.md", "Shared too.");
    expect(paths(claudeInstructions(project, home, top))).toEqual(["AGENTS.md", ".claude/AGENTS.md"]);
  });

  it("finds subagents from the closest .claude/agents first, then the user's, and skills with the user's winning", () => {
    write(project, ".claude/agents/reviewer.md", "---\nname: reviewer\ndescription: Reviews\ntools: Read, Grep\nmodel: sonnet\nmaxTurns: 9\nskills: [naming]\n---\nReview it.");
    write(repo, ".claude/agents/reviewer.md", "---\nname: reviewer\ndescription: Outer\n---\nOuter.");
    write(home, ".claude/agents/nested/helper.md", "---\nname: helper\ndescription: Helps\n---\nHelp.");
    write(project, ".claude/agents/broken.md", "---\ndescription: no name\n---\nx");
    const agents = findSubagents("claude", project, home);
    expect(agents.map((a) => [a.name, a.path, a.problems.length])).toEqual([["broken", ".claude/agents/broken.md", 1], ["reviewer", ".claude/agents/reviewer.md", 0], ["helper", "~/.claude/agents/nested/helper.md", 0]]);
    expect(agents[1]).toMatchObject({ model: "sonnet", maxTurns: 9, tools: ["Read", "Grep"], skills: ["naming"], prompt: "Review it." });
    write(project, ".claude/skills/naming/SKILL.md", "---\nname: naming\ndescription: Project naming\n---\nP");
    write(home, ".claude/skills/naming/SKILL.md", "---\nname: naming\ndescription: My naming\n---\nU");
    expect(findSkills("claude", project, home).skills.map((s) => [s.name, s.source, s.description])).toEqual([["naming", "user", "My naming"]]);
  });
});

describe("Codex's files", () => {
  it("reads the global file, then one file per folder from the repository root down, override first", () => {
    write(home, ".codex/AGENTS.md", "Global.");
    write(home, ".codex/AGENTS.override.md", "Global override.");
    write(repo, "AGENTS.md", "Root.");
    write(project, "AGENTS.override.md", "Game override.");
    write(project, "AGENTS.md", "Not read: the override wins in its folder.");
    expect(codexInstructions(project, home).map((f) => [f.path, f.text])).toEqual([["~/.codex/AGENTS.override.md", "Global override."], ["../AGENTS.md", "Root."], ["AGENTS.override.md", "Game override."]]);
  });

  it("honours the fallback names in config.toml and stops at 32 KiB", () => {
    write(home, ".codex/config.toml", 'project_doc_fallback_filenames = ["TEAM_GUIDE.md"]\n');
    write(repo, "TEAM_GUIDE.md", "x".repeat(CODEX_MAX_BYTES - 10));
    write(project, "AGENTS.md", "Too much now.");
    const notes: string[] = [];
    expect(paths(codexInstructions(project, home, notes))).toEqual(["../TEAM_GUIDE.md"]);
    expect(notes[0]).toMatch(/AGENTS\.md is past Codex's 32 KiB limit/);
  });

  it("reads TOML subagents, project first, and lists two skills of one name as Codex does", () => {
    write(project, ".codex/agents/builder.toml", 'name = "builder"\ndescription = "Builds"\ndeveloper_instructions = """\nBuild it.\nThen test."""\nmodel = "gpt-6-sol"\nmodel_reasoning_effort = "high"\n[features]\nshell_tool = false\n');
    write(home, ".codex/agents/builder.toml", 'name = "builder"\ndescription = "Mine"\ndeveloper_instructions = "x"\n');
    const [a] = findSubagents("codex", project, home);
    expect(a).toMatchObject({ name: "builder", description: "Builds", prompt: "Build it.\nThen test.", model: "gpt-6-sol", effort: "high", noShell: true, source: "project" });
    expect(parseCodexSubagent("name = 1 =", "x.toml", "x.toml", "project")!.problems[0]).toMatch(/not valid TOML/);
    write(project, ".agents/skills/fmt/SKILL.md", "---\nname: fmt\ndescription: A\n---\nA");
    write(repo, ".agents/skills/fmt/SKILL.md", "---\nname: fmt\ndescription: B\n---\nB");
    write(repo, ".agents/skills/quiet/SKILL.md", "---\nname: quiet\ndescription: Q\n---\nQ");
    write(repo, ".agents/skills/quiet/agents/openai.yaml", "policy:\n  allow_implicit_invocation: false\n");
    const { skills, notes } = findSkills("codex", project, home);
    expect(skills.map((s) => [s.name, s.path, s.implicit])).toEqual([["fmt", ".agents/skills/fmt", true], ["fmt", "../.agents/skills/fmt", true], ["quiet", "../.agents/skills/quiet", false]]);
    expect(notes[0]).toMatch(/Two skills are named fmt/);
    expect(skills[2].files).toEqual(["agents/openai.yaml"]);
  });
});

describe("Gemini CLI's files", () => {
  it("reads context.fileName, the global file, the folders from the repository root down, and subfolders at start", () => {
    write(project, ".gemini/settings.json", JSON.stringify({ context: { fileName: ["AGENTS.md", "GEMINI.md"] } }));
    expect(geminiNames(project, home)).toEqual(["AGENTS.md", "GEMINI.md"]);
    write(home, ".gemini/GEMINI.md", "Global.");
    write(repo, "AGENTS.md", "Root agents.");
    write(project, "GEMINI.md", "Game @./more.md");
    write(project, "more.md", "More.");
    write(project, "Source/Mod/GEMINI.md", "Module.");
    const files = geminiInstructions(project, home);
    expect(paths(files)).toEqual(["~/.gemini/GEMINI.md", "../AGENTS.md", "GEMINI.md", "Source/Mod/GEMINI.md"]);
    expect(files[2].text).toContain("More.");
    expect(files.every((f) => f.scope.kind === "always")).toBe(true);
  });

  it("reads markdown subagents and skills with workspace over user and .agents over .gemini", () => {
    write(project, ".gemini/agents/scout.md", "---\nname: scout\ndescription: Scouts\ntools: [read_file, \"mcp_*\"]\nmax_turns: 12\nmodel: gemini-3.8-flash\n---\nScout.");
    expect(findSubagents("gemini", project, home)[0]).toMatchObject({ name: "scout", maxTurns: 12, tools: ["read_file", "mcp_*"], model: "gemini-3.8-flash" });
    write(project, ".gemini/skills/a/SKILL.md", "---\nname: a\ndescription: gemini folder\n---\n");
    write(project, ".agents/skills/a/SKILL.md", "---\nname: a\ndescription: agents folder\n---\n");
    write(home, ".agents/skills/a/SKILL.md", "---\nname: a\ndescription: user\n---\n");
    expect(findSkills("gemini", project, home).skills.map((s) => s.description)).toEqual(["agents folder"]);
  });
});

describe("custom endpoints", () => {
  it("read AGENTS.md from the repository root down and .agents/skills, with no subagents", () => {
    write(repo, "AGENTS.md", "Root.");
    write(project, "AGENTS.md", "Game.");
    write(project, ".claude/agents/x.md", "---\nname: x\ndescription: x\n---\nx");
    const l = loadout("agents", project, home, new Map(), top);
    expect(paths(l.instructions)).toEqual(["../AGENTS.md", "AGENTS.md"]);
    expect(l.subagents).toEqual([]);
  });
});

describe("helpers", () => {
  it("finds the repository root, or the project when there is none", () => {
    expect(repoRoot(project)).toBe(path.resolve(repo));
    const lone = fs.mkdtempSync(path.join(os.tmpdir(), "studio-lone-"));
    expect(repoRoot(lone)).toBe(path.resolve(lone));
  });

  it("marks a skill owned by a ue-mcp plugin", () => {
    write(project, ".claude/skills/meshy-import/SKILL.md", "---\nname: meshy-import\ndescription: Imports\n---\nBody");
    const owners = new Map([[path.resolve(path.join(project, ".claude", "skills", "meshy-import")), "ue-mcp-meshy"]]);
    expect(findSkills("claude", project, home, owners).skills[0]).toMatchObject({ source: "plugin", owner: "ue-mcp-meshy", body: "Body" });
  });

  it("applies scoped files by folder and by glob", () => {
    expect(appliesTo({ kind: "folder", folder: "Source/Game" }, "Source/Game/A.cpp")).toBe(true);
    expect(appliesTo({ kind: "globs", globs: ["Content/Blueprints/**"] }, "Content/Blueprints/BP.uasset")).toBe(true);
    expect(appliesTo({ kind: "globs", globs: ["Content/Blueprints/**"] }, "Content/Maps/L.umap")).toBe(false);
  });
});

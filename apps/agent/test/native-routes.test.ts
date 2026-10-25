/** GET /native, the preview, and Open file, against a fake daemon API. */
import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DaemonExtensionApi } from "ue-mcp/daemon";
import type { NativeOverview, NativePreview } from "@ue-mcp-studio/shared";
import { registerNativeRoutes } from "../src/native-routes.js";

type Handler = (req: { body?: unknown; query?: Record<string, string> }) => { status?: number; body?: unknown };
let root: string;
let project: string;
let home: string;
let routes: Map<string, Handler>;
let opened: string[];
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
  fs.writeFileSync(path.join(project, rel), text);
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-native-routes-"));
  project = path.join(root, "Game");
  home = path.join(root, "home");
  fs.mkdirSync(path.join(project, ".git"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  routes = new Map();
  opened = [];
});

function setup(main = { vendor: "openai", model: "gpt-6-sol", route: "chatgpt" as string | null }) {
  const api = { projectDir: project, route: (m: string, p: string, h: Handler) => void routes.set(`${m} ${p}`, h) } as unknown as DaemonExtensionApi;
  registerNativeRoutes(api, {
    enabled: () => true,
    main: () => main,
    routesFor: (v) => (v === "openai" ? ["ChatGPT sign-in"] : v === "anthropic" ? ["Claude sign-in"] : []),
    runsOverApi: (v, m) => v === "openai" && m === "gpt-6-luna",
    modelName: (m) => m.toUpperCase(),
    worker: () => ({ model: "GPT-6-SOL", effort: "high", starts: "asked", fromSettings: false }),
    home: () => home,
    owners: () => new Map(),
    top: root,
    open: (abs) => void opened.push(abs),
  });
  return (key: string, body?: unknown, query: Record<string, string> = {}) => routes.get(key)!({ body, query });
}

describe("the native view", () => {
  it("lists each convention's files with who reads them and how each subagent runs here", () => {
    write("AGENTS.md", "Shared.");
    write(".codex/agents/scout.toml", 'name = "scout"\ndescription = "Finds"\ndeveloper_instructions = "Find."\nmodel = "gpt-6-luna"\n');
    write(".codex/agents/heavy.toml", 'name = "heavy"\ndescription = "Big"\ndeveloper_instructions = "Think."\nmodel = "gpt-9"\n[features]\nshell_tool = false\n');
    const call = setup();
    const o = call("GET /native").body as NativeOverview;
    expect(o.main).toBe("codex");
    expect(o.conventions.map((c) => c.convention)).toEqual(["claude", "codex", "gemini", "agents"]);
    const codex = o.conventions.find((c) => c.convention === "codex")!;
    expect(codex.routes).toEqual(["ChatGPT sign-in"]);
    expect(codex.instructions.map((f) => f.path)).toEqual(["AGENTS.md"]);
    expect(codex.subagents.map((a) => [a.name, a.runs])).toEqual([
      ["heavy", { model: "The main agent's, GPT-6-SOL", note: "Nothing on this machine runs gpt-9 over the API, so it runs on the main agent's model." }],
      ["scout", { model: "GPT-6-LUNA" }],
    ]);
    expect(codex.subagents[0].tools).toContain("edit_file");
    expect(codex.subagents[0].tools).not.toMatch(/(^|, )shell/);
    // Claude Code reads AGENTS.md when there is no CLAUDE.md, so it shows there too.
    expect(o.conventions[0].instructions.map((f) => f.path)).toEqual(["AGENTS.md"]);
  });

  it("shows no model a subagent would run on while nothing runs the main agent", () => {
    write(".codex/agents/heavy.toml", 'name = "heavy"\ndescription = "Big"\ndeveloper_instructions = "Think."\nmodel = "gpt-9"\n');
    write(".codex/agents/plain.toml", 'name = "plain"\ndescription = "Plain"\ndeveloper_instructions = "Do."\n');
    const o = setup({ vendor: "openai", model: "gpt-6-sol", route: null })("GET /native").body as NativeOverview;
    const codex = o.conventions.find((c) => c.convention === "codex")!;
    expect(codex.subagents.map((a) => [a.name, a.runs])).toEqual([
      ["heavy", { model: "Runs once a route for OpenAI models is connected" }],
      ["plain", { model: "The main agent's model, none runs here yet" }],
    ]);
  });

  it("previews the text an agent is given, and says when the SDK loads it itself", () => {
    write("CLAUDE.md", "Claude rules.");
    const p = setup({ vendor: "anthropic", model: "claude-opus-5-5", route: "claude" })("GET /native/preview", undefined, { convention: "claude" }).body as NativePreview;
    // The SDK reads the files itself, so the preview is the files, not a prompt Studio writes.
    expect(p).toMatchObject({ convention: "claude", loadedBy: "sdk", files: 1, text: "## CLAUDE.md\nClaude rules." });
    expect(p.parts).toEqual([{ path: "CLAUDE.md", text: "Claude rules." }]);
    const own = setup({ vendor: "anthropic", model: "claude-opus-5-5", route: "key" })("GET /native/preview", undefined, { convention: "claude" }).body as NativePreview;
    expect(own).toMatchObject({ loadedBy: "studio", files: 1 });
    expect(own.text).toContain("## From CLAUDE.md\nClaude rules.");
    expect(setup()("GET /native/preview", undefined, { convention: "nobody" }).status).toBe(400);
  });
});

describe("Open file", () => {
  it("opens a file the view listed, and refuses any other path", () => {
    write("AGENTS.md", "Shared.");
    write(".agents/skills/naming/SKILL.md", "---\nname: naming\ndescription: N\n---\nBody");
    const call = setup();
    call("GET /native");
    expect(call("POST /files/open", { path: "AGENTS.md" }).status).toBe(204);
    expect(call("POST /files/open", { path: ".agents/skills/naming" }).status).toBe(204);
    expect(opened).toEqual([path.join(project, "AGENTS.md"), path.join(project, ".agents", "skills", "naming", "SKILL.md")]);
    expect(call("POST /files/open", { path: "../../secret.txt" }).status).toBe(403);
    expect(call("POST /files/open", {}).status).toBe(400);
  });
});

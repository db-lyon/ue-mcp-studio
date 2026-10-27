/**
 * Settings states for the visual QA harness: every section, and the states
 * each one has (connected or not).
 * Each answer is what the agent's own route would send; main.tsx answers the
 * rest of a section's reads from its defaults.
 */
import type { NativeOverview, StudioSettings } from "@ue-mcp-studio/shared";
import type { Scenario } from "./fixtures";

/** Settings > Agents with nothing connected: every convention's files found, none read by a route. */
const NATIVE_NONE = (): NativeOverview => ({ ...NATIVE_FULL, main: null, conventions: NATIVE_FULL.conventions.map((c) => ({ ...c, routes: [] })) });

/** Settings > Agents with Claude and Codex files, a subagent and a skill. */
const NATIVE_FULL: NativeOverview = {
  enabled: true,
  main: "claude",
  worker: { model: "Claude Haiku 5.5", effort: "low", starts: "asked", fromSettings: false },
  conventions: [
    { convention: "claude", routes: ["Claude sign-in"], instructionTokens: 1240, notes: [], skipped: [{ path: "AGENTS.md", why: "not read: Claude Code reads AGENTS.md only where there is no CLAUDE.md" }],
      instructions: [
        { path: "CLAUDE.md", source: "project", tokens: 980, scope: { kind: "always" } },
        { path: "C:/Users/dev/.claude/CLAUDE.md", source: "user", tokens: 260, scope: { kind: "always" } },
        { path: "Source/StudioE2E/CLAUDE.md", source: "project", tokens: 310, scope: { kind: "folder", folder: "Source/StudioE2E" } },
      ],
      subagents: [{ name: "level-dresser", description: "Places props and foliage in a level from a short brief", path: ".claude/agents/level-dresser.md", source: "project", tokens: 420, model: "haiku", runs: { model: "Haiku 5.5" }, tools: "ue-mcp level and asset tools", effort: null, maxTurns: 30, problems: [] }],
      skills: [{ name: "naming-conventions", description: "Asset prefixes and folder layout for this project", path: ".claude/skills/naming-conventions", source: "project", tokens: 640, implicit: true, problems: [] }] },
    { convention: "codex", routes: [], instructionTokens: 300, notes: [], skipped: [], instructions: [{ path: "AGENTS.md", source: "project", tokens: 300, scope: { kind: "always" } }], subagents: [], skills: [] },
    { convention: "gemini", routes: [], instructionTokens: 0, notes: [], skipped: [], instructions: [], subagents: [], skills: [] },
    { convention: "agents", routes: [], instructionTokens: 300, notes: [], skipped: [], instructions: [{ path: "AGENTS.md", source: "project", tokens: 300, scope: { kind: "always" } }], subagents: [], skills: [] },
  ],
} as NativeOverview;

const NOTHING_CONNECTED: Partial<StudioSettings> = { route: null, connected: {} as StudioSettings["connected"] };

const page = (title: string, section: string, o: Partial<Scenario> = {}): Scenario => ({ title, hash: `#/settings/${section}`, index: { playtests: [], listed: true }, height: 2600, ...o });

export const SETTINGS_SCENARIOS: Record<string, Scenario> = {
  "settings-list": page("Settings at narrow width: the list of sections, each with its state; wide opens Agents", "", { hash: "#/settings" }),
  "settings-agents": page("Agents: main agent, worker, and the project's Claude files with a subagent and a skill", "agents", { get: (p) => (p === "/v1/ext/studio/native" ? NATIVE_FULL : undefined) }),
  "settings-agents-not-connected": page("Agents with nothing connected: the main agent cannot run yet, and no route reads the project's files", "agents", { settings: NOTHING_CONNECTED, get: (p) => (p === "/v1/ext/studio/native" ? NATIVE_NONE() : undefined) }),
  "settings-agents-files-off": page("Agents with the project's own files switched off", "agents", { settings: { usage: { projectInstructions: false } } as Partial<StudioSettings> }),
  "settings-models": page("Models & accounts: Claude signed in, no keys", "models"),
  "settings-models-nothing": page("Models & accounts with nothing connected", "models", { settings: NOTHING_CONNECTED }),
  "settings-approvals": page("Approvals & review: shell and files ask, review on", "approvals"),
  "settings-project": page("Project: ready, Micro for other clients, one MCP client", "project"),
  "settings-project-attention": page("Project needing attention, with the context strategy set by the environment", "project", {
    get: (p) => p === "/v1/install"
      ? { ...INSTALL, plugin: { ...INSTALL.plugin, installedVersion: "1.4.9" }, ok: false, problems: [{ code: "plugin-outdated", what: "The bridge plugin is older than this ue-mcp", fix: "Run npx ue-mcp update, then rebuild the project." }] }
      : p === "/v1/ext/studio/context-strategy" ? { ...CONTEXT, fromFile: true, envOverride: "full" } : undefined,
  }),
  "settings-project-yaml": page("Project with Advanced open: ue-mcp.yml highlighted, focused, with a line longer than the box", "project", {
    get: (p) => (p === "/v1/ext/studio/config" ? { path: "C:/Projects/StudioE2E/ue-mcp.yml", exists: true, text: YAML } : undefined),
    click: "details.advanced > summary",
    scroll: "details.advanced",
    focus: ".yaml-editor textarea",
  }),
  "settings-general": page("General: themes and updates", "general"),
  "settings-diagnostics": page("Diagnostics: the editor and daemon, and the event log, empty because the harness sends no events", "diagnostics"),
};

export const INSTALL = {
  ok: true,
  problems: [],
  project: { engine: "5.7", name: "StudioE2E" },
  plugin: { deployed: true, installedVersion: "1.4.11-beta.4", installKind: "source", packagedVersion: "1.4.11-beta.4", enabledInUproject: true, pluginDir: "C:/Projects/StudioE2E/Plugins/UE_MCP_Bridge" },
  toolchain: { present: true, name: "MSVC 14.44" },
  node: { version: "v22.11.0" },
  clients: [{ id: "claude-code", name: "Claude Code", detected: true, configured: true, pinned: null }, { id: "gemini", name: "Gemini CLI", detected: true, configured: false, pinned: null }],
};

export const CONTEXT = { strategy: "micro", fromFile: false, envOverride: null, seeds: { micro: 2180, lean: 18740, full: 50920 }, };

/** Every kind of token the ue-mcp.yml editor colours, and a line wider than the box. */
const YAML = [
  "# ue-mcp.yml: what ue-mcp does for this project",
  "---",
  "context:",
  "  strategy: micro # micro, lean or full",
  "server:",
  "  mode: daemon",
  "  port: 9867",
  "  timeoutSeconds: 2.5",
  "  paramEcho: false",
  "  proxy: null",
  "defaults: &defaults",
  "  retries: 3",
  "  label: \"Studio E2E\"",
  "flows:",
  "  smoke:",
  "    <<: *defaults",
  "    steps:",
  "      - project.get_status",
  "      - level.list_actors",
  "      - !!str 42",
  "    tags: [qa, nightly, {owner: 'level-team'}]",
  "  notes: |",
  "    Free text: not a key, # not a comment.",
  "    Kept as written.",
  "extraContentRoots: [\"/Game/VeryLongFolderNameThatKeepsGoing/AndGoing/AndGoingPastTheRightEdgeOfTheBox\", \"/Game/Other\"]",
  "",
].join("\n");

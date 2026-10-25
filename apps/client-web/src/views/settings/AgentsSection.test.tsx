// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DEFAULT_USAGE, type NativeOverview, type UsageSettings } from "@ue-mcp-studio/shared";

const overview = (over: Partial<NativeOverview> = {}): NativeOverview => ({
  enabled: true,
  main: "codex",
  worker: { model: "6 Sol", effort: "high", starts: "asked", fromSettings: false },
  conventions: [
    { convention: "claude", routes: ["Claude sign-in"], instructionTokens: 120, notes: [], subagents: [], skills: [],
      instructions: [{ path: "CLAUDE.md", source: "project", tokens: 120, scope: { kind: "always" } }] },
    { convention: "codex", routes: ["ChatGPT sign-in", "OpenAI key"], instructionTokens: 300, notes: ["AGENTS.md is past Codex's 32 KiB limit for instruction files, so it is not read."],
      instructions: [{ path: "AGENTS.md", source: "project", tokens: 300, scope: { kind: "always" } }, { path: "~/.codex/AGENTS.md", source: "user", tokens: 40, scope: { kind: "always" } }],
      subagents: [{ name: "scout", description: "Finds assets", path: ".codex/agents/scout.toml", source: "project", tokens: 30, model: "gpt-6-luna", runs: { model: "6 Luna" }, tools: "every tool but shell", effort: "low", maxTurns: null, problems: [] }],
      skills: [{ name: "naming", description: "Zone naming", path: ".agents/skills/naming", source: "plugin", owner: "ue-mcp-meshy", tokens: 200, implicit: false, problems: [] }] },
    { convention: "gemini", routes: [], instructionTokens: 0, notes: [], instructions: [], subagents: [], skills: [] },
    { convention: "agents", routes: [], instructionTokens: 0, notes: [], instructions: [], subagents: [], skills: [] },
  ],
  ...over,
});

const m = vi.hoisted(() => ({
  settings: vi.fn(),
  saveSettings: vi.fn(),
  native: vi.fn(),
  nativePreview: vi.fn(async () => ({ convention: "codex", text: "The project's own instructions...", tokens: 10, loadedBy: "studio" })),
  openFile: vi.fn(async () => undefined),
  models: vi.fn(async () => ({ signedIn: {}, providers: [] })),
}));
vi.mock("../../api", () => ({ api: m, ApiError: Error }));
import { AgentsSection } from "./AgentsSection";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const settingsWith = (usage: Partial<UsageSettings> = {}) => ({ provider: "openai", model: "gpt-6-sol", effort: "high", route: "chatgpt", connected: { chatgpt: true }, usage: { ...DEFAULT_USAGE, ...usage } });

async function show(usage: Partial<UsageSettings> = {}, o = overview()) {
  m.settings.mockResolvedValue(settingsWith(usage));
  m.saveSettings.mockImplementation(async (u: { usage: Partial<UsageSettings> }) => settingsWith({ ...usage, ...u.usage }));
  m.native.mockResolvedValue(o);
  await act(async () => void render(<AgentsSection onSection={vi.fn()} />));
}

describe("Agents: what each vendor's own files give its models", () => {
  it("opens on the main agent's convention, says who reads it, and lists each kind with its source", async () => {
    await show();
    const tabs = screen.getByRole("navigation", { name: "Whose files" });
    expect([...tabs.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["OpenAI4", "Claude1", "Gemini0", "Other models0"]);
    expect(screen.getByText(/The main agent reads these\. Read on this machine by ChatGPT sign-in and OpenAI key\./)).toBeTruthy();
    expect(screen.getByText("AGENTS.md is past Codex's 32 KiB limit for instruction files, so it is not read.")).toBeTruthy();
    expect(screen.getByText("scout")).toBeTruthy();
    expect(screen.getByText(/Runs on 6 Luna \(its file names gpt-6-luna\)\. Tools: every tool but shell\./)).toBeTruthy();
    expect(screen.getByText("plugin ue-mcp-meshy")).toBeTruthy();
    expect(screen.getByText(/Used only when you name it\./)).toBeTruthy();
  });

  it("opens a listed file in the system's editor", async () => {
    await show();
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Open .codex/agents/scout.toml" })));
    expect(m.openFile).toHaveBeenCalledWith(".codex/agents/scout.toml");
  });

  it("says where each vendor would read files a project does not have yet", async () => {
    await show();
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: /^Gemini/ })));
    expect(screen.getByText(/None in this project\. Gemini CLI reads a GEMINI\.md in the project folder\./)).toBeTruthy();
    expect(screen.getByText(/No connected route reads these yet\./)).toBeTruthy();
  });

  it("offers no subagent or skill editing, only the switch that reads the files at all", async () => {
    await show();
    expect(screen.queryByRole("combobox", { name: /Helper model/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Add a file|Create AGENTS\.md|New skill/ })).toBeNull();
    await act(async () => void fireEvent.click(screen.getByRole("switch", { name: "Read the project's own files" })));
    expect(m.saveSettings).toHaveBeenCalledWith({ usage: { projectInstructions: false } });
    expect(screen.getByText(/The project's own files are not read\./)).toBeTruthy();
  });

  it("shows Studio's own worker read only, and says when earlier settings set it", async () => {
    await show({}, overview({ worker: { model: "Haiku 5.5", effort: "low", starts: "automatic", fromSettings: true } }));
    expect(screen.getByText("Haiku 5.5")).toBeTruthy();
    expect(screen.getByText("when the work splits into independent parts")).toBeTruthy();
    expect(screen.getByText(/settings you made in an earlier Studio/)).toBeTruthy();
  });

  it("saves the screenshot size", async () => {
    await show();
    await act(async () => void fireEvent.click(screen.getByRole("radio", { name: /^Small/ })));
    expect(m.saveSettings).toHaveBeenCalledWith({ usage: { imageSize: "small" } });
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DEFAULT_USAGE, type NativeOverview, type UsageSettings } from "@ue-mcp-studio/shared";

const overview = (over: Partial<NativeOverview> = {}): NativeOverview => ({
  enabled: true,
  main: "codex",
  worker: { model: "6 Sol", effort: "high", starts: "asked", fromSettings: false },
  conventions: [
    { convention: "claude", routes: ["Claude sign-in"], instructionTokens: 120, notes: [], skipped: [{ path: "AGENTS.md", why: "not read: Claude Code reads AGENTS.md only where there is no CLAUDE.md" }], subagents: [], skills: [],
      instructions: [{ path: "CLAUDE.md", source: "project", tokens: 120, scope: { kind: "always" } }] },
    { convention: "codex", routes: ["ChatGPT sign-in", "OpenAI key"], instructionTokens: 300, notes: ["AGENTS.md is past Codex's 32 KiB limit for instruction files, so it is not read."], skipped: [],
      instructions: [{ path: "AGENTS.md", source: "project", tokens: 300, scope: { kind: "always" } }, { path: "~/.codex/AGENTS.md", source: "user", tokens: 40, scope: { kind: "always" } }],
      subagents: [{ name: "scout", description: "Finds assets", path: ".codex/agents/scout.toml", source: "project", tokens: 30, model: "gpt-6-luna", runs: { model: "6 Luna" }, tools: "every tool but shell", effort: "low", maxTurns: null, problems: [] }],
      skills: [{ name: "naming", description: "Zone naming", path: ".agents/skills/naming", source: "plugin", owner: "ue-mcp-meshy", tokens: 200, implicit: false, problems: [] }] },
    { convention: "gemini", routes: [], instructionTokens: 0, notes: [], skipped: [], instructions: [], subagents: [], skills: [] },
    { convention: "agents", routes: [], instructionTokens: 0, notes: [], skipped: [], instructions: [], subagents: [], skills: [] },
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
    // One fixed order in every state; a dot, not the position, marks what a route reads.
    expect([...tabs.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Claude Code1, read by a connected route", "Codex4, read by a connected route", "Gemini CLI0", "AGENTS.md0"]);
    expect([...tabs.querySelectorAll("button")].map((b) => !!b.querySelector(".dot"))).toEqual([true, true, false, false]);
    expect(tabs.querySelector("[aria-current=page]")?.textContent).toBe("Codex4, read by a connected route");
    expect(screen.getByText(/Read by: ChatGPT sign-in, OpenAI key\. The main agent runs here\. Studio reads them the way Codex does\./)).toBeTruthy();
    expect(screen.getByText("Project")).toBeTruthy();
    expect(screen.getByText("AGENTS.md is past Codex's 32 KiB limit for instruction files, so it is not read.")).toBeTruthy();
    expect(screen.getByText("scout")).toBeTruthy();
    expect(screen.getByText("gpt-6-luna").closest("dd")?.textContent).toBe("6 Luna (file says gpt-6-luna)");
    expect(screen.getByText("every tool but shell")).toBeTruthy();
    expect(screen.getByText("Plugin: ue-mcp-meshy")).toBeTruthy();
    expect(screen.getByText(/Used only when you name it\./)).toBeTruthy();
  });

  it("says on the Claude Code tab that an AGENTS.md beside a CLAUDE.md is passed over, and lets it be opened", async () => {
    await show();
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: /^Claude Code/ })));
    expect(screen.getByText("not read: Claude Code reads AGENTS.md only where there is no CLAUDE.md")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Open AGENTS.md" })).toHaveLength(1);
  });

  it("opens a listed file in the system's editor", async () => {
    await show();
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Open .codex/agents/scout.toml" })));
    expect(m.openFile).toHaveBeenCalledWith(".codex/agents/scout.toml");
  });

  it("says where each vendor would read files a project does not have yet", async () => {
    await show();
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: /^Gemini CLI/ })));
    expect(screen.getByText(/None found in any of those places\. The usual one is a GEMINI\.md in the project folder\./)).toBeTruthy();
    expect(screen.getByText(/No connected route reads these\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect one in Models & accounts" })).toBeTruthy();
  });

  it("offers no subagent or skill editing, only the switch that reads the files at all", async () => {
    await show();
    expect(screen.queryByRole("combobox", { name: /Helper model/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Add a file|Create AGENTS\.md|New skill/ })).toBeNull();
    await act(async () => void fireEvent.click(screen.getByRole("switch", { name: "Read the project's agent files" })));
    expect(m.saveSettings).toHaveBeenCalledWith({ usage: { projectInstructions: false } });
    expect(screen.getByText(/Off: agents are given none of the project's own files\./)).toBeTruthy();
  });

  it("shows Studio's own worker read only, and says when earlier settings set it", async () => {
    await show({}, overview({ worker: { model: "Haiku 5.5", effort: "low", starts: "automatic", fromSettings: true } }));
    expect(screen.getByText("Haiku 5.5")).toBeTruthy();
    expect(screen.getByText("when the work splits into independent parts")).toBeTruthy();
    expect(screen.getByText("Set in an earlier Studio and kept. Read only.")).toBeTruthy();
  });

  it("follows the main agent when the worker has no model of its own", async () => {
    await show({}, overview({ worker: { model: null, effort: null, starts: "asked", fromSettings: false } }));
    expect(screen.getAllByText("Same as the main agent")).toHaveLength(2);
  });

  it("shows the same tabs when nothing is connected, each saying no route reads it", async () => {
    const none = overview({ main: null, conventions: overview().conventions.map((c) => ({ ...c, routes: [] })) });
    await show({}, none);
    const tabs = screen.getByRole("navigation", { name: "Whose files" });
    expect([...tabs.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Claude Code1", "Codex4", "Gemini CLI0", "AGENTS.md0"]);
    expect(tabs.querySelector(".dot")).toBeNull();
    expect(screen.getByText(/No connected route reads these\./)).toBeTruthy();
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: /^AGENTS\.md/ })));
    // Custom endpoints read AGENTS.md; nothing to connect until one is set up.
    expect(screen.getByText(/Read by: custom endpoints. No route on this machine reads these./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect one in Models & accounts" })).toBeNull();
  });

  it("titles the preview by who loads the files", async () => {
    m.nativePreview.mockResolvedValueOnce({ convention: "codex", text: "## CLAUDE.md", tokens: 3, files: 1, loadedBy: "sdk", parts: [{ path: "CLAUDE.md", text: "Rules only." }] } as never);
    await show();
    expect(screen.getByText("Preview: the text on every call (1 file)")).toBeTruthy();
    // The SDK reads the files as they are: the preview adds no headings into their text.
    expect(screen.getByText("Rules only.").tagName).toBe("PRE");
    expect(screen.queryByText(/## CLAUDE.md/)).toBeNull();
  });

  it("saves the screenshot size", async () => {
    await show();
    await act(async () => void fireEvent.click(screen.getByRole("radio", { name: /^Small/ })));
    expect(m.saveSettings).toHaveBeenCalledWith({ usage: { imageSize: "small" } });
  });
});

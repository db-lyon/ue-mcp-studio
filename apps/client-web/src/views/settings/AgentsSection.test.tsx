// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { DEFAULT_USAGE, type NativeOverview, type UsageSettings } from "@ue-mcp-studio/shared";

const overview = (over: Partial<NativeOverview> = {}): NativeOverview => ({
  enabled: true,
  main: "codex",
  worker: { model: "6 Sol", effort: "high", starts: "asked" },
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
  m.models.mockImplementation(async () => ({ signedIn: {}, providers: [] }));
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
    expect(screen.getByText(/Read by: ChatGPT sign-in, OpenAI key. Main agent./)).toBeTruthy();
    expect(screen.getByText("Project")).toBeTruthy();
    expect(screen.getByText("AGENTS.md is past Codex's 32 KiB limit for instruction files, so it is not read.")).toBeTruthy();
    expect(screen.getByText("scout")).toBeTruthy();
    expect(screen.getByText("gpt-6-luna").closest("dd")?.textContent).toBe("6 Luna (file says gpt-6-luna)");
    expect(screen.getByText("every tool but shell")).toBeTruthy();
    expect(screen.getByText("Plugin: ue-mcp-meshy")).toBeTruthy();
    expect(screen.getByText(/used only when named/)).toBeTruthy();
  });

  it("says on the Claude Code tab that an AGENTS.md beside a CLAUDE.md is passed over, and lets it be opened", async () => {
    await show();
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: /^Claude Code/ })));
    expect(screen.getByText("not read: Claude Code reads AGENTS.md only where there is no CLAUDE.md")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Open AGENTS.md" })).toHaveLength(1);
  });

  it("says when a tab no route reads shares its files with one a route does", async () => {
    const o = overview();
    o.conventions[3] = { ...o.conventions[3], instructions: [{ path: "AGENTS.md", source: "project", tokens: 300, scope: { kind: "always" } }] };
    await show({}, o);
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: /^AGENTS\.md/ })));
    expect(document.querySelector(".readers.also")?.textContent).toBe("Also read under Codex, by ChatGPT sign-in, OpenAI key.");
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Codex" })));
    expect(screen.getByRole("navigation", { name: "Whose files" }).querySelector("[aria-current=page]")?.textContent).toBe("Codex4, read by a connected route");
  });

  it("opens a listed file in the system's editor", async () => {
    await show();
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Open .codex/agents/scout.toml" })));
    expect(m.openFile).toHaveBeenCalledWith(".codex/agents/scout.toml");
  });

  it("says where each vendor would read files a project does not have yet", async () => {
    await show();
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: /^Gemini CLI/ })));
    expect(screen.getByText(/None found. Usually GEMINI.md in the project folder./)).toBeTruthy();
    expect(screen.getByText(/No connected route reads these\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect one" })).toBeTruthy();
  });

  it("offers no subagent or skill editing, only the switch that reads the files at all", async () => {
    await show();
    expect(screen.queryByRole("button", { name: /Add a file|Create AGENTS\.md|New skill/ })).toBeNull();
    await act(async () => void fireEvent.click(screen.getByRole("switch", { name: "Read the project's agent files" })));
    expect(m.saveSettings).toHaveBeenCalledWith({ usage: { projectInstructions: false } });
    expect(screen.queryByRole("navigation", { name: "Whose files" })).toBeNull();
  });

  it("follows the main agent when the worker has no model or effort of its own", async () => {
    await show();
    expect(screen.getByRole("button", { name: "Worker model: Same as main agent" })).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "Worker effort" }) as HTMLSelectElement).value).toBe("");
    expect(screen.getByRole("radio", { name: "When you ask" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText(/earlier version/)).toBeNull();
  });

  it("picks the worker's model from the main agent's vendor only, and back to the main agent's", async () => {
    m.models.mockResolvedValue({ signedIn: { chatgpt: true }, providers: [
      { id: "openai", name: "OpenAI", connected: false, models: [{ id: "gpt-6-sol", name: "6 Sol", signIns: ["chatgpt"] }, { id: "gpt-6-luna", name: "6 Luna", signIns: ["chatgpt"] }] },
      { id: "anthropic", name: "Anthropic", connected: true, models: [{ id: "claude-haiku-5-5", name: "Haiku 5.5", signIns: [] }] },
    ] } as never);
    await show();
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: /^Worker model/ })));
    const menu = screen.getByRole("listbox");
    expect([...menu.querySelectorAll("[role=option]")].map((o) => o.querySelector("span")?.textContent)).toEqual(["Same as main agent", "6 Sol", "6 Luna"]);
    await act(async () => void fireEvent.click(screen.getByRole("option", { name: /6 Luna/ })));
    expect(m.saveSettings).toHaveBeenLastCalledWith({ usage: { subagentModel: { provider: "openai", model: "gpt-6-luna" } } });
    expect(screen.getByRole("button", { name: "Worker model: 6 Luna" })).toBeTruthy();
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: /^Worker model/ })));
    await act(async () => void fireEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: "Same as main agent" })));
    expect(m.saveSettings).toHaveBeenLastCalledWith({ usage: { subagentModel: null } });
  });

  it("shows a stored model of another vendor as the main agent's, since the worker does not use it", async () => {
    await show({ subagentModel: { provider: "anthropic", model: "claude-haiku-5-5" } });
    expect(screen.getByRole("button", { name: "Worker model: Same as main agent" })).toBeTruthy();
  });

  it("sets and clears the worker's effort", async () => {
    await show({ subagentEffort: "low" });
    const effort = screen.getByRole("combobox", { name: "Worker effort" }) as HTMLSelectElement;
    expect(effort.value).toBe("low");
    await act(async () => void fireEvent.change(effort, { target: { value: "max" } }));
    expect(m.saveSettings).toHaveBeenLastCalledWith({ usage: { subagentEffort: "max" } });
    await act(async () => void fireEvent.change(effort, { target: { value: "" } }));
    expect(m.saveSettings).toHaveBeenLastCalledWith({ usage: { subagentEffort: null } });
    // The main agent's effort is a different control and is not touched.
    expect(m.saveSettings).not.toHaveBeenCalledWith(expect.objectContaining({ effort: expect.anything() }));
  });

  it("shows an off from an earlier version as When you ask, and changes it", async () => {
    await show({ subagents: "off" });
    expect(screen.getByRole("radio", { name: "When you ask" }).getAttribute("aria-checked")).toBe("true");
    await act(async () => void fireEvent.click(screen.getByRole("radio", { name: "When work splits into independent parts" })));
    expect(m.saveSettings).toHaveBeenLastCalledWith({ usage: { subagents: "automatic" } });
    expect(screen.getByRole("radio", { name: "When work splits into independent parts" }).getAttribute("aria-checked")).toBe("true");
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
    expect(screen.getByText(/No connected route reads these./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect one" })).toBeNull();
  });

  it("titles the preview by who loads the files", async () => {
    m.nativePreview.mockResolvedValueOnce({ convention: "codex", text: "## CLAUDE.md", tokens: 3, files: 1, loadedBy: "sdk", parts: [{ path: "CLAUDE.md", text: "Rules only." }] } as never);
    await show();
    expect(screen.getByText("Preview (1 file)")).toBeTruthy();
    // The SDK reads the files as they are: the preview adds no headings into their text.
    expect(screen.getByText("Rules only.").tagName).toBe("PRE");
    expect(screen.queryByText(/## CLAUDE.md/)).toBeNull();
  });



  it("shows the Worker's subagents at once and saves a new number (#164)", async () => {
    await show();
    const field = screen.getByRole("textbox", { name: "Concurrency" }) as HTMLInputElement;
    expect(field.value).toBe("4");
    expect(screen.getByText("Concurrency")).toBeTruthy();
    expect(screen.getByText("The most subagents that run at the same time, 1 to 16. When the agent starts more, the extra ones wait and start as running ones finish.")).toBeTruthy();
    fireEvent.change(field, { target: { value: "8" } });
    await act(async () => void fireEvent.keyDown(field, { key: "Enter" }));
    expect(m.saveSettings).toHaveBeenCalledWith({ usage: { subagentsPerTurn: 8 } });
    expect((screen.getByRole("textbox", { name: "Concurrency" }) as HTMLInputElement).value).toBe("8");
  });

  it("keeps a subagents at once outside 1 to 16 from being saved, and says why", async () => {
    await show({ subagentsPerTurn: 6 });
    const field = screen.getByRole("textbox", { name: "Concurrency" }) as HTMLInputElement;
    expect(field.value).toBe("6");
    for (const bad of ["0", "17", "2.5", ""]) {
      fireEvent.change(field, { target: { value: bad } });
      await act(async () => void fireEvent.blur(field));
      expect(field.getAttribute("aria-invalid")).toBe("true");
      expect(field.title).toBe("a whole number from 1 to 16");
    }
    expect(m.saveSettings).not.toHaveBeenCalled();
  });

  it("saves the screenshot size", async () => {
    await show();
    await act(async () => void fireEvent.click(screen.getByRole("radio", { name: /^Small/ })));
    expect(m.saveSettings).toHaveBeenCalledWith({ usage: { imageSize: "small" } });
  });
});

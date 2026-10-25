// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DEFAULT_USAGE, type UsageSettings } from "@ue-mcp-studio/shared";

const m = vi.hoisted(() => ({
  settings: vi.fn(),
  saveSettings: vi.fn(),
  instructions: vi.fn(async () => ({ files: [], alwaysTokens: 0, hasAgentsMd: false, recognised: [] })),
  instructionsPreview: vi.fn(async () => ({ agent: "main", text: "", tokens: 0, files: 0, conditional: [] })),
  models: vi.fn(async () => ({
    signedIn: { claude: true },
    providers: [
      { id: "anthropic", name: "Anthropic", connected: false, source: "default", models: [{ id: "claude-opus-5-5", name: "Opus 5.5", signIns: ["claude"] }, { id: "claude-haiku-5-5", name: "Haiku 5.5", signIns: ["claude"] }] },
      { id: "openai", name: "OpenAI", connected: false, source: "default", models: [{ id: "gpt-6", name: "GPT-6", signIns: [] }] },
    ],
  })),
}));
vi.mock("../../api", () => ({ api: m, ApiError: Error }));
import { AgentsSection } from "./AgentsSection";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const settingsWith = (usage: Partial<UsageSettings> = {}) => ({ provider: "anthropic", model: "claude-opus-5-5", effort: "high", route: "claude", connected: {}, usage: { ...DEFAULT_USAGE, ...usage } });

async function show(usage: Partial<UsageSettings> = {}, tab?: string) {
  m.settings.mockResolvedValue(settingsWith(usage));
  m.saveSettings.mockImplementation(async (u: { usage: Partial<UsageSettings> }) => settingsWith({ ...usage, ...u.usage }));
  await act(async () => void render(<AgentsSection onSection={vi.fn()} />));
  if (tab) await act(async () => void fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${tab}`) })));
}

describe("Agents > Main agent", () => {
  it("saves the screenshot size and the instruction files switch", async () => {
    await show();
    await act(async () => void fireEvent.click(screen.getByRole("radio", { name: /^Small/ })));
    expect(m.saveSettings).toHaveBeenCalledWith({ usage: { imageSize: "small" } });
    await act(async () => void fireEvent.click(screen.getByRole("radio", { name: "Read none" })));
    expect(m.saveSettings).toHaveBeenLastCalledWith({ usage: { projectInstructions: false } });
  });
});

describe("Agents > Delegation", () => {
  it("starts with helpers only when asked, and saves another mode", async () => {
    await show({}, "Delegation");
    expect(screen.getByRole("radio", { name: "Only when I ask" }).getAttribute("aria-checked")).toBe("true");
    await act(async () => void fireEvent.click(screen.getByRole("radio", { name: "Never" })));
    expect(m.saveSettings).toHaveBeenCalledWith({ usage: { subagents: "off" } });
  });

  it("offers helper models of the main agent's vendor, and saves one", async () => {
    await show({}, "Delegation");
    const select = screen.getByRole("combobox", { name: "Helper model" }) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["Same as the main agent", "Opus 5.5", "Haiku 5.5"]);
    await act(async () => void fireEvent.change(select, { target: { value: "claude-haiku-5-5" } }));
    expect(m.saveSettings).toHaveBeenCalledWith({ usage: { subagentModel: { provider: "anthropic", model: "claude-haiku-5-5" } } });
  });

  it("disables the helper's choices while delegation is off", async () => {
    await show({ subagents: "off" }, "Delegation");
    expect((screen.getByRole("combobox", { name: "Helper effort" }) as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByRole("combobox", { name: "Helpers per turn" }) as HTMLSelectElement).disabled).toBe(true);
  });
});

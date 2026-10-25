// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DEFAULT_USAGE, type StudioSettings, type UsageSettings } from "@ue-mcp-studio/shared";

const m = vi.hoisted(() => ({
  saveSettings: vi.fn(),
  models: vi.fn(async () => ({
    signedIn: { claude: true },
    providers: [
      { id: "anthropic", name: "Anthropic", connected: false, source: "default", models: [{ id: "claude-opus-5-5", name: "Opus 5.5", signIns: ["claude"] }, { id: "claude-haiku-5-5", name: "Haiku 5.5", signIns: ["claude"] }] },
      { id: "openai", name: "OpenAI", connected: false, source: "default", models: [{ id: "gpt-6", name: "GPT-6", signIns: [] }] },
    ],
  })),
}));
vi.mock("../api", () => ({ api: m, ApiError: Error }));
import { UsageCard } from "./UsageCard";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const settingsWith = (usage: Partial<UsageSettings> = {}) => ({ provider: "anthropic", model: "claude-opus-5-5", connected: {}, usage: { ...DEFAULT_USAGE, ...usage } }) as unknown as StudioSettings;

async function show(usage: Partial<UsageSettings> = {}) {
  const onSettings = vi.fn();
  m.saveSettings.mockImplementation(async (u: { usage: Partial<UsageSettings> }) => settingsWith({ ...usage, ...u.usage }));
  await act(async () => void render(<UsageCard settings={settingsWith(usage)} onSettings={onSettings} onError={vi.fn()} />));
  return onSettings;
}

describe("Settings > Agent > Usage", () => {
  it("starts with subagents only when asked, and saves another mode", async () => {
    const onSettings = await show();
    expect((screen.getByRole("radio", { name: /^When I ask/ }) as HTMLInputElement).checked).toBe(true);
    await act(async () => void fireEvent.click(screen.getByRole("radio", { name: /^Off/ })));
    expect(m.saveSettings).toHaveBeenCalledWith({ usage: { subagents: "off" } });
    expect(onSettings).toHaveBeenCalled();
  });

  it("offers subagent models of the chat model's vendor only", async () => {
    await show();
    const select = screen.getByRole("combobox", { name: "Subagent model" }) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["Same as the chat", "Opus 5.5", "Haiku 5.5"]);
    await act(async () => void fireEvent.change(select, { target: { value: "claude-haiku-5-5" } }));
    expect(m.saveSettings).toHaveBeenCalledWith({ usage: { subagentModel: { provider: "anthropic", model: "claude-haiku-5-5" } } });
  });

  it("disables the subagent choices while subagents are off", async () => {
    await show({ subagents: "off" });
    expect((screen.getByRole("combobox", { name: "Subagent effort" }) as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByRole("combobox", { name: "Subagents per turn" }) as HTMLSelectElement).disabled).toBe(true);
  });

  it("saves a turn token limit, and clears it", async () => {
    await show();
    const input = screen.getByRole("textbox", { name: "Turn token limit" });
    fireEvent.change(input, { target: { value: "250,000" } });
    await act(async () => void fireEvent.blur(input));
    expect(m.saveSettings).toHaveBeenCalledWith({ usage: { turnTokenLimit: 250000 } });
  });

  it("refuses a limit too small to finish a model call", async () => {
    await show();
    const input = screen.getByRole("textbox", { name: "Turn token limit" });
    fireEvent.change(input, { target: { value: "500" } });
    await act(async () => void fireEvent.blur(input));
    expect(m.saveSettings).not.toHaveBeenCalled();
    expect(screen.getByText(/Leave it empty for no limit/)).toBeTruthy();
  });

  it("saves the image size and the CLAUDE.md switch", async () => {
    await show();
    await act(async () => void fireEvent.click(screen.getByRole("radio", { name: /^Small/ })));
    expect(m.saveSettings).toHaveBeenCalledWith({ usage: { imageSize: "small" } });
    await act(async () => void fireEvent.click(screen.getByRole("checkbox", { name: /CLAUDE\.md/ })));
    expect(m.saveSettings).toHaveBeenLastCalledWith({ usage: { projectInstructions: false } });
  });
});

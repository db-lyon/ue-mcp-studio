// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { StudioSettings } from "@ue-mcp-studio/shared";

const m = vi.hoisted(() => ({ saveSettings: vi.fn() }));
vi.mock("../api", () => ({ api: m }));
import { EffortPicker } from "./ModelPicker";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const settings = { provider: "anthropic", model: "claude-opus-5-5", route: "key", effort: "high" } as StudioSettings;

describe("the effort picker", () => {
  it("shows the level and saves a new one", async () => {
    m.saveSettings.mockResolvedValue({ ...settings, effort: "max" });
    const onSettings = vi.fn();
    render(<EffortPicker settings={settings} onSettings={onSettings} />);
    const select = screen.getByLabelText("Effort") as HTMLSelectElement;
    expect(select.value).toBe("high");
    expect([...select.options].map((o) => o.text)).toEqual(["Low", "Medium", "High", "Extra high", "Max"]);
    await act(async () => fireEvent.change(select, { target: { value: "max" } }));
    expect(m.saveSettings).toHaveBeenCalledWith({ effort: "max" });
    expect(onSettings).toHaveBeenCalledWith(expect.objectContaining({ effort: "max" }));
  });
});

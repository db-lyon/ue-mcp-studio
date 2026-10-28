// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { StudioSettings } from "@ue-mcp-studio/shared";

const m = vi.hoisted(() => ({ saveSettings: vi.fn(), models: vi.fn() }));
vi.mock("../api", () => ({ api: m }));
import { BAR_TIERS, BarTierContext, atMost, barTier, type BarTier } from "./barTier";
import { BarButton } from "./Composer";
import { ModelAndEffort } from "../views/ModelPicker";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const settings = { provider: "anthropic", model: "claude-opus-5-5", route: "claude", effort: "high", connected: { anthropic: true } } as unknown as StudioSettings;
const catalog = {
  routeOrder: "signins-first",
  signedIn: { claude: true },
  providers: [{ id: "anthropic", name: "Anthropic", connected: false, models: [{ id: "claude-opus-5-5", name: "Opus 5.5", signIns: ["claude"] }, { id: "claude-sonnet-5-5", name: "Sonnet 5.5", signIns: ["claude"] }] }],
};

describe("the composer bar's tiers", () => {
  it("steps down by the bar's width in ems, and an unmeasured bar is full", () => {
    expect(barTier(0, 13.5)).toBe("full");
    expect(barTier(916, 13.5)).toBe("full");
    expect(barTier(570, 13.5)).toBe("icons");
    expect(barTier(570, 12.5)).toBe("compact");
    expect(barTier(360, 13.5)).toBe("merged");
    expect(barTier(300, 13.5)).toBe("narrowest");
    // A larger font steps down sooner at the same pixel width.
    expect(barTier(600, 12)).toBe("compact");
    expect(barTier(600, 16)).toBe("icons");
    for (const [tier, min] of BAR_TIERS) expect(barTier(min * 10, 10)).toBe(tier);
  });

  it("orders the tiers widest first", () => {
    expect(atMost("icons", "full")).toBe(false);
    expect(atMost("icons", "compact")).toBe(false);
    expect(atMost("icons", "icons")).toBe(true);
    expect(atMost("icons", "narrowest")).toBe(true);
  });

  it("keeps a bar button's name when it becomes an icon", () => {
    const onClick = vi.fn();
    const at = (tier: BarTier) => render(<BarTierContext.Provider value={tier}><BarButton label="Checkpoints" title="Review" icon={<svg />} onClick={onClick} /></BarTierContext.Provider>);
    at("compact");
    expect(screen.getByRole("button", { name: "Checkpoints" }).textContent).toBe("Checkpoints");
    cleanup();
    at("icons");
    const b = screen.getByRole("button", { name: "Checkpoints" });
    expect(b.textContent).toBe("");
    expect(b.getAttribute("title")).toBe("Review");
    fireEvent.click(b);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("the model and effort in the bar", () => {
  it("are two controls while there is room", () => {
    m.models.mockResolvedValue(catalog);
    render(<BarTierContext.Provider value="icons"><ModelAndEffort settings={settings} onSettings={vi.fn()} /></BarTierContext.Provider>);
    expect(screen.getByLabelText("Effort")).toBeTruthy();
  });

  it("merge into one chip whose menu sets both, from the keyboard", async () => {
    m.models.mockResolvedValue(catalog);
    m.saveSettings.mockImplementation(async (s: Partial<StudioSettings>) => ({ ...settings, ...s }));
    const onSettings = vi.fn();
    render(<BarTierContext.Provider value="merged"><ModelAndEffort settings={settings} onSettings={onSettings} /></BarTierContext.Provider>);
    await act(async () => {});
    expect(screen.queryByLabelText("Effort")).toBeNull();
    const chip = screen.getByRole("button", { name: "Model and effort: Opus 5.5, High" });
    expect(chip.textContent).toContain("Opus 5.5 · High");
    await act(async () => fireEvent.click(chip));
    expect(chip.getAttribute("aria-expanded")).toBe("true");

    // The models are a list the arrow keys move through.
    const models = screen.getByRole("listbox", { name: "Model" });
    fireEvent.keyDown(chip, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toContain("Opus 5.5");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toContain("Sonnet 5.5");
    expect(models.contains(document.activeElement)).toBe(true);

    // The effort is a row of choices; Right picks the next one.
    const group = screen.getByRole("radiogroup", { name: "Effort" });
    const high = screen.getByRole("radio", { name: "High" });
    expect(high.getAttribute("aria-checked")).toBe("true");
    await act(async () => fireEvent.keyDown(high, { key: "ArrowRight" }));
    expect(m.saveSettings).toHaveBeenCalledWith({ effort: "xhigh" });
    expect(onSettings).toHaveBeenCalledWith(expect.objectContaining({ effort: "xhigh" }));
    expect(group.contains(document.activeElement)).toBe(true);

    // Escape closes the menu and gives focus back to the chip.
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(document.activeElement).toBe(chip);
  });

  it("leave the effort out when the model has nothing to run it", async () => {
    m.models.mockResolvedValue(catalog);
    render(<BarTierContext.Provider value="narrowest"><ModelAndEffort settings={{ ...settings, route: null } as unknown as StudioSettings} onSettings={vi.fn()} /></BarTierContext.Provider>);
    await act(async () => {});
    const chip = screen.getByTitle("Model");
    expect(chip.textContent).not.toContain("·");
    await act(async () => fireEvent.click(chip));
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });
});

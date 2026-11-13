// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { StudioSettings } from "@ue-mcp-studio/shared";

const m = vi.hoisted(() => ({ saveSettings: vi.fn(), models: vi.fn() }));
vi.mock("../api", () => ({ api: m }));
import { BAR_UTILITIES, foldUtilities, moreLabel, utilityLabel } from "@ue-mcp-studio/client-core";
import { BAR_TIERS, BarTierContext, atMost, barTier, type BarTier } from "./barTier";
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
    expect(barTier(570, 13.5)).toBe("compact");
    expect(barTier(400, 13.5)).toBe("merged");
    expect(barTier(360, 13.5)).toBe("merged");
    expect(barTier(300, 13.5)).toBe("narrowest");
    // A larger font steps down sooner at the same pixel width.
    expect(barTier(500, 12)).toBe("compact");
    expect(barTier(500, 16)).toBe("merged");
    for (const [tier, min] of BAR_TIERS) expect(barTier(min * 10, 10)).toBe(tier);
  });

  it("orders the tiers widest first", () => {
    const order: BarTier[] = ["full", "compact", "merged", "narrowest"];
    expect(order.map((t) => atMost("merged", t))).toEqual([false, false, true, true]);
  });
});

describe("the utilities' fold", () => {
  it("folds only when the measured row is wider than the room its slot and the free space give it", () => {
    expect(foldUtilities(136, 200)).toBe(false);
    expect(foldUtilities(136, 136)).toBe(false);
    expect(foldUtilities(136, 135)).toBe(true);
    // A slot squeezed to nothing with no free space is a row that does not fit.
    expect(foldUtilities(136, 0)).toBe(true);
    // Unmeasured: nothing folds.
    expect(foldUtilities(null, 10)).toBe(false);
    expect(foldUtilities(136, null)).toBe(false);
    expect(foldUtilities(0, 0)).toBe(false);
  });

  it("names every utility and the overflow button for a screen reader", () => {
    expect(BAR_UTILITIES).toEqual(["checkpoints", "subagents", "attach"]);
    expect(BAR_UTILITIES.map((id) => utilityLabel(id, 2))).toEqual(["Checkpoints", "Subagents (2)", "Attach"]);
    expect(moreLabel(0)).toBe("More controls");
    expect(moreLabel(1)).toBe("More controls, 1 subagent");
    expect(moreLabel(3)).toBe("More controls, 3 subagents");
  });
});

describe("the model and effort in the bar", () => {
  it("are two controls while there is room", () => {
    m.models.mockResolvedValue(catalog);
    render(<BarTierContext.Provider value="compact"><ModelAndEffort settings={settings} onSettings={vi.fn()} /></BarTierContext.Provider>);
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

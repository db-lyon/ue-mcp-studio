// @vitest-environment jsdom
/** settings.section: the rail and body with and without contributions, and ext: sections through the hash. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const m = vi.hoisted(() => ({ settings: vi.fn(async () => ({ route: null })) }));
vi.mock("../api", () => ({ api: m, ApiError: Error }));
vi.mock("../views/settings/AgentsSection", () => ({ AgentsSection: () => <div>AgentsSection body</div> }));
vi.mock("../views/settings/ModelsSection", () => ({ ModelsSection: () => <div>ModelsSection body</div> }));
vi.mock("../views/settings/ApprovalsSection", () => ({ ApprovalsSection: () => <div>ApprovalsSection body</div> }));
vi.mock("../views/settings/ProjectSection", () => ({ ProjectSection: () => <div>ProjectSection body</div> }));
vi.mock("../views/settings/GeneralSection", () => ({ GeneralSection: () => <div>GeneralSection body</div> }));
vi.mock("../views/Status", () => ({ StatusView: () => <div>Status</div> }));
vi.mock("../views/Logs", () => ({ LogsView: () => <div>Logs</div> }));
import { SettingsHub } from "../views/SettingsHub";
import { sectionOf } from "../views/settings/sections";
import { formatLocation, parseLocation, readLocation, writeLocation } from "../location";
import { clearSlots, register } from "./registry";
import type { SlotContribution } from "@ue-mcp-studio/extension-api";

const daemon = {} as never;
const section = (id: string, title?: string): SlotContribution<"settings.section"> => ({
  id,
  title,
  mount: (el) => {
    el.textContent = `${id} body`;
    return { unmount: () => {} };
  },
});

beforeEach(() => window.history.replaceState(null, "", "/ui/"));
afterEach(() => {
  cleanup();
  clearSlots();
  vi.clearAllMocks();
});

describe("settings.section", () => {
  it("with nothing registered, the rail and the open section are as they were", async () => {
    const { container } = await act(async () => render(<SettingsHub daemon={daemon} section="general" onSection={vi.fn()} onTheme={vi.fn()} />));
    const before = container.innerHTML;
    expect([...container.querySelectorAll(".cfg-rail-label")].map((e) => e.textContent)).toEqual(["Studio", "Work", "Project"]);
    expect(container.querySelector(".ext-slot")).toBeNull();
    let remove = () => {};
    act(() => void (remove = register("settings.section", section("plan", "Plan"), "pro")));
    expect(container.innerHTML).not.toBe(before);
    act(() => remove());
    expect(container.innerHTML).toBe(before);
  });

  it("lists each contribution under Extensions and opens it as ext:<ext>:<id>", async () => {
    register("settings.section", section("plan", "Plan & usage"), "pro");
    register("settings.section", section("raw"), "pro");
    const onSection = vi.fn();
    const { container, rerender } = await act(async () => render(<SettingsHub daemon={daemon} section="general" onSection={onSection} onTheme={vi.fn()} />));
    const groups = [...container.querySelectorAll(".cfg-rail-group")];
    expect(groups.at(-1)!.querySelector(".cfg-rail-label")!.textContent).toBe("Extensions");
    expect([...groups.at(-1)!.querySelectorAll(".cfg-rail-text > span:first-child")].map((e) => e.textContent)).toEqual(["Plan & usage", "raw"]);
    fireEvent.click(screen.getByText("Plan & usage"));
    expect(onSection).toHaveBeenCalledWith("ext:pro:plan");
    rerender(<SettingsHub daemon={daemon} section="ext:pro:plan" onSection={onSection} onTheme={vi.fn()} />);
    expect(container.querySelector('.cfg-content .ext-slot[data-slot="settings.section"]')!.textContent).toBe("plan body");
    expect(screen.getByText("Plan & usage").closest("button")!.getAttribute("aria-current")).toBe("page");
  });

  it("shows General for a section not registered yet, and the section once it is", async () => {
    const { container } = await act(async () => render(<SettingsHub daemon={daemon} section="ext:pro:plan" onSection={vi.fn()} onTheme={vi.fn()} />));
    expect(screen.getByText("GeneralSection body")).toBeTruthy();
    act(() => void register("settings.section", section("plan"), "pro"));
    expect(container.querySelector(".cfg-content .ext-slot")!.textContent).toBe("plan body");
  });

  it("round-trips ext: sections through the hash", () => {
    expect(sectionOf("ext:pro:plan")).toBe("ext:pro:plan");
    expect(sectionOf("ext:pro")).toBe("general");
    expect(sectionOf("ext:pro:a:b")).toBe("general");
    expect(parseLocation("#/settings/ext:pro:plan")).toEqual({ tab: "Settings", session: null, section: "ext:pro:plan" });
    expect(formatLocation(parseLocation("#/settings/ext:pro:plan"))).toBe("#/settings/ext:pro:plan");
    expect(parseLocation("#/settings/ext:pro:<x>").section).toBeNull();
    expect(parseLocation("#/chat/ext:pro:plan").session).toBeNull();
    writeLocation({ tab: "Settings", section: "ext:studio-pro:usage_1" });
    expect(window.location.hash).toBe("#/settings/ext:studio-pro:usage_1");
    expect(sectionOf(readLocation().section)).toBe("ext:studio-pro:usage_1");
  });
});

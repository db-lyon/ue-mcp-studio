// @vitest-environment jsdom
/** Settings with the Studio plan offered: Remote control is a built-in section under Studio. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

vi.mock("@ue-mcp-studio/shared", async (original) => ({ ...(await original<typeof import("@ue-mcp-studio/shared")>()), STUDIO_PLAN_AVAILABLE: true }));
const m = vi.hoisted(() => ({ settings: vi.fn(async () => ({ route: null })) }));
vi.mock("../api", () => ({ api: m, ApiError: Error }));
vi.mock("./settings/GeneralSection", () => ({ GeneralSection: () => <div>GeneralSection body</div> }));
vi.mock("./settings/RemoteSection", () => ({ RemoteSection: () => <div>RemoteSection body</div> }));
import { SettingsHub } from "./SettingsHub";
import { sectionOf } from "./settings/sections";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Settings with the plan offered", () => {
  it("lists Remote control under Studio, after General, and opens it", async () => {
    await act(async () => void render(<SettingsHub daemon={{} as never} section="remote" onSection={vi.fn()} onTheme={vi.fn()} />));
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect([...nav.querySelectorAll(".cfg-rail-text > span:first-child")].map((e) => e.textContent).slice(0, 2)).toEqual(["General", "Remote control"]);
    expect(screen.getByText("RemoteSection body")).toBeTruthy();
    expect(sectionOf("remote")).toBe("remote");
  });
});

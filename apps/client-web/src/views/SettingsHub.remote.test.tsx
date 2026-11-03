// @vitest-environment jsdom
/** Settings with the Studio plan offered: Remote control is listed for every account, working on a paid plan and a plan note otherwise. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

vi.mock("@ue-mcp-studio/shared", async (original) => ({ ...(await original<typeof import("@ue-mcp-studio/shared")>()), STUDIO_PLAN_AVAILABLE: true }));
const m = vi.hoisted(() => ({ settings: vi.fn(async () => ({ route: null })), remoteAvailable: vi.fn(async () => ({ available: true })) }));
vi.mock("../api", () => ({ api: m, ApiError: Error }));
vi.mock("./settings/GeneralSection", () => ({ GeneralSection: () => <div>GeneralSection body</div> }));
vi.mock("./settings/RemoteSection", async (original) => ({ ...(await original<typeof import("./settings/RemoteSection")>()), RemoteSection: () => <div>RemoteSection body</div> }));
import { SettingsHub } from "./SettingsHub";
import { sectionOf } from "./settings/sections";
import { STUDIO_PLAN_URL } from "@ue-mcp-studio/shared";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Settings with the plan offered", () => {
  it("free account: lists Remote control and shows what it does, that it needs a plan, and one link to the plans; nothing that runs", async () => {
    m.remoteAvailable.mockResolvedValueOnce({ available: false });
    await act(async () => void render(<SettingsHub daemon={{} as never} section="remote" onSection={vi.fn()} onTheme={vi.fn()} />));
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect([...nav.querySelectorAll(".cfg-rail-text > span:first-child")].map((e) => e.textContent).slice(0, 2)).toEqual(["General", "Remote control"]);
    expect(screen.queryByText("RemoteSection body")).toBeNull();
    expect(screen.getByText("Use this project from your phone or another computer.")).toBeTruthy();
    expect(screen.getByText(/^Needs a Pro or Studio plan\./)).toBeTruthy();
    const content = document.querySelector(".cfg-content")!;
    const links = [...content.querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual([STUDIO_PLAN_URL]);
    expect(content.querySelector("[role=switch], img, svg.qr, .remote-qr")).toBeNull();
    expect(content.querySelectorAll("button:not(.cfg-back)").length).toBe(0);
  });

  it("paid account: lists Remote control under Studio, after General, and opens the working section", async () => {
    await act(async () => void render(<SettingsHub daemon={{} as never} section="remote" onSection={vi.fn()} onTheme={vi.fn()} />));
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect([...nav.querySelectorAll(".cfg-rail-text > span:first-child")].map((e) => e.textContent).slice(0, 2)).toEqual(["General", "Remote control"]);
    expect(screen.getByText("RemoteSection body")).toBeTruthy();
    expect(sectionOf("remote")).toBe("remote");
  });
});

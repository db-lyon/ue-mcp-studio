// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const m = vi.hoisted(() => ({ settings: vi.fn(async () => ({ route: null })) }));
vi.mock("../api", () => ({ api: m, ApiError: Error }));
vi.mock("./settings/AgentsSection", () => ({ AgentsSection: () => <div>AgentsSection body</div> }));
vi.mock("./settings/ModelsSection", () => ({ ModelsSection: () => <div>ModelsSection body</div> }));
vi.mock("./settings/ApprovalsSection", () => ({ ApprovalsSection: () => <div>ApprovalsSection body</div> }));
vi.mock("./settings/ProjectSection", () => ({ ProjectSection: () => <div>ProjectSection body</div> }));
vi.mock("./settings/UsageSection", () => ({ UsageSection: () => <div>UsageSection body</div> }));
vi.mock("./settings/GeneralSection", () => ({ GeneralSection: () => <div>GeneralSection body</div> }));
vi.mock("./Status", () => ({ StatusView: () => <div>Status</div> }));
vi.mock("./Logs", () => ({ LogsView: () => <div>Logs</div> }));
import { SettingsHub } from "./SettingsHub";
import { sectionOf } from "./settings/sections";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const daemon = {} as never;

describe("Settings sections", () => {
  it("groups the seven sections under Work and Project and Studio", async () => {
    await act(async () => void render(<SettingsHub daemon={daemon} section="usage" onSection={vi.fn()} onTheme={vi.fn()} />));
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect([...nav.querySelectorAll(".cfg-rail-label")].map((e) => e.textContent)).toEqual(["Work", "Project and Studio"]);
    expect([...nav.querySelectorAll(".cfg-rail-text > span:first-child")].map((e) => e.textContent)).toEqual([
      "Agents", "Models & accounts", "Approvals & review", "Project", "Usage", "General", "Diagnostics",
    ]);
    expect(screen.getByText("UsageSection body")).toBeTruthy();
  });

  it("reports the context strategy in effect, and marks Project when the environment overrides the saved one", async () => {
    const withStrategy = m as unknown as { contextStrategy?: () => Promise<unknown> };
    withStrategy.contextStrategy = vi.fn(async () => ({ strategy: "micro", fromFile: true, envOverride: "full", seeds: {}, seedSource: "" }));
    try {
      await act(async () => void render(<SettingsHub daemon={daemon} section={null} onSection={vi.fn()} onTheme={vi.fn()} narrow />));
      expect(screen.getByLabelText("An environment variable overrides the saved context strategy")).toBeTruthy();
    } finally {
      delete withStrategy.contextStrategy;
    }
  });

  it("names the strategy the environment sets when it matches the saved one", async () => {
    const withStrategy = m as unknown as { contextStrategy?: () => Promise<unknown> };
    withStrategy.contextStrategy = vi.fn(async () => ({ strategy: "full", fromFile: true, envOverride: "full", seeds: {}, seedSource: "" }));
    try {
      await act(async () => void render(<SettingsHub daemon={daemon} section={null} onSection={vi.fn()} onTheme={vi.fn()} narrow />));
      expect(screen.getByText("Full for other clients, set by the environment")).toBeTruthy();
    } finally {
      delete withStrategy.contextStrategy;
    }
  });

  it("marks a section that needs attention", async () => {
    await act(async () => void render(<SettingsHub daemon={daemon} section="agents" onSection={vi.fn()} onTheme={vi.fn()} updates={2} />));
    expect(screen.getByLabelText("Connect a sign-in or an API key")).toBeTruthy();
    expect(screen.getByLabelText("2 updates available")).toBeTruthy();
  });

  it("narrow: starts on the list, and a section opens with Back", async () => {
    const onSection = vi.fn();
    const { container, rerender } = render(<SettingsHub daemon={daemon} section={null} onSection={onSection} onTheme={vi.fn()} narrow />);
    await act(async () => undefined);
    expect(container.querySelector(".cfg")!.classList.contains("has-section")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /^Approvals & review/ }));
    expect(onSection).toHaveBeenCalledWith("approvals");
    rerender(<SettingsHub daemon={daemon} section="approvals" onSection={onSection} onTheme={vi.fn()} narrow />);
    fireEvent.click(screen.getByRole("button", { name: /All settings$/ }));
    expect(onSection).toHaveBeenLastCalledWith(null);
  });

  it("maps the old section names in links and hashes", () => {
    expect(sectionOf("agent")).toBe("agents");
    expect(sectionOf("account")).toBe("models");
    expect(sectionOf("usage")).toBe("usage");
    expect(sectionOf("nowhere")).toBeNull();
  });
});

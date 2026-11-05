// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const m = vi.hoisted(() => ({ settings: vi.fn(async () => ({ route: null })) }));
vi.mock("../api", () => ({ api: m, ApiError: Error }));
vi.mock("./settings/AgentsSection", () => ({ AgentsSection: () => <div>AgentsSection body</div> }));
vi.mock("./settings/ModelsSection", () => ({ ModelsSection: () => <div>ModelsSection body</div> }));
vi.mock("./settings/ApprovalsSection", () => ({ ApprovalsSection: () => <div>ApprovalsSection body</div> }));
vi.mock("./settings/ProjectSection", () => ({ ProjectSection: () => <div>ProjectSection body</div> }));
vi.mock("./settings/GeneralSection", () => ({ GeneralSection: () => <div>GeneralSection body</div> }));
vi.mock("./settings/RemoteSection", () => ({ RemoteSection: ({ onUnavailable }: { onUnavailable?: () => void }) => <button onClick={onUnavailable}>RemoteSection body</button> }));
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
  it("puts General first, then groups the rest under Work and Project", async () => {
    await act(async () => void render(<SettingsHub daemon={daemon} section="project" onSection={vi.fn()} onTheme={vi.fn()} />));
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect([...nav.querySelectorAll(".cfg-rail-label")].map((e) => e.textContent)).toEqual(["Studio", "Work", "Project"]);
    expect([...nav.querySelectorAll(".cfg-rail-text > span:first-child")].map((e) => e.textContent)).toEqual([
      "General", "Notifications", "Agents", "Models & accounts", "Approvals & review", "Project", "Diagnostics",
    ]);
    expect(screen.getByText("ProjectSection body")).toBeTruthy();
  });

  it("keeps Remote control out of Settings while STUDIO_PLAN_AVAILABLE is off and the agent does not offer it, its name opening General", async () => {
    await act(async () => void render(<SettingsHub daemon={daemon} section="remote" onSection={vi.fn()} onTheme={vi.fn()} />));
    expect(screen.queryByText("Remote control")).toBeNull();
    expect(screen.getByText("GeneralSection body")).toBeTruthy();
    expect(sectionOf("remote")).toBe("remote");
  });

  describe("Remote control on a paid plan, with STUDIO_PLAN_AVAILABLE off", () => {
    const withRemote = m as unknown as { remoteAvailable?: ReturnType<typeof vi.fn> };
    afterEach(() => void delete withRemote.remoteAvailable);

    it("lists it under Studio and opens it when the agent offers it, asking afresh on open", async () => {
      withRemote.remoteAvailable = vi.fn(async () => ({ available: true }));
      await act(async () => void render(<SettingsHub daemon={daemon} section="remote" onSection={vi.fn()} onTheme={vi.fn()} />));
      expect(withRemote.remoteAvailable).toHaveBeenCalledWith(true);
      const nav = screen.getByRole("navigation", { name: "Settings sections" });
      expect([...nav.querySelectorAll(".cfg-rail-text > span:first-child")].map((e) => e.textContent).slice(0, 3)).toEqual(["General", "Notifications", "Remote control"]);
      expect(screen.getByText("RemoteSection body")).toBeTruthy();
    });

    it.each([
      ["a free or lapsed account", () => Promise.resolve({ available: false })],
      ["an error", () => Promise.reject(Object.assign(new Error("gateway"), { status: 502 }))],
    ])("leaves it out silently for %s", async (_name, answer) => {
      withRemote.remoteAvailable = vi.fn(answer);
      await act(async () => void render(<SettingsHub daemon={daemon} section="remote" onSection={vi.fn()} onTheme={vi.fn()} />));
      expect(screen.queryByText("Remote control")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByText("GeneralSection body")).toBeTruthy();
    });

    it("drops the section when it says the agent stopped offering it", async () => {
      withRemote.remoteAvailable = vi.fn(async () => ({ available: true }));
      await act(async () => void render(<SettingsHub daemon={daemon} section="remote" onSection={vi.fn()} onTheme={vi.fn()} />));
      withRemote.remoteAvailable.mockResolvedValue({ available: false });
      await act(async () => void fireEvent.click(screen.getByText("RemoteSection body")));
      expect(withRemote.remoteAvailable).toHaveBeenCalledTimes(2);
      expect(screen.queryByText("Remote control")).toBeNull();
      expect(screen.getByText("GeneralSection body")).toBeTruthy();
    });
  });

  it("reports the context strategy in effect, and marks Project when the environment overrides the saved one", async () => {
    const withStrategy = m as unknown as { contextStrategy?: () => Promise<unknown> };
    withStrategy.contextStrategy = vi.fn(async () => ({ strategy: "micro", fromFile: true, envOverride: "full", seeds: {} }));
    try {
      await act(async () => void render(<SettingsHub daemon={daemon} section={null} onSection={vi.fn()} onTheme={vi.fn()} narrow />));
      expect(screen.getByLabelText("Context strategy overridden by environment")).toBeTruthy();
    } finally {
      delete withStrategy.contextStrategy;
    }
  });

  it("names the strategy the environment sets when it matches the saved one", async () => {
    const withStrategy = m as unknown as { contextStrategy?: () => Promise<unknown> };
    withStrategy.contextStrategy = vi.fn(async () => ({ strategy: "full", fromFile: true, envOverride: "full", seeds: {} }));
    try {
      await act(async () => void render(<SettingsHub daemon={daemon} section={null} onSection={vi.fn()} onTheme={vi.fn()} narrow />));
      expect(screen.getByText("Full, from environment")).toBeTruthy();
    } finally {
      delete withStrategy.contextStrategy;
    }
  });

  it("marks a section that needs attention", async () => {
    await act(async () => void render(<SettingsHub daemon={daemon} section="agents" onSection={vi.fn()} onTheme={vi.fn()} updates={2} />));
    expect(screen.getByLabelText("Nothing connected")).toBeTruthy();
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
    expect(sectionOf("usage")).toBe("agents");
    expect(sectionOf("nowhere")).toBe("general");
  });
});

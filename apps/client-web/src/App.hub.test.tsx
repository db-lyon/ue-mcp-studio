// @vitest-environment jsdom
// The Playtest Hub's gate: with the experiment off Studio is as it was, with it on the Playtests tab shows the hub.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { hubFixture } from "./views/hub/test-data";

const m = vi.hoisted(() => ({
  settings: vi.fn(),
  sessions: vi.fn(),
  qaPlaytests: vi.fn(),
  hub: { overview: vi.fn() },
}));
vi.mock("./api", () => {
  const pending = () => new Promise(() => {});
  const api = new Proxy(m as Record<string, unknown>, { get: (t, k: string) => t[k] ?? pending });
  return { api, ApiError: class extends Error {} };
});
vi.mock("./state", () => ({ useDaemon: () => ({ events: [], health: null, streaming: true, error: null, refresh: () => {} }) }));
vi.mock("./views/SettingsHub", () => ({ SettingsHub: () => <div>Settings view</div> }));
vi.mock("./views/EditorBanner", () => ({ EditorBanner: () => null }));
vi.mock("./views/DialogBanner", () => ({ DialogBanner: () => null }));
vi.mock("./views/UpdateOverlay", () => ({ UpdateRunner: () => null }));
import { App } from "./App";
import { announceExperiments } from "./views/hub/state";

function layout(narrow: boolean) {
  window.matchMedia = ((query: string) => ({ matches: narrow, media: query, addEventListener: () => {}, removeEventListener: () => {} })) as never;
}

beforeEach(() => {
  layout(false);
  m.sessions.mockResolvedValue({ sessions: [] });
  m.qaPlaytests.mockResolvedValue({ playtests: [], listed: true, more: false });
  m.hub.overview.mockResolvedValue(hubFixture());
  window.location.hash = "#/settings/general";
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.location.hash = "";
});

const tabs = () => screen.getAllByRole("button").filter((b) => b.classList.contains("tab")).map((b) => b.firstChild?.textContent);

describe("the Playtest Hub gate", () => {
  it("off: no Playtests tab and no hub reads, as before", async () => {
    m.settings.mockResolvedValue({ theme: "ue-mcp", experiments: { playtestHub: false } });
    render(<App />);
    await waitFor(() => expect(m.settings).toHaveBeenCalled());
    expect(tabs()).toEqual(["Chat", "Plugins", "Settings"]);
    expect(m.hub.overview).not.toHaveBeenCalled();
  });

  it("on: the tab shows with the count of what needs attention and opens the hub", async () => {
    m.settings.mockResolvedValue({ theme: "ue-mcp", experiments: { playtestHub: true } });
    render(<App />);
    const tab = await screen.findByRole("button", { name: /Playtests/ });
    expect(tabs()).toEqual(["Chat", "Playtests", "Plugins", "Settings"]);
    await waitFor(() => expect(tab.querySelector(".tab-count")?.textContent).toBe("2"));
    fireEvent.click(tab);
    expect(await screen.findByRole("heading", { level: 1, name: "Overview" })).toBeTruthy();
    expect(window.location.hash).toBe("#/playtests");
  });

  it("follows the Settings switch without a reload", async () => {
    m.settings.mockResolvedValue({ theme: "ue-mcp", experiments: { playtestHub: false } });
    render(<App />);
    await waitFor(() => expect(m.settings).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /Playtests/ })).toBeNull();
    act(() => announceExperiments({ playtestHub: true }));
    expect(await screen.findByRole("button", { name: /Playtests/ })).toBeTruthy();
  });

  it("opens a hub link straight on its screen", async () => {
    m.settings.mockResolvedValue({ theme: "ue-mcp", experiments: { playtestHub: true } });
    window.location.hash = "#/playtests/goals/movement";
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Movement feels right" })).toBeTruthy();
  });
});

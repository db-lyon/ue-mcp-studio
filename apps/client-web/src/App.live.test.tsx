// @vitest-environment jsdom
// The bar's Live button: on a paired browser while Play In Editor runs, on every tab, opening the viewer over the tab; never on the computer.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ViewportStatus } from "@ue-mcp-studio/shared";

const status = (s: Partial<ViewportStatus> = {}): ViewportStatus => ({ access: "ok", editor: "ready", streamer: false, source: null, viewers: 0, pie: true, ...s });

const m = vi.hoisted(() => ({
  settings: vi.fn(),
  sessions: vi.fn(),
  qaPlaytests: vi.fn(),
  viewport: vi.fn(),
  about: vi.fn(),
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

const onRemote = (remote: boolean) => ((window as unknown as { __studioRemotePage?: boolean }).__studioRemotePage = remote);

function layout(narrow: boolean) {
  window.matchMedia = ((query: string) => ({ matches: narrow, media: query, addEventListener: () => {}, removeEventListener: () => {} })) as never;
}

const live = () => screen.queryByRole("button", { name: "Watch Play In Editor live" });

beforeEach(() => {
  layout(false);
  m.settings.mockResolvedValue({ theme: "ue-mcp", experiments: { playtestHub: false } });
  m.sessions.mockResolvedValue({ sessions: [] });
  m.qaPlaytests.mockResolvedValue({ playtests: [], listed: true, more: false });
  m.about.mockResolvedValue({ name: "Lantern" });
  m.viewport.mockResolvedValue(status());
  window.location.hash = "#/settings/general";
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  onRemote(false);
  window.location.hash = "";
});

describe("the bar's Live button", () => {
  it("on a paired browser: shows left of Feedback while PIE runs, and opens the viewer over the tab", async () => {
    onRemote(true);
    render(<App />);
    const button = await waitFor(() => {
      const b = live();
      expect(b).not.toBeNull();
      return b!;
    });
    expect(button.textContent).toBe("Live");
    expect(button.nextElementSibling?.textContent).toBe("Feedback");
    fireEvent.click(button);
    const dialog = await screen.findByRole("dialog", { name: "Play In Editor" });
    expect(screen.getByText("Settings view")).toBeTruthy();
    fireEvent.click(within(dialog).getByText("Close"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Settings view")).toBeTruthy();
    expect(window.location.hash).toBe("#/settings/general");
  });

  it("on a paired browser: hidden while PIE is not running", async () => {
    onRemote(true);
    m.viewport.mockResolvedValue(status({ pie: false }));
    render(<App />);
    await waitFor(() => expect(m.viewport).toHaveBeenCalled());
    await screen.findByText("Settings view");
    expect(live()).toBeNull();
  });

  it("narrow: in the bar itself, not the drawer", async () => {
    onRemote(true);
    layout(true);
    render(<App />);
    await waitFor(() => expect(live()).not.toBeNull());
    expect(live()!.closest("header")).not.toBeNull();
  });

  it("on the computer: no Live button, and no viewport status asked", async () => {
    render(<App />);
    await screen.findByText("Settings view");
    await waitFor(() => expect(m.settings).toHaveBeenCalled());
    expect(live()).toBeNull();
    expect(screen.queryByText("Live")).toBeNull();
    expect(m.viewport).not.toHaveBeenCalled();
  });
});

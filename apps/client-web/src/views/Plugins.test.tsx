// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const m = vi.hoisted(() => ({
  plugins: vi.fn(),
  pluginCatalog: vi.fn(),
  installPlugin: vi.fn(),
  updatePlugin: vi.fn(),
  uninstallPlugin: vi.fn(),
  shutdownDaemon: vi.fn(),
}));
vi.mock("../api", async () => {
  class ApiError extends Error {
    constructor(readonly status: number, message: string) {
      super(message);
    }
  }
  return { api: m, ApiError };
});
import { ApiError } from "../api";
import { PluginsView, isInstalled, searchCatalog } from "./Plugins";

const daemon = { events: [], health: null, streaming: true, error: null } as never;
const catalog = [
  { slug: "pie-studio", name: "PIE Studio", packageName: "pie-studio", tagline: "Record and replay PIE", category: "gameplay", readme: "# pie-studio\nRecords PIE." },
  { slug: "meshy", name: "Meshy", packageName: "ue-mcp-meshy", tagline: "Generate meshes", tags: ["ai"] },
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("plugin helpers", () => {
  it("searches name, tagline, category and tags", () => {
    expect(searchCatalog(catalog, "replay").map((c) => c.slug)).toEqual(["pie-studio"]);
    expect(searchCatalog(catalog, "AI").map((c) => c.slug)).toEqual(["meshy"]);
    expect(searchCatalog(catalog, " ")).toHaveLength(2);
  });

  it("matches an installed plugin by slug or package name", () => {
    expect(isInstalled(catalog[1], [{ name: "ue-mcp-meshy", version: "1.0.0", pinned: null, status: "ok", categories: [], problems: [] }])).toBeTruthy();
    expect(isInstalled(catalog[0], [])).toBeUndefined();
  });
});

describe("the Plugins tab", () => {
  it("lists installed plugins and installs one from the catalog, then offers to apply", async () => {
    m.plugins.mockResolvedValue({ plugins: [{ name: "ue-mcp-meshy", version: "1.0.0", pinned: null, status: "ok", categories: ["meshy"], problems: [] }] });
    m.pluginCatalog.mockResolvedValue({ plugins: catalog });
    m.installPlugin.mockResolvedValue({ ok: true, exitCode: 0, output: "installed pie-studio", restartRequired: true });
    render(<PluginsView daemon={daemon} />);
    await waitFor(() => expect(screen.getByText("ue-mcp-meshy")).toBeTruthy());
    expect(screen.getByText("installed")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Install" })));
    expect(m.installPlugin).toHaveBeenCalledWith("pie-studio");
    await waitFor(() => expect(screen.getByText(/Plugin changes load when ue-mcp restarts/)).toBeTruthy());
    expect(screen.getByText("Install PIE Studio: done")).toBeTruthy();
  });

  it("shows a failed install's output", async () => {
    m.plugins.mockResolvedValue({ plugins: [] });
    m.pluginCatalog.mockResolvedValue({ plugins: catalog });
    m.installPlugin.mockResolvedValue({ ok: false, exitCode: 1, output: "npm ERR! 404", restartRequired: false });
    render(<PluginsView daemon={daemon} />);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Install" })).toHaveLength(2));
    await act(async () => fireEvent.click(screen.getAllByRole("button", { name: "Install" })[0]));
    await waitFor(() => expect(screen.getByText("npm ERR! 404")).toBeTruthy());
    expect(screen.queryByText(/Plugin changes load/)).toBeNull();
  });

  it("removes only on the second click", async () => {
    m.plugins.mockResolvedValue({ plugins: [{ name: "pie-studio", version: "0.6.3", pinned: null, status: "ok", categories: [], problems: [] }] });
    m.pluginCatalog.mockResolvedValue({ plugins: [] });
    m.uninstallPlugin.mockResolvedValue({ ok: true, exitCode: 0, output: "removed", restartRequired: true });
    render(<PluginsView daemon={daemon} />);
    await waitFor(() => expect(screen.getByText("pie-studio")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(m.uninstallPlugin).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Remove for good" })));
    expect(m.uninstallPlugin).toHaveBeenCalledWith("pie-studio");
  });

  it("opens a plugin's details with its readme", async () => {
    m.plugins.mockResolvedValue({ plugins: [] });
    m.pluginCatalog.mockResolvedValue({ plugins: catalog });
    render(<PluginsView daemon={daemon} />);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Details" })).toHaveLength(2));
    fireEvent.click(screen.getAllByRole("button", { name: "Details" })[0]);
    expect(screen.getByText("Records PIE.")).toBeTruthy();
  });

  it("says which ue-mcp it needs when the daemon has no plugin routes", async () => {
    m.plugins.mockRejectedValue(new ApiError(404, "Not Found"));
    m.pluginCatalog.mockRejectedValue(new ApiError(404, "Not Found"));
    render(<PluginsView daemon={daemon} />);
    await waitFor(() => expect(screen.getByText(/needs ue-mcp 1.4.0-beta.2 or later/)).toBeTruthy());
  });
});

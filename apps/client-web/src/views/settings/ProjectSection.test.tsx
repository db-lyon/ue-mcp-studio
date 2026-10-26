// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const ctx = (over: Record<string, unknown> = {}) => ({ strategy: "micro", fromFile: false, envOverride: null, seeds: { micro: 2200, lean: 19000, full: 51000 }, seedSource: "published figures", ...over });
const m = vi.hoisted(() => ({
  install: vi.fn(),
  contextStrategy: vi.fn(),
  saveContextStrategy: vi.fn(),
  config: vi.fn(async () => ({ path: "ue-mcp.yml", exists: true, text: "" })),
}));
vi.mock("../../api", () => ({ api: m, ApiError: Error }));
vi.mock("../../native", () => ({ inEditor: () => false, native: () => ({}) }));
import { ProjectSection } from "./ProjectSection";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const report = {
  ok: true,
  problems: [],
  project: { engine: "5.7" },
  plugin: { deployed: true, installedVersion: "1.4.11", installKind: "source", packagedVersion: "1.4.11", enabledInUproject: true, pluginDir: "Plugins/UE_MCP_Bridge" },
  toolchain: { present: true, name: "MSVC" },
  node: { version: "v22" },
  clients: [{ id: "claude-code", name: "Claude Code", detected: true, configured: true, pinned: null }, { id: "gemini", name: "Gemini CLI", detected: true, configured: false, pinned: null }],
};

async function show(c = ctx()) {
  m.install.mockResolvedValue(report);
  m.contextStrategy.mockResolvedValue(c);
  await act(async () => void render(<ProjectSection onSection={vi.fn()} />));
}

describe("Project > context strategy for other clients", () => {
  it("works outside the editor, with each strategy's cost and the clients it affects", async () => {
    await show();
    expect((screen.getByRole("radio", { name: /^Micro/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("~19k tokens")).toBeTruthy();
    expect(screen.getByText(/Used by Claude Code./)).toBeTruthy();
    // ue-mcp.yml serves every client: the shared badge says so.
    expect(screen.queryByText("Shared with other clients")).toBeNull();
  });

  it("saves a strategy and says when clients get it", async () => {
    await show();
    m.saveContextStrategy.mockResolvedValue(ctx({ strategy: "lean", fromFile: true, restarting: true }));
    await act(async () => void fireEvent.click(screen.getByRole("radio", { name: /^Lean/ })));
    expect(m.saveContextStrategy).toHaveBeenCalledWith("lean");
    expect(screen.getByText(/Saved to ue-mcp.yml. ue-mcp restarts after the current turn./)).toBeTruthy();
  });

  it("says when the environment overrides the file", async () => {
    await show(ctx({ envOverride: "full" }));
    expect(screen.getByText("UE_MCP_CONTEXT_STRATEGY=full")).toBeTruthy();
    expect(screen.getByText(/overrides this. A choice here applies once it is unset./)).toBeTruthy();
    // The strategy in effect and the saved one are both named.
    expect(screen.getByText("in effect, from environment")).toBeTruthy();
    // The radio is the file's value, which a click changes; the environment's is marked, not selected.
    expect((screen.getByRole("radio", { name: /^Micro/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("radio", { name: /^Full/ }) as HTMLInputElement).checked).toBe(false);
  });
});

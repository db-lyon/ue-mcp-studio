// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const ctx = (over: Record<string, unknown> = {}) => ({ strategy: "micro", fromFile: false, envOverride: null, seeds: { micro: 2200, lean: 19000, full: 51000 }, ...over });
const m = vi.hoisted(() => ({
  install: vi.fn(),
  contextStrategy: vi.fn(),
  saveContextStrategy: vi.fn(),
  editor: vi.fn(),
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

async function show(c = ctx(), r: Record<string, unknown> = report, onSection = vi.fn()) {
  m.install.mockResolvedValue(r);
  m.contextStrategy.mockResolvedValue(c);
  await act(async () => void render(<ProjectSection onSection={onSection} />));
}

describe("Project > context strategy", () => {
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

// What ue-mcp sends: written for an agent, with tool call syntax in it.
const staleProblem = {
  code: "bridge_build_stale",
  what: "The compiled plugin is older than its source, so handlers added since the last build answer 'Unknown method'.",
  fix: "Rebuild with the editor STOPPED: project(action='build').",
};
const stale = (pendingBuild: unknown = null) => ({ ...report, ok: false, problems: [staleProblem], plugin: { ...report.plugin, pendingBuild } });
const step = (name: string, ok: boolean, extra: Record<string, unknown> = {}) => ({ step: name, ok, result: "{}", ...extra });
const TOOL_CALL = /\w+\(action=|project\(|editor\(/;

async function confirmRebuild() {
  await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Rebuild" })));
  await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Close the editor and rebuild" })));
}

describe("Project > a bridge that needs a rebuild", () => {
  it("says so plainly, with no tool call syntax, and offers Rebuild", async () => {
    await show(ctx(), stale());
    expect(screen.getByText("The bridge plugin needs a rebuild.")).toBeTruthy();
    expect(screen.getByText(/Its source is newer than its last build, so the editor still runs the previous build. Features added since then do not work until it is rebuilt./)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(TOOL_CALL);
    expect(document.body.textContent).not.toContain("STOPPED");
    expect(screen.getByRole("button", { name: "Rebuild" })).toBeTruthy();
  });

  it("names an update that installed new source while the editor was open", async () => {
    await show(ctx(), stale({ version: "1.4.11-beta.9", at: "2026-10-27T10:00:00Z", reason: "editor running" }));
    expect(screen.getByText(/ue-mcp updated the bridge to 1.4.11-beta.9 while the editor was open, and the editor still runs the previous build./)).toBeTruthy();
  });

  it("asks before closing the editor, and Cancel closes nothing", async () => {
    await show(ctx(), stale());
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Rebuild" })));
    expect(screen.getByText(/Rebuild closes the editor, builds the bridge plugin, and opens the editor again./)).toBeTruthy();
    expect(m.editor).not.toHaveBeenCalled();
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Cancel" })));
    expect(m.editor).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Rebuild" })).toBeTruthy();
  });

  it("stops, builds and starts through the daemon's rebuild, then checks again", async () => {
    await show(ctx(), stale());
    m.editor.mockResolvedValue({ op: "rebuild", steps: [step("editor.stop_editor", true), step("project.build", true), step("editor.start_editor", true)] });
    m.install.mockClear();
    m.install.mockResolvedValue(report);
    await confirmRebuild();
    expect(m.editor.mock.calls).toEqual([["rebuild"]]);
    expect(screen.getByRole("status").textContent).toBe("The bridge plugin is rebuilt and the editor is open again.");
    expect(m.install).toHaveBeenCalled();
  });

  it("shows a failed build's error and opens the editor again on the previous build", async () => {
    await show(ctx(), stale());
    m.editor
      .mockResolvedValueOnce({
        op: "rebuild",
        steps: [
          step("editor.stop_editor", true),
          step("project.build", false, {
            reason: "Build failed with exit code 6 (Result: Failed (OtherCompilationError)). First errors: Foo.cpp(12,3): error C2065: 'Bar': undeclared identifier. Stop it with editor(action='stop_editor'), then build again.",
          }),
        ],
      })
      .mockResolvedValueOnce({ op: "start", steps: [step("editor.start_editor", true)] });
    await confirmRebuild();
    expect(m.editor.mock.calls).toEqual([["rebuild"], ["start"]]);
    const alert = screen.getByRole("alert").textContent ?? "";
    expect(alert).toContain("The build failed. The editor opened again on the previous build.");
    expect(alert).toContain("error C2065: 'Bar': undeclared identifier");
    expect(alert).not.toMatch(TOOL_CALL);
  });

  it("reads a failed build from the step's result on a daemon without reason", async () => {
    await show(ctx(), stale());
    m.editor
      .mockResolvedValueOnce({ op: "rebuild", steps: [step("editor.stop_editor", true), step("project.build", false, { result: JSON.stringify({ success: false, message: "Build failed with exit code 3." }) })] })
      .mockResolvedValueOnce({ op: "start", steps: [step("editor.start_editor", false, { reason: "Editor launched but did not become ready" })] });
    await confirmRebuild();
    const alert = screen.getByRole("alert").textContent ?? "";
    expect(alert).toContain("Build failed with exit code 3.");
    expect(alert).toContain("The editor did not open again. Open the project in Unreal to keep working on the previous build.");
  });

  it("builds nothing and starts nothing when the editor does not close", async () => {
    await show(ctx(), stale());
    m.editor.mockResolvedValue({ op: "rebuild", steps: [step("editor.stop_editor", false, { reason: "Unsaved packages: /Game/Map. Save them with editor(save_dirty)." })] });
    await confirmRebuild();
    expect(m.editor).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toBe("The editor did not close, so nothing was built. Save your work and close any open dialogs in the editor, then try again.");
  });
});

describe("Project > install problems", () => {
  // Each as ue-mcp reports it, with its agent-facing fix.
  const problems = [
    { code: "no_engine", what: "No Unreal install could be resolved for EngineAssociation '5.7'.", fix: "Install the engine version this project names, or point at it with editor.buildToolPath in ue-mcp.yml." },
    { code: "no_toolchain", what: "No C++ toolchain was found on this machine.", fix: "Install the C++ toolchain Unreal uses on this platform." },
    { code: "bridge_not_deployed", what: "The bridge plugin is not in Game/Plugins/UE_MCP_Bridge/.", fix: "Run 'npx ue-mcp init C:/Game/Game.uproject' to copy the plugin source in." },
    { code: "bridge_not_enabled", what: "The plugin is on disk but the .uproject does not enable it.", fix: "Run 'npx ue-mcp deploy C:/Game/Game.uproject'." },
    { code: "bridge_version_mismatch", what: "The installed plugin is v1.4.10 and this package ships v1.4.11.", fix: "Run 'npx ue-mcp update C:/Game/Game.uproject' to fetch matching binaries." },
    { code: "bridge_never_compiled", what: "The plugin source is deployed and has never been compiled.", fix: "Build it with the editor STOPPED: project(action='build'), or open the project in Unreal and accept its rebuild prompt." },
  ];

  it("never shows ue-mcp's agent-facing fixes", async () => {
    await show(ctx(), { ...report, ok: false, project: { engine: "5.7", engineAssociation: "5.7" }, problems });
    const text = document.body.textContent ?? "";
    for (const p of problems) expect(text).not.toContain(p.fix);
    expect(text).not.toMatch(TOOL_CALL);
    expect(screen.getByText("Unreal Engine was not found.")).toBeTruthy();
    expect(screen.getByText("No C++ compiler was found.")).toBeTruthy();
    expect(screen.getByText("The bridge plugin is not in this project.")).toBeTruthy();
    expect(screen.getByText("The bridge plugin is not enabled.")).toBeTruthy();
    expect(screen.getByText("The bridge plugin needs to be built.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rebuild" })).toBeTruthy();
  });

  it("sends a version mismatch to Updates", async () => {
    const onSection = vi.fn();
    await show(ctx(), { ...report, ok: false, plugin: { ...report.plugin, installedVersion: "1.4.10" }, problems: [problems[4]] }, onSection);
    expect(screen.getByText(/The project has bridge 1.4.10 and ue-mcp is 1.4.11. Update it from Updates./)).toBeTruthy();
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Open Updates" })));
    expect(onSection).toHaveBeenCalledWith("general");
  });

  it("shows only ue-mcp's description for a problem it does not know yet", async () => {
    await show(ctx(), { ...report, ok: false, problems: [{ code: "bridge_from_the_future", what: "Something new is wrong.", fix: "Call project(action='fix_it')." }] });
    expect(screen.getByText("Something new is wrong.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("fix_it");
  });
});

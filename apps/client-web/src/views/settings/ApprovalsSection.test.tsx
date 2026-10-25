// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const base = {
  askBeforeChanges: true,
  approvals: { shell: "ask", files: "ask", editorRestart: "allow", destructive: "allow" },
  destructiveKnown: true,
  dialogPolicy: { kind: "wait" },
  reviewTurns: true,
};
const m = vi.hoisted(() => ({
  settings: vi.fn(),
  saveSettings: vi.fn(),
  agentSettings: vi.fn(),
  saveAgentSettings: vi.fn(),
}));
vi.mock("../../api", () => ({ api: m, ApiError: Error }));
import { ApprovalsSection } from "./ApprovalsSection";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const agent = (over: Record<string, unknown> = {}) => ({ feedbackTool: true, feedbackMode: { mode: "interactive", project: true }, dialogMode: { mode: "interactive", project: true }, playtestRuns: "manual", ...over });

async function show(settings: Record<string, unknown> = {}, a: Record<string, unknown> = {}) {
  m.settings.mockResolvedValue({ ...base, ...settings });
  m.agentSettings.mockResolvedValue(agent(a));
  m.saveSettings.mockImplementation(async (u: Record<string, unknown>) => ({ ...base, ...settings, ...u, approvals: { ...base.approvals, ...((u.approvals as object) ?? {}) } }));
  m.saveAgentSettings.mockImplementation(async (u: Record<string, unknown>) => agent({ ...a, ...u }));
  await act(async () => void render(<ApprovalsSection />));
}

const checked = (group: string, name: string) => screen.getByRole("radiogroup", { name: group }).querySelector(`[aria-checked="true"]`)?.textContent === name;

describe("Approvals & review: before it acts", () => {
  it("shows a row per kind with its rule, and saves one row on its own", async () => {
    await show();
    expect(checked("Shell commands", "Ask")).toBe(true);
    expect(checked("Restart or rebuild the editor", "Allow")).toBe(true);
    const restart = screen.getByRole("radiogroup", { name: "Restart or rebuild the editor" });
    await act(async () => void fireEvent.click(restart.querySelector("button")!));
    expect(m.saveSettings).toHaveBeenCalledWith({ approvals: { editorRestart: "ask" } });
    expect(checked("Restart or rebuild the editor", "Ask")).toBe(true);
  });

  it("says why the destructive row cannot ask when ue-mcp does not report its actions", async () => {
    await show({ destructiveKnown: false });
    expect(screen.getByText(/does not say which actions delete or overwrite/)).toBeTruthy();
    for (const b of screen.getByRole("radiogroup", { name: "ue-mcp actions that delete or overwrite" }).querySelectorAll("button")) expect((b as HTMLButtonElement).disabled).toBe(true);
  });

  it("starts playtests Manual by default, saves Automatic, and says to update an older Studio", async () => {
    await show();
    expect(checked("Starting playtests", "Manual")).toBe(true);
    expect(screen.getByText("A playtest runs only when you start it, or assign it to a helper, from its card.")).toBeTruthy();
    await act(async () => void fireEvent.click(screen.getByRole("radio", { name: "Automatic" })));
    expect(m.saveAgentSettings).toHaveBeenCalledWith({ playtestRuns: "automatic" });
    cleanup();
    await show({}, { playtestRuns: undefined });
    expect(screen.getByText("Update Studio to choose this.")).toBeTruthy();
  });
});

describe("Approvals & review: shared settings", () => {
  it("marks what ue-mcp keeps for every client", async () => {
    await show();
    expect(screen.getAllByText("Shared with other clients").length).toBe(3);
  });

  it("saves who answers dialogs and the feedback mode", async () => {
    await show();
    await act(async () => void fireEvent.click(screen.getByRole("radio", { name: /Let the agent answer/ })));
    expect(m.saveAgentSettings).toHaveBeenCalledWith({ dialogMode: "auto" });
    await act(async () => void fireEvent.click(screen.getByRole("radio", { name: "Keep for review" })));
    expect(m.saveAgentSettings).toHaveBeenLastCalledWith({ feedbackMode: "defer" });
  });

  it("says ue-mcp restarts when the feedback tool changes", async () => {
    await show();
    m.saveAgentSettings.mockResolvedValueOnce({ ...agent({ feedbackTool: false }), restarting: true });
    await act(async () => void fireEvent.click(screen.getByRole("switch", { name: "Agents can report gaps in ue-mcp's tools" })));
    expect(m.saveAgentSettings).toHaveBeenCalledWith({ feedbackTool: false });
    expect(screen.getByText(/ue-mcp restarts to load it/)).toBeTruthy();
  });
});

describe("Approvals & review: after it acts", () => {
  it("reviews each turn by default and saves off", async () => {
    await show();
    const sw = screen.getByRole("switch", { name: "Review each turn" });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    await act(async () => void fireEvent.click(sw));
    expect(m.saveSettings).toHaveBeenCalledWith({ reviewTurns: false });
  });
});

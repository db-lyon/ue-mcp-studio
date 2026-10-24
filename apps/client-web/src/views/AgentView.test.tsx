// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const m = vi.hoisted(() => ({
  settings: vi.fn(async () => ({ askBeforeChanges: true, dialogPolicy: { kind: "wait" } })),
  agentSettings: vi.fn(),
  saveAgentSettings: vi.fn(),
  saveSettings: vi.fn(),
}));
vi.mock("../api", () => ({ api: m, ApiError: Error }));
import { AgentView } from "./AgentView";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const agent = (playtestRuns?: "manual" | "automatic") => ({ feedbackTool: false, feedbackMode: null, dialogMode: null, ...(playtestRuns ? { playtestRuns } : {}) });

describe("Settings > Agent: Playtest runs", () => {
  it("shows Manual as chosen by default, with each option's help", async () => {
    m.agentSettings.mockResolvedValue(agent("manual"));
    await act(async () => void render(<AgentView />));
    const manual = screen.getByRole("radio", { name: /^Manual/ }) as HTMLInputElement;
    expect(manual.checked).toBe(true);
    expect(screen.getByText("Playtests run only when you click Start Playtest or Assign to subagent.")).toBeTruthy();
    expect(screen.getByText("The agent can start playtests itself.")).toBeTruthy();
  });

  it("saves Automatic, and Manual again", async () => {
    m.agentSettings.mockResolvedValue(agent("manual"));
    m.saveAgentSettings.mockImplementation(async (u: { playtestRuns: "manual" | "automatic" }) => agent(u.playtestRuns));
    await act(async () => void render(<AgentView />));
    await act(async () => void fireEvent.click(screen.getByRole("radio", { name: /^Automatic/ })));
    expect(m.saveAgentSettings).toHaveBeenCalledWith({ playtestRuns: "automatic" });
    expect((screen.getByRole("radio", { name: /^Automatic/ }) as HTMLInputElement).checked).toBe(true);
    await act(async () => void fireEvent.click(screen.getByRole("radio", { name: /^Manual/ })));
    expect(m.saveAgentSettings).toHaveBeenLastCalledWith({ playtestRuns: "manual" });
  });

  it("says to update Studio when the agent has no such setting", async () => {
    m.agentSettings.mockResolvedValue(agent());
    await act(async () => void render(<AgentView />));
    expect(screen.queryByRole("radio", { name: /^Manual/ })).toBeNull();
    expect(screen.getByText("Update Studio to choose this.")).toBeTruthy();
  });
});

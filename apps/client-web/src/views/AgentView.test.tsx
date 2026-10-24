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
    expect(screen.getByText("Playtests run only when you click Run or Assign to subagent.")).toBeTruthy();
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

describe("Settings > Agent: the Assign to subagent budget", () => {
  it("shows the budget beside Playtest runs and saves a change on Enter", async () => {
    m.agentSettings.mockResolvedValue({ ...agent("manual"), playtestBudget: { minutes: 60, tokens: 2_000_000 } });
    m.saveAgentSettings.mockImplementation(async (u: Record<string, unknown>) => ({ ...agent("manual"), playtestBudget: u.playtestBudget }));
    await act(async () => void render(<AgentView />));
    const minutes = screen.getByLabelText("Minutes per loop") as HTMLInputElement;
    const tokens = screen.getByLabelText("Tokens per loop") as HTMLInputElement;
    expect([minutes.value, tokens.value]).toEqual(["60", "2000000"]);
    fireEvent.change(minutes, { target: { value: "20" } });
    await act(async () => void fireEvent.keyDown(minutes, { key: "Enter" }));
    expect(m.saveAgentSettings).toHaveBeenCalledWith({ playtestBudget: { minutes: 20, tokens: 2_000_000 } });
  });

  it("does not save a budget out of range, and says why", async () => {
    m.agentSettings.mockResolvedValue({ ...agent("manual"), playtestBudget: { minutes: 60, tokens: 2_000_000 } });
    await act(async () => void render(<AgentView />));
    const tokens = screen.getByLabelText("Tokens per loop") as HTMLInputElement;
    fireEvent.change(tokens, { target: { value: "0" } });
    fireEvent.blur(tokens);
    expect(m.saveAgentSettings).not.toHaveBeenCalled();
    expect(screen.getByText(/Minutes from 1 to 1440/)).toBeTruthy();
  });
});

describe("Settings > Agent: Review each turn", () => {
  it("is on by default and saves off", async () => {
    m.agentSettings.mockResolvedValue(agent("manual"));
    m.saveSettings.mockImplementation(async (u: { reviewTurns: boolean }) => ({ askBeforeChanges: true, dialogPolicy: { kind: "wait" }, reviewTurns: u.reviewTurns }));
    await act(async () => void render(<AgentView />));
    const box = screen.getByRole("checkbox", { name: "Review each turn" }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    await act(async () => void fireEvent.click(box));
    expect(m.saveSettings).toHaveBeenCalledWith({ reviewTurns: false });
    expect((screen.getByRole("checkbox", { name: "Review each turn" }) as HTMLInputElement).checked).toBe(false);
  });
});

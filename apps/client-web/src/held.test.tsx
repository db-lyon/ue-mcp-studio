// @vitest-environment jsdom
// The bar for a run holding at a manual step: the line, the countdown to the agent's deadline, Resume and watch, the verdict and Stop now.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { QaHeld } from "@ue-mcp-studio/shared";

const m = vi.hoisted(() => ({ qaVerdict: vi.fn(), qaStop: vi.fn(), qaResume: vi.fn(), qaHeld: vi.fn() }));
vi.mock("./api", () => ({ api: m }));
import { HeldBar } from "./held";
import type { HeldValue } from "./held-context";

const NOW = Date.parse("2026-11-23T10:02:18.000Z");
const held = (o: Partial<QaHeld> = {}): QaHeld => ({ runId: "r1", scriptName: "Door", sessionId: "s1", step: 1, instruction: "The door opens without a pop", since: "2026-11-23T10:00:00.000Z", dueAt: "2026-11-23T10:10:00.000Z", paused: true, ...o });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
  for (const f of Object.values(m)) f.mockReset().mockResolvedValue({});
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the held bar", () => {
  it("shows nothing while no run waits", () => {
    const { container } = render(<HeldBar value={{ held: [], resume: async () => {} }} onOpenCard={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("names the step, counts down to the deadline, and offers Resume and watch while PIE is paused", async () => {
    const resume = vi.fn(async () => {});
    const value: HeldValue = { held: [held()], resume };
    render(<HeldBar value={value} onOpenCard={() => {}} />);
    expect(screen.getByText("Waiting for your verdict: Door, step 2")).toBeTruthy();
    expect(screen.getByRole("timer").textContent).toBe("Ends in 7:42");
    act(() => void vi.advanceTimersByTime(2000));
    expect(screen.getByRole("timer").textContent).toBe("Ends in 7:40");
    fireEvent.click(screen.getByRole("button", { name: "Resume and watch" }));
    await waitFor(() => expect(resume).toHaveBeenCalledWith("r1"));
    cleanup();
    render(<HeldBar value={{ held: [held({ paused: false })], resume }} onOpenCard={() => {}} />);
    expect(screen.queryByRole("button", { name: "Resume and watch" })).toBeNull();
  });

  it("sends Pass, a Fail with its note, and Stop now; opens the card", async () => {
    const open = vi.fn();
    render(<HeldBar value={{ held: [held()], resume: async () => {} }} onOpenCard={open} />);
    fireEvent.click(screen.getByRole("button", { name: "Pass" }));
    await waitFor(() => expect(m.qaVerdict).toHaveBeenCalledWith("r1", 1, "pass", undefined));
    fireEvent.click(screen.getByRole("button", { name: "Fail" }));
    fireEvent.change(screen.getByLabelText("What went wrong?"), { target: { value: "It popped" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(m.qaVerdict).toHaveBeenCalledWith("r1", 1, "fail", "It popped"));
    fireEvent.click(screen.getByRole("button", { name: "Stop now" }));
    await waitFor(() => expect(m.qaStop).toHaveBeenCalledWith("r1"));
    fireEvent.click(screen.getByRole("button", { name: "Open card" }));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ runId: "r1" }));
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ToolCallRecord } from "@ue-mcp-studio/shared";

const m = vi.hoisted(() => ({ callResult: vi.fn() }));
vi.mock("../api", () => ({ api: m }));
import { ToolCall } from "./Transcript";
import { SessionIdContext } from "./attachments";

afterEach(() => {
  cleanup();
  m.callResult.mockReset();
});

const left: ToolCallRecord = { id: "c1", name: "shell", input: { command: "ls" }, outcome: "done", resultSize: 20_000, startedAt: "2026-11-03T12:00:00Z" };

describe("a call whose long result the session left out", () => {
  it("fetches the result the first time it is opened, not before, and shows it", async () => {
    m.callResult.mockResolvedValue({ result: "line one\nline two" });
    const { container } = render(
      <SessionIdContext.Provider value="s1">
        <ToolCall call={left} />
      </SessionIdContext.Provider>,
    );
    expect(m.callResult).not.toHaveBeenCalled();
    const details = container.querySelector("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(screen.getByRole("status").textContent).toMatch(/Loading the result/);
    expect(await screen.findByText(/line one/)).toBeTruthy();
    expect(m.callResult).toHaveBeenCalledWith("s1", "c1");
    expect(m.callResult).toHaveBeenCalledTimes(1);
  });

  it("a result sent with the session is shown without asking", () => {
    const { container } = render(
      <SessionIdContext.Provider value="s1">
        <ToolCall call={{ ...left, resultSize: undefined, result: "inline" }} />
      </SessionIdContext.Provider>,
    );
    const details = container.querySelector("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(screen.getByText("inline")).toBeTruthy();
    expect(m.callResult).not.toHaveBeenCalled();
  });
});

/**
 * While a turn runs, the phone shows the model's thinking so far and what the
 * running call has printed, as the web client does.
 */
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import type { TranscriptEntry } from "@ue-mcp-studio/shared";
import { NO_LIVE } from "@ue-mcp-studio/client-core";
import { MainTranscript } from "../src/chat/Transcript";
import { renderInProject } from "./helpers";

const transcript: TranscriptEntry[] = [
  { kind: "user", text: "build it", at: "2026-11-16T10:00:00Z" },
  { kind: "tool", call: { id: "c1", name: "shell", input: { command: "build.bat" }, outcome: "pending", startedAt: "2026-11-16T10:00:01Z" } },
];
const props = { transcript, status: "running" as const, streaming: "", waitingCause: null, error: null, onOpen: vi.fn(), hidden: false };

describe("the live parts of a running turn on a phone", () => {
  it("shows the running call's output so far and the thinking, which folds", () => {
    renderInProject(<MainTranscript {...props} live={{ thinking: "The build log will say which module failed.", thinkingSince: Date.now(), output: { callId: "c1", text: "Compiling Module.Core\nLinking" } }} />);
    expect(screen.getByText("OUTPUT SO FAR")).toBeTruthy();
    expect(screen.getByText(/Compiling Module.Core/)).toBeTruthy();
    expect(screen.getByText("The build log will say which module failed.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "THINKING" }));
    expect(screen.queryByText("The build log will say which module failed.")).toBeNull();
  });

  it("shows how long a long think has run in its header, and counts on", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-16T10:05:00Z"));
      renderInProject(<MainTranscript {...props} live={{ thinking: "Still weighing it.", thinkingSince: Date.parse("2026-11-16T10:01:48Z"), output: null }} />);
      expect(screen.getByText("THINKING 3M 12S")).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(screen.getByText("THINKING 3M 14S")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows neither when there is nothing live", () => {
    renderInProject(<MainTranscript {...props} live={NO_LIVE} />);
    expect(screen.queryByText("OUTPUT SO FAR")).toBeNull();
    expect(screen.queryByText("THINKING")).toBeNull();
  });
});

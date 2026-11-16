// @vitest-environment jsdom
/**
 * While a turn runs, the conversation shows the model's thinking so far and
 * what the running call has printed, before either lands in the transcript.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { TranscriptEntry } from "@ue-mcp-studio/shared";
import { NO_LIVE } from "@ue-mcp-studio/client-core";
import { MainTranscript } from "./Transcript";

afterEach(cleanup);

const transcript: TranscriptEntry[] = [
  { kind: "user", text: "build it", at: "2026-11-16T10:00:00Z" },
  { kind: "tool", call: { id: "c1", name: "shell", input: { command: "build.bat" }, outcome: "pending", startedAt: "2026-11-16T10:00:01Z" } },
];
const props = { transcript, status: "running" as const, streaming: "", waitingCause: null, error: null, onOpen: vi.fn(), hidden: false };

describe("the live parts of a running turn", () => {
  it("shows the running call's output so far and the thinking, under their labels", () => {
    render(<MainTranscript {...props} live={{ thinking: "The build log will say which module failed.", output: { callId: "c1", text: "Compiling Module.Core\nLinking" } }} />);
    expect(screen.getByRole("log", { name: "Output so far" }).textContent).toContain("Compiling Module.Core");
    expect(screen.getByText("Thinking")).toBeTruthy();
    expect(screen.getByText("The build log will say which module failed.")).toBeTruthy();
  });

  it("shows neither when there is nothing live", () => {
    render(<MainTranscript {...props} live={NO_LIVE} />);
    expect(screen.queryByRole("log", { name: "Output so far" })).toBeNull();
    expect(screen.queryByText("Thinking")).toBeNull();
  });
});

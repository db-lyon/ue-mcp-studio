// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TranscriptEntry } from "@ue-mcp-studio/shared";

vi.mock("../api", () => ({ api: {} }));
import { Entry, PlaytestCommandContext } from "./Transcript";
import { AssetTranscriptContext } from "./asset-links";

afterEach(() => cleanup());

const at = "2026-10-24T10:00:00Z";
const transcript: TranscriptEntry[] = [
  { kind: "user", text: "add a double jump", at },
  { kind: "assistant", text: "Added a double jump to BP_Hero: press Space twice.", at },
  { kind: "user", text: "/playtest", at, source: 1 },
  { kind: "playtest", state: "failed", request: { text: "", source: 1 }, attempt: 3, errors: ["Step 1 expect.value: Pawn.JumpCnt is not a value PIE can read", "The script has no auto step"], at },
  { kind: "playtest", state: "drafting", request: { text: "" }, attempt: 2, at },
];

function show(entry: TranscriptEntry, busy = false, run = vi.fn()) {
  render(
    <AssetTranscriptContext.Provider value={transcript}>
      <PlaytestCommandContext.Provider value={{ busy, run }}>
        <Entry entry={entry} />
      </PlaytestCommandContext.Provider>
    </AssetTranscriptContext.Provider>,
  );
  return run;
}

describe("Make playtest", () => {
  it("is on an agent message and sends a /playtest made from it", () => {
    const run = show(transcript[1]);
    fireEvent.click(screen.getByRole("button", { name: "Make playtest" }));
    expect(run).toHaveBeenCalledWith({ text: "", source: 1 });
  });

  it("waits while a turn runs", () => {
    show(transcript[1], true);
    expect((screen.getByRole("button", { name: "Make playtest" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("is not on the user's messages, and a sourced /playtest says where it came from", () => {
    show(transcript[2]);
    expect(screen.queryByRole("button", { name: "Make playtest" })).toBeNull();
    expect(screen.getByText(/from the agent's message above/)).toBeTruthy();
  });
});

describe("a /playtest's flow", () => {
  it("shows its stages while it runs, the one in progress marked, and the draft's attempt", () => {
    show(transcript[4]);
    const stages = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(stages).toEqual(["Gathering", "Drafting (attempt 2)", "Checking", "Created"]);
    expect(screen.getByText("Drafting (attempt 2)").getAttribute("aria-current")).toBe("step");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("says no playtest was made, lists the flow's errors, and Retry sends the same request", () => {
    const run = show(transcript[3]);
    expect(screen.getByText("No playtest was made.")).toBeTruthy();
    expect(screen.getByText("Step 1 expect.value: Pawn.JumpCnt is not a value PIE can read")).toBeTruthy();
    expect(screen.getByText("The script has no auto step")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(run).toHaveBeenCalledWith({ text: "", source: 1 });
  });
});

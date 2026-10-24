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
  { kind: "playtest-failed", reason: "The model answered without calling pie(script_create).", request: { text: "", source: 1 }, at },
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

describe("a /playtest that made nothing", () => {
  it("says no playtest was made and why, and Retry sends the same request", () => {
    const run = show(transcript[3]);
    expect(screen.getByText("No playtest was made.")).toBeTruthy();
    expect(screen.getByText("The model answered without calling pie(script_create).")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(run).toHaveBeenCalledWith({ text: "", source: 1 });
  });
});

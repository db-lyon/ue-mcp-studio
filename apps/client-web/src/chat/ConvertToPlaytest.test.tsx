// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TranscriptEntry, TurnStatus } from "@ue-mcp-studio/shared";

vi.mock("../api", () => ({ api: {} }));
import { Entry, PlaytestConvertContext } from "./Transcript";
import { AssetTranscriptContext } from "./asset-links";
import { CONVERT_PREFIX } from "./prose-playtest";

afterEach(() => cleanup());

const PROSE = "QA pass:\n\n1. Walk up to the door - PASS\n2. Open it - PASS\n3. No pop when it opens - FAIL";
const user = (text: string): TranscriptEntry => ({ kind: "user", text, at: "2026-10-24T10:00:00Z" });
const reply = (text: string): TranscriptEntry => ({ kind: "assistant", text, at: "2026-10-24T10:00:01Z" });

function show(transcript: TranscriptEntry[], status: TurnStatus = "idle", send = vi.fn()) {
  const entry = transcript.find((t) => t.kind === "assistant")!;
  render(
    <AssetTranscriptContext.Provider value={transcript}>
      <PlaytestConvertContext.Provider value={{ status, send }}>
        <Entry entry={entry} />
      </PlaytestConvertContext.Provider>
    </AssetTranscriptContext.Provider>,
  );
  return send;
}

describe("Turn into Playtest", () => {
  it("shows under a finished prose playtest and sends the agent the steps to build", () => {
    const send = show([user("check the door"), reply(PROSE)]);
    expect(screen.getByText("These 3 steps were written out, not run.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Turn into Playtest" }));
    expect(send).toHaveBeenCalledTimes(1);
    const text = send.mock.calls[0][0] as string;
    expect(text.startsWith(CONVERT_PREFIX)).toBe(true);
    expect(text).toContain("1. Walk up to the door\n2. Open it\n3. No pop when it opens");
    expect(screen.queryByRole("button", { name: "Turn into Playtest" })).toBeNull();
  });

  it("waits for the turn to end", () => {
    show([user("check the door"), reply(PROSE)], "running");
    expect(screen.queryByRole("button", { name: "Turn into Playtest" })).toBeNull();
  });

  it("is not offered on an ordinary numbered list", () => {
    show([user("how do I add a door"), reply("1. Open BP_Door\n2. Add a Timeline\n3. Compile")]);
    expect(screen.queryByRole("button", { name: "Turn into Playtest" })).toBeNull();
  });

  it("is not offered when the turn ran a test script", () => {
    const run: TranscriptEntry = { kind: "tool", call: { id: "t1", name: "ue_mcp", input: { action: "call", category: "pie", method: "script_run", args: {} }, outcome: "done", startedAt: "" } };
    show([user("check the door"), run, reply(PROSE)]);
    expect(screen.queryByRole("button", { name: "Turn into Playtest" })).toBeNull();
  });
});

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

function show(transcript: TranscriptEntry[], status: TurnStatus = "idle", send = vi.fn(), create = vi.fn(async () => {})) {
  const entry = transcript.find((t) => t.kind === "assistant")!;
  render(
    <AssetTranscriptContext.Provider value={transcript}>
      <PlaytestConvertContext.Provider value={{ status, send, create }}>
        <Entry entry={entry} />
      </PlaytestConvertContext.Provider>
    </AssetTranscriptContext.Provider>,
  );
  return { send, create };
}

describe("Turn into Playtest", () => {
  it("shows under a finished prose playtest and sends the agent the steps to build", () => {
    const { send } = show([user("check the door"), reply(PROSE)]);
    expect(screen.getByText("These 3 steps were written out, not saved as a playtest.")).toBeTruthy();
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

describe("Turn into Playtest on a table", () => {
  const TABLE = [
    "| # | Player | Do | Pass when | Judged |",
    "|---|---|---|---|---|",
    "| 1 | Host | Pick up the sigil | The counter reads 100 | auto: PlayerState.SigilAttributes.Sigil.CurrentValue eq 100, within 5 s |",
    "| 2 | Client | Watch the pickup | It plays on the client | manual |",
  ].join("\n");

  it("saves the table's steps as the script directly, without the agent", async () => {
    const { send, create } = show([user("draft a sigil playtest"), reply(TABLE)]);
    expect(screen.getByText("These 2 steps were written out, not saved as a playtest.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Turn into Playtest" }));
    expect(send).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(expect.stringMatching(/^PT_Playtest_\d{6}$/), [
      { instruction: "Pick up the sigil. Pass when: The counter reads 100", judge: "auto", expect: { value: "PlayerState.SigilAttributes.Sigil.CurrentValue", op: "eq", target: 100, within_ms: 5000 }, player: "host" },
      { instruction: "Watch the pickup. Pass when: It plays on the client", judge: "manual", player: "client 1" },
    ]);
  });

  it("is not offered on an ordinary table", () => {
    show([user("compare"), reply("| Option | Pros | Cons |\n|---|---|---|\n| A | Fast | Big |\n| B | Small | Slow |")]);
    expect(screen.queryByRole("button", { name: "Turn into Playtest" })).toBeNull();
  });
});

import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import type { Transport } from "@ue-mcp-studio/client-core";
import type { TranscriptEntry } from "@ue-mcp-studio/shared";
import { MainTranscript } from "../src/chat/Transcript";
import { SessionIdContext } from "../src/chat/attachments";
import { fakeApi, fakeProject, renderInProject, settle } from "./helpers";

const props = (transcript: TranscriptEntry[]) => ({ transcript, status: "idle" as const, streaming: "", waitingCause: null, error: null, onOpen: vi.fn(), hidden: false });

describe("a picture the user sent, on the phone", () => {
  it("says it could not load, with its name and Retry, and Retry reads it again", async () => {
    let calls = 0;
    const transport: Transport = async () => {
      calls++;
      if (calls === 1) return { status: 500, headers: {} as Record<string, string>, body: null };
      return { status: 200, headers: { "content-type": "image/png" }, body: (async function* () { yield new Uint8Array([1, 2, 3]); })() };
    };
    const entry: TranscriptEntry = { kind: "user", text: "Here is the bug", at: "2026-11-16T10:00:00Z", attachments: [{ id: "a1", name: "door-bug.png", type: "image/png", size: 3 }] };
    renderInProject(
      <SessionIdContext.Provider value="s-sent">
        <MainTranscript {...props([entry])} />
      </SessionIdContext.Provider>,
      fakeApi(),
      fakeProject(transport).project,
    );
    await settle();
    expect(screen.getByText("The picture did not load.")).toBeTruthy();
    expect(screen.getByText("door-bug.png")).toBeTruthy();
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Load door-bug.png again" })));
    await settle();
    expect(calls).toBe(2);
    expect(screen.queryByText("The picture did not load.")).toBeNull();
  });
});

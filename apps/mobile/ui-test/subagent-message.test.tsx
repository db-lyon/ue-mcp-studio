/**
 * The composer in a subagent's thread on a phone: while the subagent runs, a
 * message goes to it (it reads it at its next step), the composer sends rather
 * than queues behind the main agent, and the thread stays open. From a
 * finished subagent's thread it goes to the main agent through the same
 * route, which names the subagent.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import type { TranscriptEntry } from "@ue-mcp-studio/shared";
import { Chat } from "../src/views/Chat";
import { fakeApi, renderInProject, session, settle } from "./helpers";

const at = "2026-11-04T12:00:00Z";
const agent = (outcome: "pending" | "done") =>
  ({ kind: "tool", call: { id: "a1", name: "agent", input: { description: "Find the hinge", prompt: "x" }, outcome, startedAt: new Date(Date.now() - 60_000).toISOString(), ...(outcome === "done" ? { endedAt: new Date().toISOString(), result: "ok" } : {}) } }) as TranscriptEntry;

async function openThread(outcome: "pending" | "done", status: "running" | "idle") {
  const api = fakeApi();
  const s = session({ status, agents: { total: 1, running: outcome === "pending" ? 1 : 0 }, transcript: [{ kind: "user", text: "Fix it", at } as TranscriptEntry, agent(outcome)] });
  api.sessions.mockResolvedValue({ sessions: [{ ...s, transcript: undefined }] });
  api.sessionSync.mockResolvedValue(s);
  api.settings.mockResolvedValue({ route: "key" });
  api.messageSubagent.mockResolvedValue({ sessionId: "s1", to: outcome === "pending" ? "subagent" : "main" });
  renderInProject(<Chat initialSession="s1" />, api);
  await settle();
  fireEvent.click(screen.getAllByText("Open thread ›")[0]);
  await settle();
  return api;
}

describe("the composer in a subagent's thread on a phone", () => {
  it("messages the running subagent while the main agent works, and stays in its thread", async () => {
    const api = await openThread("pending", "running");
    const box = screen.getByPlaceholderText('Message "Find the hinge"');
    fireEvent.change(box, { target: { value: "check the left hinge too" } });
    await settle();
    // It sends, rather than offering Queue behind the main agent.
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await settle();
    expect(api.messageSubagent).toHaveBeenCalledWith("s1", "a1", "check the left hinge too", [], false);
    expect(api.send).not.toHaveBeenCalled();
    expect(api.queue).not.toHaveBeenCalled();
    expect(api.stop).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Back to the main thread")).toBeTruthy();
  });

  it("says a finished subagent has finished, and sends to the main agent through its route", async () => {
    const api = await openThread("done", "idle");
    const box = screen.getByPlaceholderText('"Find the hinge" finished. Message the main agent');
    fireEvent.change(box, { target: { value: "do the other door the same way" } });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await settle();
    expect(api.messageSubagent).toHaveBeenCalledWith("s1", "a1", "do the other door the same way", [], false);
    expect(api.send).not.toHaveBeenCalled();
  });
});

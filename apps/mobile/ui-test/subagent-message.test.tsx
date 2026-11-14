/**
 * The composer in a subagent's thread on a phone: while the subagent runs, a
 * message goes to it (it reads it at its next step), the composer sends rather
 * than queues behind the main agent, and the thread stays open. From a
 * finished subagent's thread it goes to the main agent through the same
 * route, which names the subagent.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { sessionAgents, type TranscriptEntry } from "@ue-mcp-studio/shared";
import { Chat } from "../src/views/Chat";
import { fakeApi, renderInProject, session, settle } from "./helpers";

const at = "2026-11-04T12:00:00Z";
const agent = (outcome: "pending" | "done") =>
  ({ kind: "tool", call: { id: "a1", name: "agent", input: { description: "Find the hinge", prompt: "x" }, outcome, startedAt: new Date(Date.now() - 60_000).toISOString(), ...(outcome === "done" ? { endedAt: new Date().toISOString(), result: "ok" } : {}) } }) as TranscriptEntry;

type Extra = { messageable?: boolean; thread?: TranscriptEntry[] };
async function openThread(outcome: "pending" | "done", status: "running" | "idle", extra: Extra = {}) {
  const api = fakeApi();
  const transcript = [{ kind: "user", text: "Fix it", at } as TranscriptEntry, agent(outcome), ...(extra.thread ?? [])];
  // The daemon's own answer on whether the running subagent takes a message.
  const subagents = extra.messageable !== undefined ? { subagents: sessionAgents(transcript, { status, asked: new Set(), messageable: () => extra.messageable! }) } : {};
  const s = session({ status, agents: { total: 1, running: outcome === "pending" ? 1 : 0 }, transcript, ...subagents });
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

  it("says before the user types when the daemon says a running subagent cannot read messages, and sends to the main agent", async () => {
    const api = await openThread("pending", "running", { messageable: false });
    const box = screen.getByPlaceholderText('"Find the hinge" can\'t read messages. Queue a message for the main agent');
    fireEvent.change(box, { target: { value: "and the right one" } });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Queue" }));
    await settle();
    // Through the thread's route, which hands it to the main agent naming the subagent.
    expect(api.messageSubagent).toHaveBeenCalledWith("s1", "a1", "and the right one", [], false);
    expect(api.send).not.toHaveBeenCalled();
  });

  it("marks a message the subagent has not read yet, and one it never read, as on the web", async () => {
    await openThread("pending", "running", {
      messageable: true,
      thread: [
        { kind: "user", text: "first", at, parent: "a1", delivery: "read" },
        { kind: "user", text: "lost one", at, parent: "a1", delivery: "main" },
        { kind: "user", text: "just sent", at, parent: "a1", delivery: "waiting" },
      ],
    });
    expect(screen.getByText("Waiting for its next step")).toBeTruthy();
    expect(screen.getByText("Not delivered: it ended first, so the main agent has it")).toBeTruthy();
    expect(screen.getByText("first")).toBeTruthy();
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

// @vitest-environment jsdom
/**
 * The open session's playtests: live ones on the strip under its header, the
 * rest in the transcript, and no row of buttons above the conversation;
 * Checkpoints sits in the composer's bar when wide.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { qaRunFromAnswer, type QaRun, type SessionDetail } from "@ue-mcp-studio/shared";
import { ChatView } from "./Chat";

const OTHER = { dialogs: [], forms: [], approvals: [], providers: [], now: 0, runs: [] };
const daemon = { health: null, error: null, streaming: true, events: [], refresh: () => {} };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/ui/");
});

const run = (id: string, name: string, state: string, statuses: string[]): QaRun =>
  qaRunFromAnswer({ success: true, run_id: id, script: `/Game/T/${name}`, script_name: name, state, results_path: null, steps: statuses.map((status, index) => ({ index, instruction: `${name} ${index + 1}`, judge: "auto", status })), awaiting: [], last_seq: 1 }, { sessionId: "s1", seenAt: "2026-10-25T12:00:00.000Z" })!;

function open(runs: QaRun[]) {
  const summary = { id: "s1", title: "Play", status: "idle", createdAt: "", updatedAt: "", waitingCause: null, archived: false, agents: { total: 0, running: 0 }, awaiting: 0 };
  const detail: SessionDetail = { ...summary, status: "idle", transcript: [{ kind: "user", text: "test the door", at: "" }, ...runs.map((r) => ({ kind: "qa" as const, run: r }))], touched: [], draft: "", seen: [], dismissed: [], queue: [], error: null, approvals: [] };
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    const u = String(url);
    const body = u.endsWith("/sessions") ? { sessions: [summary] } : u.includes("/sessions/s1") && !u.includes("/forms") ? detail : u.includes("/settings") ? undefined : OTHER;
    return body === undefined ? new Promise(() => {}) : Promise.resolve(new Response(JSON.stringify(body)));
  }));
  window.history.replaceState(null, "", "/ui/#/chat/s1");
  return render(<ChatView daemon={daemon} />);
}

describe("a session's playtests", () => {
  it("draw a running one as the conversation's latest item, not pinned above it", async () => {
    // The agent moves a run that starts to the end of the transcript; the chat draws it in order.
    const { container } = open([run("done", "Walk", "finished", ["passed"]), run("live", "Door", "running", ["running", "pending"])]);
    await screen.findByRole("group", { name: "Playtest Walk" });
    const stage = container.querySelector<HTMLElement>(".thread-stage")!;
    const door = await within(stage).findByRole("group", { name: "Playtest Door" });
    expect(screen.queryByRole("region", { name: "Live playtests" })).toBeNull();
    // Shown once, after everything else in the conversation.
    expect(within(stage).getAllByRole("group", { name: "Playtest Door" })).toHaveLength(1);
    const walk = within(stage).getByRole("group", { name: "Playtest Walk" });
    expect(walk.compareDocumentPosition(door) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("take no space while none is live", async () => {
    open([run("done", "Walk", "finished", ["passed"])]);
    await screen.findByRole("group", { name: "Playtest Walk" });
    expect(screen.queryByRole("region", { name: "Live playtests" })).toBeNull();
  });
});

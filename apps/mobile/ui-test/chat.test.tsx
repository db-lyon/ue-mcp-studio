import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import type { ContextUsage, QueuedMessage, SessionSummary, TimelineMark, TranscriptEntry, TurnReview } from "@ue-mcp-studio/shared";
import { contextView } from "@ue-mcp-studio/shared";
import { SessionRow } from "../src/chat/SessionRow";
import { ChatHeader } from "../src/chat/ChatHeader";
import { Threads } from "../src/chat/Threads";
import { QueuedMessages } from "../src/chat/Queue";
import { ContextMeter, ContextWarning } from "../src/chat/ContextMeter";
import { SessionLoading, SessionRowsLoading } from "../src/chat/Skeleton";
import { ReviewPanel, TurnReviewCard } from "../src/screens/chat/items";
import { SessionIdContext } from "../src/chat/attachments";
import { Chat } from "../src/views/Chat";
import { fakeApi, renderInProject, session, settle } from "./helpers";

const summary = (over: Partial<SessionSummary> = {}): SessionSummary =>
  ({ id: "s1", title: "Door that opens", status: "idle", createdAt: "2026-11-04T12:00:00Z", updatedAt: "2026-11-04T12:05:00Z", archived: false, awaiting: 0, agents: { total: 0, running: 0 }, ...over }) as SessionSummary;

const agent = (id: string, description: string, outcome: "pending" | "done" | "error" = "pending"): TranscriptEntry =>
  ({ kind: "tool", call: { id, name: "agent", input: { description, prompt: "x" }, outcome, startedAt: new Date(Date.now() - 60_000).toISOString(), ...(outcome !== "pending" ? { endedAt: new Date().toISOString(), result: "ok" } : {}) } }) as TranscriptEntry;

describe("SessionRow", () => {
  it("opens the session, and from its menu renames, archives and deletes it after asking once more", async () => {
    const api = fakeApi();
    api.updateSession.mockResolvedValue({});
    api.deleteSession.mockResolvedValue(undefined);
    const opened = vi.fn();
    const changed = vi.fn();
    renderInProject(<SessionRow s={summary({ status: "running", model: "Sonnet 5.5", route: "key" })} selected={false} onOpen={opened} onChanged={changed} />, api);
    expect(screen.getByText("Sonnet 5.5 via key. Working")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Door that opens"));
    expect(opened).toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText("Session actions"));
    fireEvent.click(screen.getByLabelText("Archive"));
    await settle();
    expect(api.updateSession).toHaveBeenCalledWith("s1", { archived: true });

    fireEvent.click(screen.getByLabelText("Session actions"));
    fireEvent.click(screen.getByLabelText("Delete"));
    expect(api.deleteSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Are you sure?"));
    await settle();
    expect(api.deleteSession).toHaveBeenCalledWith("s1");
    expect(changed).toHaveBeenLastCalledWith("s1");

    fireEvent.click(screen.getByLabelText("Session actions"));
    fireEvent.click(screen.getByLabelText("Rename"));
    const input = screen.getByLabelText("Session title");
    fireEvent.change(input, { target: { value: "Door that swings" } });
    fireEvent.blur(input);
    await settle();
    expect(api.updateSession).toHaveBeenCalledWith("s1", { title: "Door that swings" });
  });

  it("says a session waits on the user's approval, and offers Restore on an archived one", () => {
    renderInProject(<SessionRow s={summary({ awaiting: 2, archived: true })} selected onOpen={() => undefined} onChanged={() => undefined} />);
    expect(screen.getByText("Waiting on your approval of 2 calls")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Session actions"));
    expect(screen.getByLabelText("Restore")).toBeTruthy();
  });
});

describe("ChatHeader", () => {
  it("goes back to the sessions, opens Checkpoints and the subagents", () => {
    const onSessions = vi.fn();
    const onReview = vi.fn();
    const onAgents = vi.fn();
    renderInProject(<ChatHeader title="Cave door" thread={null} transcript={[]} sessionWaiting={false} agents={3} onSessions={onSessions} onMain={() => undefined} onStop={() => undefined} onAgents={onAgents} onReview={onReview} />);
    expect(screen.getByText("Cave door")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Back to sessions"));
    fireEvent.click(screen.getByLabelText("Checkpoints"));
    fireEvent.click(screen.getByLabelText("Subagents (3)"));
    expect([onSessions, onReview, onAgents].every((f) => f.mock.calls.length === 1)).toBe(true);
  });

  it("is the touch-screen .chat-back: 44 px of buttons with no padding above or below, the label spaced as its 16 px button", () => {
    renderInProject(<ChatHeader title="Cave door" thread={null} transcript={[]} sessionWaiting={false} agents={0} onSessions={() => undefined} onMain={() => undefined} onStop={() => undefined} onReview={() => undefined} />);
    const row = getComputedStyle(screen.getByLabelText("Back to sessions").parentElement!);
    expect([row.minHeight, row.paddingTop, row.paddingBottom, row.paddingLeft, row.paddingRight]).toEqual(["44px", "0px", "0px", "4px", "8px"]);
    expect(getComputedStyle(screen.getByText("Sessions")).letterSpacing).toBe("0.32px");
  });

  it("over a subagent's thread: its name, the session above it, its state and Stop", () => {
    const call = (agent("a1", "Dress the floor") as Extract<TranscriptEntry, { kind: "tool" }>).call;
    const onMain = vi.fn();
    const onStop = vi.fn();
    renderInProject(<ChatHeader title="Cave door" thread={call} transcript={[agent("a1", "Dress the floor")]} sessionWaiting={false} agents={1} onSessions={() => undefined} onMain={onMain} onStop={onStop} onReview={() => undefined} />);
    expect(screen.getByText("Dress the floor")).toBeTruthy();
    expect(screen.getByText("Cave door")).toBeTruthy();
    expect(screen.queryByLabelText("Checkpoints")).toBeNull();
    fireEvent.click(screen.getByLabelText("Back to the main thread"));
    fireEvent.click(screen.getByLabelText("Stop"));
    expect(onMain).toHaveBeenCalled();
    expect(onStop).toHaveBeenCalledWith("a1");
  });
});

describe("Threads", () => {
  it("lists the main agent and running subagents, folds the finished ones, and stops, opens and dismisses", () => {
    const onThread = vi.fn();
    const onStop = vi.fn();
    const onDismiss = vi.fn();
    const transcript = [agent("a1", "Rocks"), agent("a2", "Fog", "done"), agent("a3", "Lights", "error")];
    renderInProject(
      <Threads transcript={transcript} thread={null} onThread={onThread} onStop={onStop} sessionWaiting={false} seen={new Set(["a2"])} onDismiss={onDismiss} tokens={{ main: 12_000, a1: 3000 }} context={{ main: { input: 41_000, cached: 0, output: 900, model: "m", at: "2026-11-04T12:00:00Z" } as ContextUsage }} />,
    );
    expect(screen.getByText(/^context 4\d/)).toBeTruthy();
    expect(screen.getByText("3.0k spent")).toBeTruthy();
    expect(screen.queryByLabelText("Fog")).toBeNull();
    fireEvent.click(screen.getByLabelText("Stop Rocks"));
    expect(onStop).toHaveBeenCalledWith("a1");
    expect(screen.getAllByText(/, 1 new/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/, 1 failed/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByLabelText("Finished (2)"));
    fireEvent.click(screen.getByLabelText("Fog"));
    expect(onThread).toHaveBeenCalledWith("a2");
    fireEvent.click(screen.getByLabelText("Dismiss Lights"));
    expect(onDismiss).toHaveBeenCalledWith(["a3"]);
    fireEvent.click(screen.getByLabelText("Clear finished"));
    expect(onDismiss).toHaveBeenLastCalledWith(["a2", "a3"]);
    fireEvent.click(screen.getByLabelText("Main"));
    expect(onThread).toHaveBeenCalledWith(null);
  });

  it("draws nothing with no subagents", () => {
    const { container } = renderInProject(<Threads transcript={[]} thread={null} onThread={() => undefined} onStop={() => undefined} sessionWaiting={false} seen={new Set()} />);
    expect(container.textContent).toBe("");
  });
});

describe("QueuedMessages", () => {
  const queue: QueuedMessage[] = [{ id: "q1", text: "Then tint the fog", attachments: [], at: "2026-11-04T12:00:00Z" } as QueuedMessage, { id: "q2", text: "", attachments: [{ id: "f" }], at: "2026-11-04T12:00:00Z" } as unknown as QueuedMessage];
  it("edits, removes, and sends the next one once the turn has stopped", () => {
    const onEdit = vi.fn();
    const onRemove = vi.fn();
    const onSendNext = vi.fn();
    renderInProject(<QueuedMessages queue={queue} busy={false} onEdit={onEdit} onRemove={onRemove} onSendNext={onSendNext} />);
    expect(screen.getByText("Queued (2)")).toBeTruthy();
    expect(screen.getByText("(files only)")).toBeTruthy();
    expect(screen.getByText("1 file")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Send next"));
    fireEvent.click(screen.getByLabelText("Remove queued message 2"));
    fireEvent.click(screen.getByLabelText("Edit queued message 1"));
    fireEvent.change(screen.getByLabelText("Edit queued message 1"), { target: { value: "Then tint the fog blue" } });
    fireEvent.click(screen.getByLabelText("Save"));
    expect(onSendNext).toHaveBeenCalled();
    expect(onRemove).toHaveBeenCalledWith("q2");
    expect(onEdit).toHaveBeenCalledWith("q1", "Then tint the fog blue");
  });

  it("says the queue goes one by one while a turn runs, without Send next", () => {
    renderInProject(<QueuedMessages queue={queue} busy onEdit={() => undefined} onRemove={() => undefined} onSendNext={() => undefined} />);
    expect(screen.getByText("Queued (2), sent one by one as each turn ends")).toBeTruthy();
    expect(screen.queryByLabelText("Send next")).toBeNull();
  });
});

describe("ContextMeter", () => {
  const usage = (input: number): ContextUsage => ({ input, cached: input * 0.9, output: 2400, model: "claude-sonnet-5-5", at: "2026-11-04T12:00:00Z" }) as ContextUsage;
  const totals = { input: 412_000, cacheRead: 18_400_000, cacheWrite: 690_000, output: 96_300, reasoning: 41_200, requests: 214, costUsd: 12.37 };

  it("shows how full the context is and opens its numbers and the session totals", () => {
    const onCompact = vi.fn();
    renderInProject(<ContextMeter context={usage(698_000)} totals={totals} model="claude-sonnet-5-5" listedWindow={1_000_000} busy={false} compacting={false} runtime={false} onCompact={onCompact} />);
    expect(screen.getByText("70%")).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/^Context 70% full/));
    expect(screen.getByText("Session totals")).toBeTruthy();
    expect(screen.getByText("$12.37")).toBeTruthy();
    expect(screen.getByText(/Studio compacts it on its own at 850k tokens \(85%\)/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Compact now"));
    expect(onCompact).toHaveBeenCalled();
  });

  it("marks an estimate with ~ and has nothing to show before any measurement", () => {
    renderInProject(<ContextMeter context={{ ...usage(41_000), estimated: true }} totals={undefined} model="claude-sonnet-5-5" listedWindow={1_000_000} busy={false} compacting={false} runtime={false} onCompact={() => undefined} />);
    expect(screen.getByText("~4%")).toBeTruthy();
    const { container } = renderInProject(<ContextMeter context={undefined} totals={undefined} model="m" busy={false} compacting={false} runtime={false} onCompact={() => undefined} />);
    expect(container.textContent).toBe("");
  });

  it("warns near the compaction point, with Compact now and Dismiss", () => {
    const view = contextView(usage(828_000), "claude-sonnet-5-5", 1_000_000)!;
    const onCompact = vi.fn();
    const onDismiss = vi.fn();
    renderInProject(<ContextWarning view={view} runtime={false} busy={false} onCompact={onCompact} onDismiss={onDismiss} />);
    expect(screen.getByText("Context is 83% full. Studio compacts it at 85%; compact now to choose the moment.")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Compact now"));
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(onCompact).toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalled();
  });
});

describe("Skeleton", () => {
  it("names what is loading", () => {
    renderInProject(
      <>
        <SessionRowsLoading />
        <SessionLoading />
      </>,
    );
    expect(screen.getByLabelText("Loading sessions")).toBeTruthy();
    expect(screen.getByLabelText("Opening session")).toBeTruthy();
  });
});

const REVIEW: TurnReview = {
  id: "r1",
  turn: 0,
  before: "a",
  after: "b",
  at: "2026-11-04T12:00:00Z",
  items: [
    { path: "Config/DefaultEngine.ini", status: "modified", kind: "config", group: "config", state: "pending", summary: "1 line added", native: { available: false, reason: "no view" } },
    { path: "Content/BP_Door.uasset", status: "modified", kind: "package", group: "blueprint", state: "kept", summary: "2 differences", native: { available: true } },
  ],
};

describe("TurnReviewCard", () => {
  it("keeps and reverts an item, and opens its diff", async () => {
    const api = fakeApi();
    api.reviewKeep.mockResolvedValue({ review: { ...REVIEW, items: [{ ...REVIEW.items[0], state: "kept" }, REVIEW.items[1]] } });
    api.reviewRevert.mockResolvedValue({ review: REVIEW, outcome: { restored: [], conflicts: ["Config/DefaultEngine.ini"], missing: [] } });
    api.reviewDiff.mockResolvedValue({ change: { path: "Config/DefaultEngine.ini", status: "modified", kind: "config", diff: "@@ -1,1 +1,2 @@\n a\n+b\n" } });
    renderInProject(
      <SessionIdContext.Provider value="s1">
        <TurnReviewCard review={REVIEW} />
      </SessionIdContext.Provider>,
      api,
    );
    expect(screen.getByText("Changes in this turn")).toBeTruthy();
    expect(screen.getByText("Kept")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Keep"));
    await settle();
    expect(api.reviewKeep).toHaveBeenCalledWith("s1", "r1", ["Config/DefaultEngine.ini"]);
    fireEvent.click(screen.getByLabelText("Revert all"));
    await settle();
    expect(api.reviewRevert).toHaveBeenCalledWith("s1", "r1", ["Config/DefaultEngine.ini", "Content/BP_Door.uasset"], false);
    expect(screen.getByText("1 file was edited after the agent and left as they are.")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("DefaultEngine.ini"));
    await settle();
    expect(api.reviewDiff).toHaveBeenCalledWith("s1", "r1", "Config/DefaultEngine.ini");
    expect(screen.getByLabelText("Diff of Config/DefaultEngine.ini")).toBeTruthy();
  });
});

describe("ReviewPanel", () => {
  it("lists the timeline newest first, restores after a second press, and undoes a restore", async () => {
    const api = fakeApi();
    api.reviewStatus.mockResolvedValue({ default: true });
    api.timelineRestore.mockResolvedValue({ timeline: [], outcome: { restored: [], conflicts: [], missing: [] } });
    api.timelineUndo.mockResolvedValue({ timeline: [], outcome: { restored: [], conflicts: [], missing: [] } });
    const timeline: TimelineMark[] = [
      { checkpoint: "c1", label: "Fix the hinge", at: "2026-11-04T12:00:00Z", kind: "turn", turn: 0 },
      { checkpoint: "c2", label: "Restored to before the hinge edit", at: "2026-11-04T12:05:00Z", kind: "restore", undo: "c0" },
    ];
    const onChanged = vi.fn();
    renderInProject(<ReviewPanel sessionId="s1" review={null} timeline={timeline} onChanged={onChanged} />, api);
    await settle();
    // Following the Settings default, which is on: the box is ticked.
    expect(screen.getByRole("checkbox").textContent).toContain("✓");
    expect(screen.getByText(/Following Settings\./)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Restore to here"));
    fireEvent.click(screen.getByLabelText("Restore every file"));
    await settle();
    expect(api.timelineRestore).toHaveBeenCalledWith("s1", "c1", false);
    fireEvent.click(screen.getByLabelText("Undo"));
    await settle();
    expect(api.timelineUndo).toHaveBeenCalledWith("s1", "c2");
    expect(onChanged).toHaveBeenCalledTimes(2);
  });
});

describe("Chat", () => {
  const settings = { provider: "anthropic", model: "claude-sonnet-5-5", effort: "medium", route: "key", connected: true } as never;

  it("lists the sessions and opens one into its conversation, then sends", async () => {
    const api = fakeApi();
    api.sessions.mockResolvedValue({ sessions: [summary(), summary({ id: "s2", title: "Old one", archived: true })] });
    api.settings.mockResolvedValue(settings);
    api.models.mockResolvedValue({ signedIn: {}, providers: [] });
    api.sessionSync.mockResolvedValue(session({ transcript: [{ kind: "user", text: "Make the door swing", at: "2026-11-04T12:00:00Z" }] as TranscriptEntry[] }));
    api.send.mockResolvedValue({ sessionId: "s1" });
    renderInProject(<Chat />, api);
    await settle();
    expect(screen.getByText("Sessions")).toBeTruthy();
    expect(screen.queryByText("Old one")).toBeNull();
    fireEvent.click(screen.getByLabelText("Archived (1)"));
    expect(screen.getByText("Old one")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Door that opens"));
    await settle();
    expect(screen.getByText("Make the door swing")).toBeTruthy();
    expect(screen.getByLabelText("Back to sessions")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("Ask for something in the editor, or drop files here"), { target: { value: "Now add a creak" } });
    fireEvent.click(screen.getByLabelText("Send"));
    await settle();
    expect(api.send).toHaveBeenCalledWith("s1", "Now add a creak", []);
    fireEvent.click(screen.getByLabelText("Back to sessions"));
    expect(screen.getByText("Sessions")).toBeTruthy();
  });

  it("starts a project with no sessions on the empty page, and an example becomes the new session's draft", async () => {
    const api = fakeApi();
    api.sessions.mockResolvedValue({ sessions: [] });
    api.settings.mockResolvedValue(settings);
    api.models.mockResolvedValue({ signedIn: {}, providers: [] });
    api.newSession.mockResolvedValue(session({ id: "s9" }));
    renderInProject(<Chat />, api);
    await settle();
    expect(screen.getByText("Start")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Build a Niagara fire at the player start"));
    await settle();
    expect(api.newSession).toHaveBeenCalled();
    expect(api.saveDraft).toHaveBeenCalledWith("s9", "Build a Niagara fire at the player start");
  });

  it("refetches the open session when the daemon says it changed", async () => {
    const api = fakeApi();
    const { project, emit } = (await import("./helpers")).fakeProject();
    api.sessions.mockResolvedValue({ sessions: [summary()] });
    api.settings.mockResolvedValue(settings);
    api.models.mockResolvedValue({ signedIn: {}, providers: [] });
    api.sessionSync.mockResolvedValue(session());
    renderInProject(<Chat initialSession="s1" />, api, project);
    await settle();
    const before = api.sessionSync.mock.calls.length;
    emit("studio.transcript.added", { sessionId: "s1" });
    await settle();
    expect(api.sessionSync.mock.calls.length).toBeGreaterThan(before);
  });
});

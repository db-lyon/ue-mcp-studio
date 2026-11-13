import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import type { ContextUsage, QueuedMessage, SessionSummary, TimelineMark, TranscriptEntry, TurnReview } from "@ue-mcp-studio/shared";
import { contextView, sessionAgents } from "@ue-mcp-studio/shared";
import { SessionRow } from "../src/chat/SessionRow";
import { ChatHeader } from "../src/chat/ChatHeader";
import { Threads } from "../src/chat/Threads";
import { QueuedMessages } from "../src/chat/Queue";
import { ContextMeter, ContextWarning } from "../src/chat/ContextMeter";
import { SessionLoading, SessionRowsLoading } from "../src/chat/Skeleton";
import { ReviewPanel, TurnReviewCard } from "../src/screens/chat/items";
import { SessionIdContext } from "../src/chat/attachments";
import { Chat } from "../src/views/Chat";
import { ThemeProvider } from "../src/ui";
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
  it("goes back to the sessions, and holds no Checkpoints or subagents button: they are in the composer bar", () => {
    const onSessions = vi.fn();
    renderInProject(<ChatHeader title="Cave door" thread={null} onSessions={onSessions} onMain={() => undefined} onStop={() => undefined} />);
    expect(screen.getByText("Cave door")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Back to sessions"));
    expect(onSessions).toHaveBeenCalledOnce();
    expect(screen.queryByText("Checkpoints")).toBeNull();
    expect(screen.queryByLabelText(/Checkpoints|Subagents/)).toBeNull();
  });

  it("is the touch-screen .chat-back: 44 px of buttons with no padding above or below, the label spaced as its 16 px button", () => {
    renderInProject(<ChatHeader title="Cave door" thread={null} onSessions={() => undefined} onMain={() => undefined} onStop={() => undefined} />);
    const row = getComputedStyle(screen.getByLabelText("Back to sessions").parentElement!);
    expect([row.minHeight, row.paddingTop, row.paddingBottom, row.paddingLeft, row.paddingRight]).toEqual(["44px", "0px", "0px", "4px", "8px"]);
    expect(getComputedStyle(screen.getByText("Sessions")).letterSpacing).toBe("0.32px");
  });

  it("over a subagent's thread: its name, the session above it, its state and Stop", () => {
    const thread = sessionAgents([agent("a1", "Dress the floor")], { status: "running", asked: new Set() })[0];
    const onMain = vi.fn();
    const onStop = vi.fn();
    renderInProject(<ChatHeader title="Cave door" thread={thread} onSessions={() => undefined} onMain={onMain} onStop={onStop} />);
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
      <Threads agents={sessionAgents(transcript, { status: "running", asked: new Set(), tokens: { a1: 3000 } })} thread={null} onThread={onThread} onStop={onStop} seen={new Set(["a2"])} onDismiss={onDismiss} tokens={{ main: 12_000 }} context={{ main: { input: 41_000, cached: 0, output: 900, model: "m", at: "2026-11-04T12:00:00Z" } as ContextUsage }} />,
    );
    expect(screen.getByText(/^context 4\d/)).toBeTruthy();
    expect(screen.getByText("3.0k spent")).toBeTruthy();
    // A row's calls and tokens stay on one line each (.agents-meta, .agents-tokens: nowrap).
    for (const meta of [screen.getByText("3.0k spent"), screen.getByText(/^\d+ calls?, /)]) expect(getComputedStyle(meta).whiteSpace).toBe("nowrap");
    // Main's numbers sit beside its name, as the web's main row has no spacer.
    const main = screen.getByLabelText("Main");
    expect(main.children[1].textContent).toBe("Main");
    expect(main.children[2].textContent).toMatch(/^context /);
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
    const { container } = renderInProject(<Threads agents={[]} thread={null} onThread={() => undefined} onStop={() => undefined} seen={new Set()} />);
    expect(container.textContent).toBe("");
  });
});

describe("QueuedMessages", () => {
  const queue: QueuedMessage[] = [{ id: "q1", text: "Then tint the fog", attachments: [], at: "2026-11-04T12:00:00Z" } as QueuedMessage, { id: "q2", text: "", attachments: [{ id: "f" }], at: "2026-11-04T12:00:00Z" } as unknown as QueuedMessage];
  it("edits, removes, and sends the next one once the turn has stopped", () => {
    const onEdit = vi.fn();
    const onRemove = vi.fn();
    const onSendNext = vi.fn();
    renderInProject(<QueuedMessages queue={queue} busy={false} onEdit={onEdit} onRemove={onRemove} onSendNext={onSendNext} onSendNow={() => undefined} />);
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

  it("sends any one row now, while a turn runs and when idle, with a finger-sized button", () => {
    const onSendNow = vi.fn();
    const first = renderInProject(<QueuedMessages queue={queue} busy onEdit={() => undefined} onRemove={() => undefined} onSendNext={() => undefined} onSendNow={onSendNow} />);
    const now = screen.getByLabelText("Send queued message 2 now");
    expect(now.textContent).toBe("Send now");
    expect(getComputedStyle(now).minHeight).toBe("44px");
    fireEvent.click(now);
    expect(onSendNow).toHaveBeenCalledWith("q2");
    first.unmount();
    renderInProject(<QueuedMessages queue={queue} busy={false} onEdit={() => undefined} onRemove={() => undefined} onSendNext={() => undefined} onSendNow={onSendNow} />);
    fireEvent.click(screen.getByLabelText("Send queued message 1 now"));
    expect(onSendNow).toHaveBeenLastCalledWith("q1");
  });

  it("says the queue goes one by one while a turn runs, without Send next", () => {
    renderInProject(<QueuedMessages queue={queue} busy onEdit={() => undefined} onRemove={() => undefined} onSendNext={() => undefined} onSendNow={() => undefined} />);
    expect(screen.getByText("Queued (2), sent one by one as each turn completes")).toBeTruthy();
    expect(screen.queryByLabelText("Send next")).toBeNull();
  });
});

describe("ContextMeter", () => {
  const usage = (input: number): ContextUsage => ({ input, cached: input * 0.9, output: 2400, model: "claude-sonnet-5-5", at: "2026-11-04T12:00:00Z" }) as ContextUsage;
  const totals = { input: 412_000, cacheRead: 18_400_000, cacheWrite: 690_000, output: 96_300, reasoning: 41_200, requests: 214, costUsd: 12.37 };

  it("shows how full the context is and opens its numbers and the session totals", () => {
    const onCompact = vi.fn();
    renderInProject(<ContextMeter context={usage(698_000)} totals={totals} model="claude-sonnet-5-5" listedWindow={1_000_000} busy={false} compacting={false} runtime={false} onCompact={onCompact} />);
    // The ring alone: the percentage is in its label, not in words beside it.
    expect(screen.queryByText("70%")).toBeNull();
    fireEvent.click(screen.getByLabelText(/^Context 70% full/));
    expect(screen.getByText("Session totals")).toBeTruthy();
    expect(screen.getByText("$12.37")).toBeTruthy();
    expect(screen.getByText(/Studio compacts it on its own at 850k tokens \(85%\)/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Compact now"));
    expect(onCompact).toHaveBeenCalled();
  });

  it("draws the ring: the fill as an arc of the circle, a tick where it compacts, and nothing beside it", () => {
    const { container } = renderInProject(<ContextMeter context={usage(698_000)} totals={totals} model="claude-sonnet-5-5" listedWindow={1_000_000} busy={false} compacting={false} runtime={false} onCompact={() => undefined} />);
    const circles = [...container.querySelectorAll("circle")];
    expect(circles).toHaveLength(2);
    const c = 2 * Math.PI * 6;
    const [dash, gap] = (circles[1].getAttribute("stroke-dasharray") ?? "").split(/[ ,]+/).map(Number);
    expect(dash).toBeCloseTo(contextView(usage(698_000), "claude-sonnet-5-5", 1_000_000)!.fraction * c, 3);
    expect(gap).toBeCloseTo(c, 3);
    expect(container.querySelectorAll("line")).toHaveLength(1);
    expect(screen.queryByText(/\d+k\/1M/)).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("says the percentage and the compaction to a screen reader while it compacts", () => {
    renderInProject(<ContextMeter context={usage(862_000)} totals={totals} model="claude-sonnet-5-5" listedWindow={1_000_000} busy compacting runtime={false} onCompact={() => undefined} />);
    expect(screen.queryByText("86%")).toBeNull();
    expect(screen.queryByText("Compacting")).toBeNull();
    expect(screen.getByLabelText(/^Context 86% full: .* of 1M tokens, compacting$/)).toBeTruthy();
  });

  it("says an estimate in its label and has nothing to show before any measurement", () => {
    renderInProject(<ContextMeter context={{ ...usage(41_000), estimated: true }} totals={undefined} model="claude-sonnet-5-5" listedWindow={1_000_000} busy={false} compacting={false} runtime={false} onCompact={() => undefined} />);
    expect(screen.getByLabelText(/^Context 4% full: .*, estimated$/)).toBeTruthy();
    const { container } = renderInProject(<ContextMeter context={undefined} totals={undefined} model="m" busy={false} compacting={false} runtime={false} onCompact={() => undefined} />);
    expect(container.textContent).toBe("");
  });

  it("is the ring alone in a round 44 dp target in every theme", () => {
    renderInProject(
      <ThemeProvider name="editor">
        <ContextMeter context={usage(68_000)} totals={undefined} model="claude-sonnet-5-5" listedWindow={1_000_000} busy={false} compacting={false} runtime={false} onCompact={() => undefined} />
      </ThemeProvider>,
    );
    const b = screen.getByLabelText(/^Context 7% full/);
    expect([getComputedStyle(b).width, getComputedStyle(b).height]).toEqual(["44px", "44px"]);
    expect(screen.queryByText("7%")).toBeNull();
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
    expect(screen.getByText("1 file was changed outside the agent and left as they are.")).toBeTruthy();
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
    expect(screen.getByRole("checkbox").querySelector("polyline")).toBeTruthy();
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

  it("draws every mark the same way: the dot beside a one-line subject, the time and the action on the line under it", async () => {
    const api = fakeApi();
    api.reviewStatus.mockResolvedValue({ default: true });
    const long = "I just noticed the Main thread here is claiming 1.7M tokens. Can you check where they went and why the meter disagrees?";
    const timeline: TimelineMark[] = [
      { checkpoint: "c1", label: long, at: "2026-11-04T12:00:00Z", kind: "turn", turn: 0 },
      { checkpoint: "c2", label: "okay build the playtest", at: "2026-11-04T12:05:00Z", kind: "turn", turn: 1 },
    ];
    renderInProject(<ReviewPanel sessionId="s1" review={null} timeline={timeline} onChanged={() => undefined} />, api);
    await settle();
    const marks = screen.getAllByTestId("timeline-mark");
    expect(marks).toHaveLength(2);
    for (const mark of marks) {
      const [first, foot] = Array.from(mark.children) as HTMLElement[];
      // The first line holds the dot and the subject, nothing else, so the dot is never alone on a line.
      expect(first.children).toHaveLength(2);
      expect(first.children[0].getAttribute("data-testid")).toBe("timeline-dot");
      const label = first.children[1] as HTMLElement;
      expect(label.getAttribute("data-testid")).toBe("timeline-label");
      // numberOfLines={1}: one line, cut with an ellipsis (react-native-web draws it as nowrap + text-overflow).
      expect(getComputedStyle(label).whiteSpace).toBe("nowrap");
      expect(getComputedStyle(label).textOverflow).toBe("ellipsis");
      // The time and Restore share the second line, whatever the subject's length.
      expect(foot.getAttribute("data-testid")).toBe("timeline-foot");
      expect(foot.textContent).toMatch(/^Turn .*Restore to here$/);
    }
    // Restore is a small button: 32 px drawn, a 44 px target through its hit slop.
    for (const b of screen.getAllByLabelText("Restore to here")) expect(getComputedStyle(b).height).toBe("32px");
    // Newest first.
    expect(screen.getAllByTestId("timeline-label")[0].textContent).toBe("okay build the playtest");
    expect(screen.getAllByTestId("timeline-label")[1].textContent).toBe(long);
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

  it("sets an example's caret inline in its text, so a second line wraps under it as the web's ::before does", async () => {
    const api = fakeApi();
    api.sessions.mockResolvedValue({ sessions: [] });
    api.settings.mockResolvedValue(settings);
    api.models.mockResolvedValue({ signedIn: {}, providers: [] });
    renderInProject(<Chat />, api);
    await settle();
    const carets = screen.getAllByTestId("example-caret");
    expect(carets).toHaveLength(3);
    expect(carets[0].parentElement!.textContent).toBe("›Make a glowing orange material and put it on a sphere in the level");
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

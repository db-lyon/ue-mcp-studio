import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, renderHook, screen } from "@testing-library/react";
import { BOTTOM_SLACK, useFollow } from "../src/chat/hooks";
import type { ApprovalRequest, EditorDialog, PendingForm, TranscriptEntry } from "@ue-mcp-studio/shared";
import { AssetLinks } from "@ue-mcp-studio/client-core";
import { Markdown } from "../src/ui";
import { DiffView } from "../src/chat/Diff";
import { EditMessageContext, MainTranscript, SubagentThread, ToolCall } from "../src/chat/Transcript";
import { CompactContext, CompactionMarker } from "../src/screens/chat/items";
import { Approvals } from "../src/screens/chat/items";
import { DialogCard, DialogLine } from "../src/screens/chat/items";
import { FormCards } from "../src/screens/chat/items";
import { AskedContext } from "../src/chat/asked";
import { breakable, EngineText } from "../src/chat/breakable";
import { SessionIdContext } from "../src/chat/attachments";
import { AssetLinksContext, AssetTranscriptContext } from "../src/chat/asset-links";
import { AssetToken } from "../src/chat/AssetLink";
import { AssetTile } from "../src/chat/AssetTile";
import * as clipboard from "./mocks/clipboard";
import { fakeApi, renderInProject, settle } from "./helpers";
import { ProjectContext } from "../src/nav";

const at = "2026-11-04T12:00:00Z";
type Compaction = Extract<TranscriptEntry, { kind: "compaction" }>;

function transcriptProps(transcript: TranscriptEntry[], over: Partial<Parameters<typeof MainTranscript>[0]> = {}) {
  return { transcript, status: "idle" as const, streaming: "", waitingCause: null, error: null, onOpen: vi.fn(), hidden: false, ...over };
}

describe("Markdown", () => {
  it("renders through the web's pipeline: emphasis, inline code, lists, breaks and ## as a label", () => {
    renderInProject(<Markdown text={"## Plan\nFirst **bold** and `code`\nsecond line\n\n- one\n- two"} />);
    expect(screen.getByText("Plan")).toBeTruthy();
    expect(screen.getByText("bold")).toBeTruthy();
    expect(screen.getByText("code")).toBeTruthy();
    // remark-breaks: the single line break stays.
    expect(screen.getByText(/second line/).textContent).toContain("\n");
    expect(screen.getByText("one")).toBeTruthy();
    expect(screen.getAllByTestId("md-bullet")).toHaveLength(2);
  });

  it("collapses a soft break to a space without remark-breaks", () => {
    renderInProject(<Markdown text={"a\nb"} breaks={false} />);
    expect(screen.getByText("a b")).toBeTruthy();
  });

  it("marks asset names for the caller with the asset plugin", () => {
    const seen: string[] = [];
    renderInProject(<Markdown text={"Open `BP_Door` and [the door](/Game/Props/BP_Door.BP_Door)"} assets renderAsset={(m, k) => (seen.push(m.kind === "exact" ? m.path : m.token), <span key={k}>{m.kind}</span>)} />);
    expect(seen).toEqual(["BP_Door", "/Game/Props/BP_Door.BP_Door"]);
  });
});

describe("breakable", () => {
  it("allows a break after each dot and underscore, and an engine name only between its parts", () => {
    expect(breakable("a.b_c")).toBe("a.\u200bb_\u200bc");
    expect(breakable("plain")).toBe("plain");
    renderInProject(<EngineText text="/Game/A.B" />);
    expect(screen.getByText("/\u200bGame/\u200bA.\u200bB")).toBeTruthy();
  });
});

describe("DiffView", () => {
  it("draws signs, lines and the left-out run, and says No change when empty", () => {
    const { unmount } = renderInProject(<DiffView lines={[{ op: "-", text: "old" }, { op: "+", text: "new" }, { op: "gap", count: 3 }]} label="Edit" />);
    expect(screen.getByText("old")).toBeTruthy();
    expect(screen.getByText("new")).toBeTruthy();
    expect(screen.getByText(/3 unchanged lines/)).toBeTruthy();
    unmount();
    renderInProject(<DiffView lines={[]} />);
    expect(screen.getByText("No change.")).toBeTruthy();
  });
});

describe("MainTranscript", () => {
  const talk: TranscriptEntry[] = [
    { kind: "user", text: "Fix the door", at },
    { kind: "tool", call: { id: "c1", name: "shell", input: { command: "git grep OpenAngle" }, outcome: "done", result: "a.cpp:41\nb.h:28", startedAt: at, endedAt: at } },
    { kind: "assistant", text: "Done. The **door** opens.", at },
    { kind: "note", text: "The editor restarted.", at },
  ];

  it("draws the user's message, the reply as markdown, tool rows and notes", () => {
    renderInProject(<MainTranscript {...transcriptProps(talk)} />);
    expect(screen.getByText("Fix the door")).toBeTruthy();
    expect(screen.getByText("door")).toBeTruthy();
    expect(screen.getByText("shell")).toBeTruthy();
    expect(screen.getByText("git grep OpenAngle")).toBeTruthy();
    expect(screen.getByText("done")).toBeTruthy();
    expect(screen.getByText("The editor restarted.")).toBeTruthy();
  });

  it("paints its scroller in the panel colour, so a GPU-scrolled list keeps subpixel text", () => {
    const { container } = renderInProject(<MainTranscript {...transcriptProps(talk)} />);
    expect(getComputedStyle(container.querySelector("#transcript")!).backgroundColor).toBe("rgb(19, 19, 18)");
  });

  it("opens a call to its command, output and Copy", async () => {
    renderInProject(<MainTranscript {...transcriptProps(talk)} />);
    fireEvent.click(screen.getByText("shell"));
    expect(screen.getByText("$ git grep OpenAngle")).toBeTruthy();
    expect(screen.getByText("Output, 2 lines")).toBeTruthy();
    fireEvent.click(screen.getByText("Copy"));
    await settle();
    expect(clipboard.copied).toBe("a.cpp:41\nb.h:28");
    expect(screen.getByText("Copied")).toBeTruthy();
  });

  it("opens an edit as its diff", () => {
    renderInProject(<ToolCall call={{ id: "e", name: "edit_file", input: { path: "a.cpp", old_string: "x = 1;", new_string: "x = 2;" }, outcome: "done", result: "Edited 1 place.", startedAt: at }} />);
    fireEvent.click(screen.getByText("edit"));
    expect(screen.getByText("x = 1;")).toBeTruthy();
    expect(screen.getByText("x = 2;")).toBeTruthy();
    expect(screen.getByText("Result, 1 line")).toBeTruthy();
  });

  it("fetches a long result the session left out the first time the call opens", async () => {
    const api = fakeApi();
    api.callResult.mockResolvedValue({ result: "the whole output" });
    renderInProject(
      <SessionIdContext.Provider value="s1">
        <ToolCall call={{ id: "big", name: "shell", input: { command: "ls" }, outcome: "done", resultSize: 400_000, startedAt: at }} />
      </SessionIdContext.Provider>,
      api,
    );
    fireEvent.click(screen.getByText("shell"));
    expect(screen.getByText("Loading the result, 391 KB")).toBeTruthy();
    await settle();
    expect(api.callResult).toHaveBeenCalledWith("s1", "big");
    expect(screen.getByText("the whole output")).toBeTruthy();
  });

  it("shortens a long result, with Show all", () => {
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    renderInProject(<ToolCall call={{ id: "l", name: "shell", input: { command: "x" }, outcome: "done", result: long, startedAt: at }} />);
    fireEvent.click(screen.getByText("shell"));
    expect(screen.queryByText(/line 39/)).toBeNull();
    fireEvent.click(screen.getByText("Show all 40 lines"));
    expect(screen.getByText(/line 39/)).toBeTruthy();
    expect(screen.getByText("Show less")).toBeTruthy();
  });

  it("streams the turn's text and says what it waits on", () => {
    renderInProject(
      <AskedContext.Provider value={new Set(["t1", "t2"])}>
        <MainTranscript {...transcriptProps(talk, { status: "waiting", streaming: "Working on it", waitingCause: "the editor is closed" })} />
      </AskedContext.Provider>,
    );
    expect(screen.getByText("Working on it")).toBeTruthy();
    expect(screen.getByText("Waiting on you: 2 calls need your approval below.")).toBeTruthy();
    expect(screen.getByText("Waiting for editor: the editor is closed. The turn continues when it is back.")).toBeTruthy();
  });

  it("shows the turn's error", () => {
    renderInProject(<MainTranscript {...transcriptProps(talk, { status: "error", error: "The model refused." })} />);
    expect(screen.getByText("The model refused.")).toBeTruthy();
  });

  it("folds a finished turn's progress messages", () => {
    const turn: TranscriptEntry[] = [
      { kind: "user", text: "Go", at },
      { kind: "assistant", text: "Looking first.", at },
      { kind: "tool", call: { id: "c", name: "agent", input: { description: "Look" }, outcome: "done", result: "x", startedAt: at, endedAt: at } },
      { kind: "assistant", text: "All done.", at },
    ];
    renderInProject(<MainTranscript {...transcriptProps(turn)} />);
    expect(screen.queryByText("Looking first.")).toBeNull();
    fireEvent.click(screen.getByText("1 progress update"));
    expect(screen.getByText("Looking first.")).toBeTruthy();
  });

  it("opens a subagent's thread from its row", () => {
    const onOpen = vi.fn();
    const turn: TranscriptEntry[] = [{ kind: "tool", call: { id: "ag", name: "agent", input: { description: "Dress the cave", prompt: "Place rocks" }, outcome: "pending", startedAt: at } }];
    renderInProject(<MainTranscript {...transcriptProps(turn, { status: "running", onOpen })} />);
    expect(screen.getByText("Dress the cave")).toBeTruthy();
    fireEvent.click(screen.getByText("Open thread \u203a"));
    expect(onOpen).toHaveBeenCalledWith("ag");
  });

  it("edits a message: rewinds at once when it is the last, asks rewind or fork otherwise", () => {
    const onEdit = vi.fn();
    const two: TranscriptEntry[] = [{ kind: "user", text: "First", at }, { kind: "assistant", text: "Reply", at }];
    renderInProject(
      <AssetTranscriptContext.Provider value={two}>
        <EditMessageContext.Provider value={onEdit}>
          <MainTranscript {...transcriptProps(two)} />
        </EditMessageContext.Provider>
      </AssetTranscriptContext.Provider>,
    );
    fireEvent.click(screen.getByLabelText("Edit this message"));
    fireEvent.change(screen.getByLabelText("Edit your message"), { target: { value: "First, again" } });
    fireEvent.click(screen.getByText("Save and send"));
    expect(screen.getByText("Fork a new session")).toBeTruthy();
    fireEvent.click(screen.getByText("Fork a new session"));
    expect(onEdit).toHaveBeenCalledWith(0, "First, again", "fork");
  });

  it("shows New messages when a line arrives while the reader is up the thread", () => {
    const view = renderInProject(<MainTranscript {...transcriptProps(talk)} />);
    const inProject = (ui: React.ReactNode) => <ProjectContext.Provider value={view.nav}>{ui}</ProjectContext.Provider>;
    const list = document.getElementById("transcript")!;
    Object.defineProperty(list, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(list, "clientHeight", { value: 500, configurable: true });
    Object.defineProperty(list, "offsetHeight", { value: 500, configurable: true });
    // Inverted: offset 0 is the newest line, so up the thread is a larger offset.
    list.scrollTop = 1000;
    fireEvent.scroll(list);
    act(() => view.rerender(inProject(<MainTranscript {...transcriptProps([...talk, { kind: "assistant", text: "More", at }])} />)));
    expect(screen.queryByText("New messages \u2193")).toBeTruthy();
  });
});

describe("SubagentThread", () => {
  it("draws the task, its steps and how it ended", () => {
    const call = { id: "ag", name: "agent", input: { description: "Dress the cave", prompt: "Place rocks" }, outcome: "done" as const, startedAt: at, endedAt: at };
    const steps: TranscriptEntry[] = [{ kind: "tool", call }, { kind: "assistant", text: "Placed 14 rocks.", at, parent: "ag" }];
    renderInProject(<SubagentThread call={call} transcript={steps} sessionWaiting={false} onBack={vi.fn()} onStop={vi.fn()} />);
    expect(screen.getByText("Task from the main agent")).toBeTruthy();
    expect(screen.getByText("Place rocks")).toBeTruthy();
    expect(screen.getByText("Placed 14 rocks.")).toBeTruthy();
    expect(screen.getByText("Reported back to the main agent.")).toBeTruthy();
  });
});

describe("CompactionMarker", () => {
  const entry = (over: Partial<Compaction> = {}) => ({ kind: "compaction", at, trigger: "auto", state: "done", before: 852_300, after: 21_400, summary: "**Asked for:** a door", method: "summary", model: "Sonnet 5.5", ms: 23_000, ...over }) as Compaction;

  it("collapsed: the numbers, the trigger and Summary; opened: who summarised it and the summary", () => {
    renderInProject(<CompactionMarker entry={entry({ trigger: "manual", instructions: "the paths" })} />);
    expect(screen.getByText("Context compacted")).toBeTruthy();
    expect(screen.getByText("852k \u2192 21k tokens")).toBeTruthy();
    expect(screen.getByText(/^by you, /)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Context compacted"));
    expect(screen.getByText(/Sonnet 5\.5 summarised the conversation in 23s/)).toBeTruthy();
    expect(screen.getByText(/You asked it to keep: the paths/)).toBeTruthy();
    expect(screen.getByText("Asked for:")).toBeTruthy();
    fireEvent.click(screen.getByText("Hide summary"));
    expect(screen.queryByText("Asked for:")).toBeNull();
  });

  it("running: says so and cannot open", () => {
    renderInProject(<CompactionMarker entry={entry({ state: "running", after: undefined, summary: undefined })} />);
    expect(screen.getByText("Compacting context")).toBeTruthy();
    expect(screen.getByText("852k tokens, summarising")).toBeTruthy();
    expect(screen.queryByText("Summary")).toBeNull();
  });

  it("failed: why, that nothing was cut, and Try again", () => {
    const retry = vi.fn();
    renderInProject(
      <CompactContext.Provider value={retry}>
        <CompactionMarker entry={entry({ state: "failed", after: undefined, summary: undefined, error: "Overloaded." })} />
      </CompactContext.Provider>,
    );
    fireEvent.click(screen.getByText("Why"));
    expect(screen.getByText(/Overloaded\. Nothing was cut/)).toBeTruthy();
    fireEvent.click(screen.getByText("Try again"));
    expect(retry).toHaveBeenCalled();
  });
});

describe("Approvals", () => {
  const approvals: ApprovalRequest[] = [
    { id: "ap1", toolUseId: "t1", tool: "edit_file", parent: null, at, path: "a.cpp", diff: [{ op: "+", text: "x = 2;" }] },
    { id: "ap2", toolUseId: "t2", tool: "shell", parent: null, at, command: "npm run build", cwd: "C:/p" },
  ];

  it("shows each call waiting and sends Allow, Allow for this session or Deny", async () => {
    const api = fakeApi();
    api.approve.mockResolvedValue({});
    renderInProject(<Approvals sessionId="s1" approvals={approvals} />, api);
    expect(screen.getByText("a.cpp")).toBeTruthy();
    expect(screen.getByText("x = 2;")).toBeTruthy();
    expect(screen.getByText("$ npm run build")).toBeTruthy();
    expect(screen.getByText("in C:/p")).toBeTruthy();
    fireEvent.click(screen.getAllByText("Allow")[0]);
    fireEvent.click(screen.getAllByText("Deny")[1]);
    await settle();
    expect(api.approve).toHaveBeenCalledWith("s1", "ap1", "allow");
    expect(api.approve).toHaveBeenCalledWith("s1", "ap2", "deny");
  });

  it("puts a failed answer back with its error", async () => {
    const api = fakeApi();
    api.approve.mockRejectedValue(new Error("Session ended"));
    renderInProject(<Approvals sessionId="s1" approvals={approvals.slice(1)} />, api);
    fireEvent.click(screen.getByText("Allow for this session"));
    await settle();
    expect(screen.getByText("Session ended")).toBeTruthy();
  });
});

describe("Dialogs", () => {
  const dialog: EditorDialog = { id: "d1", sessionId: "s1", title: "Save content?", message: "Save these assets?", buttons: ["Save", "Don't Save"], steps: [], held: null, items: [], editor: "UnrealEditor", openedAt: at, asking: { since: 0, minHumanMs: 0, deadline: null, policy: { kind: "safe" } } } as unknown as EditorDialog;

  it("presses one of the dialog's buttons", async () => {
    const api = fakeApi();
    api.answerDialog.mockResolvedValue({});
    renderInProject(<DialogCard dialog={dialog} now={Date.parse(at)} />, api);
    expect(screen.getByText("Save content?")).toBeTruthy();
    expect(screen.getByText("Save these assets?")).toBeTruthy();
    fireEvent.click(screen.getByText("Don't Save"));
    await settle();
    expect(api.answerDialog).toHaveBeenCalledWith("d1", { answer: "press", button: "Don't Save" });
  });

  it("draws a closed dialog as a line in the transcript", () => {
    renderInProject(<DialogLine dialog={dialog} />);
    expect(screen.getByText("Editor dialog")).toBeTruthy();
    expect(screen.getByText("Save content?")).toBeTruthy();
  });
});

describe("FormCards", () => {
  it("fills a form and submits or declines it", async () => {
    const api = fakeApi();
    api.answerForm.mockResolvedValue({});
    const form = { id: "f1", sessionId: "s1", call: "feedback.submit", message: "Send this report?", fields: { note: { type: "string", title: "Note" }, count: { type: "integer", title: "Count" } }, required: ["note"], at } as unknown as PendingForm;
    renderInProject(<FormCards forms={[form]} />, api);
    expect(screen.getByText("Your answer is needed")).toBeTruthy();
    expect(screen.getByText("Send this report?")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Note"), { target: { value: "door" } });
    fireEvent.change(screen.getByLabelText("Count"), { target: { value: "3" } });
    fireEvent.click(screen.getByText("Submit"));
    await settle();
    expect(api.answerForm).toHaveBeenCalledWith("f1", { action: "accept", content: { note: "door", count: 3 } });
  });
});

describe("AssetTile", () => {
  it("names the asset's kind, path, what changed and its facts, the changed ones with what they were", () => {
    renderInProject(
      <AssetTile cls="Blueprint" fileName="BP_Door.uasset" path="/Game/BP_Door" status="modified" changes={[{ text: "1 node added", tone: "add" }]} facts={[{ name: "Parent", value: "Actor" }, { name: "Speed", value: "2", was: "1" }]} />,
    );
    expect(screen.getByLabelText("Blueprint BP_Door.uasset")).toBeTruthy();
    expect(screen.getByText("Changed in this turn")).toBeTruthy();
    expect(screen.getByText("/​Game/​BP_​Door")).toBeTruthy();
    expect(screen.getByText("1 node added")).toBeTruthy();
    expect(screen.getByText("Parent")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getAllByText((_, el) => el?.textContent === "1 to 2").length).toBeGreaterThan(0);
  });
});

describe("AssetToken", () => {
  it("stays plain until resolved, then opens the asset in the editor", async () => {
    const api = fakeApi();
    api.openAsset.mockResolvedValue({ opened: "/Game/BP_Door.BP_Door" });
    const store = new AssetLinks(async () => [{ status: "resolved", paths: ["/Game/BP_Door.BP_Door"] }] as never, "s1", 0);
    renderInProject(
      <AssetLinksContext.Provider value={store}>
        <AssetToken token="BP_Door" code />
      </AssetLinksContext.Provider>,
      api,
    );
    await settle();
    await settle();
    fireEvent.click(screen.getByLabelText("/Game/BP_Door.BP_Door"));
    await settle();
    expect(api.openAsset).toHaveBeenCalledWith("/Game/BP_Door.BP_Door");
  });
});

describe("useFollow", () => {
  /** The hook over a stand-in inverted list, at its newest line. */
  function follow() {
    const scrollToOffset = vi.fn();
    const r = renderHook(({ content, snap }: { content: string; snap?: number }) => useFollow(content, snap), { initialProps: { content: "1", snap: 0 } });
    (r.result.current.ref as { current: unknown }).current = { scrollToOffset };
    const scrolled = (y: number) => act(() => r.result.current.props.onScroll({ nativeEvent: { contentOffset: { x: 0, y } } } as never));
    return { ...r, scrollToOffset, scrolled };
  }

  it("keeps the newest line in view at the bottom and says New messages up the thread", () => {
    const f = follow();
    f.rerender({ content: "2", snap: 0 });
    expect(f.scrollToOffset).toHaveBeenLastCalledWith({ offset: 0, animated: false });
    expect(f.result.current.behind).toBe(false);
    f.scrolled(BOTTOM_SLACK + 200);
    expect(f.result.current.up).toBe(true);
    f.scrollToOffset.mockClear();
    f.rerender({ content: "3", snap: 0 });
    expect(f.scrollToOffset).not.toHaveBeenCalled();
    expect(f.result.current.behind).toBe(true);
    f.scrolled(0);
    expect(f.result.current.behind).toBe(false);
    expect(f.result.current.up).toBe(false);
  });

  it("takes the reader back down on a send and on New messages", () => {
    const f = follow();
    f.scrolled(900);
    f.rerender({ content: "1", snap: 1 });
    expect(f.scrollToOffset).toHaveBeenLastCalledWith({ offset: 0, animated: false });
    expect(f.result.current.up).toBe(false);
    f.scrolled(900);
    f.rerender({ content: "2", snap: 1 });
    expect(f.result.current.behind).toBe(true);
    f.scrollToOffset.mockClear();
    act(() => f.result.current.jump());
    expect(f.scrollToOffset).toHaveBeenCalledWith({ offset: 0, animated: false });
    expect(f.result.current.behind).toBe(false);
  });
});

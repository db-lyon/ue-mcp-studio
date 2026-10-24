// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { TimelineMark, TurnReview } from "@ue-mcp-studio/shared";

const m = vi.hoisted(() => ({
  reviewKeep: vi.fn(),
  reviewRevert: vi.fn(),
  reviewUndo: vi.fn(),
  reviewDiff: vi.fn(),
  reviewStatus: vi.fn(),
  setSessionReview: vi.fn(),
  timelineRestore: vi.fn(),
  timelineUndo: vi.fn(),
  reviewImageUrl: (name: string) => `/v1/ext/studio/review/images/${name}`,
}));
vi.mock("../api", () => ({ api: m }));
import { ItemDiff, ReviewPanel, TurnReviewCard } from "./TurnReview";
import { SessionIdContext } from "./attachments";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const REVIEW: TurnReview = {
  id: "r1",
  turn: 0,
  before: "a".repeat(40),
  after: "b".repeat(40),
  at: "2026-10-24T10:00:00.000Z",
  items: [
    { path: "Config/DefaultGame.ini", status: "modified", kind: "config", group: "config", state: "pending" },
    { path: "Content/BP_Door.uasset", status: "modified", kind: "package", group: "blueprint", state: "pending", asset: "/Game/BP_Door.BP_Door" },
    { path: "Content/SM_Box.uasset", status: "added", kind: "package", group: "asset", state: "pending", asset: "/Game/SM_Box.SM_Box", visual: true },
  ],
};
const none = { restored: [], conflicts: [], missing: [] };
const withItem = (path: string, patch: Partial<TurnReview["items"][number]>): TurnReview => ({ ...REVIEW, items: REVIEW.items.map((i) => (i.path === path ? { ...i, ...patch } : i)) });

const card = (review = REVIEW) => render(<SessionIdContext.Provider value="s1"><TurnReviewCard review={review} /></SessionIdContext.Provider>);
const row = (path: string) => document.querySelector(`[data-path="${path}"]`) as HTMLElement;

describe("the turn card", () => {
  it("lists each change under its group, with Keep and Revert per item and Revert all", () => {
    card();
    expect(screen.getByText("Config")).toBeTruthy();
    expect(screen.getByText("Blueprints")).toBeTruthy();
    expect(screen.getByText("Assets")).toBeTruthy();
    for (const it of REVIEW.items) {
      expect(within(row(it.path)).getByRole("button", { name: "Keep" })).toBeTruthy();
      expect(within(row(it.path)).getByRole("button", { name: "Revert" })).toBeTruthy();
    }
    expect(screen.getByRole("button", { name: "Revert all" })).toBeTruthy();
  });

  it("reverts one item and shows it reverted with Undo revert, the others still open", async () => {
    m.reviewRevert.mockResolvedValue({ review: withItem("Config/DefaultGame.ini", { state: "reverted", undo: "c".repeat(40) }), outcome: { ...none, restored: ["Config/DefaultGame.ini"] } });
    card();
    await act(async () => void fireEvent.click(within(row("Config/DefaultGame.ini")).getByRole("button", { name: "Revert" })));
    expect(m.reviewRevert).toHaveBeenCalledWith("s1", "r1", ["Config/DefaultGame.ini"], false);
    expect(within(row("Config/DefaultGame.ini")).getByText("Reverted")).toBeTruthy();
    expect(within(row("Config/DefaultGame.ini")).getByRole("button", { name: "Undo revert" })).toBeTruthy();
    expect(within(row("Content/BP_Door.uasset")).getByRole("button", { name: "Revert" })).toBeTruthy();

    m.reviewUndo.mockResolvedValue({ review: REVIEW, outcome: { ...none, restored: ["Config/DefaultGame.ini"] } });
    await act(async () => void fireEvent.click(within(row("Config/DefaultGame.ini")).getByRole("button", { name: "Undo revert" })));
    expect(m.reviewUndo).toHaveBeenCalledWith("s1", "r1", "Config/DefaultGame.ini");
    expect(within(row("Config/DefaultGame.ini")).getByRole("button", { name: "Revert" })).toBeTruthy();
  });

  it("keeps an item", async () => {
    m.reviewKeep.mockResolvedValue({ review: withItem("Content/BP_Door.uasset", { state: "kept" }) });
    card();
    await act(async () => void fireEvent.click(within(row("Content/BP_Door.uasset")).getByRole("button", { name: "Keep" })));
    expect(m.reviewKeep).toHaveBeenCalledWith("s1", "r1", ["Content/BP_Door.uasset"]);
    expect(within(row("Content/BP_Door.uasset")).getByText("Kept")).toBeTruthy();
  });

  it("Revert all sends every item not reverted yet", async () => {
    m.reviewRevert.mockResolvedValue({ review: REVIEW, outcome: none });
    card(withItem("Content/SM_Box.uasset", { state: "reverted", undo: "c".repeat(40) }));
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Revert all" })));
    expect(m.reviewRevert).toHaveBeenCalledWith("s1", "r1", ["Config/DefaultGame.ini", "Content/BP_Door.uasset"], false);
  });

  it("shows a file the user edited after the agent, and reverts it only after a confirmed second click", async () => {
    card(withItem("Config/DefaultGame.ini", { conflict: true }));
    const r = row("Config/DefaultGame.ini");
    expect(within(r).getByRole("alert").textContent).toMatch(/You edited this file after the agent/);
    expect(within(r).queryByRole("button", { name: "Revert" })).toBeNull();
    fireEvent.click(within(r).getByRole("button", { name: "Revert anyway" }));
    expect(m.reviewRevert).not.toHaveBeenCalled();
    m.reviewRevert.mockResolvedValue({ review: withItem("Config/DefaultGame.ini", { state: "reverted" }), outcome: { ...none, restored: ["Config/DefaultGame.ini"] } });
    await act(async () => void fireEvent.click(within(r).getByRole("button", { name: "Revert and lose my edits" })));
    expect(m.reviewRevert).toHaveBeenCalledWith("s1", "r1", ["Config/DefaultGame.ini"], true);
  });

  it("says what a revert left alone", async () => {
    m.reviewRevert.mockResolvedValue({ review: withItem("Config/DefaultGame.ini", { conflict: true }), outcome: { ...none, conflicts: ["Config/DefaultGame.ini"] } });
    card();
    await act(async () => void fireEvent.click(within(row("Config/DefaultGame.ini")).getByRole("button", { name: "Revert" })));
    expect(screen.getByText("1 file was edited after the agent and left as they are.")).toBeTruthy();
  });
});

describe("the diff view", () => {
  const diffOf = async (item: TurnReview["items"][number]) => {
    await act(async () => void render(<ItemDiff sessionId="s1" reviewId="r1" item={item} />));
  };

  it("shows a text diff for config and source", async () => {
    m.reviewDiff.mockResolvedValue({ change: { path: "Config/DefaultGame.ini", status: "modified", kind: "config", diff: "@@ -1,1 +1,1 @@\n-Speed=1\n+Speed=2" } });
    await diffOf(REVIEW.items[0]);
    const pre = screen.getByLabelText("Diff of Config/DefaultGame.ini");
    expect(pre.textContent).toContain("- Speed=1");
    expect(pre.textContent).toContain("+ Speed=2");
  });

  it("shows the Blueprint diff for a Blueprint", async () => {
    m.reviewDiff.mockResolvedValue({ change: { path: "Content/BP_Door.uasset", status: "modified", kind: "package", blueprintDiff: { variables: { added: ["OpenAngle"] }, graphs: [] } } });
    await diffOf(REVIEW.items[1]);
    const list = screen.getByLabelText("Blueprint diff");
    expect(list.textContent).toContain("variables");
    expect(list.textContent).toContain("OpenAngle");
  });

  it("shows before and after pictures for a mesh, and says when there is no earlier one", async () => {
    m.reviewDiff.mockResolvedValue({ change: { path: "Content/SM_Box.uasset", status: "added", kind: "package" }, after: "abc-def-1.png" });
    await diffOf(REVIEW.items[2]);
    expect((screen.getByAltText("SM_Box.uasset after the turn") as HTMLImageElement).src).toContain("/v1/ext/studio/review/images/abc-def-1.png");
    expect(screen.getByText("No picture from before this turn.")).toBeTruthy();
  });
});

describe("the timeline", () => {
  const MARKS: TimelineMark[] = [
    { checkpoint: "1".repeat(40), label: "Make the door", at: "2026-10-24T10:00:00.000Z", kind: "turn", turn: 0 },
    { checkpoint: "2".repeat(40), label: "Fix the hinge", at: "2026-10-24T10:05:00.000Z", kind: "turn", turn: 4 },
    { checkpoint: "3".repeat(40), label: "Restored to: Make the door", at: "2026-10-24T10:06:00.000Z", kind: "restore", undo: "4".repeat(40) },
  ];
  const panel = async (review: boolean | null = null, onChanged = vi.fn()) => {
    m.reviewStatus.mockResolvedValue({ available: true, default: true });
    await act(async () => void render(<ReviewPanel sessionId="s1" review={review} timeline={MARKS} onChanged={onChanged} />));
    return onChanged;
  };

  it("lists the marks newest first, a restore with Undo and each turn with Restore to here", async () => {
    await panel();
    const items = screen.getAllByRole("listitem");
    expect(items.map((li) => li.querySelector(".timeline-label")?.textContent)).toEqual(["Restored to: Make the door", "Fix the hinge", "Make the door"]);
    expect(within(items[0]).getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(within(items[1]).getByRole("button", { name: "Restore to here" })).toBeTruthy();
  });

  it("restores to a turn after a confirming click, and undoes a restore", async () => {
    m.timelineRestore.mockResolvedValue({ timeline: MARKS, outcome: { ...none, restored: ["Config/DefaultGame.ini"] } });
    m.timelineUndo.mockResolvedValue({ timeline: MARKS, outcome: none });
    const changed = await panel();
    const items = screen.getAllByRole("listitem");
    fireEvent.click(within(items[2]).getByRole("button", { name: "Restore to here" }));
    expect(m.timelineRestore).not.toHaveBeenCalled();
    await act(async () => void fireEvent.click(within(items[2]).getByRole("button", { name: "Restore every file" })));
    expect(m.timelineRestore).toHaveBeenCalledWith("s1", "1".repeat(40), false);
    await act(async () => void fireEvent.click(within(screen.getAllByRole("listitem")[0]).getByRole("button", { name: "Undo" })));
    expect(m.timelineUndo).toHaveBeenCalledWith("s1", "3".repeat(40));
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("offers to restore the files edited outside the agent too, with force", async () => {
    m.timelineRestore.mockResolvedValueOnce({ timeline: MARKS, outcome: { ...none, conflicts: ["Config/DefaultGame.ini"] } });
    await panel();
    fireEvent.click(within(screen.getAllByRole("listitem")[1]).getByRole("button", { name: "Restore to here" }));
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Restore every file" })));
    m.timelineRestore.mockResolvedValueOnce({ timeline: MARKS, outcome: none });
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Restore those too" })));
    expect(m.timelineRestore).toHaveBeenLastCalledWith("s1", "2".repeat(40), true);
  });

  it("switches review for the session, back to the default as null", async () => {
    m.setSessionReview.mockResolvedValue({ review: false });
    await panel();
    const box = screen.getByRole("checkbox") as HTMLInputElement;
    expect(box.checked).toBe(true);
    await act(async () => void fireEvent.click(box));
    expect(m.setSessionReview).toHaveBeenCalledWith("s1", false);
    cleanup();
    await panel(false);
    await act(async () => void fireEvent.click(screen.getByRole("checkbox")));
    expect(m.setSessionReview).toHaveBeenLastCalledWith("s1", null);
  });

  it("says why review cannot run on a ue-mcp without checkpoints", async () => {
    m.reviewStatus.mockResolvedValue({ available: false, reason: "This ue-mcp has no checkpoints, so turns cannot be reviewed. Update ue-mcp.", default: true });
    await act(async () => void render(<ReviewPanel sessionId="s1" review={null} timeline={[]} onChanged={() => {}} />));
    expect(screen.getByText(/has no checkpoints/)).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});

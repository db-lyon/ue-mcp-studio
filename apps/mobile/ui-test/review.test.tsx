import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { Alert } from "react-native";
import type { ReviewItem, TurnReview } from "@ue-mcp-studio/shared";
import { ReviewItemScreen, ReviewScreen } from "../src/screens/Review";
import { CheckpointsScreen } from "../src/screens/Checkpoints";
import { fakeApi, renderInProject, session, settle } from "./helpers";

const item = (path: string, over: Partial<ReviewItem> = {}): ReviewItem => ({ path, status: "modified", kind: "package", group: "blueprint", state: "pending", ...over });
const review = (items: ReviewItem[], over: Partial<TurnReview> = {}): TurnReview => ({ id: "r1", turn: 0, before: "c0", after: "c1", at: "2026-11-04T12:00:00Z", items, ...over });

/** Presses the button of the Alert the screen raised, by its text. */
function answerAlert(button: string) {
  const spy = vi.mocked(Alert.alert);
  const buttons = spy.mock.calls.at(-1)?.[2] ?? [];
  buttons.find((b) => b.text === button)?.onPress?.();
}

describe("ReviewScreen", () => {
  it("groups the turn's changes and keeps or reverts one", async () => {
    const api = fakeApi();
    const r = review([item("Content/BP_Door.uasset", { summary: "Speed 1 to 2" }), item("Config/DefaultGame.ini", { kind: "config", group: "config" })]);
    api.reviewKeep.mockResolvedValue({ review: review([item("Content/BP_Door.uasset", { state: "kept" }), r.items[1]]) });
    renderInProject(<ReviewScreen sessionId="s1" review={r} />, api);
    expect(screen.getByText("Blueprints")).toBeTruthy();
    expect(screen.getByText("Config")).toBeTruthy();
    expect(screen.getByText("Speed 1 to 2")).toBeTruthy();
    fireEvent.click(screen.getAllByText("Keep")[0]);
    expect(api.reviewKeep).toHaveBeenCalledWith("s1", "r1", ["Content/BP_Door.uasset"]);
    await settle();
    expect(screen.getByText("Kept")).toBeTruthy();
  });

  it("keeps or reverts everything undecided at once", () => {
    const api = fakeApi();
    renderInProject(<ReviewScreen sessionId="s1" review={review([item("a.uasset"), item("b.uasset"), item("c.uasset", { conflict: true })])} />, api);
    fireEvent.click(screen.getByText("Revert all 2"));
    expect(api.reviewRevert).toHaveBeenCalledWith("s1", "r1", ["a.uasset", "b.uasset"], false);
  });

  it("asks before Revert anyway on a file edited after the agent, and says what was left", async () => {
    const spy = vi.spyOn(Alert, "alert").mockImplementation(() => undefined);
    const api = fakeApi();
    api.reviewRevert.mockResolvedValue({ review: review([item("a.uasset", { state: "reverted", undo: "c0" })]), outcome: { restored: ["a.uasset"], conflicts: [], missing: ["x"] } });
    renderInProject(<ReviewScreen sessionId="s1" review={review([item("a.uasset", { conflict: true })])} />, api);
    expect(screen.getByText(/Edited after the agent changed it/)).toBeTruthy();
    fireEvent.click(screen.getByText("Revert anyway"));
    expect(spy).toHaveBeenCalled();
    answerAlert("Revert anyway");
    expect(api.reviewRevert).toHaveBeenCalledWith("s1", "r1", ["a.uasset"], true);
    await settle();
    expect(screen.getByText("1 file has no earlier version to put back.")).toBeTruthy();
    fireEvent.click(screen.getByText("Undo revert"));
    expect(api.reviewUndo).toHaveBeenCalledWith("s1", "r1", "a.uasset");
    spy.mockRestore();
  });

  it("opens an item", () => {
    const { pushed } = renderInProject(<ReviewScreen sessionId="s1" review={review([item("Content/BP_Door.uasset")])} />);
    fireEvent.click(screen.getByText("BP_Door.uasset"));
    expect(pushed).toEqual([{ name: "reviewItem", sessionId: "s1", reviewId: "r1", path: "Content/BP_Door.uasset" }]);
  });
});

describe("ReviewItemScreen", () => {
  it("shows Unreal's property records by group, labelled as the details panel labels them", async () => {
    const api = fakeApi();
    api.reviewDiff.mockResolvedValue({
      change: {
        path: "Content/WBP_Hud.uasset",
        status: "modified",
        kind: "package",
        assetDiff: {
          state: "ready",
          status: "modified",
          assetClass: "WidgetBlueprint",
          summary: "Widget Blueprint changed.",
          nativeDiff: { available: false },
          sections: [{ category: "Properties", kind: "properties", engineSource: "x", entries: [{ displayString: "bHideWhenFull", diffType: "PropertyValueChanged", group: "HealthBar", path: "bHideWhenFull", label: "Hide when Full", before: "False", after: "True" }] }],
        },
      },
    });
    renderInProject(<ReviewItemScreen sessionId="s1" reviewId="r1" path="Content/WBP_Hud.uasset" />, api);
    await settle();
    expect(screen.getByText("Widget Blueprint changed.")).toBeTruthy();
    expect(screen.getByText("HealthBar")).toBeTruthy();
    expect(screen.getByText("Hide when Full")).toBeTruthy();
    expect(screen.getByText("False")).toBeTruthy();
    expect(screen.getByText("True")).toBeTruthy();
  });

  it("shows a text file's line diff", async () => {
    const api = fakeApi();
    api.reviewDiff.mockResolvedValue({ change: { path: "Config/DefaultGame.ini", status: "modified", kind: "config", diff: "@@ -1,1 +1,1 @@\n-Speed=1\n+Speed=2\n" } });
    renderInProject(<ReviewItemScreen sessionId="s1" reviewId="r1" path="Config/DefaultGame.ini" />, api);
    await settle();
    expect(screen.getByText(/Speed=1/)).toBeTruthy();
    expect(screen.getByText(/Speed=2/)).toBeTruthy();
  });

  it("says why a diff failed", async () => {
    const api = fakeApi();
    api.reviewDiff.mockRejectedValue(new Error("Checkpoint not found."));
    renderInProject(<ReviewItemScreen sessionId="s1" reviewId="r1" path="a.uasset" />, api);
    await settle();
    expect(screen.getByText("Checkpoint not found.")).toBeTruthy();
  });
});

describe("CheckpointsScreen", () => {
  it("lists checkpoints newest first and restores after confirming", async () => {
    const spy = vi.spyOn(Alert, "alert").mockImplementation(() => undefined);
    const api = fakeApi();
    api.sessionSync.mockResolvedValue(session({ timeline: [{ checkpoint: "c1", label: "Turn 1", at: "2026-11-04T12:00:00Z", kind: "turn" }, { checkpoint: "c2", label: "Turn 2", at: "2026-11-04T12:10:00Z", kind: "turn" }], review: null }));
    api.reviewStatus.mockResolvedValue({ default: true });
    api.timelineRestore.mockResolvedValue({ timeline: [], outcome: { restored: ["a"], conflicts: [], missing: [] } });
    renderInProject(<CheckpointsScreen sessionId="s1" />, api);
    await settle();
    await settle();
    const labels = screen.getAllByText(/^Turn \d$/).map((e) => e.textContent);
    expect(labels).toEqual(["Turn 2", "Turn 1"]);
    expect(screen.getByText("Follows Settings on your computer.")).toBeTruthy();
    fireEvent.click(screen.getAllByText("Restore to here")[1]);
    answerAlert("Restore");
    expect(api.timelineRestore).toHaveBeenCalledWith("s1", "c1", false);
    spy.mockRestore();
  });

  it("undoes a restore", async () => {
    const api = fakeApi();
    api.sessionSync.mockResolvedValue(session({ timeline: [{ checkpoint: "c3", label: "Restored to Turn 1", at: "2026-11-04T12:20:00Z", kind: "restore", undo: "c2" }] }));
    api.reviewStatus.mockResolvedValue({ default: false });
    api.timelineUndo.mockResolvedValue({ timeline: [], outcome: { restored: [], conflicts: [], missing: [] } });
    renderInProject(<CheckpointsScreen sessionId="s1" />, api);
    await settle();
    await settle();
    fireEvent.click(screen.getByText("Undo restore"));
    expect(api.timelineUndo).toHaveBeenCalledWith("s1", "c3");
  });
});

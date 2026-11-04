/**
 * The turn's review card as the web client lays it out for a phone (#278): one
 * block per file, its name a text button with a chevron that opens its diff,
 * status and controls on the second line, Open in Unreal diff under an opened
 * file, a one-file turn opened with the card, Reverting in place of the
 * controls, and a failed revert under its file.
 */
import { describe, expect, it } from "vitest";
import { act, fireEvent, screen, within } from "@testing-library/react";
import type { ReviewItem, TurnReview } from "@ue-mcp-studio/shared";
import { TurnReviewCard } from "../src/screens/chat/items";
import { SessionIdContext } from "../src/chat/attachments";
import { fakeApi, renderInProject, settle } from "./helpers";

const at = "2026-11-04T12:00:00Z";
const none = { restored: [], conflicts: [], missing: [] };
const DOOR = "Content/Blueprints/BP_DoorComponent.uasset";
const INI = "Config/DefaultGame.ini";

const item = (path: string, o: Partial<ReviewItem> = {}): ReviewItem =>
  ({ path, group: path.endsWith(".ini") ? "config" : "blueprint", status: "modified", state: "pending", summary: "1 difference", native: { available: true }, ...o }) as ReviewItem;
const REVIEW = { id: "r1", turn: 0, before: "a", after: "b", at, items: [item(DOOR), item(INI, { native: { available: false, reason: "Not an asset." } })] } as unknown as TurnReview;
const withItem = (path: string, o: Partial<ReviewItem>, r: TurnReview = REVIEW): TurnReview => ({ ...r, items: r.items.map((i) => (i.path === path ? { ...i, ...o } : i)) });

function card(review: TurnReview = REVIEW, api = fakeApi()) {
  return renderInProject(
    <SessionIdContext.Provider value="s1">
      <TurnReviewCard review={review} />
    </SessionIdContext.Provider>,
    api,
  );
}

/** An item's block, by its path. */
const row = (path: string): HTMLElement => screen.getByLabelText(path, { selector: "div" });
const nameOf = (path: string): HTMLElement => within(row(path)).getAllByRole("button")[0];
const ZW = /​/g;

describe("TurnReviewCard on a phone", () => {
  it("heads the card with its count and a Revert all text action, and labels each file's status", () => {
    card(withItem(INI, { state: "reverted", undo: "c" }, { ...REVIEW, items: [...REVIEW.items, item("Content/SM_Box.uasset", { status: "added", group: "asset" })] }));
    expect(screen.getByText("Changes in this turn")).toBeTruthy();
    expect(screen.getByText("3 files, 1 reverted")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Revert all" })).toBeTruthy();
    expect(within(row("Content/SM_Box.uasset")).getByText("Added")).toBeTruthy();
    const ini = row(INI);
    expect(within(ini).getByText("Reverted")).toBeTruthy();
    expect(within(ini).getByRole("button", { name: "Undo revert" })).toBeTruthy();
    expect(within(ini).queryByRole("button", { name: "Revert" })).toBeNull();
    expect(within(row(DOOR)).getByRole("button", { name: "Keep" })).toBeTruthy();
    expect(within(row(DOOR)).getByRole("button", { name: "Revert" })).toBeTruthy();
  });

  it("has no Revert all once every file is reverted", () => {
    card({ ...REVIEW, items: REVIEW.items.map((i) => ({ ...i, state: "reverted" as const })) });
    expect(screen.queryByRole("button", { name: "Revert all" })).toBeNull();
    expect(screen.getByText("2 files, 2 reverted")).toBeTruthy();
  });

  it("draws the name as a text button whose last part keeps the chevron, and breaks the path only between folders", () => {
    card();
    const name = nameOf(DOOR);
    expect(name.getAttribute("aria-label")).toBe("BP_DoorComponent.uasset");
    expect(name.querySelector("svg")).toBeTruthy();
    // The last two parts and the chevron are one unbroken piece.
    expect(name.querySelector("svg")!.closest("div")!.parentElement!.textContent).toBe("DoorComponent.uasset");
    const path = within(row(DOOR)).getByText((t) => t.replace(ZW, "") === DOOR);
    expect(path.textContent).toBe("Content/​Blueprints/​BP_DoorComponent.uasset");
  });

  it("opens the diff of a turn's only file with the card, and leaves a longer list closed", async () => {
    const api = fakeApi();
    api.reviewDiff.mockResolvedValue({ change: { path: DOOR, status: "modified", kind: "package" } });
    const one = card({ ...REVIEW, items: [REVIEW.items[0]] }, api);
    await settle();
    expect(nameOf(DOOR).getAttribute("aria-expanded")).toBe("true");
    expect(api.reviewDiff).toHaveBeenCalledWith("s1", "r1", DOOR);
    // Open in Unreal diff shows under the opened file only.
    expect(within(row(DOOR)).getByRole("button", { name: "Open in Unreal diff" })).toBeTruthy();
    one.unmount();
    const api2 = fakeApi();
    card(REVIEW, api2);
    expect(nameOf(DOOR).getAttribute("aria-expanded")).toBe("false");
    expect(api2.reviewDiff).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Open in Unreal diff" })).toBeNull();
  });

  it("shows Open in Unreal diff only where Unreal can open the file, and says what opening it did", async () => {
    const api = fakeApi();
    api.reviewNativeDiff.mockResolvedValue({ opened: "editor" });
    card(REVIEW, api);
    fireEvent.click(nameOf(INI));
    expect(within(row(INI)).queryByRole("button", { name: "Open in Unreal diff" })).toBeNull();
    fireEvent.click(nameOf(DOOR));
    await act(async () => void fireEvent.click(within(row(DOOR)).getByRole("button", { name: "Open in Unreal diff" })));
    expect(api.reviewNativeDiff).toHaveBeenCalledWith("s1", "r1", DOOR);
    expect(within(row(DOOR)).getByRole("status").textContent).toBe("Opened in Unreal, in its asset editor.");
  });

  it("says Reverting on the item in place of its controls while the revert runs", async () => {
    const api = fakeApi();
    let finish: (v: unknown) => void = () => undefined;
    api.reviewRevert.mockReturnValue(new Promise((r) => (finish = r)));
    card(REVIEW, api);
    fireEvent.click(within(row(DOOR)).getByRole("button", { name: "Revert" }));
    expect(within(row(DOOR)).getByRole("status").textContent).toBe("Reverting");
    expect(within(row(DOOR)).queryByRole("button", { name: "Keep" })).toBeNull();
    expect(within(row(INI)).getByRole("button", { name: "Revert" }).getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("button", { name: "Revert all" }).getAttribute("aria-disabled")).toBe("true");
    await act(async () => void finish({ review: withItem(DOOR, { state: "reverted" }), outcome: none }));
    expect(within(row(DOOR)).getByText("Reverted")).toBeTruthy();
    expect(within(row(DOOR)).queryByRole("status")).toBeNull();
  });

  it("shows a failed revert under its item, and a failed Revert all under the card", async () => {
    const api = fakeApi();
    api.reviewRevert.mockRejectedValue(new Error("the file is locked by another process"));
    card(REVIEW, api);
    fireEvent.click(within(row(DOOR)).getByRole("button", { name: "Revert" }));
    await settle();
    expect(within(row(DOOR)).getByRole("alert").textContent).toBe("the file is locked by another process");
    expect(within(row(DOOR)).getByRole("button", { name: "Revert" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Revert all" }));
    await settle();
    expect(within(row(DOOR)).queryByRole("alert")).toBeNull();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("the file is locked by another process");
    expect(row(DOOR).contains(alert) || row(INI).contains(alert)).toBe(false);
  });

  it("keeps a file and says it is kept beside its status", async () => {
    const api = fakeApi();
    api.reviewKeep.mockResolvedValue({ review: withItem(DOOR, { state: "kept" }) });
    card(REVIEW, api);
    fireEvent.click(within(row(DOOR)).getByRole("button", { name: "Keep" }));
    await settle();
    expect(api.reviewKeep).toHaveBeenCalledWith("s1", "r1", [DOOR]);
    expect(within(row(DOOR)).getByText("Kept")).toBeTruthy();
    expect(within(row(DOOR)).queryByRole("button", { name: "Keep" })).toBeNull();
    expect(within(row(DOOR)).getByRole("button", { name: "Revert" })).toBeTruthy();
  });
});

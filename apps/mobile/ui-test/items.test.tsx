/**
 * The item cards in screens/chat/items, state by state: every approval kind
 * and what a PIN-locked answer does, an editor dialog in each of its phases,
 * forms, the compaction marker's kinds, the asset diff as beta.31 draws it
 * (the web client's own review fixtures), and the review card's conflict and
 * undo paths.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { PNG } from "pngjs";
import { isFlatPicture } from "@ue-mcp-studio/client-core";
import type { ApprovalRequest, CheckpointChange, EditorDialog, PendingForm, TranscriptEntry, TurnReview } from "@ue-mcp-studio/shared";
import { REVIEW_SCENARIOS } from "../../client-web/src/visual-qa/review-fixtures";
import { Approvals, AssetDiffView, CompactContext, CompactionMarker, DialogCard, FieldsForm, FormCards, TurnReviewCard } from "../src/screens/chat/items";
import { decodePng } from "../src/screens/chat/items/png";
import { SessionIdContext } from "../src/chat/attachments";
import { fakeApi, renderInProject, settle } from "./helpers";

const at = "2026-11-04T12:00:00Z";

/** Text as it reads, without the zero-width spaces that mark where an engine name may wrap: the innermost element that holds it. */
const ZW = new RegExp(String.fromCharCode(0x200b), "g");
const reads = (want: string | RegExp) => (_: string, el: Element | null): boolean => {
  const text = (e: Element) => (e.textContent ?? "").replace(ZW, "");
  const hit = (e: Element) => (typeof want === "string" ? text(e) === want : want.test(text(e)));
  return !!el && hit(el) && ![...el.children].some(hit);
};
const now = Date.parse(at);

/** A change the web client's review fixtures answer for one path. */
function change(path: string): CheckpointChange {
  const get = REVIEW_SCENARIOS["review-card"].get!;
  const answer = get("/v1/ext/studio/sessions/qa-session/reviews/review-1/diff", new URL(`http://x/?path=${encodeURIComponent(path)}`)) as { change: CheckpointChange };
  return answer.change;
}

describe("Approvals: every kind", () => {
  it("a ue-mcp action shows its category, method and arguments; a restart says what it loses and why", () => {
    const approvals: ApprovalRequest[] = [
      { id: "a1", toolUseId: "t1", tool: "ue_mcp", parent: null, at, call: { category: "asset", method: "delete", args: { path: "/Game/Old" } } },
      { id: "a2", toolUseId: "t2", tool: "editor_restart", parent: null, at, operation: "restart", reason: "Live Coding cannot add a class", subagent: "builder" },
    ] as unknown as ApprovalRequest[];
    renderInProject(<Approvals sessionId="s1" approvals={approvals} />);
    expect(screen.getByText("asset.delete")).toBeTruthy();
    expect(screen.getByText(/"path": "\/Game\/Old"/)).toBeTruthy();
    expect(screen.getByText("ue-mcp marks this action as one that deletes or overwrites.")).toBeTruthy();
    expect(screen.getByText(/Unsaved work in the editor is lost\./)).toBeTruthy();
    expect(screen.getByText("Why: Live Coding cannot add a class")).toBeTruthy();
    expect(screen.getByText("from subagent builder")).toBeTruthy();
  });

  it("with the PIN asked for, the buttons wait; a cancelled PIN puts them back with the refusal", async () => {
    let refuse: (e: Error) => void = () => undefined;
    const api = fakeApi();
    // The locked transport holds the request while the PIN sheet is up, and answers 423 when it is cancelled.
    api.approve.mockReturnValue(new Promise((_, reject) => (refuse = reject)));
    const approvals = [{ id: "a3", toolUseId: "t3", tool: "shell", parent: null, at, command: "git push" }] as unknown as ApprovalRequest[];
    renderInProject(<Approvals sessionId="s1" approvals={approvals} />, api);
    fireEvent.click(screen.getByText("Allow"));
    await settle();
    expect(api.approve).toHaveBeenCalledWith("s1", "a3", "allow");
    expect(screen.getByLabelText("Deny").getAttribute("aria-disabled")).toBe("true");
    refuse(new Error("Enter your PIN to do this."));
    await settle();
    expect(screen.getByText("Enter your PIN to do this.")).toBeTruthy();
    expect(screen.getByLabelText("Deny").getAttribute("aria-disabled")).not.toBe("true");
  });
});

describe("DialogCard: who decides", () => {
  const base = { id: "d1", sessionId: "s1", title: "Save content?", message: "", buttons: ["Save Selected", "Don't Save"], steps: [{ at, text: "Opened by asset.save" }], held: null, editor: "UnrealEditor", openedAt: at } as unknown as EditorDialog;

  it("waiting for you: its buttons, the assets to tick, and Let the agent decide", async () => {
    const api = fakeApi();
    api.answerDialog.mockResolvedValue({});
    const d = { ...base, asking: { since: now, minHumanMs: 0, deadline: null, policy: { kind: "wait" } }, items: [{ index: 0, label: "BP_Door", checked: true, cells: ["BP_Door", "/Game/BP_Door"] }] } as unknown as EditorDialog;
    renderInProject(<DialogCard dialog={d} now={now} />, api);
    expect(screen.getByText("/Game/BP_Door")).toBeTruthy();
    expect(screen.getByText("Opened by asset.save")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("BP_Door"));
    fireEvent.click(screen.getByText("Save Selected"));
    await settle();
    expect(api.answerDialog).toHaveBeenCalledWith("d1", { answer: "press", button: "Save Selected", items: [{ index: 0, checked: false }] });
  });

  it("hands the dialog to the agent", async () => {
    const api = fakeApi();
    api.answerDialog.mockResolvedValue({});
    renderInProject(<DialogCard dialog={{ ...base, asking: { since: now, minHumanMs: 0, deadline: null, policy: { kind: "wait" } } } as unknown as EditorDialog} now={now} />, api);
    fireEvent.click(screen.getByText("Let the agent decide"));
    await settle();
    expect(api.answerDialog).toHaveBeenCalledWith("d1", { answer: "delegate" });
  });

  it("held by the agent: Press it now, or another button instead", async () => {
    const api = fakeApi();
    api.answerDialog.mockResolvedValue({});
    renderInProject(<DialogCard dialog={{ ...base, held: { button: "Don't Save", until: now + 5000 } } as unknown as EditorDialog} now={now} />, api);
    expect(screen.getByText(/The agent chose Don't Save/)).toBeTruthy();
    fireEvent.click(screen.getByText("Save Selected instead"));
    await settle();
    expect(api.answerDialog).toHaveBeenCalledWith("d1", { answer: "press", button: "Save Selected" });
  });

  it("decided by the agent: Answer it yourself with any button", () => {
    renderInProject(<DialogCard dialog={{ ...base, mode: "auto" } as unknown as EditorDialog} now={now} />);
    expect(screen.getByText("Answer it yourself:")).toBeTruthy();
    expect(screen.getByText("Don't Save")).toBeTruthy();
  });
});

describe("Forms", () => {
  it("a yes or no, a choice and a number; Decline sends decline", async () => {
    const api = fakeApi();
    api.answerForm.mockResolvedValue({});
    const form = {
      id: "f2", sessionId: "s1", call: "feedback.submit", message: "Send it?", required: [], at,
      fields: { attach: { type: "boolean", title: "Attach the log" }, level: { type: "string", title: "Severity", enum: ["low", "high"], enumNames: ["Low", "High"] }, n: { type: "number", title: "Count", description: "How many times" } },
    } as unknown as PendingForm;
    renderInProject(<FormCards forms={[form]} />, api);
    expect(screen.getByText("Attach the log")).toBeTruthy();
    expect(screen.getByText("How many times")).toBeTruthy();
    expect(screen.getAllByText("(optional)").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText("Decline"));
    await settle();
    expect(api.answerForm).toHaveBeenCalledWith("f2", { action: "decline" });
  });

  it("with requireFilled, Submit waits for every required field", () => {
    const onSubmit = vi.fn();
    renderInProject(<FieldsForm fields={{ name: { type: "string", title: "Name" } }} required={["name"]} sent={false} error={null} requireFilled onSubmit={onSubmit} onDecline={() => undefined} />);
    fireEvent.click(screen.getByText("Submit"));
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "door" } });
    fireEvent.click(screen.getByText("Submit"));
    expect(onSubmit).toHaveBeenCalledWith({ name: "door" });
  });
});

describe("CompactionMarker: its kinds", () => {
  type Compaction = Extract<TranscriptEntry, { kind: "compaction" }>;
  const entry = (over: Partial<Compaction> = {}) => ({ kind: "compaction", at, trigger: "auto", state: "done", before: 852_300, after: 21_400, summary: "kept", method: "summary", model: "Sonnet 5.5", ms: 23_000, ...over }) as Compaction;

  it("a subagent's failed compaction has no Try again", () => {
    renderInProject(
      <CompactContext.Provider value={() => undefined}>
        <CompactionMarker entry={entry({ state: "failed", after: undefined, summary: undefined, error: "Overloaded.", parent: "call-1" })} />
      </CompactContext.Provider>,
    );
    fireEvent.click(screen.getByText("Why"));
    expect(screen.queryByText("Try again")).toBeNull();
  });

  it("trimmed: the oldest part was cut, and why", () => {
    renderInProject(<CompactionMarker entry={entry({ method: "truncated", summary: undefined, error: "the summary was empty" })} />);
    expect(screen.getByText("Context trimmed")).toBeTruthy();
  });

  it("by Claude's runtime: opens to say the runtime kept its summary", () => {
    renderInProject(<CompactionMarker entry={entry({ method: "runtime", summary: undefined })} />);
    fireEvent.click(screen.getByText("Summary"));
    expect(screen.getByText(/Claude's runtime summarised the conversation/)).toBeTruthy();
    expect(screen.getByText("The runtime did not hand over its summary.")).toBeTruthy();
  });
});

describe("AssetDiffView: only what changed", () => {
  const view = (path: string, status: "added" | "modified" | "deleted" = "modified") =>
    renderInProject(<AssetDiffView diff={change(path).assetDiff!} name={path.split("/").pop()!} status={status} />);

  it("a widget property by its details-panel label; the facts that are the same are not shown at all", () => {
    view("Content/UI/HUD/WBP_GameHUD.uasset");
    expect(screen.getByText(reads(/^Changed\s*Hide when Full$/))).toBeTruthy();
    expect(screen.getByText("False")).toBeTruthy();
    expect(screen.getByText("True")).toBeTruthy();
    expect(screen.queryByText(/unchanged fact/)).toBeNull();
    expect(screen.queryByText(reads("Parent class"))).toBeNull();
    expect(screen.queryByLabelText("Facts")).toBeNull();
  });

  it("a graph: the verb its badge says is dropped, a pin's defaults are its before and after", () => {
    view("Content/Characters/Player/BP_PlayerCharacterMovementComponent.uasset");
    expect(screen.getByText(reads(/^Added\s*Node Branch$/))).toBeTruthy();
    expect(screen.getAllByText("1.5").length).toBeGreaterThan(0);
    expect(screen.getAllByText("1.8").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Structure \(blueprint diff\)/)).toBeNull();
    expect(screen.queryByText(/How Unreal compared this/)).toBeNull();
  });

  it("a material: a node's property is named by its node", () => {
    view("Content/Environment/Materials/M_RockMaster.uasset");
    expect(screen.getAllByText(reads(/Roughness > /))[0]).toBeTruthy();
  });

  it("a sound with no records and no picture: its tile names the one fact that changed, and nothing counts the rest", () => {
    view("Content/Audio/SW_WardChime.uasset");
    expect(screen.getByLabelText(/SoundWave SW_WardChime/)).toBeTruthy();
    expect(screen.getByText(reads("Duration"))).toBeTruthy();
    expect(screen.queryByText("Facts")).toBeNull();
    expect(screen.queryByText(/unchanged fact/)).toBeNull();
  });

  it("an added asset with no picture: its tile, and the details of this version", () => {
    view("Content/Input/Actions/IA_WallRunWhileCrouched.uasset", "added");
    expect(screen.getByLabelText(/InputAction IA_WallRunWhileCrouched\.uasset/)).toBeTruthy();
  });

  it("an asset Unreal could not load: why, and what Keep and Revert do without it", () => {
    view("Content/Props/SM_CrateWoodenLarge.uasset");
    expect(screen.getByText(/Unreal could not load this asset to diff it/)).toBeTruthy();
    expect(screen.getByText(/byte for byte/)).toBeTruthy();
  });
});

describe("blank pictures", () => {
  const png = (fill: (x: number, y: number) => [number, number, number]) => {
    const p = new PNG({ width: 16, height: 16 });
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) p.data.set([...fill(x, y), 255], (y * 16 + x) * 4);
    return new Uint8Array(PNG.sync.write(p));
  };

  it("decodes a thumbnail on the phone and tells a flat one from a picture", () => {
    const black = decodePng(png(() => [0, 0, 0]));
    const sphere = decodePng(png((x, y) => [x * 16, y * 16, 90]));
    expect(black && isFlatPicture(black)).toBe(true);
    expect(sphere && isFlatPicture(sphere)).toBe(false);
    expect(decodePng(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe("TurnReviewCard: a conflict and an undo", () => {
  const review = {
    id: "r2", turn: 1, before: "a", after: "b", at,
    items: [
      { path: "Content/Maps/L_Playtest.umap", group: "level", status: "modified", state: "pending", conflict: true, untracked: true, summary: "2 differences", native: { available: true } },
      { path: "Config/DefaultEngine.ini", group: "config", status: "modified", state: "reverted", undo: "c", summary: "2 lines added, 1 removed", native: { available: false, reason: "Not an asset." } },
    ],
  } as unknown as TurnReview;

  it("Revert anyway asks once more before it loses the user's edits; Undo revert puts the agent's version back", async () => {
    const api = fakeApi();
    api.reviewRevert.mockResolvedValue({ review, outcome: { restored: [], conflicts: [], missing: [] } });
    api.reviewUndo.mockResolvedValue({ review, outcome: { restored: [], conflicts: [], missing: [] } });
    renderInProject(
      <SessionIdContext.Provider value="s1">
        <TurnReviewCard review={review} />
      </SessionIdContext.Provider>,
      api,
    );
    expect(screen.getByText("Outside the agent")).toBeTruthy();
    expect(screen.getByText("You edited this file after the agent, so Revert left it alone.")).toBeTruthy();
    fireEvent.click(screen.getByText("Revert anyway"));
    fireEvent.click(screen.getByText("Revert and lose my edits"));
    await settle();
    expect(api.reviewRevert).toHaveBeenCalledWith("s1", "r2", ["Content/Maps/L_Playtest.umap"], true);
    fireEvent.click(screen.getByText("Undo revert"));
    await settle();
    expect(api.reviewUndo).toHaveBeenCalledWith("s1", "r2", "Config/DefaultEngine.ini");
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { EditorDialog } from "@ue-mcp-studio/shared";

vi.mock("../api", () => ({ api: { answerDialog: vi.fn(async () => undefined) } }));
import { api } from "../api";
import { DialogBannerLine, DialogCards, DialogLine } from "./Dialogs";
import { clock, outcomeLine, policyLine, readyIn } from "./dialog-model";
import { Entry } from "./Transcript";
import { DialogPolicyField } from "../views/Settings";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  delete (window as { ue?: unknown }).ue;
});

const T0 = 1_000_000;
const base: EditorDialog = {
  id: "d1",
  editor: "Scratch",
  title: "Save Content",
  message: "Save these?",
  buttons: ["Save Selected", "Don't Save", "Cancel"],
  mode: "interactive",
  openedAt: T0,
  sessionId: "s1",
  toolUseId: "tu1",
  parent: "a1",
  subagent: "Tidy the level",
  call: "editor.stop_editor",
  asking: { since: T0, minHumanMs: 1000, policy: { kind: "agent", minutes: 2 }, deadline: T0 + 120_000, safeButton: "Cancel" },
  held: null,
  outcome: null,
};

const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

describe("a dialog card", () => {
  it("shows the dialog, the call and subagent that met it, and what happens if nobody answers", () => {
    render(<DialogCards dialogs={[base]} now={T0 + 18_000} />);
    expect(screen.getByText("Save Content")).toBeTruthy();
    expect(screen.getByText("Save these?")).toBeTruthy();
    expect(screen.getByText("met by editor(stop_editor) in subagent Tidy the level")).toBeTruthy();
    expect(screen.getByText("The agent decides in 1:42.")).toBeTruthy();
  });

  it("keeps its buttons off until there has been time to read it", () => {
    const { rerender } = render(<DialogCards dialogs={[base]} now={T0 + 500} />);
    expect(button("Cancel").disabled).toBe(true);
    expect(button("Let the agent decide").disabled).toBe(true);
    rerender(<DialogCards dialogs={[base]} now={T0 + 1000} />);
    expect(button("Cancel").disabled).toBe(false);
  });

  it("presses the chosen button, with the rows as ticked", async () => {
    const items = [
      { index: 0, label: "Asset", cells: ["Asset", "File", "Type"], checked: true },
      { index: 1, label: "L_Test", cells: ["L_Test", "/Game/L_Test", "/Script/Engine.World"], checked: true },
      { index: 2, label: "M_A", cells: ["M_A", "/Game/M_A", "/Script/Engine.Material"], checked: true },
    ];
    render(<DialogCards dialogs={[{ ...base, items }]} now={T0 + 2000} />);
    // The header row is not a question.
    expect(screen.queryByText("Asset")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: /M_A/ }));
    await act(async () => fireEvent.click(button("Save Selected")));
    expect(api.answerDialog).toHaveBeenCalledWith("d1", { answer: "press", button: "Save Selected", items: [{ index: 1, checked: true }, { index: 2, checked: false }] });
    expect(button("Cancel").disabled).toBe(true);
  });

  it("hands it to the agent", async () => {
    render(<DialogCards dialogs={[base]} now={T0 + 2000} />);
    await act(async () => fireEvent.click(button("Let the agent decide")));
    expect(api.answerDialog).toHaveBeenCalledWith("d1", { answer: "delegate" });
  });

  it("lets the user answer again when the answer did not arrive", async () => {
    vi.mocked(api.answerDialog).mockRejectedValueOnce(new Error("That dialog is no longer waiting."));
    render(<DialogCards dialogs={[base]} now={T0 + 2000} />);
    await act(async () => fireEvent.click(button("Cancel")));
    expect(screen.getByText("That dialog is no longer waiting.")).toBeTruthy();
    expect(button("Cancel").disabled).toBe(false);
  });

  it("counts down a destructive answer the agent chose, with Press now and an override for each other button", async () => {
    const held: EditorDialog = { ...base, mode: "auto", asking: null, held: { button: "Don't Save", until: T0 + 10_000 } };
    render(<DialogCards dialogs={[held]} now={T0 + 2_100} />);
    expect(screen.getByText(/It is pressed in 8 s/)).toBeTruthy();
    await act(async () => fireEvent.click(button("Cancel instead")));
    expect(api.answerDialog).toHaveBeenCalledWith("d1", { answer: "press", button: "Cancel" });
    cleanup();
    render(<DialogCards dialogs={[held]} now={T0 + 2_100} />);
    await act(async () => fireEvent.click(button("Press Don't Save now")));
    expect(api.answerDialog).toHaveBeenCalledWith("d1", { answer: "release" });
  });

  it("says to answer in the editor when Studio was not asked", () => {
    render(<DialogCards dialogs={[{ ...base, mode: "defer", asking: null }]} now={T0} />);
    expect(screen.getByText(/Answer it in the editor/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("flashes the window when it asks while Studio is not in front", () => {
    const drawattention = vi.fn(async () => true);
    (window as { ue?: unknown }).ue = { studio: { drawattention } };
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    render(<DialogCards dialogs={[base]} now={T0} />);
    expect(drawattention).toHaveBeenCalledWith("Unreal is waiting on a dialog: Save Content");
    vi.mocked(document.hasFocus).mockRestore();
  });

  it("does not flash a window the user is looking at", () => {
    const drawattention = vi.fn(async () => true);
    (window as { ue?: unknown }).ue = { studio: { drawattention } };
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    render(<DialogCards dialogs={[base]} now={T0} />);
    expect(drawattention).not.toHaveBeenCalled();
    vi.mocked(document.hasFocus).mockRestore();
  });
});

describe("a dialog in the transcript and the banner", () => {
  it("says how it ended", () => {
    const at = T0;
    expect(outcomeLine({ ...base, outcome: { kind: "pressed", button: "Cancel", by: "you", at } })).toBe("You pressed Cancel.");
    expect(outcomeLine({ ...base, outcome: { kind: "pressed", button: "Save Selected", by: "agent", at } })).toBe("The agent pressed Save Selected.");
    expect(outcomeLine({ ...base, outcome: { kind: "pressed", button: "Cancel", by: "policy", at } })).toBe("Nobody answered in time, so Cancel was pressed.");
    expect(outcomeLine({ ...base, outcome: { kind: "delegated", by: "policy", at } })).toBe("Nobody answered in time, so the agent was handed it.");
    expect(outcomeLine({ ...base, outcome: { kind: "closed", at } })).toBe("Closed in the editor.");
    expect(outcomeLine({ ...base, asking: null, mode: "auto" })).toBe("The agent is choosing an answer.");
  });

  it("renders as a line in the transcript", () => {
    render(<Entry entry={{ kind: "dialog", dialog: { ...base, asking: null, outcome: { kind: "pressed", button: "Cancel", by: "you", at: T0 } } }} />);
    expect(screen.getByText("Save Content")).toBeTruthy();
    expect(screen.getByText("You pressed Cancel.")).toBeTruthy();
    cleanup();
    render(<DialogLine dialog={base} />);
    expect(screen.getByText("Waiting for an answer.")).toBeTruthy();
  });

  it("puts the dialog in the banner, so a stalled turn is never silent", () => {
    render(<DialogBannerLine dialog={base} now={T0 + 60_000} />);
    expect(screen.getByRole("status").textContent).toBe("Editor waiting on a dialog: Save Content The agent decides in 1:00.");
  });

  it("words each policy", () => {
    expect(policyLine({ ...base, asking: { ...base.asking!, policy: { kind: "wait" }, deadline: null } }, T0)).toBe("Waiting for you.");
    expect(policyLine({ ...base, asking: { ...base.asking!, policy: { kind: "safe", minutes: 2 } } }, T0 + 90_000)).toBe("Cancel is pressed in 0:30.");
    expect(policyLine({ ...base, asking: { ...base.asking!, policy: { kind: "safe", minutes: 2 }, deadline: null, safeButton: null } }, T0)).toMatch(/no Cancel or Keep/);
    expect(readyIn(base, T0 + 400)).toBe(600);
    expect(clock(61_001)).toBe("1:02");
  });
});

describe("the dialog policy setting", () => {
  it("saves each choice, with the minutes", () => {
    const onSave = vi.fn();
    const { rerender } = render(<DialogPolicyField policy={{ kind: "agent", minutes: 2 }} onSave={onSave} />);
    expect((screen.getByRole("radio", { name: "Ask me, then let the agent decide" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Ask me and wait" }));
    expect(onSave).toHaveBeenCalledWith({ kind: "wait" });
    fireEvent.click(screen.getByRole("radio", { name: /press the safe default/ }));
    expect(onSave).toHaveBeenCalledWith({ kind: "safe", minutes: 2 });
    rerender(<DialogPolicyField policy={{ kind: "safe", minutes: 2 }} onSave={onSave} />);
    const minutes = screen.getByLabelText("Minutes");
    fireEvent.change(minutes, { target: { value: "5" } });
    fireEvent.blur(minutes);
    expect(onSave).toHaveBeenLastCalledWith({ kind: "safe", minutes: 5 });
  });

  it("hides the minutes for wait, and ignores a value out of range", () => {
    const onSave = vi.fn();
    const { rerender } = render(<DialogPolicyField policy={{ kind: "wait" }} onSave={onSave} />);
    expect(screen.queryByLabelText("Minutes")).toBeNull();
    rerender(<DialogPolicyField policy={{ kind: "agent", minutes: 2 }} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText("Minutes"), { target: { value: "0" } });
    fireEvent.blur(screen.getByLabelText("Minutes"));
    expect(onSave).not.toHaveBeenCalled();
  });
});

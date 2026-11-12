// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { EditorDialog } from "@ue-mcp-studio/shared";

vi.mock("../api", () => ({ api: { answerDialog: vi.fn(async () => undefined) } }));
import { api } from "../api";
import { DialogBannerLine, DialogCards, DialogLine } from "./Dialogs";
import { clock, decider, outcomeLine, readyIn, statusLine } from "@ue-mcp-studio/client-core";
import { Entry } from "./Transcript";
import { DialogPolicyField } from "../views/settings/ApprovalsSection";

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
  steps: [{ at: T0, text: "Asked you. The agent decides if nobody answers in 2 min." }],
};

const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

describe("a dialog card", () => {
  it("shows the dialog, the call and subagent that met it, and what happens if nobody answers", () => {
    render(<DialogCards dialogs={[base]} now={T0 + 18_000} />);
    expect(screen.getByText("Save Content")).toBeTruthy();
    expect(screen.getByText("Save these?")).toBeTruthy();
    expect(screen.getByText("met by editor(stop_editor) in subagent Tidy the level")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Waiting for you. The agent decides in 1:42.");
    expect(screen.getByText(/Asked you. The agent decides if nobody answers in 2 min./)).toBeTruthy();
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
    expect(screen.getByRole("status").textContent).toBe("The agent chose Don't Save, pressing in 0:08 (Override).");
    await act(async () => fireEvent.click(button("Cancel instead")));
    expect(api.answerDialog).toHaveBeenCalledWith("d1", { answer: "press", button: "Cancel" });
    cleanup();
    render(<DialogCards dialogs={[held]} now={T0 + 2_100} />);
    await act(async () => fireEvent.click(button("Press Don't Save now")));
    expect(api.answerDialog).toHaveBeenCalledWith("d1", { answer: "release" });
  });

  it("says to answer in the editor when the project defers dialogs", () => {
    render(<DialogCards dialogs={[{ ...base, mode: "defer", asking: null }]} now={T0} />);
    expect(screen.getByRole("status").textContent).toBe("Waiting for an answer in the editor.");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("says the agent is deciding in auto mode, and still lets the user answer", async () => {
    render(<DialogCards dialogs={[{ ...base, mode: "auto", asking: null }]} now={T0} />);
    expect(screen.getByRole("status").textContent).toBe("The agent is deciding.");
    await act(async () => fireEvent.click(button("Cancel")));
    expect(api.answerDialog).toHaveBeenCalledWith("d1", { answer: "press", button: "Cancel" });
  });

  it("says the agent is deciding once the deadline handed it over, never waiting for you", () => {
    const handed: EditorDialog = { ...base, asking: null, outcome: { kind: "delegated", by: "policy", at: T0 + 120_000 } };
    render(<DialogCards dialogs={[handed]} now={T0 + 121_000} />);
    expect(screen.getByRole("status").textContent).toBe("Nobody answered in time, so the agent is deciding.");
    expect(screen.queryByText(/Waiting for you/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Let the agent decide" })).toBeNull();
  });

  it("leaves telling an away user to notifications: the card itself flashes and toasts nothing", () => {
    const drawattention = vi.fn(async () => true);
    const notify = vi.fn(async () => true);
    (window as { ue?: unknown }).ue = { studio: { drawattention, notify } };
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    render(<DialogCards dialogs={[base]} now={T0} />);
    expect(drawattention).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    vi.mocked(document.hasFocus).mockRestore();
  });
});

/** The Save Content prompt as ue-mcp reads it: its flat text, its rows, and the same body as blocks. */
const SAVE_ITEMS = [
  { index: 0, label: "Asset", cells: ["Asset", "File", "Type"], checked: true },
  { index: 1, label: "L_FightArena", cells: ["L_FightArena", "/Game/Maps/Test/L_FightArena", "/Script/Engine.World"], checked: true },
];
const saveContent: EditorDialog = {
  ...base,
  message: ["Select Content to Save", "Asset", "File", "Type", "L_FightArena", "/Game/Maps/Test/L_FightArena", "/Script/Engine.World", "Save Selected", "Don't Save", "Cancel"].join("\n"),
  items: SAVE_ITEMS,
  blocks: [
    { type: "paragraph", text: "Select Content to Save" },
    { type: "table", columns: ["Asset", "File", "Type"], rows: [["L_FightArena", "/Game/Maps/Test/L_FightArena", "/Script/Engine.World"]], checked: [true], items: [1] },
  ],
};

describe("a dialog's body as ue-mcp read it (#1891)", () => {
  it("draws the caption as a paragraph and the package list as a table under its headings", () => {
    render(<DialogCards dialogs={[saveContent]} now={T0 + 2000} />);
    expect(screen.getByText("Select Content to Save").tagName).toBe("P");
    const table = screen.getByRole("table");
    expect([...table.querySelectorAll("th[scope=col]")].map((th) => th.textContent)).toEqual(["Asset", "File", "Type"]);
    const cells = [...table.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td:not(.check)")].map((td) => td.textContent));
    expect(cells).toEqual([["L_FightArena", "/Game/Maps/Test/L_FightArena", "/Script/Engine.World"]]);
    // The buttons are buttons, not body text, and the flat message is not drawn too.
    expect(screen.getAllByText("Don't Save")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Don't Save" })).toBeTruthy();
    expect(document.querySelector(".dialog-message")).toBeNull();
    // One checkbox per asset: in the table, not again in a list below it.
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  });

  it("ticks a row in the table and sends it with the press while Studio is asking", async () => {
    render(<DialogCards dialogs={[saveContent]} now={T0 + 2000} />);
    const box = screen.getByRole("checkbox", { name: "Select L_FightArena" }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(false);
    fireEvent.click(box);
    await act(async () => fireEvent.click(button("Save Selected")));
    expect(api.answerDialog).toHaveBeenCalledWith("d1", { answer: "press", button: "Save Selected", items: [{ index: 1, checked: false }] });
  });

  it("shows the ticks read-only when nobody is asking the user", () => {
    render(<DialogCards dialogs={[{ ...saveContent, mode: "auto", asking: null }]} now={T0} />);
    const box = screen.getByRole("checkbox", { name: "Select L_FightArena" }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(true);
    expect(screen.getByText("Answer it yourself:")).toBeTruthy();
  });

  it("falls back to the flat text, without the button labels, from a ue-mcp that sends no blocks", () => {
    render(<DialogCards dialogs={[{ ...saveContent, blocks: undefined }]} now={T0 + 2000} />);
    const message = document.querySelector(".dialog-message")!;
    expect(message.textContent).toContain("/Game/Maps/Test/L_FightArena");
    expect(message.textContent).not.toContain("Don't Save");
    expect(screen.queryByRole("table")).toBeNull();
    // The rows are still offered to tick, as before.
    expect(screen.getByRole("checkbox", { name: /L_FightArena/ })).toBeTruthy();
  });

  it("draws a table with no checkbox column and no headings", () => {
    render(<DialogCards dialogs={[{ ...base, blocks: [{ type: "table", columns: ["", ""], rows: [["a", "b"], ["c"]] }] }]} now={T0 + 2000} />);
    const table = screen.getByRole("table");
    expect(table.querySelector("thead")).toBeNull();
    expect([...table.querySelectorAll("tbody tr")].map((tr) => tr.children.length)).toEqual([2, 2]);
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });
});

describe("a dialog in the transcript and the banner", () => {
  it("says how it ended", () => {
    const at = T0;
    expect(outcomeLine({ ...base, outcome: { kind: "pressed", button: "Cancel", by: "you", at } })).toBe("You pressed Cancel.");
    expect(outcomeLine({ ...base, outcome: { kind: "pressed", button: "Save Selected", by: "agent", at } })).toBe("The agent pressed Save Selected.");
    expect(outcomeLine({ ...base, outcome: { kind: "pressed", button: "Cancel", by: "policy", at } })).toBe("Nobody answered in time, so Cancel was pressed.");
    expect(outcomeLine({ ...base, outcome: { kind: "closed", at } })).toBe("Closed in the editor.");
    expect(outcomeLine(base)).toBe("");
  });

  it("renders as a line in the transcript", () => {
    render(<Entry entry={{ kind: "dialog", dialog: { ...base, asking: null, outcome: { kind: "pressed", button: "Cancel", by: "you", at: T0 } } }} />);
    expect(screen.getByText("Save Content")).toBeTruthy();
    expect(screen.getByText("You pressed Cancel.")).toBeTruthy();
    cleanup();
    render(<DialogLine dialog={base} />);
    expect(screen.getByText(/Asked you. The agent decides/)).toBeTruthy();
  });

  it("puts the dialog in the banner, so a stalled turn is never silent", () => {
    render(<DialogBannerLine dialog={base} now={T0 + 60_000} />);
    expect(screen.getByRole("status").textContent).toBe("Editor waiting on a dialog: Save Content Waiting for you. The agent decides in 1:00.");
  });

  it("tells the truth about who decides, in every state", () => {
    // Waiting for you only with nothing else to answer it, and with the deadline when there is one.
    expect(statusLine({ ...base, asking: { ...base.asking!, policy: { kind: "wait" }, deadline: null } }, T0)).toBe("Waiting for you.");
    expect(statusLine(base, T0 + 15_000)).toBe("Waiting for you. The agent decides in 1:45.");
    expect(statusLine({ ...base, asking: { ...base.asking!, policy: { kind: "safe", minutes: 2 } } }, T0 + 90_000)).toBe("Waiting for you. Cancel is pressed in 0:30.");
    expect(statusLine({ ...base, asking: { ...base.asking!, policy: { kind: "safe", minutes: 2 }, deadline: null, safeButton: null } }, T0)).toBe("Waiting for you. It has no Cancel or Keep, so nothing is pressed for you.");
    expect(statusLine({ ...base, asking: null, outcome: { kind: "delegated", by: "policy", at: T0 } }, T0)).toBe("Nobody answered in time, so the agent is deciding.");
    expect(statusLine({ ...base, asking: null, outcome: { kind: "delegated", by: "you", at: T0 } }, T0)).toBe("Handed to the agent. The agent is deciding.");
    expect(statusLine({ ...base, asking: null, mode: "auto" }, T0)).toBe("The agent is deciding.");
    expect(statusLine({ ...base, asking: null, held: { button: "Don't Save", until: T0 + 8_000 } }, T0)).toBe("The agent chose Don't Save, pressing in 0:08 (Override).");
    expect(statusLine({ ...base, asking: null, outcome: { kind: "pressed", button: "Cancel", by: "policy", at: T0 } }, T0)).toBe("Nobody answered in time, so Cancel was pressed.");
    expect(statusLine({ ...base, asking: null, mode: "interactive" }, T0)).toMatch(/^Not put to Studio yet/);
    expect(decider(base)).toBe("you");
    expect(decider({ ...base, asking: null, outcome: { kind: "delegated", by: "policy", at: T0 } })).toBe("agent");
    expect(readyIn(base, T0 + 400)).toBe(600);
    expect(clock(61_001)).toBe("1:02");
  });
});

describe("the dialog policy setting", () => {
  it("saves each choice, with the minutes", () => {
    const onSave = vi.fn();
    const { rerender } = render(<DialogPolicyField policy={{ kind: "agent", minutes: 2 }} onSave={onSave} />);
    expect((screen.getByRole("radio", { name: "Hand to agent" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Keep waiting" }));
    expect(onSave).toHaveBeenCalledWith({ kind: "wait" });
    fireEvent.click(screen.getByRole("radio", { name: /Press Cancel or Keep/ }));
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

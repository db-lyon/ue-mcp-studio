import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { StudioApi } from "@ue-mcp-studio/client-core";
import type { ApprovalRequest, EditorDialog } from "@ue-mcp-studio/shared";
import { ApprovalCard, DialogCard } from "../src/Cards";
import { DiffView } from "../src/Diff";
import { Markdown } from "../src/Markdown";
import { fakeApi, settle } from "./helpers";

const approval = (over: Partial<ApprovalRequest>): ApprovalRequest => ({ id: "a1", toolUseId: "t1", tool: "shell", parent: null, at: "2026-11-04T12:00:00Z", ...over });

describe("ApprovalCard", () => {
  it("shows a command and sends the owner's decision", async () => {
    const api = fakeApi();
    api.approve.mockResolvedValue({});
    render(<ApprovalCard api={api as unknown as StudioApi} sessionId="s1" approval={approval({ command: "git status", cwd: "D:/Game" })} />);
    expect(screen.getByText("Run this command?")).toBeTruthy();
    expect(screen.getByText("$ git status")).toBeTruthy();
    expect(screen.getByText("in D:/Game")).toBeTruthy();
    fireEvent.click(screen.getByText("Allow for this session"));
    expect(api.approve).toHaveBeenCalledWith("s1", "a1", "session");
    await settle();
  });

  it("names a file edit and shows its diff", () => {
    render(<ApprovalCard api={fakeApi() as unknown as StudioApi} sessionId="s1" approval={approval({ tool: "edit_file", path: "Source/Door.cpp", diff: [{ op: "-", text: "old();" }, { op: "+", text: "new();" }] })} />);
    expect(screen.getByText("Make this edit?")).toBeTruthy();
    expect(screen.getByText("Source/Door.cpp")).toBeTruthy();
    expect(screen.getByText(/new\(\);/)).toBeTruthy();
  });

  it("asks before a rebuild and gives the reason", () => {
    render(<ApprovalCard api={fakeApi() as unknown as StudioApi} sessionId="s1" approval={approval({ tool: "editor_restart", operation: "rebuild", reason: "New C++ class" })} />);
    expect(screen.getByText("Rebuild and restart the editor?")).toBeTruthy();
    expect(screen.getByText(/rebuild the project's C\+\+/)).toBeTruthy();
    expect(screen.getByText("Why: New C++ class")).toBeTruthy();
  });

  it("puts the buttons back and shows the error when the answer fails", async () => {
    const api = fakeApi();
    api.approve.mockRejectedValue(new Error("Computer offline."));
    render(<ApprovalCard api={api as unknown as StudioApi} sessionId="s1" approval={approval({ command: "ls" })} />);
    fireEvent.click(screen.getByText("Deny"));
    await settle();
    expect(screen.getByText("Computer offline.")).toBeTruthy();
    fireEvent.click(screen.getByText("Allow"));
    expect(api.approve).toHaveBeenLastCalledWith("s1", "a1", "allow");
    await settle();
  });
});

const dialog = (over: Partial<EditorDialog>): EditorDialog => ({
  id: "d1",
  editor: "Unreal Editor",
  title: "Save Content",
  message: "Save these assets?",
  buttons: ["Save Selected", "Don't Save", "Cancel"],
  mode: "interactive",
  openedAt: 1000,
  sessionId: "s1",
  toolUseId: null,
  parent: null,
  call: "editor.stop_editor",
  asking: { since: 1000, minHumanMs: 0, policy: { kind: "wait" } as never, deadline: null, safeButton: null },
  held: null,
  steps: [],
  outcome: null,
  ...over,
});

describe("DialogCard", () => {
  it("presses one of the dialog's buttons with the ticked assets", async () => {
    const api = fakeApi();
    api.answerDialog.mockResolvedValue({});
    render(<DialogCard api={api as unknown as StudioApi} dialog={dialog({ items: [{ index: 0, label: "Door", cells: ["Door", "/Game/Door"], checked: true }] })} now={5000} />);
    expect(screen.getByText("Save Content")).toBeTruthy();
    expect(screen.getByText("met by editor(stop_editor)")).toBeTruthy();
    expect(screen.getByText("/Game/Door")).toBeTruthy();
    fireEvent.click(screen.getByText("Save Selected"));
    expect(api.answerDialog).toHaveBeenCalledWith("d1", { answer: "press", button: "Save Selected", items: [{ index: 0, checked: true }] });
    await settle();
  });

  it("hands the dialog to the agent", async () => {
    const api = fakeApi();
    api.answerDialog.mockResolvedValue({});
    render(<DialogCard api={api as unknown as StudioApi} dialog={dialog({})} now={5000} />);
    fireEvent.click(screen.getByText("Let the agent decide"));
    expect(api.answerDialog).toHaveBeenCalledWith("d1", { answer: "delegate" });
    await settle();
  });

  it("offers Press now and Override while the agent's choice is held", () => {
    const api = fakeApi();
    render(<DialogCard api={api as unknown as StudioApi} dialog={dialog({ asking: null, mode: "auto", held: { button: "Don't Save", until: 65_000 } })} now={5000} />);
    expect(screen.getByText(/The agent chose Don't Save, pressing in 1:00/)).toBeTruthy();
    fireEvent.click(screen.getByText("Press Don't Save now"));
    expect(api.answerDialog).toHaveBeenCalledWith("d1", { answer: "release" });
  });

  it("holds the buttons until the minimum time has passed", () => {
    const api = fakeApi();
    render(<DialogCard api={api as unknown as StudioApi} dialog={dialog({ asking: { since: 4000, minHumanMs: 3000, policy: { kind: "wait" } as never, deadline: null, safeButton: null } })} now={5000} />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(api.answerDialog).not.toHaveBeenCalled();
  });
});

describe("Markdown", () => {
  it("draws headings, emphasis, inline and fenced code, lists and links", () => {
    render(<Markdown text={"# Done\n\nI **fixed** the `Door` and:\n\n- one\n- two\n\n```cpp\nint x = 1;\n```\n\n[docs](https://ue-mcp.com)"} />);
    expect(screen.getByText("Done")).toBeTruthy();
    expect(screen.getByText("fixed")).toBeTruthy();
    expect(screen.getByText("Door")).toBeTruthy();
    expect(screen.getByText("one")).toBeTruthy();
    expect(screen.getByText("int x = 1;")).toBeTruthy();
    expect(screen.getByText("cpp")).toBeTruthy();
    expect(screen.getByText("docs")).toBeTruthy();
  });

  it("shows text marked escapes as typed", () => {
    render(<Markdown text={"a < b && c > d"} />);
    expect(screen.getByText("a < b && c > d")).toBeTruthy();
  });

  it("draws a table", () => {
    render(<Markdown text={"| Asset | State |\n|---|---|\n| Door | Saved |"} />);
    expect(screen.getByText("Asset")).toBeTruthy();
    expect(screen.getByText("Saved")).toBeTruthy();
  });
});

describe("DiffView", () => {
  it("marks added and removed lines and folds a long diff", () => {
    const lines = Array.from({ length: 5 }, (_, i) => ({ op: "+" as const, text: `line ${i}` }));
    render(<DiffView lines={[{ op: "-", text: "gone" }, { op: "gap", count: 4 }, ...lines]} label="Changes" max={3} />);
    expect(screen.getByText(/gone/)).toBeTruthy();
    expect(screen.getByText(/4 unchanged lines/)).toBeTruthy();
    expect(screen.getByText("4 more lines not shown")).toBeTruthy();
  });
});


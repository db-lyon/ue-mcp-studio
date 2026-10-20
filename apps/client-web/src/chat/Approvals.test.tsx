// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ApprovalRequest, SessionSummary, ToolCallRecord } from "@ue-mcp-studio/shared";

vi.mock("../api", () => ({ api: { approve: vi.fn(async () => undefined) } }));
import { api } from "../api";
import { Approvals } from "./Approvals";
import { ToolCall } from "./Transcript";
import { sessionLine } from "./SessionRow";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const at = "2026-10-12T12:00:00Z";
const shell: ApprovalRequest = { id: "ap1", toolUseId: "t1", tool: "shell", parent: null, command: "git rev-parse HEAD", cwd: "C:\Projects\Vale", at };
const edit: ApprovalRequest = {
  id: "ap2", toolUseId: "t2", tool: "edit_file", parent: "a1", subagent: "Fix config", path: "C:\Projects\Vale\Config\DefaultGame.ini",
  diff: [{ op: "gap", count: 4 }, { op: " ", text: "[Game]" }, { op: "-", text: "Speed=1" }, { op: "+", text: "Speed=2" }], at,
};

describe("an approval card", () => {
  it("shows the command and where it runs, and sends Allow", async () => {
    render(<Approvals sessionId="s1" approvals={[shell]} />);
    expect(screen.getByText("Run this command?")).toBeTruthy();
    expect(screen.getByText("$ git rev-parse HEAD")).toBeTruthy();
    expect(screen.getByText("in C:\Projects\Vale")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Allow" })));
    expect(api.approve).toHaveBeenCalledWith("s1", "ap1", "allow");
    // One answer per card.
    expect((screen.getByRole("button", { name: "Deny" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows an edit as a diff, names the subagent that asked, and sends each answer", async () => {
    render(<Approvals sessionId="s1" approvals={[edit]} />);
    expect(screen.getByText("Make this edit?")).toBeTruthy();
    expect(screen.getByText("from subagent Fix config")).toBeTruthy();
    expect(screen.getByText("C:\Projects\Vale\Config\DefaultGame.ini")).toBeTruthy();
    const diff = screen.getByLabelText("Changes to C:\Projects\Vale\Config\DefaultGame.ini");
    expect(diff.querySelector(".diff-del")?.textContent).toBe("- Speed=1\n");
    expect(diff.querySelector(".diff-add")?.textContent).toBe("+ Speed=2\n");
    expect(diff.querySelector(".diff-gap")?.textContent).toContain("4 unchanged lines");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Allow for this session" })));
    expect(api.approve).toHaveBeenCalledWith("s1", "ap2", "session");
  });

  it("sends Deny, and lets the user answer again when the answer did not arrive", async () => {
    vi.mocked(api.approve).mockRejectedValueOnce(new Error("no approval ap1 is waiting"));
    render(<Approvals sessionId="s1" approvals={[shell]} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Deny" })));
    expect(api.approve).toHaveBeenCalledWith("s1", "ap1", "deny");
    expect(screen.getByText("no approval ap1 is waiting")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Allow" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("calls a new file a creation, and lists several in order", () => {
    const create: ApprovalRequest = { id: "ap3", toolUseId: "t3", tool: "write_file", parent: null, path: "C:\p\new.md", creates: true, diff: [{ op: "+", text: "# New" }], at };
    render(<Approvals sessionId="s1" approvals={[shell, create]} />);
    const cards = screen.getAllByRole("group");
    expect(cards.map((c) => c.getAttribute("aria-label"))).toEqual(["Run this command?", "Create this file?"]);
  });

  it("is nothing when no call waits", () => {
    const { container } = render(<Approvals sessionId="s1" approvals={[]} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("a session waiting for approval", () => {
  it("says so in the session list", () => {
    const s: SessionSummary = { id: "s", title: "t", status: "running", createdAt: at, updatedAt: at, waitingCause: null, archived: false, agents: { total: 0, running: 0 }, awaiting: 1 };
    expect(sessionLine(s)).toBe("Needs your approval");
  });
});

describe("machine tool calls in the transcript", () => {
  const call = (name: string, input: Record<string, unknown>, result?: string, outcome: ToolCallRecord["outcome"] = "done"): ToolCallRecord =>
    ({ id: "c", name, input, outcome, startedAt: at, endedAt: at, result });

  it("shows a command with its output and exit code", () => {
    const { container } = render(<ToolCall call={call("shell", { command: "git rev-parse HEAD" }, "5c341efc\nExit code: 0")} />);
    expect(screen.getByText("shell")).toBeTruthy();
    expect(container.querySelector(".tool-call")?.textContent).toBe("git rev-parse HEAD");
    expect(screen.getByText("$ git rev-parse HEAD")).toBeTruthy();
    expect(screen.getByText("Output, 2 lines")).toBeTruthy();
    expect(container.textContent).toContain("Exit code: 0");
  });

  it("shows an edit as a diff, by file path", () => {
    const { container } = render(<ToolCall call={call("edit_file", { path: "Source/A.cpp", old_string: "int a = 1;", new_string: "int a = 2;" }, "Edited")} />);
    expect(screen.getByText("edit")).toBeTruthy();
    expect(container.querySelector(".tool-call")?.textContent).toBe("Source/A.cpp");
    expect(container.querySelector(".diff-del")?.textContent).toBe("- int a = 1;\n");
    expect(container.querySelector(".diff-add")?.textContent).toBe("+ int a = 2;\n");
  });

  it("names reads and searches by what they read, and marks a declined call", () => {
    const { container } = render(<>
      <ToolCall call={call("read_file", { path: "Docs/WorldGen/PASSES.md", limit: 20 }, "1\t# Passes")} />
      <ToolCall call={call("web_search", { query: "unreal 5.8" }, "Notes\nhttps://example.com")} />
      <ToolCall call={call("write_file", { path: "x.txt", content: "a" }, "The user declined this file change", "declined")} />
    </>);
    const labels = [...container.querySelectorAll(".tool-call")].map((e) => e.textContent);
    expect(labels).toEqual(["Docs/WorldGen/PASSES.md (from line 1)", "\"unreal 5.8\"", "x.txt"]);
    expect(container.querySelector(".tool.declined")).toBeTruthy();
    expect(screen.getByText("declined")).toBeTruthy();
  });
});

describe("where a session runs", () => {
  const base = { id: "s", title: "t", status: "idle" as const, createdAt: "", updatedAt: "2026-10-12T10:00:00Z", waitingCause: null, archived: false, agents: { total: 0, running: 0 }, awaiting: 0 };
  it("names the model and how it was reached", () => {
    expect(sessionLine({ ...base, model: "Claude Opus 5.5", route: "Claude Code login", status: "running" })).toBe("Claude Opus 5.5 via Claude Code login. Working");
    expect(sessionLine({ ...base, model: "Gemini 3.8 Flash", route: "API key", status: "running" })).toBe("Gemini 3.8 Flash via API key. Working");
    expect(sessionLine({ ...base, status: "stopped" })).toBe("Stopped");
  });
});

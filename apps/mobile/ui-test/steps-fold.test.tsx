import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import type { ToolCallRecord, TranscriptEntry } from "@ue-mcp-studio/shared";
import { MainTranscript, SubagentThread } from "../src/chat/Transcript";
import { AskedContext } from "../src/chat/asked";
import { renderInProject } from "./helpers";
import { ProjectContext } from "../src/nav";

const at = (s: number) => new Date(Date.parse("2026-11-07T10:00:00Z") + s * 1000).toISOString();
let n = 0;
const tool = (name: string, input: Record<string, unknown>, outcome: ToolCallRecord["outcome"] = "done", parent?: string): TranscriptEntry => ({
  kind: "tool",
  ...(parent ? { parent } : {}),
  call: { id: `m${++n}`, name, input, outcome, startedAt: at(n), ...(outcome === "pending" ? {} : { endedAt: at(n), result: "ok" }) },
});
const read = (path: string, outcome: ToolCallRecord["outcome"] = "done", extra: Record<string, unknown> = {}) => tool("read_file", { file_path: path, ...extra }, outcome);
const sh = (command: string, outcome: ToolCallRecord["outcome"] = "done") => tool("shell", { command }, outcome);
const user: TranscriptEntry = { kind: "user", text: "What does the wiki say?", at: at(0) };
const props = (transcript: TranscriptEntry[], status: "idle" | "running" = "idle") => ({ transcript, status, streaming: "", waitingCause: null, error: null, onOpen: vi.fn(), hidden: false });

const wiki = (): TranscriptEntry[] => [
  user,
  sh("ls .wiki/"),
  ...Array.from({ length: 8 }, (_, i) => read(`C:/Vale/.wiki/Page${i}.md`)),
  read("C:/Vale/.wiki/Caravan-Exposure.md", "done", { offset: 55 }),
  sh("head -12 .wiki/Caravan-Exposure.md"),
];

describe("a run of steps on a phone", () => {
  it("is one line, and a press lists every call with each read named", () => {
    renderInProject(<MainTranscript {...props([...wiki(), { kind: "assistant", text: "The caravans are exposed.", at: at(99) }])} />);
    const head = screen.getByRole("button", { name: "Ran 2 commands, read 9 files" });
    expect(screen.queryByText("Page0.md")).toBeNull();
    expect(screen.getByText("The caravans are exposed.")).toBeTruthy();
    fireEvent.click(head);
    expect(screen.getByText("Page0.md")).toBeTruthy();
    expect(screen.getByText("Caravan-Exposure.md (from line 55)")).toBeTruthy();
    expect(screen.getAllByText("read")).toHaveLength(9);
  });

  it("shows the full path on a long press", () => {
    renderInProject(<MainTranscript {...props(wiki())} />);
    fireEvent.click(screen.getByRole("button", { name: "Ran 2 commands, read 9 files" }));
    const line = screen.getByText("Page0.md").closest("[role=button]")!;
    expect(screen.queryByText("C:/Vale/.wiki/Page0.md")).toBeNull();
    // A finger held on the line past the long press delay.
    vi.useFakeTimers();
    const touch = { identifier: 1, target: line, pageX: 10, pageY: 10, clientX: 10, clientY: 10 };
    fireEvent.touchStart(line, { touches: [touch], changedTouches: [touch], targetTouches: [touch] });
    act(() => vi.advanceTimersByTime(1000));
    fireEvent.touchEnd(line, { touches: [], changedTouches: [touch], targetTouches: [] });
    vi.useRealTimers();
    expect(screen.getByText("C:/Vale/.wiki/Page0.md")).toBeTruthy();
  });

  it("names the step running now while the turn runs, and keeps its open state as steps arrive", () => {
    const t = wiki();
    const { rerender, nav } = renderInProject(<MainTranscript {...props([...t, read("C:/Vale/.wiki/Monsters.md", "pending")], "running")} />);
    const head = screen.getByRole("button", { name: /^Ran 2 commands, read 10 files\. Now: read Monsters\.md$/ });
    fireEvent.click(head);
    rerender(<ProjectContext.Provider value={nav}><MainTranscript {...props([...t, read("C:/Vale/.wiki/Monsters.md"), sh("git log -1", "pending")], "running")} /></ProjectContext.Provider>);
    const next = screen.getByRole("button", { name: /^Ran 3 commands, read 10 files\. Now: shell git log -1$/ });
    expect(next.getAttribute("aria-expanded")).toBe("true");
  });

  it("leaves a failed call and a call waiting on approval in view", () => {
    const held = sh("git push", "pending");
    const id = (held as Extract<TranscriptEntry, { kind: "tool" }>).call.id;
    const t = [user, read("a/One.md"), read("a/Two.md"), sh("build", "error"), read("a/Three.md"), read("a/Four.md"), held];
    renderInProject(<AskedContext.Provider value={new Set([id])}><MainTranscript {...props(t, "running")} /></AskedContext.Provider>);
    expect(screen.getAllByRole("button", { name: "Read 2 files" })).toHaveLength(2);
    expect(screen.getByText("build")).toBeTruthy();
    expect(screen.getByText("failed")).toBeTruthy();
    expect(screen.getByText("git push")).toBeTruthy();
  });

  it("folds a subagent's own steps too", () => {
    const agent: ToolCallRecord = { id: "ag", name: "agent", input: { description: "Read the wiki", prompt: "read it" }, outcome: "done", startedAt: at(0), endedAt: at(9) };
    const t: TranscriptEntry[] = [{ kind: "tool", call: agent }, tool("read_file", { path: "w/A.md" }, "done", "ag"), tool("read_file", { path: "w/B.md" }, "done", "ag")];
    renderInProject(<SubagentThread call={agent} transcript={t} sessionWaiting={false} onBack={vi.fn()} onStop={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Read 2 files" })).toBeTruthy();
  });
});

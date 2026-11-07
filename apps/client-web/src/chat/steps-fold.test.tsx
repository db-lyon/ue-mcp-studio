// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ToolCallRecord, TranscriptEntry } from "@ue-mcp-studio/shared";

vi.mock("../api", () => ({ api: {} }));
import { MainTranscript, SubagentThread } from "./Transcript";
import { AskedContext } from "./asked";

const at = (s: number) => new Date(Date.parse("2026-11-07T10:00:00Z") + s * 1000).toISOString();
let n = 0;
const tool = (name: string, input: Record<string, unknown>, outcome: ToolCallRecord["outcome"] = "done", parent?: string): TranscriptEntry => ({
  kind: "tool",
  ...(parent ? { parent } : {}),
  call: { id: `c${++n}`, name, input, outcome, startedAt: at(n), ...(outcome === "pending" ? {} : { endedAt: at(n), result: "ok" }) },
});
const read = (path: string, outcome: ToolCallRecord["outcome"] = "done", extra: Record<string, unknown> = {}) => tool("read_file", { file_path: path, ...extra }, outcome);
const sh = (command: string, outcome: ToolCallRecord["outcome"] = "done") => tool("shell", { command }, outcome);
const user: TranscriptEntry = { kind: "user", text: "What does the wiki say about caravans?", at: at(0) };
const reply = (text: string): TranscriptEntry => ({ kind: "assistant", text, at: at(99) });
const props = { status: "idle" as const, streaming: "", waitingCause: null, error: null, onOpen: vi.fn(), hidden: false };

/** The owner's screenshot: a command, eight reads, a read from line 55 and another command. */
const wikiTurn = (): TranscriptEntry[] => [
  user,
  sh("ls .wiki/ ; find Docs -maxdepth 3 -name \"*.md\""),
  ...Array.from({ length: 8 }, (_, i) => read(`C:/Users/dev/Vale/.wiki/Page${i}.md`)),
  read("C:/Users/dev/Vale/.wiki/Caravan-Exposure.md", "done", { offset: 55 }),
  sh("head -12 .wiki/Caravan-Exposure.md"),
];

afterEach(cleanup);

describe("a run of steps in the transcript", () => {
  it("is one summary line, and opens to every call with each read named", () => {
    const { container } = render(<MainTranscript transcript={[...wikiTurn(), reply("The caravans are exposed on the north road.")]} {...props} />);
    const head = screen.getByRole("button", { name: /Ran 2 commands, read 9 files/ });
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelectorAll("details.tool")).toHaveLength(0);
    // The final reply stays in view under the fold.
    expect(screen.getByText("The caravans are exposed on the north road.")).toBeTruthy();
    fireEvent.click(head);
    const labels = [...container.querySelectorAll(".steps-list .tool-call")].map((e) => e.textContent);
    expect(labels).toHaveLength(11);
    expect(labels).toContain("Page0.md");
    expect(labels).toContain("Caravan-Exposure.md (from line 55)");
    expect(labels.every((l) => l && l.trim())).toBe(true);
    const named = [...container.querySelectorAll(".steps-list .tool-call")].find((e) => e.textContent === "Page0.md");
    expect(named?.getAttribute("title")).toBe("C:/Users/dev/Vale/.wiki/Page0.md");
  });

  it("shows the step running now on the summary while the turn runs", () => {
    const t = [...wikiTurn(), read("C:/Users/dev/Vale/.wiki/Monsters.md", "pending")];
    const { container } = render(<MainTranscript transcript={t} {...props} status="running" />);
    expect(container.querySelector(".steps-fold.running")).toBeTruthy();
    expect(container.querySelector(".steps-live")?.textContent).toBe("read Monsters.md");
    expect(container.querySelector(".steps-live")?.getAttribute("title")).toBe("C:/Users/dev/Vale/.wiki/Monsters.md");
  });

  it("keeps its open state while the turn streams more steps into it", () => {
    const t = wikiTurn();
    const { rerender, container } = render(<MainTranscript transcript={[...t, read("a/Next.md", "pending")]} {...props} status="running" />);
    fireEvent.click(screen.getByRole("button", { name: /Ran 2 commands/ }));
    const more = [...t, read("a/Next.md"), sh("git log -1", "pending")];
    rerender(<MainTranscript transcript={more} {...props} status="running" />);
    expect(screen.getByRole("button", { name: /Ran 3 commands, read 10 files/ }).getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".steps-live")?.textContent).toBe("shell git log -1");
    // Once the turn ends the fold stays open.
    rerender(<MainTranscript transcript={[...more.slice(0, -1), sh("git log -1"), reply("Done.")]} {...props} />);
    expect(screen.getByRole("button", { name: /Ran 3 commands, read 10 files/ }).getAttribute("aria-expanded")).toBe("true");
  });

  it("leaves a failed call outside the fold, in view", () => {
    const t = [user, read("a/One.md"), read("a/Two.md"), sh("npx ue-mcp project build_project", "error"), read("a/Three.md"), read("a/Four.md")];
    const { container } = render(<MainTranscript transcript={t} {...props} />);
    expect(container.querySelectorAll(".steps-fold")).toHaveLength(2);
    const failed = container.querySelector(".transcript > details.tool.error");
    expect(failed?.querySelector(".tool-call")?.textContent).toBe("npx ue-mcp project build_project");
  });

  it("leaves a call waiting on approval outside the fold", () => {
    const held = sh("git push", "pending");
    const t = [user, read("a/One.md"), read("a/Two.md"), held];
    const id = (held as Extract<TranscriptEntry, { kind: "tool" }>).call.id;
    const { container } = render(<AskedContext.Provider value={new Set([id])}><MainTranscript transcript={t} {...props} status="running" /></AskedContext.Provider>);
    expect(container.querySelector(".steps-fold.running")).toBeNull();
    expect(container.querySelector(".transcript > details.tool.pending .tool-call")?.textContent).toBe("git push");
  });

  it("folds a subagent's own steps too", () => {
    const agent: ToolCallRecord = { id: "ag", name: "agent", input: { description: "Read the wiki", prompt: "read it" }, outcome: "done", startedAt: at(0), endedAt: at(9) };
    const t: TranscriptEntry[] = [{ kind: "tool", call: agent }, tool("read_file", { path: "w/A.md" }, "done", "ag"), tool("read_file", { path: "w/B.md" }, "done", "ag")];
    render(<SubagentThread call={agent} transcript={t} sessionWaiting={false} onBack={vi.fn()} onStop={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Read 2 files/ })).toBeTruthy();
  });
});

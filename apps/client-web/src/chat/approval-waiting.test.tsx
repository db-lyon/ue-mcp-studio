// @vitest-environment jsdom
/**
 * #149: a subagent's call waiting for approval left the session reading idle,
 * so nothing said a decision waited. A session with a pending approval, from
 * the main agent or any subagent, shows as waiting on the user in the session
 * list and in the chat.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { SessionSummary, ToolCallRecord, TranscriptEntry } from "@ue-mcp-studio/shared";

const m = vi.hoisted(() => ({ sessions: vi.fn(), updateSession: vi.fn(), deleteSession: vi.fn() }));
vi.mock("../api", () => ({ api: m }));
import { NavDrawer } from "../views/NavDrawer";
import { SessionRow, sessionLine } from "./SessionRow";
import { MainTranscript, SubagentThread } from "./Transcript";
import { Threads } from "./Threads";
import { AskedContext } from "./asked";
import { agentStatus, summarize } from "./model";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const T0 = Date.parse("2026-10-27T12:00:00Z");
const at = (secs: number) => new Date(T0 + secs * 1000).toISOString();

const agent = (id: string): TranscriptEntry => ({
  kind: "tool",
  call: { id, name: "agent", input: { description: "Run the DoorOpens playtest", prompt: "p" }, outcome: "pending", startedAt: at(0) },
});
const shell = (parent: string, id: string, outcome: ToolCallRecord["outcome"] = "pending"): TranscriptEntry => ({
  kind: "tool",
  parent,
  call: { id, name: "shell", input: { command: "npm run build" }, outcome, startedAt: at(2) },
});
const callOf = (e: TranscriptEntry) => (e as Extract<TranscriptEntry, { kind: "tool" }>).call;

// A subagent the user assigned from a playtest card runs while the session's turn is idle.
const idleAsking: SessionSummary = {
  id: "s1", title: "Door playtest", status: "idle", createdAt: at(0), updatedAt: at(5), waitingCause: null, archived: false,
  agents: { total: 1, running: 1 }, awaiting: 1,
};

describe("a subagent waiting for approval", () => {
  const a = agent("a");
  const t = [a, shell("a", "c1")];

  it("waits on the user, not working, naming the call", () => {
    const st = agentStatus(callOf(a), t, false, T0 + 30_000, new Set(["c1"]));
    expect(st).toEqual({ state: "approval", activity: "approve npm run build", secs: 30 });
  });

  it("waits on the user even while the editor is away", () => {
    expect(agentStatus(callOf(a), t, true, T0 + 30_000, new Set(["c1"])).state).toBe("approval");
  });

  it("works again once the call is answered", () => {
    expect(agentStatus(callOf(a), t, false, T0 + 30_000, new Set()).state).toBe("working");
  });

  it("counts as waiting on you in a group's summary", () => {
    expect(summarize(["approval", "working", "done"])).toBe("1 waiting on you, 1 working, 1 done");
  });
});

describe("the session list", () => {
  it("says an idle session is waiting on the user's approval", () => {
    expect(sessionLine(idleAsking)).toBe("Waiting on your approval, 1 of 1 subagents running");
    expect(sessionLine({ ...idleAsking, agents: { total: 0, running: 0 }, awaiting: 2 })).toBe("Waiting on your approval of 2 calls");
  });

  it("marks the row as needing the user, with its dot", () => {
    const { container } = render(<SessionRow s={idleAsking} selected={false} onOpen={vi.fn()} onChanged={vi.fn()} />);
    expect(container.querySelector(".item")?.classList.contains("status-needs-you")).toBe(true);
    expect(container.querySelector(".item")?.classList.contains("status-idle")).toBe(false);
  });

  it("marks the drawer's recent session as needing the user", async () => {
    m.sessions.mockResolvedValue({ sessions: [idleAsking, { ...idleAsking, id: "s2", title: "Quiet", awaiting: 0 }] });
    render(<NavDrawer open tab="Chat" session="s2" updates={0} playtestsWaiting={0} onClose={vi.fn()} onTab={vi.fn()} onSession={vi.fn()} onNewSession={vi.fn()} />);
    const row = (await screen.findByText("Door playtest")).closest("button")!;
    expect(row.classList.contains("status-needs-you")).toBe(true);
    expect(row.getAttribute("title")).toBe("Door playtest, waiting on your approval");
    expect(screen.getByText("Quiet").closest("button")!.classList.contains("status-idle")).toBe(true);
  });
});

describe("the chat", () => {
  const props = { status: "idle" as const, streaming: "", waitingCause: null, error: null, onOpen: vi.fn(), hidden: false };
  const t = [{ kind: "user", text: "go", at: at(0) } as TranscriptEntry, agent("a"), shell("a", "c1")];

  it("says the idle session waits on the user, and the subagent's line says so", () => {
    render(<AskedContext.Provider value={new Set(["c1"])}><MainTranscript transcript={t} {...props} /></AskedContext.Provider>);
    expect(screen.getByRole("status").textContent).toBe("Waiting on you: a call needs your approval below.");
    expect(document.querySelector(".agent-link")?.classList.contains("state-approval")).toBe(true);
    expect(document.querySelector(".agent-link .agents-state")?.textContent).toBe("waiting on you");
  });

  it("says nothing once no call waits", () => {
    render(<MainTranscript transcript={t} {...props} />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(document.querySelector(".agent-link .agents-state")?.textContent).toBe("working");
  });

  it("shows the subagent's thread and its row in the list as waiting on the user", () => {
    render(
      <AskedContext.Provider value={new Set(["c1"])}>
        <SubagentThread call={callOf(t[1])} transcript={t} sessionWaiting={false} onBack={vi.fn()} onStop={vi.fn()} />
        <Threads transcript={t} thread={null} sessionWaiting={false} seen={new Set()} onThread={vi.fn()} onStop={vi.fn()} />
      </AskedContext.Provider>,
    );
    expect(document.querySelector(".thread-head")?.classList.contains("state-approval")).toBe(true);
    expect(document.querySelector(".agents-row:not(.main) .agents-state")?.textContent).toBe("waiting on you");
  });
});

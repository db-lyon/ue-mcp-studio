// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { qaRunFromAnswer, type QaRun, type TranscriptEntry } from "@ue-mcp-studio/shared";

vi.mock("../api", () => ({ api: new Proxy({}, { get: () => () => new Promise(() => {}) }) }));
import { PlaytestsPanel, needsYou, sessionPlaytests } from "./PlaytestsPanel";
import { ChatHeader } from "./ChatHeader";

afterEach(cleanup);

const run = (id: string, name: string, status = "passed", state = "finished"): QaRun =>
  qaRunFromAnswer({ success: true, run_id: id, script: `/Game/S/${name}`, script_name: name, state, results_path: null, steps: [{ index: 0, instruction: "Jump", judge: "manual", status }], awaiting: [], last_seq: 1 }, { sessionId: "s1", seenAt: "2026-10-25T15:00:00.000Z" })!;
const at = "2026-10-25T15:00:00.000Z";

describe("a session's playtests", () => {
  it("are every Playtest card on the main thread, newest first, each run once", () => {
    const transcript: TranscriptEntry[] = [
      { kind: "user", text: "make two", at },
      { kind: "qa", run: run("a", "First") },
      { kind: "assistant", text: "...", at },
      { kind: "qa", run: run("b", "Second") },
      { kind: "qa", run: run("a", "First", "failed") },
      { kind: "qa", run: run("c", "InASubagent"), parent: "agent-1" },
    ];
    const runs = sessionPlaytests(transcript);
    expect(runs.map((r) => r.scriptName)).toEqual(["Second", "First"]);
    expect(runs[1].steps[0].status).toBe("failed");
  });

  it("wait for the user when a step does", () => {
    expect(needsYou(run("a", "A", "awaiting_verdict", "awaiting_verdict"))).toBe(true);
    expect(needsYou(run("a", "A"))).toBe(false);
  });

  it("show collapsed in the panel, each with Show in chat", () => {
    const onShow = vi.fn();
    render(<PlaytestsPanel runs={[run("b", "Second"), run("a", "First")]} onShow={onShow} />);
    expect(screen.getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual(["Playtest Second", "Playtest First"]);
    expect(screen.getAllByRole("list", { name: "Steps" })).toHaveLength(2);
    fireEvent.click(within(screen.getAllByRole("group")[1].parentElement!).getByRole("button", { name: "Show in chat" }));
    expect(onShow).toHaveBeenCalledWith("a");
  });

  it("say how to make one when there are none", () => {
    render(<PlaytestsPanel runs={[]} onShow={vi.fn()} />);
    expect(screen.getByText(/no playtests yet/)).toBeTruthy();
  });
});

describe("the narrow header's Playtests button", () => {
  const header = (playtests: number, waiting = false, onPlaytests = vi.fn()) =>
    render(<ChatHeader title="S" thread={null} transcript={[]} sessionWaiting={false} agents={0} onSessions={vi.fn()} onMain={vi.fn()} onStop={vi.fn()} playtests={playtests} playtestsWaiting={waiting} onPlaytests={onPlaytests} />);

  it("shows the count, marked when one waits, and opens the panel", () => {
    const open = vi.fn();
    header(3, true, open);
    const b = screen.getByRole("button", { name: "Playtests (3)" });
    expect(b.className).toContain("needs-you");
    fireEvent.click(b);
    expect(open).toHaveBeenCalled();
  });

  it("is absent while the session has none", () => {
    header(0);
    expect(screen.queryByRole("button", { name: /Playtests/ })).toBeNull();
  });
});

/**
 * A long session (8 MB of transcript, as a real one grows): it opens on its
 * newest lines at once, draws only the lines near the screen, and a line that
 * cannot be drawn says so in place instead of blanking the thread.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import type { TranscriptEntry } from "@ue-mcp-studio/shared";
import { UNREADABLE_ENTRY } from "@ue-mcp-studio/client-core";
import { FIRST_ROWS, MainTranscript } from "../src/chat/Transcript";
import { Chat } from "../src/views/Chat";
import { HUGE_ID, HUGE_LAST, HUGE_TITLE, hugeSession, hugeTranscript } from "../visual-qa/huge-session";
import { fakeApi, renderInProject, settle } from "./helpers";

// A reply whose text is "BOOM" fails to draw, as a line the renderer cannot take would.
vi.mock("../src/ui/Markdown", async (original) => {
  const real = await original<typeof import("../src/ui/Markdown")>();
  return {
    ...real,
    Markdown: (p: Parameters<typeof real.Markdown>[0]) => {
      if (p.text === "BOOM") throw new Error("cannot draw this");
      return <real.Markdown {...p} />;
    },
  };
});

const props = (transcript: TranscriptEntry[]) => ({ transcript, status: "idle" as const, streaming: "", waitingCause: null, error: null, onOpen: vi.fn(), hidden: false });

describe("a long session", () => {
  it("opens an 8 MB transcript on its newest lines, quickly, drawing only the lines near the screen", () => {
    const transcript = hugeTranscript(8_000_000);
    expect(JSON.stringify(transcript).length).toBeGreaterThan(8_000_000);
    const started = performance.now();
    renderInProject(<MainTranscript {...props(transcript)} />);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(screen.getByText(HUGE_LAST)).toBeTruthy();
    const turns = screen.queryAllByText(/^Turn \d+$/).length;
    expect(turns).toBeGreaterThan(0);
    expect(turns).toBeLessThanOrEqual(FIRST_ROWS);
    // No scroll to the end and no page button: the newest line is the list's first.
    expect(screen.queryByLabelText(/^Show earlier messages/)).toBeNull();
  });

  it("draws every line of a short session, with no way to earlier ones", () => {
    renderInProject(<MainTranscript {...props([{ kind: "user", text: "Fix it", at: "2026-11-04T12:00:00Z" }, { kind: "assistant", text: "Fixed.", at: "2026-11-04T12:01:00Z" }])} />);
    expect(screen.getByText("Fix it")).toBeTruthy();
    expect(screen.getByText("Fixed.")).toBeTruthy();
  });

  it("opens in the chat from the daemon's answer and shows its newest line", async () => {
    const api = fakeApi();
    const detail = hugeSession(8_000_000);
    api.sessions.mockResolvedValue({ sessions: [{ ...detail, transcript: undefined }] });
    api.settings.mockResolvedValue({ route: "key" });
    api.sessionSync.mockResolvedValue(detail);
    renderInProject(<Chat initialSession={HUGE_ID} />, api);
    await settle();
    await settle();
    expect(screen.getByText(HUGE_TITLE)).toBeTruthy();
    expect(screen.getByText(HUGE_LAST)).toBeTruthy();
  });

  describe("while background subagents fill the newest page", () => {
    const at = "2026-11-13T21:19:29.165Z";
    const sub = (i: number): TranscriptEntry => ({ kind: "tool", parent: "g1", call: { id: `c${i}`, name: "shell", input: { command: `run ${i}` }, outcome: "done", result: "ok", startedAt: at } });
    const whole: TranscriptEntry[] = [
      ...Array.from({ length: 24 }, (_, i): TranscriptEntry => ({ kind: i % 2 ? "assistant" : "user", text: `main ${i}`, at })),
      { kind: "user", text: "get those workers going again", at },
      { kind: "assistant", text: "Both workers are running again.", at },
      ...Array.from({ length: 329 }, (_, i) => sub(i)),
      { kind: "note", text: "The editor disconnected during this turn: the project is rebuilding.", at },
    ];

    it("offers the earlier messages at the top of a thread too short to scroll", () => {
      const more = vi.fn();
      renderInProject(<MainTranscript {...props(whole.slice(-60))} more={more} />);
      expect(screen.getByText("The editor disconnected during this turn: the project is rebuilding.")).toBeTruthy();
      fireEvent.click(screen.getByText("Show earlier messages"));
      expect(more).toHaveBeenCalled();
    });

    it("opens on the main thread against a daemon that answers only the 60 entries asked for", async () => {
      const api = fakeApi();
      const base = { id: "s9", title: "Vale: build the combat features", status: "running", createdAt: at, updatedAt: at, touched: [], draft: "", seen: [], dismissed: [], queue: [], error: null, approvals: [], waitingCause: null };
      api.sessions.mockResolvedValue({ sessions: [base] });
      api.settings.mockResolvedValue({ route: "key" });
      api.sessionSync.mockImplementation(async (_id: string, _have: string | undefined, p?: { tail?: number; before?: number }) => {
        const end = p?.before ?? whole.length;
        const from = Math.max(0, end - (p?.tail ?? end));
        return { ...base, hashes: "", transcript: whole.slice(from, end), from, total: whole.length };
      });
      renderInProject(<Chat initialSession="s9" />, api);
      for (let i = 0; i < 8; i++) await settle();
      expect(screen.getByText("Both workers are running again.")).toBeTruthy();
      expect(screen.getByText("get those workers going again")).toBeTruthy();
    });
  });

  it("keeps the chat around entries of a shape it does not know: the rest draws, and the composer stays", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const at = "2026-11-13T21:19:29.165Z";
    const api = fakeApi();
    const base = { id: "s8", title: "Odd shapes", status: "idle", createdAt: at, updatedAt: at, touched: [], draft: "", seen: [], dismissed: [], queue: [], error: null, approvals: [], waitingCause: null };
    api.sessions.mockResolvedValue({ sessions: [base] });
    api.settings.mockResolvedValue({ route: "key" });
    const odd = [
      { kind: "user", text: "Before the odd ones", at },
      { kind: "tool", at },
      { kind: "a-kind-from-a-later-daemon", payload: { x: 1 }, at },
      { kind: "assistant", text: "After the odd ones", at },
    ] as unknown as TranscriptEntry[];
    api.sessionSync.mockResolvedValue({ ...base, transcript: odd, subagents: "not a list", working: 7 });
    renderInProject(<Chat initialSession="s8" />, api);
    await settle();
    await settle();
    expect(screen.getByText("Odd shapes")).toBeTruthy();
    expect(screen.getByText("Before the odd ones")).toBeTruthy();
    expect(screen.getByText("After the odd ones")).toBeTruthy();
    expect(screen.getByText(UNREADABLE_ENTRY)).toBeTruthy();
  });

  it("says a line could not be shown in its place, and still shows the rest", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const broken: TranscriptEntry = { kind: "assistant", text: "BOOM", at: "2026-11-04T12:00:00Z" };
    renderInProject(<MainTranscript {...props([{ kind: "user", text: "Fix it", at: "2026-11-04T12:00:00Z" }, broken, { kind: "assistant", text: "Fixed.", at: "2026-11-04T12:01:00Z" }])} />);
    expect(screen.getByText("This item could not be shown: cannot draw this")).toBeTruthy();
    expect(screen.getByText("Fix it")).toBeTruthy();
    expect(screen.getByText("Fixed.")).toBeTruthy();
  });
});

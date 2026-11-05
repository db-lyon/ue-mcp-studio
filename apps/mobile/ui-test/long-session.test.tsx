/**
 * A long session (8 MB of transcript, as a real one grows): it opens on its
 * newest lines at once, draws older ones a page at a time from the top, and a
 * line that cannot be drawn says so in place instead of blanking the thread.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import type { TranscriptEntry } from "@ue-mcp-studio/shared";
import { MainTranscript, TRANSCRIPT_PAGE } from "../src/chat/Transcript";
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
  it("opens an 8 MB transcript on its newest lines, quickly, and draws older ones a page at a time", () => {
    const transcript = hugeTranscript(8_000_000);
    expect(JSON.stringify(transcript).length).toBeGreaterThan(8_000_000);
    const started = performance.now();
    renderInProject(<MainTranscript {...props(transcript)} />);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(screen.getByText(HUGE_LAST)).toBeTruthy();
    const turns = () => screen.queryAllByText(/^Turn \d+$/).length;
    const first = turns();
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(TRANSCRIPT_PAGE);
    fireEvent.click(screen.getByLabelText(/^Show earlier messages \(\d+ more\)$/));
    expect(turns()).toBeGreaterThan(first);
    expect(screen.getByText(HUGE_LAST)).toBeTruthy();
  });

  it("draws every line of a short session, with no way to earlier ones", () => {
    renderInProject(<MainTranscript {...props([{ kind: "user", text: "Fix it", at: "2026-11-04T12:00:00Z" }, { kind: "assistant", text: "Fixed.", at: "2026-11-04T12:01:00Z" }])} />);
    expect(screen.getByText("Fix it")).toBeTruthy();
    expect(screen.queryByLabelText(/^Show earlier messages/)).toBeNull();
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

  it("says a line could not be shown in its place, and still shows the rest", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const broken: TranscriptEntry = { kind: "assistant", text: "BOOM", at: "2026-11-04T12:00:00Z" };
    renderInProject(<MainTranscript {...props([{ kind: "user", text: "Fix it", at: "2026-11-04T12:00:00Z" }, broken, { kind: "assistant", text: "Fixed.", at: "2026-11-04T12:01:00Z" }])} />);
    expect(screen.getByText("This line of the conversation could not be shown: cannot draw this")).toBeTruthy();
    expect(screen.getByText("Fix it")).toBeTruthy();
    expect(screen.getByText("Fixed.")).toBeTruthy();
  });
});

/**
 * On Android a thread's scroller draws nothing once its content runs to tens
 * of thousands of pixels (a real session's newest lines measured 540, 1873 and
 * 5974 dp at 4 px per dp). A thread opens on a page of its newest lines, and a
 * line taller than FOLD_MAX folds behind Show more.
 */
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import type { TranscriptEntry } from "@ue-mcp-studio/shared";
import { FOLD_MAX, MainTranscript, PAGE_ROWS } from "../src/chat/Transcript";
import { fakeApi, renderInProject, settle } from "./helpers";
import { Chat, TAIL_ENTRIES } from "../src/views/Chat";
import { HUGE_ID, hugeSession } from "../visual-qa/huge-session";

const props = (transcript: TranscriptEntry[]) => ({ transcript, status: "idle" as const, streaming: "", waitingCause: null, error: null, onOpen: vi.fn(), hidden: false });

/** What the platform reports when it lays a line out at `height` dp. */
function layOut(el: Element, height: number) {
  const handler = (el as unknown as { __reactLayoutHandler?: (e: unknown) => void }).__reactLayoutHandler;
  if (!handler) throw new Error("no layout handler on the element");
  act(() => handler({ nativeEvent: { layout: { x: 0, y: 0, width: 336, height } } }));
}

const at = "2026-11-07T12:00:00Z";

describe("a thread on a phone", () => {
  it("folds a line taller than FOLD_MAX behind Show more, and opens it on a press", () => {
    renderInProject(<MainTranscript {...props([{ kind: "user", text: "What's next?", at }, { kind: "assistant", text: "A long answer.\n\n".repeat(200), at }])} />);
    const bodies = screen.getAllByTestId("fold-body");
    expect(bodies).toHaveLength(2);
    // The list is inverted: the newest line (the long answer) is its first row.
    layOut(bodies[0], 5974);
    layOut(bodies[1], 41);
    const more = screen.getByRole("button", { name: "Show more" });
    expect(screen.getAllByRole("button", { name: /^Show (more|less)$/ })).toHaveLength(1);
    const fold = screen.getAllByTestId("fold")[0] as HTMLElement;
    expect(fold.style.maxHeight).toBe(`${FOLD_MAX}px`);
    fireEvent.click(more);
    expect(screen.getByRole("button", { name: "Show less" })).toBeTruthy();
    expect((screen.getAllByTestId("fold")[0] as HTMLElement).style.maxHeight).toBe("");
  });

  it("leaves a short line as it is", () => {
    renderInProject(<MainTranscript {...props([{ kind: "user", text: "Fix it", at }, { kind: "assistant", text: "Fixed.", at }])} />);
    for (const b of screen.getAllByTestId("fold-body")) layOut(b, 60);
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("opens on a page of the newest lines, not the whole session", () => {
    const transcript: TranscriptEntry[] = Array.from({ length: 40 }, (_, i) => ({ kind: i % 2 ? "assistant" : "user", text: `Line ${i}`, at }) as TranscriptEntry);
    renderInProject(<MainTranscript {...props(transcript)} />);
    expect(screen.getByText("Line 39")).toBeTruthy();
    expect(screen.getByText(`Line ${40 - PAGE_ROWS}`)).toBeTruthy();
    expect(screen.queryByText(`Line ${40 - PAGE_ROWS - 1}`)).toBeNull();
    expect(screen.queryByText("Line 0")).toBeNull();
  });
});

describe("a thread read a page at a time", () => {
  it("asks for the entries before the held ones once every held line is drawn and the reader reaches the top", async () => {
    const more = vi.fn();
    renderInProject(<MainTranscript {...props([{ kind: "user", text: "Fix it", at }, { kind: "assistant", text: "Fixed.", at }])} more={more} />);
    // The platform lays the list out: 400 dp of screen, the two short lines 120 dp of content.
    const list = document.getElementById("transcript")!;
    layOut(list, 400);
    layOut(list.firstElementChild!, 120);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(more).toHaveBeenCalled();
  });
});

describe("a session opened in the chat", () => {
  it("reads only its newest entries, and the entries before them as the reader reaches the top", async () => {
    const api = fakeApi();
    const whole = hugeSession(400_000);
    const n = whole.transcript.length;
    expect(n).toBeGreaterThan(TAIL_ENTRIES);
    api.sessions.mockResolvedValue({ sessions: [{ ...whole, transcript: undefined }] });
    api.settings.mockResolvedValue({ route: "key" });
    api.sessionSync.mockImplementation(async (_id: string, have?: string, page?: { tail?: number; before?: number }) => {
      // Asked again with the hashes held (the stream came up): nothing changed.
      if (have !== undefined) return { ...whole, transcript: undefined, hashes: "H", changed: { length: n, entries: [] } };
      const end = page?.before ?? n;
      const from = Math.max(0, end - (page?.tail ?? n));
      return { ...whole, hashes: "H", transcript: whole.transcript.slice(from, end), from, total: n };
    });
    renderInProject(<Chat initialSession={HUGE_ID} />, api);
    await settle();
    await settle();
    expect(api.sessionSync).toHaveBeenCalledWith(HUGE_ID, undefined, { tail: TAIL_ENTRIES });
    // The reader reaches the top of what is drawn, again and again: older pages are read in front.
    const paged = () => api.sessionSync.mock.calls.some((c: unknown[]) => (c[2] as { before?: number } | undefined)?.before !== undefined);
    for (let i = 0; i < 40 && !paged(); i++) {
      const list = document.getElementById("transcript")!;
      layOut(list, 400);
      layOut(list.firstElementChild!, 120 + 10 * i);
      await settle();
    }
    expect(api.sessionSync).toHaveBeenCalledWith(HUGE_ID, undefined, { tail: TAIL_ENTRIES, before: n - TAIL_ENTRIES });
  }, 30_000);
});

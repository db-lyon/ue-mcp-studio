/**
 * On Android a thread's scroller draws nothing once its content runs to tens
 * of thousands of pixels (a real session's newest lines measured 540, 1873 and
 * 5974 dp at 4 px per dp). A thread opens on a page of its newest lines, and a
 * line taller than FOLD_MAX folds behind Show more.
 */
import { describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { View } from "react-native";
import type { ToolCallRecord, TranscriptEntry } from "@ue-mcp-studio/shared";
import { FIRST_ROWS, FOLD_FADE, FOLD_MAX, MainTranscript, PAGE_ROWS, SubagentThread, UNFOLDED_MAX, streamPieces } from "../src/chat/Transcript";
import { Markdown, MarkdownPiece, PIECE_CHARS, THEMES, ThemeProvider, markdownPieces } from "../src/ui";
import { longReply } from "../visual-qa/long-reply";
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

/** A colour as the DOM reports an inline style's. */
function rgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

describe("a thread on a phone", () => {
  it("folds an older line taller than FOLD_MAX behind a centred Show more pill over a fade, and opens it on a press", () => {
    renderInProject(<MainTranscript {...props([{ kind: "user", text: "What's next?", at }, { kind: "assistant", text: "A tall answer.", at }, { kind: "user", text: "Thanks", at }])} />);
    const bodies = screen.getAllByTestId("fold-body");
    expect(bodies).toHaveLength(3);
    // The list is inverted: the newest line is its first row.
    layOut(bodies[0], 41);
    layOut(bodies[1], 5974);
    layOut(bodies[2], 41);
    const more = screen.getByRole("button", { name: "Show more" });
    expect(screen.getAllByRole("button", { name: /^Show (more|less)$/ })).toHaveLength(1);
    const fold = screen.getAllByTestId("fold")[1] as HTMLElement;
    expect(fold.style.maxHeight).toBe(`${FOLD_MAX}px`);
    const fade = within(fold).getByTestId("fold-fade");
    expect(fade.style.height).toBe(`${FOLD_FADE}px`);
    // No hard rule across the cut: the pill is centred under the fade, 44 dp tall, in the accent.
    const pill = screen.getByTestId("fold-pill");
    expect(pill.style.minHeight).toBe("44px");
    expect(pill.style.borderTopColor).toBe(rgb(THEMES["ue-mcp"].c.accent));
    expect((pill.parentElement as HTMLElement).style.alignItems).toBe("center");
    expect(within(pill).getByText("Show more").style.color).toBe(rgb(THEMES["ue-mcp"].c.accent));
    fireEvent.click(more);
    expect(screen.getByRole("button", { name: "Show less" })).toBeTruthy();
    expect((screen.getAllByTestId("fold")[1] as HTMLElement).style.maxHeight).toBe("");
    expect(screen.queryByTestId("fold-fade")).toBeNull();
  });

  it("draws the pill in the editor theme's accent", () => {
    renderInProject(
      <ThemeProvider name="editor">
        <MainTranscript {...props([{ kind: "assistant", text: "A tall answer.", at }, { kind: "user", text: "Thanks", at }])} />
      </ThemeProvider>,
    );
    layOut(screen.getAllByTestId("fold-body")[1], 900);
    const pill = screen.getByTestId("fold-pill");
    expect(pill.style.borderTopColor).toBe(rgb(THEMES.editor.c.accent));
    expect(within(pill).getByText("Show more").style.color).toBe(rgb(THEMES.editor.c.accent));
  });

  it("never folds the newest line: a reply about 6000 dp tall is drawn as pieces on rows of their own", () => {
    const text = longReply();
    renderInProject(<MainTranscript {...props([{ kind: "user", text: "Plan it", at }, { kind: "assistant", text, at }])} />);
    const n = markdownPieces(text, true, true);
    expect(n).toBeGreaterThan(FIRST_ROWS);
    // Every piece is a row of the list, so the list draws only the ones near the screen: the newest first.
    const pieces = screen.getAllByTestId("reply-piece");
    expect(pieces).toHaveLength(FIRST_ROWS);
    expect(within(pieces[0]).getByText("The last paragraph.")).toBeTruthy();
    for (const b of screen.getAllByTestId("fold-body")) layOut(b, 520);
    expect(screen.queryByRole("button", { name: /^Show (more|less)$/ })).toBeNull();
    for (const f of screen.getAllByTestId("fold")) expect(f.style.maxHeight).toBe("");
  });

  it("cuts a long reply into pieces that stack back into the whole, each within the budget", () => {
    const text = longReply();
    const n = markdownPieces(text, true, true);
    const whole = render(<Markdown text={text} assets />).container.textContent;
    cleanup();
    const { container } = render(
      <View>
        {Array.from({ length: n }, (_, i) => (
          <View key={i} testID="piece">
            <MarkdownPiece text={text} piece={i} assets />
          </View>
        ))}
      </View>,
    );
    // The same text in the same order (a run of code ends its own box instead of a line break).
    const words = (s: string | null) => (s ?? "").replace(/\s+/g, "");
    expect(words(container.textContent)).toBe(words(whole));
    for (const p of screen.getAllByTestId("piece")) expect((p.textContent ?? "").length).toBeLessThanOrEqual(PIECE_CHARS);
    // The numbered list keeps counting across pieces, and the code is cut between lines.
    for (const k of [1, 15, 30]) expect(screen.getByText(`${k}.`)).toBeTruthy();
    expect(screen.getAllByLabelText("cpp code").length).toBeGreaterThan(1);
  });

  it("folds the previous newest line again when a newer one arrives, and keeps a line the reader opened open", () => {
    const text = longReply();
    const first: TranscriptEntry[] = [{ kind: "user", text: "Plan it", at }, { kind: "assistant", text, at }];
    const { rerender } = renderInProject(<MainTranscript {...props(first)} />);
    expect(screen.getAllByTestId("reply-piece").length).toBeGreaterThan(3);
    const second: TranscriptEntry[] = [...first, { kind: "user", text: "And then?", at }];
    rerender(<MainTranscript {...props(second)} />);
    // One row again, folded from its first frame because it is known to be long.
    expect(screen.queryAllByTestId("reply-piece")).toHaveLength(0);
    expect(screen.getAllByTestId("fold")[1].style.maxHeight).toBe(`${FOLD_MAX}px`);
    layOut(screen.getAllByTestId("fold-body")[1], 6000);
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getAllByTestId("reply-piece").length).toBeGreaterThan(3);
    // Show less sits once, under the last piece: the inverted list holds the newest row first.
    const less = screen.getAllByRole("button", { name: "Show less" });
    expect(less).toHaveLength(1);
    const pieces = screen.getAllByTestId("reply-piece");
    expect(within(pieces[0]).getByText("The last paragraph.")).toBeTruthy();
    expect(pieces[0].compareDocumentPosition(less[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(less[0].compareDocumentPosition(pieces[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    rerender(<MainTranscript {...props([...second, { kind: "assistant", text: "Then the save system.", at }])} />);
    expect(screen.getAllByTestId("reply-piece").length).toBeGreaterThan(3);
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(screen.queryAllByTestId("reply-piece")).toHaveLength(0);
    expect(screen.getAllByTestId("fold")[2].style.maxHeight).toBe(`${FOLD_MAX}px`);
  });

  it("draws the newest reply of a subagent's own thread as pieces too, never folded", () => {
    const agent: ToolCallRecord = { id: "ag", name: "agent", input: { description: "Plan the save system", prompt: "plan it" }, outcome: "pending", startedAt: at };
    const t: TranscriptEntry[] = [{ kind: "tool", call: agent }, { kind: "assistant", text: longReply(), at, parent: "ag" }];
    renderInProject(<SubagentThread call={agent} transcript={t} sessionWaiting={false} onBack={vi.fn()} onStop={vi.fn()} />);
    const pieces = screen.getAllByTestId("reply-piece");
    expect(pieces.length).toBeGreaterThan(3);
    expect(within(pieces[0]).getByText("The last paragraph.")).toBeTruthy();
    for (const b of screen.getAllByTestId("fold-body")) layOut(b, 520);
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("still folds a newest line that cannot be cut once it is taller than UNFOLDED_MAX", () => {
    renderInProject(<MainTranscript {...props([{ kind: "user", text: "Fix it", at }, { kind: "assistant", text: "Short.", at }])} />);
    const bodies = screen.getAllByTestId("fold-body");
    layOut(bodies[0], UNFOLDED_MAX - 10);
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
    layOut(bodies[0], UNFOLDED_MAX + 10);
    expect(screen.getByRole("button", { name: "Show more" })).toBeTruthy();
  });

  it("draws a long streaming reply as pieces, cut at blank lines, that stack back into the whole", () => {
    const text = Array.from({ length: 40 }, (_, i) => `Streamed paragraph ${i} ${"word ".repeat(40)}`).join("\n\n");
    const runs = streamPieces(text);
    expect(runs.length).toBeGreaterThan(3);
    expect(runs.join("\n")).toBe(text);
    for (const r of runs.slice(0, -1)) expect(r.length).toBeLessThanOrEqual(PIECE_CHARS);
    // Earlier cuts stay put as more text arrives.
    expect(streamPieces(`${text}\n\nMore.`).slice(0, runs.length - 1)).toEqual(runs.slice(0, -1));
    renderInProject(<MainTranscript {...props([{ kind: "user", text: "Go", at }])} streaming={text} status="running" />);
    expect(screen.getAllByTestId("stream-piece")).toHaveLength(runs.length);
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
    for (let i = 0; i < 50 && !document.getElementById("transcript"); i++) await settle();
    for (let i = 0; i < 100 && !paged(); i++) {
      const list = document.getElementById("transcript");
      if (!list) {
        await settle();
        continue;
      }
      layOut(list, 400);
      layOut(list.firstElementChild!, 120 + 10 * i);
      await settle();
    }
    expect(api.sessionSync).toHaveBeenCalledWith(HUGE_ID, undefined, { tail: TAIL_ENTRIES, before: n - TAIL_ENTRIES });
  }, 60_000);
});

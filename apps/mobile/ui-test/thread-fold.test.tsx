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
import { renderInProject } from "./helpers";

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

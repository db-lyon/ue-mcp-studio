// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";

vi.mock("../api", () => ({
  api: { uploadAttachment: vi.fn(async (_id: string, u: { name: string; type: string; data: string }) => ({ id: `id-${u.name}`, name: u.name, type: u.type, size: 3 })) },
}));
import { api } from "../api";
import { useRef } from "react";
import { Composer, MAX_LINES, MIN_HEIGHT, MIN_TRANSCRIPT, NUDGE, clampHeight, fitHeight } from "./Composer";
import { useAttachments, type PendingFile } from "./attachments";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const base = {
  draft: "", onDraft: vi.fn(), onBlur: vi.fn(), placeholder: "Ask", busy: false, canSend: true,
  onSend: vi.fn(), onStop: vi.fn(), files: [] as PendingFile[], onAddFiles: vi.fn(), onRemoveFile: vi.fn(), picker: null,
};

describe("the composer", () => {
  it("attaches pasted files and leaves pasted text alone", () => {
    const onAddFiles = vi.fn();
    render(<Composer {...base} onAddFiles={onAddFiles} />);
    const box = screen.getByPlaceholderText("Ask");
    const file = new File(["x"], "shot.png", { type: "image/png" });
    fireEvent.paste(box, { clipboardData: { files: [file], types: ["Files"] } });
    expect(onAddFiles).toHaveBeenCalledWith([file]);
    onAddFiles.mockClear();
    fireEvent.paste(box, { clipboardData: { files: [], types: ["text/plain"] } });
    expect(onAddFiles).not.toHaveBeenCalled();
  });

  it("sends on Enter only when it can, and keeps Shift+Enter for a new line", () => {
    const onSend = vi.fn();
    const { rerender } = render(<Composer {...base} onSend={onSend} canSend={false} />);
    const box = screen.getByPlaceholderText("Ask");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    rerender(<Composer {...base} onSend={onSend} canSend />);
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("shows each file with its state, and removes one", () => {
    const onRemoveFile = vi.fn();
    const files: PendingFile[] = [
      { key: "a", name: "rock.fbx", type: "application/octet-stream", size: 2048, preview: null, state: "ready" },
      { key: "b", name: "big.mp4", type: "video/mp4", size: 1, preview: null, state: "error", error: "larger than 100.0 MB" },
    ];
    render(<Composer {...base} files={files} onRemoveFile={onRemoveFile} />);
    expect(screen.getByText("rock.fbx")).toBeTruthy();
    expect(screen.getByText("FBX")).toBeTruthy();
    expect(screen.getByText("larger than 100.0 MB")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove rock.fbx" }));
    expect(onRemoveFile).toHaveBeenCalledWith("a");
  });
});

describe("adding files", () => {
  it("uploads each file as it is added, and offers the uploaded ones for the next message", async () => {
    globalThis.URL.createObjectURL = vi.fn(() => "blob:preview");
    globalThis.URL.revokeObjectURL = vi.fn();
    const { result } = renderHook(() => useAttachments("s1"));
    act(() => result.current.add([new File(["abc"], "ref.png", { type: "image/png" }), new File(["abc"], "notes.txt", { type: "text/plain" })]));
    expect(result.current.uploading).toBe(true);
    await waitFor(() => expect(result.current.ready).toHaveLength(2));
    expect(api.uploadAttachment).toHaveBeenCalledWith("s1", { name: "ref.png", type: "image/png", data: "YWJj" });
    expect(result.current.files[0].preview).toBe("blob:preview");
    act(() => result.current.clear());
    expect(result.current.files).toHaveLength(0);
  });

  it("refuses a file over the limit without uploading it", () => {
    const { result } = renderHook(() => useAttachments("s1"));
    const huge = new File(["x"], "huge.mov", { type: "video/quicktime" });
    Object.defineProperty(huge, "size", { value: 200 * 1024 * 1024 });
    act(() => result.current.add([huge]));
    expect(result.current.files[0].state).toBe("error");
    expect(api.uploadAttachment).not.toHaveBeenCalled();
  });
});

// jsdom lays nothing out: the box's content height is its line count times LINE, plus its padding.
const LINE = 20;
const PAD = 20;
const CHROME = PAD + 2;
const CAP = MAX_LINES * LINE + CHROME;
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

describe("the composer's height", () => {
  const sheet = document.createElement("style");
  sheet.textContent = `textarea { font-size: 14px; line-height: ${LINE}px; padding: ${PAD / 2}px 12px; border: 1px solid black; }`;
  document.head.appendChild(sheet);
  Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLTextAreaElement) {
      return this.value.split("\n").length * LINE + PAD;
    },
  });

  /** The composer under a transcript of `stageHeight` pixels that gives up what the box takes. */
  function Laid({ stageHeight = 600, ...props }: Partial<React.ComponentProps<typeof Composer>> & { stageHeight?: number }) {
    const stage = useRef<HTMLDivElement | null>(null);
    const setStage = (el: HTMLDivElement | null) => {
      stage.current = el;
      const total = stageHeight + MIN_HEIGHT;
      if (el) Object.defineProperty(el, "clientHeight", { configurable: true, get: () => total - (parseFloat(textbox().style.height) || MIN_HEIGHT) });
    };
    return (
      <div>
        <div ref={setStage} />
        <Composer {...base} stage={stage} {...props} />
      </div>
    );
  }
  const textbox = () => screen.getByPlaceholderText("Ask") as HTMLTextAreaElement;
  const boxHeight = () => parseFloat(textbox().style.height);
  const overflow = () => textbox().style.overflowY;
  const divider = () => screen.getByRole("separator", { name: "Resize the message box" });
  const drag = (from: number, to: number) => {
    fireEvent.mouseDown(divider(), { clientY: from, button: 0 });
    fireEvent.mouseMove(window, { clientY: to });
    fireEvent.mouseUp(window, { clientY: to });
  };

  it("grows with its content up to 15 lines, then scrolls", () => {
    const { rerender } = render(<Laid draft="hi" />);
    expect(boxHeight()).toBe(MIN_HEIGHT);
    expect(overflow()).toBe("hidden");
    rerender(<Laid draft={lines(8)} />);
    expect(boxHeight()).toBe(8 * LINE + CHROME);
    expect(overflow()).toBe("hidden");
    rerender(<Laid draft={lines(20)} />);
    expect(boxHeight()).toBe(CAP);
    expect(overflow()).toBe("auto");
  });

  it("shrinks back when the text is removed or sent", () => {
    const { rerender } = render(<Laid draft={lines(20)} />);
    expect(boxHeight()).toBe(CAP);
    rerender(<Laid draft={lines(4)} />);
    expect(boxHeight()).toBe(4 * LINE + CHROME);
    rerender(<Laid draft="" />);
    expect(boxHeight()).toBe(MIN_HEIGHT);
  });

  it("never takes the transcript's last usable height", () => {
    render(<Laid draft={lines(20)} stageHeight={200} />);
    // The box's own height, plus what the transcript can give up.
    expect(boxHeight()).toBe(MIN_HEIGHT + 200 - MIN_TRANSCRIPT);
    expect(overflow()).toBe("auto");
  });

  it("drags taller and shorter from the divider, and saves where it was let go", () => {
    const onHeight = vi.fn();
    render(<Laid draft="" onHeight={onHeight} />);
    drag(500, 300);
    expect(boxHeight()).toBe(MIN_HEIGHT + 200);
    expect(onHeight).toHaveBeenLastCalledWith(MIN_HEIGHT + 200);
    drag(300, 400);
    expect(boxHeight()).toBe(MIN_HEIGHT + 100);
    expect(onHeight).toHaveBeenLastCalledWith(MIN_HEIGHT + 100);
    expect(divider().getAttribute("aria-valuenow")).toBe(String(MIN_HEIGHT + 100));
  });

  it("clamps a drag so the transcript and the box both stay usable", () => {
    const onHeight = vi.fn();
    render(<Laid draft="" stageHeight={400} onHeight={onHeight} />);
    drag(500, -5000);
    expect(boxHeight()).toBe(MIN_HEIGHT + 400 - MIN_TRANSCRIPT);
    expect(onHeight).toHaveBeenLastCalledWith(MIN_HEIGHT + 400 - MIN_TRANSCRIPT);
    drag(0, 5000);
    expect(boxHeight()).toBe(MIN_HEIGHT);
    expect(onHeight).toHaveBeenLastCalledWith(MIN_HEIGHT);
  });

  it("treats a dragged height as a minimum the content can grow past, up to 15 lines", () => {
    const { rerender } = render(<Laid draft="" height={150} />);
    expect(boxHeight()).toBe(150);
    rerender(<Laid draft={lines(10)} height={150} />);
    expect(boxHeight()).toBe(10 * LINE + CHROME);
    rerender(<Laid draft={lines(30)} height={150} />);
    expect(boxHeight()).toBe(CAP);
    // A dragged height above 15 lines is the cap instead.
    rerender(<Laid draft={lines(30)} height={CAP + 80} />);
    expect(boxHeight()).toBe(CAP + 80);
    expect(overflow()).toBe("auto");
  });

  it("resets on a double click and forgets the saved height", () => {
    const onHeight = vi.fn();
    render(<Laid draft={lines(1)} height={250} onHeight={onHeight} />);
    expect(boxHeight()).toBe(250);
    fireEvent.doubleClick(divider());
    expect(onHeight).toHaveBeenCalledWith(null);
    expect(boxHeight()).toBe(MIN_HEIGHT);
    expect(divider().getAttribute("aria-valuenow")).toBeNull();
  });

  it("picks up a saved height when it arrives", () => {
    const { rerender } = render(<Laid draft="" height={null} />);
    expect(boxHeight()).toBe(MIN_HEIGHT);
    rerender(<Laid draft="" height={180} />);
    expect(boxHeight()).toBe(180);
  });

  it("moves with the arrow keys, clamped", () => {
    const onHeight = vi.fn();
    render(<Laid draft="" stageHeight={140} onHeight={onHeight} />);
    fireEvent.keyDown(divider(), { key: "ArrowUp" });
    expect(onHeight).toHaveBeenLastCalledWith(MIN_HEIGHT + NUDGE);
    fireEvent.keyDown(divider(), { key: "ArrowUp" });
    // The room is the box plus the transcript less its minimum: 60 + 140 - 120.
    expect(onHeight).toHaveBeenLastCalledWith(80);
    fireEvent.keyDown(divider(), { key: "ArrowDown" });
    fireEvent.keyDown(divider(), { key: "ArrowDown" });
    expect(onHeight).toHaveBeenLastCalledWith(MIN_HEIGHT);
  });
});

describe("the height rules", () => {
  it("clamps a dragged height between the minimum and the room", () => {
    expect(clampHeight(10, 500)).toBe(MIN_HEIGHT);
    expect(clampHeight(900, 500)).toBe(500);
    expect(clampHeight(240.4, 500)).toBe(240);
    expect(clampHeight(100, 20)).toBe(MIN_HEIGHT);
  });

  it("fits the content between the floor and the larger of 15 lines and the floor", () => {
    const fit = (content: number, floor: number | null, room = Infinity) => fitHeight({ content, line: 20, chrome: 22, floor, room });
    expect(fit(42, null)).toEqual({ height: MIN_HEIGHT, scroll: false });
    expect(fit(200, null)).toEqual({ height: 200, scroll: false });
    expect(fit(900, null)).toEqual({ height: 322, scroll: true });
    expect(fit(100, 250)).toEqual({ height: 250, scroll: false });
    expect(fit(900, 500)).toEqual({ height: 500, scroll: true });
    expect(fit(900, 500, 300)).toEqual({ height: 300, scroll: true });
  });
});

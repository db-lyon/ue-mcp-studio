// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";

vi.mock("../api", () => ({
  api: { uploadAttachment: vi.fn(async (_id: string, u: { name: string; type: string; data: string }) => ({ id: `id-${u.name}`, name: u.name, type: u.type, size: 3 })) },
}));
import { api } from "../api";
import { useRef } from "react";
import { Composer, MAX_LINES, MIN_HEIGHT, MIN_TRANSCRIPT, NUDGE, NUDGE_SAVE_MS, clampHeight, fitHeight } from "./Composer";
import { useAttachments, type PendingFile } from "./attachments";
import { SEND_KEYS, STOP_KEYS } from "@ue-mcp-studio/client-core";

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

  it("while a turn runs, queues on Enter and stops and sends now on Ctrl+Enter, saying so", () => {
    const onSend = vi.fn();
    const onQueue = vi.fn();
    const onSendNow = vi.fn();
    render(<Composer {...base} busy onSend={onSend} onQueue={onQueue} onSendNow={onSendNow} />);
    const box = screen.getByPlaceholderText("Ask") as HTMLTextAreaElement;
    expect(box.disabled).toBe(false);
    // The keys are told in Stop's tooltip, not in words on the bar.
    expect(screen.queryByText(/Enter to queue/)).toBeNull();
    expect(screen.getByRole("button", { name: "Stop" }).getAttribute("title")).toBe(STOP_KEYS);
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onQueue).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    expect(onSendNow).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Queue" }));
    expect(onQueue).toHaveBeenCalledTimes(2);
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  });

  it("sends on Ctrl+Enter too when nothing runs", () => {
    const onSend = vi.fn();
    const onSendNow = vi.fn();
    render(<Composer {...base} onSend={onSend} onQueue={vi.fn()} onSendNow={onSendNow} />);
    fireEvent.keyDown(screen.getByPlaceholderText("Ask"), { key: "Enter", ctrlKey: true });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSendNow).not.toHaveBeenCalled();
    expect(screen.queryByText(/Enter to send/)).toBeNull();
    const send = screen.getByRole("button", { name: "Send" });
    expect(send.getAttribute("title")).toBe(SEND_KEYS);
    expect(send.textContent).toBe("");
  });

  it("puts the utilities in the bar as icons, in order, with Subagents' count as a badge", () => {
    const review = vi.fn();
    const agents = vi.fn();
    render(<Composer {...base} utilities={[
      { id: "subagents", icon: <svg />, count: 2, onClick: agents },
      { id: "checkpoints", icon: <svg />, onClick: review },
    ]} />);
    const slot = document.querySelector(".composer-utilities")!;
    const buttons = [...slot.querySelectorAll("button")];
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["Checkpoints", "Subagents (2)", "Attach"]);
    // Icons: no words on the bar, the badge holds only the count.
    expect(buttons[0].textContent).toBe("");
    expect(buttons[1].querySelector(".utility-count")?.textContent).toBe("2");
    expect(buttons[2].getAttribute("title")).toBe("Attach files (or drop or paste them)");
    fireEvent.click(buttons[0]);
    fireEvent.click(buttons[1]);
    expect([review, agents].every((f) => f.mock.calls.length === 1)).toBe(true);
    // The measured copy is out of reach of the keyboard and a screen reader.
    const copy = document.querySelector(".composer-utilities-measure")!;
    expect(copy.getAttribute("aria-hidden")).toBe("true");
    expect([...copy.querySelectorAll("button")].every((b) => b.tabIndex === -1)).toBe(true);
  });

  it("folds the utilities into one menu when the measured row does not fit, and unfolds when it does", () => {
    const widths: Record<string, number> = { row: 120, slot: 120, spacer: 0 };
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const w = this.classList.contains("composer-utilities-row") ? widths.row
        : this.classList.contains("composer-utilities") ? widths.slot
        : this.classList.contains("spacer") ? widths.spacer : 0;
      return { width: w, height: 36, left: 0, right: w, top: 0, bottom: 36, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    });
    const observers: Array<() => void> = [];
    const RO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class { constructor(cb: () => void) { observers.push(cb); } observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
    try {
      const review = vi.fn();
      const agents = vi.fn();
      render(<Composer {...base} utilities={[{ id: "checkpoints", icon: <svg />, onClick: review }, { id: "subagents", icon: <svg />, count: 2, onClick: agents }]} />);
      expect(screen.getByRole("button", { name: "Checkpoints" })).toBeTruthy();
      // Squeezed: the slot is narrower than the row and nothing is free.
      widths.slot = 80;
      act(() => observers.forEach((o) => o()));
      expect(document.querySelector(".composer-utilities button[aria-label='Checkpoints']")).toBeNull();
      const more = screen.getByRole("button", { name: "More controls, 2 subagents" });
      expect(more.getAttribute("aria-haspopup")).toBe("menu");
      fireEvent.click(more);
      const items = screen.getAllByRole("menuitem");
      expect(items.map((i) => i.textContent)).toEqual(["Checkpoints", "Subagents (2)", "Attach"]);
      expect(document.activeElement).toBe(items[0]);
      fireEvent.keyDown(items[0], { key: "ArrowDown" });
      expect(document.activeElement).toBe(items[1]);
      fireEvent.click(items[1]);
      expect(agents).toHaveBeenCalledOnce();
      expect(screen.queryByRole("menu")).toBeNull();
      // Escape closes the menu and gives the focus back to its button.
      fireEvent.click(more);
      fireEvent.keyDown(screen.getAllByRole("menuitem")[0], { key: "Escape" });
      expect(screen.queryByRole("menu")).toBeNull();
      expect(document.activeElement).toBe(more);
      // Room again: the overflow button and the free space are wider than the row.
      widths.slot = 44;
      widths.spacer = 200;
      act(() => observers.forEach((o) => o()));
      expect(screen.getByRole("button", { name: "Checkpoints" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: /More controls/ })).toBeNull();
    } finally {
      rect.mockRestore();
      globalThis.ResizeObserver = RO;
    }
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
  // jsdom has no PointerEvent; this one carries what the handle reads, as a browser's does.
  if (typeof window.PointerEvent === "undefined") {
    class PointerEventShim extends MouseEvent {
      readonly pointerId: number;
      readonly pointerType: string;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 0;
        this.pointerType = init.pointerType ?? "mouse";
      }
    }
    (window as unknown as { PointerEvent: unknown }).PointerEvent = PointerEventShim;
  }
  /** A drag on the handle with a mouse, a finger or a pen: pointer events, captured by the handle. */
  const drag = (from: number, to: number, pointerType = "mouse", pointerId = 1) => {
    fireEvent.pointerDown(divider(), { clientY: from, button: 0, pointerType, pointerId });
    fireEvent.pointerMove(divider(), { clientY: to, pointerType, pointerId });
    fireEvent.pointerUp(divider(), { clientY: to, pointerType, pointerId });
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

  it("drags with a finger the same way, and shows a handle to drag", () => {
    const onHeight = vi.fn();
    render(<Laid draft="" onHeight={onHeight} />);
    expect(divider().querySelector(".composer-grip")).not.toBeNull();
    drag(500, 350, "touch", 7);
    expect(boxHeight()).toBe(MIN_HEIGHT + 150);
    expect(onHeight).toHaveBeenLastCalledWith(MIN_HEIGHT + 150);
  });

  it("follows only the pointer that started the drag", () => {
    const onHeight = vi.fn();
    render(<Laid draft="" onHeight={onHeight} />);
    fireEvent.pointerDown(divider(), { clientY: 500, pointerType: "touch", pointerId: 1 });
    // A second finger moving elsewhere does not move the box.
    fireEvent.pointerMove(divider(), { clientY: 100, pointerType: "touch", pointerId: 2 });
    expect(boxHeight()).toBe(MIN_HEIGHT);
    fireEvent.pointerMove(divider(), { clientY: 450, pointerType: "touch", pointerId: 1 });
    fireEvent.pointerCancel(divider(), { clientY: 450, pointerType: "touch", pointerId: 1 });
    expect(boxHeight()).toBe(MIN_HEIGHT + 50);
    expect(onHeight).toHaveBeenLastCalledWith(MIN_HEIGHT + 50);
  });

  it("ignores a right-button press", () => {
    const onHeight = vi.fn();
    render(<Laid draft="" onHeight={onHeight} />);
    fireEvent.pointerDown(divider(), { clientY: 500, button: 2, pointerType: "mouse", pointerId: 1 });
    fireEvent.pointerMove(divider(), { clientY: 300, pointerType: "mouse", pointerId: 1 });
    fireEvent.pointerUp(divider(), { clientY: 300, pointerType: "mouse", pointerId: 1 });
    expect(boxHeight()).toBe(MIN_HEIGHT);
    expect(onHeight).not.toHaveBeenCalled();
  });

  it("states its range for assistive technology, and Home resets it", () => {
    const onHeight = vi.fn();
    render(<Laid draft="" height={200} stageHeight={400} onHeight={onHeight} />);
    expect(divider().getAttribute("tabindex")).toBe("0");
    expect(divider().getAttribute("aria-valuemin")).toBe(String(MIN_HEIGHT));
    expect(Number(divider().getAttribute("aria-valuemax"))).toBeGreaterThanOrEqual(200);
    fireEvent.keyDown(divider(), { key: "Home" });
    expect(onHeight).toHaveBeenCalledWith(null);
    expect(divider().getAttribute("aria-valuenow")).toBeNull();
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

  it("moves with the arrow keys, clamped, and saves once the keys stop", () => {
    vi.useFakeTimers();
    try {
      const onHeight = vi.fn();
      render(<Laid draft="" stageHeight={140} onHeight={onHeight} />);
      const press = (key: string) => fireEvent.keyDown(divider(), { key });
      press("ArrowUp");
      expect(boxHeight()).toBe(MIN_HEIGHT + NUDGE);
      press("ArrowUp");
      // The room is the box plus the transcript less its minimum: 60 + 140 - 120.
      expect(boxHeight()).toBe(80);
      expect(onHeight).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(NUDGE_SAVE_MS));
      expect(onHeight).toHaveBeenCalledTimes(1);
      expect(onHeight).toHaveBeenLastCalledWith(80);
      press("ArrowDown");
      press("ArrowDown");
      act(() => vi.advanceTimersByTime(NUDGE_SAVE_MS));
      expect(onHeight).toHaveBeenCalledTimes(2);
      expect(onHeight).toHaveBeenLastCalledWith(MIN_HEIGHT);
    } finally {
      vi.useRealTimers();
    }
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

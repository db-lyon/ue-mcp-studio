import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { formatBytes, type PendingFile } from "./attachments";

/** The text box grows with what is written up to this many lines, then scrolls. */
export const MAX_LINES = 15;
/** The text box is never shorter than this, in pixels. */
export const MIN_HEIGHT = 60;
/** The transcript keeps at least this much height, however far the divider is dragged. */
export const MIN_TRANSCRIPT = 120;
/** One arrow key press on the divider moves it this far. */
export const NUDGE = 16;

/** A dragged height, kept between MIN_HEIGHT and the room the transcript can give up. */
export function clampHeight(h: number, room: number): number {
  return Math.round(Math.max(MIN_HEIGHT, Math.min(h, Math.max(MIN_HEIGHT, room))));
}

/**
 * The text box's height for what is written: the content's height, at least the
 * dragged height (`floor`), and at most the larger of 15 lines and that floor,
 * never more than `room`. Past the top it scrolls.
 */
export function fitHeight({ content, line, chrome, floor, room }: { content: number; line: number; chrome: number; floor: number | null; room: number }): { height: number; scroll: boolean } {
  const top = Math.max(MIN_HEIGHT, Math.min(Math.max(line * MAX_LINES + chrome, floor ?? 0), room));
  const want = Math.max(content, floor ?? 0, MIN_HEIGHT);
  return { height: Math.round(Math.min(want, top)), scroll: content > top + 1 };
}

/**
 * Where the user writes: the text, the files added to it (dropped, pasted or
 * picked), and the bar with the model picker and Send or Stop. Enter sends,
 * Shift+Enter starts a new line.
 *
 * The text box sizes itself to what is written. The divider above it drags the
 * box taller or shorter against `stage`, the transcript that gives up the room;
 * the dragged height is a minimum the content can still grow past. A double
 * click on the divider forgets it. `height` is the saved one, `onHeight` saves.
 */
export function Composer({ draft, onDraft, onBlur, placeholder, busy, canSend, onSend, onStop, files, onAddFiles, onRemoveFile, picker, stage, height, onHeight, children }: {
  draft: string;
  onDraft: (text: string) => void;
  onBlur: () => void;
  placeholder: string;
  busy: boolean;
  canSend: boolean;
  onSend: () => void;
  onStop: () => void;
  files: PendingFile[];
  onAddFiles: (files: FileList | File[]) => void;
  onRemoveFile: (key: string) => void;
  picker: ReactNode;
  stage?: RefObject<HTMLElement>;
  height?: number | null;
  onHeight?: (h: number | null) => void;
  children?: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const [floor, setFloor] = useState<number | null>(height ?? null);
  const [dragging, setDragging] = useState(false);
  const [viewport, setViewport] = useState(0);
  useEffect(() => setFloor(height ?? null), [height]);
  useEffect(() => {
    const onResize = () => setViewport((n) => n + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const current = () => {
    const el = box.current;
    return (el && (parseFloat(el.style.height) || el.offsetHeight)) || MIN_HEIGHT;
  };
  /** How tall the text box may get: its height plus what the transcript can give up. */
  const room = () => (stage?.current ? current() + stage.current.clientHeight - MIN_TRANSCRIPT : Infinity);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const r = room();
    const cs = getComputedStyle(el);
    const px = (v: string) => parseFloat(v) || 0;
    const line = parseFloat(cs.lineHeight) || (px(cs.fontSize) || 14) * 1.5;
    const border = px(cs.borderTopWidth) + px(cs.borderBottomWidth);
    const chrome = px(cs.paddingTop) + px(cs.paddingBottom) + border;
    el.style.height = "auto";
    const fit = fitHeight({ content: el.scrollHeight + border, line, chrome, floor, room: r });
    el.style.height = `${fit.height}px`;
    el.style.overflowY = fit.scroll ? "auto" : "hidden";
  }, [draft, floor, viewport, placeholder]);

  const save = (h: number | null) => {
    setFloor(h);
    onHeight?.(h);
  };
  const startDrag = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = current();
    const r = room();
    let last: number | null = floor;
    setDragging(true);
    document.body.classList.add("row-resizing");
    const move = (m: MouseEvent) => {
      last = clampHeight(startH + startY - m.clientY, r);
      setFloor(last);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setDragging(false);
      document.body.classList.remove("row-resizing");
      if (last !== floor) onHeight?.(last);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  const nudge = (e: React.KeyboardEvent) => {
    const step = e.key === "ArrowUp" ? NUDGE : e.key === "ArrowDown" ? -NUDGE : 0;
    if (!step) return;
    e.preventDefault();
    save(clampHeight((floor ?? current()) + step, room()));
  };

  return (
    <div className={`composer ${dragging ? "resizing" : ""}`}>
      <div
        className="composer-divider"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the message box"
        aria-valuemin={MIN_HEIGHT}
        aria-valuenow={floor ?? undefined}
        tabIndex={0}
        title="Drag to resize, double-click to reset"
        onMouseDown={startDrag}
        onDoubleClick={() => save(null)}
        onKeyDown={nudge}
      />
      {files.length > 0 && (
        <div className="attach-list" aria-label="Attached files">
          {files.map((f) => (
            <div key={f.key} className={`attach-chip ${f.state}`} title={f.error ?? f.name}>
              {f.preview ? <img src={f.preview} alt="" /> : <span className="attach-ext">{extOf(f.name)}</span>}
              <span className="attach-name">{f.name}</span>
              <span className="dim small">{f.state === "uploading" ? "adding" : f.state === "error" ? f.error : formatBytes(f.size)}</span>
              <button className="attach-remove" aria-label={`Remove ${f.name}`} onClick={() => onRemoveFile(f.key)}>{"×"}</button>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={box}
        rows={1}
        value={draft}
        placeholder={placeholder}
        disabled={busy}
        onChange={(e) => onDraft(e.target.value)}
        onBlur={onBlur}
        onPaste={(e) => {
          // A pasted screenshot or copied file is attached; pasted text stays text.
          if (e.clipboardData.files.length > 0) {
            e.preventDefault();
            onAddFiles(e.clipboardData.files);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (canSend) onSend();
          }
        }}
      />
      <div className="composer-bar">
        {picker}
        <button className="ghost attach-button" disabled={busy} onClick={() => input.current?.click()} title="Attach files (or drop or paste them)">Attach</button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          aria-label="Attach files"
          onChange={(e) => {
            if (e.target.files?.length) onAddFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <span className="spacer" />
        {busy ? <button onClick={onStop}>Stop</button> : <button className="primary" disabled={!canSend} onClick={onSend}>Send</button>}
      </div>
      {children}
    </div>
  );
}

const extOf = (name: string): string => (name.includes(".") ? name.split(".").pop()!.slice(0, 4).toUpperCase() : "FILE");

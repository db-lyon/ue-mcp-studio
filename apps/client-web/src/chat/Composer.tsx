import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { formatBytes, type PendingFile } from "./attachments";
import { useSlashMenu } from "./SlashMenu";
import type { FlowListing, SlashCommand } from "@ue-mcp-studio/shared";

/** The text box grows with what is written up to this many lines, then scrolls. */
export const MAX_LINES = 15;
/** The text box is never shorter than this, in pixels. */
export const MIN_HEIGHT = 60;
/** The transcript keeps at least this much height, however far the divider is dragged. */
export const MIN_TRANSCRIPT = 120;
/** One arrow key press on the divider moves it this far. */
export const NUDGE = 16;
/** Arrow key presses are saved once they stop for this long, so a held key sends one save. */
export const NUDGE_SAVE_MS = 400;

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
 * Shift+Enter starts a new line. While a turn runs, Enter queues the message
 * behind it, and Ctrl+Enter stops the turn and sends the message now.
 *
 * The text box sizes itself to what is written. The divider above it drags the
 * box taller or shorter against `stage`, the transcript that gives up the room;
 * the dragged height is a minimum the content can still grow past. A double
 * click on the divider forgets it. `height` is the saved one, `onHeight` saves.
 */
export function Composer({ draft, onDraft, onBlur, placeholder, busy, canSend, onSend, onQueue, onSendNow, onStop, files, onAddFiles, onRemoveFile, picker, stage, height, onHeight, commands, flows, children }: {
  draft: string;
  onDraft: (text: string) => void;
  onBlur: () => void;
  placeholder: string;
  busy: boolean;
  canSend: boolean;
  onSend: () => void;
  /** While a turn runs: Enter. Without it, the box is closed while a turn runs. */
  onQueue?: () => void;
  /** While a turn runs: Ctrl+Enter, stop it and send now. */
  onSendNow?: () => void;
  onStop: () => void;
  files: PendingFile[];
  onAddFiles: (files: FileList | File[]) => void;
  onRemoveFile: (key: string) => void;
  picker: ReactNode;
  stage?: RefObject<HTMLElement>;
  height?: number | null;
  onHeight?: (h: number | null) => void;
  /** The slash commands the menu offers; the registry's when not given. */
  commands?: readonly SlashCommand[];
  /** The project's flows, for the names /flow completes. Fetched when the menu offers them; stable across renders. */
  flows?: () => Promise<FlowListing[]>;
  children?: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const slash = useSlashMenu(draft, onDraft, commands, flows);
  /** A hidden copy of the box, out of the page flow, measured instead of the box so typing never lays out the conversation. */
  const mirror = useRef<HTMLTextAreaElement>(null);
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
  /** The conversation's height, kept by a ResizeObserver so typing never reads layout for it. */
  const stageHeight = useRef<number | null>(null);
  useEffect(() => {
    const el = stage?.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    stageHeight.current = el.clientHeight;
    const o = new ResizeObserver(([e]) => {
      stageHeight.current = e.contentRect.height;
    });
    o.observe(el);
    return () => o.disconnect();
  }, [stage]);
  /** How tall the text box may get: its height plus what the transcript can give up. */
  const room = () => {
    const h = stageHeight.current ?? stage?.current?.clientHeight;
    return h === undefined || h === null ? Infinity : current() + h - MIN_TRANSCRIPT;
  };

  /** The box's line height, border and padding, read again only on a resize. */
  const metrics = useRef<{ line: number; border: number; chrome: number; width: number } | null>(null);
  useLayoutEffect(() => {
    metrics.current = null;
  }, [viewport, placeholder]);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const r = room();
    if (!metrics.current) {
      const cs = getComputedStyle(el);
      const px = (v: string) => parseFloat(v) || 0;
      const border = px(cs.borderTopWidth) + px(cs.borderBottomWidth);
      metrics.current = {
        line: parseFloat(cs.lineHeight) || (px(cs.fontSize) || 14) * 1.5,
        border,
        chrome: px(cs.paddingTop) + px(cs.paddingBottom) + border,
        width: el.offsetWidth,
      };
    }
    const { line, border, chrome, width } = metrics.current;
    const m = mirror.current;
    let content: number;
    if (m) {
      if (m.style.width !== `${width}px`) m.style.width = `${width}px`;
      m.value = el.value || el.placeholder;
      content = m.scrollHeight + border;
    } else {
      el.style.height = "auto";
      content = el.scrollHeight + border;
    }
    const fit = fitHeight({ content, line, chrome, floor, room: r });
    // Only a real change touches the box: an unchanged height costs no layout.
    if (el.style.height !== `${fit.height}px`) el.style.height = `${fit.height}px`;
    const overflow = fit.scroll ? "auto" : "hidden";
    if (el.style.overflowY !== overflow) el.style.overflowY = overflow;
  }, [draft, floor, viewport, placeholder]);

  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (pending.current) clearTimeout(pending.current);
  }, []);
  const save = (h: number | null, later = false) => {
    setFloor(h);
    if (pending.current) clearTimeout(pending.current);
    pending.current = null;
    if (later) pending.current = setTimeout(() => {
      pending.current = null;
      onHeight?.(h);
    }, NUDGE_SAVE_MS);
    else onHeight?.(h);
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
      if (last !== floor) save(last);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  const nudge = (e: React.KeyboardEvent) => {
    const step = e.key === "ArrowUp" ? NUDGE : e.key === "ArrowDown" ? -NUDGE : 0;
    if (!step) return;
    e.preventDefault();
    save(clampHeight((floor ?? current()) + step, room()), true);
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
      <textarea ref={mirror} className="composer-mirror" rows={1} tabIndex={-1} aria-hidden readOnly defaultValue="" />
      {slash.menu}
      <textarea
        ref={box}
        rows={1}
        value={draft}
        placeholder={placeholder}
        disabled={busy && !onQueue}
        {...slash.aria}
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
          if (slash.keyDown(e)) return;
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (!canSend) return;
            if (!busy) onSend();
            else if (e.ctrlKey || e.metaKey) onSendNow?.();
            else onQueue?.();
          }
        }}
      />
      <div className="composer-bar">
        {picker}
        <button className="ghost attach-button" disabled={busy && !onQueue} onClick={() => input.current?.click()} title="Attach files (or drop or paste them)">Attach</button>
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
        {onQueue && <span className="composer-hint dim small">{busy ? "Enter to queue, Ctrl+Enter to stop and send now" : "Enter to send, Shift+Enter for a new line"}</span>}
        {busy && onQueue && <button disabled={!canSend} onClick={onQueue} title="Send when the running turn ends">Queue</button>}
        {busy ? <button onClick={onStop}>Stop</button> : <button className="primary" disabled={!canSend} onClick={onSend}>Send</button>}
      </div>
      {children}
    </div>
  );
}

const extOf = (name: string): string => (name.includes(".") ? name.split(".").pop()!.slice(0, 4).toUpperCase() : "FILE");

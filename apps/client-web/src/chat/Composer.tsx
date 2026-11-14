import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { BAR_UTILITIES, QUEUE_HINT, MAX_LINES, MIN_HEIGHT, MIN_TRANSCRIPT, NUDGE, NUDGE_SAVE_MS, SEND_KEYS, STOP_KEYS, UTILITY_MORE_LABEL, UTILITY_TITLE, clampHeight, extOf, fitHeight, foldUtilities, formatBytes, moreLabel, utilityLabel, type BarUtilityId } from "@ue-mcp-studio/client-core";
import type { PendingFile } from "./attachments";
import { useSlashMenu } from "./SlashMenu";
import { MentionChips, useMentionMenu, type MentionSearchFn } from "./MentionMenu";
import { BarTierContext, barTier, type BarTier } from "./barTier";
import type { ActionListing, FlowListing, SlashCommand } from "@ue-mcp-studio/shared";

// The box's sizing rules are client-core's, shared with the mobile app's composer.
export { MAX_LINES, MIN_HEIGHT, MIN_TRANSCRIPT, NUDGE, NUDGE_SAVE_MS, clampHeight, fitHeight };

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
export function Composer({ draft, onDraft, onBlur, placeholder, busy, canSend, onSend, onQueue, onSendNow, onStop, files, onAddFiles, onRemoveFile, picker, utilities = [], extras, stage, height, onHeight, commands, flows, actions, mentions, children }: {
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
  /** The model and the context meter: the bar's start. */
  picker: ReactNode;
  /** The session's utility buttons (Checkpoints, Subagents); the composer adds Attach and orders them. */
  utilities?: BarUtility[];
  /** More bar controls, after the utilities: the composer.action slot. */
  extras?: ReactNode;
  stage?: RefObject<HTMLElement>;
  height?: number | null;
  onHeight?: (h: number | null) => void;
  /** The slash commands the menu offers; the registry's when not given. */
  commands?: readonly SlashCommand[];
  /** The project's flows, for the names /flow completes. Fetched when the menu offers them; stable across renders. */
  flows?: () => Promise<FlowListing[]>;
  /** ue-mcp's actions, for the names /action completes. Fetched when the menu offers them; stable across renders. */
  actions?: () => Promise<ActionListing[]>;
  /** Looks names up for an @-mention; without it, @ is plain text. */
  mentions?: MentionSearchFn;
  children?: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const slash = useSlashMenu(draft, onDraft, commands, flows, actions);
  const mention = useMentionMenu(draft, onDraft, box, mentions);
  /** A hidden copy of the box, out of the page flow, measured instead of the box so typing never lays out the conversation. */
  const mirror = useRef<HTMLTextAreaElement>(null);
  const [floor, setFloor] = useState<number | null>(height ?? null);
  const [dragging, setDragging] = useState(false);
  const [viewport, setViewport] = useState(0);
  useEffect(() => setFloor(height ?? null), [height]);
  useEffect(() => {
    const onResize = () => setViewport((n) => n + 1);
    window.addEventListener("resize", onResize);
    // The box was measured in a fallback font until the web fonts arrive: measure it again then, or it keeps a fallback line count.
    let alive = true;
    void document.fonts?.ready.then(() => alive && onResize());
    return () => {
      alive = false;
      window.removeEventListener("resize", onResize);
    };
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

  /** The bar's tier, from its own width: the panel can be narrower than the window. */
  const bar = useRef<HTMLDivElement>(null);
  const [tier, setTier] = useState<BarTier>("full");
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;
    const measure = () => setTier(barTier(el.clientWidth, parseFloat(getComputedStyle(el).fontSize)));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const o = new ResizeObserver(measure);
    o.observe(el);
    return () => o.disconnect();
  }, []);

  /**
   * The utility buttons, in their order, and whether they fold into one
   * overflow button: from the row's natural width against the room its slot
   * and the bar's free space give it (client-core's foldUtilities).
   */
  const all: BarUtility[] = [
    ...utilities,
    { id: "attach" as const, icon: <AttachGlyph />, disabled: busy && !onQueue, onClick: () => input.current?.click() },
  ].sort((a, b) => BAR_UTILITIES.indexOf(a.id) - BAR_UTILITIES.indexOf(b.id));
  const slot = useRef<HTMLDivElement>(null);
  const spacer = useRef<HTMLSpanElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const [folded, setFolded] = useState(false);
  useLayoutEffect(() => {
    const parts = [bar.current, slot.current, spacer.current, row.current];
    if (parts.some((p) => !p)) return;
    const width = (el: Element | null) => (el ? el.getBoundingClientRect().width : 0);
    const measure = () => setFolded(foldUtilities(width(row.current), width(slot.current) + width(spacer.current)));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const o = new ResizeObserver(measure);
    for (const el of parts) o.observe(el!);
    return () => o.disconnect();
  }, []);

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
  /** Drag with a mouse, a finger or a pen: the pointer is captured so the drag follows it off the handle. */
  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const id = e.pointerId;
    handle.setPointerCapture?.(id);
    const startY = e.clientY;
    const startH = current();
    const r = room();
    let last: number | null = floor;
    setDragging(true);
    document.body.classList.add("row-resizing");
    const move = (m: PointerEvent) => {
      if (m.pointerId !== id) return;
      m.preventDefault();
      last = clampHeight(startH + startY - m.clientY, r);
      setFloor(last);
    };
    const up = (u: PointerEvent) => {
      if (u.pointerId !== id) return;
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      handle.releasePointerCapture?.(id);
      setDragging(false);
      document.body.classList.remove("row-resizing");
      if (last !== floor) save(last);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };
  const nudge = (e: React.KeyboardEvent) => {
    // Home forgets the dragged height, as a double click does.
    if (e.key === "Home") {
      e.preventDefault();
      save(null);
      return;
    }
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
        aria-valuemax={Math.round(room())}
        aria-valuenow={floor ?? undefined}
        tabIndex={0}
        title="Drag to resize, double-click to reset"
        onPointerDown={startDrag}
        onDoubleClick={() => save(null)}
        onKeyDown={nudge}
      >
        <span className="composer-grip" aria-hidden="true" />
      </div>
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
      {mentions && <MentionChips draft={draft} onDraft={onDraft} />}
      <textarea ref={mirror} className="composer-mirror" rows={1} tabIndex={-1} aria-hidden readOnly defaultValue="" />
      {slash.menu ?? mention.menu}
      <textarea
        ref={box}
        rows={1}
        value={draft}
        placeholder={placeholder}
        disabled={busy && !onQueue}
        {...(slash.open ? slash.aria : mention.aria)}
        onChange={(e) => {
          mention.track(e.target);
          onDraft(e.target.value);
        }}
        onSelect={(e) => mention.track(e.currentTarget)}
        onBlur={() => {
          mention.blur();
          onBlur();
        }}
        onPaste={(e) => {
          // A pasted screenshot or copied file is attached; pasted text stays text.
          if (e.clipboardData.files.length > 0) {
            e.preventDefault();
            onAddFiles(e.clipboardData.files);
          }
        }}
        onKeyDown={(e) => {
          if (slash.keyDown(e)) return;
          if (!slash.open && mention.keyDown(e)) return;
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (!canSend) return;
            if (!busy) onSend();
            else if (e.ctrlKey || e.metaKey) onSendNow?.();
            else onQueue?.();
          }
        }}
      />
      {/* Send or Stop is last and never shrinks; the model gives way by tier (barTier.ts), the utilities fold by measured fit. */}
      <div className="composer-bar" ref={bar} data-tier={tier} data-folded={folded ? "" : undefined}>
        <BarTierContext.Provider value={tier}>
          {picker}
          <div className="composer-utilities" ref={slot}>
            {folded ? <UtilityMenu items={all} /> : all.map((u) => <UtilityButton key={u.id} u={u} />)}
          </div>
          {extras}
        </BarTierContext.Provider>
        {/* The row at its natural width, out of the flow and unseen, measured for the fold. */}
        <div className="composer-utilities-measure" aria-hidden="true">
          <div className="composer-utilities-row" ref={row}>
            {all.map((u) => <UtilityButton key={u.id} u={u} hidden />)}
          </div>
        </div>
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
        <span className="spacer" ref={spacer} />
        {busy && onQueue && <button className="composer-queue" disabled={!canSend} onClick={onQueue} title={QUEUE_HINT}>Queue</button>}
        {/* Icons, named for a screen reader; the keys are in the tooltip. */}
        {busy
          ? <button className="composer-send stop" aria-label="Stop" title={onQueue ? STOP_KEYS : "Stop"} onClick={onStop}><StopGlyph /></button>
          : <button className="composer-send primary" aria-label="Send" title={SEND_KEYS} disabled={!canSend} onClick={onSend}><SendGlyph /></button>}
      </div>
      {children}
    </div>
  );
}

/** One of the bar's utility buttons: an icon, with a count for Subagents. */
export interface BarUtility {
  id: BarUtilityId;
  icon: ReactNode;
  onClick: () => void;
  /** Subagents: how many the Subagents list shows (listedSubagents). */
  count?: number;
  disabled?: boolean;
  /** A toggle's state: Subagents where its list is inline, pressed while that list shows. Undefined is a plain button. */
  pressed?: boolean;
}

/** Each utility's class, for styles and for the visual QA's clicks. */
const UTILITY_CLASS: Record<BarUtilityId, string> = { checkpoints: "composer-checkpoints", subagents: "composer-agents", attach: "attach-button" };

/** A utility as an icon button, named for the keyboard and a screen reader; `hidden` is the measured copy, out of reach. */
function UtilityButton({ u, hidden }: { u: BarUtility; hidden?: boolean }) {
  return (
    <button
      className={`ghost bar-button icon-only ${UTILITY_CLASS[u.id]} ${u.pressed ? "selected" : ""}`}
      aria-label={utilityLabel(u.id, u.count)}
      aria-pressed={u.pressed}
      title={UTILITY_TITLE[u.id]}
      disabled={u.disabled}
      tabIndex={hidden ? -1 : undefined}
      onClick={hidden ? undefined : u.onClick}
    >
      {u.icon}
      {u.count ? <span className="utility-count">{u.count}</span> : null}
    </button>
  );
}

/**
 * The utilities folded into one button, for a bar too narrow for their row:
 * a menu of each with its icon and name. Escape or a click outside closes it,
 * the arrow keys move between its items.
 */
function UtilityMenu({ items }: { items: BarUtility[] }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const agents = items.find((u) => u.id === "subagents")?.count ?? 0;
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  // Opened over the button, kept inside the bar; the first item takes the focus.
  useLayoutEffect(() => {
    const m = menu.current;
    const b = button.current;
    const barEl = b?.closest(".composer-bar");
    if (!open || !m || !b || !barEl) return;
    const bar = barEl.getBoundingClientRect();
    const at = b.getBoundingClientRect().left - bar.left;
    m.style.left = `${Math.max(0, Math.min(at, bar.width - m.offsetWidth))}px`;
    m.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [open]);
  const keyDown = (e: React.KeyboardEvent) => {
    if (!open) return;
    if (e.key === "Escape" || e.key === "Tab") {
      if (e.key === "Escape") e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      if (e.key === "Escape") button.current?.focus();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const list = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    if (!list.length) return;
    e.preventDefault();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    list[(i + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length].focus();
  };
  return (
    <div className="composer-more" ref={box} onKeyDown={keyDown}>
      <button
        ref={button}
        className="ghost bar-button icon-only composer-more-button"
        aria-label={moreLabel(agents)}
        title={UTILITY_MORE_LABEL}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <MoreGlyph />
        {agents > 0 ? <span className="utility-count">{agents}</span> : null}
      </button>
      {open && (
        <div className="composer-more-menu" role="menu" aria-label={UTILITY_MORE_LABEL} ref={menu}>
          {items.map((u) => (
            <button
              key={u.id}
              role={u.pressed === undefined ? "menuitem" : "menuitemcheckbox"}
              aria-checked={u.pressed}
              className={`composer-more-item ${UTILITY_CLASS[u.id]}`}
              title={UTILITY_TITLE[u.id]}
              disabled={u.disabled}
              onClick={() => {
                setOpen(false);
                u.onClick();
              }}
            >
              {u.icon}
              <span>{utilityLabel(u.id, u.count)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Send's arrow and Stop's square, as the phone draws them. */
function SendGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 15V3M4 8l5-5 5 5" />
    </svg>
  );
}
function StopGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
      <rect width="12" height="12" rx="2" />
    </svg>
  );
}

/** The overflow button: three dots. */
function MoreGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="3" cy="8" r="1.4" />
      <circle cx="8" cy="8" r="1.4" />
      <circle cx="13" cy="8" r="1.4" />
    </svg>
  );
}

/** Subagents: two people. */
export function AgentsGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      <circle cx="5" cy="5" r="2" />
      <circle cx="11" cy="5" r="2" />
      <path d="M1.5 13c0-2 1.6-3.5 3.5-3.5S8.5 11 8.5 13M7.5 13c0-2 1.6-3.5 3.5-3.5s3.5 1.5 3.5 3.5" />
    </svg>
  );
}

function AttachGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13.5 7.5 8 13a3.5 3.5 0 0 1-5-5l5.8-5.8a2.3 2.3 0 0 1 3.3 3.3L6.3 11.3a1.1 1.1 0 0 1-1.6-1.6L10 4.5" />
    </svg>
  );
}

/** Checkpoints: a flag on a pole. */
export function CheckpointsGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 14.5V2M3.5 2.5h8.5l-2 3 2 3H3.5" />
    </svg>
  );
}

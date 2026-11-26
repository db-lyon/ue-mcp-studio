/**
 * The Arrangement's timelines: a ruler with the loop brace and the playhead's
 * marker, then one row per track, a narrow header (name, then play, Mute,
 * Solo and the player under it) beside the track's lane. The header column
 * and the ruler stay put while the lanes scroll. Rows below the tracks are
 * empty grid, at least six rows in all, as a DAW draws an empty arrangement;
 * a clip dropped there gets a track of its own.
 */
import { useEffect, useRef, type CSSProperties, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import {
  INSTANCE_STATUS_LOOK,
  SET_COPY,
  SET_OPS,
  arrangeClock,
  arrangeEnd,
  arrangeSeconds,
  arrangeStep,
  clipScale,
  dragLines,
  replaceLines,
  rulerEvery,
  rulerFrames,
  rulerMinor,
  rulerTicks,
  snapTo,
  spanProgress,
  type ArrangeDragMode,
} from "@ue-mcp-studio/client-core";
import type { InstanceKind, InstanceLayout, InstanceStatus, SetAnswer, SetRunScope, SetTrackView as SetTrack } from "@ue-mcp-studio/shared";
import { HubIcon, StatusMark } from "./parts";
import { CLIP_MIME } from "./ClipBrowser";
import type { ClipRef } from "./arrangement-sync";
import { capture, followPointer, hold, type DragPoint } from "./drag";
import { dragGhost, type Ghost } from "./optimistic";

export type Sel = { kind: "track"; track: string } | { kind: "instance"; track: string; id: string } | null;

/** A track row's height, and the header column's width: narrow, as a DAW keeps it. */
export const ROW_H = 48;
export const HEAD_W = 150;
/** The fewest rows the grid draws, tracks and empty rows together. */
export const MIN_ROWS = 6;
/** The most remote clients a track may drive, as ue-mcp's SET_PLAYER_MAX. */
const SET_PLAYER_MAX = 15;

export const colorClass = (c?: string): string => (c ? `c-${c}` : "");

export interface Loop { start: number; end: number }

export interface ViewCtx {
  tracks: SetTrack[];
  rate: number;
  sel: Sel;
  select: (s: Sel) => void;
  /** Send op lines, one edit at a time; a ghost draws the edit at once, until the answer replaces it or a refusal slides it back. */
  edit: (lines: string[] | null, after?: (a: SetAnswer) => void, ghost?: Ghost | null) => Promise<void>;
  play: (scope: SetRunScope, what: string) => Promise<void>;
  open: (kind: InstanceKind, target: string) => void;
  /** Add a clip to a track (a new one when null) at a frame. */
  addClip: (clip: ClipRef, track: string | null, at: number) => void;
  results: { instances: Record<string, InstanceStatus>; tracks: Record<string, InstanceStatus> };
  cursor: number | null;
  runLength: number;
  /** The warning on each track ("walk") and block ("walk/i1"). */
  flagged: Map<string, string>;
  onWarning: (key: string) => void;
  zoom: number;
  playhead: number;
  setPlayhead: (f: number) => void;
  /** Show a frame on the transport's clock while the playhead is dragged, or null to show the playhead again. */
  showClock?: (f: number | null) => void;
  loop: Loop | null;
  loopOn: boolean;
  setLoop: (l: Loop) => void;
  onAddTrack: () => void;
  onRename: () => void;
  scrollRef: RefObject<HTMLDivElement>;
}

function readDrag(e: ReactDragEvent, mime: string): { kind?: InstanceKind; target?: string } | null {
  try {
    const raw = e.dataTransfer?.getData(mime);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
const carriesClip = (e: ReactDragEvent) => Array.from(e.dataTransfer?.types ?? []).includes(CLIP_MIME);

/** A track's player, shown where a DAW shows a track's input and output: 0 is the editor's own player, N remote client N. */
function PlayerField({ t, edit }: { t: SetTrack; edit: ViewCtx["edit"] }) {
  const players = Array.from({ length: Math.max(SET_PLAYER_MAX, t.player) + 1 }, (_, n) => n);
  return (
    <select className="hub-set-io small" value={t.player} title={`${SET_COPY.playerName(t.player)}\n${SET_COPY.player}`} aria-label={SET_COPY.playerFor(t.title)}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (n !== t.player) void edit([SET_OPS.trackPlayer(t.id, n)]);
      }}>
      {players.map((n) => <option key={n} value={n} title={SET_COPY.playerName(n)} aria-label={SET_COPY.playerName(n)}>{SET_COPY.playerShort(n)}</option>)}
    </select>
  );
}

/**
 * The block drag under way: the element it moves, and how far it has gone.
 * It lives in a ref and is drawn by writing the element's style, so the
 * arrangement does not re-render while the pointer moves.
 */
interface BlockDrag { el: HTMLElement; track: string; id: string; mode: ArrangeDragMode; alt: boolean; copy: HTMLElement | null; stop: () => void }
type BraceMode = "move" | "start" | "end" | "new";


export function Timelines({ ctx }: { ctx: ViewCtx }) {
  const { tracks, rate, zoom, playhead, setPlayhead, sel, select, edit, play, open, results, cursor, flagged, loop, loopOn, setLoop, scrollRef } = ctx;
  const blockDrag = useRef<BlockDrag | null>(null);
  const markerRef = useRef<HTMLSpanElement>(null);
  const playheadRef = useRef<HTMLSpanElement>(null);
  const braceRef = useRef<HTMLSpanElement>(null);
  const shadeRef = useRef<HTMLSpanElement>(null);
  // A drag still under way when the view goes away stops listening.
  useEffect(() => () => blockDrag.current?.stop(), []);
  const frames = rulerFrames(Math.max(arrangeEnd(tracks.map((t) => t.layout)), ctx.runLength, loop?.end ?? 0), rate);
  const px = (f: number) => (f / rate) * zoom;
  const fr = (x: number) => (x / zoom) * rate;
  const width = px(frames);
  const step = arrangeStep(rate);
  const fillers = Math.max(1, MIN_ROWS - tracks.length);
  const gridStyle = { width: HEAD_W + width, "--major": `${rulerEvery(zoom) * zoom}px`, "--minor": `${rulerMinor(zoom) * zoom}px` } as CSSProperties;

  /** Where a drag lands: the frame delta on the grid (Shift for single frames) and, for a move, the track it is over. */
  const landing = (mode: ArrangeDragMode, track: string, l: InstanceLayout, dx: number, dy: number, free: boolean) => {
    const snap = (f: number) => (free ? Math.max(0, Math.round(f)) : snapTo(f, step));
    const edgeAt = mode === "trimEnd" ? l.end : l.start;
    const df = snap(edgeAt + fr(dx)) - edgeAt;
    const ti = tracks.findIndex((t) => t.id === track);
    const rows = mode === "move" ? Math.max(-ti, Math.min(tracks.length - 1 - ti, Math.round(dy / ROW_H))) : 0;
    return { df, rows, to: mode === "move" ? tracks[ti + rows]?.id : undefined };
  };

  /** Press on a block: select it, then drag to move it (Alt: a copy), or by an edge to trim it. */
  const blockDown = (e: ReactPointerEvent<HTMLElement>, t: SetTrack, l: InstanceLayout) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    blockDrag.current?.stop();
    const el = e.currentTarget;
    const edge = (e.target as HTMLElement).dataset.edge;
    const mode: ArrangeDragMode = edge === "start" ? "trimStart" : edge === "end" ? "trimEnd" : "move";
    capture(el, e.pointerId);
    select({ kind: "instance", track: t.id, id: l.id });
    const w0 = Math.max(6, px(l.length));
    const restore = hold(el);
    const d: BlockDrag = { el, track: t.id, id: l.id, mode, alt: e.altKey, copy: null, stop: () => {} };
    const far = (p: DragPoint) => Math.abs(p.dx) >= 3 || Math.abs(p.dy) >= ROW_H / 2;
    /** An Alt drag moves a copy and leaves the block where it is; the copy comes and goes with Alt. */
    const mover = (copy: boolean): HTMLElement => {
      if (copy && !d.copy) {
        restore();
        d.copy = el.cloneNode(true) as HTMLElement;
        d.copy.removeAttribute("aria-label");
        d.copy.removeAttribute("data-key");
        d.copy.setAttribute("aria-hidden", "true");
        d.copy.dataset.ghost = "";
        el.parentElement?.appendChild(d.copy);
      } else if (!copy && d.copy) {
        d.copy.remove();
        d.copy = null;
      }
      return d.copy ?? el;
    };
    const draw = (p: DragPoint) => {
      if (!far(p)) {
        mover(false);
        restore();
        return;
      }
      const { df, rows } = landing(mode, t.id, l, p.dx, p.dy, p.shift);
      if (mode !== "move") el.dataset.dragging = "";
      if (mode === "move") {
        const m = mover(d.alt || p.alt);
        m.dataset.dragging = "";
        m.style.transform = `translate(${px(df)}px, ${rows * ROW_H}px)`;
      } else if (mode === "trimEnd") el.style.width = `${Math.max(6, w0 + px(df))}px`;
      else {
        const dd = Math.min(df, l.length - 1);
        el.style.transform = `translateX(${px(dd)}px)`;
        el.style.width = `${Math.max(6, w0 - px(dd))}px`;
      }
    };
    const end = () => {
      d.copy?.remove();
      restore();
      if (blockDrag.current === d) blockDrag.current = null;
    };
    d.stop = followPointer(e, {
      move: draw,
      cancel: end,
      up: (p) => {
        end();
        if (!far(p)) return;
        // Read the block as it is drawn now: an earlier drop may still be on its way.
        const now = ctx.tracks.find((x) => x.id === t.id);
        const lay = now?.layout.find((x) => x.id === l.id) ?? l;
        const inst = now?.arrangement.instances.find((i) => i.id === l.id);
        if (!now || !inst) return;
        const { df, to } = landing(mode, t.id, lay, p.dx, p.dy, p.shift);
        const dup = d.alt || p.alt;
        const opts = { scale: clipScale(now.arrangement.rate || rate, lay.clipRate), duplicate: dup, toTrack: to };
        void edit(dragLines(t.id, inst, lay, mode, df, opts), (a) => {
          const id = dup ? a.changed?.find((c) => c !== l.id) : l.id;
          if (id) select({ kind: "instance", track: to ?? t.id, id });
        }, dragGhost(t.id, inst, lay, mode, df, opts));
        if (!dup) select({ kind: "instance", track: to ?? t.id, id: l.id });
      },
    });
    blockDrag.current = d;
  };

  /** Press on a track's header and drag it up or down to put the track elsewhere; the rows it passes make room. */
  const headDown = (e: ReactPointerEvent<HTMLElement>, t: SetTrack) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest(".hub-set-head-ctl, .hub-set-warn")) return;
    const head = e.currentTarget;
    if (e.target === head) select({ kind: "track", track: t.id });
    const row = head.closest<HTMLElement>(".hub-set-row");
    const rowsEl = row?.parentElement;
    if (!row || !rowsEl) return;
    const from = tracks.findIndex((x) => x.id === t.id);
    const others = () => Array.from(rowsEl.querySelectorAll<HTMLElement>(".hub-set-row[data-track]"));
    const shiftOf = (dy: number) => Math.max(-from, Math.min(tracks.length - 1 - from, Math.round(dy / ROW_H)));
    let captured = false;
    const held = others().map(hold);
    const clear = () => {
      delete rowsEl.dataset.reordering;
      held.forEach((r) => r());
    };
    followPointer(e, {
      move: (p) => {
        if (Math.abs(p.dy) < ROW_H / 3 && !captured) return;
        if (!captured) {
          captured = true;
          capture(head, e.pointerId);
        }
        const by = shiftOf(p.dy);
        rowsEl.dataset.reordering = "";
        row.dataset.dragging = "";
        row.style.zIndex = "3";
        row.style.transform = `translateY(${by * ROW_H}px)`;
        others().forEach((r, i) => {
          if (r === row) return;
          const between = by > 0 ? i > from && i <= from + by : i < from && i >= from + by;
          r.style.transform = between ? `translateY(${by > 0 ? -ROW_H : ROW_H}px)` : "";
        });
      },
      cancel: clear,
      up: (p) => {
        clear();
        const by = Math.abs(p.dy) < ROW_H / 3 ? 0 : shiftOf(p.dy);
        if (!by) return;
        const index = from + by;
        void edit([SET_OPS.trackMove(t.id, index)], undefined, { kind: "order", track: t.id, index });
      },
    });
  };

  const frameAt = (e: { clientX: number; currentTarget: HTMLElement }) => snapTo(fr(e.clientX - e.currentTarget.getBoundingClientRect().left), step);
  const laneDrop = (e: ReactDragEvent<HTMLElement>, t: SetTrack | null) => {
    e.preventDefault();
    const clip = readDrag(e, CLIP_MIME);
    if (!clip?.kind || !clip.target) return;
    ctx.addClip({ kind: clip.kind, target: clip.target }, t?.id ?? null, frameAt(e));
  };
  /** A clip from Clips dropped on a block replaces that instance's clip, keeping its place, name and color. */
  const blockDrop = (e: ReactDragEvent<HTMLElement>, t: SetTrack, l: InstanceLayout) => {
    e.preventDefault();
    e.stopPropagation();
    const clip = readDrag(e, CLIP_MIME);
    const inst = t.arrangement.instances.find((i) => i.id === l.id);
    if (!clip?.kind || !clip.target || !inst) return;
    select({ kind: "instance", track: t.id, id: l.id });
    void edit(replaceLines(t.id, inst, { kind: clip.kind, target: clip.target }));
  };

  /** The playhead drawn at a frame without a render: the ruler's marker, the line over the lanes and the clock. */
  const drawPlayhead = (f: number) => {
    if (markerRef.current) markerRef.current.style.left = `${px(f)}px`;
    if (playheadRef.current) playheadRef.current.style.left = `${px(f)}px`;
    ctx.showClock?.(f);
  };
  /** The ruler's scale: press or drag to move the playhead, as a DAW's scrub area does; the playhead is set once, on release. */
  const scrub = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const scale = e.currentTarget;
    const at = (x: number) => snapTo(fr(x - scale.getBoundingClientRect().left), step);
    const held = [hold(markerRef.current), hold(playheadRef.current)];
    const undrawPlayhead = () => {
      held.forEach((r) => r());
      ctx.showClock?.(null);
    };
    capture(scale, e.pointerId);
    drawPlayhead(at(e.clientX));
    followPointer(e, {
      move: (p) => drawPlayhead(at(p.clientX)),
      cancel: undrawPlayhead,
      up: (p) => {
        undrawPlayhead();
        setPlayhead(at(p.clientX));
      },
    });
  };
  /** The loop strip: drag the brace or its edges, or drag across empty strip to draw a new range; the loop is set once, on release. */
  const braceDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const edge = (e.target as HTMLElement).dataset.brace as BraceMode | undefined;
    capture(e.currentTarget, e.pointerId);
    const f0 = frameAt(e);
    const mode: BraceMode = loop ? edge ?? "new" : "new";
    const from: Loop = mode === "new" ? { start: f0, end: f0 } : loop ?? { start: f0, end: f0 };
    const rangeAt = (dx: number): Loop | null => {
      const df = snapTo(Math.abs(fr(dx)), step) * Math.sign(dx);
      const { start, end } = from;
      let next: Loop;
      if (mode === "move") next = { start: Math.max(0, start + df), end: Math.max(0, start + df) + (end - start) };
      else if (mode === "start") next = { start: Math.max(0, Math.min(end - step, start + df)), end };
      else if (mode === "end") next = { start, end: Math.max(start + step, end + df) };
      else {
        const b = Math.max(0, f0 + df);
        next = { start: Math.min(f0, b), end: Math.max(f0, b) };
      }
      return next.end - next.start >= step ? next : null;
    };
    const held = [hold(braceRef.current), hold(shadeRef.current)];
    const clear = () => held.forEach((r) => r());
    followPointer(e, {
      move: (p) => {
        const next = rangeAt(p.dx);
        if (!next) return;
        for (const el of [braceRef.current, shadeRef.current]) {
          if (!el) continue;
          el.style.left = `${px(next.start)}px`;
          el.style.width = `${Math.max(el === braceRef.current ? 4 : 0, px(next.end - next.start))}px`;
        }
        if (braceRef.current) {
          braceRef.current.style.display = "block";
          braceRef.current.dataset.dragging = "";
        }
      },
      cancel: clear,
      up: (p) => {
        clear();
        const next = rangeAt(p.dx);
        if (next) setLoop(next);
      },
    });
  };

  const row = (t: SetTrack) => {
    const status = results.tracks[t.id];
    const tSel = (sel?.kind === "track" || sel?.kind === "instance") && sel.track === t.id;
    const warn = flagged.get(t.id);
    return (
      <div key={t.id} className={`hub-set-row ${t.mute ? "muted" : ""} ${tSel ? "on" : ""}`} style={{ height: ROW_H }} data-track={t.id}>
        <div className={`hub-set-head ${colorClass(t.color)} ${sel?.kind === "track" && sel.track === t.id ? "on" : ""}`} title={SET_COPY.reorderHint}
          onPointerDown={(e) => headDown(e, t)}>
          <div className="hub-set-head-top">
            <button className="hub-set-title" aria-pressed={sel?.kind === "track" && sel.track === t.id} title={`${t.title}\n${SET_COPY.renameHint}`}
              onClick={() => select({ kind: "track", track: t.id })}
              onDoubleClick={() => {
                select({ kind: "track", track: t.id });
                ctx.onRename();
              }}>
              {status && <StatusMark look={INSTANCE_STATUS_LOOK[status]} size={10} />}
              <span className="hub-set-title-text">{t.title}</span>
            </button>
            {warn && <button className="hub-set-warn" aria-label={warn} title={warn} onClick={() => ctx.onWarning(t.id)}><HubIcon name="warn" size={11} /></button>}
          </div>
          <div className="hub-set-head-ctl">
            <button className="hub-set-toggle play" aria-label={SET_COPY.playTrack(t.title)} title={SET_COPY.playTrack(t.title)} onClick={() => void play({ kind: "track", goalId: t.id }, t.title)}><HubIcon name="play" size={9} /></button>
            <button className={`hub-set-toggle mute ${t.mute ? "on" : ""}`} aria-pressed={t.mute} aria-label={`${SET_COPY.mute} ${t.title}`} title={SET_COPY.mute} onClick={() => void edit([SET_OPS.trackMute(t.id, !t.mute)])}>M</button>
            <button className={`hub-set-toggle solo ${t.solo ? "on" : ""}`} aria-pressed={t.solo} aria-label={`${SET_COPY.solo} ${t.title}`} title={SET_COPY.solo} onClick={() => void edit([SET_OPS.trackSolo(t.id, !t.solo)])}>S</button>
            <PlayerField t={t} edit={edit} />
          </div>
        </div>
        <div className="hub-set-lane" style={{ width }} aria-label={t.title} role="group"
          onPointerDown={(e) => {
            if (e.button !== 0 || e.target !== e.currentTarget) return;
            setPlayhead(frameAt(e));
            select({ kind: "track", track: t.id });
          }}
          onDragOver={(e) => carriesClip(e) && e.preventDefault()}
          onDrop={(e) => laneDrop(e, t)}>
          {t.layout.map((l) => {
            const key = `${t.id}/${l.id}`;
            const st = results.instances[key];
            const inst = t.arrangement.instances.find((i) => i.id === l.id);
            const on = sel?.kind === "instance" && sel.track === t.id && sel.id === l.id;
            const flag = flagged.get(key);
            const w = Math.max(6, px(l.length));
            return (
              <div key={l.id} data-key={key}
                className={`hub-set-block kind-${l.kind} ${colorClass(inst?.color ?? t.color)} ${st ? `st-${st}` : ""} ${on ? "on" : ""} ${l.known ? "" : "unknown"} ${flag ? "flagged" : ""} ${w < 40 ? "thin" : ""}`}
                style={{ left: px(l.start), width: w }}
                role="button" tabIndex={-1} aria-pressed={on}
                aria-label={SET_COPY.block(l.name, arrangeSeconds(l.start, rate), arrangeSeconds(l.end, rate))}
                title={[l.name, flag, l.known ? null : SET_COPY.unknownLength, l.kind === "script" && l.known ? SET_COPY.reserved : null, st ? INSTANCE_STATUS_LOOK[st].label : null, SET_COPY.blockHint].filter(Boolean).join("\n")}
                onPointerDown={(e) => blockDown(e, t, l)}
                onDoubleClick={() => open(l.kind, l.target)}
                onDragOver={(e) => carriesClip(e) && e.preventDefault()}
                onDrop={(e) => blockDrop(e, t, l)}
              >
                <span className="hub-set-block-head">
                  {st && <StatusMark look={INSTANCE_STATUS_LOOK[st]} size={9} />}
                  <span className="hub-set-block-name">{l.name}</span>
                  {flag && <span className="hub-set-block-warn" aria-hidden="true" onPointerDown={(e) => {
                    e.stopPropagation();
                    ctx.onWarning(key);
                  }}><HubIcon name="warn" size={10} /></span>}
                </span>
                <span className="hub-set-block-body" aria-hidden="true">{!l.known && <span className="hub-set-block-unknown">?</span>}</span>
                <span className="hub-set-edge start" data-edge="start" aria-hidden="true" />
                {st === "running" && <span className="hub-set-progress" style={{ width: `${spanProgress(l.start, l.end, cursor) * 100}%` }} aria-hidden="true" />}
                <span className="hub-set-edge end" data-edge="end" aria-hidden="true" />
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="hub-set-scroll" ref={scrollRef}>
      <div className="hub-set-grid" style={gridStyle}>
        <div className="hub-set-row ruler">
          <div className="hub-set-corner">
            <button className="ghost small-button hub-set-add-track" onClick={ctx.onAddTrack} title={SET_COPY.addTrackHint}><HubIcon name="plus" size={11} /> {SET_COPY.addTrack}</button>
          </div>
          <div className="hub-set-ruler" style={{ width }}>
            <div className="hub-set-loopzone" aria-label={SET_COPY.loopRange} onPointerDown={braceDown}>
              {/* Drawn with no loop too, hidden, so drawing a first range has an element to move. */}
              <span ref={braceRef} className={`hub-set-brace ${loopOn ? "on" : ""}`} data-brace={loop ? "move" : undefined}
                style={loop ? { left: px(loop.start), width: Math.max(4, px(loop.end - loop.start)) } : { display: "none" }}
                title={loop ? `${SET_COPY.loopRange}: ${arrangeClock(loop.start, rate, true)} to ${arrangeClock(loop.end, rate, true)}` : undefined}>
                <span className="hub-set-brace-edge start" data-brace={loop ? "start" : undefined} />
                <span className="hub-set-brace-edge end" data-brace={loop ? "end" : undefined} />
              </span>
            </div>
            <div className="hub-set-scale" onPointerDown={scrub}>
              {rulerTicks(frames, rate, zoom).map((s) => <span key={s} className="hub-set-tick" style={{ left: px(s * rate) }}>{rulerEvery(zoom) < 1 ? arrangeClock(s * rate, rate, true) : arrangeClock(s * rate, rate)}</span>)}
            </div>
            <span ref={markerRef} className="hub-set-marker" style={{ left: px(playhead) }} aria-hidden="true" />
          </div>
        </div>
        <div className="hub-set-rows">
          {tracks.map(row)}
          {Array.from({ length: fillers }, (_, i) => (
            <div key={`spare-${i}`} className={`hub-set-row spare ${i === fillers - 1 ? "last" : ""}`} style={{ minHeight: ROW_H }}>
              <div className="hub-set-head spare" aria-hidden="true" />
              <div className="hub-set-lane spare" style={{ width }} title={SET_COPY.dropHint}
                onPointerDown={(e) => e.button === 0 && setPlayhead(frameAt(e))}
                onDragOver={(e) => carriesClip(e) && e.preventDefault()}
                onDrop={(e) => laneDrop(e, null)}>
                {i === 0 && <span className="hub-set-drop-hint">{SET_COPY.dropHere}</span>}
              </div>
            </div>
          ))}
          <div className="hub-set-overlay" style={{ left: HEAD_W, width }} aria-hidden="true">
            {loop && loopOn && <span ref={shadeRef} className="hub-set-loopshade" style={{ left: px(loop.start), width: px(loop.end - loop.start) }} />}
            <span ref={playheadRef} className="hub-set-playhead" style={{ left: px(playhead) }} />
            {cursor !== null && <span className="hub-set-cursor" style={{ left: px(cursor) }} />}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The Arrangement's timelines: a ruler with the loop brace and the playhead's
 * marker, then one row per track, a narrow header (name, then play, Mute,
 * Solo and the player under it) beside the track's lane. The header column
 * and the ruler stay put while the lanes scroll. Rows below the tracks are
 * empty grid, at least six rows in all, as a DAW draws an empty arrangement;
 * a clip dropped there gets a track of its own.
 */
import { useState, type CSSProperties, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
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
  edit: (lines: string[] | null, after?: (a: SetAnswer) => void) => Promise<void>;
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

/** A drag under way: an instance moved (across tracks too) or trimmed, or the loop brace moved or resized, by dx, dy pixels. */
interface Drag { track: string; id: string; mode: ArrangeDragMode; x0: number; y0: number; dx: number; dy: number; alt: boolean }
interface BraceDrag { mode: "move" | "start" | "end" | "new"; x0: number; f0: number; loop: Loop }

export function Timelines({ ctx }: { ctx: ViewCtx }) {
  const { tracks, rate, zoom, playhead, setPlayhead, sel, select, edit, play, open, results, cursor, flagged, loop, loopOn, setLoop, scrollRef } = ctx;
  const [drag, setDrag] = useState<Drag | null>(null);
  const [brace, setBrace] = useState<BraceDrag | null>(null);
  const frames = rulerFrames(Math.max(arrangeEnd(tracks.map((t) => t.layout)), ctx.runLength, loop?.end ?? 0), rate);
  const px = (f: number) => (f / rate) * zoom;
  const fr = (x: number) => (x / zoom) * rate;
  const width = px(frames);
  const step = arrangeStep(rate);
  const fillers = Math.max(1, MIN_ROWS - tracks.length);
  const gridStyle = { width: HEAD_W + width, "--major": `${rulerEvery(zoom) * zoom}px`, "--minor": `${rulerMinor(zoom) * zoom}px` } as CSSProperties;

  const blockDown = (e: ReactPointerEvent<HTMLElement>, t: SetTrack, l: InstanceLayout) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const edge = (e.target as HTMLElement).dataset.edge;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // jsdom and some pens have no capture; the drag still ends on pointerup.
    }
    select({ kind: "instance", track: t.id, id: l.id });
    setDrag({ track: t.id, id: l.id, mode: edge === "start" ? "trimStart" : edge === "end" ? "trimEnd" : "move", x0: e.clientX, y0: e.clientY, dx: 0, dy: 0, alt: e.altKey });
  };
  const blockMove = (e: ReactPointerEvent) => setDrag((d) => (d ? { ...d, dx: e.clientX - d.x0, dy: e.clientY - d.y0 } : d));
  /** Where a drag lands: the frame delta on the grid (Shift for single frames) and, for a move, the track it is over. */
  const landing = (d: Drag, l: InstanceLayout, free: boolean) => {
    const snap = (f: number) => (free ? Math.max(0, Math.round(f)) : snapTo(f, step));
    const edgeAt = d.mode === "trimEnd" ? l.end : l.start;
    const df = snap(edgeAt + fr(d.dx)) - edgeAt;
    const ti = tracks.findIndex((t) => t.id === d.track);
    const to = d.mode === "move" ? tracks[Math.max(0, Math.min(tracks.length - 1, ti + Math.round(d.dy / ROW_H)))] : undefined;
    return { df, to: to?.id };
  };
  const blockUp = (e: ReactPointerEvent, t: SetTrack, l: InstanceLayout) => {
    const d = drag;
    setDrag(null);
    if (!d || (Math.abs(d.dx) < 3 && Math.abs(d.dy) < ROW_H / 2)) return;
    const inst = t.arrangement.instances.find((i) => i.id === l.id);
    if (!inst) return;
    const { df, to } = landing(d, l, e.shiftKey);
    const dup = d.alt || e.altKey;
    void edit(dragLines(t.id, inst, l, d.mode, df, { scale: clipScale(t.arrangement.rate || rate, l.clipRate), duplicate: dup, toTrack: to }), (a) => {
      const id = dup ? a.changed?.find((c) => c !== l.id) : l.id;
      if (id) select({ kind: "instance", track: to ?? t.id, id });
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

  /** The ruler's scale: press or drag to move the playhead, as a DAW's scrub area does. */
  const scrub = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.buttons !== 1 && e.type !== "pointerdown") return;
    setPlayhead(frameAt(e));
  };
  /** The loop strip: drag the brace or its edges, or drag across empty strip to draw a new range. */
  const braceDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const edge = (e.target as HTMLElement).dataset.brace as BraceDrag["mode"] | undefined;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // As above.
    }
    const f0 = frameAt(e);
    const mode = edge ?? "new";
    const start = loop ?? { start: f0, end: f0 };
    setBrace({ mode, x0: e.clientX, f0, loop: mode === "new" ? { start: f0, end: f0 } : start });
  };
  const braceMove = (e: ReactPointerEvent<HTMLElement>) => {
    if (!brace) return;
    const df = snapTo(Math.abs(fr(e.clientX - brace.x0)), step) * Math.sign(e.clientX - brace.x0);
    const { start, end } = brace.loop;
    let next: Loop;
    if (brace.mode === "move") next = { start: Math.max(0, start + df), end: Math.max(0, start + df) + (end - start) };
    else if (brace.mode === "start") next = { start: Math.max(0, Math.min(end - step, start + df)), end };
    else if (brace.mode === "end") next = { start, end: Math.max(start + step, end + df) };
    else {
      const a = brace.f0;
      const b = Math.max(0, a + df);
      next = { start: Math.min(a, b), end: Math.max(a, b) };
    }
    if (next.end - next.start >= step) setLoop(next);
  };

  const row = (t: SetTrack) => {
    const status = results.tracks[t.id];
    const tSel = (sel?.kind === "track" || sel?.kind === "instance") && sel.track === t.id;
    const warn = flagged.get(t.id);
    return (
      <div key={t.id} className={`hub-set-row ${t.mute ? "muted" : ""} ${tSel ? "on" : ""}`} style={{ height: ROW_H }}>
        <div className={`hub-set-head ${colorClass(t.color)} ${sel?.kind === "track" && sel.track === t.id ? "on" : ""}`}
          onPointerDown={(e) => e.target === e.currentTarget && select({ kind: "track", track: t.id })}>
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
            const d = drag && drag.track === t.id && drag.id === l.id ? drag : null;
            const flag = flagged.get(key);
            let left = px(l.start);
            let w = Math.max(6, px(l.length));
            let dy = 0;
            if (d) {
              const { df } = landing(d, l, false);
              if (d.mode === "move") {
                left += px(df);
                dy = Math.round(d.dy / ROW_H) * ROW_H;
              } else if (d.mode === "trimEnd") w = Math.max(6, w + px(df));
              else {
                left += px(df);
                w = Math.max(6, w - px(df));
              }
            }
            return (
              <div key={l.id}
                className={`hub-set-block kind-${l.kind} ${colorClass(inst?.color ?? t.color)} ${st ? `st-${st}` : ""} ${on ? "on" : ""} ${l.known ? "" : "unknown"} ${flag ? "flagged" : ""} ${d ? "dragging" : ""} ${w < 40 ? "thin" : ""}`}
                style={{ left, width: w, transform: dy ? `translateY(${dy}px)` : undefined }}
                role="button" tabIndex={-1} aria-pressed={on}
                aria-label={SET_COPY.block(l.name, arrangeSeconds(l.start, rate), arrangeSeconds(l.end, rate))}
                title={[l.name, flag, l.known ? null : SET_COPY.unknownLength, l.kind === "script" && l.known ? SET_COPY.reserved : null, st ? INSTANCE_STATUS_LOOK[st].label : null, SET_COPY.blockHint].filter(Boolean).join("\n")}
                onPointerDown={(e) => blockDown(e, t, l)} onPointerMove={blockMove} onPointerUp={(e) => blockUp(e, t, l)}
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
            <div className="hub-set-loopzone" aria-label={SET_COPY.loopRange} onPointerDown={braceDown} onPointerMove={braceMove} onPointerUp={() => setBrace(null)}>
              {loop && (
                <span className={`hub-set-brace ${loopOn ? "on" : ""}`} data-brace="move" style={{ left: px(loop.start), width: Math.max(4, px(loop.end - loop.start)) }}
                  title={`${SET_COPY.loopRange}: ${arrangeClock(loop.start, rate, true)} to ${arrangeClock(loop.end, rate, true)}`}>
                  <span className="hub-set-brace-edge start" data-brace="start" />
                  <span className="hub-set-brace-edge end" data-brace="end" />
                </span>
              )}
            </div>
            <div className="hub-set-scale" onPointerDown={scrub} onPointerMove={scrub}>
              {rulerTicks(frames, rate, zoom).map((s) => <span key={s} className="hub-set-tick" style={{ left: px(s * rate) }}>{rulerEvery(zoom) < 1 ? arrangeClock(s * rate, rate, true) : arrangeClock(s * rate, rate)}</span>)}
            </div>
            <span className="hub-set-marker" style={{ left: px(playhead) }} aria-hidden="true" />
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
            {loop && loopOn && <span className="hub-set-loopshade" style={{ left: px(loop.start), width: px(loop.end - loop.start) }} />}
            <span className="hub-set-playhead" style={{ left: px(playhead) }} />
            {cursor !== null && <span className="hub-set-cursor" style={{ left: px(cursor) }} />}
          </div>
        </div>
      </div>
    </div>
  );
}

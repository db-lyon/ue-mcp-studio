/**
 * A timeline playtest on its timeline, edited like a sequencer's piano roll:
 * a lane per Input Action (Boolean notes, axis curves), the check notes,
 * events and named regions over a ruler of game time. Every change goes
 * through clip_edit, all or none, so ids stay stable; its rollback is undo,
 * and the rollback of that undo is redo. Warnings and refusals show inline
 * with ue-mcp's candidates as one-click fixes.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { Clip, ClipCheck, ClipFinding, ClipRefusal, ClipTrack, ClipTrackType } from "@ue-mcp-studio/shared";
import {
  CLIP_COPY,
  CLIP_GRIDS,
  CLIP_GRID_LABEL,
  CLIP_INTERP_LABEL,
  CLIP_MODE_LABEL,
  clipEnd,
  clipName,
  clipRate,
  emptyHistory,
  findingFix,
  findingTarget,
  frameSeconds,
  gridStep,
  historyAfterEdit,
  historyAfterRedo,
  historyAfterUndo,
  newKeyValue,
  parseValue,
  snapFrame,
  trackName,
  valueText,
  type ClipHistory,
  type ClipOp,
} from "@ue-mcp-studio/client-core";
import { ApiError, api } from "../../api";
import { useHub } from "./state";
import { HubField, HubIcon, Placeholder, ScreenHead } from "./parts";
import { capture, followPointer, hold, keyed, slideFrom } from "./drag";
import { NEW_ID, applyClipOps } from "./optimistic";
import "./timeline.css";

/** What is selected: an item on the clip, a track, or a check being added over a span. */
export type ClipSel =
  | { kind: "note" | "key"; track: string; id: string }
  | { kind: "check" | "event" | "region"; id: string }
  | { kind: "track"; track: string }
  | { kind: "newCheck"; start: number; length: number }
  | null;

/** How an item drag changes it: moved, or trimmed at its end or start. */
type ItemMode = "move" | "trim" | "trimStart";

const ZOOMS = [0.5, 1, 2, 4, 8, 16];
const LANE_H = 28;
const AXIS_H = 56;
const OPS = ["gt", "lt", "eq", "ne", "gte", "lte", "increasing", "decreasing", "visible", "exists", "triggered"];
const TYPES: ClipTrackType[] = ["bool", "axis1d", "axis2d", "axis3d"];

/** Overlays the run and recording views draw on the lanes. */
export interface LaneOverlay {
  /** Playback's position, in frames. */
  cursor?: number;
  checkStatus?: Record<string, string>;
  regionStatus?: Record<string, { status: string; drift?: string }>;
  /** Input Actions armed for recording, and how to arm one; absent hides the arm boxes. */
  armed?: Set<string>;
  onArm?: (action: string, on: boolean) => void;
  /** Extra notes drawn on a track while a take records: action to spans. */
  take?: Record<string, Array<{ start: number; length: number; open?: boolean }>>;
  takeKeys?: Record<string, Array<{ t: number; v: number | number[] }>>;
}

export function ClipScreen({ path, children }: { path: string; children?: (c: { clip: Clip; sel: ClipSel; select: (s: ClipSel) => void; reload: () => void }) => { overlay?: LaneOverlay; panel?: ReactNode; actions?: ReactNode } }) {
  const hub = useHub();
  /** The clip as clip_edit last answered it; what shows is this with the edits still out drawn over it. */
  const [server, setClip] = useState<Clip | null>(null);
  const [pending, setPending] = useState<Array<{ n: number; ops: ClipOp[] }>>([]);
  const clip = useMemo(() => (server ? pending.reduce((c, p) => applyClipOps(c, p.ops), server) : null), [server, pending]);
  const editN = useRef(0);
  /** Edits sent and not answered yet, drawn ahead or not. */
  const [out, setOut] = useState(0);
  /** One clip_edit at a time: each goes once the one before it is answered, so ids and the undo history stay in order. */
  const editQueue = useRef<Promise<void>>(Promise.resolve());
  const [slideBack, setSlideBack] = useState<{ id: string; from: DOMRect | null; n: number } | null>(null);
  useLayoutEffect(() => {
    if (slideBack) slideFrom(keyed(root.current, "data-id", slideBack.id), slideBack.from);
  }, [slideBack?.n]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<ClipFinding[]>([]);
  const [refusal, setRefusal] = useState<ClipRefusal | null>(null);
  const [history, setHistory] = useState<ClipHistory>(emptyHistory);
  const [sel, setSel] = useState<ClipSel>(null);
  const [zoom, setZoom] = useState(4);
  const [busy, setBusy] = useState(false);
  const [announce, setAnnounce] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const fitted = useRef(false);

  // The first time the clip shows, zoom so all of it fits when it can.
  useEffect(() => {
    if (!clip || fitted.current || !root.current) return;
    fitted.current = true;
    const room = root.current.clientWidth - (hub.narrow ? 96 : 168) - 4;
    if (room <= 0) return;
    const span = clipEnd(clip) + clipRate(clip);
    setZoom([...ZOOMS].reverse().find((z) => span * z <= room) ?? ZOOMS[0]);
  }, [clip]);

  const load = () => {
    setLoadError(null);
    api.clips.read(path).then((r) => {
      setClip(r.clip);
      setWarnings(r.warnings ?? []);
    }, (e: Error) => setLoadError(e.message));
  };
  useEffect(load, [path]);

  const refused = (e: unknown) => {
    const body = e instanceof ApiError ? (e.body as Partial<ClipRefusal> | undefined) : undefined;
    setRefusal({ error: body?.error ?? (e as Error).message, errors: body?.errors ?? [] });
  };

  /**
   * Apply ops through clip_edit; `then` picks what to select from the ids it
   * changed. Moves, trims and drawn notes, keys and regions show at once and
   * clip_edit's answer replaces them in the same render; a refusal takes them
   * back, slides the item to where it was and says why. Edits go one at a
   * time, behind any edit or undo still out.
   */
  const edit = (ops: ClipOp[], then?: (changed: string[]) => ClipSel): Promise<void> => {
    if (!ops.length) return Promise.resolve();
    const n = ++editN.current;
    const ahead = ops.some((o) => o.op === "move" || o.op === "trim" || o.op === "add");
    if (ahead) setPending((p) => [...p, { n, ops }]);
    setOut((c) => c + 1);
    const drop = () => {
      setPending((p) => p.filter((x) => x.n !== n));
      setOut((c) => c - 1);
    };
    const send = async () => {
      try {
        const r = await api.clips.edit(path, ops);
        setClip(r.clip);
        drop();
        setWarnings(r.warnings ?? []);
        setRefusal(null);
        setHistory((h) => historyAfterEdit(h, r.rollback));
        if (then) setSel(then(r.changed));
      } catch (e) {
        if (ahead) {
          const id = ops.map((o) => (o.op === "add" ? NEW_ID : typeof o.id === "string" ? o.id : null)).find((x): x is string => !!x);
          const from = id ? keyed(root.current, "data-id", id)?.getBoundingClientRect() ?? null : null;
          if (id && id !== NEW_ID) setSlideBack({ id, from, n });
          const body = e instanceof ApiError ? (e.body as Partial<ClipRefusal> | undefined) : undefined;
          hub.notify(CLIP_COPY.putBack(body?.error ?? (e as Error).message), "bad");
        }
        drop();
        refused(e);
      }
    };
    const p = editQueue.current.then(send, send);
    editQueue.current = p;
    return p;
  };

  const step = (dir: "undo" | "redo") => {
    // Undo takes back the newest answered edit, so it waits until none is out.
    if (busy || out) return;
    const run = async () => {
      const stack = dir === "undo" ? history.undo : history.redo;
      const payload = stack[stack.length - 1];
      if (!payload || !server) return;
      setBusy(true);
      try {
        const r = await api.clips.update(payload);
        const back = r.rollback ?? { path, clip: server };
        setHistory((h) => (dir === "undo" ? historyAfterUndo(h, back) : historyAfterRedo(h, back)));
        setClip(r.clip);
        setWarnings(r.warnings ?? []);
        setRefusal(null);
        setAnnounce(dir === "undo" ? CLIP_COPY.undo : CLIP_COPY.redo);
      } catch (e) {
        refused(e);
      } finally {
        setBusy(false);
      }
    };
    const p = editQueue.current.then(run, run);
    editQueue.current = p;
    return p;
  };

  if (loadError) {
    return (
      <div className="hub-screen">
        <ScreenHead eyebrow={CLIP_COPY.clip} title={clipName(path)} back={{ label: CLIP_COPY.clips, route: { screen: "clips" } }} />
        <div className="banner bad" role="alert">{CLIP_COPY.loadFailed}: {loadError} <button className="small-button" onClick={load}>{CLIP_COPY.tryAgain}</button></div>
      </div>
    );
  }
  if (!clip) return <div className="hub-screen"><Placeholder rows={6} /></div>;

  const extra = children?.({ clip, sel, select: setSel, reload: load }) ?? {};

  return (
    <div className="hub-screen hub-clip" ref={root}>
      <ScreenHead
        back={{ label: CLIP_COPY.clips, route: { screen: "clips" } }}
        eyebrow={CLIP_COPY.clip}
        title={clipName(path)}
        sub={<span className="mono small dim hub-path">{path}</span>}
        actions={<>
          {extra.actions}
          <button onClick={() => void step("undo")} disabled={busy || out > 0 || !history.undo.length} title={`${CLIP_COPY.undo} (Ctrl+Z)`}>{CLIP_COPY.undo}</button>
          <button onClick={() => void step("redo")} disabled={busy || out > 0 || !history.redo.length} title={`${CLIP_COPY.redo} (Ctrl+Y)`}>{CLIP_COPY.redo}</button>
        </>}
      />
      <span className="sr-only" role="status">{announce}</span>
      {extra.panel}
      {refusal && (
        <div className="banner bad hub-clip-refusal" role="alert">
          <div>{refusal.error}</div>
          {refusal.errors?.map((f, i) => <FindingLine key={i} clip={clip} finding={f} onSelect={setSel} onFix={(op) => void edit([op])} />)}
          <button className="ghost small-button" aria-label="Dismiss" onClick={() => setRefusal(null)}><HubIcon name="close" size={12} /></button>
        </div>
      )}
      {warnings.length > 0 && (
        <section className="hub-clip-warnings" aria-label={CLIP_COPY.warnings}>
          <div className="hub-eyebrow">{CLIP_COPY.warnings}</div>
          {warnings.map((f, i) => <FindingLine key={i} clip={clip} finding={f} onSelect={setSel} onFix={(op) => void edit([op])} />)}
        </section>
      )}
      <div className="hub-clip-toolbar">
        <label className="small">
          {CLIP_COPY.snap}{" "}
          <select value={clip.grid ?? "frame"} disabled={busy} onChange={(e) => void edit([{ op: "set_clip", grid: e.target.value }])}>
            {[...new Set([...CLIP_GRIDS, clip.grid ?? "frame"])].map((g) => <option key={g} value={g}>{CLIP_GRID_LABEL[g] ?? g}</option>)}
          </select>
        </label>
        <span className="hub-clip-zoom">
          <button className="ghost small-button" aria-label={CLIP_COPY.zoomOut} title={CLIP_COPY.zoomOut} disabled={zoom <= ZOOMS[0]} onClick={() => setZoom(ZOOMS[Math.max(0, ZOOMS.indexOf(zoom) - 1)])}>-</button>
          <button className="ghost small-button" aria-label={CLIP_COPY.zoomIn} title={CLIP_COPY.zoomIn} disabled={zoom >= ZOOMS[ZOOMS.length - 1]} onClick={() => setZoom(ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(zoom) + 1)])}>+</button>
        </span>
        <span className="small dim">{CLIP_COPY.hint}</span>
      </div>
      <Lanes clip={clip} zoom={zoom} narrow={hub.narrow} sel={sel} onSelect={setSel} onEdit={edit} onHistory={(d) => void step(d)} overlay={extra.overlay} />
      <Inspector key={selKey(sel)} clip={clip} sel={sel} busy={busy} onEdit={edit} onSelect={setSel} />
    </div>
  );
}

const selKey = (s: ClipSel): string => (!s ? "clip" : s.kind === "newCheck" ? `new:${s.start}:${s.length}` : s.kind === "track" ? `track:${s.track}` : `${s.kind}:${s.id}`);
const selId = (s: ClipSel): string | null => (s && "id" in s ? s.id : null);

/** One finding: its message, Select when it names something on the clip, and its candidates as fixes where they are field values. */
function FindingLine({ clip, finding, onSelect, onFix }: { clip: Clip; finding: ClipFinding; onSelect: (s: ClipSel) => void; onFix: (op: ClipOp) => void }) {
  const at = findingTarget(clip, finding);
  const fixes = (finding.candidates ?? []).map((c) => ({ c, op: findingFix(clip, finding, c) }));
  const plain = fixes.filter((f) => !f.op).map((f) => f.c);
  return (
    <div className="hub-clip-finding small">
      <span>{finding.message}</span>
      {at && <button className="ghost small-button" onClick={() => onSelect(at.kind === "note" || at.kind === "key" ? { kind: at.kind, id: at.id, track: at.track! } : { kind: at.kind, id: at.id })}>{CLIP_COPY.selectIt}</button>}
      {fixes.some((f) => f.op) && <span className="dim">{CLIP_COPY.replaceWith}</span>}
      {fixes.filter((f) => f.op).map((f) => <button key={f.c} className="small-button mono" onClick={() => onFix(f.op!)}>{f.c}</button>)}
      {plain.length > 0 && <span className="dim">{CLIP_COPY.closest}: <span className="mono">{plain.join(", ")}</span></span>}
    </div>
  );
}

/** Seconds between ruler labels, so labels stay at least 64 pixels apart. */
function rulerStep(zoom: number, rate: number): number {
  for (const s of [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60]) if (s * rate * zoom >= 64) return s;
  return 120;
}

function Lanes({ clip, zoom, narrow, sel, onSelect, onEdit, onHistory, overlay }: {
  clip: Clip;
  zoom: number;
  narrow: boolean;
  sel: ClipSel;
  onSelect: (s: ClipSel) => void;
  onEdit: (ops: ClipOp[], then?: (changed: string[]) => ClipSel) => Promise<void>;
  onHistory: (d: "undo" | "redo") => void;
  overlay?: LaneOverlay;
}) {
  const box = useRef<HTMLDivElement>(null);
  /** The drag under way, so a new press or leaving the view ends it. */
  const dragStop = useRef<(() => void) | null>(null);
  useEffect(() => () => dragStop.current?.(), []);
  const rate = clipRate(clip);
  // Keep playback's cursor in view.
  useEffect(() => {
    const el = box.current;
    if (!el || overlay?.cursor === undefined) return;
    const x = overlay.cursor * zoom;
    const view = el.clientWidth - (narrow ? 96 : 168);
    if (x < el.scrollLeft || x > el.scrollLeft + view - 24) el.scrollLeft = Math.max(0, x - view / 3);
  }, [overlay?.cursor, zoom]);
  const end = clipEnd(clip);
  const width = Math.ceil((end + rate) * zoom);
  const label = narrow ? 96 : 168;
  const step = gridStep(clip);
  const snap = (f: number) => snapFrame(f, clip);
  const tracks = clip.tracks ?? [];
  const checkRows = useMemo(() => stackRows(clip.checks ?? []), [clip.checks]);

  /** Where an item lands after a drag of dx pixels: its start and length on the clip's grid. */
  const land = (mode: ItemMode, start: number, length: number, dx: number): [number, number] => {
    const df = snap(start + dx / zoom) - start;
    if (mode === "move") return [start + df, length];
    if (mode === "trim") return [start, Math.max(step || 1, snap(start + length + dx / zoom) - start)];
    const s = Math.min(start + length - (step || 1), snap(start + dx / zoom));
    return [s, start + length - s];
  };

  /**
   * Press on an item: select it, and drag to move it, or by an edge to trim
   * it. The drag writes the item's left and width itself, once a frame, and
   * `commit` gets where it landed once, on release.
   */
  const itemDown = (e: ReactPointerEvent<HTMLElement>, target: ClipSel, trimmable: boolean, start: number, length: number, minW: number, commit: (mode: ItemMode, s: number, l: number) => void) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    dragStop.current?.();
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    const edge = Math.min(6, r.width / 3);
    const mode: ItemMode = trimmable && e.clientX > r.right - edge ? "trim" : trimmable && e.clientX < r.left + edge ? "trimStart" : "move";
    capture(el, e.pointerId);
    onSelect(target);
    const restore = hold(el);
    const end = () => {
      restore();
      dragStop.current = null;
    };
    dragStop.current = followPointer(e, {
      move: (p) => {
        if (Math.abs(p.dx) < 3) return restore();
        const [s, l] = land(mode, start, length, p.dx);
        el.dataset.dragging = "";
        el.style.left = `${s * zoom}px`;
        if (trimmable) el.style.width = `${Math.max(l * zoom, minW)}px`;
      },
      cancel: end,
      up: (p) => {
        end();
        if (Math.abs(p.dx) < 3) return;
        const [s, l] = land(mode, start, length, p.dx);
        commit(mode, s, l);
      },
    });
  };
  /** A note, key, check or event dropped: one move or trim op, drawn at once. */
  const itemCommit = (id: string, target: ClipSel, start: number, length: number) => (mode: ItemMode, s: number, l: number) => {
    if (mode === "move" && s !== start) void onEdit([{ op: "move", id, to: s }], () => target);
    else if (mode === "trim" && l !== length) void onEdit([{ op: "trim", id, length: l }], () => target);
    else if (mode === "trimStart" && s !== start) void onEdit([{ op: "trim", id, start: s, length: l }], () => target);
  };
  const regionCommit = (r: { id: string; start: number; end: number }) => (mode: ItemMode, s: number, l: number) => {
    const target: ClipSel = { kind: "region", id: r.id };
    if (mode === "move" && s !== r.start) void onEdit([{ op: "move", id: r.id, to: s }], () => target);
    else if (mode !== "move" && (s !== r.start || s + l !== r.end)) void onEdit([{ op: "trim", id: r.id, start: s, end: s + l }], () => target);
  };

  /** Press on an empty lane: draw a span, drawn by the drag itself and handed over once, on release. */
  const laneDown = (e: ReactPointerEvent<HTMLElement>, lane: string, track?: ClipTrack) => {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    dragStop.current?.();
    const laneEl = e.currentTarget;
    const at = (x: number) => snap((x - laneEl.getBoundingClientRect().left) / zoom);
    const f0 = at(e.clientX);
    capture(laneEl, e.pointerId);
    const span = document.createElement("span");
    span.className = "hub-clip-drawing";
    span.setAttribute("aria-hidden", "true");
    span.style.display = "none";
    laneEl.appendChild(span);
    const end = () => {
      span.remove();
      dragStop.current = null;
    };
    dragStop.current = followPointer(e, {
      move: (p) => {
        const f1 = at(p.clientX);
        span.style.display = f1 === f0 ? "none" : "";
        span.style.left = `${Math.min(f0, f1) * zoom}px`;
        span.style.width = `${Math.abs(f1 - f0) * zoom}px`;
      },
      cancel: end,
      up: (p) => {
        end();
        drawn(lane, track, f0, at(p.clientX));
      },
    });
  };
  const drawn = (lane: string, track: ClipTrack | undefined, f0: number, f1: number) => {
    const d = { lane, f0, f1 };
    const start = Math.min(d.f0, d.f1);
    const drawn = Math.abs(d.f1 - d.f0);
    const length = drawn > 0 ? drawn : step || 1;
    if (track?.type === "bool") void onEdit([{ op: "add", kind: "note", track: track.action, start, length }], (c) => (c[0] ? { kind: "note", track: track.action, id: c[0] } : null));
    else if (track) void onEdit([{ op: "add", kind: "key", track: track.action, time: d.f0, value: newKeyValue(track, d.f0) }], (c) => (c[0] ? { kind: "key", track: track.action, id: c[0] } : null));
    else if (d.lane === "regions") void onEdit([{ op: "add", kind: "region", name: CLIP_COPY.newRegion((clip.regions?.length ?? 0) + 1), start, end: start + (drawn > 0 ? drawn : rate) }], (c) => (c[0] ? { kind: "region", id: c[0] } : null));
    else if (d.lane === "checks") onSelect({ kind: "newCheck", start, length: drawn });
  };

  /** Delete, arrow nudges and undo from the keyboard while the timeline has focus. */
  const onKey = (e: ReactKeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA") return;
    const ctrl = e.ctrlKey || e.metaKey;
    const id = selId(sel);
    if (ctrl && e.key.toLowerCase() === "z") onHistory(e.shiftKey ? "redo" : "undo");
    else if (ctrl && e.key.toLowerCase() === "y") onHistory("redo");
    else if ((e.key === "Delete" || e.key === "Backspace") && id) void onEdit([{ op: "delete", id }], () => null);
    else if ((e.key === "Delete" || e.key === "Backspace") && sel?.kind === "track") void onEdit([{ op: "delete", id: sel.track }], () => null);
    else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && id && sel?.kind !== "newCheck") void onEdit([{ op: "move", id, by: (e.key === "ArrowLeft" ? -1 : 1) * (step || 1) }], () => sel);
    else return;
    e.preventDefault();
  };

  const ticks: number[] = [];
  const every = rulerStep(zoom, rate);
  for (let s = 0; s * rate <= end + rate; s += every) ticks.push(s);
  const cursor = overlay?.cursor !== undefined ? <span className="hub-clip-cursor" style={{ left: overlay.cursor * zoom }} aria-hidden="true" /> : null;

  return (
    <div className="hub-clip-lanes" ref={box} tabIndex={0} onKeyDown={onKey} role="group" aria-label={CLIP_COPY.clip} style={{ ["--label-w" as string]: `${label}px` }}>
      <div className="hub-clip-grid" style={{ width: width + label }}>
        <div className="hub-clip-row hub-clip-ruler">
          <div className="hub-clip-label" />
          <div className="hub-clip-lane" style={{ width }}>
            {ticks.map((s) => <span key={s} className="hub-clip-tick small dim" style={{ left: s * rate * zoom }}>{frameSeconds(s * rate, clip)}</span>)}
            {cursor}
          </div>
        </div>
        <div className="hub-clip-row">
          <div className="hub-clip-label small">{CLIP_COPY.regions}</div>
          <div className="hub-clip-lane hub-clip-regions" style={{ width }} onPointerDown={(e) => laneDown(e, "regions")}>
            {(clip.regions ?? []).map((r) => {
              const st = overlay?.regionStatus?.[r.id];
              return (
                <button key={r.id} data-id={r.id} className={`hub-clip-item hub-clip-region ${selId(sel) === r.id ? "on" : ""} ${st ? `st-${st.status}` : ""}`} style={{ left: r.start * zoom, width: Math.max((r.end - r.start) * zoom, 6) }}
                  title={`${r.name} (${r.start} to ${r.end})${st?.drift ? `, ${st.drift}` : ""}`}
                  onPointerDown={(e) => itemDown(e, { kind: "region", id: r.id }, true, r.start, r.end - r.start, 6, regionCommit(r))}
                  onClick={() => onSelect({ kind: "region", id: r.id })}>
                  <span className="hub-clip-item-text">{r.name}{st?.drift ? ` · ${st.drift}` : ""}</span>
                </button>
              );
            })}
            {cursor}
          </div>
        </div>
        {tracks.map((t) => {
          const axis = t.type !== "bool";
          const h = axis ? AXIS_H : LANE_H;
          const armed = overlay?.armed;
          return (
            <div key={t.action} className="hub-clip-row" style={{ height: h }}>
              <div className={`hub-clip-label small ${sel?.kind === "track" && sel.track === t.action ? "on" : ""}`}>
                {armed && (
                  <input type="checkbox" className="hub-clip-arm" checked={armed.has(t.action)} disabled={!overlay?.onArm} aria-label={`${CLIP_COPY.arm}: ${trackName(t.action)}`} title={CLIP_COPY.arm} onChange={(e) => overlay?.onArm?.(t.action, e.target.checked)} />
                )}
                <button className="ghost hub-clip-track-name" title={t.action} onClick={() => onSelect({ kind: "track", track: t.action })}>{trackName(t.action)}</button>
                <span className="dim mono hub-clip-type">{t.type}</span>
              </div>
              <div className={`hub-clip-lane ${axis ? "axis" : ""}`} style={{ width, height: h }} onPointerDown={(e) => laneDown(e, t.action, t)}>
                {axis && <Curve track={t} zoom={zoom} width={width} height={h} extra={overlay?.takeKeys?.[t.action]} />}
                {(t.notes ?? []).map((n) => {
                  const target: ClipSel = { kind: "note", track: t.action, id: n.id };
                  return (
                    <button key={n.id} data-id={n.id} className={`hub-clip-item hub-clip-note ${selId(sel) === n.id ? "on" : ""}`} style={{ left: n.start * zoom, width: Math.max(n.length * zoom, 4) }}
                      title={`${n.id}: ${n.start} + ${n.length}${n.value !== undefined ? ` = ${valueText(n.value)}` : ""}`} aria-label={`${CLIP_COPY.note} ${n.id}, ${CLIP_COPY.start} ${n.start}, ${CLIP_COPY.length} ${n.length}`}
                      onPointerDown={(e) => itemDown(e, target, true, n.start, n.length, 4, itemCommit(n.id, target, n.start, n.length))} onClick={() => onSelect(target)} />
                  );
                })}
                {(t.keys ?? []).map((k) => {
                  const target: ClipSel = { kind: "key", track: t.action, id: k.id };
                  const y = typeof k.v === "number" ? (1 - (Math.max(-1, Math.min(1, k.v)) + 1) / 2) * h : h / 2;
                  return (
                    <button key={k.id} data-id={k.id} className={`hub-clip-key ${selId(sel) === k.id ? "on" : ""}`} style={{ left: k.t * zoom, top: y }}
                      title={`${k.id}: ${k.t} = ${valueText(k.v)}`} aria-label={`${CLIP_COPY.key} ${k.id}, ${CLIP_COPY.time} ${k.t}, ${CLIP_COPY.value} ${valueText(k.v)}`}
                      onPointerDown={(e) => itemDown(e, target, false, k.t, 0, 0, itemCommit(k.id, target, k.t, 0))} onClick={() => onSelect(target)} />
                  );
                })}
                {(overlay?.take?.[t.action] ?? []).map((n, i) => (
                  <span key={`take${i}`} className={`hub-clip-take ${n.open ? "open" : ""}`} style={{ left: n.start * zoom, width: Math.max(n.length * zoom, 3) }} aria-hidden="true" />
                ))}
                {cursor}
              </div>
            </div>
          );
        })}
        <div className="hub-clip-row" style={{ height: Math.max(1, checkRows.count) * LANE_H }}>
          <div className="hub-clip-label small">{CLIP_COPY.checks}</div>
          <div className="hub-clip-lane hub-clip-checks" style={{ width, height: Math.max(1, checkRows.count) * LANE_H }} onPointerDown={(e) => laneDown(e, "checks")}>
            {(clip.checks ?? []).map((c) => {
              const st = overlay?.checkStatus?.[c.id];
              const target: ClipSel = { kind: "check", id: c.id };
              return (
                <button key={c.id} data-id={c.id} className={`hub-clip-item hub-clip-check mode-${c.manual ? "manual" : c.mode} ${selId(sel) === c.id ? "on" : ""} ${st ? `st-${st}` : ""}`}
                  style={{ left: c.start * zoom, width: Math.max(c.length * zoom, 8), top: (checkRows.row[c.id] ?? 0) * LANE_H + 3 }}
                  title={`${checkTitle(c)}${st ? ` (${st.replace("_", " ")})` : ""}`}
                  onPointerDown={(e) => itemDown(e, target, c.length > 0, c.start, c.length, 8, itemCommit(c.id, target, c.start, c.length))}
                  onClick={() => onSelect({ kind: "check", id: c.id })}>
                  <span className="hub-clip-item-text">{checkTitle(c)}</span>
                </button>
              );
            })}
            {cursor}
          </div>
        </div>
        <div className="hub-clip-row">
          <div className="hub-clip-label small">{CLIP_COPY.events}</div>
          <div className="hub-clip-lane" style={{ width }}>
            {(clip.events ?? []).map((ev) => {
              const target: ClipSel = { kind: "event", id: ev.id };
              return (
                <button key={ev.id} data-id={ev.id} className={`hub-clip-event ${selId(sel) === ev.id ? "on" : ""}`} style={{ left: ev.at * zoom }} title={`${ev.id}: ${JSON.stringify(ev.do)}`} aria-label={`${CLIP_COPY.event} ${ev.id}, ${ev.at}`}
                  onPointerDown={(e) => itemDown(e, target, false, ev.at, 0, 0, itemCommit(ev.id, target, ev.at, 0))} onClick={() => onSelect(target)} />
              );
            })}
            {cursor}
          </div>
        </div>
      </div>
    </div>
  );
}

const checkTitle = (c: ClipCheck): string => c.name ?? (c.manual ? c.instruction ?? c.id : c.expect ? `${c.expect.value} ${c.expect.op}${c.expect.target !== undefined ? ` ${String(c.expect.target)}` : ""}` : c.id);

/** Check notes may overlap: each goes on the first row free at its start. */
function stackRows(checks: ClipCheck[]): { row: Record<string, number>; count: number } {
  const ends: number[] = [];
  const row: Record<string, number> = {};
  for (const c of [...checks].sort((a, b) => a.start - b.start)) {
    let i = ends.findIndex((e) => e <= c.start);
    if (i < 0) i = ends.length;
    ends[i] = c.start + Math.max(c.length, 1);
    row[c.id] = i;
  }
  return { row, count: ends.length };
}

/** An axis track's curve, one line per component, from -1 at the bottom to 1 at the top. */
function Curve({ track, zoom, width, height, extra }: { track: ClipTrack; zoom: number; width: number; height: number; extra?: Array<{ t: number; v: number | number[] }> }) {
  const y = (v: number) => (1 - (Math.max(-1, Math.min(1, v)) + 1) / 2) * height;
  const own = linesOf([...(track.keys ?? [])].sort((a, b) => a.t - b.t), zoom, width, y);
  // The take so far is its own line, ending where the take has got to.
  const take = extra?.length ? linesOf([...extra].sort((a, b) => a.t - b.t), zoom, extra[extra.length - 1].t * zoom, y) : [];
  if (!own.length && !take.length) return null;
  return (
    <svg className="hub-clip-curve" width={width} height={height} aria-hidden="true">
      <line x1={0} x2={width} y1={height / 2} y2={height / 2} className="zero" />
      {own.map((p, d) => <polyline key={d} points={p} className={`c${d}`} />)}
      {take.map((p, d) => <polyline key={`t${d}`} points={p} className="take" />)}
    </svg>
  );
}

/** Polyline points per component of a curve, held flat after a constant key and after the last one. */
function linesOf(keys: Array<{ t: number; v: number | number[]; interp?: string }>, zoom: number, until: number, y: (v: number) => number): string[] {
  if (!keys.length) return [];
  const dims = Array.isArray(keys[0].v) ? keys[0].v.length : 1;
  return Array.from({ length: dims }, (_, d) => {
    const pts: string[] = [];
    keys.forEach((k, i) => {
      const v = Array.isArray(k.v) ? k.v[d] ?? 0 : k.v;
      const prev = keys[i - 1];
      if (prev?.interp === "constant") {
        const pv = Array.isArray(prev.v) ? prev.v[d] ?? 0 : prev.v;
        pts.push(`${k.t * zoom},${y(pv)}`);
      }
      pts.push(`${k.t * zoom},${y(v)}`);
    });
    const last = keys[keys.length - 1];
    pts.push(`${until},${y(Array.isArray(last.v) ? last.v[d] ?? 0 : last.v)}`);
    return pts.join(" ");
  });
}

/** A number field that commits on blur or Enter, when it changed. */
function NumField({ id, label, value, onCommit, min = 0 }: { id: string; label: string; value: number; onCommit: (n: number) => void; min?: number }) {
  const [text, setText] = useState(String(value));
  const [error, setError] = useState<string | undefined>();
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Number(text);
    if (!Number.isFinite(n) || n < min) return setError(CLIP_COPY.badValue(1));
    setError(undefined);
    if (n !== value) onCommit(n);
  };
  return (
    <HubField id={id} label={label} error={error}>
      {(a) => <input {...a} inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} />}
    </HubField>
  );
}

/** A text field that commits on blur or Enter; `check` returns an error or null. */
function TextField({ id, label, value, onCommit, check, mono, list, placeholder }: { id: string; label: string; value: string; onCommit: (s: string) => void; check?: (s: string) => string | null; mono?: boolean; list?: string; placeholder?: string }) {
  const [text, setText] = useState(value);
  const [error, setError] = useState<string | undefined>();
  useEffect(() => setText(value), [value]);
  const commit = () => {
    const bad = check?.(text) ?? null;
    if (bad) return setError(bad);
    setError(undefined);
    if (text !== value) onCommit(text);
  };
  return (
    <HubField id={id} label={label} error={error}>
      {(a) => <input {...a} className={mono ? "mono" : undefined} list={list} placeholder={placeholder} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} />}
    </HubField>
  );
}

/** A check's target as typed: a number, true or false, or text. */
const targetOf = (s: string): unknown => (s.trim() === "" ? undefined : s === "true" ? true : s === "false" ? false : Number.isFinite(Number(s)) ? Number(s) : s);

function Inspector({ clip, sel, busy, onEdit, onSelect }: { clip: Clip; sel: ClipSel; busy: boolean; onEdit: (ops: ClipOp[], then?: (changed: string[]) => ClipSel) => Promise<void>; onSelect: (s: ClipSel) => void }) {
  const del = (id: string) => <button className="danger-button small-button" disabled={busy} onClick={() => void onEdit([{ op: "delete", id }], () => null)}><HubIcon name="trash" size={12} /> {CLIP_COPY.delete}</button>;
  const track = sel && "track" in sel ? clip.tracks?.find((t) => t.action === sel.track) : undefined;
  const set = (id: string, fields: Record<string, unknown>) => void onEdit([{ op: "set", id, ...fields }], () => sel);
  const ops = <datalist id="clip-ops">{OPS.map((o) => <option key={o} value={o} />)}</datalist>;

  let title: string = CLIP_COPY.clipSettings;
  let body: ReactNode = null;
  if (sel?.kind === "note" && track) {
    const n = track.notes?.find((x) => x.id === sel.id);
    if (n) {
      title = `${CLIP_COPY.note} ${n.id} · ${trackName(track.action)}`;
      body = <>
        <NumField id="ci-start" label={`${CLIP_COPY.start} (${CLIP_COPY.frames})`} value={n.start} onCommit={(v) => void onEdit([{ op: "move", id: n.id, to: v }], () => sel)} />
        <NumField id="ci-length" label={`${CLIP_COPY.length} (${CLIP_COPY.frames})`} value={n.length} onCommit={(v) => void onEdit([{ op: "trim", id: n.id, length: v }], () => sel)} />
        {track.type !== "bool" && <TextField id="ci-value" label={CLIP_COPY.value} value={valueText(n.value)} mono check={(s) => (parseValue(s, track.type) === null ? CLIP_COPY.badValue(dimsOf(track.type)) : null)} onCommit={(s) => set(n.id, { value: parseValue(s, track.type) })} />}
        {del(n.id)}
      </>;
    }
  } else if (sel?.kind === "key" && track) {
    const k = track.keys?.find((x) => x.id === sel.id);
    if (k) {
      title = `${CLIP_COPY.key} ${k.id} · ${trackName(track.action)}`;
      body = <>
        <NumField id="ci-time" label={`${CLIP_COPY.time} (${CLIP_COPY.frames})`} value={k.t} onCommit={(v) => void onEdit([{ op: "move", id: k.id, to: v }], () => sel)} />
        <TextField id="ci-value" label={CLIP_COPY.value} value={valueText(k.v)} mono check={(s) => (parseValue(s, track.type) === null ? CLIP_COPY.badValue(dimsOf(track.type)) : null)} onCommit={(s) => set(k.id, { v: parseValue(s, track.type) })} />
        <HubField id="ci-interp" label={CLIP_COPY.interp}>
          {(a) => <select {...a} value={k.interp ?? "linear"} disabled={busy} onChange={(e) => set(k.id, { interp: e.target.value })}>{Object.entries(CLIP_INTERP_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>}
        </HubField>
        {del(k.id)}
      </>;
    }
  } else if (sel?.kind === "track" && track) {
    title = trackName(track.action);
    body = <>
      <div className="mono small dim">{track.action} · {track.type}</div>
      {del(track.action)}
    </>;
  } else if (sel?.kind === "check") {
    const c = clip.checks?.find((x) => x.id === sel.id);
    if (c) {
      title = `${CLIP_COPY.check} ${c.id}`;
      body = <>
        <TextField id="ci-name" label={CLIP_COPY.name} value={c.name ?? ""} onCommit={(s) => set(c.id, { name: s })} />
        {!c.manual && (
          <HubField id="ci-mode" label={CLIP_COPY.mode}>
            {(a) => <select {...a} value={c.mode} disabled={busy} onChange={(e) => set(c.id, { mode: e.target.value })}>{Object.entries(CLIP_MODE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>}
          </HubField>
        )}
        <NumField id="ci-start" label={`${CLIP_COPY.start} (${CLIP_COPY.frames})`} value={c.start} onCommit={(v) => void onEdit([{ op: "move", id: c.id, to: v }], () => sel)} />
        <NumField id="ci-length" label={`${CLIP_COPY.length} (${CLIP_COPY.frames})`} value={c.length} onCommit={(v) => void onEdit([{ op: "trim", id: c.id, length: v }], () => sel)} />
        {c.manual
          ? <TextField id="ci-instruction" label={CLIP_COPY.instruction} value={c.instruction ?? ""} onCommit={(s) => set(c.id, { instruction: s })} />
          : <>
            <TextField id="ci-value" label={CLIP_COPY.checkValue} value={c.expect?.value ?? ""} mono onCommit={(s) => set(c.id, { expect: { value: s } })} />
            <TextField id="ci-op" label={CLIP_COPY.op} value={c.expect?.op ?? ""} mono list="clip-ops" onCommit={(s) => set(c.id, { expect: { op: s } })} />
            <TextField id="ci-target" label={CLIP_COPY.target} value={c.expect?.target === undefined ? "" : String(c.expect.target)} mono onCommit={(s) => set(c.id, { expect: { target: targetOf(s) } })} />
            {ops}
          </>}
        {del(c.id)}
      </>;
    }
  } else if (sel?.kind === "region") {
    const r = clip.regions?.find((x) => x.id === sel.id);
    if (r) {
      title = `${CLIP_COPY.region} ${r.id}`;
      body = <>
        <TextField id="ci-name" label={CLIP_COPY.name} value={r.name} onCommit={(s) => set(r.id, { name: s })} />
        <NumField id="ci-start" label={`${CLIP_COPY.start} (${CLIP_COPY.frames})`} value={r.start} onCommit={(v) => void onEdit([{ op: "trim", id: r.id, start: v }], () => sel)} />
        <NumField id="ci-end" label={`${CLIP_COPY.end} (${CLIP_COPY.frames})`} value={r.end} onCommit={(v) => void onEdit([{ op: "trim", id: r.id, end: v }], () => sel)} />
        {del(r.id)}
      </>;
    }
  } else if (sel?.kind === "event") {
    const ev = clip.events?.find((x) => x.id === sel.id);
    if (ev) {
      title = `${CLIP_COPY.event} ${ev.id}`;
      body = <>
        <NumField id="ci-at" label={`${CLIP_COPY.time} (${CLIP_COPY.frames})`} value={ev.at} onCommit={(v) => void onEdit([{ op: "move", id: ev.id, to: v }], () => sel)} />
        <TextField id="ci-do" label={CLIP_COPY.eventDo} value={JSON.stringify(ev.do)} mono check={(s) => (jsonOf(s) === undefined ? CLIP_COPY.badJson : null)} onCommit={(s) => set(ev.id, { do: jsonOf(s) })} />
        {del(ev.id)}
      </>;
    }
  } else if (sel?.kind === "newCheck") {
    title = CLIP_COPY.addCheck;
    body = <NewCheck start={sel.start} length={sel.length} busy={busy} ops={ops} onAdd={(fields) => void onEdit([{ op: "add", kind: "check", ...fields }], (c) => (c[0] ? { kind: "check", id: c[0] } : null))} />;
  }
  if (!body) {
    body = <ClipSettings clip={clip} busy={busy} onEdit={onEdit} onSelect={onSelect} />;
  }
  return (
    <section className="hub-clip-inspector" aria-label={title}>
      <div className="hub-clip-inspector-head">
        <strong>{title}</strong>
        {sel && <button className="ghost small-button" aria-label="Close" onClick={() => onSelect(null)}><HubIcon name="close" size={12} /></button>}
      </div>
      <div className="hub-clip-fields">{body}</div>
    </section>
  );
}

const dimsOf = (t: ClipTrackType): number => (t === "axis2d" ? 2 : t === "axis3d" ? 3 : 1);
function jsonOf(s: string): unknown {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return undefined;
  }
}

function NewCheck({ start, length, busy, ops, onAdd }: { start: number; length: number; busy: boolean; ops: ReactNode; onAdd: (fields: Record<string, unknown>) => void }) {
  const [s, setS] = useState(String(start));
  const [l, setL] = useState(String(length));
  const [manual, setManual] = useState(false);
  const [mode, setMode] = useState<string>(length > 0 ? "by_end" : "hold");
  const [value, setValue] = useState("");
  const [op, setOp] = useState("gt");
  const [target, setTarget] = useState("");
  const [instruction, setInstruction] = useState("");
  const add = () => {
    const at = { start: Number(s) || 0, length: Number(l) || 0 };
    if (manual) onAdd({ ...at, mode: "hold", manual: true, instruction });
    else onAdd({ ...at, mode, expect: { value, op, ...(targetOf(target) !== undefined ? { target: targetOf(target) } : {}) } });
  };
  const ready = manual ? instruction.trim() !== "" : value.trim() !== "" && op.trim() !== "";
  return (
    <>
      <HubField id="nc-start" label={`${CLIP_COPY.start} (${CLIP_COPY.frames})`}>{(a) => <input {...a} inputMode="decimal" value={s} onChange={(e) => setS(e.target.value)} />}</HubField>
      <HubField id="nc-length" label={`${CLIP_COPY.length} (${CLIP_COPY.frames})`}>{(a) => <input {...a} inputMode="decimal" value={l} onChange={(e) => setL(e.target.value)} />}</HubField>
      <label className="hub-clip-check-manual small"><input type="checkbox" checked={manual} onChange={(e) => setManual(e.target.checked)} /> {CLIP_COPY.manual}</label>
      {manual
        ? <HubField id="nc-instruction" label={CLIP_COPY.instruction}>{(a) => <input {...a} value={instruction} onChange={(e) => setInstruction(e.target.value)} />}</HubField>
        : <>
          <HubField id="nc-mode" label={CLIP_COPY.mode}>{(a) => <select {...a} value={mode} onChange={(e) => setMode(e.target.value)}>{Object.entries(CLIP_MODE_LABEL).map(([v, lab]) => <option key={v} value={v}>{lab}</option>)}</select>}</HubField>
          <HubField id="nc-value" label={CLIP_COPY.checkValue}>{(a) => <input {...a} className="mono" spellCheck={false} value={value} onChange={(e) => setValue(e.target.value)} />}</HubField>
          <HubField id="nc-op" label={CLIP_COPY.op}>{(a) => <input {...a} className="mono" list="clip-ops" value={op} onChange={(e) => setOp(e.target.value)} />}</HubField>
          <HubField id="nc-target" label={CLIP_COPY.target}>{(a) => <input {...a} className="mono" value={target} onChange={(e) => setTarget(e.target.value)} />}</HubField>
          {ops}
        </>}
      <button className="primary small-button" disabled={busy || !ready} onClick={add}>{CLIP_COPY.addCheck}</button>
    </>
  );
}

function ClipSettings({ clip, busy, onEdit, onSelect }: { clip: Clip; busy: boolean; onEdit: (ops: ClipOp[], then?: (changed: string[]) => ClipSel) => Promise<void>; onSelect: (s: ClipSel) => void }) {
  const [action, setAction] = useState("");
  const [type, setType] = useState<ClipTrackType>("bool");
  const [evAt, setEvAt] = useState("0");
  const [evDo, setEvDo] = useState("");
  const [evError, setEvError] = useState<string | undefined>();
  const rate = clipRate(clip);
  return (
    <>
      <NumField id="cs-rate" label={CLIP_COPY.rate} value={rate} min={1} onCommit={(v) => void onEdit([{ op: "set_clip", rate: v }])} />
      <NumField id="cs-length" label={CLIP_COPY.clipLength} value={clip.length ?? 0} onCommit={(v) => void onEdit([{ op: "set_clip", length: v }])} />
      <div className="hub-clip-add">
        <HubField id="cs-action" label={CLIP_COPY.trackAction}>{(a) => <input {...a} className="mono" spellCheck={false} placeholder="/Game/Input/IA_Jump" value={action} onChange={(e) => setAction(e.target.value)} />}</HubField>
        <HubField id="cs-type" label={CLIP_COPY.trackType}>{(a) => <select {...a} value={type} onChange={(e) => setType(e.target.value as ClipTrackType)}>{TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select>}</HubField>
        <button className="small-button" disabled={busy || !action.startsWith("/")} onClick={() => void onEdit([{ op: "add", kind: "track", action: action.trim(), type }], () => { setAction(""); return null; })}>{CLIP_COPY.addTrack}</button>
      </div>
      <div className="hub-clip-add">
        <button className="small-button" disabled={busy} onClick={() => void onEdit([{ op: "add", kind: "region", name: CLIP_COPY.newRegion((clip.regions?.length ?? 0) + 1), start: 0, end: rate }], (c) => (c[0] ? { kind: "region", id: c[0] } : null))}>{CLIP_COPY.addRegion}</button>
        <button className="small-button" disabled={busy} onClick={() => onSelect({ kind: "newCheck", start: 0, length: 0 })}>{CLIP_COPY.addCheck}</button>
      </div>
      <div className="hub-clip-add">
        <HubField id="cs-ev-at" label={`${CLIP_COPY.time} (${CLIP_COPY.frames})`}>{(a) => <input {...a} inputMode="decimal" value={evAt} onChange={(e) => setEvAt(e.target.value)} />}</HubField>
        <HubField id="cs-ev-do" label={CLIP_COPY.eventDo} error={evError}>{(a) => <input {...a} className="mono" spellCheck={false} placeholder='{"console":"stat fps"}' value={evDo} onChange={(e) => { setEvDo(e.target.value); setEvError(undefined); }} />}</HubField>
        <button className="small-button" disabled={busy || !evDo.trim()} onClick={() => {
          const d = jsonOf(evDo);
          if (d === undefined) return setEvError(CLIP_COPY.badJson);
          void onEdit([{ op: "add", kind: "event", at: Number(evAt) || 0, do: d }], (c) => { setEvDo(""); return c[0] ? { kind: "event", id: c[0] } : null; });
        }}>{CLIP_COPY.addEvent}</button>
      </div>
    </>
  );
}

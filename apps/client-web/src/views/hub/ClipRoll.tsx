/**
 * A player clip as a piano roll: one row per Input Action lane, its notes as
 * bars and its curve keys as marks on a time grid at the clip's rate. A clip has no checks: those live on an
 * arrangement's Checks track. Drag a note or a mark to move it, its edge to
 * change a note's length, double-click an input row to add a note, and
 * Delete removes the selection. Edits save in the background.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Clip } from "ue-mcp/daemon";
import {
  ARRANGE_DEFAULT_ZOOM,
  HUB_COPY,
  addNote,
  arrangeClock,
  arrangeStep,
  clipEnd,
  refusalFindings,
  removeEvent,
  rollRows,
  rulerEvery,
  rulerFrames,
  rulerMinor,
  rulerTicks,
  setNote,
  setPoint,
  snapTo,
  zoomStep,
} from "@ue-mcp-studio/client-core";
import { api } from "../../api";
import { useHub } from "./state";
import { Block } from "./Arrangement";
import { HubIcon, Placeholder, RouteLink } from "./parts";

const HEAD = 150;
const ROW = 34;

export function ClipScreen({ id, from }: { id: string; from: string | null }) {
  const { notify, data } = useHub();
  const [clip, setClip] = useState<Clip | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(ARRANGE_DEFAULT_ZOOM * 2);
  const [sel, setSel] = useState<{ row: string; id: string } | null>(null);
  const [state, setState] = useState<"saved" | "saving">("saved");
  const cur = useRef<Clip | null>(null);
  const saved = useRef<Clip | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    api.hub.clip(id).then((c) => {
      cur.current = c;
      saved.current = c;
      setClip(c);
    }, (e: Error) => setError(e.message));
  }, [id]);

  const flush = async () => {
    timer.current = null;
    if (!cur.current) return;
    try {
      const c = await api.hub.putClip(cur.current);
      saved.current = c;
      if (!timer.current) {
        cur.current = c;
        setClip(c);
        setState("saved");
      }
      data.reload();
    } catch (e) {
      const f = refusalFindings((e as { body?: unknown }).body);
      notify(f[0]?.message ?? (e as Error).message, "bad");
      cur.current = saved.current;
      setClip(saved.current);
      setState("saved");
    }
  };
  const edit = (f: (c: Clip) => Clip) => {
    if (!cur.current) return;
    cur.current = f(cur.current);
    setClip(cur.current);
    setState("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 250);
  };
  useEffect(() => () => {
    if (timer.current) {
      clearTimeout(timer.current);
      void flush();
    }
  }, []);

  if (error) return <div className="hub-screen"><div className="banner bad" role="alert">{error}</div></div>;
  if (!clip) return <div className="hub-screen"><Placeholder rows={6} /></div>;
  const rate = clip.rate;
  const rows = rollRows(clip);
  const frames = rulerFrames(clipEnd(clip), rate);
  const px = (f: number) => (f / rate) * zoom;
  const toFrame = (x: number) => (x / zoom) * rate;
  const width = px(frames);
  const step = Math.max(1, Math.round(arrangeStep(rate) / 3));
  const remove = () => {
    if (!sel) return;
    edit((c) => removeEvent(c, sel.row, sel.id));
    setSel(null);
  };

  return (
    <div className="hub-screen hub-set hub-roll" onKeyDown={(e) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT") return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        remove();
      }
    }}>
      <header className="hub-head compact">
        <div className="hub-head-text">
          {from ? (
            <RouteLink className="hub-back small" to={{ screen: "arrangement", id: from }} aria-label={HUB_COPY.clipBack} title={HUB_COPY.clipBack}><HubIcon name="back" size={12} /></RouteLink>
          ) : (
            <RouteLink className="hub-back small" to={{ screen: "arrangements" }} aria-label={HUB_COPY.arrangements} title={HUB_COPY.arrangements}><HubIcon name="back" size={12} /></RouteLink>
          )}
          <input className="hub-set-name hub-set-title-input" aria-label="Clip title" defaultValue={clip.title} key={`${clip.id}:${clip.title}`} onBlur={(e) => e.target.value.trim() && e.target.value !== clip.title && edit((c) => ({ ...c, title: e.target.value.trim() }))} />
        </div>
        <div className="hub-head-actions hub-set-transport">
          <span className="hub-set-clock">{arrangeClock(clip.length, rate, true)}</span>
          <span className="dim small" role="status">{state === "saving" ? HUB_COPY.saving : HUB_COPY.clipSaved}</span>
          <span className="hub-set-zoom">
            <button className="ghost icon-button" aria-label="Zoom out" onClick={() => setZoom((z) => zoomStep(z, -1))}>-</button>
            <button className="ghost icon-button" aria-label="Zoom in" onClick={() => setZoom((z) => zoomStep(z, 1))}>+</button>
          </span>
        </div>
      </header>
      <div className="hub-set-surface" tabIndex={-1}>
        <div className="hub-set-scroll">
          <div className="hub-set-grid" style={{ width: HEAD + width, ["--major" as string]: `${rulerEvery(zoom) * zoom}px`, ["--minor" as string]: `${rulerMinor(zoom) * zoom}px` }}>
            <div className="hub-set-row ruler">
              <div className="hub-set-corner"><span className="dim small">{rows.length === 1 ? "1 lane" : `${rows.length} lanes`}</span></div>
              <div className="hub-set-ruler" style={{ width }}>
                <div className="hub-set-scale">
                  {rulerTicks(frames, rate, zoom).map((s) => <span key={s} className="hub-set-tick" style={{ left: s * zoom }}>{arrangeClock(s * rate, rate)}</span>)}
                </div>
                <span className="hub-roll-end" style={{ left: px(clip.length) }} title="Clip end" />
              </div>
            </div>
            <div className="hub-set-rows">
              {rows.length === 0 && <div className="hub-set-row spare last" style={{ height: ROW * 3 }}><div className="hub-set-head spare" /><div className="hub-set-lane spare" style={{ width }}><span className="hub-set-drop-hint">This clip has no lanes yet. Record a performance into it, or ask an agent to write them.</span></div></div>}
              {rows.map((r) => (
                <div key={r.key} className={`hub-set-row roll-${r.kind}`} style={{ height: ROW }}>
                  <div className="hub-set-head"><div className="hub-set-head-top"><span className="hub-set-title-text" title={r.label}>{r.label}</span></div></div>
                  <div className="hub-set-lane" style={{ width }} onDoubleClick={(e) => {
                    if (r.kind !== "input") return;
                    const at = snapTo(toFrame(e.clientX - e.currentTarget.getBoundingClientRect().left), step);
                    const added = addNote(clip, r.key, at, Math.max(1, Math.round(rate / 4)));
                    edit(() => added.clip);
                    setSel({ row: r.key, id: added.id });
                  }}>
                    {r.notes.map((n) => (
                      <Block
                        key={n.id}
                        className={`c-blue hub-roll-note ${sel?.row === r.key && sel.id === n.id ? "on" : ""}`}
                        left={px(n.start)} width={Math.max(px(n.length), 4)}
                        label={arrangeClock(n.start, rate, true)}
                        resizable
                        onSelect={() => setSel({ row: r.key, id: n.id })}
                        onCommit={(dx, _dy, mode) => {
                          const df = snapTo(toFrame(Math.abs(dx)), step) * Math.sign(dx);
                          if (mode === "end") edit((c) => setNote(c, r.key, n.id, n.start, n.length + df));
                          else if (mode === "start") edit((c) => setNote(c, r.key, n.id, n.start + df, n.length - df));
                          else edit((c) => setNote(c, r.key, n.id, n.start + df, n.length));
                        }}
                      />
                    ))}
                    {r.points.map((p) => (
                      <Mark key={p.id} left={px(p.t)} label={p.label} on={sel?.row === r.key && sel.id === p.id}
                        onSelect={() => setSel({ row: r.key, id: p.id })}
                        onCommit={(dx) => edit((c) => setPoint(c, r.key, p.id, snapTo(p.t + toFrame(dx), step)))} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <footer className="hub-set-foot">
        <div className="hub-set-foot-bar">
          <span className="hub-set-inspector dim small hub-set-foot-hint">Double-click an input lane to add a note. Delete removes the selection. Checks belong on an arrangement's Checks track.</span>
        </div>
      </footer>
    </div>
  );
}

/** A curve key: a diamond that drags along its lane. */
function Mark({ left, label, on, onSelect, onCommit }: { left: number; label: string; on: boolean; onSelect: () => void; onCommit: (dx: number) => void }) {
  const el = useRef<HTMLSpanElement>(null);
  const down = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    onSelect();
    const node = el.current;
    if (!node) return;
    const x0 = e.clientX;
    let dx = 0;
    const move = (ev: PointerEvent) => {
      dx = ev.clientX - x0;
      node.style.transform = `translateX(${dx}px) rotate(45deg)`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      node.style.transform = "";
      if (Math.abs(dx) > 2) onCommit(dx);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return <span ref={el} className={`hub-roll-mark ${on ? "on" : ""}`} style={{ left }} title={label} role="button" tabIndex={0} aria-label={label} onPointerDown={down} />;
}

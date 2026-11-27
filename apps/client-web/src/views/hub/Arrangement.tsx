/**
 * The Arrangement, laid out as a DAW's arrangement view: a one-line
 * transport, then the timelines filling the page (the ruler, the named
 * regions, one row per track with its clip instances, at least MIN_ROWS rows,
 * and the Checks track), then a footer with the selection's inspector and the
 * Clips drawer.
 *
 * Edits apply on the page at once and are saved in the background; a save the
 * daemon refuses puts the last saved arrangement back and says why. A drag
 * moves the element itself each frame and commits once, on release.
 *
 * Run feedback: the latest run of this arrangement (or the one the address
 * names) colours each check by its result, draws the playhead while it runs,
 * and holds a bar for every manual check that waits for a verdict.
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { Arrangement, ArrangementView, Check, CheckMode, PerformerCandidate, Performer, RunRecord, Track } from "ue-mcp/daemon";
import { CHECK_MODES, performerKey, performerLabel, runEnded } from "ue-mcp/hub";
import {
  ARRANGE_DEFAULT_ZOOM,
  CHECK_MODE_HELP,
  CHECK_MODE_LABEL,
  CHECK_MODE_MARK,
  CHECK_STATUS_LOOK,
  EXPECT_OPS,
  HUB_COPY,
  MIN_ROWS,
  PERFORMER_KIND_LABEL,
  RUN_STATE_LOOK,
  addCheck,
  addInstance,
  addRegion,
  addTrack,
  arrangeClock,
  arrangeStep,
  arrangementRun,
  awaitingVerdicts,
  checkResults,
  checkSummary,
  clampZoom,
  clipFits,
  instanceFits,
  instanceSpan,
  moveInstance,
  moveTrack,
  refusalFindings,
  regionFits,
  removeCheck,
  removeInstance,
  removeRegion,
  removeTrack,
  rulerEvery,
  rulerFrames,
  rulerMinor,
  rulerTicks,
  runTally,
  setTrack,
  shortAgo,
  snapTo,
  expectTargetOf,
  trackWarnings,
  updateCheck,
  updateRegion,
  zoomStep,
  zoomToFit,
  type ClipSpan,
} from "@ue-mcp-studio/client-core";
import { api } from "../../api";
import { useHub } from "./state";
import { HubIcon, Placeholder, RouteLink, StatusMark, StatusPill } from "./parts";

const HEAD = 150;
const ROW = 46;

type Selection = { kind: "instance"; id: string } | { kind: "check"; id: string } | { kind: "region"; id: string } | { kind: "track"; id: string } | null;

/** The arrangement on show and its save loop: edits apply at once, saves go one at a time, a refusal restores the last saved. */
function useArrangement(id: string) {
  const { data, notify } = useHub();
  const [view, setView] = useState<ArrangementView | null>(null);
  const [draft, setDraft] = useState<Arrangement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cur = useRef<Arrangement | null>(null);
  const saved = useRef<Arrangement | null>(null);
  const dirty = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const take = (v: ArrangementView) => {
    setView(v);
    saved.current = v.arrangement;
    if (dirty.current === 0) {
      cur.current = v.arrangement;
      setDraft(v.arrangement);
    }
  };
  // Read again whenever the overview is, unless an edit is still on its way.
  useEffect(() => {
    if (dirty.current > 0) return;
    api.hub.arrangement(id).then(take, (e: Error) => setError(e.message));
  }, [id, data.version]);

  const flush = async () => {
    timer.current = null;
    const a = cur.current;
    if (!a) return;
    const mark = dirty.current;
    try {
      const v = await api.hub.putArrangement(a);
      if (dirty.current === mark) dirty.current = 0;
      take(v);
    } catch (e) {
      dirty.current = 0;
      const f = refusalFindings((e as { body?: unknown }).body);
      notify(f[0]?.message ?? (e as Error).message, "bad");
      if (saved.current) {
        cur.current = saved.current;
        setDraft(saved.current);
      }
    }
  };
  const edit = (f: (a: Arrangement) => Arrangement) => {
    if (!cur.current) return;
    const next = f(cur.current);
    if (next === cur.current) return;
    cur.current = next;
    dirty.current++;
    setDraft(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 200);
  };
  useEffect(() => () => {
    if (timer.current) {
      clearTimeout(timer.current);
      void flush();
    }
  }, []);
  return { view, draft, error, edit };
}

export function ArrangementScreen({ id, runId }: { id: string; runId: string | null }) {
  const hub = useHub();
  const { o, run, notify, narrow } = hub;
  const { view, draft, error, edit } = useArrangement(id);
  const [zoom, setZoom] = useState(ARRANGE_DEFAULT_ZOOM);
  const [sel, setSel] = useState<Selection>(null);
  const [drawer, setDrawer] = useState(true);
  const [performers, setPerformers] = useState<PerformerCandidate[]>([]);
  const scroll = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.hub.performers(id).then((p) => setPerformers(p.performers), () => setPerformers([]));
  }, [id]);

  const spans = useMemo(() => {
    const m: Record<string, ClipSpan & { title: string; performer: string }> = {};
    for (const c of o.clips) m[c.id] = c;
    for (const c of Object.values(view?.clips ?? {})) m[c.id] = c;
    return m;
  }, [o.clips, view?.clips]);

  const latest = arrangementRun(o.recent, id, runId);
  const results = checkResults(latest);
  const live = latest && !runEnded(latest.state) ? latest : null;

  if (error && !draft) return <div className="hub-screen"><div className="banner bad" role="alert">{error}</div></div>;
  if (!draft || !view) return <div className="hub-screen"><Placeholder rows={6} /></div>;
  const a = draft;
  const rate = a.rate;
  const end = Math.max(view.length, ...a.tracks.flatMap((t) => t.instances.map((i) => instanceSpan(i, spans, rate).end)), ...a.checks.map((c) => c.at + c.length), ...a.regions.map((r) => r.end));
  const frames = rulerFrames(end, rate);
  const px = (f: number) => (f / rate) * zoom;
  const toFrame = (x: number) => (x / zoom) * rate;
  const width = px(frames);
  const step = arrangeStep(rate);
  const waiting = awaitingVerdicts(live, a.checks);
  const blocking = view.findings.filter((f) => f.blocks);
  const fit = () => setZoom(zoomToFit(0, Math.max(end, rate * 5), rate, (scroll.current?.clientWidth ?? 800) - HEAD - 24));

  const performerOptions = (t: Track) => {
    const list = performers.some((p) => performerKey(p.performer) === performerKey(t.performer)) ? performers : [{ performer: t.performer, label: performerLabel(t.performer), capabilities: [] }, ...performers];
    return list;
  };
  const newTrack = () => {
    const p: Performer = performers[0]?.performer ?? { kind: "player", client: 0 };
    edit((x) => addTrack(x, p, performerLabel(p)));
  };

  const spare = Math.max(0, MIN_ROWS - a.tracks.length);
  const selected = sel;
  const remove = () => {
    if (!selected) return;
    if (selected.kind === "instance") edit((x) => removeInstance(x, selected.id));
    else if (selected.kind === "check") edit((x) => removeCheck(x, selected.id));
    else if (selected.kind === "region") edit((x) => removeRegion(x, selected.id));
    else edit((x) => removeTrack(x, selected.id));
    setSel(null);
  };

  return (
    <div
      className="hub-screen hub-set"
      onKeyDown={(e) => {
        const t = e.target as HTMLElement;
        if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT") return;
        if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          remove();
        } else if (e.key === "Escape") setSel(null);
      }}
    >
      <header className="hub-head compact">
        <div className="hub-head-text">
          <RouteLink className="hub-back small" to={{ screen: "arrangements" }} aria-label={HUB_COPY.arrangements} title={HUB_COPY.arrangements}><HubIcon name="back" size={12} /></RouteLink>
          <input className="hub-set-name hub-set-title-input" aria-label="Arrangement title" defaultValue={a.title} key={`${a.id}:${a.title}`} onBlur={(e) => e.target.value.trim() && e.target.value !== a.title && edit((x) => ({ ...x, title: e.target.value.trim() }))} />
        </div>
        <div className="hub-head-actions hub-set-transport">
          {live ? (
            <button className="small-button hub-set-transport-btn on" onClick={() => api.hub.stopRun(live.runId).catch((e: Error) => notify(e.message, "bad"))}><HubIcon name="stop" />{HUB_COPY.stop}</button>
          ) : (
            <button className="small-button primary hub-set-transport-btn" disabled={!a.checks.length} title={a.checks.length ? undefined : "Add a check to run it"} onClick={() => void run({ test: a.id }, a.title)}><HubIcon name="play" />{HUB_COPY.play}</button>
          )}
          <span className="hub-set-clock" aria-label="Position">{arrangeClock(live?.frame ?? 0, rate, true)}</span>
          <span className="muted small hub-set-level" title={a.level ?? HUB_COPY.openLevel}>{a.level ? a.level.split("/").pop() : HUB_COPY.openLevel}</span>
          {blocking.length > 0 && <Findings findings={blocking.map((f) => f.message)} />}
          <span className="hub-set-zoom">
            <button className="ghost icon-button" aria-label="Zoom out" onClick={() => setZoom((z) => zoomStep(z, -1))}>-</button>
            <button className="ghost icon-button" aria-label="Zoom in" onClick={() => setZoom((z) => zoomStep(z, 1))}>+</button>
            <button className="ghost icon-button" aria-label="Fit" title="Fit" onClick={fit}><HubIcon name="fit" /></button>
          </span>
        </div>
      </header>

      {latest && <RunLine run={latest} />}
      {waiting.length > 0 && (
        <div className="hub-set-verdicts">
          {waiting.map((c) => <VerdictLine key={c.id} run={latest!} check={c} />)}
        </div>
      )}

      <div className="hub-set-surface" tabIndex={-1}>
        <div className="hub-set-scroll" ref={scroll} onWheel={(e) => {
          if (!e.ctrlKey) return;
          e.preventDefault();
          setZoom((z) => clampZoom(z * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
        }}>
          <div className="hub-set-grid" style={{ width: HEAD + width, ["--major" as string]: `${rulerEvery(zoom) * zoom}px`, ["--minor" as string]: `${rulerMinor(zoom) * zoom}px` }}>
            <div className="hub-set-row ruler">
              <div className="hub-set-corner">
                <button className="ghost hub-set-add-track" onClick={newTrack}><HubIcon name="plus" size={12} />{HUB_COPY.addTrack}</button>
              </div>
              <div className="hub-set-ruler" style={{ width }}>
                <div className="hub-set-scale">
                  {rulerTicks(frames, rate, zoom).map((s) => <span key={s} className="hub-set-tick" style={{ left: s * zoom }}>{arrangeClock(s * rate, rate)}</span>)}
                </div>
              </div>
            </div>

            <div className="hub-set-row regions">
              <div className="hub-set-head fixed">
                <div className="hub-set-head-top"><span className="hub-set-title-text">{HUB_COPY.regions}</span></div>
                <div className="hub-set-head-ctl">
                  <button className="ghost hub-set-add-track" onClick={() => {
                    const start = snapTo(a.regions.reduce((m, r) => Math.max(m, r.end), 0), step);
                    const r = addRegion(a, start, start + rate * 5);
                    edit(() => r.arrangement);
                    setSel({ kind: "region", id: r.id });
                  }}><HubIcon name="plus" size={12} />{HUB_COPY.addRegion}</button>
                </div>
              </div>
              <div className="hub-set-lane" style={{ width }}>
                {a.regions.map((r) => (
                  <Block
                    key={r.id}
                    className={`hub-set-region ${selected?.kind === "region" && selected.id === r.id ? "on" : ""}`}
                    left={px(r.start)} width={px(r.end - r.start)}
                    label={r.name}
                    resizable
                    onSelect={() => setSel({ kind: "region", id: r.id })}
                    onCommit={(dx, _dy, mode) => {
                      const df = snapTo(toFrame(Math.abs(dx)), step) * Math.sign(dx);
                      const start = mode === "end" ? r.start : Math.max(0, r.start + df);
                      const stop = mode === "start" ? r.end : mode === "end" ? Math.max(r.start + step, r.end + df) : r.end + (start - r.start);
                      if (regionFits(a, start, stop, r.id)) edit((x) => updateRegion(x, r.id, { start, end: stop }));
                    }}
                  />
                ))}
              </div>
            </div>

            <div className="hub-set-rows">
              {a.tracks.map((t, ti) => {
                const warn = trackWarnings({ arrangement: a, findings: view.findings }, t.id);
                const on = selected?.kind === "track" && selected.id === t.id;
                return (
                  <div key={t.id} className={`hub-set-row ${t.mute ? "muted" : ""} ${on ? "on" : ""}`} data-track={t.id} style={{ height: ROW }}>
                    <div className={`hub-set-head ${on ? "on" : ""}`} onClick={() => setSel({ kind: "track", id: t.id })}>
                      <div className="hub-set-head-top">
                        <button className="hub-set-title" title={t.title}><span className="hub-set-title-text">{t.title}</span></button>
                        {warn.length > 0 && <span className="hub-set-warn" title={warn.map((w) => w.message).join("\n")}><HubIcon name="warn" size={12} /></span>}
                      </div>
                      <div className="hub-set-head-ctl" onClick={(e) => e.stopPropagation()}>
                        <button className={`hub-set-toggle mute ${t.mute ? "on" : ""}`} aria-pressed={t.mute} title="Mute" onClick={() => edit((x) => setTrack(x, t.id, { mute: !t.mute }))}>M</button>
                        <button className={`hub-set-toggle solo ${t.solo ? "on" : ""}`} aria-pressed={t.solo} title="Solo" onClick={() => edit((x) => setTrack(x, t.id, { solo: !t.solo }))}>S</button>
                        <select className="hub-set-io hub-set-performer-select" aria-label={`${t.title} performer`} title={performerLabel(t.performer)} value={performerKey(t.performer)} onChange={(e) => {
                          const p = performerOptions(t).find((c) => performerKey(c.performer) === e.target.value);
                          if (p) edit((x) => setTrack(x, t.id, { performer: p.performer }));
                        }}>
                          {performerOptions(t).map((p) => <option key={performerKey(p.performer)} value={performerKey(p.performer)}>{p.label}</option>)}
                        </select>
                      </div>
                    </div>
                    <Lane width={width} onDropClip={(clip, x) => {
                      const c = spans[clip];
                      if (!c) return;
                      if (!clipFits(c as { performer: Track["performer"]["kind"] }, t)) return notify(`${c.title} is a ${c.performer} clip, and ${t.title} drives ${performerLabel(t.performer)}`, "bad");
                      const at = snapTo(toFrame(x), step);
                      if (!instanceFits(t, spans, rate, clip, at)) return notify("That spot overlaps another clip on this track", "bad");
                      const r = addInstance(a, t.id, clip, at);
                      edit(() => r.arrangement);
                      setSel({ kind: "instance", id: r.id });
                    }}>
                      {t.instances.map((i) => {
                        const s = instanceSpan(i, spans, rate);
                        const c = spans[i.clip];
                        return (
                          <Block
                            key={i.id}
                            className={`c-${PALETTE[ti % PALETTE.length]} ${c ? "" : "unknown"} ${selected?.kind === "instance" && selected.id === i.id ? "on" : ""}`}
                            left={px(s.start)} width={px(s.end - s.start)}
                            label={c?.title ?? i.clip}
                            rowHeight={ROW}
                            onSelect={() => setSel({ kind: "instance", id: i.id })}
                            onOpen={() => hub.go({ screen: "clip", id: i.clip, from: a.id })}
                            onCommit={(dx, dy) => {
                              const at = snapTo(Math.max(0, i.at + toFrame(dx)), step);
                              const to = a.tracks[Math.max(0, Math.min(a.tracks.length - 1, ti + Math.round(dy / ROW)))]!;
                              if (to.id !== t.id && c && !clipFits(c as { performer: Track["performer"]["kind"] }, to)) return notify(`${c.title} does not suit ${to.title}`, "bad");
                              if (!instanceFits(to, spans, rate, i.clip, at, i.id)) return notify("That spot overlaps another clip on this track", "bad");
                              edit((x) => moveInstance(x, i.id, at, to.id));
                            }}
                          />
                        );
                      })}
                      {t.instances.length === 0 && <span className="hub-set-drop-hint">{HUB_COPY.dropHint}</span>}
                    </Lane>
                  </div>
                );
              })}
              {Array.from({ length: spare }, (_, i) => (
                <div key={`spare${i}`} className={`hub-set-row spare ${i === spare - 1 ? "last" : ""}`} style={{ height: ROW }}>
                  <div className="hub-set-head spare" />
                  <div className="hub-set-lane spare" style={{ width }} />
                </div>
              ))}
            </div>

            <div className="hub-set-row checks">
              <div className="hub-set-head fixed">
                <div className="hub-set-head-top"><span className="hub-set-title-text">{HUB_COPY.checks}</span></div>
                <div className="hub-set-head-ctl">
                  <select className="hub-set-io hub-set-add-check" aria-label={HUB_COPY.addCheck} value="" onChange={(e) => {
                    const mode = e.target.value as CheckMode;
                    if (!mode) return;
                    const at = snapTo(a.checks.reduce((m, c) => Math.max(m, c.at + c.length), 0), step);
                    const r = addCheck(a, at, mode, mode === "manual" ? 0 : rate * 2);
                    edit(() => r.arrangement);
                    setSel({ kind: "check", id: r.id });
                  }}>
                    <option value="">{HUB_COPY.addCheck}</option>
                    {CHECK_MODES.map((m) => <option key={m} value={m}>{CHECK_MODE_LABEL[m]}</option>)}
                  </select>
                </div>
              </div>
              <div className="hub-set-lane" style={{ width }}>
                {a.checks.map((c) => {
                  const r = results[c.id];
                  return (
                    <Block
                      key={c.id}
                      className={`hub-set-check mode-${c.mode} ${r ? `st-${r.status}` : ""} ${selected?.kind === "check" && selected.id === c.id ? "on" : ""}`}
                      left={px(c.at)} width={Math.max(px(c.length), 18)}
                      label={c.title}
                      mark={CHECK_MODE_MARK[c.mode]}
                      title={`${CHECK_MODE_LABEL[c.mode]}: ${checkSummary(c)}${r ? `\n${CHECK_STATUS_LOOK[r.status].label}${r.message ? `: ${r.message}` : ""}` : ""}`}
                      resizable={c.mode !== "manual"}
                      onSelect={() => setSel({ kind: "check", id: c.id })}
                      onCommit={(dx, _dy, mode) => {
                        const df = snapTo(toFrame(Math.abs(dx)), step) * Math.sign(dx);
                        if (mode === "end") edit((x) => updateCheck(x, c.id, { length: Math.max(0, c.length + df) }));
                        else if (mode === "start") edit((x) => updateCheck(x, c.id, { at: Math.max(0, c.at + df), length: Math.max(0, c.length - df) }));
                        else edit((x) => updateCheck(x, c.id, { at: Math.max(0, c.at + df) }));
                      }}
                    />
                  );
                })}
              </div>
            </div>

            {live?.frame !== undefined && <div className="hub-set-overlay" style={{ left: HEAD, width }}><div className="hub-set-cursor" style={{ left: px(live.frame) }} /></div>}
          </div>
        </div>
      </div>

      <footer className="hub-set-foot">
        <div className="hub-set-foot-bar">
          <button className={`ghost hub-set-drawer-toggle ${drawer ? "on" : ""}`} aria-expanded={drawer} onClick={() => setDrawer((d) => !d)}>{HUB_COPY.clips}</button>
          <span className="hub-set-foot-div" />
          <Inspector a={a} sel={selected} results={results} run={latest} spans={spans} edit={edit} onRemove={remove} onMoveTrack={(tid, by) => edit((x) => moveTrack(x, tid, x.tracks.findIndex((t) => t.id === tid) + by))} />
        </div>
        {drawer && <ClipDrawer narrow={narrow} />}
      </footer>
    </div>
  );
}

const PALETTE = ["blue", "teal", "orange", "violet", "green", "pink", "yellow", "cyan"] as const;

/** A lane that takes clips dragged from the drawer. */
function Lane({ width, children, onDropClip }: { width: number; children: ReactNode; onDropClip: (clip: string, x: number) => void }) {
  return (
    <div
      className="hub-set-lane"
      style={{ width }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(CLIP_MIME)) e.preventDefault();
      }}
      onDrop={(e) => {
        const clip = e.dataTransfer.getData(CLIP_MIME);
        if (!clip) return;
        e.preventDefault();
        onDropClip(clip, e.clientX - e.currentTarget.getBoundingClientRect().left);
      }}
    >
      {children}
    </div>
  );
}

const CLIP_MIME = "application/x-ue-mcp-clip";

/**
 * A block on a lane: a clip instance, a check note or a region. A drag writes
 * its transform itself each frame and commits once, on release, so nothing
 * re-renders while it moves. Its edges resize when `resizable`.
 */
export function Block({ className, left, width, label, mark, title, rowHeight, resizable, onSelect, onOpen, onCommit }: {
  className: string;
  left: number;
  width: number;
  label: string;
  mark?: string;
  title?: string;
  rowHeight?: number;
  resizable?: boolean;
  onSelect: () => void;
  onOpen?: () => void;
  onCommit: (dx: number, dy: number, mode: "move" | "start" | "end") => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const begin = (e: ReactPointerEvent, mode: "move" | "start" | "end") => {
    if (e.button !== 0) return;
    e.stopPropagation();
    onSelect();
    const node = el.current;
    if (!node) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let dx = 0;
    let dy = 0;
    let frame = 0;
    node.setPointerCapture?.(e.pointerId);
    node.setAttribute("data-dragging", "");
    const paint = () => {
      frame = 0;
      if (mode === "move") node.style.transform = `translate(${dx}px, ${rowHeight ? Math.round(dy / rowHeight) * rowHeight : 0}px)`;
      else if (mode === "end") node.style.width = `${Math.max(6, width + dx)}px`;
      else {
        node.style.transform = `translateX(${Math.min(dx, width - 6)}px)`;
        node.style.width = `${Math.max(6, width - dx)}px`;
      }
    };
    const move = (ev: PointerEvent) => {
      dx = ev.clientX - x0;
      dy = ev.clientY - y0;
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (frame) cancelAnimationFrame(frame);
      node.removeAttribute("data-dragging");
      node.style.transform = "";
      node.style.width = "";
      if (Math.abs(dx) > 2 || Math.abs(dy) > 4) onCommit(dx, dy, mode);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div
      ref={el}
      className={`hub-set-block ${width < 40 ? "thin" : ""} ${className}`}
      style={{ left, width }}
      title={title ?? label}
      tabIndex={0}
      role="button"
      aria-label={label}
      onPointerDown={(e) => begin(e, "move")}
      onDoubleClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen ? onOpen() : onSelect();
      }}
    >
      <div className="hub-set-block-head">
        {mark && <span className="hub-set-block-mark">{mark}</span>}
        <span className="hub-set-block-name">{label}</span>
      </div>
      <div className="hub-set-block-body" />
      {resizable && <span className="hub-set-edge start" onPointerDown={(e) => begin(e, "start")} />}
      {resizable && <span className="hub-set-edge end" onPointerDown={(e) => begin(e, "end")} />}
    </div>
  );
}

/** The problems that stop the arrangement from saving cleanly or running, behind one button. */
function Findings({ findings }: { findings: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="hub-set-pop-anchor">
      <button className="hub-set-warnings bad" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{HUB_COPY.findings(findings.length)}</button>
      {open && (
        <div className="hub-set-pop warnings" role="dialog" aria-label={HUB_COPY.findings(findings.length)}>
          <ul>{findings.map((f, i) => <li key={i} className="bad"><HubIcon name="warn" size={12} /><span className="hub-set-pop-text">{f}</span></li>)}</ul>
        </div>
      )}
    </span>
  );
}

/** The run the Arrangement shows: its state, its checks tallied, when it started, and the region it played. */
function RunLine({ run }: { run: RunRecord }) {
  const t = runTally(run);
  const region = run.test.includes(":") ? run.test.split(":")[1] : null;
  return (
    <div className="hub-set-run" role="status">
      <StatusPill look={RUN_STATE_LOOK[run.state]} />
      <span className="muted small">{t.passed} of {t.total} checks passed{t.failed ? `, ${t.failed} failed` : ""}</span>
      {region && <span className="muted small">Region {region}</span>}
      <span className="dim small">{shortAgo(run.startedAt)}</span>
      {run.error && <span className="hub-bad-text small">{run.error}</span>}
    </div>
  );
}

/** A manual check waiting for a verdict: what to look at, Pass, and Fail with an optional note. */
function VerdictLine({ run, check }: { run: RunRecord; check: Check }) {
  const { notify } = useHub();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const give = (v: "pass" | "fail") => {
    setBusy(true);
    api.hub.verdict(run.runId, check.id, v, note.trim() || undefined).catch((e: Error) => notify(e.message, "bad")).finally(() => setBusy(false));
  };
  return (
    <div className="hub-set-verdict" role="region" aria-label={`${HUB_COPY.waitingVerdict}: ${check.title}`}>
      <StatusMark look={CHECK_STATUS_LOOK.awaiting_verdict} />
      <strong>{check.title}</strong>
      <span className="hub-set-verdict-ask" title={check.instruction}>{check.instruction}</span>
      <input value={note} placeholder={HUB_COPY.verdictNote} aria-label={HUB_COPY.verdictNote} onChange={(e) => setNote(e.target.value)} />
      <button className="small-button verdict-pass" disabled={busy} onClick={() => give("pass")}>{HUB_COPY.pass}</button>
      <button className="small-button verdict-fail" disabled={busy} onClick={() => give("fail")}>{HUB_COPY.fail}</button>
    </div>
  );
}

/** The footer's inspector: the selection's own fields on one line. */
function Inspector({ a, sel, results, run, spans, edit, onRemove, onMoveTrack }: {
  a: Arrangement;
  sel: Selection;
  results: ReturnType<typeof checkResults>;
  run: RunRecord | null;
  spans: Record<string, ClipSpan & { title: string }>;
  edit: (f: (a: Arrangement) => Arrangement) => void;
  onRemove: () => void;
  onMoveTrack: (id: string, by: number) => void;
}) {
  const hub = useHub();
  const del = <button className="ghost icon-button" aria-label="Delete" title="Delete" onClick={onRemove}><HubIcon name="trash" /></button>;
  if (!sel) return <span className="hub-set-inspector dim small hub-set-foot-hint">Select a clip, check or region to edit it. Drag clips from the drawer onto a track.</span>;
  if (sel.kind === "instance") {
    const i = a.tracks.flatMap((t) => t.instances).find((x) => x.id === sel.id);
    if (!i) return null;
    return (
      <span className="hub-set-inspector">
        <strong className="small">{spans[i.clip]?.title ?? i.clip}</strong>
        <span className="muted small mono">{arrangeClock(i.at, a.rate, true)}</span>
        <RouteLink className="small-button" to={{ screen: "clip", id: i.clip, from: a.id }}><HubIcon name="edit" size={12} />Edit clip</RouteLink>
        {del}
      </span>
    );
  }
  if (sel.kind === "track") {
    const t = a.tracks.find((x) => x.id === sel.id);
    if (!t) return null;
    return (
      <span className="hub-set-inspector">
        <input className="hub-set-name" aria-label="Track name" defaultValue={t.title} key={`${t.id}:${t.title}`} onBlur={(e) => e.target.value.trim() && e.target.value !== t.title && edit((x) => setTrack(x, t.id, { title: e.target.value.trim() }))} />
        <span className="muted small">{PERFORMER_KIND_LABEL[t.performer.kind]}</span>
        <button className="ghost icon-button" aria-label="Move up" onClick={() => onMoveTrack(t.id, -1)}>↑</button>
        <button className="ghost icon-button" aria-label="Move down" onClick={() => onMoveTrack(t.id, 1)}>↓</button>
        {del}
      </span>
    );
  }
  if (sel.kind === "region") {
    const r = a.regions.find((x) => x.id === sel.id);
    if (!r) return null;
    return (
      <span className="hub-set-inspector">
        <input className="hub-set-name" aria-label="Region name" defaultValue={r.name} key={`${r.id}:${r.name}`} onBlur={(e) => e.target.value.trim() && e.target.value !== r.name && edit((x) => updateRegion(x, r.id, { name: e.target.value.trim() }))} />
        <span className="muted small mono">{arrangeClock(r.start, a.rate, true)} to {arrangeClock(r.end, a.rate, true)}</span>
        <button className="small-button" onClick={() => void hub.run({ test: `${a.id}:${r.id}` }, r.name)}><HubIcon name="play" size={12} />Run region</button>
        {del}
      </span>
    );
  }
  const c = a.checks.find((x) => x.id === sel.id);
  if (!c) return null;
  const r = results[c.id];
  return (
    <span className="hub-set-inspector">
      <input className="hub-set-name" aria-label="Check name" defaultValue={c.title} key={`${c.id}:${c.title}`} onBlur={(e) => e.target.value.trim() && e.target.value !== c.title && edit((x) => updateCheck(x, c.id, { title: e.target.value.trim() }))} />
      <select className="hub-set-io wide" aria-label="Mode" title={CHECK_MODE_HELP[c.mode]} value={c.mode} onChange={(e) => edit((x) => updateCheck(x, c.id, { mode: e.target.value as CheckMode }))}>
        {CHECK_MODES.map((m) => <option key={m} value={m}>{CHECK_MODE_LABEL[m]}</option>)}
      </select>
      {c.mode === "manual" ? (
        <>
          <input className="hub-set-name wide" aria-label="Instruction" defaultValue={c.instruction} key={`${c.id}:i:${c.instruction}`} onBlur={(e) => e.target.value.trim() && edit((x) => updateCheck(x, c.id, { instruction: e.target.value.trim() }))} />
          <label className="small hub-set-check-flag"><input type="checkbox" checked={c.personOnly === true} onChange={(e) => edit((x) => updateCheck(x, c.id, { personOnly: e.target.checked }))} />{HUB_COPY.personOnly}</label>
        </>
      ) : (
        <>
          <input className="hub-set-name" aria-label="Value" defaultValue={c.expect?.value} key={`${c.id}:v:${c.expect?.value}`} onBlur={(e) => e.target.value.trim() && edit((x) => updateCheck(x, c.id, { expect: { ...(c.expect ?? { op: "==" }), value: e.target.value.trim() } }))} />
          <select className="hub-set-io" aria-label="Operator" value={c.expect?.op ?? "=="} onChange={(e) => edit((x) => updateCheck(x, c.id, { expect: { ...(c.expect ?? { value: "pawn.alive" }), op: e.target.value } }))}>
            {EXPECT_OPS.map((op) => <option key={op} value={op}>{op}</option>)}
          </select>
          <input className="hub-set-name narrow" aria-label="Target" defaultValue={c.expect?.target === undefined ? "" : String(c.expect.target)} key={`${c.id}:t:${String(c.expect?.target)}`} onBlur={(e) => {
            const target = expectTargetOf(e.target.value);
            edit((x) => updateCheck(x, c.id, { expect: { ...(c.expect ?? { value: "pawn.alive", op: "==" }), ...(target === undefined ? { target: undefined } : { target }) } }));
          }} />
        </>
      )}
      {r && <StatusPill look={CHECK_STATUS_LOOK[r.status]}>{r.message ?? CHECK_STATUS_LOOK[r.status].label}</StatusPill>}
      {r?.status === "awaiting_verdict" && run && <VerdictButtons run={run} check={c} />}
      {del}
    </span>
  );
}

function VerdictButtons({ run, check }: { run: RunRecord; check: Check }) {
  const { notify } = useHub();
  const give = (v: "pass" | "fail") => api.hub.verdict(run.runId, check.id, v).catch((e: Error) => notify(e.message, "bad"));
  return (
    <>
      <button className="small-button verdict-pass" onClick={() => void give("pass")}>{HUB_COPY.pass}</button>
      <button className="small-button verdict-fail" onClick={() => void give("fail")}>{HUB_COPY.fail}</button>
    </>
  );
}

/** The Clips drawer: every clip, filtered by name, dragged onto a track. */
function ClipDrawer({ narrow }: { narrow: boolean }) {
  const { o } = useHub();
  const [q, setQ] = useState("");
  const shown = o.clips.filter((c) => !q || c.title.toLowerCase().includes(q.toLowerCase()) || c.id.includes(q.toLowerCase())).sort((a, b) => a.title.localeCompare(b.title));
  return (
    <div className="hub-set-drawer" style={{ height: narrow ? 200 : 168 }}>
      <div className="hub-set-browser in-drawer">
        <div className="hub-set-browser-find">
          <input type="search" placeholder="Find a clip" aria-label="Find a clip" value={q} onChange={(e) => setQ(e.target.value)} />
          <p className="hub-set-browser-hint dim small">Drag a clip onto a track whose performer it suits.</p>
        </div>
        <div className="hub-set-browser-list">
          {o.clips.length === 0 ? <p className="dim small">{HUB_COPY.noClips}</p> : (
            <ul className="hub-set-clips">
              {shown.map((c) => (
                <li key={c.id} className="hub-set-clip-row">
                  <span
                    className="hub-set-clip"
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(CLIP_MIME, c.id);
                      e.dataTransfer.effectAllowed = "copy";
                    }}
                    title={`${c.title}: ${PERFORMER_KIND_LABEL[c.performer]}, ${arrangeClock(c.length, c.rate, true)}`}
                  >
                    <span className="hub-set-clip-name">{c.title}</span>
                    <span className="hub-set-clip-meta dim small">{PERFORMER_KIND_LABEL[c.performer]} · {arrangeClock(c.length, c.rate, true)}</span>
                  </span>
                  <RouteLink className="hub-set-clip-act" to={{ screen: "clip", id: c.id }} aria-label={`Edit ${c.title}`} title={`Edit ${c.title}`}><HubIcon name="edit" size={12} /></RouteLink>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

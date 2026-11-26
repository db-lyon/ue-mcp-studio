/**
 * The Arrangement: every track as a timeline of clip instances under one
 * ruler, laid out as a DAW's arrangement view. A one-line transport sits
 * above the timelines, which take the rest of the page; Clips and the
 * selection's inspector sit in the footer below them, and Clips pops out
 * into a window of its own where Studio's window can host one. Play runs
 * every timeline from the playhead (or the loop range), honoring mute and
 * solo; a track's own play button runs just that. Every change is an op line
 * sent to POST /hub/set/edit, all or none, and the daemon's answer is what
 * is drawn. Runs color each block with its result and show a playhead while
 * they play. Every drag has a key. Scenes stay in the set but belong to the
 * Session view, so none of them shows here.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import {
  ARRANGE_DEFAULT_ZOOM,
  SET_COPY,
  SET_OPS,
  activeSetRun,
  arrangeClock,
  arrangeEnd,
  arrangeSeconds,
  arrangeStep,
  arrangementCursor,
  arrangementFindings,
  arrangementFromPlayhead,
  arrangementOn,
  awaitingChecks,
  candidateLines,
  clampZoom,
  clipScale,
  dragLines,
  emptySegmentLive,
  findingPlace,
  foldRun,
  foldSegmentEvents,
  nextName,
  refusalFindings,
  replaceLines,
  runFeedback,
  setResults,
  snapTo,
  stepSelection,
  zoomStep,
  zoomToFit,
  type SegmentLive,
} from "@ue-mcp-studio/client-core";
import {
  ARRANGEMENT_DEFAULT_RATE,
  HUB_COLORS,
  checkId,
  type ArrangementFinding,
  type ArrangementRun,
  type HubClipEntry,
  type InstanceKind,
  type SetAnswer,
  type SetRunScope,
} from "@ue-mcp-studio/shared";
import { ApiError, api } from "../../api";
import { useHub } from "./state";
import { Empty, HubIcon, Placeholder, ScreenHead } from "./parts";
import { Dialog } from "./dialogs";
import { ClipBrowser } from "./ClipBrowser";
import { HEAD_W, Timelines, type Loop, type Sel, type ViewCtx } from "./ArrangementGrid";
import { canPopOut, openSync, popOutClips, type ClipRef, type SyncMessage } from "./arrangement-sync";
import "./arrangement.css";

export { CLIP_MIME } from "./ClipBrowser";

const typing = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA");
};

/** Per-viewer conveniences: whether the Clips drawer is open, and its height. */
const DRAWER_KEY = "studio.arrangement.drawer";
const DRAWER_H_KEY = "studio.arrangement.drawerHeight";
const DRAWER_H = 220;
function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, v: string): void {
  try {
    window.localStorage.setItem(key, v);
  } catch {
    // Storage blocked: the drawer starts closed next time.
  }
}

/** The set, read again whenever the hub hears a change; edits answer with the whole set. */
function useSet(version: number, on: boolean) {
  const [set, setSet] = useState<SetAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!on) return;
    let live = true;
    api.set.read().then((a) => {
      if (!live) return;
      setSet(a);
      setError(null);
    }, (e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [version, on]);
  return { set, setSet, error };
}

/** The run playing now and the newest results: its detail, playhead and the checks waiting on a person. */
function useSetRun(mine: { planId: string; runId: string } | null) {
  const hub = useHub();
  const active = activeSetRun(hub.o, mine);
  const [detail, setDetail] = useState<ArrangementRun | null>(null);
  useEffect(() => {
    if (!active) {
      setDetail(null);
      return;
    }
    let live = true;
    api.set.runDetail(active.runId).then((d) => live && setDetail(d.arrangement ?? null), () => {});
    return () => {
      live = false;
    };
  }, [active?.runId, hub.data.version]);
  const segIds = useMemo(() => new Set((detail?.segments ?? []).map((s) => s.runId).filter((x): x is string => !!x)), [detail]);
  const [live, setLive] = useState<SegmentLive>(emptySegmentLive);
  const events = hub.events ?? [];
  const lastId = events.length ? events[events.length - 1].id : 0;
  useEffect(() => setLive((l) => foldSegmentEvents(l, events, segIds)), [lastId, segIds]);
  const base = useMemo(() => setResults(hub.o.recent), [hub.o.recent]);
  const target = (hub.o.queue.current?.scope as { goalId?: string } | undefined)?.goalId ?? "";
  const results = useMemo(() => (detail ? foldRun(base, detail, null, target, true) : base), [base, detail, target]);
  const cursor = active ? arrangementCursor(detail, live) : null;
  const awaiting = active ? awaitingChecks(detail) : [];
  return { active, detail, cursor, results, awaiting };
}

/** A popover closed by Escape or a press outside it and its opener. */
function usePopover(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    document.addEventListener("pointerdown", down);
    return () => document.removeEventListener("pointerdown", down);
  }, [open]);
  return ref;
}

export function ArrangementScreen() {
  const hub = useHub();
  const on = arrangementOn(hub.health);
  const { set, setSet, error } = useSet(hub.data.version, on);
  const [mine, setMine] = useState<{ planId: string; runId: string } | null>(null);
  const run = useSetRun(mine);
  const [refused, setRefused] = useState<{ lines: string[]; findings: ArrangementFinding[] } | null>(null);
  const [sel, setSel] = useState<Sel>(null);
  const [copied, setCopied] = useState<{ track: string; id: string } | null>(null);
  const [picked, setPicked] = useState<ClipRef | null>(null);
  const [zoom, setZoom] = useState<number>(ARRANGE_DEFAULT_ZOOM);
  const [playhead, setPlayhead] = useState(0);
  const [loop, setLoop] = useState<Loop | null>(null);
  const [loopOn, setLoopOn] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(() => readStored(DRAWER_KEY) === "open");
  const [drawerH, setDrawerH] = useState(() => Number(readStored(DRAWER_H_KEY)) || DRAWER_H);
  const [popped, setPopped] = useState(false);
  const [warnOpen, setWarnOpen] = useState(false);
  const [warnAt, setWarnAt] = useState<string | null>(null);
  const [keysOpen, setKeysOpen] = useState(false);
  const [renameAsk, setRenameAsk] = useState(0);
  const [answers, setAnswers] = useState(0);
  const nameBox = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const popup = useRef<Window | null>(null);
  /** Where to scroll once a new zoom is drawn: this frame at this many pixels from the lanes' left edge. */
  const anchor = useRef<{ frame: number; x: number } | null>(null);
  const zoomBack = useRef<Array<{ zoom: number; left: number }>>([]);
  const restarting = useRef(false);
  const loopTick = useRef<() => void>(() => {});
  const warnRef = usePopover(warnOpen, () => setWarnOpen(false));
  const keysRef = usePopover(keysOpen, () => setKeysOpen(false));
  const rate = ARRANGEMENT_DEFAULT_RATE;

  useLayoutEffect(() => {
    const a = anchor.current;
    const el = scrollRef.current;
    if (!a || !el) return;
    anchor.current = null;
    el.scrollLeft = Math.max(0, (a.frame / rate) * zoom - a.x);
  }, [zoom]);
  useEffect(() => {
    if (renameAsk) nameBox.current?.focus();
  }, [renameAsk]);
  useEffect(() => loopTick.current(), [run.cursor]);

  // Ctrl + scroll zooms around the pointer; a plain scroll scrolls. The listener is not passive, so it can keep the page from zooming.
  const wheelZoom = useRef<(e: WheelEvent) => void>(() => {});
  wheelZoom.current = (e: WheelEvent) => {
    const el = scrollRef.current;
    if (!el || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const x = Math.max(0, e.clientX - el.getBoundingClientRect().left - HEAD_W);
    zoomAround(clampZoom(zoom * Math.pow(1.0015, -e.deltaY)), ((el.scrollLeft + x) / zoom) * rate, x, false);
  };
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const fn = (e: WheelEvent) => wheelZoom.current(e);
    el.addEventListener("wheel", fn, { passive: false });
    return () => el.removeEventListener("wheel", fn);
  }, [!!set, on]);

  // The Clips window, over the sync channel: it says when it opens and closes, and picks, adds and opens through this view.
  const fromWindow = useRef<(m: SyncMessage) => void>(() => {});
  const sync = useRef<ReturnType<typeof openSync>>(null);
  useEffect(() => {
    const s = openSync((m) => fromWindow.current(m));
    sync.current = s;
    s?.post({ t: "ping" });
    return () => s?.close();
  }, []);

  const tracks = set ? [...set.tracks].sort((a, b) => a.order - b.order) : [];
  const trackOf = (id: string) => tracks.find((t) => t.id === id);
  const instOf = (t: string, i: string) => trackOf(t)?.arrangement.instances.find((x) => x.id === i);
  const layoutOf = (t: string, i: string) => trackOf(t)?.layout.find((x) => x.id === i);
  const selTrack = sel ? sel.track : null;
  const addsTo = selTrack && trackOf(selTrack) ? SET_COPY.addTo(trackOf(selTrack)!.title, arrangeClock(playhead, rate, true)) : SET_COPY.addToNew(arrangeClock(playhead, rate, true));
  useEffect(() => {
    sync.current?.post({ t: "state", picked, addsTo, version: hub.data.version + answers });
  }, [picked?.target, picked?.kind, addsTo, hub.data.version, answers, popped]);

  if (!on) return <div className="hub-screen"><Empty title={SET_COPY.arrangement}>{SET_COPY.notOffered}</Empty></div>;
  if (!set) return <div className="hub-screen">{error ? <div className="banner warn small" role="alert">{error}</div> : <Placeholder />}</div>;

  const select = (s: Sel) => setSel(s);

  /** Send op lines; the answer is the set, and a refusal shows its findings and candidates. */
  const edit = async (lines: string[] | null, after?: (a: SetAnswer) => void) => {
    if (!lines?.length) return;
    setRefused(null);
    try {
      const a = await api.set.edit(lines);
      setSet(a);
      setAnswers((n) => n + 1);
      after?.(a);
    } catch (e) {
      if (e instanceof ApiError && e.status === 400) {
        setRefused({ lines, findings: refusalFindings(e.body) });
        setWarnOpen(true);
      } else hub.notify((e as Error).message, "bad");
    }
  };
  const play = async (scope: SetRunScope, what: string) => {
    try {
      const { plan, placement, runId } = await api.set.run(scope);
      setMine(runId ? { planId: plan.id, runId } : null);
      const f = runFeedback(what || plan.title, placement);
      hub.notify(f.text, f.tone);
      hub.data.reload();
    } catch (e) {
      hub.notify((e as Error).message, "bad");
    }
  };
  /** Play and Space: every timeline from the playhead, as a DAW plays from its insert marker; from the loop's start when Loop is on. */
  const playAll = () => {
    const from = loopOn && loop ? loop.start : playhead;
    void play(arrangementFromPlayhead(from, rate), from > 0 ? SET_COPY.arrangementFrom(arrangeSeconds(from, rate)) : SET_COPY.arrangement);
  };
  const stop = async () => {
    if (!run.active) return;
    try {
      await api.hub.cancelPlan(run.active.planId);
      hub.data.reload();
    } catch (e) {
      hub.notify((e as Error).message, "bad");
    }
  };
  // Loop on: the run reaching the loop's end starts again from its start.
  loopTick.current = () => {
    if (!loopOn || !loop || !run.active || run.cursor === null || run.cursor < loop.end || restarting.current) return;
    restarting.current = true;
    void stop().then(() => play(arrangementFromPlayhead(loop.start, rate), SET_COPY.arrangementFrom(arrangeSeconds(loop.start, rate)))).finally(() => {
      restarting.current = false;
    });
  };
  const open = (kind: InstanceKind, target: string) => hub.go(kind === "clip" ? { screen: "clip", path: target } : { screen: "check", checkId: checkId({ kind: "script", target }) });
  const newTrack = (a: SetAnswer) => a.changed?.find((c) => a.tracks.some((t) => t.id === c));
  const addTrack = () => void edit([SET_OPS.trackAdd(nextName(SET_COPY.track, tracks.map((t) => t.title)))], (a) => {
    const id = newTrack(a);
    if (id) select({ kind: "track", track: id });
  });
  /** A clip onto a track at a frame, selected once it is there; onto a new track when there is none, as dropping below the tracks does. */
  const addClip = (clip: ClipRef, to: string | null, at: number) => {
    const put = (t: string) => void edit([SET_OPS.add(t, clip.kind, clip.target, at)], (a) => {
      const id = a.changed?.find((c) => a.tracks.find((x) => x.id === t)?.layout.some((l) => l.id === c));
      if (id) select({ kind: "instance", track: t, id });
    });
    if (to) put(to);
    else void edit([SET_OPS.trackAdd(nextName(SET_COPY.track, tracks.map((t) => t.title)))], (a) => {
      const id = newTrack(a);
      if (id) put(id);
    });
  };
  fromWindow.current = (m) => {
    if (m.t === "hello") setPopped(true);
    else if (m.t === "bye") setPopped(false);
    else if (m.t === "pick") setPicked(m.clip);
    else if (m.t === "add") addClip(m.clip, selTrack, playhead);
    else if (m.t === "open") open(m.clip.kind, m.clip.target);
  };
  const pickEntry = (c: HubClipEntry | null) => setPicked(c ? { kind: c.kind, target: c.target, name: c.name } : null);
  const popOut = () => {
    const w = popOutClips();
    if (!w) return;
    popup.current = w;
    setPopped(true);
  };
  const bringBack = () => {
    sync.current?.post({ t: "close" });
    popup.current?.close();
    popup.current = null;
    setPopped(false);
    setDrawer(true);
    store(DRAWER_KEY, "open");
  };
  const toggleDrawer = () => {
    if (popped) {
      popup.current?.focus();
      return;
    }
    setDrawer((d) => {
      store(DRAWER_KEY, d ? "closed" : "open");
      return !d;
    });
  };

  /** What the selection is called and the lines renaming or coloring it send. */
  const about = (() => {
    if (sel?.kind === "track") {
      const t = trackOf(sel.track);
      return t && { name: t.title, color: t.color, rename: (n: string) => [SET_OPS.trackRename(t.id, n)], recolor: (c: string) => [SET_OPS.trackColor(t.id, c)] };
    }
    if (sel?.kind === "instance") {
      const l = layoutOf(sel.track, sel.id);
      return l && { name: l.name, color: instOf(sel.track, sel.id)?.color, rename: (n: string) => [SET_OPS.rename(sel.track, sel.id, n)], recolor: (c: string) => [SET_OPS.color(sel.track, sel.id, c)] };
    }
    return null;
  })();
  /** The selected track one place up or down. */
  const reorder = (by: number): string[] | null => {
    if (sel?.kind !== "track") return null;
    const i = tracks.findIndex((t) => t.id === sel.track) + by;
    return i >= 0 && i < tracks.length ? [SET_OPS.trackMove(sel.track, i)] : null;
  };
  const duplicate = () => {
    if (sel?.kind === "instance") void edit([SET_OPS.duplicate(sel.track, sel.id)], (a) => {
      const id = a.changed?.find((c) => c !== sel.id);
      if (id) select({ kind: "instance", track: sel.track, id });
    });
  };
  /** An instance goes at once, as in a DAW; a track is confirmed first, since its timeline goes with it. */
  const remove = () => {
    if (sel?.kind === "instance") void edit([SET_OPS.remove(sel.track, sel.id)], () => select({ kind: "track", track: sel.track }));
    else if (sel?.kind === "track") setDeleting(sel.track);
  };
  const copy = () => {
    if (sel?.kind !== "instance" || !about) return false;
    setCopied({ track: sel.track, id: sel.id });
    hub.notify(SET_COPY.copied(about.name));
    return true;
  };
  const paste = () => {
    if (copied && selTrack && instOf(copied.track, copied.id)) void edit([SET_OPS.copy(copied.track, copied.id, selTrack, playhead)]);
  };
  /** I: the clip picked in Clips onto the selected track (a new one when none is) at the playhead. */
  const insertPicked = () => {
    if (picked) addClip(picked, selTrack, playhead);
  };
  /** R: the selected instance plays the clip picked in Clips instead. */
  const replacePicked = () => {
    const inst = sel?.kind === "instance" ? instOf(sel.track, sel.id) : undefined;
    if (inst && picked && sel?.kind === "instance") void edit(replaceLines(sel.track, inst, picked));
  };
  /** The frames the selection spans: a clip's, or everything on a track. */
  const selSpan = (): Loop | null => {
    if (sel?.kind === "instance") {
      const l = layoutOf(sel.track, sel.id);
      return l ? { start: l.start, end: l.end } : null;
    }
    const t = sel ? trackOf(sel.track) : null;
    if (!t?.layout.length) return null;
    return { start: Math.min(...t.layout.map((l) => l.start)), end: arrangeEnd([t.layout]) };
  };

  // ---------- Zoom ----------
  const lanesWidth = () => Math.max(160, (scrollRef.current?.clientWidth ?? 960) - HEAD_W - 24);
  /** Zoom to `z` keeping `frame` at `x` pixels from the lanes' left edge; `remember` lets X go back. */
  function zoomAround(z: number, frame: number, x: number, remember = true) {
    const el = scrollRef.current;
    if (remember) zoomBack.current = [...zoomBack.current.slice(-19), { zoom, left: el?.scrollLeft ?? 0 }];
    anchor.current = { frame, x };
    setZoom(clampZoom(z));
  }
  const zoomStepBy = (dir: 1 | -1) => {
    const el = scrollRef.current;
    const left = el?.scrollLeft ?? 0;
    const x = (playhead / rate) * zoom - left;
    const inView = x >= 0 && x <= lanesWidth();
    zoomAround(zoomStep(zoom, dir), inView ? playhead : (left / zoom) * rate, inView ? x : 0);
  };
  const zoomFit = () => {
    const end = Math.max(arrangeEnd(tracks.map((t) => t.layout)), run.detail?.length ?? 0, rate * 5);
    zoomAround(zoomToFit(0, end, rate, lanesWidth()), 0, 0);
  };
  const zoomToSelection = () => {
    const span = selSpan();
    if (!span) return zoomFit();
    const pad = (span.end - span.start) * 0.05;
    zoomAround(zoomToFit(span.start - pad, span.end + pad, rate, lanesWidth()), Math.max(0, span.start - pad), 0);
  };
  const zoomOutBack = () => {
    const prev = zoomBack.current.pop();
    if (!prev) return;
    anchor.current = { frame: (prev.left / prev.zoom) * rate, x: 0 };
    setZoom(prev.zoom);
  };
  const loopSelection = () => {
    const span = selSpan();
    if (span) setLoop(span);
    if (span || loop) setLoopOn(span ? true : (v) => !v);
  };

  /** Arrows: a selected clip moves (Shift for a second), Alt trims its end and Alt+Shift its start, Up and Down take it to the next track; otherwise the playhead and the selection move, and Alt+Up and Down reorder. */
  const arrow = (key: string, alt: boolean, shift: boolean) => {
    const dir = key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : 0;
    const dy = key === "ArrowUp" ? -1 : key === "ArrowDown" ? 1 : 0;
    if (sel?.kind === "instance") {
      const inst = instOf(sel.track, sel.id);
      const l = layoutOf(sel.track, sel.id);
      if (!inst || !l) return;
      if (dy) {
        const to = tracks[tracks.findIndex((t) => t.id === sel.track) + dy];
        if (to) void edit(dragLines(sel.track, inst, l, "move", 0, { toTrack: to.id }), () => select({ kind: "instance", track: to.id, id: sel.id }));
        return;
      }
      const scale = clipScale(trackOf(sel.track)?.arrangement.rate || rate, l.clipRate);
      if (alt) return void edit(dragLines(sel.track, inst, l, shift ? "trimStart" : "trimEnd", dir * arrangeStep(rate), { scale }));
      return void edit(dragLines(sel.track, inst, l, "move", Math.max(-l.start, dir * arrangeStep(rate, shift))));
    }
    if (dir) return setPlayhead((p) => snapTo(p + dir * arrangeStep(rate, shift), arrangeStep(rate)));
    if (alt) return void edit(reorder(dy));
    const ti = selTrack ? tracks.findIndex((t) => t.id === selTrack) : -1;
    const t = tracks[Math.max(0, Math.min(tracks.length - 1, ti + dy))];
    if (t) select({ kind: "track", track: t.id });
  };

  const onKey = (e: ReactKeyboardEvent) => {
    if (typing(e.target)) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key;
    const lower = k.toLowerCase();
    if (k === " ") {
      if (run.active) void stop();
      else playAll();
    } else if (k === "Enter") {
      if (sel?.kind === "track") void play({ kind: "track", goalId: sel.track }, trackOf(sel.track)?.title ?? "");
      else if (sel?.kind === "instance") {
        const i = instOf(sel.track, sel.id);
        if (i) open(i.kind, i.target);
      } else return;
    } else if (ctrl && e.altKey && lower === "b") toggleDrawer();
    else if (ctrl && lower === "d") duplicate();
    else if (ctrl && lower === "c") copy();
    else if (ctrl && lower === "x") {
      if (copy()) remove();
    } else if (ctrl && lower === "v") paste();
    else if (ctrl && lower === "t") addTrack();
    else if (ctrl && lower === "l") loopSelection();
    else if ((ctrl && lower === "r") || k === "F2") nameBox.current?.focus();
    else if (k === "Delete" || k === "Backspace") remove();
    else if (ctrl) return;
    else if (lower === "i") insertPicked();
    else if (lower === "r") replacePicked();
    else if (lower === "w") zoomFit();
    else if (lower === "z") zoomToSelection();
    else if (lower === "x") zoomOutBack();
    else if (k === "+" || k === "=") zoomStepBy(1);
    else if (k === "-" || k === "_") zoomStepBy(-1);
    else if (k === "Escape") {
      if (warnOpen || keysOpen) {
        setWarnOpen(false);
        setKeysOpen(false);
      } else select(null);
    } else if (k === "Home") setPlayhead(0);
    else if (k === "End") setPlayhead(arrangeEnd(tracks.map((t) => t.layout)));
    else if (k === "," || k === ".") {
      const t = selTrack ? trackOf(selTrack) : null;
      const id = t ? stepSelection(t.layout, sel?.kind === "instance" ? sel.id : null, k === "," ? -1 : 1) : null;
      if (t && id) select({ kind: "instance", track: t.id, id });
    } else if (k.startsWith("Arrow")) arrow(k, e.altKey, e.shiftKey);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const findings = arrangementFindings(set, refused?.findings ?? []);
  const flagged = new Map<string, string>();
  for (const f of findings) {
    const p = findingPlace(f, set);
    const key = p ? (p.instance ? `${p.track}/${p.instance}` : p.track) : null;
    if (key && !flagged.has(key)) flagged.set(key, f.message);
  }
  const blocking = findings.some((f) => f.blocks);
  const showFinding = (f: ArrangementFinding) => {
    const p = findingPlace(f, set);
    if (!p) return;
    select(p.instance ? { kind: "instance", track: p.track, id: p.instance } : { kind: "track", track: p.track });
    const l = p.instance ? layoutOf(p.track, p.instance) : null;
    const el = scrollRef.current;
    if (l && el) el.scrollLeft = Math.max(0, (l.start / rate) * zoom - 40);
    setWarnOpen(false);
  };
  const ctx: ViewCtx = {
    tracks, rate, sel, select, edit, play, open, addClip,
    results: run.results, cursor: run.cursor, runLength: run.detail?.length ?? 0,
    flagged, onWarning: (key) => {
      setWarnAt(key);
      setWarnOpen(true);
    },
    zoom, playhead, setPlayhead, loop, loopOn, setLoop: (l) => setLoop(l),
    onAddTrack: addTrack, onRename: () => setRenameAsk((n) => n + 1), scrollRef,
  };
  const instanceSel = sel?.kind === "instance" ? instOf(sel.track, sel.id) : undefined;
  const at = run.cursor ?? playhead;

  const resize = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const y0 = e.clientY;
    const h0 = drawerH;
    const move = (m: PointerEvent) => setDrawerH(Math.max(120, Math.min(window.innerHeight * 0.6, h0 + y0 - m.clientY)));
    const up = (m: PointerEvent) => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      store(DRAWER_H_KEY, String(Math.round(Math.max(120, Math.min(window.innerHeight * 0.6, h0 + y0 - m.clientY)))));
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  };

  return (
    <div className="hub-screen hub-set" onKeyDown={onKey}>
      <ScreenHead
        compact
        title={SET_COPY.arrangement}
        actions={<>
          <div className="hub-set-transport" role="group" aria-label={SET_COPY.transport}>
            {run.active
              ? <button className="hub-set-transport-btn on" onClick={() => void stop()} title={SET_COPY.stopHint}><HubIcon name="stop" size={11} /> {SET_COPY.stop}</button>
              : <button className="hub-set-transport-btn primary" onClick={playAll} title={SET_COPY.playArrangement} disabled={!tracks.length}><HubIcon name="play" size={11} /> {SET_COPY.play}</button>}
            <button className={`hub-set-transport-btn ${loopOn ? "on" : ""}`} aria-pressed={loopOn} title={SET_COPY.loopHint}
              onClick={() => {
                if (!loop) setLoop(selSpan() ?? { start: playhead, end: playhead + rate * 4 });
                setLoopOn((v) => !v);
              }}><HubIcon name="loop" size={12} /> {SET_COPY.loop}</button>
            <output className="hub-set-clock" aria-label={SET_COPY.position} title={SET_COPY.position}>{arrangeClock(at, rate, true)}</output>
          </div>
          {findings.length > 0 && (
            <div className="hub-set-pop-anchor" ref={warnRef}>
              <button className={`hub-set-warnings ${blocking ? "bad" : ""}`} aria-expanded={warnOpen} aria-controls="hub-set-warnings" onClick={() => setWarnOpen((v) => !v)}>
                <HubIcon name="warn" size={12} /> {SET_COPY.warnings(findings.length)}
              </button>
              {warnOpen && (
                <div className="hub-set-pop warnings" id="hub-set-warnings" role="region" aria-label={SET_COPY.warningsTitle}>
                  <ul>
                    {findings.map((f) => {
                      const p = findingPlace(f, set);
                      const key = p ? (p.instance ? `${p.track}/${p.instance}` : p.track) : null;
                      return (
                        <li key={`${f.id}:${f.field}:${f.message}`} className={`${f.blocks ? "bad" : "warn"} ${key && key === warnAt ? "at" : ""}`} role={f.blocks ? "alert" : undefined}>
                          <HubIcon name="warn" size={12} />
                          <span className="hub-set-pop-text">{f.message}</span>
                          <span className="hub-set-pop-acts">
                            {(f.candidates ?? []).map((c) => {
                              const lines = candidateLines(f, c, refused?.lines ?? null, set);
                              return lines ? <button key={c} className="ghost small-button" onClick={() => void edit(lines)}>{SET_COPY.useCandidate(c)}</button> : null;
                            })}
                            {p && <button className="ghost small-button" onClick={() => showFinding(f)}>{SET_COPY.showWarning}</button>}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </div>
          )}
          <div className="hub-set-zoom" role="group" aria-label={SET_COPY.zoom}>
            <button className="ghost icon-button" aria-label={SET_COPY.zoomOut} title={SET_COPY.zoomOut} onClick={() => zoomStepBy(-1)}>-</button>
            <button className="ghost icon-button" aria-label={SET_COPY.zoomIn} title={SET_COPY.zoomIn} onClick={() => zoomStepBy(1)}>+</button>
            <button className="ghost icon-button" aria-label={SET_COPY.zoomFit} title={SET_COPY.zoomFit} onClick={zoomFit}><HubIcon name="fit" size={13} /></button>
            <button className="ghost icon-button" aria-label={SET_COPY.zoomSelection} title={SET_COPY.zoomSelection} onClick={zoomToSelection}><HubIcon name="focus" size={13} /></button>
          </div>
          <div className="hub-set-pop-anchor" ref={keysRef}>
            <button className="ghost icon-button" aria-label={SET_COPY.keys} title={SET_COPY.keys} aria-expanded={keysOpen} onClick={() => setKeysOpen((v) => !v)}><HubIcon name="keyboard" size={13} /></button>
            {keysOpen && (
              <div className="hub-set-pop keys" role="region" aria-label={SET_COPY.keys}>
                <dl>{SET_COPY.keyList.map(([k, v]) => <div key={k}><dt><kbd>{k}</kbd></dt><dd>{v}</dd></div>)}</dl>
              </div>
            )}
          </div>
        </>}
      />
      {run.awaiting.length > 0 && run.active && <Verdicts runId={run.active.runId} checks={run.awaiting} />}
      <div className="hub-set-surface" ref={surfaceRef} tabIndex={0} role="group" aria-label={SET_COPY.arrangement}
        onPointerDownCapture={(e) => {
          if (!typing(e.target) && !(e.target as HTMLElement).closest("button, select")) surfaceRef.current?.focus({ preventScroll: true });
        }}>
        <Timelines ctx={ctx} />
      </div>
      <footer className="hub-set-foot">
        <div className="hub-set-foot-bar">
          <button className={`ghost hub-set-drawer-toggle ${drawer || popped ? "on" : ""}`} aria-expanded={drawer && !popped} title={popped ? SET_COPY.focusWindow : SET_COPY.showClips} onClick={toggleDrawer}>
            <HubIcon name={popped ? "external" : drawer ? "down" : "up"} size={11} /> {SET_COPY.clips}
          </button>
          {canPopOut() && !popped && <button className="ghost icon-button" aria-label={SET_COPY.popOut} title={SET_COPY.popOut} onClick={popOut}><HubIcon name="external" size={12} /></button>}
          {popped && <button className="ghost small-button" onClick={bringBack}>{SET_COPY.bringBack}</button>}
          <span className="hub-set-foot-div" aria-hidden="true" />
          {about ? (
            <div className="hub-set-inspector" role="group" aria-label={SET_COPY.selection}>
              <input
                key={JSON.stringify(sel)}
                ref={nameBox}
                className="hub-set-name"
                defaultValue={about.name}
                aria-label={SET_COPY.name}
                title={about.name}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") {
                    (e.target as HTMLInputElement).value = about.name;
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v && v !== about.name) void edit(about.rename(v));
                }}
              />
              <span className="hub-set-swatches" role="group" aria-label={SET_COPY.color}>
                {HUB_COLORS.map((c) => (
                  <button key={c} className={`hub-set-swatch c-${c}`} aria-label={SET_COPY.colorName(c)} title={SET_COPY.colorName(c)} aria-pressed={about.color === c} onClick={() => void edit(about.recolor(c))} />
                ))}
              </span>
              {instanceSel && sel?.kind === "instance" && <>
                <button className="ghost small-button" onClick={() => open(instanceSel.kind, instanceSel.target)}>{SET_COPY.open}</button>
                <button className="ghost small-button" onClick={duplicate} title={SET_COPY.duplicateHint}>{SET_COPY.duplicate}</button>
                <button className="ghost small-button" onClick={() => void edit([SET_OPS.unique(sel.track, sel.id)])} title={SET_COPY.makeUniqueHint}>{SET_COPY.makeUnique}</button>
                {picked && replaceLines(sel.track, instanceSel, picked) && (
                  <button className="ghost small-button" onClick={replacePicked} title={SET_COPY.replaceHint}>{SET_COPY.replace(picked.name ?? picked.target.split("/").pop()!)}</button>
                )}
              </>}
              {sel?.kind === "track" && <>
                <button className="ghost icon-button" aria-label={SET_COPY.moveUp} title={SET_COPY.moveUp} disabled={!reorder(-1)} onClick={() => void edit(reorder(-1))}><HubIcon name="up" size={12} /></button>
                <button className="ghost icon-button" aria-label={SET_COPY.moveDown} title={SET_COPY.moveDown} disabled={!reorder(1)} onClick={() => void edit(reorder(1))}><HubIcon name="down" size={12} /></button>
              </>}
              <button className="ghost small-button" onClick={remove}>{SET_COPY.remove}</button>
            </div>
          ) : picked ? <span className="hub-set-foot-hint dim small">{SET_COPY.pickedGoes(picked.name ?? picked.target.split("/").pop()!, selTrack ? trackOf(selTrack)?.title ?? null : null, arrangeClock(playhead, rate, true))}</span> : null}
        </div>
        {popped && drawer && <p className="hub-set-drawer-note dim small">{SET_COPY.poppedOut}</p>}
        {drawer && !popped && (
          <div className="hub-set-drawer" style={{ height: drawerH }}>
            <div className="hub-set-drawer-grip" onPointerDown={resize} aria-hidden="true" />
            <ClipBrowser variant="drawer" picked={picked} onPick={pickEntry} onOpen={(c) => open(c.kind, c.target)} onAdd={(c) => addClip({ kind: c.kind, target: c.target, name: c.name }, selTrack, playhead)} addsTo={addsTo} version={hub.data.version} />
          </div>
        )}
      </footer>
      {deleting && (
        <DeleteConfirm track={deleting} set={set} onClose={() => setDeleting(null)}
          onDeleted={(a, title) => {
            setDeleting(null);
            setSet(a);
            select(null);
            hub.notify(SET_COPY.deleted(title));
          }} />
      )}
    </div>
  );
}

/**
 * Confirm deleting a track, sent as its delete op. It names the scenes that
 * stop playing it, since that changes them out of sight. A refusal (a run
 * made for it is queued or running) stays in the dialog.
 */
function DeleteConfirm({ track, set, onClose, onDeleted }: { track: string; set: SetAnswer; onClose: () => void; onDeleted: (a: SetAnswer, title: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const x = set.tracks.find((t) => t.id === track);
  if (!x) return null;
  const scenes = set.scenes.filter((s) => s.tracks.includes(track)).sort((a, b) => a.order - b.order);
  const question = SET_COPY.deleteTitle(x.title);
  const close = () => !busy && onClose();
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      onDeleted(await api.set.edit([SET_OPS.trackDelete(track)]), x.title);
    } catch (e) {
      setBusy(false);
      setError(e instanceof ApiError && e.status === 400 ? refusalFindings(e.body)[0]?.message ?? e.message : (e as Error).message);
    }
  };
  return (
    <Dialog label={question} onClose={close} className="hub-delete">
      <div className="overlay-head">{question}</div>
      <p className="small">{SET_COPY.deleteTrackKeeps}</p>
      {scenes.length > 0 && (
        <div className="hub-set-delete-scenes">
          <p className="small" id="hub-set-delete-scenes">{SET_COPY.deleteUnlinks}</p>
          <ul className="hub-delete-list" aria-labelledby="hub-set-delete-scenes">
            {scenes.map((s) => <li key={s.id} className="small">{s.title}</li>)}
          </ul>
        </div>
      )}
      {error && <div className="banner bad small" role="alert">{error}</div>}
      <div className="hub-form-actions">
        <span className="spacer" />
        <button className="ghost" autoFocus disabled={busy} onClick={close}>{SET_COPY.cancel}</button>
        <button className="danger-button" disabled={busy} onClick={() => void run()}>{SET_COPY.deleteTrack}</button>
      </div>
    </Dialog>
  );
}

/** Checks waiting on a person in the run playing now, each on one line with the question it asks. */
function Verdicts({ runId, checks }: { runId: string; checks: Array<{ check: string; instruction: string; name: string }> }) {
  const hub = useHub();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [done, setDone] = useState<string[]>([]);
  const answer = async (check: string, v: "pass" | "fail" | "skip") => {
    try {
      await api.set.verdict(runId, check, v, notes[check]?.trim() || undefined);
      setDone((d) => [...d, check]);
      hub.data.reload();
    } catch (e) {
      hub.notify((e as Error).message, "bad");
    }
  };
  const open = checks.filter((c) => !done.includes(c.check));
  if (!open.length) return null;
  return (
    <div className="hub-set-verdicts">
      {open.map(({ check: c, instruction, name }) => (
        <div key={c} className="hub-set-verdict" role="group" aria-label={SET_COPY.needsVerdict(name)}>
          <strong>{SET_COPY.needsVerdict(name)}</strong>
          <span className="hub-set-verdict-ask" title={instruction}>{instruction}</span>
          <input value={notes[c] ?? ""} onChange={(e) => setNotes((n) => ({ ...n, [c]: e.target.value }))} placeholder={SET_COPY.note} aria-label={SET_COPY.note} />
          <button className="small-button" onClick={() => void answer(c, "pass")}>{SET_COPY.pass}</button>
          <button className="small-button" onClick={() => void answer(c, "fail")}>{SET_COPY.fail}</button>
          <button className="ghost small-button" onClick={() => void answer(c, "skip")}>{SET_COPY.skip}</button>
        </div>
      ))}
    </div>
  );
}

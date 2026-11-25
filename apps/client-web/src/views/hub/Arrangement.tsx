/**
 * The Arrangement: every track as a timeline of clip instances under one
 * ruler, as in a DAW, with the Clips panel to drag clips in and the scenes
 * that play chosen tracks together. Play runs every timeline, honoring mute
 * and solo; a track's or a scene's own play button runs just that. Every
 * change is an op line sent to POST /hub/set/edit, all or none, and the
 * daemon's answer is what is drawn. Runs color each block with its result
 * and show a playhead while they play. Every drag has a key.
 */
import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import {
  ARRANGE_DEFAULT_ZOOM,
  ARRANGE_ZOOMS,
  GOAL_STATUS_LOOK,
  INSTANCE_STATUS_LOOK,
  SET_COPY,
  SET_OPS,
  activeSetRun,
  arrangeEnd,
  arrangeSeconds,
  arrangeStep,
  arrangementCursor,
  arrangementOn,
  candidateLines,
  clipScale,
  dragLines,
  emptySegmentLive,
  foldRun,
  foldSegmentEvents,
  nextName,
  refusalFindings,
  replaceLines,
  rulerFrames,
  rulerTicks,
  runFeedback,
  setResults,
  snapTo,
  spanProgress,
  stepSelection,
  type ArrangeDragMode,
  type SegmentLive,
} from "@ue-mcp-studio/client-core";
import {
  HUB_COLORS,
  checkId,
  type ArrangementFinding,
  type ArrangementRun,
  type HubClipEntry,
  type InstanceKind,
  type InstanceLayout,
  type SetAnswer,
  type SetRunScope,
  type SetScene,
  type SetTrack,
} from "@ue-mcp-studio/shared";
import { ApiError, api } from "../../api";
import { useHub } from "./state";
import { Empty, HubIcon, Placeholder, ScreenHead, StatusMark } from "./parts";
import { Dialog } from "./dialogs";
import "./arrangement.css";

type Sel = { kind: "scene"; scene: string } | { kind: "track"; track: string } | { kind: "instance"; track: string; id: string } | null;

/** What a clip dragged from the Clips panel carries. */
export const CLIP_MIME = "application/x-ue-mcp-clip";

const ROW_H = 44;
const typing = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA");
};
const colorClass = (c?: string): string => (c ? `c-${c}` : "");

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
function useSetRun() {
  const hub = useHub();
  const active = activeSetRun(hub.o);
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
  const awaiting = active ? [...segIds].flatMap((id) => live.awaiting[id] ?? []) : [];
  return { active, detail, cursor, results, awaiting };
}

export function ArrangementScreen() {
  const hub = useHub();
  const on = arrangementOn(hub.health);
  const { set, setSet, error } = useSet(hub.data.version, on);
  const run = useSetRun();
  const [refused, setRefused] = useState<{ lines: string[]; findings: ArrangementFinding[] } | null>(null);
  const [sel, setSel] = useState<Sel>(null);
  const [scene, setScene] = useState<string | null>(null);
  const [copied, setCopied] = useState<{ track: string; id: string } | null>(null);
  const [picked, setPicked] = useState<HubClipEntry | null>(null);
  const [rates, setRates] = useState<Record<string, number>>({});
  const [zoom, setZoom] = useState<number>(ARRANGE_DEFAULT_ZOOM);
  const [playhead, setPlayhead] = useState(0);
  const [deleting, setDeleting] = useState<{ kind: "track" | "scene"; id: string } | null>(null);
  const nameBox = useRef<HTMLInputElement>(null);

  if (!on) return <div className="hub-screen"><Empty title={SET_COPY.arrangement}>{SET_COPY.notOffered}</Empty></div>;
  if (!set) return <div className="hub-screen">{error ? <div className="banner warn small" role="alert">{error}</div> : <Placeholder />}</div>;

  const tracks = [...set.tracks].sort((a, b) => a.order - b.order);
  const scenes = [...set.scenes].sort((a, b) => a.order - b.order);
  const rate = set.rate || 60;
  const trackOf = (id: string) => tracks.find((t) => t.id === id);
  const sceneOf = (id: string | null) => scenes.find((s) => s.id === id);
  const instOf = (t: string, i: string) => trackOf(t)?.arrangement.instances.find((x) => x.id === i);
  const layoutOf = (t: string, i: string) => trackOf(t)?.layout.find((x) => x.id === i);
  const shownScene = sceneOf(sel?.kind === "scene" ? sel.scene : scene);
  const select = (s: Sel) => {
    setSel(s);
    if (s?.kind === "scene") setScene(s.scene);
  };

  /** Send op lines; the answer is the set, and a refusal shows its findings and candidates. */
  const edit = async (lines: string[] | null, after?: (a: SetAnswer) => void) => {
    if (!lines?.length) return;
    setRefused(null);
    try {
      const a = await api.set.edit(lines);
      setSet(a);
      after?.(a);
    } catch (e) {
      if (e instanceof ApiError && e.status === 400) setRefused({ lines, findings: refusalFindings(e.body) });
      else hub.notify((e as Error).message, "bad");
    }
  };
  const play = async (scope: SetRunScope, what: string) => {
    try {
      const { plan, placement } = await api.set.run(scope);
      const f = runFeedback(what || plan.title, placement);
      hub.notify(f.text, f.tone);
      hub.data.reload();
    } catch (e) {
      hub.notify((e as Error).message, "bad");
    }
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
  const open = (kind: InstanceKind, target: string) => hub.go(kind === "clip" ? { screen: "clip", path: target } : { screen: "check", checkId: checkId({ kind: "script", target }) });
  const selectNew = (kind: "track" | "scene") => (a: SetAnswer) => {
    const id = a.changed?.find((c) => (kind === "track" ? a.tracks : a.scenes).some((x) => x.id === c));
    if (id) select(kind === "track" ? { kind: "track", track: id } : { kind: "scene", scene: id });
  };
  const addTrack = () => void edit([SET_OPS.trackAdd(nextName(SET_COPY.track, tracks.map((t) => t.title)))], selectNew("track"));
  const addScene = () => void edit([SET_OPS.sceneAdd(nextName(SET_COPY.scene, scenes.map((s) => s.title)))], selectNew("scene"));
  const insertScene = () => {
    const at = sel?.kind === "scene" ? scenes.findIndex((s) => s.id === sel.scene) : 0;
    void edit([SET_OPS.sceneInsert(nextName(SET_COPY.scene, scenes.map((s) => s.title)), Math.max(0, at))], selectNew("scene"));
  };
  const selTrack = sel?.kind === "track" || sel?.kind === "instance" ? sel.track : null;

  /** What the selection is called and the lines renaming or coloring it sends. */
  const about = (() => {
    if (sel?.kind === "track") {
      const t = trackOf(sel.track);
      return t && { name: t.title, color: t.color, rename: (n: string) => [SET_OPS.trackRename(t.id, n)], recolor: (c: string) => [SET_OPS.trackColor(t.id, c)] };
    }
    if (sel?.kind === "scene") {
      const s = sceneOf(sel.scene);
      return s && { name: s.title, color: s.color, rename: (n: string) => [SET_OPS.sceneRename(s.id, n)], recolor: (c: string) => [SET_OPS.sceneColor(s.id, c)] };
    }
    if (sel?.kind === "instance") {
      const l = layoutOf(sel.track, sel.id);
      return l && { name: l.name, color: instOf(sel.track, sel.id)?.color, rename: (n: string) => [SET_OPS.rename(sel.track, sel.id, n)], recolor: (c: string) => [SET_OPS.color(sel.track, sel.id, c)] };
    }
    return null;
  })();
  /** The selected track or scene one place up or down. */
  const reorder = (by: number): string[] | null => {
    if (sel?.kind === "track") {
      const i = tracks.findIndex((t) => t.id === sel.track) + by;
      return i >= 0 && i < tracks.length ? [SET_OPS.trackMove(sel.track, i)] : null;
    }
    if (sel?.kind === "scene") {
      const i = scenes.findIndex((s) => s.id === sel.scene) + by;
      return i >= 0 && i < scenes.length ? [SET_OPS.sceneMove(sel.scene, i)] : null;
    }
    return null;
  };
  const duplicate = () => {
    if (sel?.kind === "instance") void edit([SET_OPS.duplicate(sel.track, sel.id)], (a) => {
      const id = a.changed?.find((c) => c !== sel.id);
      if (id) select({ kind: "instance", track: sel.track, id });
    });
    else if (sel?.kind === "scene") void edit([SET_OPS.sceneDuplicate(sel.scene)], selectNew("scene"));
  };
  /** An instance goes at once, as in a DAW; a track or scene is confirmed first, since its timeline or its list of tracks goes with it. */
  const remove = () => {
    if (sel?.kind === "instance") void edit([SET_OPS.remove(sel.track, sel.id)], () => select({ kind: "track", track: sel.track }));
    else if (sel?.kind === "scene") setDeleting({ kind: "scene", id: sel.scene });
    else if (sel?.kind === "track") setDeleting({ kind: "track", id: sel.track });
  };
  const copy = () => {
    if (sel?.kind !== "instance" || !about) return;
    setCopied({ track: sel.track, id: sel.id });
    hub.notify(SET_COPY.copied(about.name));
  };
  const paste = () => {
    if (copied && selTrack && instOf(copied.track, copied.id)) void edit([SET_OPS.copy(copied.track, copied.id, selTrack, playhead)]);
  };
  /** I: the clip picked in the Clips panel onto the selected track at the playhead. */
  const insertPicked = () => {
    if (!picked || !selTrack) return;
    void edit([SET_OPS.add(selTrack, picked.kind, picked.target, playhead)], (a) => {
      const id = a.changed?.find((c) => a.tracks.find((t) => t.id === selTrack)?.layout.some((l) => l.id === c));
      if (id) select({ kind: "instance", track: selTrack, id });
    });
  };

  /** R: the selected instance plays the clip picked in the Clips panel instead. */
  const replacePicked = () => {
    const inst = sel?.kind === "instance" ? instOf(sel.track, sel.id) : undefined;
    if (inst && picked && sel?.kind === "instance") void edit(replaceLines(sel.track, inst, picked));
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
      const scale = clipScale(trackOf(sel.track)?.arrangement.rate || rate, rates[inst.target]);
      if (alt) return void edit(dragLines(sel.track, inst, l, shift ? "trimStart" : "trimEnd", dir * arrangeStep(rate), { scale }));
      return void edit(dragLines(sel.track, inst, l, "move", Math.max(-l.start, dir * arrangeStep(rate, shift))));
    }
    if (dir) return setPlayhead((p) => snapTo(p + dir * arrangeStep(rate, shift), arrangeStep(rate)));
    if (alt) return void edit(reorder(dy));
    if (sel?.kind === "scene") {
      const s = scenes[scenes.findIndex((x) => x.id === sel.scene) + dy];
      if (s) select({ kind: "scene", scene: s.id });
      return;
    }
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
      else void play({ kind: "arrangement" }, SET_COPY.arrangement);
    } else if (k === "Enter") {
      if (sel?.kind === "scene") void play({ kind: "scene", goalId: sel.scene }, sceneOf(sel.scene)?.title ?? "");
      else if (sel?.kind === "track") void play({ kind: "track", goalId: sel.track }, trackOf(sel.track)?.title ?? "");
      else if (sel?.kind === "instance") {
        const i = instOf(sel.track, sel.id);
        if (i) open(i.kind, i.target);
      } else return;
    } else if (ctrl && lower === "d") duplicate();
    else if (ctrl && lower === "c") copy();
    else if (ctrl && lower === "v") paste();
    else if (ctrl && lower === "t") addTrack();
    else if (ctrl && lower === "i") insertScene();
    else if (k === "Delete" || k === "Backspace") remove();
    else if (k === "F2") nameBox.current?.focus();
    else if (!ctrl && lower === "i") insertPicked();
    else if (!ctrl && lower === "r") replacePicked();
    else if (k === "Escape") select(null);
    else if (k === "," || k === ".") {
      const t = selTrack ? trackOf(selTrack) : null;
      const id = t ? stepSelection(t.layout, sel?.kind === "instance" ? sel.id : null, k === "," ? -1 : 1) : null;
      if (t && id) select({ kind: "instance", track: t.id, id });
    } else if (k.startsWith("Arrow")) arrow(k, e.altKey, e.shiftKey);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const findings = [...(refused?.findings ?? []), ...set.findings.filter((f) => !refused?.findings.some((r) => r.id === f.id && r.field === f.field))];
  const flagged = new Map(findings.map((f) => [f.id, f.message] as const));
  const ctx: ViewCtx = { tracks, rate, sel, select, edit, play, open, run, flagged, rates, zoom, playhead, setPlayhead, scene: shownScene ?? null };
  const instanceSel = sel?.kind === "instance";

  return (
    <div className="hub-screen hub-set">
      <ScreenHead
        title={SET_COPY.arrangement}
        actions={<>
          {run.active
            ? <button onClick={() => void stop()}><HubIcon name="pause" size={12} /> {SET_COPY.stop}</button>
            : <button className="primary" onClick={() => void play({ kind: "arrangement" }, SET_COPY.arrangement)} title={SET_COPY.playArrangement} disabled={!tracks.length}><HubIcon name="play" size={12} /> {SET_COPY.play}</button>}
          <button className="ghost" onClick={addTrack} title={SET_COPY.addTrackHint}><HubIcon name="plus" size={12} /> {SET_COPY.addTrack}</button>
          <button className="ghost" onClick={addScene}><HubIcon name="plus" size={12} /> {SET_COPY.addScene}</button>
        </>}
      />
      {findings.length > 0 && (
        <ul className="hub-set-findings" aria-label="Findings">
          {findings.map((f) => (
            <li key={`${f.id}:${f.field}:${f.message}`} className={f.blocks ? "bad" : "warn"} role={f.blocks ? "alert" : undefined}>
              <span>{f.message}</span>
              {(f.candidates ?? []).map((c) => {
                const lines = candidateLines(f, c, refused?.lines ?? null, set);
                return lines ? <button key={c} className="ghost small-button" onClick={() => void edit(lines)}>{SET_COPY.useCandidate(c)}</button> : null;
              })}
            </li>
          ))}
        </ul>
      )}
      {run.awaiting.length > 0 && run.active && <Verdicts runId={run.active.runId} checks={run.awaiting} detail={run.detail} />}
      {about && (
        <div className="hub-set-inspector" role="group" aria-label={SET_COPY.selection}>
          <input
            key={JSON.stringify(sel)}
            ref={nameBox}
            className="hub-set-name"
            defaultValue={about.name}
            aria-label={SET_COPY.name}
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
          <span className="spacer" />
          {instanceSel && <button className="ghost small-button" onClick={() => sel?.kind === "instance" && instOf(sel.track, sel.id) && open(instOf(sel.track, sel.id)!.kind, instOf(sel.track, sel.id)!.target)}>{SET_COPY.open}</button>}
          {(instanceSel || sel?.kind === "scene") && <button className="ghost small-button" onClick={duplicate} title={SET_COPY.duplicateHint}>{SET_COPY.duplicate}</button>}
          {sel?.kind === "instance" && <button className="ghost small-button" onClick={() => void edit([SET_OPS.unique(sel.track, sel.id)])} title={SET_COPY.makeUniqueHint}>{SET_COPY.makeUnique}</button>}
          {sel?.kind === "instance" && picked && instOf(sel.track, sel.id) && replaceLines(sel.track, instOf(sel.track, sel.id)!, picked) && (
            <button className="ghost small-button" onClick={replacePicked} title={SET_COPY.replaceHint}>{SET_COPY.replace(picked.name)}</button>
          )}
          {!instanceSel && <>
            <button className="ghost icon-button" aria-label={SET_COPY.moveUp} title={SET_COPY.moveUp} disabled={!reorder(-1)} onClick={() => void edit(reorder(-1))}><HubIcon name="up" size={12} /></button>
            <button className="ghost icon-button" aria-label={SET_COPY.moveDown} title={SET_COPY.moveDown} disabled={!reorder(1)} onClick={() => void edit(reorder(1))}><HubIcon name="down" size={12} /></button>
          </>}
          <button className="ghost small-button" onClick={remove}>{SET_COPY.remove}</button>
        </div>
      )}
      <div className="hub-set-body" onKeyDown={onKey}>
        <div className="hub-set-side">
          <ClipBrowser picked={picked} onPick={setPicked} onOpen={(c) => open(c.kind, c.target)} onClips={(cs) => setRates((r) => ({ ...r, ...Object.fromEntries(cs.map((c) => [c.target, c.rate])) }))} />
          <ScenesPanel scenes={scenes} ctx={ctx} />
        </div>
        <div className="hub-set-main">
          <div className="hub-set-surface" tabIndex={0} role="group" aria-label={SET_COPY.arrangement}>
            {!tracks.length ? <p className="dim small">{SET_COPY.emptySet}</p> : <Timelines ctx={ctx} onZoom={setZoom} />}
          </div>
          <details className="hub-set-keys small">
            <summary>{SET_COPY.keys}</summary>
            <dl>{SET_COPY.keyList.map(([k, v]) => <div key={k}><dt><kbd>{k}</kbd></dt><dd>{v}</dd></div>)}</dl>
          </details>
        </div>
      </div>
      {deleting && (
        <DeleteConfirm what={deleting} set={set} onClose={() => setDeleting(null)}
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
 * Confirm deleting a track or scene, sent as its delete op. A track names the
 * scenes that stop playing it. A refusal (a run made for it is queued or
 * running) stays in the dialog.
 */
function DeleteConfirm({ what, set, onClose, onDeleted }: { what: { kind: "track" | "scene"; id: string }; set: SetAnswer; onClose: () => void; onDeleted: (a: SetAnswer, title: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const x = what.kind === "track" ? set.tracks.find((t) => t.id === what.id) : set.scenes.find((s) => s.id === what.id);
  if (!x) return null;
  const scenes = what.kind === "track" ? set.scenes.filter((s) => s.tracks.includes(what.id)).sort((a, b) => a.order - b.order) : [];
  const question = SET_COPY.deleteTitle(what.kind, x.title);
  const close = () => !busy && onClose();
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      onDeleted(await api.set.edit([what.kind === "track" ? SET_OPS.trackDelete(what.id) : SET_OPS.sceneDelete(what.id)]), x.title);
    } catch (e) {
      setBusy(false);
      setError(e instanceof ApiError && e.status === 400 ? refusalFindings(e.body)[0]?.message ?? e.message : (e as Error).message);
    }
  };
  return (
    <Dialog label={question} onClose={close} className="hub-delete">
      <div className="overlay-head">{question}</div>
      <p className="small">{what.kind === "track" ? SET_COPY.deleteTrackKeeps : SET_COPY.deleteSceneKeeps}</p>
      {scenes.length > 0 && (
        <>
          <p className="small" id="hub-set-delete-scenes">{SET_COPY.deleteUnlinks}</p>
          <ul className="hub-delete-list" aria-labelledby="hub-set-delete-scenes">
            {scenes.map((s) => <li key={s.id} className="small">{s.title}</li>)}
          </ul>
        </>
      )}
      {error && <div className="banner bad small" role="alert">{error}</div>}
      <div className="hub-form-actions">
        <span className="spacer" />
        <button className="ghost" autoFocus disabled={busy} onClick={close}>{SET_COPY.cancel}</button>
        <button className="danger-button" disabled={busy} onClick={() => void run()}>{SET_COPY.deleteKind(what.kind)}</button>
      </div>
    </Dialog>
  );
}

interface ViewCtx {
  tracks: SetTrack[];
  rate: number;
  sel: Sel;
  select: (s: Sel) => void;
  edit: (lines: string[] | null, after?: (a: SetAnswer) => void) => Promise<void>;
  play: (scope: SetRunScope, what: string) => Promise<void>;
  open: (kind: InstanceKind, target: string) => void;
  run: ReturnType<typeof useSetRun>;
  flagged: Map<string, string>;
  rates: Record<string, number>;
  zoom: number;
  playhead: number;
  setPlayhead: (f: number) => void;
  /** The scene selected last: its tracks are marked on the timelines. */
  scene: SetScene | null;
}

function readDrag(e: ReactDragEvent, mime: string): unknown {
  try {
    const raw = e.dataTransfer?.getData(mime);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** The scenes: each plays its tracks' timelines together; its newest result is on its play button. */
function ScenesPanel({ scenes, ctx }: { scenes: SetScene[]; ctx: ViewCtx }) {
  const { sel, select, play, run } = ctx;
  return (
    <section className="hub-set-scenes" aria-label={SET_COPY.scenes}>
      <h2>{SET_COPY.scenes}</h2>
      {!scenes.length && <p className="dim small">{SET_COPY.noScenes}</p>}
      <ul>
        {scenes.map((s) => {
          const result = run.results.scenes[s.id];
          const on = sel?.kind === "scene" && sel.scene === s.id;
          return (
            <li key={s.id} className={`hub-set-scene ${colorClass(s.color)} ${on ? "on" : ""}`}>
              <button className="hub-set-play-scene ghost icon-button" aria-label={SET_COPY.playScene(s.title)} title={result ? INSTANCE_STATUS_LOOK[result].label : GOAL_STATUS_LOOK[s.status]?.label} onClick={() => void play({ kind: "scene", goalId: s.id }, s.title)}>
                {result ? <StatusMark look={INSTANCE_STATUS_LOOK[result]} size={12} /> : <HubIcon name="play" size={12} />}
              </button>
              <button className="hub-set-title" aria-pressed={on} onClick={() => select({ kind: "scene", scene: s.id })}>{s.title}</button>
              <span className="dim small" title={SET_COPY.trackCount(s.tracks.length)} aria-label={SET_COPY.trackCount(s.tracks.length)}>{s.tracks.length}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** A track's player, shown where a DAW shows a track's input and output: 0 is the editor's own player, N remote client N. */
function PlayerField({ t, edit }: { t: SetTrack; edit: ViewCtx["edit"] }) {
  return (
    <label className="hub-set-io small" title={SET_COPY.player}>
      <span>{SET_COPY.playerName(t.player)}</span>
      <input type="number" min={0} step={1} value={t.player} aria-label={SET_COPY.playerFor(t.title)}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isInteger(n) && n >= 0 && n !== t.player) void edit([SET_OPS.trackPlayer(t.id, n)]);
        }} />
    </label>
  );
}

/** A drag under way on a timeline: an instance moved (across tracks too) or trimmed by dx, dy pixels. */
interface Drag { track: string; id: string; mode: ArrangeDragMode; x0: number; y0: number; dx: number; dy: number; alt: boolean }

function Timelines({ ctx, onZoom }: { ctx: ViewCtx; onZoom: (z: number) => void }) {
  const { tracks, rate, zoom, playhead, setPlayhead, sel, select, edit, play, open, run, flagged, rates, scene } = ctx;
  const [drag, setDrag] = useState<Drag | null>(null);
  const frames = rulerFrames(Math.max(arrangeEnd(tracks.map((t) => t.layout)), run.detail?.length ?? 0), rate);
  const px = (f: number) => (f / rate) * zoom;
  const fr = (x: number) => (x / zoom) * rate;
  const width = px(frames);
  const step = arrangeStep(rate);
  const zi = ARRANGE_ZOOMS.indexOf(zoom as (typeof ARRANGE_ZOOMS)[number]);

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
    void edit(dragLines(t.id, inst, l, d.mode, df, { scale: clipScale(t.arrangement.rate || rate, rates[inst.target]), duplicate: dup, toTrack: to }), (a) => {
      const id = dup ? a.changed?.find((c) => c !== l.id) : l.id;
      if (id) select({ kind: "instance", track: to ?? t.id, id });
    });
  };
  const frameAt = (e: { clientX: number; currentTarget: HTMLElement }) => snapTo(fr(e.clientX - e.currentTarget.getBoundingClientRect().left), step);
  const laneDrop = (e: ReactDragEvent<HTMLElement>, t: SetTrack) => {
    e.preventDefault();
    const clip = readDrag(e, CLIP_MIME) as { kind?: InstanceKind; target?: string } | null;
    if (!clip?.kind || !clip.target) return;
    void edit([SET_OPS.add(t.id, clip.kind, clip.target, frameAt(e))], (a) => {
      const id = a.changed?.find((c) => a.tracks.find((x) => x.id === t.id)?.layout.some((l) => l.id === c));
      if (id) select({ kind: "instance", track: t.id, id });
    });
  };

  /** A clip from Clips dropped on a block replaces that instance's clip, keeping its place, name and color. */
  const blockDrop = (e: ReactDragEvent<HTMLElement>, t: SetTrack, l: InstanceLayout) => {
    e.preventDefault();
    e.stopPropagation();
    const clip = readDrag(e, CLIP_MIME) as { kind?: InstanceKind; target?: string } | null;
    const inst = t.arrangement.instances.find((i) => i.id === l.id);
    if (!clip?.kind || !clip.target || !inst) return;
    select({ kind: "instance", track: t.id, id: l.id });
    void edit(replaceLines(t.id, inst, { kind: clip.kind, target: clip.target }));
  };

  return (
    <div className="hub-set-arr">
      <div className="hub-set-zoom">
        <button className="ghost icon-button" aria-label={SET_COPY.zoomOut} disabled={zi <= 0} onClick={() => onZoom(ARRANGE_ZOOMS[Math.max(0, zi - 1)])}>-</button>
        <button className="ghost icon-button" aria-label={SET_COPY.zoomIn} disabled={zi >= ARRANGE_ZOOMS.length - 1} onClick={() => onZoom(ARRANGE_ZOOMS[Math.min(ARRANGE_ZOOMS.length - 1, zi + 1)])}>+</button>
      </div>
      <div className="hub-set-arr-grid" style={{ width: width + 240 }}>
        <div className="hub-set-row ruler">
          <div className="hub-set-label" />
          <div className="hub-set-ruler" style={{ width }} onPointerDown={(e) => setPlayhead(frameAt(e))}>
            {rulerTicks(frames, rate, zoom).map((s) => <span key={s} className="hub-set-tick small dim" style={{ left: px(s * rate) }}>{arrangeSeconds(s * rate, rate)}</span>)}
            <span className="hub-set-playhead" style={{ left: px(playhead) }} aria-hidden="true" />
          </div>
        </div>
        {tracks.map((t) => {
          const inScene = scene?.tracks.includes(t.id) ?? false;
          const status = scene ? run.results.sceneTracks[`${scene.id}/${t.id}`] : run.results.tracks[t.id];
          const tSel = sel?.kind === "track" && sel.track === t.id;
          return (
            <div key={t.id} className={`hub-set-row ${t.mute ? "muted" : ""} ${scene && !inScene ? "out-of-scene" : ""}`} style={{ height: ROW_H }}>
              <div className={`hub-set-label ${colorClass(t.color)} ${tSel ? "on" : ""}`}>
                {scene && <input type="checkbox" checked={inScene} aria-label={SET_COPY.inScene(scene.title, t.title)} title={SET_COPY.inScene(scene.title, t.title)} onChange={() => void edit([SET_OPS.sceneTrack(scene.id, t.id, !inScene)])} />}
                <button className="ghost icon-button" aria-label={SET_COPY.playTrack(t.title)} onClick={() => void play({ kind: "track", goalId: t.id }, t.title)}><HubIcon name="play" size={10} /></button>
                <button className="hub-set-title" aria-pressed={tSel} onClick={() => select({ kind: "track", track: t.id })}>
                  {status && <StatusMark look={INSTANCE_STATUS_LOOK[status]} size={10} />} {t.title}
                </button>
                <span className="hub-set-ms">
                  <button className={`hub-set-toggle mute ${t.mute ? "on" : ""}`} aria-pressed={t.mute} aria-label={`${SET_COPY.mute} ${t.title}`} title={SET_COPY.mute} onClick={() => void edit([SET_OPS.trackMute(t.id, !t.mute)])}>M</button>
                  <button className={`hub-set-toggle solo ${t.solo ? "on" : ""}`} aria-pressed={t.solo} aria-label={`${SET_COPY.solo} ${t.title}`} title={SET_COPY.solo} onClick={() => void edit([SET_OPS.trackSolo(t.id, !t.solo)])}>S</button>
                </span>
                <PlayerField t={t} edit={edit} />
              </div>
              <div className="hub-set-lane" style={{ width }} aria-label={t.title} role="group"
                onPointerDown={(e) => {
                  if (e.button !== 0 || e.target !== e.currentTarget) return;
                  setPlayhead(frameAt(e));
                  select({ kind: "track", track: t.id });
                }}
                onDragOver={(e) => Array.from(e.dataTransfer?.types ?? []).includes(CLIP_MIME) && e.preventDefault()}
                onDrop={(e) => laneDrop(e, t)}>
                {t.layout.map((l) => {
                  const key = `${t.id}/${l.id}`;
                  const st = run.results.instances[key];
                  const inst = t.arrangement.instances.find((i) => i.id === l.id);
                  const on = sel?.kind === "instance" && sel.track === t.id && sel.id === l.id;
                  const d = drag && drag.track === t.id && drag.id === l.id ? drag : null;
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
                      className={`hub-set-block kind-${l.kind} ${colorClass(inst?.color ?? t.color)} ${st ? `st-${st}` : ""} ${on ? "on" : ""} ${l.known ? "" : "unknown"} ${flagged.has(key) ? "flagged" : ""} ${d ? "dragging" : ""}`}
                      style={{ left, width: w, transform: dy ? `translateY(${dy}px)` : undefined }}
                      role="button" tabIndex={-1} aria-pressed={on}
                      aria-label={SET_COPY.block(l.name, arrangeSeconds(l.start, rate), arrangeSeconds(l.end, rate))}
                      title={[l.name, flagged.get(key), l.known ? null : SET_COPY.unknownLength, st ? INSTANCE_STATUS_LOOK[st].label : null, SET_COPY.blockHint].filter(Boolean).join("\n")}
                      onPointerDown={(e) => blockDown(e, t, l)} onPointerMove={blockMove} onPointerUp={(e) => blockUp(e, t, l)}
                      onDoubleClick={() => open(l.kind, l.target)}
                      onDragOver={(e) => Array.from(e.dataTransfer?.types ?? []).includes(CLIP_MIME) && e.preventDefault()}
                      onDrop={(e) => blockDrop(e, t, l)}
                    >
                      <span className="hub-set-edge start" data-edge="start" aria-hidden="true" />
                      <span className="hub-set-block-name">{l.name}</span>
                      {st === "running" && <span className="hub-set-progress" style={{ width: `${spanProgress(l.start, l.end, run.cursor) * 100}%` }} aria-hidden="true" />}
                      <span className="hub-set-edge end" data-edge="end" aria-hidden="true" />
                    </div>
                  );
                })}
                {!t.layout.length && <span className="hub-set-lane-empty small dim">{SET_COPY.emptyLane}</span>}
                <span className="hub-set-playhead" style={{ left: px(playhead) }} aria-hidden="true" />
                {run.cursor !== null && <span className="hub-set-cursor" style={{ left: px(run.cursor) }} aria-hidden="true" />}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Checks waiting on a person in the run playing now. */
function Verdicts({ runId, checks, detail }: { runId: string; checks: string[]; detail: ArrangementRun | null }) {
  const hub = useHub();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [done, setDone] = useState<string[]>([]);
  const nameOf = (check: string) => {
    const [key] = check.split(".");
    return detail?.instances.find((x) => x.key === key || x.id === key)?.name ?? key;
  };
  const answer = async (check: string, v: "pass" | "fail" | "skip") => {
    try {
      await api.set.verdict(runId, check, v, notes[check]?.trim() || undefined);
      setDone((d) => [...d, check]);
      hub.data.reload();
    } catch (e) {
      hub.notify((e as Error).message, "bad");
    }
  };
  const open = checks.filter((c) => !done.includes(c));
  if (!open.length) return null;
  return (
    <div className="hub-set-verdicts">
      {open.map((c) => (
        <div key={c} className="hub-card hub-set-verdict" role="group" aria-label={SET_COPY.needsVerdict(nameOf(c))}>
          <strong title={c}>{SET_COPY.needsVerdict(nameOf(c))}</strong>
          <input value={notes[c] ?? ""} onChange={(e) => setNotes((n) => ({ ...n, [c]: e.target.value }))} placeholder={SET_COPY.note} aria-label={SET_COPY.note} />
          <button onClick={() => void answer(c, "pass")}>{SET_COPY.pass}</button>
          <button onClick={() => void answer(c, "fail")}>{SET_COPY.fail}</button>
          <button className="ghost" onClick={() => void answer(c, "skip")}>{SET_COPY.skip}</button>
        </div>
      ))}
    </div>
  );
}

/** The Clips panel: both kinds, searched by the daemon, dragged onto timelines. */
function ClipBrowser({ picked, onPick, onOpen, onClips }: { picked: HubClipEntry | null; onPick: (c: HubClipEntry | null) => void; onOpen: (c: HubClipEntry) => void; onClips: (cs: HubClipEntry[]) => void }) {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<InstanceKind | undefined>(undefined);
  const [clips, setClips] = useState<HubClipEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      api.set.clips(q.trim(), kind).then((a) => {
        if (!live) return;
        setClips(a.clips);
        setError(null);
        onClips(a.clips);
      }, (e: Error) => live && setError(e.message));
    }, q ? 200 : 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, kind]);
  const kinds: Array<[InstanceKind | undefined, string]> = [[undefined, SET_COPY.kindAll], ["clip", SET_COPY.kindClip], ["script", SET_COPY.kindScript]];
  return (
    <section className="hub-set-browser" aria-label={SET_COPY.clips}>
      <h2>{SET_COPY.clips}</h2>
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={SET_COPY.search} aria-label={SET_COPY.search} />
      <div className="seg" role="group" aria-label={SET_COPY.clipType}>
        {kinds.map(([k, label]) => <button key={label} className={kind === k ? "on" : ""} aria-pressed={kind === k} onClick={() => setKind(k)}>{label}</button>)}
      </div>
      {error && <p className="banner warn small" role="alert">{error}</p>}
      {clips && !clips.length && <p className="dim small">{SET_COPY.noClips}</p>}
      <ul className="hub-set-clips">
        {(clips ?? []).map((c) => {
          const on = picked?.target === c.target && picked.kind === c.kind;
          return (
            <li key={`${c.kind}:${c.target}`}>
              <button className={`hub-set-clip kind-${c.kind} ${on ? "on" : ""}`} aria-pressed={on} draggable
                onClick={() => onPick(on ? null : c)}
                onDoubleClick={() => onOpen(c)}
                onDragStart={(e) => {
                  e.dataTransfer.setData(CLIP_MIME, JSON.stringify({ kind: c.kind, target: c.target }));
                  e.dataTransfer.setData("text/plain", c.target);
                  e.dataTransfer.effectAllowed = "copy";
                }}>
                <span className="hub-set-clip-name">{c.name}</span>
                <span className="dim small">{c.kind === "clip" ? SET_COPY.kindClip : SET_COPY.kindScript}{c.length ? `, ${arrangeSeconds(c.length, c.rate || 60)}` : ""}</span>
                {c.lastRun && <StatusMark look={INSTANCE_STATUS_LOOK[c.lastRun.outcome === "passed" ? "passed" : c.lastRun.outcome === "failed" ? "failed" : "skipped"]} size={10} />}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="dim small">{SET_COPY.browserHint}</p>
    </section>
  );
}

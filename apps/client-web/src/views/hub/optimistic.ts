/**
 * Edits drawn before the daemon answers them. A drag or a nudge is shown
 * where it was let go at once, as a ghost over the set (or an op over the
 * clip), while the edit goes out in the background. The answer replaces the
 * ghost in the same frame; a refusal drops it and the item slides back.
 */
import type { Clip, ClipTrack, InstanceLayout, SetTrackView as SetTrack } from "@ue-mcp-studio/shared";
import type { ArrangeDragMode, ClipOp } from "@ue-mcp-studio/client-core";

type Inst = SetTrack["arrangement"]["instances"][number];

/** One edit drawn ahead of its answer. */
export type Ghost =
  /** An instance at a new place: moved, trimmed, or moved to track `to`. `inst` is what its instance becomes. */
  | { kind: "place"; track: string; id: string; to: string; start: number; length: number; inst: Partial<Inst> }
  /** A copy of an instance on track `to` at `start`, under a stand-in id until the answer names it. */
  | { kind: "copy"; track: string; id: string; to: string; start: number; tempId: string }
  /** A track at a new place in the order. */
  | { kind: "order"; track: string; index: number };

/** The id a copy goes by until the daemon names it. */
export const COPY_ID = "~copy";

/**
 * The ghost for the lines dragLines sends for the same drag, or null when
 * those lines change nothing. Kept beside dragLines' rules: the start edge
 * never passes frame 0, the end, or a clip's own first frame.
 */
export function dragGhost(t: string, inst: Inst, l: InstanceLayout, mode: ArrangeDragMode, df: number, opts: { scale?: number; duplicate?: boolean; toTrack?: string } = {}): Ghost | null {
  const scale = opts.scale ?? 1;
  const to = opts.toTrack ?? t;
  if (mode === "move") {
    const start = Math.max(0, Math.round(l.start + df));
    if (opts.duplicate) return { kind: "copy", track: t, id: inst.id, to, start, tempId: COPY_ID };
    if (to === t && start === l.start) return null;
    return { kind: "place", track: t, id: inst.id, to, start, length: l.length, inst: { start } };
  }
  if (mode === "trimEnd") {
    const length = Math.max(1, l.length + df);
    if (length === l.length) return null;
    return { kind: "place", track: t, id: inst.id, to: t, start: l.start, length, inst: inst.kind === "clip" ? { out: (inst.in ?? 0) + length * scale } : { length } };
  }
  let d = Math.min(df, l.length - 1);
  d = Math.max(d, -l.start);
  if (inst.kind === "clip") d = Math.max(d, -(inst.in ?? 0) / scale);
  if (d === 0) return null;
  const start = l.start + d;
  return { kind: "place", track: t, id: inst.id, to: t, start, length: l.length - d, inst: inst.kind === "clip" ? { start, in: (inst.in ?? 0) + d * scale } : { start, length: l.length - d } };
}

const byStart = (a: { start: number }, b: { start: number }) => a.start - b.start;

/** The tracks with every ghost drawn over them, in order. Ghosts naming something gone are skipped. */
export function withGhosts(tracks: readonly SetTrack[], ghosts: readonly Ghost[]): SetTrack[] {
  let out = tracks.map((t) => ({ ...t, layout: [...t.layout], arrangement: { ...t.arrangement, instances: [...t.arrangement.instances] } }));
  const find = (id: string) => out.find((t) => t.id === id);
  for (const g of ghosts) {
    if (g.kind === "order") {
      const sorted = [...out].sort((a, b) => a.order - b.order);
      const from = sorted.findIndex((t) => t.id === g.track);
      if (from < 0) continue;
      const [moved] = sorted.splice(from, 1);
      sorted.splice(Math.max(0, Math.min(sorted.length, g.index)), 0, moved);
      out = sorted.map((t, i) => ({ ...t, order: i }));
      continue;
    }
    const src = find(g.track);
    const dst = find(g.to);
    const l = src?.layout.find((x) => x.id === g.id);
    const inst = src?.arrangement.instances.find((x) => x.id === g.id);
    if (!src || !dst || !l || !inst) continue;
    if (g.kind === "copy") {
      dst.layout = [...dst.layout, { ...l, id: g.tempId, start: g.start, end: g.start + l.length }].sort(byStart);
      dst.arrangement.instances = [...dst.arrangement.instances, { ...inst, id: g.tempId, start: g.start }];
      continue;
    }
    const placed: InstanceLayout = { ...l, start: g.start, end: g.start + g.length, length: g.length };
    const moved: Inst = { ...inst, ...g.inst } as Inst;
    src.layout = src.layout.filter((x) => x.id !== g.id);
    src.arrangement.instances = src.arrangement.instances.filter((x) => x.id !== g.id);
    dst.layout = [...dst.layout, placed].sort(byStart);
    dst.arrangement.instances = [...dst.arrangement.instances, moved];
  }
  return out;
}

/** The keys (track/id, or a track id) of the things a ghost moves, for sliding them back. */
export const ghostKey = (g: Ghost): string => (g.kind === "order" ? g.track : g.kind === "copy" ? `${g.to}/${g.tempId}` : `${g.to}/${g.id}`);

// ---------- The clip's piano roll ----------

/** The id a drawn note, key or region goes by until clip_edit names it. */
export const NEW_ID = "~new";

type Spanned = { id: string; start: number; length: number };

/**
 * A clip with the piano roll's move, trim and add ops applied as clip_edit
 * would: items are found by id across notes, keys, checks, regions and
 * events. Ops it does not draw ahead (set, delete, quantize) leave the clip
 * as it is, and their answer draws them.
 */
export function applyClipOps(clip: Clip, ops: readonly ClipOp[]): Clip {
  let c: Clip = clip;
  for (const op of ops) c = applyOne(c, op);
  return c;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function applyOne(c: Clip, op: ClipOp): Clip {
  if (op.op === "add") return addOne(c, op);
  if (op.op !== "move" && op.op !== "trim") return c;
  const id = String(op.id);
  const span = (x: Spanned): Spanned => {
    if (op.op === "move") {
      const to = num(op.to) ?? x.start + (num(op.by) ?? 0);
      return { ...x, start: to };
    }
    const start = num(op.start) ?? x.start;
    const end = num(op.end);
    return { ...x, start, length: end !== undefined ? end - start : num(op.length) ?? x.length };
  };
  const tracks = c.tracks?.map((t): ClipTrack => ({
    ...t,
    notes: t.notes?.map((n) => (n.id === id ? { ...n, ...span(n) } : n)),
    keys: t.keys?.map((k) => (k.id === id ? { ...k, t: span({ id, start: k.t, length: 0 }).start } : k)),
  }));
  return {
    ...c,
    ...(tracks ? { tracks } : {}),
    ...(c.checks ? { checks: c.checks.map((x) => (x.id === id ? { ...x, ...span(x) } : x)) } : {}),
    ...(c.events ? { events: c.events.map((e) => (e.id === id ? { ...e, at: span({ id, start: e.at, length: 0 }).start } : e)) } : {}),
    ...(c.regions ? { regions: c.regions.map((r) => {
      if (r.id !== id) return r;
      const s = span({ id, start: r.start, length: r.end - r.start });
      return { ...r, start: s.start, end: s.start + s.length };
    }) } : {}),
  };
}

function addOne(c: Clip, op: ClipOp): Clip {
  if (op.kind === "region") {
    const start = num(op.start) ?? 0;
    return { ...c, regions: [...(c.regions ?? []), { id: NEW_ID, name: String(op.name ?? ""), start, end: num(op.end) ?? start }] };
  }
  if (op.kind !== "note" && op.kind !== "key") return c;
  const track = String(op.track);
  return {
    ...c,
    tracks: c.tracks?.map((t) => {
      if (t.action !== track) return t;
      if (op.kind === "note") return { ...t, notes: [...(t.notes ?? []), { id: NEW_ID, start: num(op.start) ?? 0, length: num(op.length) ?? 1 }] };
      return { ...t, keys: [...(t.keys ?? []), { id: NEW_ID, t: num(op.time) ?? 0, v: op.value as never }] };
    }),
  };
}

/**
 * The hub's set of tracks and scenes as the Arrangement view draws it: the daemon's set routes, the op lines an edit, a drag or a key
 * becomes, the grid edits snap to, the run a view follows with its playhead
 * and results, and the copy. The daemon validates and lays out; the views
 * draw what it answers and send ops.
 */
import { ARRANGEMENT_FEATURE } from "@ue-mcp-studio/shared";
import type {
  ArrangementFinding,
  ArrangementRun,
  HubClipEntry,
  HubOverview,
  Instance,
  InstanceKind,
  InstanceLayout,
  InstanceStatus,
  PlanPlacement,
  PlanRun,
  RunDetail,
  RunRecord,
  SetAnswer,
  SetRunScope,
} from "@ue-mcp-studio/shared";
import { HUB_BASE, type HubRequest, type StatusLook } from "./hub.js";

const enc = encodeURIComponent;

/** Whether the daemon serves the set routes. */
export function arrangementOn(health: unknown): boolean {
  const features = Array.isArray(health) ? health : (health as { features?: unknown } | null)?.features;
  return Array.isArray(features) && features.includes(ARRANGEMENT_FEATURE);
}

/** The daemon's set routes under /v1/hub. Edits go as op lines (SET_OPS). */
export function setApi(request: HubRequest) {
  return {
    read: () => request<SetAnswer>("GET", `${HUB_BASE}/set`),
    edit: (lines: readonly string[]) => request<SetAnswer>("POST", `${HUB_BASE}/set/edit`, { ops: lines.join("\n") }),
    clips: (q = "", kind?: InstanceKind) => {
      const p = new URLSearchParams();
      if (q) p.set("q", q);
      if (kind) p.set("kind", kind);
      const s = p.toString();
      return request<{ clips: HubClipEntry[] }>("GET", `${HUB_BASE}/clips${s ? `?${s}` : ""}`);
    },
    run: (scope: SetRunScope, next?: boolean) => request<{ plan: PlanRun; placement?: PlanPlacement }>("POST", `${HUB_BASE}/run`, next ? { scope, next } : { scope }),
    runDetail: (runId: string) => request<RunDetail & { arrangement?: ArrangementRun }>("GET", `${HUB_BASE}/runs/${enc(runId)}`),
    verdict: (runId: string, check: string, verdict: "pass" | "fail" | "skip", note?: string) =>
      request<unknown>("POST", `${HUB_BASE}/runs/${enc(runId)}/verdict`, note ? { check, verdict, note } : { check, verdict }),
  };
}
export type SetApi = ReturnType<typeof setApi>;

// ---------- Op lines ----------

const q = (s: string): string => `"${s.replace(/"/g, "'")}"`;
const onOff = (on: boolean): string => (on ? "on" : "off");
const at = (f?: number): string => (f === undefined ? "" : ` at ${Math.max(0, Math.round(f))}`);
const kv = (k: string, v: number | null | undefined): string => (v === undefined ? "" : ` ${k}=${v === null ? "-" : Math.round(v * 1000) / 1000}`);

/** The set's ops in their text form, one line each, as ue-mcp's issue 2113 lists them. */
export const SET_OPS = {
  trackAdd: (name: string) => `track add ${q(name)}`,
  trackDelete: (t: string) => `track delete ${t}`,
  sceneDelete: (s: string) => `scene delete ${s}`,
  trackRename: (t: string, name: string) => `track rename ${t} ${q(name)}`,
  trackColor: (t: string, color: string) => `track color ${t} ${color}`,
  trackMove: (t: string, to: number) => `track move ${t} to ${to}`,
  trackMute: (t: string, on: boolean) => `track mute ${t} ${onOff(on)}`,
  trackSolo: (t: string, on: boolean) => `track solo ${t} ${onOff(on)}`,
  trackPlayer: (t: string, n: number) => `track player ${t} ${n}`,
  sceneAdd: (name: string) => `scene add ${q(name)}`,
  sceneInsert: (name: string, to: number) => `scene insert ${q(name)} at ${to}`,
  sceneRename: (s: string, name: string) => `scene rename ${s} ${q(name)}`,
  sceneColor: (s: string, color: string) => `scene color ${s} ${color}`,
  sceneDuplicate: (s: string) => `scene duplicate ${s}`,
  sceneMove: (s: string, to: number) => `scene move ${s} to ${to}`,
  sceneCapture: (s: string, frame?: number) => `scene capture ${s}${at(frame)}`,
  sceneTrack: (s: string, t: string, on: boolean) => `scene track ${s} ${on ? "add" : "remove"} ${t}`,
  add: (t: string, kind: InstanceKind, path: string, frame?: number) => `add ${t} ${kind} ${path}${at(frame)}`,
  duplicate: (t: string, i: string, frame?: number) => `duplicate ${t}/${i}${at(frame)}`,
  copy: (t: string, i: string, t2: string, frame?: number) => `copy ${t}/${i} to ${t2}${at(frame)}`,
  moveTo: (t: string, i: string, frame: number) => `move ${t}/${i} to ${Math.max(0, Math.round(frame))}`,
  moveBy: (t: string, i: string, by: number) => `move ${t}/${i} by ${Math.round(by)}`,
  moveToTrack: (t: string, i: string, t2: string, frame?: number) => `move ${t}/${i} to ${t2}${at(frame)}`,
  trim: (t: string, i: string, v: { in?: number | null; out?: number | null; length?: number | null }) => `trim ${t}/${i}${kv("in", v.in)}${kv("out", v.out)}${kv("length", v.length)}`,
  rename: (t: string, i: string, name: string) => `rename ${t}/${i} ${q(name)}`,
  color: (t: string, i: string, color: string) => `color ${t}/${i} ${color}`,
  remove: (t: string, i: string) => `delete ${t}/${i}`,
  unique: (t: string, i: string) => `unique ${t}/${i}`,
};

// ---------- Time ----------

/** Pixels per second of game time the zoom steps through. */
export const ARRANGE_ZOOMS = [20, 40, 80, 160, 320] as const;
export const ARRANGE_DEFAULT_ZOOM = 80;

/** Frames per grid step: a quarter second, or a whole second with `coarse` (Shift). */
export const arrangeStep = (rate: number, coarse = false): number => (coarse ? rate : Math.max(1, Math.round(rate / 4)));

/** A frame on the grid, never before 0. */
export const snapTo = (f: number, step: number): number => Math.max(0, step > 0 ? Math.round(f / step) * step : Math.round(f));

/** Frames as seconds of game time: "1.5 s". */
export const arrangeSeconds = (f: number, rate: number): string => `${(f / rate).toFixed(2).replace(/\.?0+$/, "") || "0"} s`;

/** Where the last instance on these timelines ends. */
export const arrangeEnd = (layouts: ReadonlyArray<readonly InstanceLayout[]>): number => layouts.reduce((m, l) => l.reduce((n, x) => Math.max(n, x.end), m), 0);

/** How long the ruler runs: ten seconds past the end, and never under thirty. */
export const rulerFrames = (end: number, rate: number): number => Math.max(end + rate * 10, rate * 30);

/** Ruler ticks, in seconds, spaced so labels never crowd at this zoom. */
export function rulerTicks(frames: number, rate: number, zoom: number): number[] {
  const every = [1, 2, 5, 10, 30, 60].find((s) => s * zoom >= 60) ?? 60;
  const out: number[] = [];
  for (let s = 0; s * rate <= frames; s += every) out.push(s);
  return out;
}

// ---------- Lines from drags and keys ----------

export type ArrangeDragMode = "move" | "trimStart" | "trimEnd";

/** Clip frames per track frame for a clip at `clipRate` on a track at `trackRate`. */
export const clipScale = (trackRate: number, clipRate?: number | null): number => (clipRate && clipRate > 0 && trackRate > 0 ? clipRate / trackRate : 1);

/**
 * The lines that move, duplicate or trim an instance on track `t` by `df`
 * frames, or move or copy it to track `toTrack`. A clip instance trims its in
 * and out points (in its own frames, `scale` clip frames per track frame); a
 * step-list instance changes the space it takes. Trimming the start keeps the
 * end where it is. Null when nothing changes.
 */
export function dragLines(t: string, inst: Instance, l: InstanceLayout, mode: ArrangeDragMode, df: number, opts: { scale?: number; duplicate?: boolean; toTrack?: string } = {}): string[] | null {
  const scale = opts.scale ?? 1;
  if (mode === "move") {
    const to = Math.max(0, l.start + df);
    if (opts.toTrack && opts.toTrack !== t) return [opts.duplicate ? SET_OPS.copy(t, inst.id, opts.toTrack, to) : SET_OPS.moveToTrack(t, inst.id, opts.toTrack, to)];
    if (opts.duplicate) return [SET_OPS.duplicate(t, inst.id, to)];
    return to === l.start ? null : [SET_OPS.moveTo(t, inst.id, to)];
  }
  if (mode === "trimEnd") {
    const length = Math.max(1, l.length + df);
    if (length === l.length) return null;
    return [inst.kind === "clip" ? SET_OPS.trim(t, inst.id, { out: (inst.in ?? 0) + length * scale }) : SET_OPS.trim(t, inst.id, { length })];
  }
  // The start edge: never before frame 0, never past the end, and a clip never before its own first frame.
  let d = Math.min(df, l.length - 1);
  d = Math.max(d, -l.start);
  if (inst.kind === "clip") d = Math.max(d, -(inst.in ?? 0) / scale);
  if (d === 0) return null;
  return inst.kind === "clip"
    ? [SET_OPS.trim(t, inst.id, { in: (inst.in ?? 0) + d * scale }), SET_OPS.moveBy(t, inst.id, d)]
    : [SET_OPS.trim(t, inst.id, { length: l.length - d }), SET_OPS.moveBy(t, inst.id, d)];
}

/**
 * The lines a finding's candidate stands for: the refused lines with the
 * missing path replaced, or a slot or instance whose clip is missing pointed
 * at the candidate. Null when the finding is not about a clip path.
 */
export function candidateLines(f: ArrangementFinding, candidate: string, refused: readonly string[] | null, set: Pick<SetAnswer, "tracks" | "scenes"> | null): string[] | null {
  if (refused?.some((l) => l.includes(f.id))) return refused.map((l) => l.split(f.id).join(candidate));
  if (f.field !== "target" || !set) return null;
  const [a, b] = f.id.split("/");
  const track = set.tracks.find((t) => t.id === a);
  const inst = track?.arrangement.instances.find((i) => i.id === b);
  return track && inst ? [SET_OPS.remove(track.id, inst.id), SET_OPS.add(track.id, inst.kind, candidate, inst.start)] : null;
}

/** The 400 body's findings, the refused one first. */
export function refusalFindings(body: unknown): ArrangementFinding[] {
  const b = (body ?? {}) as { finding?: ArrangementFinding; findings?: ArrangementFinding[] };
  const all = Array.isArray(b.findings) ? b.findings : [];
  return b.finding ? [b.finding, ...all.filter((f) => f.id !== b.finding!.id || f.field !== b.finding!.field)] : all;
}

/** The instance before or after `selected` on one timeline, by start. */
export function stepSelection(layout: readonly InstanceLayout[], selected: string | null, by: 1 | -1): string | null {
  const order = [...layout].sort((a, b) => a.start - b.start);
  if (!order.length) return null;
  const i = selected ? order.findIndex((l) => l.id === selected) : -1;
  if (i < 0) return (by > 0 ? order[0] : order[order.length - 1]).id;
  return order[Math.max(0, Math.min(order.length - 1, i + by))].id;
}

/** A name for a new track or scene that the set does not have yet: "Track 3". */
export function nextName(base: string, taken: readonly string[]): string {
  for (let n = taken.length + 1; ; n++) if (!taken.includes(`${base} ${n}`)) return `${base} ${n}`;
}

// ---------- Runs ----------

const SET_SCOPES = ["track", "scene", "arrangement"];

/** The set run playing now: the plan on the editor, when it runs part of the set and its run has started. */
export function activeSetRun(o: Pick<HubOverview, "queue">): { planId: string; runId: string } | null {
  const cur = o.queue.current;
  if (!cur || !SET_SCOPES.includes((cur.scope as { kind: string }).kind)) return null;
  const item = [...cur.items].reverse().find((i) => i.runId);
  return item?.runId ? { planId: cur.id, runId: item.runId } : null;
}

/**
 * The newest result of every scene, instance and track. Keys: a scene's id;
 * "scene/track" for a track in a scene's newest run; "track/instance"; a track's id.
 */
export interface SetResults {
  scenes: Record<string, InstanceStatus>;
  sceneTracks: Record<string, InstanceStatus>;
  instances: Record<string, InstanceStatus>;
  tracks: Record<string, InstanceStatus>;
}
export const emptyResults = (): SetResults => ({ scenes: {}, sceneTracks: {}, instances: {}, tracks: {} });

const outcomeStatus = (outcome: string): InstanceStatus =>
  outcome === "passed" ? "passed" : outcome === "failed" || outcome === "error" || outcome === "crashed" ? "failed" : outcome === "running" ? "running" : outcome === "needs_you" ? "awaiting_verdict" : "skipped";

/** Fold one run's results in; what is already there is newer and stays unless `over` (the live run). */
export function foldRun(r: SetResults, run: ArrangementRun, outcome: string | null, target: string, over = false): SetResults {
  const n: SetResults = { scenes: { ...r.scenes }, sceneTracks: { ...r.sceneTracks }, instances: { ...r.instances }, tracks: { ...r.tracks } };
  const put = (m: Record<string, InstanceStatus>, k: string, v: InstanceStatus) => {
    if (over || !(k in m)) m[k] = v;
  };
  for (const i of run.instances) put(n.instances, `${i.goalId}/${i.id}`, i.status);
  for (const t of run.tracks ?? []) {
    put(n.tracks, t.goalId, t.status as InstanceStatus);
    if (run.kind === "scene") put(n.sceneTracks, `${target}/${t.goalId}`, t.status as InstanceStatus);
  }
  if (run.kind === "scene" && outcome) put(n.scenes, target, outcomeStatus(outcome));
  return n;
}

/** The newest results from the overview's recent runs, newest first. */
export function setResults(recent: readonly RunRecord[]): SetResults {
  let r = emptyResults();
  for (const rec of recent) {
    const arr = (rec as RunRecord & { arrangement?: ArrangementRun }).arrangement;
    if (arr && SET_SCOPES.includes(rec.kind as string)) r = foldRun(r, arr, rec.outcome, rec.target);
  }
  return r;
}

/** What the segment clip runs have said: each one's position, and the checks waiting on a person. */
export interface SegmentLive {
  seen: number;
  position: Record<string, number>;
  awaiting: Record<string, string[]>;
}
export const emptySegmentLive = (): SegmentLive => ({ seen: 0, position: {}, awaiting: {} });

/** Fold the daemon's clip.position and clip.verdict_requested events for these segment runs. */
export function foldSegmentEvents(live: SegmentLive, events: ReadonlyArray<{ id: number; type: string; data?: Record<string, unknown> }>, runIds: ReadonlySet<string>): SegmentLive {
  let n = live;
  for (const e of events) {
    if (e.id <= live.seen) continue;
    const runId = e.data?.runId;
    if (typeof runId !== "string" || !runIds.has(runId)) continue;
    if (e.type === "clip.position" && typeof e.data?.position === "number") n = { ...n, position: { ...n.position, [runId]: e.data.position } };
    else if (e.type === "clip.verdict_requested") n = { ...n, awaiting: { ...n.awaiting, [runId]: Array.isArray(e.data?.awaiting) ? (e.data!.awaiting as string[]) : [] } };
  }
  const last = events.length ? events[events.length - 1].id : live.seen;
  return n === live && last <= live.seen ? live : { ...n, seen: Math.max(live.seen, last) };
}

/** The playhead during a run: the running segment's offset plus where its clip run is. Null when nothing plays. */
export function arrangementCursor(run: ArrangementRun | null | undefined, live: SegmentLive): number | null {
  if (!run) return null;
  const seg = run.segments.find((s) => s.state === "running" && s.runId);
  if (!seg?.runId) return null;
  const p = live.position[seg.runId];
  return seg.offset + (typeof p === "number" ? p : 0);
}

/** How far a playing span is, 0 to 1, at the playhead. */
export const spanProgress = (start: number, end: number, cursor: number | null): number =>
  cursor === null || end <= start ? 0 : Math.max(0, Math.min(1, (cursor - start) / (end - start)));

export const INSTANCE_STATUS_LOOK: Record<InstanceStatus, StatusLook> = {
  pending: { label: "Waiting", glyph: "queued", tone: "idle" },
  running: { label: "Playing", glyph: "running", tone: "run" },
  passed: { label: "Passed", glyph: "check", tone: "ok" },
  failed: { label: "Failed", glyph: "fail", tone: "bad" },
  skipped: { label: "Skipped", glyph: "skip", tone: "idle" },
  awaiting_verdict: { label: "Needs your verdict", glyph: "needs", tone: "attention" },
};

// ---------- Copy ----------

export const SET_COPY = {
  arrangement: "Arrangement",
  notOffered: "Update ue-mcp to use the Arrangement.",
  play: "Play",
  stop: "Stop",
  playArrangement: "Play every track from the start, respecting Mute and Solo (Space)",
  playTrack: (title: string) => `Play ${title}`,
  playScene: (title: string) => `Play ${title}`,
  addTrack: "Add track",
  addTrackHint: "Add track (Ctrl+T)",
  addScene: "Add scene",
  track: "Track",
  scene: "Scene",
  scenes: "Scenes",
  noScenes: "A scene plays chosen tracks together. Add one, select it, then check the tracks it plays.",
  inScene: (scene: string, track: string) => `${track} plays in ${scene}`,
  trackCount: (n: number) => `${n} ${n === 1 ? "track" : "tracks"}`,
  emptySet: "No tracks yet. Add a track, then drag clips onto its timeline.",
  emptyLane: "Drag a clip here from Clips.",
  mute: "Mute",
  solo: "Solo",
  player: "Player: 0 is the editor, 1 and up are remote clients",
  playerFor: (title: string) => `Player for ${title}`,
  playerName: (n: number) => (n === 0 ? "Editor" : `Client ${n}`),
  moveUp: "Move up",
  moveDown: "Move down",
  clips: "Clips",
  search: "Search clips",
  clipType: "Clip type",
  kindAll: "All",
  kindClip: "Timeline",
  kindScript: "Script",
  noClips: "No clips match.",
  browserHint: "Drag a clip onto a track, or select one and press I to add it at the playhead.",
  selection: "Selection",
  name: "Name",
  color: "Color",
  duplicate: "Duplicate",
  duplicateHint: "Duplicate (Ctrl+D)",
  makeUnique: "Make unique",
  makeUniqueHint: "Copy the clip asset and use the copy here only",
  remove: "Delete",
  deleteTitle: (kind: "track" | "scene", title: string) => `Delete the ${kind} "${title}"?`,
  deleteTrackKeeps: "Its timeline goes with it. The clips on it stay in the library and keep their past runs.",
  deleteSceneKeeps: "The tracks it plays stay as they are.",
  deleteUnlinks: "These scenes will stop playing it:",
  deleteKind: (kind: "track" | "scene") => (kind === "track" ? "Delete track" : "Delete scene"),
  deleted: (title: string) => `Deleted ${title}`,
  cancel: "Cancel",
  open: "Open clip",
  copied: (name: string) => `Copied ${name}`,
  block: (name: string, from: string, to: string) => `${name}, ${from} to ${to}`,
  blockHint: "Double-click to open",
  unknownLength: "Length unknown: the clip could not be read",
  useCandidate: (c: string) => `Use ${c}`,
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  needsVerdict: (name: string) => `${name} needs your verdict`,
  pass: "Pass",
  fail: "Fail",
  skip: "Skip",
  note: "Note (optional)",
  keys: "Shortcuts",
  keyList: [
    ["Drag", "Move a clip, drag an edge to trim it, Alt-drag to duplicate it"],
    ["Space", "Play the Arrangement, or stop"],
    ["Enter", "Play the selected scene or track, or open the selected clip"],
    ["Left, Right", "Move the selected clip by a quarter second (Shift: a second); with no clip selected, move the playhead"],
    ["Up, Down", "Move the selected clip to the next track; with no clip selected, select the next track or scene"],
    ["Alt + Left, Right", "Trim the selected clip's end (Shift: its start)"],
    ["Alt + Up, Down", "Reorder the selected track or scene"],
    ["Ctrl + D", "Duplicate"],
    ["Ctrl + C, Ctrl + V", "Copy the clip; paste it on the selected track at the playhead"],
    ["Delete", "Delete"],
    ["F2", "Rename"],
    ["Ctrl + T", "Add a track"],
    ["Ctrl + I", "Insert a scene above the selected one"],
    ["I", "Add the clip selected in Clips at the playhead"],
    [", and .", "Select the previous or next clip"],
    ["Escape", "Clear the selection"],
  ] as ReadonlyArray<readonly [string, string]>,
  colorName: (c: string) => c[0].toUpperCase() + c.slice(1),
};

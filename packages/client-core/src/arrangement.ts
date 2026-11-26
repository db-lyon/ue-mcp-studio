/**
 * The hub's set of tracks and scenes as the Arrangement view draws it: the daemon's set routes, the op lines an edit, a drag or a key
 * becomes, the grid edits snap to, the run a view follows with its playhead
 * and results, and the copy. The daemon validates and lays out; the views
 * draw what it answers and send ops.
 */
import { ARRANGEMENT_DEFAULT_RATE, ARRANGEMENT_FEATURE, ARRANGEMENTS_FEATURE } from "@ue-mcp-studio/shared";
import type {
  ArrangementFinding,
  ArrangementInfo,
  ArrangementsView,
  ArrangementRun,
  HubClipEntry,
  HubOverview,
  Instance,
  InstanceKind,
  InstanceLayout,
  InstanceStatus,
  Performer,
  PerformersView,
  PlanPlacement,
  PlanRun,
  RunDetail,
  RunRecord,
  SetAnswer,
  SetRunScope,
} from "@ue-mcp-studio/shared";
import { HUB_BASE, type HubRequest, type StatusLook } from "./hub.js";
import { performerText, placePerformerFindings } from "./performers.js";

const enc = encodeURIComponent;

/** Whether the daemon serves the set routes. */
export function arrangementOn(health: unknown): boolean {
  const features = Array.isArray(health) ? health : (health as { features?: unknown } | null)?.features;
  return Array.isArray(features) && features.includes(ARRANGEMENT_FEATURE);
}

/** Whether the daemon serves a project's named arrangements (GET /hub/arrangements and the `arrangement` the set routes take). */
export function arrangementsOn(health: unknown): boolean {
  const features = Array.isArray(health) ? health : (health as { features?: unknown } | null)?.features;
  return Array.isArray(features) && features.includes(ARRANGEMENTS_FEATURE);
}

/**
 * The daemon's set routes under /v1/hub. Edits go as op lines (SET_OPS).
 * `arrangement` names which arrangement; without it the daemon answers its
 * first one, as a daemon that predates arrangements always does.
 */
export function setApi(request: HubRequest) {
  const of = (arrangement?: string | null) => (arrangement ? `?arrangement=${enc(arrangement)}` : "");
  return {
    read: (arrangement?: string | null) => request<SetAnswer>("GET", `${HUB_BASE}/set${of(arrangement)}`),
    edit: (lines: readonly string[], arrangement?: string | null) => request<SetAnswer>("POST", `${HUB_BASE}/set/edit`, arrangement ? { ops: lines.join("\n"), arrangement } : { ops: lines.join("\n") }),
    /** What a track can drive: the players, then the open level's actors (a daemon with hub.performers). */
    performers: (arrangement?: string | null) => request<PerformersView>("GET", `${HUB_BASE}/performers${of(arrangement)}`),
    arrangements: () => request<ArrangementsView>("GET", `${HUB_BASE}/arrangements`),
    createArrangement: (title: string, level?: string | null) => request<{ arrangement: ArrangementInfo }>("POST", `${HUB_BASE}/arrangements`, level ? { title, level } : { title }),
    updateArrangement: (id: string, change: { title?: string; level?: string | null }) => request<{ arrangement: ArrangementInfo }>("PUT", `${HUB_BASE}/arrangements/${enc(id)}`, change),
    duplicateArrangement: (id: string, title?: string) => request<{ arrangement: ArrangementInfo }>("POST", `${HUB_BASE}/arrangements/${enc(id)}/duplicate`, title ? { title } : {}),
    deleteArrangement: (id: string) => request<void>("DELETE", `${HUB_BASE}/arrangements/${enc(id)}`),
    clips: (q = "", kind?: InstanceKind) => {
      const p = new URLSearchParams();
      if (q) p.set("q", q);
      if (kind) p.set("kind", kind);
      const s = p.toString();
      return request<{ clips: HubClipEntry[] }>("GET", `${HUB_BASE}/clips${s ? `?${s}` : ""}`);
    },
    /** `runId` names the run once the plan started at once; null while it is queued or waiting. */
    run: (scope: SetRunScope, next?: boolean) => request<{ plan: PlanRun; placement?: PlanPlacement; runId?: string | null }>("POST", `${HUB_BASE}/run`, next ? { scope, next } : { scope }),
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
  /** A new track that drives this performer (a daemon with hub.performers). */
  trackAddFor: (name: string, p: Performer) => `track add ${q(name)} performer=${performerText(p)}`,
  trackPerformer: (t: string, p: Performer) => `track performer ${t} ${performerText(p)}`,
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
  /** Point an instance at another clip; naming a kind changes it (and drops the trim). */
  retarget: (t: string, i: string, path: string, kind?: InstanceKind) => `retarget ${t}/${i}${kind ? ` ${kind}` : ""} ${path}`,
};

/** The line replacing instance `i`'s clip with `clip`, or null when it already plays that clip. */
export function replaceLines(t: string, inst: Pick<Instance, "id" | "kind" | "target">, clip: { kind: InstanceKind; target: string }): string[] | null {
  if (clip.kind === inst.kind && clip.target === inst.target) return null;
  return [SET_OPS.retarget(t, inst.id, clip.target, clip.kind === inst.kind ? undefined : clip.kind)];
}

// ---------- Time ----------

/** Pixels per second of game time: the default, and the range zooming stays in, from a long overview to single frames. */
export const ARRANGE_DEFAULT_ZOOM = 80;
export const ARRANGE_ZOOM_MIN = 4;
export const ARRANGE_ZOOM_MAX = 1280;

/** A zoom inside the range. */
export const clampZoom = (z: number): number => Math.min(ARRANGE_ZOOM_MAX, Math.max(ARRANGE_ZOOM_MIN, Number.isFinite(z) ? z : ARRANGE_DEFAULT_ZOOM));

/** One step in (1) or out (-1), as + and - take it: half again, or two thirds. */
export const zoomStep = (z: number, dir: 1 | -1): number => clampZoom(dir > 0 ? z * 1.5 : z / 1.5);

/** The zoom that shows frames `from` to `to` across `width` pixels, never closer than half a second across. */
export const zoomToFit = (from: number, to: number, rate: number, width: number): number =>
  clampZoom(Math.max(1, width) / Math.max(0.5, (to - from) / (rate || ARRANGEMENT_DEFAULT_RATE)));

/** Frames as a clock: "0:05", "1:30", or with hundredths, "0:01.25", for the playhead's position. */
export function arrangeClock(f: number, rate: number, hundredths = false): string {
  const total = Math.max(0, f) / (rate || ARRANGEMENT_DEFAULT_RATE);
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  if (!hundredths) return `${m}:${String(Math.floor(s + 1e-6)).padStart(2, "0")}`;
  const cs = Math.round(s * 100);
  return `${m + Math.floor(cs / 6000)}:${(((cs % 6000) / 100).toFixed(2)).padStart(5, "0")}`;
}

/** Frames per grid step: a quarter second, or a whole second with `coarse` (Shift). */
export const arrangeStep = (rate: number, coarse = false): number => (coarse ? rate : Math.max(1, Math.round(rate / 4)));

/** A frame on the grid, never before 0. */
export const snapTo = (f: number, step: number): number => Math.max(0, step > 0 ? Math.round(f / step) * step : Math.round(f));

/** Frames as seconds of game time: "1.5 s". */
export const arrangeSeconds = (f: number, rate: number): string => `${(f / rate).toFixed(2).replace(/\.?0+$/, "") || "0"} s`;

/** The arrangement run from the playhead (`at` frames at `rate`): from the start when it is at 0. `arrangementId` names which arrangement plays. */
export const arrangementFromPlayhead = (at: number, rate: number, arrangementId?: string | null): SetRunScope => ({
  kind: "arrangement",
  ...(at > 0 ? { from: Math.round(((at * ARRANGEMENT_DEFAULT_RATE) / (rate || ARRANGEMENT_DEFAULT_RATE)) * 1000) / 1000 } : {}),
  ...(arrangementId ? { arrangementId } : {}),
});

/** Whether a plan is another arrangement's: the Arrangement view shows only its own runs. A plan without an arrangement (an older daemon's) is anyone's. */
export const otherArrangement = (plan: { arrangementId?: string } | null | undefined, arrangementId: string | null | undefined): boolean =>
  !!plan?.arrangementId && !!arrangementId && plan.arrangementId !== arrangementId;

/** Where the last instance on these timelines ends. */
export const arrangeEnd = (layouts: ReadonlyArray<readonly InstanceLayout[]>): number => layouts.reduce((m, l) => l.reduce((n, x) => Math.max(n, x.end), m), 0);

/** How long the ruler runs: ten seconds past the end, and never under thirty. */
export const rulerFrames = (end: number, rate: number): number => Math.max(end + rate * 10, rate * 30);

/** Ruler ticks, in seconds, spaced so labels never crowd at this zoom. */
export function rulerTicks(frames: number, rate: number, zoom: number): number[] {
  const every = rulerEvery(zoom);
  const out: number[] = [];
  for (let s = 0; s * rate <= frames; s += every) out.push(s);
  return out;
}

/** Seconds between labelled ruler ticks at this zoom: the closest spacing at least 60 pixels apart. */
export const rulerEvery = (zoom: number): number => [0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600].find((s) => s * zoom >= 60) ?? 600;

/** Seconds between the unlabelled grid lines between labelled ticks: each tick split in four or five, never under 8 pixels apart. */
export function rulerMinor(zoom: number): number {
  const every = rulerEvery(zoom);
  const parts = [5, 10, 30, 300].includes(every) ? 5 : every === 60 || every === 600 ? 6 : 4;
  return every / parts * zoom >= 8 ? every / parts : every;
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
 * missing path replaced, or an instance whose clip is missing pointed at the
 * candidate in place, keeping its trim, name and color. Null when the
 * finding is not about a clip path.
 */
export function candidateLines(f: ArrangementFinding, candidate: string, refused: readonly string[] | null, set: Pick<SetAnswer, "tracks" | "scenes"> | null): string[] | null {
  if (refused?.some((l) => l.includes(f.id))) return refused.map((l) => l.split(f.id).join(candidate));
  if (f.field !== "target" || !set) return null;
  const [a, b] = f.id.split("/");
  const track = set.tracks.find((t) => t.id === a);
  const inst = track?.arrangement.instances.find((i) => i.id === b);
  return track && inst ? [SET_OPS.retarget(track.id, inst.id, candidate)] : null;
}

/** The 400 body's findings, the refused one first. */
export function refusalFindings(body: unknown): ArrangementFinding[] {
  const b = (body ?? {}) as { finding?: ArrangementFinding; findings?: ArrangementFinding[] };
  const all = Array.isArray(b.findings) ? b.findings : [];
  return b.finding ? [b.finding, ...all.filter((f) => f.id !== b.finding!.id || f.field !== b.finding!.field)] : all;
}

/**
 * The findings the Arrangement shows: a refused edit's first, then the set's.
 * A scene's own findings are left out, since scenes belong to the Session
 * view; one about a track or an instance stays. A performer finding a
 * scene's composition carries is about an instance, and is placed on it.
 */
export function arrangementFindings(set: Pick<SetAnswer, "findings" | "tracks" | "scenes">, refused: readonly ArrangementFinding[] = []): ArrangementFinding[] {
  const scenes = new Set(set.scenes.map((s) => s.id));
  const tracks = new Set(set.tracks.map((t) => t.id));
  const own = placePerformerFindings(set.findings, set).filter((f) => {
    const head = f.id.split("/")[0];
    return !(scenes.has(head) && !tracks.has(head)) && !refused.some((r) => r.id === f.id && r.field === f.field);
  });
  return [...refused, ...own];
}

/** The track, and the instance on it, a finding is about; null when it names neither. */
export function findingPlace(f: Pick<ArrangementFinding, "id">, set: Pick<SetAnswer, "tracks">): { track: string; instance?: string } | null {
  const [a, b] = f.id.split("/");
  const track = set.tracks.find((t) => t.id === a);
  if (!track) return null;
  return b && track.layout.some((l) => l.id === b) ? { track: track.id, instance: b } : { track: track.id };
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

/**
 * The set run playing now. A run this view started is known by the id
 * POST /hub/run answered with, while its plan is on the editor. One started
 * elsewhere (an agent, a schedule) is the queue's current plan when it plays
 * part of the set, by the run its item records.
 */
export function activeSetRun(o: Pick<HubOverview, "queue">, mine?: { planId: string; runId: string } | null, arrangementId?: string | null): { planId: string; runId: string } | null {
  const cur = o.queue.current;
  if (!cur || !SET_SCOPES.includes((cur.scope as { kind: string }).kind) || otherArrangement(cur, arrangementId)) return null;
  if (mine && mine.planId === cur.id) return mine;
  const item = [...cur.items].reverse().find((i) => i.runId);
  return item?.runId ? { planId: cur.id, runId: item.runId } : null;
}

/** The manual checks waiting in a run, each with the name of the instance it is on. */
export function awaitingChecks(run: ArrangementRun | null | undefined): Array<{ check: string; instruction: string; name: string }> {
  return (run?.instances ?? []).flatMap((i) => (i.awaiting ?? []).map((a) => ({ ...a, name: i.name })));
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

/** Where each segment clip run is, from its clip.position events. */
export interface SegmentLive {
  seen: number;
  position: Record<string, number>;
}
export const emptySegmentLive = (): SegmentLive => ({ seen: 0, position: {} });

/** Fold the daemon's clip.position events for these segment runs. */
export function foldSegmentEvents(live: SegmentLive, events: ReadonlyArray<{ id: number; type: string; data?: Record<string, unknown> }>, runIds: ReadonlySet<string>): SegmentLive {
  let n = live;
  for (const e of events) {
    if (e.id <= live.seen) continue;
    const runId = e.data?.runId;
    if (typeof runId !== "string" || !runIds.has(runId)) continue;
    if (e.type === "clip.position" && typeof e.data?.position === "number") n = { ...n, position: { ...n.position, [runId]: e.data.position } };
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
  // A project's arrangements: the list, and the switcher in the transport.
  arrangements: "Arrangements",
  arrangementsLead: "Each arrangement has its own tracks, scenes and level. Clips are shared by all of them.",
  newArrangement: "New arrangement",
  switcher: "Arrangement shown",
  allArrangements: "All arrangements",
  openArrangement: (title: string) => `Open ${title}`,
  arrangementCounts: (tracks: number, scenes: number) => `${tracks} ${tracks === 1 ? "track" : "tracks"}, ${scenes} ${scenes === 1 ? "scene" : "scenes"}`,
  noLevel: "Opens no level",
  levelOf: (level: string) => `Opens ${level.split("/").pop()}`,
  lastRun: (outcome: string, when: string) => `Last run ${outcome}, ${when}`,
  neverRun: "Not run yet",
  rename: "Rename",
  setLevel: "Level",
  duplicateArrangement: "Duplicate",
  deleteArrangement: "Delete",
  arrangementTitle: "Name",
  levelLabel: "Level",
  levelPlaceholder: "/Game/Maps/MyMap",
  levelHelp: "The map a run of this arrangement opens before Play In Editor starts. Leave it empty to play whichever map is open.",
  create: "Create",
  save: "Save",
  renameTitle: (title: string) => `Rename "${title}"`,
  levelTitle: (title: string) => `Level for "${title}"`,
  deleteArrangementTitle: (title: string) => `Delete the arrangement "${title}"?`,
  deleteArrangementKeeps: (tracks: number, scenes: number) => `Its ${tracks} ${tracks === 1 ? "track" : "tracks"} and ${scenes} ${scenes === 1 ? "scene" : "scenes"} are deleted with it. Clips stay in Clips with their past runs.`,
  deleteLast: "This is the project's only arrangement. Create another before deleting it.",
  created: (title: string) => `Created ${title}`,
  duplicated: (title: string) => `Duplicated as ${title}`,
  deletedArrangement: (title: string) => `Deleted ${title}`,
  play: "Play",
  stop: "Stop",
  playArrangement: "Play from the playhead, or from the loop range when Loop is on (Space)",
  stopHint: "Stop (Space)",
  arrangementFrom: (at: string) => `Arrangement from ${at}`,
  playTrack: (title: string) => `Play ${title} from the start`,
  transport: "Transport",
  zoom: "Zoom",
  position: "Playhead position",
  loop: "Loop",
  loopHint: "Repeat the loop range (Ctrl+L: set it to the selection)",
  loopRange: "Loop range",
  addTrack: "Add track",
  addTrackHint: "Add track (Ctrl+T)",
  track: "Track",
  dropHere: "Drop clips here",
  dropHint: "Dropping a clip here adds a track for it.",
  mute: "Mute",
  solo: "Solo",
  player: "The player this track drives: the editor or a client",
  playerFor: (title: string) => `Player for ${title}`,
  playerName: (n: number) => (n === 0 ? "Editor" : `Client ${n}`),
  /** The player as the narrow track header shows it, with the full name on hover. */
  playerShort: (n: number) => (n === 0 ? "Ed" : `C${n}`),
  moveUp: "Move up",
  moveDown: "Move down",
  clips: "Clips",
  search: "Search clips",
  clipType: "Clip type",
  kindAll: "All",
  kindClip: "Timeline",
  kindScript: "Script",
  noClips: "No clips match.",
  browserHint: "Drag a clip onto a track, or onto a clip to replace it. Double-click a clip to add it to the selected track at the playhead.",
  showClips: "Show or hide Clips (Ctrl+Alt+B)",
  popOut: "Open Clips in its own window",
  poppedOut: "Clips is open in its own window.",
  bringBack: "Show Clips here",
  focusWindow: "Show the Clips window",
  add: (name: string) => `Add ${name}`,
  addTo: (track: string, at: string) => `Adds to ${track} at ${at}`,
  addToNew: (at: string) => `Adds to a new track at ${at}`,
  pickedGoes: (name: string, track: string | null, at: string) => `${name} goes to ${track ?? "a new track"} at ${at}`,
  openClip: (name: string) => `Open ${name}`,
  noArrangement: "Open the Arrangement in Studio to add clips from here.",
  selection: "Selection",
  name: "Name",
  color: "Color",
  duplicate: "Duplicate",
  duplicateHint: "Duplicate (Ctrl+D)",
  makeUnique: "Make unique",
  makeUniqueHint: "Copy the clip asset and use the copy here only",
  replace: (name: string) => `Replace with ${name}`,
  replaceHint: "Replace this clip with the one selected in Clips, keeping its position, name and color (R)",
  remove: "Delete",
  renameHint: "Double-click or press F2 to rename",
  reorderHint: "Drag up or down to reorder",
  /** A toast when an edit drawn ahead of its answer was refused and put back. */
  putBack: (why: string) => `Put back: ${why}`,
  deleteTitle: (title: string) => `Delete the track "${title}"?`,
  deleteTrackKeeps: "Its timeline is deleted with it. The clips it used stay in Clips and keep their past runs.",
  deleteUnlinks: "These scenes will stop playing it:",
  deleteTrack: "Delete track",
  deleted: (title: string) => `Deleted ${title}`,
  cancel: "Cancel",
  open: "Open clip",
  copied: (name: string) => `Copied ${name}`,
  block: (name: string, from: string, to: string) => `${name}, ${from} to ${to}`,
  blockHint: "Double-click to open",
  unknownLength: "Length unknown: the clip could not be read",
  reserved: "Script playtest: its steps have no fixed length, so the block shows the time reserved for it",
  useCandidate: (c: string) => `Use ${c}`,
  warnings: (n: number) => `${n} ${n === 1 ? "warning" : "warnings"}`,
  warningsTitle: "Warnings",
  showWarning: "Show",
  zoomIn: "Zoom in (+)",
  zoomOut: "Zoom out (-)",
  zoomFit: "Zoom to fit all tracks (W)",
  zoomSelection: "Zoom to the selection (Z)",
  needsVerdict: (name: string) => `${name} needs your verdict`,
  pass: "Pass",
  fail: "Fail",
  skip: "Skip",
  note: "Note (optional)",
  keys: "Shortcuts",
  keyList: [
    ["Drag", "Move a clip, or drag its edge to trim it (Alt: duplicate it)"],
    ["Drag from Clips", "Drop on a track to add the clip, on a clip to replace it, or below the tracks to add a track for it"],
    ["Space", "Play from the playhead (or the loop range when Loop is on), or stop"],
    ["Home, End", "Move the playhead to the start or the end"],
    ["Enter", "Play the selected track, or open the selected clip"],
    ["Left, Right", "Move the selected clip by a quarter second (Shift: a second); with no clip selected, move the playhead"],
    ["Up, Down", "Move the selected clip to the track above or below; with no clip selected, select the track above or below"],
    ["Alt + Left, Right", "Trim the selected clip's end (Shift: its start)"],
    ["Alt + Up, Down", "Reorder the selected track (or drag its header)"],
    ["Escape while dragging", "Cancel the drag"],
    ["Ctrl + D", "Duplicate the selected clip"],
    ["Ctrl + C, X, V", "Copy or cut the selected clip; paste it on the selected track at the playhead"],
    ["Delete, Backspace", "Delete the selected clip or track"],
    ["Ctrl + R, F2", "Rename the selected clip or track"],
    ["Ctrl + T", "Add a track"],
    ["Ctrl + L", "Set the loop range to the selection and turn Loop on"],
    ["Ctrl + Alt + B", "Show or hide Clips"],
    ["I", "Add the clip selected in Clips at the playhead"],
    ["R", "Replace the selected clip with the one selected in Clips"],
    ["+, -", "Zoom in or out (Ctrl + scroll zooms around the pointer)"],
    ["W", "Zoom to fit all tracks"],
    ["Z, X", "Zoom to the selection, or back to the previous zoom"],
    ["Comma, Period", "Select the previous or next clip"],
    ["Escape", "Clear the selection"],
  ] as ReadonlyArray<readonly [string, string]>,
  colorName: (c: string) => c[0].toUpperCase() + c.slice(1),
};

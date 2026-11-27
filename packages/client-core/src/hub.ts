/**
 * The Playtest Hub as both clients draw it: the daemon's /v1/hub routes, the
 * hub's screens and their addresses under #/playtests, the looks of health
 * and run states, the timeline math of the Arrangement and the clip piano
 * roll, the edits a person makes to an arrangement or a clip, and the copy.
 *
 * Every hub type comes from `ue-mcp/daemon` and every hub function from
 * `ue-mcp/hub`, which exports the same declarations without Node imports.
 * Studio declares none of its own (packages/client-core/test/no-hub-copies.test.ts).
 */
import type {
  Arrangement,
  ArrangementDraft,
  AuditionRequest,
  AuditionState,
  ArrangementView,
  Check,
  CheckMode,
  CheckResult,
  CheckStatus,
  Clip,
  ClipDraft,
  ClipInstance,
  EditorLease,
  HubFinding,
  HubOverview,
  InputLane,
  Performer,
  PerformersView,
  QueueItem,
  QueueRequest,
  QueueState,
  RecordingState,
  Region,
  RunnerKind,
  RunRecord,
  RunState,
  Schedule,
  ScheduleDraft,
  Suite,
  SuiteDraft,
  SuiteHealth,
  SuiteItem,
  SuiteState,
  TestDetail,
  TestHealth,
  Track,
} from "ue-mcp/daemon";
import { DEFAULT_RATE, HUB_CHANGED, HUB_LEASE, instanceLength, runEnded } from "ue-mcp/hub";
import { requestJson, type Transport } from "./transport.js";

// ---------- API ----------

/** One JSON request: the web client passes its fetch `call`, the phone `requestJson` over its sealed transport. */
export type HubRequest = <T>(method: string, path: string, body?: unknown) => Promise<T>;

/** The hub is ue-mcp's: its routes are the daemon's own, not an extension's. */
export const HUB_BASE = "/v1/hub";
const enc = encodeURIComponent;

/** What POST /v1/hub/queue answers. */
export interface QueueAnswer {
  batch: string;
  queued: QueueItem[];
  skipped: Array<{ test: string; reason: string }>;
  queue: QueueState;
}

/** The daemon's hub routes (docs/hub.md in ue-mcp), typed. */
export function hubApi(request: HubRequest) {
  const B = HUB_BASE;
  const clip = (id: string) => `${B}/clips/${enc(id)}`;
  const arr = (id: string) => `${B}/arrangements/${enc(id)}`;
  const suite = (id: string) => `${B}/suites/${enc(id)}`;
  const run = (id: string) => `${B}/runs/${enc(id)}`;
  return {
    overview: () => request<HubOverview>("GET", B),
    clip: (id: string) => request<{ clip: Clip }>("GET", clip(id)).then((r) => r.clip),
    createClip: (d: ClipDraft) => request<{ clip: Clip }>("POST", `${B}/clips`, d).then((r) => r.clip),
    putClip: (c: Clip) => request<{ clip: Clip }>("PUT", clip(c.id), c).then((r) => r.clip),
    deleteClip: (id: string) => request<void>("DELETE", clip(id)),
    /** arrangement, track, at and seconds say where the take lands and how long it runs; the daemon keeps them for recordState. */
    recordStart: (body: { performer: Performer; clip?: string; from?: number; to?: number; rate?: number; arrangement?: string; track?: string; at?: number; seconds?: number }) => request<{ recording: true }>("POST", `${B}/record/start`, body),
    /** The recording under way on the open editor, so a reloaded page can show it and stop it. */
    recordState: () => request<{ recording: RecordingState | null }>("GET", `${B}/record`).then((r) => r.recording),
    recordStop: (body: { id?: string; title?: string } = {}) => request<{ clip: Clip }>("POST", `${B}/record/stop`, body).then((r) => r.clip),
    arrangement: (id: string) => request<ArrangementView>("GET", arr(id)),
    createArrangement: (d: ArrangementDraft) => request<ArrangementView>("POST", `${B}/arrangements`, d),
    putArrangement: (a: Arrangement) => request<ArrangementView>("PUT", arr(a.id), a),
    deleteArrangement: (id: string) => request<void>("DELETE", arr(id)),
    performers: (arrangement?: string) => request<PerformersView>("GET", `${B}/performers${arrangement ? `?arrangement=${enc(arrangement)}` : ""}`),
    test: (id: string, limit?: number) => request<TestDetail>("GET", `${B}/tests/${enc(id)}${limit ? `?limit=${limit}` : ""}`),
    suite: (id: string) => request<SuiteState>("GET", suite(id)),
    createSuite: (d: SuiteDraft) => request<SuiteState>("POST", `${B}/suites`, d),
    putSuite: (s: Suite) => request<SuiteState>("PUT", suite(s.id), s),
    deleteSuite: (id: string) => request<void>("DELETE", suite(id)),
    quarantine: (id: string, test: string, on: boolean) => request<SuiteState>("POST", `${suite(id)}/quarantine`, { test, on }),
    markFlaky: (id: string, test: string, on: boolean) => request<SuiteState>("POST", `${suite(id)}/flaky`, { test, on }),
    runs: (q: { test?: string; suite?: string; limit?: number } = {}) => {
      const qs = Object.entries(q).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k}=${enc(String(v))}`).join("&");
      return request<{ runs: RunRecord[]; more: boolean }>("GET", `${B}/runs${qs ? `?${qs}` : ""}`);
    },
    run: (runId: string) => request<RunRecord>("GET", run(runId)),
    verdict: (runId: string, check: string, verdict: "pass" | "fail", note?: string) => request<RunRecord>("POST", `${run(runId)}/verdict`, { check, verdict, ...(note ? { note } : {}) }),
    stopRun: (runId: string) => request<RunRecord>("POST", `${run(runId)}/stop`, {}),
    enqueue: (req: QueueRequest) => request<QueueAnswer>("POST", `${B}/queue`, req),
    dequeue: (id: string) => request<QueueState>("DELETE", `${B}/queue/${enc(id)}`),
    pause: (paused: boolean) => request<QueueState>("PUT", `${B}/queue/paused`, { paused }),
    lease: () => request<{ lease: EditorLease | null }>("GET", `${B}/lease`),
    release: () => request<QueueState>("POST", `${B}/release`, {}),
    /** Audition: play on the open editor to watch, from the playhead and looping when asked. Not a test run. */
    play: (req: AuditionRequest) => request<{ play: AuditionState }>("POST", `${B}/play`, req).then((r) => r.play),
    playState: () => request<{ play: AuditionState | null }>("GET", `${B}/play`).then((r) => r.play),
    stopPlay: () => request<{ play: AuditionState }>("POST", `${B}/play/stop`, {}).then((r) => r.play),
    schedules: () => request<{ schedules: Schedule[] }>("GET", `${B}/schedules`).then((r) => r.schedules),
    createSchedule: (d: ScheduleDraft) => request<{ schedule: Schedule }>("POST", `${B}/schedules`, d).then((r) => r.schedule),
    updateSchedule: (id: string, d: ScheduleDraft) => request<{ schedule: Schedule }>("PUT", `${B}/schedules/${enc(id)}`, d).then((r) => r.schedule),
    deleteSchedule: (id: string) => request<void>("DELETE", `${B}/schedules/${enc(id)}`),
  };
}
export type HubApi = ReturnType<typeof hubApi>;

/** The hub API over a Transport, for a client that has one (the phone). */
export const hubApiOver = (transport: Transport): HubApi =>
  hubApi(<T>(method: string, path: string, body?: unknown) => requestJson<T>(transport, method, path, body === undefined ? undefined : { json: body }));

/** The 400 body of a write the daemon refused: each finding with its path. */
export function refusalFindings(body: unknown): HubFinding[] {
  const f = (body as { findings?: unknown } | null)?.findings;
  return Array.isArray(f) ? f.filter((x): x is HubFinding => !!x && typeof x === "object" && typeof (x as HubFinding).message === "string") : [];
}

/** Events after which the overview is read again. */
export const hubReloadsOn = (type: string): boolean => type === HUB_CHANGED || type === HUB_LEASE;
/** A burst of hub.changed (a run's checks settling) folds into one read per this many milliseconds. */
export const HUB_RELOAD_MS = 400;

// ---------- Screens under #/playtests ----------

export type HubRoute =
  | { screen: "arrangements" }
  | { screen: "arrangement"; id: string; run?: string }
  | { screen: "clip"; id: string; from?: string }
  | { screen: "suites"; id?: string }
  | { screen: "runs" };

export type HubSection = "arrangements" | "suites" | "runs";

/** The route of a path under #/playtests: "", "arrangements/<id>", "arrangements/<id>/runs/<run>", "clips/<id>", "suites", "suites/<id>", "runs". */
export function parseHubPath(sub: string | null | undefined): HubRoute {
  const parts = (sub ?? "").split("?")[0]!.split("/").filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  const [head, id, sub2, id2] = parts;
  if (head === "arrangements" && id) return sub2 === "runs" && id2 ? { screen: "arrangement", id, run: id2 } : { screen: "arrangement", id };
  if (head === "clips" && id) return sub2 === "in" && id2 ? { screen: "clip", id, from: id2 } : { screen: "clip", id };
  if (head === "suites") return id ? { screen: "suites", id } : { screen: "suites" };
  if (head === "runs") return { screen: "runs" };
  return { screen: "arrangements" };
}

export function hubPath(r: HubRoute): string {
  switch (r.screen) {
    case "arrangements": return "";
    case "arrangement": return `arrangements/${enc(r.id)}${r.run ? `/runs/${enc(r.run)}` : ""}`;
    case "clip": return `clips/${enc(r.id)}${r.from ? `/in/${enc(r.from)}` : ""}`;
    case "suites": return r.id ? `suites/${enc(r.id)}` : "suites";
    case "runs": return "runs";
  }
}

export const hubHash = (r: HubRoute): string => {
  const p = hubPath(r);
  return p ? `#/playtests/${p}` : "#/playtests";
};

/** The rail entry a screen sits under. */
export function hubSection(r: HubRoute): HubSection {
  return r.screen === "suites" ? "suites" : r.screen === "runs" ? "runs" : "arrangements";
}

/** A link's target as a hub screen, for an address such as #/playtests/suites/smoke; null for anything else. */
export function hubAddressRoute(url: string): HubRoute | null {
  const m = /^#\/playtests(?:\/(.*))?$/.exec(url.trim());
  return m ? parseHubPath(m[1] ?? "") : null;
}

// ---------- Looks ----------

export type StatusGlyph = "needs" | "fail" | "missing" | "running" | "flaky" | "stale" | "never" | "check" | "risk" | "skip" | "stop" | "queued";
export type StatusTone = "attention" | "bad" | "warn" | "run" | "ok" | "idle";
export interface StatusLook {
  glyph: StatusGlyph;
  tone: StatusTone;
  label: string;
}

export const TEST_HEALTH_LOOK: Record<TestHealth, StatusLook> = {
  running: { glyph: "running", tone: "run", label: "Running" },
  failing: { glyph: "fail", tone: "bad", label: "Failing" },
  missing: { glyph: "missing", tone: "bad", label: "Missing" },
  flaky: { glyph: "flaky", tone: "warn", label: "Flaky" },
  never_run: { glyph: "never", tone: "idle", label: "Never run" },
  passing: { glyph: "check", tone: "ok", label: "Passing" },
};

export const SUITE_HEALTH_LOOK: Record<SuiteHealth, StatusLook> = {
  running: TEST_HEALTH_LOOK.running,
  failing: TEST_HEALTH_LOOK.failing,
  flaky: TEST_HEALTH_LOOK.flaky,
  never_run: TEST_HEALTH_LOOK.never_run,
  passing: TEST_HEALTH_LOOK.passing,
  empty: { glyph: "skip", tone: "idle", label: "No tests" },
};

export const RUN_STATE_LOOK: Record<RunState, StatusLook> = {
  starting: { glyph: "queued", tone: "run", label: "Starting" },
  running: { glyph: "running", tone: "run", label: "Running" },
  awaiting_verdict: { glyph: "needs", tone: "attention", label: "Waiting for a verdict" },
  passed: { glyph: "check", tone: "ok", label: "Passed" },
  failed: { glyph: "fail", tone: "bad", label: "Failed" },
  error: { glyph: "risk", tone: "bad", label: "Error" },
  stopped: { glyph: "stop", tone: "idle", label: "Stopped" },
};

export const CHECK_STATUS_LOOK: Record<CheckStatus, StatusLook> = {
  pending: { glyph: "queued", tone: "idle", label: "Pending" },
  running: { glyph: "running", tone: "run", label: "Judging" },
  passed: { glyph: "check", tone: "ok", label: "Passed" },
  failed: { glyph: "fail", tone: "bad", label: "Failed" },
  awaiting_verdict: { glyph: "needs", tone: "attention", label: "Waiting for a verdict" },
  skipped: { glyph: "skip", tone: "idle", label: "Skipped" },
};

export const passRateText = (rate: number | null | undefined): string => (rate === null || rate === undefined ? "No runs" : `${Math.round(rate * 100)}%`);

/** How long ago, short: "now", "4m", "3h", "2d". */
export function shortAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(s)) return "";
  if (s < 45) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

// ---------- Checks ----------

export const CHECK_MODE_LABEL: Record<CheckMode, string> = {
  by_end: "By the end",
  throughout: "Throughout",
  hold: "Hold until true",
  manual: "Manual verdict",
};

export const CHECK_MODE_HELP: Record<CheckMode, string> = {
  by_end: "Passes once the condition holds on any frame before the check ends.",
  throughout: "Passes when the condition holds on every frame of the check.",
  hold: "Playback waits at the start until the condition holds, and fails after the check's length.",
  manual: "Play In Editor pauses until a person or an agent gives a pass or fail verdict.",
};

/** The short mark drawn on a check note. */
export const CHECK_MODE_MARK: Record<CheckMode, string> = { by_end: "END", throughout: "ALL", hold: "WAIT", manual: "YOU" };

/** What a check reads, in a line: "health >= 50", or the instruction of a manual one. */
export function checkSummary(c: Pick<Check, "mode" | "expect" | "instruction">): string {
  if (c.mode === "manual") return c.instruction ?? "";
  if (!c.expect) return "";
  const t = c.expect.target === undefined ? "" : ` ${typeof c.expect.target === "string" ? c.expect.target : JSON.stringify(c.expect.target)}`;
  return `${c.expect.subject ? `${c.expect.subject}: ` : ""}${c.expect.value} ${c.expect.op}${t}`;
}

/** The ops a check's expect takes, as the plugin judges them. */
export const EXPECT_OPS = ["==", "!=", ">", ">=", "<", "<=", "contains", "exists"] as const;

/** A target typed as text: a number or true/false when it reads as one, else the text. */
export function expectTargetOf(text: string): unknown {
  const t = text.trim();
  if (t === "") return undefined;
  if (t === "true" || t === "false") return t === "true";
  const n = Number(t);
  return Number.isFinite(n) ? n : t;
}

// ---------- Time ----------

/** Pixels per second of game time: the default, and the range zooming stays in. */
export const ARRANGE_DEFAULT_ZOOM = 80;
export const ARRANGE_ZOOM_MIN = 4;
export const ARRANGE_ZOOM_MAX = 1280;
export const clampZoom = (z: number): number => Math.min(ARRANGE_ZOOM_MAX, Math.max(ARRANGE_ZOOM_MIN, Number.isFinite(z) ? z : ARRANGE_DEFAULT_ZOOM));
export const zoomStep = (z: number, dir: 1 | -1): number => clampZoom(dir > 0 ? z * 1.5 : z / 1.5);
/** The zoom that shows frames `from` to `to` across `width` pixels. */
export const zoomToFit = (from: number, to: number, rate: number, width: number): number => clampZoom(Math.max(1, width) / Math.max(0.5, (to - from) / (rate || DEFAULT_RATE)));

/** Frames as a clock: "0:05", or with hundredths "0:01.25". */
export function arrangeClock(f: number, rate: number, hundredths = false): string {
  const total = Math.max(0, f) / (rate || DEFAULT_RATE);
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  if (!hundredths) return `${m}:${String(Math.floor(s + 1e-6)).padStart(2, "0")}`;
  const cs = Math.round(s * 100);
  return `${m + Math.floor(cs / 6000)}:${((cs % 6000) / 100).toFixed(2).padStart(5, "0")}`;
}

/** Frames per grid step: a quarter second, or a whole second with `coarse` (Shift). */
export const arrangeStep = (rate: number, coarse = false): number => (coarse ? rate : Math.max(1, Math.round(rate / 4)));
export const snapTo = (f: number, step: number): number => Math.max(0, step > 0 ? Math.round(f / step) * step : Math.round(f));
export const arrangeSeconds = (f: number, rate: number): string => `${(f / rate).toFixed(2).replace(/\.?0+$/, "") || "0"} s`;
/** How long the ruler runs: ten seconds past the end, and never under thirty. */
export const rulerFrames = (end: number, rate: number): number => Math.max(end + rate * 10, rate * 30);
export const rulerEvery = (zoom: number): number => [0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600].find((s) => s * zoom >= 60) ?? 600;
export function rulerTicks(frames: number, rate: number, zoom: number): number[] {
  const every = rulerEvery(zoom);
  const out: number[] = [];
  for (let s = 0; s * rate <= frames; s += every) out.push(s);
  return out;
}
export function rulerMinor(zoom: number): number {
  const every = rulerEvery(zoom);
  const parts = [5, 10, 30, 300].includes(every) ? 5 : every === 60 || every === 600 ? 6 : 4;
  return (every / parts) * zoom >= 8 ? every / parts : every;
}

/** The fewest rows the Arrangement draws, spare ones under the tracks. */
export const MIN_ROWS = 6;

// ---------- Arrangement edits ----------

/** A title not in `taken`: the base, then "base 2", "base 3". */
export function nextTitle(base: string, taken: readonly string[]): string {
  const t = new Set(taken.map((x) => x.toLowerCase()));
  if (!t.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!t.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

/** An id not in `taken`: prefix and the first free number. */
export function nextPartId(prefix: string, taken: Iterable<string>): string {
  const t = new Set(taken);
  for (let i = 1; ; i++) if (!t.has(`${prefix}${i}`)) return `${prefix}${i}`;
}

const allInstances = (a: Arrangement): ClipInstance[] => a.tracks.flatMap((t) => t.instances);
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const byAt = (x: ClipInstance, y: ClipInstance) => x.at - y.at || x.id.localeCompare(y.id);

export function addTrack(a: Arrangement, performer: Performer, title: string): Arrangement {
  const id = nextPartId("t", a.tracks.map((t) => t.id));
  return { ...a, tracks: [...a.tracks, { id, title, performer, mute: false, solo: false, instances: [] }] };
}

export const setTrack = (a: Arrangement, id: string, patch: Partial<Omit<Track, "id" | "instances">>): Arrangement => ({ ...a, tracks: a.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
export const removeTrack = (a: Arrangement, id: string): Arrangement => ({ ...a, tracks: a.tracks.filter((t) => t.id !== id) });
export function moveTrack(a: Arrangement, id: string, to: number): Arrangement {
  const from = a.tracks.findIndex((t) => t.id === id);
  if (from < 0) return a;
  const tracks = [...a.tracks];
  const [t] = tracks.splice(from, 1);
  tracks.splice(Math.max(0, Math.min(tracks.length, to)), 0, t!);
  return { ...a, tracks };
}

export function addInstance(a: Arrangement, trackId: string, clip: string, at: number): { arrangement: Arrangement; id: string } {
  const id = nextPartId("i", allInstances(a).map((i) => i.id));
  return { id, arrangement: { ...a, tracks: a.tracks.map((t) => (t.id === trackId ? { ...t, instances: [...t.instances, { id, clip, at: r3(Math.max(0, at)) }].sort(byAt) } : t)) } };
}

/** An instance moved to `at`, on `toTrack` when given. */
export function moveInstance(a: Arrangement, id: string, at: number, toTrack?: string): Arrangement {
  const inst = allInstances(a).find((i) => i.id === id);
  if (!inst) return a;
  const moved = { ...inst, at: r3(Math.max(0, at)) };
  const from = a.tracks.find((t) => t.instances.some((i) => i.id === id))!.id;
  const dest = toTrack ?? from;
  return {
    ...a,
    tracks: a.tracks.map((t) => {
      const kept = t.instances.filter((i) => i.id !== id);
      return { ...t, instances: t.id === dest ? [...kept, moved].sort(byAt) : kept };
    }),
  };
}

export const removeInstance = (a: Arrangement, id: string): Arrangement => ({ ...a, tracks: a.tracks.map((t) => ({ ...t, instances: t.instances.filter((i) => i.id !== id) })) });

/** A new check on the Checks track: a manual one asks what to look at, the rest start from a placeholder expect. */
export function addCheck(a: Arrangement, at: number, mode: CheckMode, length: number): { arrangement: Arrangement; id: string } {
  const id = nextPartId("c", a.checks.map((c) => c.id));
  const base: Check = { id, title: `Check ${id.slice(1)}`, at: r3(Math.max(0, at)), length: r3(Math.max(0, length)), mode };
  const check: Check = mode === "manual" ? { ...base, instruction: "Look at the result and pass or fail it." } : { ...base, expect: { value: "pawn.alive", op: "==", target: true } };
  return { id, arrangement: { ...a, checks: [...a.checks, check].sort((x, y) => x.at - y.at || x.id.localeCompare(y.id)) } };
}

export function updateCheck(a: Arrangement, id: string, patch: Partial<Omit<Check, "id">>): Arrangement {
  return {
    ...a,
    checks: a.checks
      .map((c) => {
        if (c.id !== id) return c;
        const next: Check = { ...c, ...patch };
        // A check's mode decides which fields it keeps.
        if (next.mode === "manual") {
          delete next.expect;
          delete next.timeout;
          next.instruction = next.instruction || "Look at the result and pass or fail it.";
        } else {
          delete next.instruction;
          delete next.personOnly;
          next.expect = next.expect ?? { value: "pawn.alive", op: "==", target: true };
          if (next.mode !== "hold") delete next.timeout;
        }
        return { ...next, at: r3(Math.max(0, next.at)), length: r3(Math.max(0, next.length)) };
      })
      .sort((x, y) => x.at - y.at || x.id.localeCompare(y.id)),
  };
}

export const removeCheck = (a: Arrangement, id: string): Arrangement => ({ ...a, checks: a.checks.filter((c) => c.id !== id) });

export function addRegion(a: Arrangement, start: number, end: number): { arrangement: Arrangement; id: string } {
  const id = nextPartId("r", a.regions.map((r) => r.id));
  const region: Region = { id, name: `Region ${id.slice(1)}`, start: r3(Math.max(0, start)), end: r3(Math.max(start + 1, end)) };
  return { id, arrangement: { ...a, regions: [...a.regions, region].sort((x, y) => x.start - y.start) } };
}

export const updateRegion = (a: Arrangement, id: string, patch: Partial<Omit<Region, "id">>): Arrangement => ({
  ...a,
  regions: a.regions.map((r) => (r.id === id ? { ...r, ...patch, start: r3(Math.max(0, patch.start ?? r.start)), end: r3(Math.max((patch.start ?? r.start) + 1, patch.end ?? r.end)) } : r)).sort((x, y) => x.start - y.start),
});
export const removeRegion = (a: Arrangement, id: string): Arrangement => ({ ...a, regions: a.regions.filter((r) => r.id !== id) });

/** Where a span fits on the region lane: none of the other regions overlap it. */
export const regionFits = (a: Pick<Arrangement, "regions">, start: number, end: number, except?: string): boolean => a.regions.every((r) => r.id === except || end <= r.start || start >= r.end);

/** What the timeline needs of a clip: its length at its rate. A Clip or a ClipSummary. */
export type ClipSpan = Pick<Clip, "length" | "rate">;

/** The frames an instance spans, at the arrangement's rate; never under a quarter second, so an empty clip can be grabbed. */
export function instanceSpan(inst: Pick<ClipInstance, "clip" | "at">, clips: Record<string, ClipSpan>, rate: number): { start: number; end: number } {
  const len = instanceLength(clips[inst.clip], rate);
  return { start: inst.at, end: inst.at + Math.max(len, rate / 4) };
}

/** Whether an instance at `at` on a track would overlap another there. */
export function instanceFits(track: Pick<Track, "instances">, clips: Record<string, ClipSpan>, rate: number, clip: string, at: number, except?: string): boolean {
  const len = instanceLength(clips[clip], rate);
  return track.instances.every((i) => {
    if (i.id === except) return true;
    const s = instanceSpan(i, clips, rate);
    return at + len <= s.start || at >= s.end;
  });
}

/**
 * Spans laid out on as few rows as fit, each on the first row it does not
 * overlap: the Checks track stacks checks that overlap in time this way, so
 * every one stays visible. Spans in start order keep their rows stable.
 */
export function stackRows(spans: ReadonlyArray<{ id: string; start: number; end: number }>): { row: Record<string, number>; rows: number } {
  const ends: number[] = [];
  const row: Record<string, number> = {};
  for (const s of [...spans].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id))) {
    let r = ends.findIndex((e) => e <= s.start);
    if (r < 0) r = ends.push(0) - 1;
    ends[r] = s.end;
    row[s.id] = r;
  }
  return { row, rows: Math.max(1, ends.length) };
}

/** The findings that name one track or instance, by the path the daemon gave them. */
export function findingsAt(findings: readonly HubFinding[], a: Arrangement, where: { track?: string; instance?: string; check?: string; region?: string }): HubFinding[] {
  return findings.filter((f) => {
    const m = /^(tracks|checks|regions)\[(\d+)\](?:\.instances\[(\d+)\])?/.exec(f.path);
    if (!m) return false;
    const i = Number(m[2]);
    if (m[1] === "checks") return !!where.check && a.checks[i]?.id === where.check;
    if (m[1] === "regions") return !!where.region && a.regions[i]?.id === where.region;
    const t = a.tracks[i];
    if (!t) return false;
    if (where.instance) return m[3] !== undefined && t.instances[Number(m[3])]?.id === where.instance;
    return !!where.track && t.id === where.track && m[3] === undefined;
  });
}

// ---------- Run feedback ----------

/** Whether a run is of this arrangement: the arrangement itself or one of its regions. */
export const runOfArrangement = (r: Pick<RunRecord, "test">, id: string): boolean => r.test === id || r.test.startsWith(`${id}:`);

/** The run the Arrangement shows: the one asked for, else the arrangement's newest. */
export function arrangementRun(recent: readonly RunRecord[], id: string, runId?: string | null): RunRecord | null {
  if (runId) return recent.find((r) => r.runId === runId) ?? null;
  return [...recent].filter((r) => runOfArrangement(r, id)).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null;
}

/** A run's check results by check id. */
export const checkResults = (run: Pick<RunRecord, "checks"> | null | undefined): Record<string, CheckResult> => Object.fromEntries((run?.checks ?? []).map((c) => [c.id, c]));

/** The manual checks of a run that wait for a verdict now. */
export function awaitingVerdicts(run: RunRecord | null | undefined, checks: readonly Check[]): Check[] {
  if (!run || runEnded(run.state)) return [];
  const waiting = new Set(run.checks.filter((c) => c.status === "awaiting_verdict").map((c) => c.id));
  return checks.filter((c) => c.mode === "manual" && waiting.has(c.id));
}

/** A run's counts, for its line: how many checks passed of how many. */
export function runTally(run: Pick<RunRecord, "checks">): { passed: number; failed: number; total: number } {
  return { passed: run.checks.filter((c) => c.status === "passed").length, failed: run.checks.filter((c) => c.status === "failed").length, total: run.checks.length };
}

/** What the page says after a Run: started, queued behind others, or why nothing was queued. */
export function queuedText(a: Pick<QueueAnswer, "queued" | "skipped" | "queue">, what: string): { text: string; tone: "ok" | "bad" } {
  if (!a.queued.length) return { text: a.skipped[0]?.reason ?? `${what} was not queued.`, tone: "bad" };
  const running = a.queued.some((q) => q.state === "running");
  const ahead = a.queue.running.length + a.queue.queued.filter((q) => !a.queued.some((x) => x.id === q.id)).length;
  const n = a.queued.length;
  const tests = n === 1 ? "1 test" : `${n} tests`;
  if (running) return { text: n === 1 ? `Running ${what}` : `Running ${what}: ${tests}`, tone: "ok" };
  if (a.queue.paused) return { text: `Queued ${tests}. The queue is paused.`, tone: "ok" };
  if (a.queue.waiting.length) return { text: `Queued ${tests}. ${a.queue.waiting[0]!.text}`, tone: "ok" };
  return { text: ahead ? `Queued ${tests} behind ${ahead} more` : `Queued ${tests}`, tone: "ok" };
}

// ---------- Where a run plays ----------

/** The runner a person picks in Run: auto leaves the choice to the hub. */
export type RunnerChoice = RunnerKind | "auto";

export const RUNNER_LABEL: Record<RunnerKind, string> = { headless: "Headless", editor: "Open editor" };

export const RUNNER_CHOICES: ReadonlyArray<{ value: RunnerChoice; label: string; help: string }> = [
  { value: "auto", label: "Automatic", help: "Headless when a hidden editor fits in memory and the test has no manual checks, otherwise the open editor." },
  { value: "headless", label: "Headless", help: "A hidden editor the hub starts and closes, so the open editor stays free. Manual checks cannot run there." },
  { value: "editor", label: "Open editor", help: "Play In Editor in the editor you have open, where a person can judge manual checks." },
];

/** The queue request for a choice: auto sends no runner. */
export const runnerRequest = (choice: RunnerChoice): { runner?: RunnerKind } => (choice === "auto" ? {} : { runner: choice });

/** Where a queued test plays and why: "Headless, because a hidden editor fits in memory", or "Open editor, as chosen". */
export function runnerText(i: Pick<QueueItem, "runner" | "runnerReason">): string {
  return i.runnerReason ? `${RUNNER_LABEL[i.runner]}, because ${i.runnerReason}` : `${RUNNER_LABEL[i.runner]}, as chosen`;
}

// ---------- Schedules ----------

export const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
/** The days in the order a week reads here: Monday first. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

/** A schedule's days in words: "Every day", "Weekdays", "Weekends", or "Mon, Wed, Fri". */
export function scheduleDaysText(days: readonly number[]): string {
  const set = new Set(days);
  if (set.size === 7) return "Every day";
  if (set.size === 5 && [1, 2, 3, 4, 5].every((d) => set.has(d))) return "Weekdays";
  if (set.size === 2 && set.has(0) && set.has(6)) return "Weekends";
  return WEEK_ORDER.filter((d) => set.has(d)).map((d) => DAY_SHORT[d]).join(", ");
}

/** A day toggled in or out of a schedule's days, never leaving none. */
export function toggleDay(days: readonly number[], d: number): number[] {
  const next = days.includes(d) ? days.filter((x) => x !== d) : [...days, d];
  return next.length ? [...next].sort() : [...days];
}

/** What a schedule runs, by name: the suite's title or the test's. */
export function scheduleTarget(s: Pick<Schedule, "suite" | "test">, o: Pick<HubOverview, "suites" | "tests">): string {
  if (s.suite) return o.suites.find((x) => x.id === s.suite)?.title ?? s.suite;
  return s.test ? testLabel(s.test, o) : "";
}

/** The form's value for what a schedule runs: "suite:<id>" or "test:<id>". */
export const scheduleTargetKey = (s: Pick<Schedule, "suite" | "test">): string => (s.suite ? `suite:${s.suite}` : s.test ? `test:${s.test}` : "");
export function scheduleTargetOf(key: string): { suite: string } | { test: string } | null {
  const i = key.indexOf(":");
  if (i < 0) return null;
  const kind = key.slice(0, i);
  const id = key.slice(i + 1);
  if (!id) return null;
  return kind === "suite" ? { suite: id } : kind === "test" ? { test: id } : null;
}

// ---------- Audition and recording ----------

/** Whether an audition is still playing. */
export const auditionLive = (p: Pick<AuditionState, "state"> | null | undefined): boolean => !!p && (p.state === "starting" || p.state === "running" || p.state === "awaiting_verdict");

/** Whether an audition is of this arrangement: the arrangement itself or one of its regions. */
export const auditionOf = (p: Pick<AuditionState, "test"> | null | undefined, id: string): boolean => !!p && (p.test === id || p.test.startsWith(`${id}:`));

/** The range Loop plays and the takes record over: one region, or the whole arrangement. */
export interface LoopRange {
  start: number;
  end: number;
  /** The region it is; absent for the whole arrangement. */
  region?: string;
}

/** The loop range Loop sets: the selected region, else the region under the playhead, else the whole arrangement. */
export function loopRangeOf(a: Pick<Arrangement, "regions">, end: number, playhead: number, selected?: string | null): LoopRange {
  const r = a.regions.find((x) => x.id === selected) ?? a.regions.find((x) => playhead >= x.start && playhead < x.end);
  return r ? { start: r.start, end: r.end, region: r.id } : { start: 0, end: Math.max(1, end) };
}

/** What an audition plays: the loop range's region when looping over one, else the arrangement from the playhead. */
export function auditionRequest(id: string, playhead: number, loop: LoopRange | null): AuditionRequest {
  if (loop?.region) return { test: `${id}:${loop.region}`, from: Math.max(loop.start, Math.min(playhead, loop.end - 1)), loop: true };
  return { test: id, from: Math.max(0, playhead), ...(loop ? { loop: true } : {}) };
}

export type RecordMode = "playhead" | "range" | "punch";

export const RECORD_MODES: ReadonlyArray<{ value: RecordMode; label: string; help: string }> = [
  { value: "playhead", label: "From playhead", help: "Records a new take until you stop it, placed on the armed track at the playhead." },
  { value: "range", label: "Over loop range", help: "Records a new take for the length of the loop range, placed on the armed track at its start." },
  { value: "punch", label: "Punch in", help: "Records over the loop range inside the clip under it on the armed track, keeping the rest of the clip." },
];

/** The instance on a track that covers a frame. */
export function instanceAt(track: Pick<Track, "instances">, frame: number, clips: Record<string, ClipSpan>, rate: number): ClipInstance | null {
  return track.instances.find((i) => {
    const s = instanceSpan(i, clips, rate);
    return frame >= s.start && frame < s.end;
  }) ?? null;
}

/** A punch range in the clip's own frames: where the arrangement span falls inside the instance, or null when it misses. */
export function punchRange(inst: Pick<ClipInstance, "at">, clip: ClipSpan, rate: number, start: number, end: number): { from: number; to: number } | null {
  const scale = clip.rate / (rate || DEFAULT_RATE);
  const from = Math.max(0, Math.round((start - inst.at) * scale));
  const to = Math.min(clip.length, Math.round((end - inst.at) * scale));
  return to > from ? { from, to } : null;
}

// ---------- Suites ----------

/** The suites no other suite holds, in title order: the roots of the tree. */
export function rootSuites(suites: readonly SuiteState[]): SuiteState[] {
  const held = new Set(suites.flatMap((s) => s.items.flatMap((i) => ("suite" in i ? [i.suite] : []))));
  return suites.filter((s) => !held.has(s.id)).sort((a, b) => a.title.localeCompare(b.title));
}

/** A suite's items with the suite or test each names, for its tree. */
export function suiteChildren(s: Pick<SuiteState, "items">, suites: readonly SuiteState[], tests: readonly { id: string }[]): Array<{ item: SuiteItem; suite?: SuiteState; test?: string; missing: boolean }> {
  return s.items.map((item) => {
    if ("suite" in item) {
      const found = suites.find((x) => x.id === item.suite);
      return { item, ...(found ? { suite: found } : {}), missing: !found };
    }
    return { item, test: item.test, missing: !tests.some((t) => t.id === item.test) };
  });
}

/** Bars for a pass-rate history: a height from 0 to 1 and a label. */
export function historyBars(history: SuiteState["history"], max = 30): Array<{ batch: string; rate: number; label: string }> {
  return history.slice(-max).map((p) => ({ batch: p.batch, rate: p.rate, label: `${p.passed} of ${p.total} passed, ${new Date(p.at).toLocaleString()}` }));
}

/** A suite with an item added, once. */
export function withItem(s: Suite, item: SuiteItem): Suite {
  const key = (i: SuiteItem) => ("test" in i ? `t:${i.test}` : `s:${i.suite}`);
  return s.items.some((i) => key(i) === key(item)) ? s : { ...s, items: [...s.items, item] };
}
export const withoutItem = (s: Suite, item: SuiteItem): Suite => ({ ...s, items: s.items.filter((i) => ("test" in i && "test" in item ? i.test !== item.test : "suite" in i && "suite" in item ? i.suite !== item.suite : true)) });

/** The editable file of a suite as the overview shows it. */
export const suiteFileOf = (s: SuiteState): Suite => ({ id: s.id, title: s.title, ...(s.description ? { description: s.description } : {}), items: s.items, quarantined: s.quarantined, flaky: s.flaky });

// ---------- Clip piano roll ----------

/**
 * One row of the piano roll: an Input Action lane. Studio's hub drives
 * players only, so a clip's rows are its Input Action lanes; `kind` leaves
 * room for another lane kind when a performer kind that takes one is added.
 */
export interface RollRow {
  key: string;
  label: string;
  kind: "input";
  /** Bars: the lane's notes. */
  notes: Array<{ id: string; start: number; length: number }>;
  /** Points: the lane's curve keys. */
  points: Array<{ id: string; t: number; label: string }>;
}

const shortAction = (path: string): string => path.split(/[/.]/).filter(Boolean).pop() ?? path;

export function rollRows(c: Clip): RollRow[] {
  return c.input.map((l, i) => ({
    key: `input:${i}`,
    label: shortAction(l.action),
    kind: "input",
    notes: l.notes.map((n) => ({ id: n.id, start: n.start, length: n.length })),
    points: l.keys.map((k) => ({ id: k.id, t: k.t, label: Array.isArray(k.v) ? k.v.join(", ") : String(k.v) })),
  }));
}

/** The performer kinds Studio offers a track: players only, the editor's player or a remote client. */
export const OFFERED_PERFORMER_KINDS: readonly Performer["kind"][] = ["player"];
export const offersPerformer = (p: Pick<Performer, "kind">): boolean => OFFERED_PERFORMER_KINDS.includes(p.kind);

const mapInput = (c: Clip, i: number, f: (l: InputLane) => InputLane): Clip => ({ ...c, input: c.input.map((l, j) => (j === i ? f(l) : l)) });
const rowIndex = (key: string): number => Number(key.split(":")[1]);

/** A note moved to `start` and given `length` (frames, at the clip's rate). */
export function setNote(c: Clip, row: string, id: string, start: number, length: number): Clip {
  if (!row.startsWith("input:")) return c;
  return mapInput(c, rowIndex(row), (l) => ({ ...l, notes: l.notes.map((n) => (n.id === id ? { ...n, start: r3(Math.max(0, start)), length: r3(Math.max(1, length)) } : n)).sort((a, b) => a.start - b.start) }));
}

export function addNote(c: Clip, row: string, start: number, length: number): { clip: Clip; id: string } {
  if (!row.startsWith("input:")) return { clip: c, id: "" };
  const lane = c.input[rowIndex(row)];
  const id = nextPartId("n", lane?.notes.map((n) => n.id) ?? []);
  return { id, clip: mapInput(c, rowIndex(row), (l) => ({ ...l, notes: [...l.notes, { id, start: r3(Math.max(0, start)), length: r3(Math.max(1, length)) }].sort((a, b) => a.start - b.start) })) };
}

/** A curve key moved to `t`. */
export function setPoint(c: Clip, row: string, id: string, t: number): Clip {
  if (!row.startsWith("input:")) return c;
  const at = r3(Math.max(0, t));
  return mapInput(c, rowIndex(row), (l) => ({ ...l, keys: l.keys.map((k) => (k.id === id ? { ...k, t: at } : k)).sort((a, b) => a.t - b.t) }));
}

/** A note or key removed. */
export function removeEvent(c: Clip, row: string, id: string): Clip {
  if (!row.startsWith("input:")) return c;
  return mapInput(c, rowIndex(row), (l) => ({ ...l, notes: l.notes.filter((n) => n.id !== id), keys: l.keys.filter((k) => k.id !== id) }));
}

/** Where a clip's content ends, in its own frames. */
export function clipEnd(c: Clip): number {
  let end = c.length;
  for (const r of rollRows(c)) {
    for (const n of r.notes) end = Math.max(end, n.start + n.length);
    for (const p of r.points) end = Math.max(end, p.t);
  }
  return end;
}

// ---------- The lease bar ----------

/** The hub's hold on the editor from a hub.lease event, or null for any other event. */
export function leaseOfEvent(e: { type: string; data?: unknown }): { lease: EditorLease | null } | null {
  if (e.type !== HUB_LEASE) return null;
  const lease = (e.data as { lease?: unknown } | undefined)?.lease;
  return { lease: lease && typeof lease === "object" ? (lease as EditorLease) : null };
}

export const LEASE_COPY = {
  holding: "Studio is running a playtest",
  release: "Release the editor",
  releaseHelp: "Stop the run Studio started, end its Play In Editor session and pause the queue",
} as const;

// ---------- Copy ----------

export const HUB_COPY = {
  title: "Playtest Hub",
  arrangements: "Arrangements",
  suites: "Suites",
  runs: "Runs",
  newArrangement: "New arrangement",
  newSuite: "New suite",
  noArrangements: "No arrangements yet",
  noArrangementsHelp: "An arrangement places clips on tracks in one level, with the checks that grade it. Agents make them with the hub tools, or start one here.",
  noSuites: "No suites yet",
  noSuitesHelp: "A suite groups tests to run together and tracks their health over time. A test is an arrangement, or one of its regions.",
  noRuns: "Nothing has run yet",
  play: "Run",
  stop: "Stop",
  checks: "Checks",
  regions: "Regions",
  clips: "Clips",
  addTrack: "Add track",
  addCheck: "Add check",
  addRegion: "Add region",
  noClips: "No clips yet. Record a performance or ask an agent to write one.",
  record: "Record",
  stopRecording: "Stop recording",
  arm: "Arm for recording",
  armRemote: "Only the editor's own player records here. Record a remote client from its own editor.",
  armFirst: "Arm a player track to record",
  recording: (track: string) => `Recording ${track}`,
  recordingHelp: "Play in the editor now. Stop saves the take.",
  takeSaved: (clip: string, track: string) => `${clip} is on ${track}`,
  takeKept: (clip: string) => `${clip} is saved, but it overlaps a clip on the armed track, so it is only in the Clips drawer`,
  punched: (clip: string) => `Punched in on ${clip}`,
  punchMiss: "Punch in needs a clip under the loop range on the armed track",
  audition: "Play",
  auditionHelp: "Play from the playhead on the open editor to watch it. Nothing is recorded as a run.",
  auditioning: "Auditioning",
  testRun: "Test run",
  loop: "Loop",
  loopHelp: "Loop the selected region, the region under the playhead, or the whole arrangement",
  runHelp: "Queue this arrangement as a test, with its result kept in Runs",
  where: "Where it runs",
  schedules: "Schedules",
  newSchedule: "New schedule",
  noSchedules: "No schedules. A schedule queues a test or a suite on chosen days at a set time on this computer.",
  scheduleWhat: "Test or suite",
  scheduleDays: "Days",
  scheduleTime: "Time",
  scheduleTitle: "Name",
  scheduleSave: "Save",
  scheduleCancel: "Cancel",
  scheduleLast: (ago: string) => (ago === "now" ? "Last ran just now" : `Last ran ${ago} ago`),
  scheduleNever: "Not run yet",
  scheduleEditorNote: "The open editor must be running at that time.",
  queue: "Queue",
  queuePaused: "The queue is paused.",
  resume: "Resume",
  pause: "Pause",
  remove: "Remove",
  recent: "Recent runs",
  pass: "Pass",
  fail: "Fail",
  verdictNote: "Note (optional)",
  waitingVerdict: "Waiting for your verdict",
  personOnly: "Only a person may judge this check",
  quarantine: "Quarantine",
  unquarantine: "Release from quarantine",
  quarantined: "Quarantined",
  markFlaky: "Mark flaky",
  unmarkFlaky: "Clear flaky mark",
  flakyMarked: "Marked flaky",
  flakyDetected: (checks: readonly string[]) => (checks.length ? `Flaky: ${checks.join(", ")} flip between runs` : "Flaky"),
  runSuite: "Run suite",
  addToSuite: "Add",
  passRate: "Pass rate",
  history: "Pass-rate history",
  noHistory: "No runs of this suite yet.",
  missing: "Missing",
  level: "Level",
  openLevel: "The open level",
  findings: (n: number) => (n === 1 ? "1 problem" : `${n} problems`),
  deleteConfirm: (what: string) => `Delete ${what}? Its file is removed from the project.`,
  clipBack: "Back to the arrangement",
  clipSaved: "Saved",
  saving: "Saving",
  dropHint: "Drag a clip here from the drawer",
  editorBusy: "Waits for the editor",
  problems: (n: number) => (n === 1 ? "1 hub file does not read" : `${n} hub files do not read`),
} as const;

/** A player performer's name on a track: the editor's player, or a remote client. */
export const playerLabel = (p: Performer): string => (p.kind === "player" ? (p.client === 0 ? "Player" : `Client ${p.client}`) : "");

/** A short glance at a test id: "Arena" or "Arena: Boss fight". */
export function testLabel(id: string, o: Pick<HubOverview, "tests">): string {
  return o.tests.find((t) => t.id === id)?.title ?? id;
}

/** Whether an arrangement view's tests can run: an arrangement with no checks cannot be queued. */
export const canRun = (a: Pick<Arrangement, "checks">): boolean => a.checks.length > 0;

/** The tracks whose header has a warning: a finding on the track or any of its instances. */
export function trackWarnings(view: Pick<ArrangementView, "arrangement" | "findings">, trackId: string): HubFinding[] {
  const ti = view.arrangement.tracks.findIndex((t) => t.id === trackId);
  return ti < 0 ? [] : view.findings.filter((f) => f.path.startsWith(`tracks[${ti}]`));
}

/** The clip a new instance from the drawer uses when dropped on a track: only clips for the track's performer kind fit. */
export const clipFits = (clip: Pick<Clip, "performer">, track: Pick<Track, "performer">): boolean => clip.performer === track.performer.kind;

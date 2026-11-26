/**
 * Playing and recording a timeline playtest: Play the clip or one region,
 * Record into armed tracks from frame 0, a region or a hold check, Stop, and
 * a manual check's verdict. The run is followed on the daemon's clip.* events
 * where it offers them (events.clip), and by polling clip_status otherwise;
 * the cursor, each check's and region's result and, while recording, the take
 * so far (events.clip.take) are drawn on the timeline. Past runs come from
 * clip_runs, each one shown on the timeline when picked.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Clip, ClipRunSummary } from "@ue-mcp-studio/shared";
import {
  CLIP_COPY,
  CLIP_POLL_MS,
  clipEventsOn,
  clipLiveFromStatus,
  clipLiveFromSummary,
  clipPackage,
  clipPlaying,
  clipTakeEventsOn,
  driftCm,
  driftText,
  foldClipEvent,
  type ClipLive,
} from "@ue-mcp-studio/client-core";
import { api } from "../../api";
import { useHub } from "./state";
import { ClipScreen, type LaneOverlay } from "./Timeline";

export function ClipRunView({ path }: { path: string }) {
  const hub = useHub();
  const events = hub.events ?? [];
  const streamed = clipEventsOn(hub.health);
  const takeStreamed = clipTakeEventsOn(hub.health);
  const [live, setLive] = useState<ClipLive | null>(null);
  const [shown, setShown] = useState<ClipRunSummary | null>(null);
  const [runs, setRuns] = useState<ClipRunSummary[] | null | undefined>(undefined);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [armed, setArmed] = useState<Set<string> | null>(null);
  const reloadClip = useRef<() => void>(() => {});
  const seen = useRef<number>(events.length ? events[events.length - 1].id : 0);

  const loadRuns = () => {
    api.clips.runs(path).then((r) => {
      setRuns(r.runs);
      setRunsError(null);
    }, (e: Error) => setRunsError(e.message));
  };
  // A run already under way on this clip (opened mid-run, or mid-take), and the history.
  useEffect(() => {
    api.clips.status().then((s) => {
      if (s?.run_id && s.clip && clipPackage(s.clip) === clipPackage(path)) setLive(clipLiveFromStatus(s));
    }, () => {});
    loadRuns();
  }, [path]);

  // The daemon's clip.* events since the last render.
  useEffect(() => {
    if (!streamed) return;
    const fresh = events.filter((e) => e.id > seen.current);
    if (!fresh.length) return;
    seen.current = fresh[fresh.length - 1].id;
    setLive((l) => fresh.reduce<ClipLive | null>((acc, e) => foldClipEvent(acc, e, path), l));
  }, [events.length ? events[events.length - 1].id : 0, streamed]);

  // No clip events from this daemon: poll the run while it plays.
  const playing = clipPlaying(live);
  useEffect(() => {
    if (streamed || !playing || !live) return;
    const id = live.runId;
    const t = setInterval(() => {
      api.clips.status(id).then((s) => setLive((l) => (l && l.runId === s.run_id ? { ...clipLiveFromStatus(s), take: null } : l)), () => {});
    }, CLIP_POLL_MS);
    return () => clearInterval(t);
  }, [streamed, playing, live?.runId]);

  // A run that ends: its history row, and for a recording the clip with its take.
  const was = useRef(false);
  useEffect(() => {
    if (was.current && !playing) {
      loadRuns();
      if (live?.mode === "record") reloadClip.current();
    }
    was.current = playing;
  }, [playing]);

  const start = async (f: () => Promise<Parameters<typeof clipLiveFromStatus>[0]>) => {
    setStarting(true);
    setError(null);
    setShown(null);
    try {
      const s = await f();
      setLive(s?.run_id ? clipLiveFromStatus({ ...s, state: s.state ?? "running" }) : null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  };
  const stop = async () => {
    try {
      if (live?.mode === "record") await api.clips.recordStop();
      else await api.clips.stop(live?.runId);
      if (live && !streamed) setLive(clipLiveFromStatus(await api.clips.status(live.runId)));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const verdict = async (check: string, v: "pass" | "fail" | "skip", note: string) => {
    try {
      const s = await api.clips.verdict(check, v, note.trim() || undefined);
      // The verdict's answer may be partial; the run's own updates carry the rest.
      setLive((l) => (l ? { ...l, awaiting: Array.isArray(s?.awaiting) ? s.awaiting : l.awaiting.filter((a) => a !== check) } : l));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const view = shown ? clipLiveFromSummary(shown) : live;

  return (
    <ClipScreen path={path}>
      {({ clip, reload }) => {
        reloadClip.current = reload;
        // Input Action lanes are armed until a person says otherwise; a move, action or value lane only when armed, so a take never replaces drawn actor lanes unasked.
        const arm = armed ?? new Set((clip.tracks ?? []).map((t) => t.action));
        const overlay: LaneOverlay = {
          cursor: view && !shown && playing ? view.position : undefined,
          checkStatus: view ? Object.fromEntries(Object.values(view.checks).map((c) => [c.id, c.status])) : undefined,
          regionStatus: view ? Object.fromEntries(Object.values(view.regions).map((r) => [r.id, { status: r.status, drift: driftText(r.drift) }])) : undefined,
          laneStatus: view?.lanes,
          armed: arm,
          onArm: playing ? undefined : (action, on) => {
            const next = new Set(arm);
            if (on) next.add(action);
            else next.delete(action);
            setArmed(next);
          },
          ...(live?.mode === "record" && playing && live.take && !shown ? takeOverlay(live, clip) : {}),
        };
        return {
          overlay,
          panel: (
            <Transport
              clip={clip}
              live={live}
              shown={shown}
              runs={runs}
              runsError={runsError}
              error={error}
              starting={starting}
              armedCount={arm.size}
              liveTakeHidden={!takeStreamed && live?.mode === "record" && playing}
              onPlay={(region) => void start(() => api.clips.run(path, region))}
              onRecord={(punch) => void start(() => api.clips.record({ path, ...punch, armed: [...arm] }))}
              onStop={() => void stop()}
              onVerdict={(c, v, n) => void verdict(c, v, n)}
              onShow={setShown}
            />
          ),
        };
      }}
    </ClipScreen>
  );
}

/** The take so far as lane overlays, keyed by the clip's own track names. */
function takeOverlay(live: ClipLive, clip: Clip): Pick<LaneOverlay, "take" | "takeKeys"> {
  const take: NonNullable<LaneOverlay["take"]> = {};
  const takeKeys: NonNullable<LaneOverlay["takeKeys"]> = {};
  for (const t of live.take?.tracks ?? []) {
    const action = clip.tracks?.find((c) => clipPackage(c.action) === clipPackage(t.action))?.action ?? t.action;
    if (t.notes?.length) take[action] = t.notes;
    if (t.keys?.length) takeKeys[action] = t.keys;
  }
  return { take, takeKeys };
}

function Transport({ clip, live, shown, runs, runsError, error, starting, armedCount, liveTakeHidden, onPlay, onRecord, onStop, onVerdict, onShow }: {
  clip: Clip;
  live: ClipLive | null;
  shown: ClipRunSummary | null;
  runs: ClipRunSummary[] | null | undefined;
  runsError: string | null;
  error: string | null;
  starting: boolean;
  armedCount: number;
  liveTakeHidden: boolean;
  onPlay: (region?: string) => void;
  onRecord: (punch: { region?: string; from_check?: string }) => void;
  onStop: () => void;
  onVerdict: (check: string, v: "pass" | "fail" | "skip", note: string) => void;
  onShow: (r: ClipRunSummary | null) => void;
}) {
  const [region, setRegion] = useState("");
  const [punch, setPunch] = useState("");
  const playing = clipPlaying(live);
  const holds = useMemo(() => (clip.checks ?? []).filter((c) => c.mode === "hold" && !c.manual), [clip.checks]);
  const regions = clip.regions ?? [];
  const busy = starting || playing;
  const recordArgs = (): { region?: string; from_check?: string } => (punch.startsWith("r:") ? { region: punch.slice(2) } : punch.startsWith("c:") ? { from_check: punch.slice(2) } : {});

  return (
    <section className="hub-clip-transport" aria-label={CLIP_COPY.play}>
      <div className="hub-clip-transport-row">
        <label className="small">
          <span className="sr-only">{CLIP_COPY.play}</span>
          <select value={region} disabled={busy} onChange={(e) => setRegion(e.target.value)} aria-label={CLIP_COPY.play}>
            <option value="">{CLIP_COPY.wholeClip}</option>
            {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </label>
        <button className="primary" disabled={busy} onClick={() => onPlay(region || undefined)}>{starting ? CLIP_COPY.starting : CLIP_COPY.play}</button>
        <span className="hub-clip-transport-gap" />
        <label className="small">
          {CLIP_COPY.punchIn}{" "}
          <select value={punch} disabled={busy} onChange={(e) => setPunch(e.target.value)}>
            <option value="">{CLIP_COPY.frameZero}</option>
            {regions.map((r) => <option key={r.id} value={`r:${r.id}`}>{r.name}</option>)}
            {holds.map((c) => <option key={c.id} value={`c:${c.id}`}>{CLIP_COPY.holdCheck(c.name ?? c.id)}</option>)}
          </select>
        </label>
        <button className="hub-clip-record" disabled={busy || armedCount === 0} title={armedCount === 0 ? CLIP_COPY.armNone : undefined} onClick={() => onRecord(recordArgs())}>{CLIP_COPY.record}</button>
        {playing && <button onClick={onStop}>{live?.mode === "record" ? CLIP_COPY.stopRecording : CLIP_COPY.stop}</button>}
      </div>
      {armedCount === 0 && <div className="small dim">{CLIP_COPY.armNone}</div>}
      {error && <div className="banner bad small" role="alert">{error}</div>}
      {live && !shown && <RunLine live={live} />}
      {liveTakeHidden && <div className="small dim">{CLIP_COPY.liveTakeHidden}</div>}
      {live && !shown && live.awaiting.map((id) => {
        const c = clip.checks?.find((x) => x.id === id);
        return <Verdict key={id} id={id} instruction={c?.instruction ?? c?.name ?? id} onVerdict={onVerdict} />;
      })}
      <RunHistory runs={runs} error={runsError} shown={shown} onShow={onShow} names={Object.fromEntries(regions.map((r) => [r.id, r.name]))} />
    </section>
  );
}

function RunLine({ live }: { live: ClipLive }) {
  const total = live.summary?.total ?? Object.keys(live.checks).length;
  let text: string;
  let tone = "";
  if (clipPlaying(live)) {
    text = live.holding && live.awaiting.includes(live.holding) ? CLIP_COPY.pausedAt(live.position) : live.holding ? CLIP_COPY.holdingAt(live.holding) : live.mode === "record" ? CLIP_COPY.recording(live.position) : CLIP_COPY.playing(live.position, live.length);
  } else if (live.state === "unreachable") {
    text = CLIP_COPY.unreachable;
    tone = "bad";
  } else if (live.state === "stopped") {
    text = CLIP_COPY.stopped(live.stopReason);
  } else if (live.passed) {
    text = CLIP_COPY.passedSummary(live.summary?.passed ?? total, total);
    tone = "ok";
  } else {
    text = CLIP_COPY.failedSummary(live.summary?.failed ?? Object.values(live.checks).filter((c) => c.status === "failed").length, total);
    tone = "bad";
  }
  const drift = driftCm(live.drift);
  const failed = Object.values(live.checks).filter((c) => c.status === "failed" && c.evidence?.reason);
  return (
    <div className="hub-clip-runline" role="status">
      <strong className={tone}>{text}</strong>
      {drift && !clipPlaying(live) && <span className="small dim">{CLIP_COPY.drift(drift)}</span>}
      {failed.map((c) => <div key={c.id} className="small"><span className="mono">{c.id}</span> {c.evidence!.reason}</div>)}
    </div>
  );
}

function Verdict({ id, instruction, onVerdict }: { id: string; instruction: string; onVerdict: (check: string, v: "pass" | "fail" | "skip", note: string) => void }) {
  const [note, setNote] = useState("");
  return (
    <div className="hub-clip-verdict" role="group" aria-label={CLIP_COPY.verdictTitle}>
      <div className="hub-eyebrow">{CLIP_COPY.verdictTitle}</div>
      <div>{instruction}</div>
      <input aria-label={CLIP_COPY.verdictNote} placeholder={CLIP_COPY.verdictNote} value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="hub-clip-verdict-actions">
        <button className="primary small-button" onClick={() => onVerdict(id, "pass", note)}>{CLIP_COPY.pass}</button>
        <button className="small-button" onClick={() => onVerdict(id, "fail", note)}>{CLIP_COPY.fail}</button>
        <button className="ghost small-button" onClick={() => onVerdict(id, "skip", note)}>{CLIP_COPY.skip}</button>
      </div>
    </div>
  );
}

const when = (iso?: string): string => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

function RunHistory({ runs, error, shown, onShow, names }: { runs: ClipRunSummary[] | null | undefined; error: string | null; shown: ClipRunSummary | null; onShow: (r: ClipRunSummary | null) => void; names: Record<string, string> }) {
  if (runs === undefined && !error) return null;
  return (
    <div className="hub-clip-runs">
      <div className="hub-eyebrow">{CLIP_COPY.runs}</div>
      {error && <div className="small bad">{error}</div>}
      {runs === null && <div className="small dim">{CLIP_COPY.runsUnavailable}</div>}
      {runs && runs.length === 0 && <div className="small dim">{CLIP_COPY.noRuns}</div>}
      {shown && (
        <div className="small">
          {CLIP_COPY.showingRun(when(shown.started_at))} <button className="ghost small-button" onClick={() => onShow(null)}>{CLIP_COPY.showLatest}</button>
        </div>
      )}
      {runs && runs.length > 0 && (
        <ul className="hub-clip-run-list">
          {runs.map((r) => {
            const total = r.summary?.total ?? 0;
            const result = r.state === "stopped" ? CLIP_COPY.stopped(r.stop_reason) : r.passed ? CLIP_COPY.passedSummary(r.summary?.passed ?? total, total) : CLIP_COPY.failedSummary(r.summary?.failed ?? 0, total);
            return (
              <li key={r.run_id}>
                <button className={`ghost hub-clip-run ${shown?.run_id === r.run_id ? "on" : ""}`} aria-pressed={shown?.run_id === r.run_id} onClick={() => onShow(shown?.run_id === r.run_id ? null : r)}>
                  <span className="small dim">{when(r.started_at)}</span>
                  <span className="small">{r.mode === "record" ? CLIP_COPY.recorded : CLIP_COPY.played}{r.region ? ` · ${names[r.region] ?? r.region}` : ""}</span>
                  <span className={`small ${r.passed ? "ok" : r.state === "stopped" ? "dim" : "bad"}`}>{result}</span>
                  {driftText(r.drift) && <span className="small dim">{driftText(r.drift)}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

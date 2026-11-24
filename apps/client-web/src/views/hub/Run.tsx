/**
 * One run as evidence: its steps as bars on the run's own clock, each step's
 * expectation, what ue-mcp read and what the arrange and act did, the
 * values ue-mcp tracked drawn as lines, the warnings and errors PIE
 * logged, and what changed since the check last passed. A step that waits
 * for a person is judged here too.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { QaStep, QaVerdict, RunDetail } from "@ue-mcp-studio/shared";
import {
  HUB_COPY,
  HUB_LIVE_COPY,
  RUN_OUTCOME_LOOK,
  RUN_SOURCE_LABEL,
  STEP_LOOK,
  evidenceText,
  expectLine,
  judgeLabel,
  playingStep,
  provenanceParts,
  runLength,
  runMarks,
  runPlaying,
  runTimeline,
  seriesPath,
  shortAgo,
} from "@ue-mcp-studio/client-core";
import { api } from "../../api";
import { FailNote } from "../../chat/Qa";
import { useHub } from "./state";
import { Empty, HubIcon, HubLink, Placeholder, ScreenHead, StatusMark, StatusPill } from "./parts";
import { HubViewer, useHubViewer } from "./live";
import { HubLinks } from "./links";

export function RunScreen({ runId }: { runId: string }) {
  const hub = useHub();
  const { go, data } = hub;
  const [d, setD] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const [failing, setFailing] = useState<number | null>(null);
  const read = () => api.hub.run(runId).then((r) => {
    setD(r);
    setError(null);
  }, (e: Error) => setError(e.message));
  useEffect(() => {
    void read();
  }, [runId, data.version]);
  const steps = useRef<HTMLOListElement>(null);

  const record = d?.record;
  const checkId = record ? `${record.kind}:${record.target}` : null;
  hub.onKeys((a) => {
    if (!d) return false;
    const n = d.steps.length;
    if (a.type === "next") setFocus((f) => Math.min(n - 1, (f ?? -1) + 1));
    else if (a.type === "prev") setFocus((f) => Math.max(0, (f ?? 1) - 1));
    else if (a.type === "run" && checkId) void hub.runCheck(checkId, record!.name);
    else return false;
    return true;
  });
  useEffect(() => {
    if (focus === null) return;
    const el = steps.current?.querySelector<HTMLElement>(`[data-step="${focus}"]`);
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
  }, [focus]);

  const tl = useMemo(() => (d ? runTimeline(d.steps) : null), [d]);
  // The Viewport card: "Running now" while this run plays; the picture once expanded.
  const playing = !!record && runPlaying(record) && hub.o.editor.connected;
  const viewer = useHubViewer(playing && record ? { runId: record.runId, checkId: `${record.kind}:${record.target}`, name: record.name } : null);

  if (!d || !record) {
    return <div className="hub-screen">{error ? <Empty title="Run not found" actions={<button onClick={() => go({ screen: "overview" })}>Go to Overview</button>}>{error}</Empty> : <Placeholder rows={5} />}</div>;
  }

  const look = RUN_OUTCOME_LOOK[record.outcome];
  const qaSteps = new Map<number, QaStep>((d.run?.steps ?? []).map((s) => [s.index, s]));
  const changed = new Set(d.changedSteps ?? []);
  const results = d.resultsUrl ?? (d.run?.resultsPath ? api.hub.resultsUrl(runId) : null);
  const verdict = async (step: number, v: QaVerdict, note?: string) => {
    setFailing(null);
    try {
      await api.hub.verdict(runId, step, v, note);
      void read();
      data.reload();
    } catch (e) {
      hub.notify(`The verdict was not recorded: ${(e as Error).message}`, "bad");
    }
  };
  const errors = (d.log ?? []).filter((l) => l.level === "error").length;
  const warnings = (d.log ?? []).length - errors;
  const now = playingStep(d.steps);
  const nowQa = now ? qaSteps.get(now.index) : undefined;
  const nowExpect = nowQa ? expectLine(nowQa) : "";
  const overlay = now ? (
    <>
      <div className="hub-live-step-top">
        <span className="mono">{HUB_LIVE_COPY.stepOf(now.index + 1, d.steps.length)}</span>
        {now.status === "pending" ? <span>{HUB_LIVE_COPY.next}</span> : <><StatusMark look={STEP_LOOK[now.status]} size={12} /><span>{STEP_LOOK[now.status].label}</span></>}
      </div>
      <div className="hub-live-step-text">{now.instruction}</div>
      {nowExpect && <div className="hub-live-step-expect mono">Expect {nowExpect}</div>}
    </>
  ) : null;

  return (
    <div className="hub-screen hub-run">
      <ScreenHead
        back={checkId ? { label: record.name, route: { screen: "check", checkId } } : undefined}
        eyebrow="Run"
        title={record.name}
        sub={<>
          <StatusPill look={look} />
          <span className="dim small" title={new Date(record.startedAt).toLocaleString()}>{new Date(record.startedAt).toLocaleString()}</span>
          {record.durationMs ? <span className="dim small">{runLength(record.durationMs)}</span> : null}
          <span className="dim small">{RUN_SOURCE_LABEL[record.source]}</span>
          {record.map && <span className="mono small dim">{record.map.split("/").pop()}</span>}
          {runMarks(record).map((m) => <span key={m.label} className="pill" title={m.title}>{m.label}</span>)}
        </>}
        actions={<>
          {checkId && <button className="primary" onClick={() => void hub.runCheck(checkId, record.name)} title="Run again (r)"><HubIcon name="play" size={12} /> Run again</button>}
          {record.outcome === "failed" && checkId && <button title="An agent fixes it in a chat session of its own" onClick={() => void api.hub.fix({ checkId }).then((r) => { hub.notify(HUB_COPY.fixesQueued(r.queued)); hub.data.reload(); }, (e: Error) => hub.notify(e.message, "bad"))}><HubIcon name="assign" size={12} /> {HUB_COPY.fix}</button>}
          {record.sessionId && <button className="ghost" onClick={() => hub.openChat(record.sessionId!, runId)} title="The playtest's card in its session"><HubIcon name="external" size={12} /> Open in chat</button>}
        </>}
      />
      <div className="hub-provenance small dim" aria-label="What this run tested">{provenanceParts(record.provenance).join(" · ")}</div>
      {d.lastPass && (
        <div className="hub-compare small">
          <span>{changed.size ? `${changed.size} ${changed.size === 1 ? "step differs" : "steps differ"} from` : "Same results as"} the last pass,</span>
          <HubLink href={`#/playtests/runs/${encodeURIComponent(d.lastPass.runId)}`} onGo={() => go({ screen: "run", runId: d.lastPass!.runId })}>{shortAgo(d.lastPass.startedAt)} ago</HubLink>
        </div>
      )}
      <HubLinks links={record.links} onAdd={async (l) => { await api.hub.addRunLink(runId, l); void read(); }}
        onRemove={(url) => void api.hub.removeRunLink(runId, url).then(() => read(), (e: Error) => hub.notify(e.message, "bad"))} />
      {record.replayOf && (
        <div className="hub-compare small">Replay of <HubLink href={`#/playtests/runs/${encodeURIComponent(record.replayOf)}`} onGo={() => go({ screen: "run", runId: record.replayOf! })}>an earlier run</HubLink>{d.run?.summary.regressions ? `, ${d.run.summary.regressions} regressed` : ""}</div>
      )}

      <div className={`hub-run-stage ${viewer.open ? "with-live" : ""}`}>
      <HubViewer viewer={viewer} overlay={overlay} linkRun={false} className="hub-run-live" />
      <div className="hub-run-col">
      {tl && d.steps.length > 0 && (
        <section className="hub-section">
          <div className="hub-section-head"><h2>Timeline</h2><span className="spacer" /><span className="mono small dim">{runLength(tl.totalMs)}</span></div>
          <div className="hub-timeline" role="list" aria-label="Steps on the run's clock">
            {tl.bars.map((b) => {
              const sl = STEP_LOOK[b.span.status];
              return (
                <button key={b.span.index} role="listitem" className={`hub-tl-bar tone-${sl.tone} ${focus === b.span.index ? "on" : ""} ${changed.has(b.span.index) ? "changed" : ""}`}
                  style={{ left: `${b.left}%`, width: `${b.width}%` }}
                  title={`${b.span.index + 1}. ${b.span.instruction}: ${sl.label}${b.span.startMs !== null ? ` at ${runLength(b.span.startMs)}` : ""}`}
                  aria-label={`Step ${b.span.index + 1}: ${sl.label}`}
                  onClick={() => setFocus(b.span.index)} />
              );
            })}
          </div>
          <div className="hub-tl-axis mono small dim"><span>0s</span><span>{runLength(tl.totalMs / 2)}</span><span>{runLength(tl.totalMs)}</span></div>
        </section>
      )}

      {d.series && Object.keys(d.series).length > 0 && (
        <section className="hub-section">
          <div className="hub-section-head"><h2>Observed values</h2></div>
          <div className="hub-series">
            {Object.entries(d.series).map(([name, pts]) => <SeriesChart key={name} name={name} points={pts} totalMs={tl?.totalMs ?? 0} />)}
          </div>
        </section>
      )}

      <section className="hub-section">
        <div className="hub-section-head"><h2>Steps <span className="dim">{d.steps.length}</span></h2></div>
        <ol className="hub-run-steps" ref={steps}>
          {d.steps.map((s) => {
            const sl = STEP_LOOK[s.status];
            const q = qaSteps.get(s.index);
            const ev = q ? evidenceText(q) : "";
            const captures = q?.evidence?.captures ?? [];
            return (
              <li key={s.index} data-step={s.index} className={`hub-run-step tone-${sl.tone} ${focus === s.index ? "on" : ""}`} onClick={() => setFocus(s.index)}>
                <div className="hub-run-step-head">
                  <span className="hub-step-num mono">{s.index + 1}</span>
                  <StatusMark look={sl} label={sl.label} />
                  <span className="hub-step-text">{s.instruction}</span>
                  {changed.has(s.index) && <span className="pill warn" title="Its result differs from the last pass">Changed</span>}
                  <span className="spacer" />
                  <span className="small dim">{q?.verdictSource === "agent" ? "Watched by an agent" : judgeLabel(s)}</span>
                  {s.startMs !== null && <span className="mono small dim">{runLength(s.startMs)}</span>}
                </div>
                {ev && <pre className="hub-evidence small">{ev}</pre>}
                {q?.actResult && <ActLine step={q} />}
                {q?.note && <p className="small muted">"{q.note}"</p>}
                {captures.length > 0 && (
                  <div className="hub-captures">
                    {captures.map((_, n) => <a key={n} href={api.qaCaptureUrl(runId, s.index, n)} target="_blank" rel="noreferrer"><img src={api.qaCaptureUrl(runId, s.index, n)} alt={`Capture ${n + 1} of step ${s.index + 1}`} loading="lazy" /></a>)}
                  </div>
                )}
                {s.status === "awaiting_verdict" && (
                  <div className="hub-verdict" role="group" aria-label={`Verdict for step ${s.index + 1}`}>
                    <button className="verdict-pass" onClick={() => void verdict(s.index, "pass")}>Pass</button>
                    <button className="verdict-fail" onClick={() => setFailing(failing === s.index ? null : s.index)} aria-expanded={failing === s.index}>Fail</button>
                    <button className="ghost" onClick={() => void verdict(s.index, "skip")}>Skip</button>
                  </div>
                )}
                {failing === s.index && <FailNote step={s.index} initial="" onSubmit={(note) => void verdict(s.index, "fail", note)} onCancel={() => setFailing(null)} />}
              </li>
            );
          })}
        </ol>
      </section>
      </div>
      </div>

      {d.log && d.log.length > 0 && (
        <section className="hub-section">
          <details className="hub-log" open={d.log.length <= 8}>
            <summary><h2>PIE log</h2><span className="small dim">{errors} {errors === 1 ? "error" : "errors"}, {warnings} {warnings === 1 ? "warning" : "warnings"}</span></summary>
            <ol>
              {d.log.map((l, i) => (
                <li key={i} className={`hub-log-line ${l.level}`}>
                  <span className="mono small dim">{runLength(l.atMs)}</span>
                  <StatusMark look={l.level === "error" ? RUN_OUTCOME_LOOK.failed : RUN_OUTCOME_LOOK.incomplete} label={l.level === "error" ? "Error" : "Warning"} size={12} />
                  <span className="mono small">{l.text}</span>
                </li>
              ))}
            </ol>
          </details>
        </section>
      )}

      {results && (
        <details className="hub-raw small">
          <summary>Raw files</summary>
          <a href={results} target="_blank" rel="noreferrer">results.json</a>
          {d.run?.resultsPath && <span className="mono dim"> {d.run.resultsPath}</span>}
        </details>
      )}
    </div>
  );
}

/** What a step's arrange and act did, as one line. */
function ActLine({ step }: { step: QaStep }) {
  const r = step.actResult;
  if (!r) return null;
  const actions = Array.isArray(r.actions) ? r.actions : [];
  const bad = actions.filter((a) => a.ok === false);
  const text = bad.length ? bad.map((a) => `${a.action}: ${a.error ?? "failed"}`).join("; ")
    : r.status === "skipped" ? `Skipped${r.reason ? `: ${r.reason}` : ""}`
    : r.status === "failed" ? `Failed${r.reason ? `: ${r.reason}` : ""}`
    : r.status === "running" ? "Running"
    : `${actions.length} ${actions.length === 1 ? "action" : "actions"} ran${r.duration_ms ? ` in ${runLength(r.duration_ms)}` : ""}`;
  return <p className={`small hub-act ${r.status === "failed" || bad.length ? "hub-bad-text" : "dim"}`}>Arrange and act: {text}</p>;
}

/** A tracked value over the run, as a line on the run's clock. */
function SeriesChart({ name, points, totalMs }: { name: string; points: Array<[number, number]>; totalMs: number }) {
  const W = 320;
  const H = 64;
  const p = seriesPath(points, W, H, totalMs > 0 ? { from: 0, to: totalMs } : undefined);
  if (!p) return null;
  const fmt = (n: number) => (Math.abs(n) >= 1000 || Number.isInteger(n) ? String(Math.round(n)) : n.toFixed(2));
  return (
    <figure className="hub-chart">
      <figcaption className="small"><span className="mono">{name}</span><span className="dim">{fmt(p.min)} to {fmt(p.max)}</span></figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${name}: from ${fmt(p.min)} to ${fmt(p.max)} over ${points.length} samples`}>
        <line x1="0" x2={W} y1={H - 1} y2={H - 1} className="hub-chart-axis" />
        <path d={p.d} className="hub-chart-line" vectorEffect="non-scaling-stroke" />
      </svg>
    </figure>
  );
}

/**
 * One playtest: what it does step by step, every run it has had (newest
 * first, a page at a time), how often its result flips, the goals that rely
 * on it, and its own links, wherever it is listed. Its steps are edited in
 * the playtest card's own editor.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { CheckDetail, QaRun, RunRecord, TrackerLink } from "@ue-mcp-studio/shared";
import { HubLinks } from "./links";
import {
  CHECK_CHANGE_LOOK,
  CHECK_HEALTH_LOOK,
  GOAL_STATUS_LOOK,
  HUB_COPY,
  withLink,
  withoutLink,
  RUN_OUTCOME_LOOK,
  RUN_SOURCE_LABEL,
  flips,
  hubHash,
  judgeLabel,
  passRateText,
  revisionText,
  runLength,
  runMarks,
  shortAgo,
} from "@ue-mcp-studio/client-core";
import { api } from "../../api";
import { QaCard, QaContext, savedScriptActions, type QaLive } from "../../chat/Qa";
import { useCursor, useHub } from "./state";
import { Empty, EvidenceScope, HubIcon, HubLink, Placeholder, ScreenHead, StatusMark, StatusPill, WinLoss } from "./parts";

const PAGE = 30;

export function CheckScreen({ checkId }: { checkId: string }) {
  const hub = useHub();
  const { o, go, data } = hub;
  const [detail, setDetail] = useState<CheckDetail | null>(null);
  const [older, setOlder] = useState<RunRecord[]>([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    let live = true;
    api.hub.check(checkId, { limit: PAGE }).then((d) => {
      if (!live) return;
      setDetail(d);
      setMore(d.more);
      setError(null);
    }, (e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [checkId, data.version]);
  const state = detail?.state ?? o.checks.find((c) => c.id === checkId) ?? null;
  const runs = useMemo(() => [...(detail?.runs ?? []), ...older.filter((r) => !detail?.runs.some((d) => d.runId === r.runId))], [detail, older]);
  const list = useRef<HTMLDivElement>(null);
  const [at, setAt, move] = useCursor(runs.length, list);

  const loadOlder = () => {
    const last = runs[runs.length - 1];
    if (!last) return;
    api.hub.runs({ check: checkId, limit: PAGE, before: last.runId }).then((r) => {
      setOlder((cur) => [...cur, ...r.runs]);
      setMore(r.more);
    }, (e: Error) => hub.notify(e.message, "bad"));
  };

  hub.onKeys((a) => {
    if (a.type === "next") move(1);
    else if (a.type === "prev") move(-1);
    else if (a.type === "open" && runs[at]) go({ screen: "run", runId: runs[at].runId });
    else if (a.type === "run" && state) void hub.runCheck(checkId, state.name);
    else return false;
    return true;
  });

  const live: QaLive = useMemo(() => ({ events: [], streaming: true, forms: [], sessionId: null }), []);

  if (!state) {
    return (
      <div className="hub-screen">
        {error ? <Empty title="This playtest is not known" actions={<button onClick={() => go({ screen: "library" })}>Go to Library</button>}>{error}</Empty> : <Placeholder />}
      </div>
    );
  }

  const look = CHECK_HEALTH_LOOK[state.health];
  const goals = state.goalIds.map((id) => o.goals.find((g) => g.goal.id === id)).filter((g): g is NonNullable<typeof g> => !!g);
  const durations = runs.map((r) => r.durationMs).filter((d): d is number => typeof d === "number").sort((a, b) => a - b);
  const median = durations.length ? durations[Math.floor(durations.length / 2)] : null;
  const flipCount = flips(state.recent);
  const script: QaRun | null = detail?.script ?? null;
  // A playtest's links are its own record, the same on every goal that lists it.
  const saveLinks = async (links: TrackerLink[]) => {
    try {
      await api.hub.updateCheck(checkId, { links });
    } finally {
      data.reload();
    }
  };
  const fix = async () => {
    try {
      hub.notify(HUB_COPY.fixesQueued((await api.hub.fix({ checkId })).queued));
      data.reload();
    } catch (e) {
      hub.notify((e as Error).message, "bad");
    }
  };

  return (
    <div className="hub-screen hub-check">
      <ScreenHead
        back={{ label: HUB_COPY.library, route: { screen: "library" } }}
        eyebrow={HUB_COPY.playtest}
        title={state.name}
        sub={<>
          <StatusPill look={look} />
          {state.change && <StatusPill look={CHECK_CHANGE_LOOK[state.change.kind]} />}
          <span className="mono small dim hub-path">{state.check.target}</span>
          <EvidenceScope />
        </>}
        actions={<>
          <button className="primary" onClick={() => void hub.runCheck(checkId, state.name)} disabled={state.missing} title="Run (r)"><HubIcon name="play" size={12} /> Run</button>
          {state.health === "failing" && <button onClick={() => void fix()} title="An agent fixes it in a chat session of its own"><HubIcon name="assign" size={12} /> {HUB_COPY.fix}</button>}
          <button onClick={() => hub.addToGoal([checkId])}><HubIcon name="goal" size={12} /> {HUB_COPY.addToGoal}</button>
          {script && <button className="ghost" aria-expanded={editing} onClick={() => setEditing((e) => !e)}><HubIcon name="edit" size={12} /> {editing ? "Done editing" : "Edit steps"}</button>}
        </>}
      />
      {state.missing && <div className="banner small">{HUB_COPY.notOnCheckout}</div>}
      {state.renamedFrom && <p className="dim small mono">{HUB_COPY.movedFrom(state.renamedFrom)}</p>}
      <div className="hub-stats">
        <div className="hub-stat"><span className="hub-stat-value">{passRateText(state.passRate)}</span><span className="hub-stat-label">Pass rate</span></div>
        <div className="hub-stat"><span className="hub-stat-value">{flipCount}</span><span className="hub-stat-label">{flipCount === 1 ? "Flip" : "Flips"} in {state.recent.length} runs</span></div>
        <div className="hub-stat"><span className="hub-stat-value">{median !== null ? runLength(median) : "-"}</span><span className="hub-stat-label">Median length</span></div>
        <div className="hub-stat"><span className="hub-stat-value">{state.last ? shortAgo(state.last.startedAt) : "Never"}</span><span className="hub-stat-label">Last run</span></div>
        <div className="hub-stat hub-stat-spark"><WinLoss recent={state.recent} wide /><span className="hub-stat-label">Oldest to newest</span></div>
      </div>
      <div className="hub-goal-chips">
        <span className="dim small">Proves</span>
        {goals.length === 0 ? <span className="dim small">no goal yet</span> : goals.map((g) => (
          <HubLink key={g.goal.id} className="hub-goal-chip" href={hubHash({ screen: "goal", goalId: g.goal.id })} onGo={() => go({ screen: "goal", goalId: g.goal.id })}>
            <StatusMark look={GOAL_STATUS_LOOK[g.status]} size={10} />{g.goal.title}
          </HubLink>
        ))}
      </div>
      <HubLinks
        links={state.links}
        onAdd={(l) => saveLinks(withLink(state.links, l))}
        onRemove={(url) => void saveLinks(withoutLink(state.links, url)).catch((e: Error) => hub.notify(e.message, "bad"))}
      />

      {editing && script ? (
        <QaContext.Provider value={live}>
          <div className="hub-editor"><QaCard run={script} actions={{ script: savedScriptActions(state.check.target, () => data.reload()) }} slotted /></div>
        </QaContext.Provider>
      ) : script && script.steps.length > 0 ? (
        <section className="hub-section">
          <div className="hub-section-head"><h2>Steps <span className="dim">{script.steps.length}</span></h2>{script.map && <span className="mono small dim">{script.map.split("/").pop()}</span>}</div>
          <ol className="hub-steps">
            {script.steps.map((s) => (
              <li key={s.index} className={`hub-step judge-${s.judge}`}>
                <span className="hub-step-num mono">{s.index + 1}</span>
                <span className="hub-step-text">{s.instruction}</span>
                <span className="hub-step-judge small dim">{judgeLabel(s)}</span>
                {s.expect && <span className="hub-step-expect mono small">{s.expect.value} {s.expect.op}{s.expect.target !== undefined ? ` ${s.expect.target}` : ""}{s.withinMs ? ` within ${s.withinMs} ms` : ""}</span>}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <section className="hub-section">
        <div className="hub-section-head"><h2>Runs</h2></div>
        {!detail && !error && <Placeholder rows={3} />}
        {error && <div className="banner bad small">{error}</div>}
        {detail && runs.length === 0 && <p className="dim small">Never run. Run it to see its history here.</p>}
        <div className="hub-list" ref={list}>
          {runs.map((r, i) => <RunRow key={r.runId} r={r} on={i === at} onPoint={() => setAt(i)} />)}
        </div>
        {more && <button className="ghost" onClick={loadOlder}>Show older runs</button>}
      </section>
    </div>
  );
}

/** One run in a history list. */
export function RunRow({ r, on, onPoint }: { r: RunRecord; on?: boolean; onPoint?: () => void }) {
  const { go } = useHub();
  const look = RUN_OUTCOME_LOOK[r.outcome];
  const route = { screen: "run" as const, runId: r.runId };
  const rev = r.provenance ? revisionText(r.provenance.vcs, r.provenance.revision) : null;
  return (
    <HubLink href={hubHash(route)} onGo={() => go(route)} className={`hub-row hub-run-row ${on ? "on" : ""}`} data-row="" aria-current={on || undefined} onMouseEnter={onPoint}>
      <StatusMark look={look} label={look.label} />
      <span className="hub-row-main">
        <span className="hub-row-title">{look.label}{runMarks(r).map((m) => <span key={m.label} className="pill" title={m.title}>{m.label}</span>)}</span>
        <span className="hub-row-meta">
          <span title={new Date(r.startedAt).toLocaleString()}>{new Date(r.startedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
          {rev && <span className="mono">{rev}</span>}
          <span>{RUN_SOURCE_LABEL[r.source]}</span>
          {r.failedSteps && r.failedSteps.length > 0 && <span className="hub-bad-text">Failed at step {r.failedSteps.map((s) => s + 1).join(", ")}</span>}
          {r.summary && <span>{r.summary.passed}/{r.summary.total} passed</span>}
        </span>
      </span>
      <span className="hub-row-num mono">{runLength(r.durationMs)}</span>
      <span className="hub-row-when">{shortAgo(r.startedAt)}</span>
    </HubLink>
  );
}

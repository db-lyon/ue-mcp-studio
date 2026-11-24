/**
 * The overview, useful with no goals at all: what runs now (the strip at the
 * top, with the runs waiting and the ones that finished under it), every
 * playtest with its health, Run all and Run failing, what needs a person and
 * what just broke. Goals are a layer on top: each under its milestone,
 * worst first. The Goals menu moves the goal store to another computer.
 */
import { useMemo, useRef, useState } from "react";
import type { GoalStatus, PlanRun } from "@ue-mcp-studio/shared";
import { GOAL_STATUS_ORDER } from "@ue-mcp-studio/shared";
import {
  GOAL_STATUS_LOOK,
  ATTENTION_KIND_LABEL,
  HUB_COPY,
  HUB_STORE_COPY,
  PLAN_ITEM_LOOK,
  PLAN_STATE_LABEL,
  attentionTarget,
  RUN_OUTCOME_LOOK,
  dueText,
  goalCounts,
  goalSummary,
  hubHash,
  importReportText,
  importedText,
  isGoalsFile,
  milestoneGroups,
  planProgress,
  queuePausedText,
  playingRuns,
  progressText,
  regressions,
  runsDone,
  scopeText,
  shortAgo,
  sortChecks,
} from "@ue-mcp-studio/client-core";
import { api } from "../../api";
import { useAgentFixes, useCursor, useHub } from "./state";
import { Empty,HubIcon, HubLink, Progress, ScreenHead, StatusMark, StatusPill } from "./parts";
import { CheckRow, GoalRow } from "./rows";

export function OverviewScreen({ onChat }: { onChat?: () => void }) {
  const hub = useHub();
  const { o, go } = hub;
  const [only, setOnly] = useState<GoalStatus | null>(null);
  const groups = useMemo(() => milestoneGroups(o.goals), [o.goals]);
  const counts = useMemo(() => goalCounts(o.goals), [o.goals]);
  const shownGroups = groups
    .map((gr) => ({ ...gr, goals: only ? gr.goals.filter((g) => g.status === only) : gr.goals }))
    .filter((gr) => gr.goals.length > 0 || (!only && gr.milestone));
  const flat = shownGroups.flatMap((gr) => gr.goals);
  const list = useRef<HTMLDivElement>(null);
  const [at, setAt, move] = useCursor(flat.length, list);
  const failing = o.checks.filter((c) => c.health === "failing").length;
  const runnable = o.checks.filter((c) => !c.missing).length;
  const imported = importedText(o.imported);

  hub.onKeys((a) => {
    if (a.type === "next") move(1);
    else if (a.type === "prev") move(-1);
    else if (a.type === "open" && flat[at]) go({ screen: "goal", goalId: flat[at].goal.id });
    else if (a.type === "run" && flat[at]) void hub.runPlan({ scope: { kind: "goal", goalId: flat[at].goal.id } }, flat[at].goal.title);
    else return false;
    return true;
  });

  const noGoals = o.goals.filter((g) => !g.goal.archived).length === 0;

  return (
    <div className="hub-screen hub-overview">
      <ScreenHead
        title={HUB_COPY.overview}
        sub={<><span>{goalSummary(o.goals)}</span></>}
        actions={<>
          {failing > 0 && <button onClick={() => void hub.runPlan({ scope: { kind: "failing" } }, "every failing playtest")}><HubIcon name="play" size={12} /> {HUB_COPY.runFailing} <span className="hub-btn-count">{failing}</span></button>}
          {runnable > 0 && <button onClick={() => void hub.runPlan({ scope: { kind: "all" } }, "every playtest")}><HubIcon name="play" size={12} /> {HUB_COPY.runAll}</button>}
          <button className="primary" onClick={() => hub.editGoal(null)} title="New goal (c)"><HubIcon name="plus" size={12} /> {HUB_COPY.newGoal}</button>
          <GoalsMenu />
        </>}
      />
      {imported && <p className="dim small hub-imported">{imported}</p>}
      {o.warnings.map((w) => <div key={w} className="banner warn small">{w}</div>)}
      {!o.editor.connected && <div className="banner warn small hub-editor-down">{HUB_COPY.editorDown}</div>}
      <NowRunning />
      <div className="hub-overview-grid">
        <section className="hub-overview-goals" aria-label={HUB_COPY.goals}>
          {!noGoals && <>
            <div className="hub-chips" role="group" aria-label="Show goals">
              <button className={`filter-chip ${only === null ? "active" : ""}`} aria-pressed={only === null} onClick={() => setOnly(null)}>All <span className="filter-count">{GOAL_STATUS_ORDER.reduce((n, s) => n + counts[s], 0)}</span></button>
              {GOAL_STATUS_ORDER.filter((s) => counts[s] > 0).map((s) => (
                <button key={s} className={`filter-chip hub-chip tone-${GOAL_STATUS_LOOK[s].tone} ${only === s ? "active" : ""}`} aria-pressed={only === s} onClick={() => setOnly(only === s ? null : s)}>
                  <StatusMark look={GOAL_STATUS_LOOK[s]} size={12} />{GOAL_STATUS_LOOK[s].label} <span className="filter-count">{counts[s]}</span>
                </button>
              ))}
            </div>
            <div className="hub-groups" ref={list}>
              {shownGroups.map((gr, gi) => {
                const m = gr.milestone;
                // A goal under two milestones is a row in each: the cursor counts rows, not goals.
                const first = shownGroups.slice(0, gi).reduce((n, x) => n + x.goals.length, 0);
                const due = m ? dueText(m.goal.due) : null;
                return (
                  <section key={m?.goal.id ?? "none"} className="hub-group">
                    {m ? (
                      <HubLink className="hub-group-head" href={hubHash({ screen: "goal", goalId: m.goal.id })} onGo={() => go({ screen: "goal", goalId: m.goal.id })}>
                        <HubIcon name="milestone" />
                        <span className="hub-group-title">{m.goal.title}</span>
                        <StatusPill look={GOAL_STATUS_LOOK[m.status]} />
                        {due && <span className={`small ${due.overdue ? "hub-overdue" : "dim"}`}>{due.text}</span>}
                        <span className="spacer" />
                        <Progress met={m.progress.met} total={m.progress.total} label={progressText(m.progress)} />
                      </HubLink>
                    ) : (
                      shownGroups.length > 1 && <div className="hub-group-head plain"><span className="hub-group-title">{HUB_COPY.otherGoals}</span></div>
                    )}
                    <div className="hub-list">
                      {gr.goals.length === 0 && <p className="dim small hub-list-note">{HUB_COPY.noGoalsInMilestone}</p>}
                      {gr.goals.map((g, j) => {
                        const i = first + j;
                        return <GoalRow key={g.goal.id} g={g} on={i === at} onPoint={() => setAt(i)} />;
                      })}
                    </div>
                  </section>
                );
              })}
            </div>
          </>}
          <Playtests noGoals={noGoals} onChat={onChat} />
        </section>
        <aside className="hub-side">
          <AttentionCard />
          <RegressionsCard />
        </aside>
      </div>
    </div>
  );
}

/** Every playtest with its health, the overview's answer before any goal exists. */
function Playtests({ noGoals, onChat }: { noGoals: boolean; onChat?: () => void }) {
  const { o, go } = useHub();
  const checks = useMemo(() => sortChecks(o.checks), [o.checks]);
  if (checks.length === 0) {
    return (
      <Empty title={HUB_COPY.noChecksTitle} actions={onChat && <button onClick={onChat}>Go to Chat</button>}>
        <p>{HUB_COPY.noChecksLead}</p>
      </Empty>
    );
  }
  return (
    <section className="hub-section hub-overview-playtests" aria-label={HUB_COPY.playtests}>
      <div className="hub-section-head">
        <h2>{HUB_COPY.playtests} <span className="dim">{checks.length}</span></h2>
        <span className="spacer" />
        <HubLink className="small" href={hubHash({ screen: "library" })} onGo={() => go({ screen: "library" })}>Open {HUB_COPY.library}</HubLink>
      </div>
      {noGoals && <p className="dim small">{HUB_COPY.goalsLead}</p>}
      <div className="hub-list">
        {checks.map((c) => <CheckRow key={c.id} c={c} />)}
      </div>
    </section>
  );
}

/** Export the goal store as one file, or import one; where goals live is said here once. */
function GoalsMenu() {
  const hub = useHub();
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const exportGoals = async () => {
    setBusy(true);
    try {
      const data = await api.hub.exportStore();
      const url = URL.createObjectURL(new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = HUB_STORE_COPY.fileName(data.exportedAt);
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      hub.notify(HUB_STORE_COPY.exported);
    } catch (e) {
      hub.notify((e as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  };
  const importGoals = async (f: File) => {
    setBusy(true);
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await f.text());
      } catch {
        parsed = null;
      }
      if (!isGoalsFile(parsed)) return hub.notify(HUB_STORE_COPY.notAFile, "bad");
      hub.notify(importReportText(await api.hub.importStore(parsed)));
      hub.data.reload();
    } catch (e) {
      hub.notify((e as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="hub-menu">
      <summary className="button ghost">{HUB_STORE_COPY.menu} <HubIcon name="down" size={12} /></summary>
      <div className="hub-menu-list" role="menu">
        <p className="dim small">{HUB_STORE_COPY.where}</p>
        <button role="menuitem" className="ghost" disabled={busy} onClick={() => void exportGoals()}>{HUB_STORE_COPY.export}</button>
        <button role="menuitem" className="ghost" disabled={busy} onClick={() => file.current?.click()}>{HUB_STORE_COPY.import}</button>
        <input ref={file} type="file" accept="application/json,.json" hidden aria-hidden="true" onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void importGoals(f);
        }} />
      </div>
    </details>
  );
}

/**
 * Now running: the run on the editor and how far its batch is, why the queue
 * waits or is paused, then the runs waiting and the
 * ones that finished. Release the editor is the app's bar (held.tsx LeaseBar).
 */
function NowRunning() {
  const hub = useHub();
  const { o, go } = hub;
  const q = o.queue;
  const cur = q.current;
  const p = cur ? planProgress(cur) : null;
  const playing = playingRuns(o)[0] ?? null;
  // A run outside any batch (from Chat, or a fix) plays too: named here, since the batch line does not.
  const solo = playing && !cur?.items.some((i) => i.runId === playing.runId) ? playing : null;
  const setQueue = (next: typeof q) => hub.data.patch((ov) => ({ ...ov, queue: next }));
  const pause = async () => {
    const want = !q.paused;
    setQueue({ ...q, paused: want });
    try {
      setQueue(await api.hub.pause(want));
    } catch (e) {
      setQueue({ ...q, paused: !want });
      hub.notify((e as Error).message, "bad");
    }
  };
  const cancel = async (plan: PlanRun) => {
    if (cur?.id !== plan.id) setQueue({ ...q, queued: q.queued.filter((x) => x.id !== plan.id) });
    try {
      await api.hub.cancelPlan(plan.id);
      hub.notify(`Stopped ${plan.title}`);
    } catch (e) {
      hub.notify((e as Error).message, "bad");
    }
    hub.data.reload();
  };
  const idle = !cur && !solo && q.queued.length === 0;
  return (
    <section className="hub-card hub-now-strip" aria-label={HUB_COPY.nowRunning}>
      <div className="hub-card-head">
        <HubIcon name="queue" />
        <span>{HUB_COPY.nowRunning}</span>
        {q.paused && <span className="pill warn" title={queuePausedText(q)}>{PLAN_STATE_LABEL.paused}</span>}
        <span className="spacer" />
        {(!idle || q.paused) && (
          <button className="ghost small-button" aria-pressed={q.paused} onClick={() => void pause()}>
            <HubIcon name={q.paused ? "play" : "pause"} size={12} /> {q.paused ? HUB_COPY.resume : HUB_COPY.pause}
          </button>
        )}
      </div>
      {q.paused && <div className="dim small">{queuePausedText(q)}</div>}
      {q.waiting && <div className="dim small">{HUB_COPY.waiting(q.waiting)}</div>}
      {solo && (
        <HubLink className="hub-now-line" href={hubHash({ screen: "run", runId: solo.runId })} onGo={() => go({ screen: "run", runId: solo.runId })}>
          <StatusMark look={RUN_OUTCOME_LOOK.running} />
          <span className="hub-row-title">{solo.name}</span>
        </HubLink>
      )}
      {cur && p && <PlanCard plan={cur} onCancel={() => void cancel(cur)} live />}
      {idle && <p className="dim small">{HUB_COPY.queueIdle}</p>}
      {q.queued.length > 0 && (
        <ol className="hub-list hub-queued">
          {q.queued.map((plan) => (
            <li key={plan.id} className="hub-row hub-queued-row">
              <span className="dim small">Next</span>
              <span className="hub-row-main">
                <span className="hub-row-title">{plan.title}</span>
                <span className="hub-row-meta"><span>{scopeText(plan.scope, o.goals)}</span><span>{plan.items.length} {plan.items.length === 1 ? "playtest" : "playtests"}</span></span>
              </span>
              <span className="hub-row-actions">
                <button className="ghost icon-button" aria-label={`Stop ${plan.title}`} onClick={() => void cancel(plan)}><HubIcon name="close" size={12} /></button>
              </span>
            </li>
          ))}
        </ol>
      )}
      {q.recent.length > 0 && (
        <details className="hub-finished">
          <summary className="small dim">{HUB_COPY.finished} <span className="filter-count">{q.recent.length}</span></summary>
          <div className="hub-list">{q.recent.map((plan) => <PlanCard key={plan.id} plan={plan} />)}</div>
        </details>
      )}
    </section>
  );
}

/** A batch of runs: its title and scope, progress, and each playtest's state; open by default while it runs. */
function PlanCard({ plan, onCancel, live = false }: { plan: PlanRun; onCancel?: () => void; live?: boolean }) {
  const { o, go, openChat } = useHub();
  const fixes = useAgentFixes();
  const p = planProgress(plan);
  const [open, setOpen] = useState(live);
  return (
    <div className={`hub-plan ${live ? "live" : ""}`}>
      <div className="hub-plan-head">
        <button className="ghost hub-plan-toggle" aria-expanded={open} onClick={() => setOpen((x) => !x)}>
          <HubIcon name="chevron" size={12} />
          <span className="hub-row-title">{live && p.current ? p.current.name : plan.title}</span>
        </button>
        <span className="small dim">{live ? plan.title : scopeText(plan.scope, o.goals)}</span>
        {!live && <span className="pill">{PLAN_STATE_LABEL[plan.state]}</span>}
        {p.failed > 0 && <span className="pill bad">{p.failed} failed</span>}
        <span className="spacer" />
        {!live && plan.endedAt && <span className="small dim">{shortAgo(plan.endedAt)}</span>}
        {fixes && live && p.current?.sessionId && <button className="ghost small-button" onClick={() => openChat(p.current!.sessionId!)}>{HUB_COPY.fixChat}</button>}
        {onCancel && <button className="ghost small-button" onClick={onCancel}>Stop</button>}
      </div>
      <Progress met={p.done} total={p.total} label={runsDone(p.done, p.total)} />
      {open && (
        <ol className="hub-plan-items">
          {plan.items.map((it, i) => {
            const look = PLAN_ITEM_LOOK[it.state];
            return (
              <li key={i} className={`hub-plan-item ${it.state}`}>
                <StatusMark look={look} label={look.label} />
                {it.runId && plan.work !== "fix" ? <HubLink href={hubHash({ screen: "run", runId: it.runId })} onGo={() => go({ screen: "run", runId: it.runId! })}>{it.name}</HubLink> : <span>{it.name}</span>}
                <span className="small dim">{look.label}{it.reason ? `: ${it.reason}` : ""}</span>
                {fixes && it.sessionId && <button className="ghost small-button" onClick={() => openChat(it.sessionId!)}>{HUB_COPY.fixChat}</button>}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

/** What waits for a person and does not need the game playing: each item links to where it is dealt with; a stopped fix opens its chat. */
function AttentionCard() {
  const { o, go, openChat } = useHub();
  // In order already: buildAttention sorts by ATTENTION_ORDER, oldest first.
  const items = o.attention;
  return (
    <section className="hub-card" aria-label={HUB_COPY.attention}>
      <div className="hub-card-head">
        <HubIcon name="attention" />
        <span>{HUB_COPY.attention}</span>
        {items.length > 0 && <span className="tab-count warn">{items.length}</span>}
      </div>
      {items.length === 0 ? <p className="dim small">{HUB_COPY.attentionEmpty}</p> : (
        <div className="hub-list">
          {items.map((it) => (
            <HubLink key={it.id} className={`hub-row hub-mini-row hub-attention-row kind-${it.kind}`} href={hubHash(attentionTarget(it))} onGo={() => (it.sessionId ? openChat(it.sessionId, it.runId) : go(attentionTarget(it)))} title={it.detail}>
              <span className="hub-attention-kind">{ATTENTION_KIND_LABEL[it.kind]}</span>
              <span className="hub-row-title">{it.title}</span>
              <span className="dim small">{shortAgo(it.at)}</span>
            </HubLink>
          ))}
        </div>
      )}
    </section>
  );
}

function RegressionsCard() {
  const { o, go } = useHub();
  const broke = useMemo(() => regressions(o.checks), [o.checks]);
  if (broke.length === 0) return null;
  return (
    <section className="hub-card" aria-label={HUB_COPY.justBroke}>
      <div className="hub-card-head"><StatusMark look={RUN_OUTCOME_LOOK.failed} /><span>{HUB_COPY.justBroke}</span></div>
      <div className="hub-list">
        {broke.slice(0, 5).map((c) => {
          const r = c.last ? { screen: "run" as const, runId: c.last.runId } : { screen: "check" as const, checkId: c.id };
          return (
            <HubLink key={c.id} className="hub-row hub-mini-row" href={hubHash(r)} onGo={() => go(r)} title="Passed on the run before">
              <span className="hub-row-title">{c.name}</span>
              <span className="dim small">{c.last ? shortAgo(c.last.startedAt) : ""}</span>
            </HubLink>
          );
        })}
      </div>
    </section>
  );
}

/**
 * The overview: every goal under its milestone, worst first, with what needs
 * a person, what runs now and what just broke beside it. A project with
 * scripts and no goals gets them listed, with a one-click start.
 */
import { useMemo, useRef, useState } from "react";
import type { GoalStatus } from "@ue-mcp-studio/shared";
import { GOAL_STATUS_ORDER } from "@ue-mcp-studio/shared";
import {
  CHECK_HEALTH_LOOK,
  GOAL_STATUS_LOOK,
  HUB_COPY,
  INBOX_KIND_LABEL,
  PLAN_ITEM_LOOK,
  RUN_OUTCOME_LOOK,
  dueText,
  goalCounts,
  goalSummary,
  hubHash,
  inboxTarget,
  milestoneGroups,
  planProgress,
  playingRuns,
  progressText,
  proposeGoals,
  regressions,
  shortAgo,
  sortChecks,
  sortInbox,
} from "@ue-mcp-studio/client-core";
import { api } from "../../api";
import { useCursor, useHub } from "./state";
import { Empty, HubIcon, HubLink, Progress, ScreenHead, StatusMark, StatusPill } from "./parts";
import { GoalRow } from "./rows";
import { ViewportButton } from "./live";

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
        sub={goalSummary(o.goals)}
        actions={<>
          {failing > 0 && <button onClick={() => void hub.runPlan({ scope: { kind: "failing" } }, "every failing check")} title="Queue every failing check"><HubIcon name="play" size={12} /> {HUB_COPY.runFailing} <span className="hub-btn-count">{failing}</span></button>}
          <button className="primary" onClick={() => hub.editGoal(null)} title="New goal (c)"><HubIcon name="plus" size={12} /> {HUB_COPY.newGoal}</button>
        </>}
      />
      {o.warnings.map((w) => <div key={w} className="banner warn small">{w}</div>)}
      {!o.editor.connected && <div className="banner warn small hub-editor-down">{HUB_COPY.editorDown}</div>}
      <div className="hub-overview-grid">
        <section className="hub-overview-goals" aria-label={HUB_COPY.goals}>
          {noGoals ? <GettingStarted onChat={onChat} /> : <>
            <div className="hub-chips" role="group" aria-label="Show goals">
              <button className={`filter-chip ${only === null ? "active" : ""}`} aria-pressed={only === null} onClick={() => setOnly(null)}>All <span className="filter-count">{GOAL_STATUS_ORDER.reduce((n, s) => n + counts[s], 0)}</span></button>
              {GOAL_STATUS_ORDER.filter((s) => counts[s] > 0).map((s) => (
                <button key={s} className={`filter-chip hub-chip tone-${GOAL_STATUS_LOOK[s].tone} ${only === s ? "active" : ""}`} aria-pressed={only === s} onClick={() => setOnly(only === s ? null : s)}>
                  <StatusMark look={GOAL_STATUS_LOOK[s]} size={12} />{GOAL_STATUS_LOOK[s].label} <span className="filter-count">{counts[s]}</span>
                </button>
              ))}
            </div>
            <div className="hub-groups" ref={list}>
              {shownGroups.map((gr) => {
                const m = gr.milestone;
                return (
                  <section key={m?.goal.id ?? "none"} className="hub-group">
                    {m ? (
                      <HubLink className="hub-group-head" href={hubHash({ screen: "goal", goalId: m.goal.id })} onGo={() => go({ screen: "goal", goalId: m.goal.id })}>
                        <HubIcon name="milestone" />
                        <span className="hub-group-title">{m.goal.title}</span>
                        <StatusPill look={GOAL_STATUS_LOOK[m.status]} />
                        {dueText(m.goal.due) && <span className={`small ${dueText(m.goal.due)!.overdue ? "hub-overdue" : "dim"}`}>{dueText(m.goal.due)!.text}</span>}
                        <span className="spacer" />
                        <Progress met={m.progress.met} total={m.progress.total} label={progressText(m.progress)} />
                      </HubLink>
                    ) : (
                      shownGroups.length > 1 && <div className="hub-group-head plain"><span className="hub-group-title">{HUB_COPY.noMilestone}</span></div>
                    )}
                    <div className="hub-list">
                      {gr.goals.length === 0 && <p className="dim small hub-list-note">No goals in this milestone yet.</p>}
                      {gr.goals.map((g) => {
                        const i = flat.indexOf(g);
                        return <GoalRow key={g.goal.id} g={g} on={i === at} onPoint={() => setAt(i)} />;
                      })}
                    </div>
                  </section>
                );
              })}
            </div>
          </>}
        </section>
        <aside className="hub-side">
          <InboxCard />
          <QueueCard />
          <RegressionsCard />
        </aside>
      </div>
    </div>
  );
}

/** No goals yet: the scripts the project has, and ways to put them under goals at once. */
function GettingStarted({ onChat }: { onChat?: () => void }) {
  const hub = useHub();
  const { o, go } = hub;
  const scripts = useMemo(() => sortChecks(o.checks), [o.checks]);
  const proposals = useMemo(() => proposeGoals(o.checks), [o.checks]);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      for (const p of proposals) await api.hub.createGoal({ title: p.title, checks: p.checks });
      hub.notify(`Created ${proposals.length} ${proposals.length === 1 ? "goal" : "goals"}. Rename them as you like.`);
      hub.data.reload();
    } catch (e) {
      hub.notify((e as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  };
  if (scripts.length === 0) {
    return (
      <Empty title={HUB_COPY.noGoalsTitle} actions={<>
        <button className="primary" onClick={() => hub.editGoal(null)}>{HUB_COPY.newGoal}</button>
        {onChat && <button onClick={onChat}>Go to Chat</button>}
      </>}>
        <p>{HUB_COPY.noGoalsLead}</p>
        <p>{HUB_COPY.noChecksLead}</p>
      </Empty>
    );
  }
  return (
    <div className="hub-start">
      <Empty title={HUB_COPY.noGoalsTitle} actions={<>
        {proposals.length > 0 && (
          <button className="primary" disabled={busy} onClick={() => void create()} title={proposals.map((p) => `${p.title} (${p.checks.length})`).join("\n")}>
            {proposals.length === 1 ? `Create "${proposals[0].title}"` : `Create ${proposals.length} goals, one per map`}
          </button>
        )}
        <button onClick={() => hub.editGoal(null)}>{HUB_COPY.newGoal}</button>
        <button className="ghost" onClick={() => void hub.runPlan({ scope: { kind: "all" } }, "every check")}><HubIcon name="play" size={12} /> {HUB_COPY.runAll}</button>
      </>}>
        <p>{HUB_COPY.noGoalsLead}</p>
      </Empty>
      <div className="hub-start-list">
        <div className="hub-card-head"><span>{HUB_COPY.scriptsFound(scripts.length)}</span><span className="spacer" /><HubLink className="small" href={hubHash({ screen: "library" })} onGo={() => go({ screen: "library" })}>Open Library</HubLink></div>
        <div className="hub-list">
          {scripts.slice(0, 10).map((c) => (
            <HubLink key={c.id} className="hub-row hub-mini-row" href={hubHash({ screen: "check", checkId: c.id })} onGo={() => go({ screen: "check", checkId: c.id })}>
              <StatusMark look={CHECK_HEALTH_LOOK[c.health]} label={CHECK_HEALTH_LOOK[c.health].label} />
              <span className="hub-row-title">{c.name}</span>
              <span className="dim small">{c.last ? shortAgo(c.last.startedAt) : CHECK_HEALTH_LOOK[c.health].label}</span>
            </HubLink>
          ))}
        </div>
        {scripts.length > 10 && <p className="dim small">And {scripts.length - 10} more in the Library.</p>}
      </div>
    </div>
  );
}

function InboxCard() {
  const { o, go } = useHub();
  const items = useMemo(() => sortInbox(o.inbox), [o.inbox]);
  return (
    <section className="hub-card" aria-label={HUB_COPY.inbox}>
      <div className="hub-card-head">
        <HubIcon name="inbox" />
        <HubLink href={hubHash({ screen: "inbox" })} onGo={() => go({ screen: "inbox" })}>{HUB_COPY.inbox}</HubLink>
        {items.length > 0 && <span className="tab-count warn">{items.length}</span>}
      </div>
      {items.length === 0 ? <p className="dim small">{HUB_COPY.inboxEmpty}</p> : (
        <div className="hub-list">
          {items.slice(0, 4).map((it) => (
            <HubLink key={it.id} className="hub-row hub-mini-row" href={hubHash(inboxTarget(it))} onGo={() => go(it.kind === "verdict" ? { screen: "inbox" } : inboxTarget(it))}>
              <span className="hub-inbox-kind">{INBOX_KIND_LABEL[it.kind]}</span>
              <span className="hub-row-title">{it.title}</span>
              <span className="dim small">{shortAgo(it.at)}</span>
            </HubLink>
          ))}
          {items.length > 4 && <HubLink className="small" href={hubHash({ screen: "inbox" })} onGo={() => go({ screen: "inbox" })}>{items.length - 4} more</HubLink>}
        </div>
      )}
    </section>
  );
}

/** What runs now and what is next, one line each, and the Viewport button while something plays. */
function QueueCard() {
  const { o, go } = useHub();
  const q = o.queue;
  const cur = q.current;
  const p = cur ? planProgress(cur) : null;
  const playing = playingRuns(o)[0] ?? null;
  // A run outside any plan (from Chat, or a fix loop) plays too: named here, since the plan line does not.
  const solo = playing && !cur?.items.some((i) => i.runId === playing.runId) ? playing : null;
  return (
    <section className="hub-card" aria-label={HUB_COPY.queue}>
      <div className="hub-card-head">
        <HubIcon name="queue" />
        <HubLink href={hubHash({ screen: "queue" })} onGo={() => go({ screen: "queue" })}>{HUB_COPY.queue}</HubLink>
        {q.paused && <span className="pill warn">Paused</span>}
        <span className="spacer" />
        <ViewportButton relevant={playing !== null} compact />
      </div>
      {solo && (
        <HubLink className="hub-now-line" href={hubHash({ screen: "run", runId: solo.runId })} onGo={() => go({ screen: "run", runId: solo.runId })}>
          <StatusMark look={RUN_OUTCOME_LOOK.running} />
          <span className="hub-row-title">{solo.name}</span>
        </HubLink>
      )}
      {cur && p ? (
        <div className="hub-now">
          <div className="hub-now-line">
            <StatusMark look={PLAN_ITEM_LOOK.running} />
            <span className="hub-row-title">{p.current?.name ?? cur.title}</span>
            <span className="mono small">{p.done}/{p.total}</span>
          </div>
          <div className="dim small">{cur.title}</div>
          <Progress met={p.done} total={p.total} label={`${p.done} of ${p.total} checks done`} />
        </div>
      ) : !solo && <p className="dim small">{HUB_COPY.queueIdle}</p>}
      {q.queued.slice(0, 3).map((plan) => (
        <div key={plan.id} className="hub-next small"><span className="dim">Next</span> {plan.title} <span className="dim">({plan.items.length})</span></div>
      ))}
      {q.queued.length > 3 && <div className="dim small">{q.queued.length - 3} more queued</div>}
    </section>
  );
}

function RegressionsCard() {
  const { o, go } = useHub();
  const broke = useMemo(() => regressions(o.checks), [o.checks]);
  if (broke.length === 0) return null;
  return (
    <section className="hub-card" aria-label="Recent regressions">
      <div className="hub-card-head"><StatusMark look={RUN_OUTCOME_LOOK.failed} /><span>Just broke</span></div>
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

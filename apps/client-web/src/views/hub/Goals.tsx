/**
 * Goals: every goal under its milestones, for a project with too many to
 * list in the rail. Search by title, filter by status, open a row.
 */
import { useMemo, useRef, useState } from "react";
import {
  GOAL_STATUS_LOOK,
  HUB_COPY,
  dueText,
  filterGoalGroups,
  goalCounts,
  goalSummary,
  goalsByMilestone,
  hubHash,
  progressText,
} from "@ue-mcp-studio/client-core";
import { GOAL_STATUS_ORDER, type GoalStatus } from "@ue-mcp-studio/shared";
import { useCursor, useHub } from "./state";
import { Empty, HubIcon, HubLink, Kbd, Progress, ScreenHead, StatusMark, StatusPill } from "./parts";
import { GoalRow } from "./rows";

export function GoalsScreen() {
  const hub = useHub();
  const { o, go } = hub;
  const [only, setOnly] = useState<GoalStatus | null>(null);
  const [text, setText] = useState("");
  const filterBox = useRef<HTMLInputElement>(null);
  const groups = useMemo(() => goalsByMilestone(o.goals), [o.goals]);
  const counts = useMemo(() => goalCounts(o.goals), [o.goals]);
  const shown = useMemo(() => filterGoalGroups(groups, { status: only, text }), [groups, only, text]);
  const flat = shown.flatMap((gr) => gr.goals);
  const list = useRef<HTMLDivElement>(null);
  const [at, setAt, move] = useCursor(flat.length, list);
  const total = GOAL_STATUS_ORDER.reduce((n, s) => n + counts[s], 0);

  hub.onKeys((a) => {
    if (a.type === "next") move(1);
    else if (a.type === "prev") move(-1);
    else if (a.type === "open" && flat[at]) go({ screen: "goal", goalId: flat[at].goal.id });
    else if (a.type === "run" && flat[at]) void hub.runPlan({ scope: { kind: "goal", goalId: flat[at].goal.id } }, flat[at].goal.title);
    else if (a.type === "filter") filterBox.current?.focus();
    else return false;
    return true;
  });

  return (
    <div className="hub-screen hub-goals">
      <ScreenHead
        title={HUB_COPY.goals}
        sub={<span>{goalSummary(o.goals)}</span>}
        actions={<button className="primary" onClick={() => hub.editGoal(null)} title="New goal (c)"><HubIcon name="plus" size={12} /> {HUB_COPY.newGoal}</button>}
      />
      {o.goals.filter((g) => !g.goal.archived).length === 0 ? (
        <Empty title="No goals yet">{HUB_COPY.goalsLead}</Empty>
      ) : (
        <>
          <div className="hub-filters">
            <div className="hub-search">
              <HubIcon name="search" />
              <input
                ref={filterBox}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") { setText(""); (e.target as HTMLInputElement).blur(); }
                  if (e.key === "Enter" || e.key === "ArrowDown") { e.preventDefault(); (e.target as HTMLInputElement).blur(); setAt(0); }
                }}
                placeholder={HUB_COPY.searchGoals}
                aria-label={HUB_COPY.searchGoals}
              />
              {!hub.narrow && <Kbd>/</Kbd>}
            </div>
          </div>
          <div className="hub-chips" role="group" aria-label="Show goals">
            <button className={`filter-chip ${only === null ? "active" : ""}`} aria-pressed={only === null} onClick={() => setOnly(null)}>All <span className="filter-count">{total}</span></button>
            {GOAL_STATUS_ORDER.filter((s) => counts[s] > 0).map((s) => (
              <button key={s} className={`filter-chip hub-chip tone-${GOAL_STATUS_LOOK[s].tone} ${only === s ? "active" : ""}`} aria-pressed={only === s} onClick={() => setOnly(only === s ? null : s)}>
                <StatusMark look={GOAL_STATUS_LOOK[s]} size={12} />{GOAL_STATUS_LOOK[s].label} <span className="filter-count">{counts[s]}</span>
              </button>
            ))}
          </div>
          {flat.length === 0 && shown.length === 0 ? <Empty title={HUB_COPY.noGoalsMatch} /> : (
            <div className="hub-groups" ref={list}>
              {shown.map((gr, gi) => {
                const m = gr.milestone;
                // A goal under two milestones is a row in each: the cursor counts rows, not goals.
                const first = shown.slice(0, gi).reduce((n, x) => n + x.goals.length, 0);
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
                      <div className="hub-group-head plain"><span className="hub-group-title">{HUB_COPY.notInMilestone}</span></div>
                    )}
                    <div className="hub-list">
                      {gr.goals.length === 0 && <p className="dim small hub-list-note">{HUB_COPY.noGoalsInMilestone}</p>}
                      {gr.goals.map((g, j) => <GoalRow key={g.goal.id} g={g} on={first + j === at} onPoint={() => setAt(first + j)} />)}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

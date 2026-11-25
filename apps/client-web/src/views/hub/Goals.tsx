/**
 * Goals: every goal once, for a project with too many to list in the rail.
 * Search by title, filter by status or milestone, open a row. Milestones have
 * their own screen.
 */
import { useMemo, useRef, useState } from "react";
import {
  GOAL_STATUS_LOOK,
  HUB_COPY,
  NO_MILESTONE,
  filterGoals,
  goalCounts,
  goalSummary,
  milestoneList,
} from "@ue-mcp-studio/client-core";
import { GOAL_STATUS_ORDER, type GoalStatus } from "@ue-mcp-studio/shared";
import { useCursor, useHub } from "./state";
import { Empty, HubIcon, Kbd, ScreenHead, StatusMark } from "./parts";
import { GoalListRow } from "./rows";

export function GoalsScreen() {
  const hub = useHub();
  const { o, go } = hub;
  const [only, setOnly] = useState<GoalStatus | null>(null);
  const [text, setText] = useState("");
  const [milestone, setMilestone] = useState<string | null>(null);
  const filterBox = useRef<HTMLInputElement>(null);
  const milestones = useMemo(() => milestoneList(o.goals), [o.goals]);
  const counts = useMemo(() => goalCounts(o.goals), [o.goals]);
  // A milestone that is gone (archived, deleted) no longer filters.
  const under = milestone && milestone !== NO_MILESTONE && !milestones.some((m) => m.goal.id === milestone) ? null : milestone;
  const shown = useMemo(() => filterGoals(o.goals, { status: only, text, milestone: under }), [o.goals, only, text, under]);
  const list = useRef<HTMLDivElement>(null);
  const [at, setAt, move] = useCursor(shown.length, list);
  const total = GOAL_STATUS_ORDER.reduce((n, s) => n + counts[s], 0);

  hub.onKeys((a) => {
    if (a.type === "next") move(1);
    else if (a.type === "prev") move(-1);
    else if (a.type === "open" && shown[at]) go({ screen: "goal", goalId: shown[at].goal.id });
    else if (a.type === "run" && shown[at]) void hub.runPlan({ scope: { kind: "goal", goalId: shown[at].goal.id } }, shown[at].goal.title);
    else if (a.type === "filter") filterBox.current?.focus();
    else return false;
    return true;
  });

  return (
    <div className="hub-screen hub-goals">
      <ScreenHead
        title={HUB_COPY.goals}
        sub={<span>{goalSummary(o.goals)}</span>}
        actions={<button className="primary" onClick={() => hub.editGoal(null)} title="New track (c)"><HubIcon name="plus" size={12} /> {HUB_COPY.newGoal}</button>}
      />
      {total === 0 ? (
        <Empty title="No tracks yet">{HUB_COPY.goalsLead}</Empty>
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
            {milestones.length > 0 && (
              <select className="hub-milestone-filter" aria-label={HUB_COPY.milestoneFilter} value={under ?? ""} onChange={(e) => setMilestone(e.target.value || null)}>
                <option value="">{HUB_COPY.allMilestones}</option>
                {milestones.map((m) => <option key={m.goal.id} value={m.goal.id}>{m.goal.title}</option>)}
                <option value={NO_MILESTONE}>{HUB_COPY.notInMilestone}</option>
              </select>
            )}
          </div>
          <div className="hub-chips" role="group" aria-label="Show tracks">
            <button className={`filter-chip ${only === null ? "active" : ""}`} aria-pressed={only === null} onClick={() => setOnly(null)}>All <span className="filter-count">{total}</span></button>
            {GOAL_STATUS_ORDER.filter((s) => counts[s] > 0).map((s) => (
              <button key={s} className={`filter-chip hub-chip tone-${GOAL_STATUS_LOOK[s].tone} ${only === s ? "active" : ""}`} aria-pressed={only === s} onClick={() => setOnly(only === s ? null : s)}>
                <StatusMark look={GOAL_STATUS_LOOK[s]} size={12} />{GOAL_STATUS_LOOK[s].label} <span className="filter-count">{counts[s]}</span>
              </button>
            ))}
          </div>
          {shown.length === 0 ? <Empty title={HUB_COPY.noGoalsMatch} /> : (
            <div className="hub-list" ref={list}>
              {shown.map((g, i) => <GoalListRow key={g.goal.id} g={g} on={i === at} onPoint={() => setAt(i)} />)}
            </div>
          )}
        </>
      )}
    </div>
  );
}

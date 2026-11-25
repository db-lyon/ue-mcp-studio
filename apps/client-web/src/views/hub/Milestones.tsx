/**
 * Milestones: every milestone with its status, progress and due date. Search
 * by title, filter by status, open a row for its goals.
 */
import { useMemo, useRef, useState } from "react";
import {
  GOAL_STATUS_LOOK,
  HUB_COPY,
  filterMilestones,
  milestoneCounts,
} from "@ue-mcp-studio/client-core";
import { GOAL_STATUS_ORDER, type GoalStatus } from "@ue-mcp-studio/shared";
import { useCursor, useHub } from "./state";
import { Empty, HubIcon, Kbd, ScreenHead, StatusMark } from "./parts";
import { GoalListRow } from "./rows";

export function MilestonesScreen() {
  const hub = useHub();
  const { o, go } = hub;
  const [only, setOnly] = useState<GoalStatus | null>(null);
  const [text, setText] = useState("");
  const filterBox = useRef<HTMLInputElement>(null);
  const counts = useMemo(() => milestoneCounts(o.goals), [o.goals]);
  const shown = useMemo(() => filterMilestones(o.goals, { status: only, text }), [o.goals, only, text]);
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
        title={HUB_COPY.milestones}
        sub={<span>{total === 0 ? "No scenes" : `${total} ${total === 1 ? "scene" : "scenes"}`}</span>}
        actions={<button className="primary" onClick={() => hub.editGoal(null, { kind: "milestone" })}><HubIcon name="plus" size={12} /> {HUB_COPY.newMilestone}</button>}
      />
      {total === 0 ? (
        <Empty title="No scenes yet">{HUB_COPY.noMilestonesYet}</Empty>
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
                placeholder={HUB_COPY.searchMilestones}
                aria-label={HUB_COPY.searchMilestones}
              />
              {!hub.narrow && <Kbd>/</Kbd>}
            </div>
          </div>
          <div className="hub-chips" role="group" aria-label="Show scenes">
            <button className={`filter-chip ${only === null ? "active" : ""}`} aria-pressed={only === null} onClick={() => setOnly(null)}>All <span className="filter-count">{total}</span></button>
            {GOAL_STATUS_ORDER.filter((s) => counts[s] > 0).map((s) => (
              <button key={s} className={`filter-chip hub-chip tone-${GOAL_STATUS_LOOK[s].tone} ${only === s ? "active" : ""}`} aria-pressed={only === s} onClick={() => setOnly(only === s ? null : s)}>
                <StatusMark look={GOAL_STATUS_LOOK[s]} size={12} />{GOAL_STATUS_LOOK[s].label} <span className="filter-count">{counts[s]}</span>
              </button>
            ))}
          </div>
          {shown.length === 0 ? <Empty title={HUB_COPY.noMilestonesMatch} /> : (
            <div className="hub-list" ref={list}>
              {shown.map((g, i) => <GoalListRow key={g.goal.id} g={g} milestone on={i === at} onPoint={() => setAt(i)} />)}
            </div>
          )}
        </>
      )}
    </div>
  );
}

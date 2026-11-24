/**
 * The rows every hub list is made of: a goal, a check. Each row is a link to
 * its object's screen, so it opens, copies and middle-clicks like any link,
 * with its own buttons at the end that do not open it.
 */
import type { ReactNode } from "react";
import type { CheckState, GoalState } from "@ue-mcp-studio/shared";
import {
  CHECK_HEALTH_LOOK,
  GOAL_STATUS_LOOK,
  HUB_COPY,
  PRIORITY_SHORT,
  RUN_OUTCOME_LOOK,
  dueText,
  hubHash,
  passRateText,
  progressText,
  shortAgo,
} from "@ue-mcp-studio/client-core";
import { useHub } from "./state";
import { HubLink, Progress, StatusMark, WinLoss } from "./parts";
import { HubLinkChips } from "./links";

export function GoalRow({ g, on, onPoint }: { g: GoalState; on?: boolean; onPoint?: () => void }) {
  const { go } = useHub();
  const look = GOAL_STATUS_LOOK[g.status];
  const due = dueText(g.goal.due);
  const route = { screen: "goal" as const, goalId: g.goal.id };
  return (
    <HubLink href={hubHash(route)} onGo={() => go(route)} className={`hub-row hub-goal-row ${on ? "on" : ""}`} data-row="" aria-current={on || undefined} onMouseEnter={onPoint}>
        <StatusMark look={look} label={look.label} />
        <span className="hub-row-main">
          <span className="hub-row-title">{g.goal.title}</span>
          <span className="hub-row-meta">
            <span className="hub-status-word">{look.label}</span>
            {g.goal.owner && <span>{g.goal.owner}</span>}
            {due && <span className={due.overdue ? "hub-overdue" : ""}>{due.text}</span>}
            {g.unused && <span className="hub-unused">{HUB_COPY.notInMilestone}</span>}
          </span>
        </span>
        {g.goal.priority && <span className={`hub-prio ${g.goal.priority}`} title={`Priority ${PRIORITY_SHORT[g.goal.priority]}`}>{PRIORITY_SHORT[g.goal.priority]}</span>}
        <Progress met={g.progress.met} total={g.progress.total} label={progressText(g.progress)} />
    </HubLink>
  );
}

/**
 * A check: its health, name and where it plays, the goals that list it, its
 * recent runs as a win/loss line, pass rate and last run. `lead` goes before
 * the mark (a checkbox), `actions` after everything.
 */
export function CheckRow({ c, on, lead, actions, showGoals = true, onPoint }: { c: CheckState; on?: boolean; lead?: ReactNode; actions?: ReactNode; showGoals?: boolean; onPoint?: () => void }) {
  const { go, o } = useHub();
  const look = CHECK_HEALTH_LOOK[c.health];
  const route = { screen: "check" as const, checkId: c.id };
  const goals = showGoals ? c.goalIds.map((id) => o.goals.find((g) => g.goal.id === id)).filter((g): g is GoalState => !!g) : [];
  return (
    <div className={`hub-row hub-check-row ${on ? "on" : ""} ${c.check.required === false ? "optional" : ""}`} data-row="" aria-current={on || undefined} onMouseEnter={onPoint}>
      {lead}
      <StatusMark look={look} label={look.label} />
      <HubLink href={hubHash(route)} onGo={() => go(route)} className="hub-row-main">
        <span className="hub-row-title">{c.name}{c.check.required === false && <span className="hub-optional"> optional</span>}</span>
        <span className="hub-row-meta">
          <span className="hub-status-word">{look.label}</span>
          {c.map && <span className="mono">{c.map.split("/").pop()}</span>}
          {c.steps ? <span>{c.steps} steps</span> : null}
          {goals.slice(0, 2).map((g) => <span key={g.goal.id} className="hub-goal-chip"><StatusMark look={GOAL_STATUS_LOOK[g.status]} size={10} />{g.goal.title}</span>)}
          {goals.length > 2 && <span>+{goals.length - 2}</span>}
          {showGoals && c.unused && <span className="hub-unused">{HUB_COPY.notInGoal}</span>}
          {c.renamedFrom && <span className="mono" title={c.renamedFrom}>{HUB_COPY.movedFrom(c.renamedFrom.split("/").pop()!)}</span>}
        </span>
      </HubLink>
      {c.links?.length ? <span className="hub-row-links"><HubLinkChips links={c.links} max={1} compact /></span> : null}
      <span className="hub-row-spark"><WinLoss recent={c.recent} max={12} /></span>
      <span className="hub-row-num mono" title="Pass rate over recent runs">{passRateText(c.passRate)}</span>
      <span className="hub-row-when" title={c.last ? `${RUN_OUTCOME_LOOK[c.last.outcome].label} ${new Date(c.last.startedAt).toLocaleString()}` : "Never run"}>{c.last ? shortAgo(c.last.startedAt) : ""}</span>
      {actions && <span className="hub-row-actions">{actions}</span>}
    </div>
  );
}

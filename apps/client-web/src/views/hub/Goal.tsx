/**
 * One goal: its status and why, who owns it and when it is due, its
 * acceptance rule and sign-off, and the checks that prove it, each with its
 * recent runs. Run goal queues every check; Write playtests asks an agent for
 * more. A milestone also lists its goals.
 */
import { useMemo, useRef, useState } from "react";
import {
  CHECK_KIND_LABEL,
  GOAL_STATUS_LOOK,
  HUB_COPY,
  PRIORITY_LABEL,
  acceptanceText,
  dueText,
  hubHash,
  playingFor,
  progressText,
  shortAgo,
  sortChecks,
  sortGoals,
} from "@ue-mcp-studio/client-core";
import { needsSignOff } from "@ue-mcp-studio/shared";
import { api } from "../../api";
import { useCursor, useHub } from "./state";
import { Empty, HubIcon, HubLink, Progress, ScreenHead, StatusPill } from "./parts";
import { CheckRow, GoalRow } from "./rows";
import { LiveTile } from "./Check";
import { ViewportButton, useHubLive } from "./live";

export function GoalScreen({ goalId }: { goalId: string }) {
  const hub = useHub();
  const { o, go } = hub;
  const g = o.goals.find((x) => x.goal.id === goalId);
  const checks = useMemo(() => (g ? sortChecks(g.checks) : []), [g]);
  const children = useMemo(() => (g ? sortGoals(o.goals.filter((x) => x.goal.parent === g.goal.id && !x.goal.archived)) : []), [g, o.goals]);
  const list = useRef<HTMLDivElement>(null);
  const [at, setAt, move] = useCursor(checks.length, list);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [note, setNote] = useState("");
  const [writing, setWriting] = useState(false);

  const failing = checks.filter((c) => c.health === "failing").length;
  // A run of one of this goal's checks, or of its goals' checks for a milestone, playing now.
  const ids = [...checks.map((c) => c.id), ...children.flatMap((c) => c.checks.map((x) => x.id))];
  const nowRun = playingFor(o, ids);
  const tile = useHubLive(nowRun !== null, "tile");
  const runGoal = () => g && void hub.runPlan({ scope: { kind: "goal", goalId: g.goal.id } }, g.goal.title);
  const assignFailing = async () => {
    if (!g) return;
    try {
      const r = await api.hub.assignFailing(g.goal.id);
      hub.notify(r.queued ? `Queued ${r.queued} failing ${r.queued === 1 ? "check" : "checks"} for subagents, one at a time` : "No failing checks to assign");
    } catch (e) {
      hub.notify((e as Error).message, "bad");
    }
  };

  hub.onKeys((a) => {
    if (a.type === "next") move(1);
    else if (a.type === "prev") move(-1);
    else if (a.type === "open" && checks[at]) go({ screen: "check", checkId: checks[at].id });
    else if (a.type === "run") runGoal();
    else if (a.type === "assign" && failing > 0) void assignFailing();
    else return false;
    return true;
  });

  if (!g) {
    return (
      <div className="hub-screen">
        <Empty title="This goal is not in the project" actions={<button onClick={() => go({ screen: "overview" })}>Go to Overview</button>}>
          Its file may have been deleted or renamed in {o.goalsDir}.
        </Empty>
      </div>
    );
  }

  const goal = g.goal;
  const look = GOAL_STATUS_LOOK[g.status];
  const parent = goal.parent ? o.goals.find((x) => x.goal.id === goal.parent) : null;
  const due = dueText(goal.due);

  const removeCheck = async (checkId: string) => {
    hub.data.patch((ov) => ({
      ...ov,
      goals: ov.goals.map((x) => (x.goal.id === goal.id ? { ...x, checks: x.checks.filter((c) => c.id !== checkId), goal: { ...x.goal, checks: x.goal.checks.filter((c) => `${c.kind}:${c.target}` !== checkId) } } : x)),
    }));
    try {
      await api.hub.removeCheck(goal.id, checkId);
    } catch (e) {
      hub.notify((e as Error).message, "bad");
    }
    hub.data.reload();
  };
  const assignOne = async (runId: string) => {
    try {
      await api.hub.assign(runId);
      hub.notify("Assigned to a subagent");
    } catch (e) {
      hub.notify((e as Error).message, "bad");
    }
  };
  const writePlaytests = async () => {
    setWriting(true);
    try {
      const r = await api.hub.writePlaytests(goal.id);
      hub.openChat(r.sessionId);
    } catch (e) {
      hub.notify((e as Error).message, "bad");
    } finally {
      setWriting(false);
    }
  };
  const signOff = async () => {
    try {
      await api.hub.signOff(goal.id, note.trim() || undefined);
      setNote("");
      hub.data.reload();
    } catch (e) {
      hub.notify((e as Error).message, "bad");
    }
  };
  const clearSignOff = async () => {
    try {
      await api.hub.clearSignOff(goal.id);
      hub.data.reload();
    } catch (e) {
      hub.notify((e as Error).message, "bad");
    }
  };
  const remove = async () => {
    try {
      await api.hub.deleteGoal(goal.id);
      hub.notify(`Deleted ${goal.title}`);
      go(parent ? { screen: "goal", goalId: parent.goal.id } : { screen: "overview" });
      hub.data.reload();
    } catch (e) {
      hub.notify((e as Error).message, "bad");
    }
  };

  return (
    <div className="hub-screen hub-goal">
      <ScreenHead
        back={parent ? { label: parent.goal.title, route: { screen: "goal", goalId: parent.goal.id } } : { label: HUB_COPY.overview, route: { screen: "overview" } }}
        eyebrow={goal.kind === "milestone" ? "Milestone" : "Goal"}
        title={goal.title}
        sub={<><StatusPill look={look} /><span className="dim">{progressText(g.progress)}</span></>}
        actions={<>
          <button className="primary" onClick={runGoal} disabled={g.checks.length === 0 && children.length === 0} title="Run every check in order (r)"><HubIcon name="play" size={12} /> {HUB_COPY.runGoal}</button>
          {failing > 0 && <button onClick={() => void assignFailing()} title="Each failing check goes to a subagent's fix loop, one at a time (a)"><HubIcon name="assign" size={12} /> {HUB_COPY.assignFailing}</button>}
          <button className="ghost" onClick={() => hub.editGoal(goal.id)} title={HUB_COPY.editGoal}><HubIcon name="edit" size={12} /> Edit</button>
        </>}
      />
      <Progress met={g.progress.met} total={g.progress.total} label={progressText(g.progress)} />
      <LiveTile live={tile} run={nowRun} />
      <dl className="hub-facts">
        <div><dt>Owner</dt><dd>{goal.owner || <span className="dim">Nobody</span>}</dd></div>
        <div><dt>Priority</dt><dd>{goal.priority ? <span className={`hub-prio ${goal.priority}`}>{PRIORITY_LABEL[goal.priority]}</span> : <span className="dim">None</span>}</dd></div>
        <div><dt>Due</dt><dd>{due ? <span className={due.overdue ? "hub-overdue" : ""} title={goal.due ?? ""}>{due.text}</span> : <span className="dim">No date</span>}</dd></div>
        {(goal.tags ?? []).length > 0 && <div><dt>Tags</dt><dd>{goal.tags!.map((t) => <span key={t} className="hub-tag">#{t}</span>)}</dd></div>}
      </dl>
      {goal.description && <p className="hub-description">{goal.description}</p>}
      <section className="hub-card hub-acceptance">
        <div className="hub-card-head"><span>Done when</span></div>
        <p className="small">{acceptanceText(goal)}</p>
        {(needsSignOff(goal) || goal.signOff) && (goal.signOff ? (
          <div className="hub-signed">
            <StatusPill look={GOAL_STATUS_LOOK.met}>Signed off by {goal.signOff.by}, {shortAgo(goal.signOff.at)}</StatusPill>
            {goal.signOff.note && <span className="muted small">"{goal.signOff.note}"</span>}
            <span className="spacer" />
            <button className="ghost small-button" onClick={() => void clearSignOff()}>{HUB_COPY.clearSignOff}</button>
          </div>
        ) : (
          <form className="hub-signoff" onSubmit={(e) => { e.preventDefault(); void signOff(); }}>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" aria-label="Sign-off note" />
            <button type="submit">{HUB_COPY.signOff}</button>
          </form>
        ))}
      </section>

      {goal.kind === "milestone" && (
        <section className="hub-section">
          <div className="hub-section-head">
            <h2>Goals <span className="dim">{children.length}</span></h2>
            <span className="spacer" />
            <button className="ghost" onClick={() => hub.editGoal(null, { parent: goal.id })}><HubIcon name="plus" size={12} /> New goal here</button>
          </div>
          {children.length === 0 ? <p className="dim small">No goals in this milestone yet.</p> : (
            <div className="hub-list">{children.map((c) => <GoalRow key={c.goal.id} g={c} />)}</div>
          )}
        </section>
      )}

      <section className="hub-section">
        <div className="hub-section-head">
          <h2>Checks <span className="dim">{checks.length}</span></h2>
          <span className="spacer" />
          <button className="ghost" onClick={() => hub.addChecks(goal.id)}><HubIcon name="plus" size={12} /> {HUB_COPY.addChecks}</button>
          <button className="ghost" disabled={writing} onClick={() => void writePlaytests()} title="An agent writes test scripts for this goal in a new session, and links them here"><HubIcon name="sparkle" size={12} /> {HUB_COPY.writePlaytests}</button>
        </div>
        {checks.length === 0 ? (
          <Empty title="No checks yet" actions={<>
            <button onClick={() => hub.addChecks(goal.id)}>{HUB_COPY.addChecks}</button>
            <button onClick={() => void writePlaytests()} disabled={writing}>{HUB_COPY.writePlaytests}</button>
          </>}>A goal is met when its required checks pass. Link test scripts the project has, or ask an agent to write them.</Empty>
        ) : (
          <div className="hub-list" ref={list}>
            {checks.map((c, i) => (
              <CheckRow key={c.id} c={c} on={i === at} onPoint={() => setAt(i)} showGoals={false} actions={<>
                {nowRun?.checkId === c.id && <ViewportButton relevant compact />}
                <span className="hub-kind small dim">{CHECK_KIND_LABEL[c.check.kind]}</span>
                <button className="ghost icon-button" aria-label={`Run ${c.name}`} title="Run" onClick={() => void hub.runCheck(c.id, c.name)}><HubIcon name="play" size={12} /></button>
                {c.health === "failing" && c.last && <button className="ghost icon-button" aria-label={`Assign ${c.name} to a subagent`} title="Assign to a subagent" onClick={() => void assignOne(c.last!.runId)}><HubIcon name="assign" size={12} /></button>}
                <button className="ghost icon-button" aria-label={`Remove ${c.name} from this goal`} title="Remove from this goal" onClick={() => void removeCheck(c.id)}><HubIcon name="close" size={12} /></button>
              </>} />
            ))}
          </div>
        )}
      </section>

      <section className="hub-danger">
        {confirmDelete ? (
          <span className="hub-confirm">
            <span className="small">Delete {o.goalsDir}/{goal.id}.json? The checks and their runs stay.</span>
            <button className="danger-button" onClick={() => void remove()}>Delete goal</button>
            <button className="ghost" onClick={() => setConfirmDelete(false)}>Cancel</button>
          </span>
        ) : <button className="ghost small" onClick={() => setConfirmDelete(true)}><HubIcon name="trash" size={12} /> Delete goal</button>}
      </section>
    </div>
  );
}

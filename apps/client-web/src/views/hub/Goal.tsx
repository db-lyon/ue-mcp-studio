/**
 * One goal: its status and why, the goals and milestones it is part of, who
 * owns it and when it is due, its acceptance rule and sign-off, the goals it
 * requires and the playtests that prove it, each list in the goal's own
 * order with up and down to change it. Run goal queues every playtest the
 * goal stands for, its required goals' included; Write playtests and Fix
 * with an agent each work in a named chat session.
 */
import { useMemo, useRef, useState } from "react";
import {
  CHECK_HEALTH_LOOK,
  DRAFT_COPY,
  GOAL_STATUS_LOOK,
  HUB_COPY,
  PRIORITY_LABEL,
  acceptanceText,
  dueText,
  goalCheckIds,
  hubHash,
  moveId,
  parentGoals,
  progressText,
  requiredRows,
  shortAgo,
  signOffText,
  withLink,
  withoutLink,
} from "@ue-mcp-studio/client-core";
import { needsSignOff, type TrackerLink } from "@ue-mcp-studio/shared";
import { HubLinks } from "./links";
import { api } from "../../api";
import { useCursor, useHub } from "./state";
import { Empty,HubIcon, HubLink, Progress, ScreenHead, StatusMark, StatusPill } from "./parts";
import { CheckRow, GoalRow } from "./rows";

/** Up and down for one row of an ordered list; each is disabled at its end. */
function OrderButtons({ name, at, count, onMove }: { name: string; at: number; count: number; onMove: (by: number) => void }) {
  return (
    <>
      <button className="ghost icon-button" aria-label={`Move ${name} up`} title="Move up" disabled={at === 0} onClick={() => onMove(-1)}><HubIcon name="up" size={12} /></button>
      <button className="ghost icon-button" aria-label={`Move ${name} down`} title="Move down" disabled={at === count - 1} onClick={() => onMove(1)}><HubIcon name="down" size={12} /></button>
    </>
  );
}

export function GoalScreen({ goalId }: { goalId: string }) {
  const hub = useHub();
  const { o, go } = hub;
  const g = o.goals.find((x) => x.goal.id === goalId);
  // The goal's own order: it is the order a run takes.
  const checks = g?.checks ?? [];
  const required = useMemo(() => (g ? requiredRows(g, o.goals) : []), [g, o.goals]);
  const parents = useMemo(() => (g ? parentGoals(g, o.goals) : []), [g, o.goals]);
  const runnable = useMemo(() => goalCheckIds(goalId, o.goals).length, [goalId, o.goals]);
  const list = useRef<HTMLDivElement>(null);
  const [at, setAt, move] = useCursor(checks.length, list);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [note, setNote] = useState("");
  const signed = g?.signOff ? signOffText(g.signOff) : null;
  const [writing, setWriting] = useState(false);

  const failing = checks.filter((c) => c.health === "failing").length;
  const runGoal = () => g && void hub.runPlan({ scope: { kind: "goal", goalId: g.goal.id } }, g.goal.title);
  /** Fix with an agent: the goal's failing playtests, or one; each in a chat session of its own. */
  const fix = async (req: { goalId: string } | { checkId: string }) => {
    try {
      const r = await api.hub.fix(req);
      hub.notify(HUB_COPY.fixesQueued(r.queued));
      hub.data.reload();
    } catch (e) {
      hub.notify((e as Error).message, "bad");
    }
  };

  hub.onKeys((a) => {
    if (a.type === "next") move(1);
    else if (a.type === "prev") move(-1);
    else if (a.type === "open" && checks[at]) go({ screen: "check", checkId: checks[at].id });
    else if (a.type === "run") runGoal();
    else if (a.type === "fix" && g && failing > 0) void fix({ goalId: g.goal.id });
    else return false;
    return true;
  });

  if (!g) {
    return (
      <div className="hub-screen">
        <Empty title="This goal is gone" actions={<button onClick={() => go({ screen: "overview" })}>Go to Overview</button>}>
          It was deleted, or the link is from another computer's goals.
        </Empty>
      </div>
    );
  }

  const goal = g.goal;
  const look = GOAL_STATUS_LOOK[g.status];
  // Back goes to the one goal this is part of; with several, or none, to the overview.
  const back = parents.length === 1 ? parents[0] : null;
  const due = dueText(goal.due);

  /** Run a change, say why when it is refused, and read the hub again either way. */
  const act = async (work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (e) {
      hub.notify((e as Error).message, "bad");
    }
    hub.data.reload();
  };
  /** The goal's links replaced, shown at once and saved; a refusal throws for the form to show. */
  const saveLinks = async (links: TrackerLink[]) => {
    hub.data.patch((ov) => ({ ...ov, goals: ov.goals.map((x) => (x.goal.id === goal.id ? { ...x, goal: { ...x.goal, links } } : x)) }));
    try {
      await api.hub.updateGoal(goal.id, { links });
    } finally {
      hub.data.reload();
    }
  };
  const removeCheck = async (checkId: string) => {
    hub.data.patch((ov) => ({
      ...ov,
      goals: ov.goals.map((x) => (x.goal.id === goal.id ? { ...x, checks: x.checks.filter((c) => c.id !== checkId), goal: { ...x.goal, checks: x.goal.checks.filter((c) => `${c.kind}:${c.target}` !== checkId) } } : x)),
    }));
    await act(() => api.hub.removeCheck(goal.id, checkId));
  };
  const moveCheck = (checkId: string, by: number) => {
    const order = moveId(checks.map((c) => c.id), checkId, by);
    hub.data.patch((ov) => ({ ...ov, goals: ov.goals.map((x) => (x.goal.id === goal.id ? { ...x, checks: order.map((id) => x.checks.find((c) => c.id === id)!) } : x)) }));
    void act(() => api.hub.orderChecks(goal.id, order));
  };
  const moveRequired = (id: string, by: number) => {
    const order = moveId(g.requires.map((r) => r.goal), id, by);
    hub.data.patch((ov) => ({ ...ov, goals: ov.goals.map((x) => (x.goal.id === goal.id ? { ...x, requires: order.map((r) => x.requires.find((y) => y.goal === r)!) } : x)) }));
    void act(() => api.hub.orderRequires(goal.id, order));
  };
  const setRequired = (id: string, on: boolean) => void act(() => api.hub.addRequire(goal.id, id, on));
  const removeRequired = (id: string) => {
    hub.data.patch((ov) => ({ ...ov, goals: ov.goals.map((x) => (x.goal.id === goal.id ? { ...x, requires: x.requires.filter((r) => r.goal !== id) } : x)) }));
    void act(() => api.hub.removeRequire(goal.id, id));
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
      go(back ? { screen: "goal", goalId: back.goal.id } : { screen: "overview" });
      hub.data.reload();
    } catch (e) {
      hub.notify((e as Error).message, "bad");
    }
  };

  return (
    <div className="hub-screen hub-goal">
      <ScreenHead
        back={back ? { label: back.goal.title, route: { screen: "goal", goalId: back.goal.id } } : { label: HUB_COPY.overview, route: { screen: "overview" } }}
        eyebrow={goal.kind === "milestone" ? "Milestone" : "Goal"}
        title={goal.title}
        sub={<><StatusPill look={look} /><span className="dim">{progressText(g.progress)}</span></>}
        actions={<>
          <button className="primary" onClick={runGoal} disabled={runnable === 0} title="Run every playtest in order, the required goals' first (r)"><HubIcon name="play" size={12} /> {HUB_COPY.runGoal}</button>
          {failing > 0 && <button onClick={() => void fix({ goalId: goal.id })} title="An agent fixes each failing playtest in its own chat session, one at a time (a)"><HubIcon name="assign" size={12} /> {HUB_COPY.fixFailing}</button>}
          <button className="ghost" onClick={() => hub.editGoal(goal.id)} title={HUB_COPY.editGoal}><HubIcon name="edit" size={12} /> Edit</button>
        </>}
      />
      {parents.length > 0 ? (
        <div className="hub-part-of small" role="group" aria-label={HUB_COPY.partOf}>
          <span className="dim">{HUB_COPY.partOf}</span>
          {parents.map((p) => (
            <HubLink key={p.goal.id} className="hub-goal-chip" href={hubHash({ screen: "goal", goalId: p.goal.id })} onGo={() => go({ screen: "goal", goalId: p.goal.id })}>
              {p.goal.kind === "milestone" ? <HubIcon name="milestone" size={10} /> : <StatusMark look={GOAL_STATUS_LOOK[p.status]} size={10} />}
              {p.goal.title}
            </HubLink>
          ))}
        </div>
      ) : g.unused && <div className="hub-part-of small dim">{HUB_COPY.notInMilestone}</div>}
      <Progress met={g.progress.met} total={g.progress.total} label={progressText(g.progress)} />
      <dl className="hub-facts">
        <div><dt>{HUB_COPY.owner}</dt><dd>{goal.owner || <span className="dim">Nobody</span>}</dd></div>
        <div><dt>{HUB_COPY.priority}</dt><dd>{goal.priority ? <span className={`hub-prio ${goal.priority}`}>{PRIORITY_LABEL[goal.priority]}</span> : <span className="dim">None</span>}</dd></div>
        <div><dt>{HUB_COPY.due}</dt><dd>{due ? <span className={due.overdue ? "hub-overdue" : ""} title={goal.due ?? ""}>{due.text}</span> : <span className="dim">No date</span>}</dd></div>
      </dl>
      <HubLinks links={goal.links} onAdd={(l) => saveLinks(withLink(goal.links, l))} onRemove={(url) => void saveLinks(withoutLink(goal.links, url)).catch((e: Error) => hub.notify(e.message, "bad"))} />
      {goal.description && <p className="hub-description">{goal.description}</p>}
      <section className="hub-card hub-acceptance">
        <div className="hub-card-head"><span>Done when</span></div>
        <p className="small">{acceptanceText(goal)}</p>
        {g.signOff && signed && (
          <div className="hub-signed">
            <StatusPill look={g.signOff.lapsed ? GOAL_STATUS_LOOK.at_risk : GOAL_STATUS_LOOK.met}>{signed.title}, {shortAgo(g.signOff.record.at)}</StatusPill>
            {signed.detail && <span className="muted small">{signed.detail}</span>}
            {g.signOff.record.note && <span className="muted small">"{g.signOff.record.note}"</span>}
            <span className="spacer" />
            {!g.signOff.lapsed && <button className="ghost small-button" onClick={() => void clearSignOff()}>{HUB_COPY.clearSignOff}</button>}
          </div>
        )}
        {needsSignOff(goal) && (!g.signOff || g.signOff.lapsed) && (
          <form className="hub-signoff" onSubmit={(e) => { e.preventDefault(); void signOff(); }}>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" aria-label="Sign-off note" />
            <button type="submit">{HUB_COPY.signOff}</button>
          </form>
        )}
      </section>

      <section className="hub-section" aria-label={HUB_COPY.requiredGoals}>
        <div className="hub-section-head">
          <h2>{HUB_COPY.requiredGoals} <span className="dim">{required.length}</span></h2>
          <span className="spacer" />
          <button className="ghost" onClick={() => hub.requireGoal(goal.id)}><HubIcon name="plus" size={12} /> {HUB_COPY.addGoal}</button>
          <button className="ghost" onClick={() => hub.editGoal(null, { parents: [goal.id] })}><HubIcon name="plus" size={12} /> {HUB_COPY.newGoalHere}</button>
        </div>
        {required.length === 0 ? <p className="dim small">{goal.kind === "milestone" ? HUB_COPY.noGoalsInMilestone : HUB_COPY.noRequiredGoals}</p> : (
          <div className="hub-list">
            {required.map((r, i) => (
              <div key={r.state.goal.id} className={`hub-required-row ${r.required ? "" : "optional"}`}>
                <GoalRow g={r.state} />
                <span className="hub-row-actions">
                  <button className="ghost small-button" aria-pressed={!r.required} title={r.required ? "Make optional: still listed and run, but it no longer holds this goal back" : "Make required: this goal is met only when it is"} onClick={() => setRequired(r.state.goal.id, !r.required)}>
                    {r.required ? "Required" : "Optional"}
                  </button>
                  <OrderButtons name={r.state.goal.title} at={i} count={required.length} onMove={(by) => moveRequired(r.state.goal.id, by)} />
                  <button className="ghost icon-button" aria-label={`Remove ${r.state.goal.title} from this goal`} title="Remove from this goal" onClick={() => removeRequired(r.state.goal.id)}><HubIcon name="close" size={12} /></button>
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="hub-section">
        <div className="hub-section-head">
          <h2>{HUB_COPY.playtests} <span className="dim">{checks.length}</span></h2>
          <span className="spacer" />
          <button className="ghost" onClick={() => hub.go({ screen: "draft", goalId: goal.id })} title="Write a playtest here, added to this goal"><HubIcon name="edit" size={12} /> {DRAFT_COPY.newPlaytest}</button>
          <button className="ghost" onClick={() => hub.addChecks(goal.id)}><HubIcon name="plus" size={12} /> {HUB_COPY.addPlaytests}</button>
          <button className="ghost" disabled={writing} onClick={() => void writePlaytests()} title="An agent writes playtests for this goal in a new chat session, and adds them here"><HubIcon name="sparkle" size={12} /> {HUB_COPY.writePlaytests}</button>
        </div>
        {checks.length === 0 ? (
          <Empty title="No playtests yet" actions={<>
            <button onClick={() => hub.go({ screen: "draft", goalId: goal.id })}>{DRAFT_COPY.newPlaytest}</button>
            <button onClick={() => hub.addChecks(goal.id)}>{HUB_COPY.addPlaytests}</button>
            <button onClick={() => void writePlaytests()} disabled={writing}>{HUB_COPY.writePlaytests}</button>
          </>}>{HUB_COPY.noPlaytestsInGoal}</Empty>
        ) : (
          <div className="hub-list" ref={list}>
            {checks.map((c, i) => (
              <CheckRow key={c.id} c={c} on={i === at} onPoint={() => setAt(i)} showGoals={false} actions={<>
                <button className="ghost icon-button" aria-label={`Run ${c.name}`} title={c.missing ? CHECK_HEALTH_LOOK.missing.label : "Run"} disabled={c.missing} onClick={() => void hub.runCheck(c.id, c.name)}><HubIcon name="play" size={12} /></button>
                {c.health === "failing" && <button className="ghost icon-button" aria-label={`${HUB_COPY.fix}: ${c.name}`} title={HUB_COPY.fix} onClick={() => void fix({ checkId: c.id })}><HubIcon name="assign" size={12} /></button>}
                <OrderButtons name={c.name} at={i} count={checks.length} onMove={(by) => moveCheck(c.id, by)} />
                <button className="ghost icon-button" aria-label={`Remove ${c.name} from this goal`} title="Remove from this goal" onClick={() => void removeCheck(c.id)}><HubIcon name="close" size={12} /></button>
              </>} />
            ))}
          </div>
        )}
        {(goal.unsupported ?? []).length > 0 && (
          <div className="hub-unsupported">
            <p className="dim small">{HUB_COPY.unsupportedLead}</p>
            <ul className="hub-list">
              {goal.unsupported!.map((u) => (
                <li key={`${u.kind}:${u.target}`} className="hub-row hub-mini-row">
                  <span className="pill">{HUB_COPY.unsupported}</span>
                  <span className="hub-row-title">{u.target}</span>
                  <span className="dim small mono">{u.kind}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="hub-danger">
        {confirmDelete ? (
          <span className="hub-confirm">
            <span className="small">Delete {goal.title}? Its playtests and their runs stay, and goals that required it stop requiring it.</span>
            <button className="danger-button" onClick={() => void remove()}>Delete goal</button>
            <button className="ghost" onClick={() => setConfirmDelete(false)}>Cancel</button>
          </span>
        ) : <button className="ghost small" onClick={() => setConfirmDelete(true)}><HubIcon name="trash" size={12} /> Delete goal</button>}
      </section>
    </div>
  );
}

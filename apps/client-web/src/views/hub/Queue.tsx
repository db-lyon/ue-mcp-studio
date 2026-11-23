/**
 * The queue: the plan running on the editor now with each check's state,
 * the plans waiting behind it (reorder, cancel), pause, the plans that
 * finished, and schedules that queue plans on given days.
 */
import { useState } from "react";
import type { PlanRun, PlanScope, Schedule, ScheduleDraft } from "@ue-mcp-studio/shared";
import {
  DAY_SHORT,
  HUB_COPY,
  PLAN_ITEM_LOOK,
  PLAN_STATE_LABEL,
  blankSchedule,
  moveQueued,
  planProgress,
  playingRuns,
  scheduleErrors,
  scheduleText,
  scopeText,
  shortAgo,
  sortGoals,
} from "@ue-mcp-studio/client-core";
import { api } from "../../api";
import { Switch } from "../settings/controls";
import { useHub } from "./state";
import { HubField, HubIcon, HubLink, Progress, ScreenHead, StatusMark } from "./parts";
import { ViewportButton } from "./live";

export function QueueScreen() {
  const hub = useHub();
  const { o } = hub;
  const q = o.queue;
  const [editing, setEditing] = useState<Schedule | "new" | null>(null);

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
  const move = async (p: PlanRun, to: number) => {
    setQueue(moveQueued(q, p.id, to));
    try {
      setQueue(await api.hub.movePlan(p.id, to));
    } catch (e) {
      hub.notify((e as Error).message, "bad");
      hub.data.reload();
    }
  };
  const cancel = async (p: PlanRun) => {
    if (q.current?.id !== p.id) setQueue({ ...q, queued: q.queued.filter((x) => x.id !== p.id) });
    try {
      await api.hub.cancelPlan(p.id);
      hub.notify(`Cancelled ${p.title}`);
    } catch (e) {
      hub.notify((e as Error).message, "bad");
    }
    hub.data.reload();
  };

  hub.onKeys(() => false);

  return (
    <div className="hub-screen hub-queue">
      <ScreenHead
        title={HUB_COPY.queue}
        sub={<span className={q.editor.connected ? "dim" : "hub-bad-text"}>{q.editor.connected ? "Editor connected" : "Editor not connected"}</span>}
        actions={<button onClick={() => void pause()} aria-pressed={q.paused} title={q.paused ? "Start runs again" : "Finish the running check, then hold the rest"}>
          <HubIcon name={q.paused ? "play" : "pause"} size={12} /> {q.paused ? "Resume" : "Pause"}
        </button>}
      />
      {!q.editor.connected && <div className="banner warn small">{HUB_COPY.editorDown}</div>}
      {q.paused && <div className="banner warn small">{HUB_COPY.paused}</div>}

      <section className="hub-section">
        <div className="hub-section-head"><h2>Now</h2></div>
        {q.current ? <PlanCard plan={q.current} onCancel={() => void cancel(q.current!)} live /> : <p className="dim small">{HUB_COPY.queueIdle}</p>}
      </section>

      <section className="hub-section">
        <div className="hub-section-head"><h2>Next <span className="dim">{q.queued.length}</span></h2></div>
        {q.queued.length === 0 ? <p className="dim small">{HUB_COPY.queueEmpty}</p> : (
          <ol className="hub-list hub-queued">
            {q.queued.map((p, i) => (
              <li key={p.id} className="hub-row hub-queued-row">
                <span className="hub-queued-pos mono">{i + 1}</span>
                <span className="hub-row-main">
                  <span className="hub-row-title">{p.title}</span>
                  <span className="hub-row-meta"><span>{scopeText(p.scope, o.goals)}</span><span>{p.items.length} {p.items.length === 1 ? "check" : "checks"}</span><span>{p.trigger === "schedule" ? "Scheduled" : p.trigger === "agent" ? "From an agent" : `Queued ${shortAgo(p.createdAt)} ago`}</span></span>
                </span>
                <span className="hub-row-actions">
                  <button className="ghost icon-button" aria-label={`Move ${p.title} up`} disabled={i === 0} onClick={() => void move(p, i - 1)}><HubIcon name="up" size={12} /></button>
                  <button className="ghost icon-button" aria-label={`Move ${p.title} down`} disabled={i === q.queued.length - 1} onClick={() => void move(p, i + 1)}><HubIcon name="down" size={12} /></button>
                  <button className="ghost icon-button" aria-label={`Cancel ${p.title}`} onClick={() => void cancel(p)}><HubIcon name="close" size={12} /></button>
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="hub-section">
        <div className="hub-section-head">
          <h2>Schedules <span className="dim">{q.schedules.length}</span></h2>
          <span className="spacer" />
          {editing === null && <button className="ghost" onClick={() => setEditing("new")}><HubIcon name="plus" size={12} /> New schedule</button>}
        </div>
        {editing === "new" && <ScheduleForm onDone={() => setEditing(null)} />}
        {q.schedules.length === 0 && editing !== "new" && <p className="dim small">{HUB_COPY.noSchedules} A schedule queues a plan on the days and time you pick, when the editor is up and idle.</p>}
        <div className="hub-list">
          {q.schedules.map((s) => editing !== "new" && editing?.id === s.id ? <ScheduleForm key={s.id} schedule={s} onDone={() => setEditing(null)} /> : (
            <div key={s.id} className={`hub-row hub-schedule-row ${s.enabled ? "" : "off"}`}>
              <Switch on={s.enabled} label={`${s.title} on`} onChange={(on) => void api.hub.updateSchedule(s.id, { enabled: on }).then(() => hub.data.reload(), (e: Error) => hub.notify(e.message, "bad"))} />
              <span className="hub-row-main">
                <span className="hub-row-title">{s.title}</span>
                <span className="hub-row-meta">
                  <span><HubIcon name="calendar" size={11} /> {scheduleText(s)}</span>
                  <span>{scopeText(s.scope, o.goals)}</span>
                  {s.nextRunAt && s.enabled && <span>Next {new Date(s.nextRunAt).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}</span>}
                  {s.lastSkipped && <span className="hub-bad-text" title={s.lastRunAt ?? ""}>Skipped: {s.lastSkipped}</span>}
                </span>
              </span>
              <span className="hub-row-actions">
                <button className="ghost icon-button" aria-label={`Edit ${s.title}`} onClick={() => setEditing(s)}><HubIcon name="edit" size={12} /></button>
                <button className="ghost icon-button" aria-label={`Delete ${s.title}`} onClick={() => void api.hub.deleteSchedule(s.id).then(() => hub.data.reload(), (e: Error) => hub.notify(e.message, "bad"))}><HubIcon name="trash" size={12} /></button>
              </span>
            </div>
          ))}
        </div>
      </section>

      {q.recent.length > 0 && (
        <section className="hub-section">
          <div className="hub-section-head"><h2>Finished</h2></div>
          <div className="hub-list">{q.recent.map((p) => <PlanCard key={p.id} plan={p} />)}</div>
        </section>
      )}
    </div>
  );
}

/** A plan: its title and scope, progress, and each check's state; open by default while it runs. */
function PlanCard({ plan, onCancel, live = false }: { plan: PlanRun; onCancel?: () => void; live?: boolean }) {
  const { o, go } = useHub();
  const p = planProgress(plan);
  const [open, setOpen] = useState(live);
  const playing = new Set(playingRuns(o).map((r) => r.runId));
  return (
    <div className={`hub-plan ${live ? "live" : ""}`}>
      <div className="hub-plan-head">
        <button className="ghost hub-plan-toggle" aria-expanded={open} onClick={() => setOpen((x) => !x)}>
          <HubIcon name="chevron" size={12} />
          <span className="hub-row-title">{plan.title}</span>
        </button>
        <span className="small dim">{scopeText(plan.scope, o.goals)}</span>
        <span className="pill">{PLAN_STATE_LABEL[plan.state]}</span>
        {p.failed > 0 && <span className="pill bad">{p.failed} failed</span>}
        {p.waiting > 0 && <span className="pill warn">{p.waiting} need you</span>}
        <span className="spacer" />
        {!live && plan.endedAt && <span className="small dim">{shortAgo(plan.endedAt)}</span>}
        {onCancel && <button className="ghost" onClick={onCancel}>Cancel</button>}
      </div>
      <Progress met={p.done} total={p.total} label={`${p.done} of ${p.total} checks done`} />
      {open && (
        <ol className="hub-plan-items">
          {plan.items.map((it, i) => {
            const look = PLAN_ITEM_LOOK[it.state];
            return (
              <li key={i} className={`hub-plan-item ${it.state}`}>
                <StatusMark look={look} label={look.label} />
                {it.runId ? <HubLink href={`#/playtests/runs/${encodeURIComponent(it.runId)}`} onGo={() => go({ screen: "run", runId: it.runId! })}>{it.name}</HubLink> : <span>{it.name}</span>}
                <span className="small dim">{look.label}{it.reason ? `: ${it.reason}` : ""}</span>
                {live && it.runId && playing.has(it.runId) && <ViewportButton relevant compact />}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

type ScopeKey = "all" | "failing" | "stale" | `goal:${string}`;
const scopeKey = (s: PlanScope): ScopeKey => (s.kind === "goal" ? `goal:${s.goalId}` : s.kind === "checks" ? "all" : s.kind);
const scopeOf = (k: ScopeKey): PlanScope => (k.startsWith("goal:") ? { kind: "goal", goalId: k.slice(5) } : { kind: k as "all" | "failing" | "stale" });

/** New or edit schedule, in place in the list. */
function ScheduleForm({ schedule, onDone }: { schedule?: Schedule; onDone: () => void }) {
  const hub = useHub();
  const [s, setS] = useState<ScheduleDraft>(() => schedule ? { title: schedule.title, scope: schedule.scope, options: schedule.options, at: schedule.at, days: schedule.days, enabled: schedule.enabled } : blankSchedule());
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const errors = scheduleErrors(s);
  const shown = tried ? errors : {};
  const goals = sortGoals(hub.o.goals.filter((g) => !g.goal.archived));
  const save = async () => {
    setTried(true);
    if (Object.keys(errors).length) return;
    setSaving(true);
    try {
      if (schedule) await api.hub.updateSchedule(schedule.id, s);
      else await api.hub.createSchedule(s);
      hub.data.reload();
      onDone();
    } catch (e) {
      hub.notify((e as Error).message, "bad");
    } finally {
      setSaving(false);
    }
  };
  const toggleDay = (d: number) => setS((x) => ({ ...x, days: x.days.includes(d) ? x.days.filter((y) => y !== d) : [...x.days, d].sort() }));
  return (
    <form className="hub-card hub-schedule-form" onSubmit={(e) => { e.preventDefault(); void save(); }} onKeyDown={(e) => e.key === "Escape" && onDone()}>
      <HubField id="hub-schedule-title" label="Name" error={shown.title}>
        {(a) => <input {...a} autoFocus value={s.title} onChange={(e) => setS({ ...s, title: e.target.value })} />}
      </HubField>
      <HubField id="hub-schedule-scope" label="Runs">
        {(a) => (
          <select {...a} value={scopeKey(s.scope)} onChange={(e) => setS({ ...s, scope: scopeOf(e.target.value as ScopeKey) })}>
            <option value="all">Every check</option>
            <option value="failing">Every failing check</option>
            <option value="stale">Every stale check</option>
            {goals.map((g) => <option key={g.goal.id} value={`goal:${g.goal.id}`}>Goal: {g.goal.title}</option>)}
          </select>
        )}
      </HubField>
      <div className="hub-field">
        <span className="hub-field-label">Days</span>
        <div className="hub-days" role="group" aria-label="Days">
          {DAY_SHORT.map((name, d) => <button type="button" key={name} className={`filter-chip ${s.days.includes(d) ? "active" : ""}`} aria-pressed={s.days.includes(d)} onClick={() => toggleDay(d)}>{name}</button>)}
        </div>
        {shown.days && <span className="hub-error">{shown.days}</span>}
      </div>
      <HubField id="hub-schedule-at" label="Time" error={shown.at}>
        {(a) => <input {...a} type="time" value={s.at} onChange={(e) => setS({ ...s, at: e.target.value })} />}
      </HubField>
      <HubField id="hub-schedule-manual" label="Manual steps">
        {(a) => (
          <select {...a} value={s.options.manualSteps} onChange={(e) => setS({ ...s, options: { ...s.options, manualSteps: e.target.value as "defer" | "block" } })}>
            <option value="defer">Send to the inbox and go on</option>
            <option value="block">Hold the plan until judged</option>
          </select>
        )}
      </HubField>
      <label className="hub-check-label"><input type="checkbox" checked={s.options.stopOnFailure} onChange={(e) => setS({ ...s, options: { ...s.options, stopOnFailure: e.target.checked } })} /> Stop at the first failure</label>
      <div className="hub-form-actions">
        <span className="small dim">{scheduleText(s)}</span>
        <span className="spacer" />
        <button type="button" className="ghost" onClick={onDone}>Cancel</button>
        <button type="submit" className="primary" disabled={saving}>{schedule ? "Save" : "Create schedule"}</button>
      </div>
    </form>
  );
}

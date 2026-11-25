/**
 * The queue: the run on the editor now with each playtest's state, the runs
 * waiting behind it (Run next, move up or down, stop), pause and why the
 * queue is paused or waiting, schedules that run playtests on chosen days,
 * and the runs that finished. The Overview's Now running strip is the same
 * queue at a glance. Release the editor is the app's bar (held.tsx LeaseBar),
 * on every tab.
 */
import { useState } from "react";
import type { PlanRun, PlanScope, Schedule, ScheduleDraft } from "@ue-mcp-studio/shared";
import {
  DAY_SHORT,
  HUB_COPY,
  blankSchedule,
  moveQueued,
  queuePausedText,
  scheduleErrors,
  scheduleText,
  scopeText,
  shortAgo,
  sortGoals,
} from "@ue-mcp-studio/client-core";
import { api } from "../../api";
import { Switch } from "../settings/controls";
import { useHub } from "./state";
import { HubField, HubIcon, ScreenHead } from "./parts";
import { PlanCard } from "./Overview";

const count = (n: number) => `${n} ${n === 1 ? "clip" : "clips"}`;

/** Who queued a run: a schedule, an agent, or a person some time ago. */
const queuedBy = (p: PlanRun): string => (p.trigger === "schedule" ? "Scheduled" : p.trigger === "agent" ? "From an agent" : `Queued ${shortAgo(p.createdAt)} ago`);

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
      hub.notify(`Stopped ${p.title}`);
    } catch (e) {
      hub.notify((e as Error).message, "bad");
    }
    hub.data.reload();
  };
  const schedules = q.schedules;

  hub.onKeys(() => false);

  return (
    <div className="hub-screen hub-queue">
      <ScreenHead
        title={HUB_COPY.queue}
        sub={<span className={q.editor.connected ? "dim" : "hub-bad-text"}>{q.editor.connected ? "Editor connected" : "Editor not connected"}</span>}
        actions={<button onClick={() => void pause()} aria-pressed={q.paused} title={q.paused ? "Start runs again" : "Finish the running clip, then hold the rest"}>
          <HubIcon name={q.paused ? "play" : "pause"} size={12} /> {q.paused ? HUB_COPY.resume : HUB_COPY.pause}
        </button>}
      />
      {!q.editor.connected && <div className="banner warn small">{HUB_COPY.editorDown}</div>}
      {q.paused && <div className="banner warn small">{queuePausedText(q)}</div>}
      {q.waiting && <div className="banner small">{HUB_COPY.waiting(q.waiting)}</div>}

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
                  <span className="hub-row-meta"><span>{scopeText(p.scope, o.goals)}</span><span>{count(p.items.length)}</span><span>{queuedBy(p)}</span></span>
                </span>
                <span className="hub-row-actions">
                  {i > 0 && <button className="ghost small-button" onClick={() => void move(p, 0)}>{HUB_COPY.runNext}</button>}
                  <button className="ghost icon-button" aria-label={`Move ${p.title} up`} disabled={i === 0} onClick={() => void move(p, i - 1)}><HubIcon name="up" size={12} /></button>
                  <button className="ghost icon-button" aria-label={`Move ${p.title} down`} disabled={i === q.queued.length - 1} onClick={() => void move(p, i + 1)}><HubIcon name="down" size={12} /></button>
                  <button className="ghost icon-button" aria-label={`Stop ${p.title}`} onClick={() => void cancel(p)}><HubIcon name="close" size={12} /></button>
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="hub-section">
        <div className="hub-section-head">
          <h2>{HUB_COPY.schedules} {schedules && <span className="dim">{schedules.length}</span>}</h2>
          <span className="spacer" />
          {schedules && editing === null && <button className="ghost" onClick={() => setEditing("new")}><HubIcon name="plus" size={12} /> {HUB_COPY.newSchedule}</button>}
        </div>
        {!schedules && <p className="dim small">{HUB_COPY.schedulesUnavailable}</p>}
        {editing === "new" && <ScheduleForm onDone={() => setEditing(null)} />}
        {schedules && schedules.length === 0 && editing !== "new" && <p className="dim small">{HUB_COPY.noSchedules}</p>}
        {schedules && schedules.length > 0 && (
          <div className="hub-list">
            {schedules.map((s) => editing !== "new" && editing?.id === s.id ? <ScheduleForm key={s.id} schedule={s} onDone={() => setEditing(null)} /> : (
              <div key={s.id} className={`hub-row hub-schedule-row ${s.enabled ? "" : "off"}`}>
                <Switch on={s.enabled} label={`${s.title} on`} onChange={(on) => void api.hub.updateSchedule(s.id, { enabled: on }).then(() => hub.data.reload(), (e: Error) => hub.notify(e.message, "bad"))} />
                <span className="hub-row-main">
                  <span className="hub-row-title">{s.title}</span>
                  <span className="hub-row-meta">
                    <span><HubIcon name="calendar" size={11} /> {scheduleText(s)}</span>
                    <span>{scopeText(s.scope, o.goals)}</span>
                    {s.waiting ? <span className="hub-warn-text">{HUB_COPY.scheduleWaiting(s.waiting)}</span>
                      : s.nextRunAt && s.enabled && <span>Next {new Date(s.nextRunAt).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}</span>}
                    {s.lastSkipped && <span className="hub-bad-text" title={s.lastRunAt ?? ""}>{HUB_COPY.scheduleSkipped(s.lastSkipped)}</span>}
                  </span>
                </span>
                <span className="hub-row-actions">
                  <button className="ghost icon-button" aria-label={`Edit ${s.title}`} onClick={() => setEditing(s)}><HubIcon name="edit" size={12} /></button>
                  <button className="ghost icon-button" aria-label={`Delete ${s.title}`} onClick={() => void api.hub.deleteSchedule(s.id).then(() => hub.data.reload(), (e: Error) => hub.notify(e.message, "bad"))}><HubIcon name="trash" size={12} /></button>
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {q.recent.length > 0 && (
        <section className="hub-section">
          <div className="hub-section-head"><h2>{HUB_COPY.finished}</h2></div>
          <div className="hub-list">{q.recent.map((p) => <PlanCard key={p.id} plan={p} />)}</div>
        </section>
      )}
    </div>
  );
}

type ScopeKey = "all" | "failing" | "stale" | `goal:${string}`;
// The form offers goals and the three sweeps; a track's or scene's set run shows as its goal.
const scopeKey = (s: PlanScope): ScopeKey =>
  s.kind === "goal" || s.kind === "track" || s.kind === "scene" ? `goal:${s.goalId}`
  : s.kind === "all" || s.kind === "failing" || s.kind === "stale" ? s.kind
  : "all";
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
            <option value="all">Every clip</option>
            <option value="failing">Every failing clip</option>
            <option value="stale">Every stale clip</option>
            {goals.map((g) => <option key={g.goal.id} value={`goal:${g.goal.id}`}>{g.goal.kind === "milestone" ? "Scene" : "Track"}: {g.goal.title}</option>)}
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
      <label className="hub-check-label" title={HUB_COPY.attendedHelp}><input type="checkbox" checked={s.options.attended} onChange={(e) => setS({ ...s, options: { ...s.options, attended: e.target.checked } })} /> {HUB_COPY.attended}</label>
      <label className="hub-check-label"><input type="checkbox" checked={s.options.stopOnFailure} onChange={(e) => setS({ ...s, options: { ...s.options, stopOnFailure: e.target.checked } })} /> {HUB_COPY.stopOnFailure}</label>
      <div className="hub-form-actions">
        <span className="small dim">{scheduleText(s)}</span>
        <span className="spacer" />
        <button type="button" className="ghost" onClick={onDone}>Cancel</button>
        <button type="submit" className="primary" disabled={saving}>{schedule ? "Save" : "Create schedule"}</button>
      </div>
    </form>
  );
}

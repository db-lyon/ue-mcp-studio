/**
 * Schedules, on the Runs screen: each queues a test or a suite on chosen days
 * at a local time, on this computer, headless or on the open editor. A row
 * turns on and off in place; Edit opens the same form New schedule does.
 */
import { useState } from "react";
import type { RunnerKind, Schedule, ScheduleDraft } from "ue-mcp/daemon";
import {
  DAY_SHORT,
  HUB_COPY,
  RUNNER_CHOICES,
  RUNNER_LABEL,
  WEEK_ORDER,
  scheduleDaysText,
  scheduleTarget,
  scheduleTargetKey,
  scheduleTargetOf,
  shortAgo,
  toggleDay,
} from "@ue-mcp-studio/client-core";
import { api } from "../../api";
import { useHub } from "./state";
import { HubIcon } from "./parts";

type Form = { title: string; target: string; runner: RunnerKind; days: number[]; time: string };

const blank = (target: string): Form => ({ title: "", target, runner: "headless", days: [1, 2, 3, 4, 5], time: "03:00" });
const formOf = (s: Schedule): Form => ({ title: s.title, target: scheduleTargetKey(s), runner: s.runner, days: [...s.days], time: s.time });

export function SchedulesSection() {
  const { o, notify, data } = useHub();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const act = (f: () => Promise<unknown>) => f().then(() => data.reload(), (e: Error) => notify(e.message, "bad"));
  const firstTarget = o.suites[0] ? `suite:${o.suites[0].id}` : o.tests[0] ? `test:${o.tests[0].id}` : "";
  return (
    <section className="hub-section">
      <div className="hub-section-head">
        <h2>{HUB_COPY.schedules}</h2>
        {editing !== "new" && <button className="small-button" disabled={!firstTarget} onClick={() => setEditing("new")}><HubIcon name="plus" />{HUB_COPY.newSchedule}</button>}
      </div>
      {editing === "new" && <ScheduleForm initial={blank(firstTarget)} onCancel={() => setEditing(null)} onSave={(d) => act(() => api.hub.createSchedule(d)).then(() => setEditing(null))} />}
      {o.schedules.length === 0 && editing !== "new" ? <p className="dim small">{HUB_COPY.noSchedules}</p> : (
        <ul className="hub-list">
          {o.schedules.map((s) => editing === s.id ? (
            <li key={s.id}><ScheduleForm initial={formOf(s)} onCancel={() => setEditing(null)} onSave={(d) => act(() => api.hub.updateSchedule(s.id, d)).then(() => setEditing(null))} /></li>
          ) : (
            <li key={s.id} className={`hub-row hub-schedule-row ${s.enabled ? "" : "off"}`}>
              <button className={`switch ${s.enabled ? "on" : ""}`} role="switch" aria-checked={s.enabled} aria-label={`${s.title} ${s.enabled ? "on" : "off"}`} onClick={() => void act(() => api.hub.updateSchedule(s.id, { enabled: !s.enabled }))} />
              <span className="hub-row-main">
                <span className="hub-row-title">{s.title}</span>
                <span className="hub-row-meta">
                  {s.title !== scheduleTarget(s, o) && <span>{scheduleTarget(s, o)}</span>}
                  <span><HubIcon name="clock" size={12} /> {scheduleDaysText(s.days)} at {s.time}</span>
                  <span title={RUNNER_CHOICES.find((c) => c.value === s.runner)?.help}>{RUNNER_LABEL[s.runner]}</span>
                  <span className="dim">{s.lastRunAt ? HUB_COPY.scheduleLast(shortAgo(s.lastRunAt)) : HUB_COPY.scheduleNever}</span>
                </span>
              </span>
              <span className="hub-row-actions">
                <button className="icon-button" aria-label={`Edit ${s.title}`} title="Edit" onClick={() => setEditing(s.id)}><HubIcon name="edit" /></button>
                <button className="icon-button" aria-label={`Delete ${s.title}`} title="Delete" onClick={() => window.confirm(`Delete the schedule ${s.title}?`) && void act(() => api.hub.deleteSchedule(s.id))}><HubIcon name="trash" /></button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ScheduleForm({ initial, onSave, onCancel }: { initial: Form; onSave: (d: ScheduleDraft) => Promise<unknown>; onCancel: () => void }) {
  const { o } = useHub();
  const [f, setF] = useState<Form>(initial);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<Form>) => setF((x) => ({ ...x, ...patch }));
  const target = scheduleTargetOf(f.target);
  const save = () => {
    if (!target) return;
    setBusy(true);
    const draft: ScheduleDraft = { ...target, runner: f.runner, days: f.days, time: f.time, ...(f.title.trim() ? { title: f.title.trim() } : {}) };
    void onSave(draft).finally(() => setBusy(false));
  };
  return (
    <form className="hub-card hub-schedule-form" onSubmit={(e) => {
      e.preventDefault();
      save();
    }}>
      <div className="hub-schedule-fields">
        <label className="hub-schedule-field">
          <span className="small muted">{HUB_COPY.scheduleWhat}</span>
          <select value={f.target} onChange={(e) => set({ target: e.target.value })}>
            {o.suites.length > 0 && <optgroup label={HUB_COPY.suites}>{o.suites.map((s) => <option key={s.id} value={`suite:${s.id}`}>{s.title}</option>)}</optgroup>}
            <optgroup label="Tests">{o.tests.map((t) => <option key={t.id} value={`test:${t.id}`}>{t.title}</option>)}</optgroup>
          </select>
        </label>
        <label className="hub-schedule-field">
          <span className="small muted">{HUB_COPY.scheduleTitle}</span>
          <input value={f.title} placeholder={target ? scheduleTarget(target, o) : ""} onChange={(e) => set({ title: e.target.value })} />
        </label>
      </div>
      <div className="hub-schedule-fields">
        <fieldset className="hub-schedule-field">
          <legend className="small muted">{HUB_COPY.scheduleDays}</legend>
          <span className="hub-days" role="group">
            {WEEK_ORDER.map((d) => <button key={d} type="button" className={`small-button ${f.days.includes(d) ? "on" : ""}`} aria-pressed={f.days.includes(d)} onClick={() => set({ days: toggleDay(f.days, d) })}>{DAY_SHORT[d]}</button>)}
          </span>
        </fieldset>
        <label className="hub-schedule-field narrow">
          <span className="small muted">{HUB_COPY.scheduleTime}</span>
          <input type="time" required value={f.time} onChange={(e) => set({ time: e.target.value })} />
        </label>
      </div>
      <fieldset className="hub-schedule-field">
        <legend className="small muted">{HUB_COPY.where}</legend>
        {RUNNER_CHOICES.filter((c) => c.value !== "auto").map((c) => (
          <label key={c.value} className="hub-schedule-radio">
            <input type="radio" name="runner" checked={f.runner === c.value} onChange={() => set({ runner: c.value as RunnerKind })} />
            <span><strong className="small">{c.label}</strong> <span className="small muted">{c.help}{c.value === "editor" ? ` ${HUB_COPY.scheduleEditorNote}` : ""}</span></span>
          </label>
        ))}
      </fieldset>
      <div className="hub-schedule-actions">
        <button type="submit" className="primary small-button" disabled={busy || !target}>{HUB_COPY.scheduleSave}</button>
        <button type="button" className="small-button" onClick={onCancel}>{HUB_COPY.scheduleCancel}</button>
      </div>
    </form>
  );
}

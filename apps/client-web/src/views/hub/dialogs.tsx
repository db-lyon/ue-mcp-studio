/**
 * The hub's dialogs: New and Edit goal, Add playtests to a goal, and Add to
 * goal for playtests picked in the library. Each closes on Escape or the
 * scrim.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { GOAL_PRIORITIES, type GoalPriority } from "@ue-mcp-studio/shared";
import {
  CHECK_HEALTH_LOOK,
  GOAL_STATUS_LOOK,
  GOAL_TITLE_MAX,
  HUB_COPY,
  PRIORITY_LABEL,
  checksNotIn,
  fuzzyScore,
  goalDraftOf,
  goalFormErrors,
  goalFormOf,
  goalUpdateOf,
  parentCandidates,
  requireCandidates,
  shortAgo,
  sortGoals,
  type GoalForm,
} from "@ue-mcp-studio/client-core";
import { api } from "../../api";
import { useHub, type GoalPreset } from "./state";
import { HubField, HubIcon, StatusMark } from "./parts";
import { HubLinkRows } from "./links";

function Dialog({ label, onClose, className = "", children }: { label: string; onClose: () => void; className?: string; children: ReactNode }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, []);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`overlay-card hub-dialog ${className}`} role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </div>
  );
}

/** New goal, or Edit goal: title first, everything else optional. */
export function GoalDialog({ goalId, preset, onClose }: { goalId: string | null; preset?: GoalPreset; onClose: () => void }) {
  const hub = useHub();
  const state = goalId ? hub.o.goals.find((g) => g.goal.id === goalId) ?? null : null;
  const existing = state?.goal ?? null;
  const [f, setF] = useState<GoalForm>(() => ({ ...goalFormOf(existing, state?.parents ?? []), ...(existing ? {} : { parents: preset?.parents ?? [], kind: preset?.kind ?? "goal" }) }));
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errors = goalFormErrors(f, { selfId: goalId ?? undefined, goals: hub.o.goals });
  // Errors show once Save was tried; a title past the limit says so as it is typed.
  const shown: typeof errors = tried ? errors : f.title.trim().length > GOAL_TITLE_MAX ? { title: errors.title } : {};
  const candidates = useMemo(() => parentCandidates(goalId, hub.o.goals), [hub.o.goals, goalId]);
  const [partQ, setPartQ] = useState("");
  const shownParents = partQ.trim() ? candidates.filter((g) => f.parents.includes(g.goal.id) || fuzzyScore(partQ, g.goal.title) !== null) : candidates;
  const toggleParent = (id: string) => setF((x) => ({ ...x, parents: x.parents.includes(id) ? x.parents.filter((p) => p !== id) : [...x.parents, id] }));
  const set = <K extends keyof GoalForm>(k: K, v: GoalForm[K]) => setF((x) => ({ ...x, [k]: v }));

  const save = async () => {
    setTried(true);
    if (Object.keys(errors).length) return;
    setSaving(true);
    setError(null);
    try {
      if (existing) {
        await api.hub.updateGoal(existing.id, goalUpdateOf(f));
        hub.notify(`Saved ${f.title.trim()}`);
        hub.data.reload();
        onClose();
      } else {
        const { goal } = await api.hub.createGoal(goalDraftOf(f));
        hub.notify(`Created ${goal.title}`);
        hub.data.reload();
        onClose();
        hub.go({ screen: "goal", goalId: goal.id });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const title = existing ? HUB_COPY.editGoal : f.kind === "milestone" ? "New milestone" : HUB_COPY.newGoal;
  return (
    <Dialog label={title} onClose={onClose} className="hub-goal-dialog">
      <form onSubmit={(e) => { e.preventDefault(); void save(); }} onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void save(); } }} noValidate>
        <div className="overlay-head">{title}</div>
        <HubField id="hub-goal-title" label="Title" error={shown.title}>
          {(a) => <input {...a} autoFocus value={f.title} onChange={(e) => set("title", e.target.value)} placeholder="A new player finishes the tutorial" />}
        </HubField>
        <HubField id="hub-goal-description" label="What done means">
          {(a) => <textarea {...a} rows={3} value={f.description} onChange={(e) => set("description", e.target.value)} placeholder="Optional. Markdown." />}
        </HubField>
        <div className="hub-field-row">
          <div className="hub-field">
            <span className="hub-field-label">Kind</span>
            <div className="seg compact" role="radiogroup" aria-label="Kind">
              {(["goal", "milestone"] as const).map((k) => (
                <button type="button" key={k} role="radio" aria-checked={f.kind === k} className={f.kind === k ? "on" : ""} onClick={() => set("kind", k)}>
                  {k === "goal" ? "Goal" : "Milestone"}
                </button>
              ))}
            </div>
          </div>
        </div>
        {candidates.length > 0 && (
          <fieldset className="hub-fieldset hub-part-of-field" aria-describedby={shown.parents ? "hub-goal-parents-error" : undefined}>
            <legend>{HUB_COPY.partOf}</legend>
            {candidates.length > 6 && <input value={partQ} onChange={(e) => setPartQ(e.target.value)} placeholder="Filter goals" aria-label="Filter goals to be part of" />}
            <div className="hub-picker-list">
              {shownParents.map((g) => (
                <label key={g.goal.id} className="hub-picker-row">
                  <input type="checkbox" checked={f.parents.includes(g.goal.id)} onChange={() => toggleParent(g.goal.id)} />
                  {g.goal.kind === "milestone" ? <HubIcon name="milestone" size={12} /> : <StatusMark look={GOAL_STATUS_LOOK[g.status]} />}
                  <span className="hub-row-title">{g.goal.title}</span>
                </label>
              ))}
            </div>
            {shown.parents && <span id="hub-goal-parents-error" className="hub-error">{shown.parents}</span>}
          </fieldset>
        )}
        <div className="hub-field-row">
          <HubField id="hub-goal-owner" label="Owner">
            {(a) => <input {...a} value={f.owner} onChange={(e) => set("owner", e.target.value)} placeholder="Nobody" />}
          </HubField>
          <HubField id="hub-goal-priority" label="Priority">
            {(a) => (
              <select {...a} value={f.priority} onChange={(e) => set("priority", e.target.value as GoalPriority | "")}>
                <option value="">None</option>
                {GOAL_PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
              </select>
            )}
          </HubField>
          <HubField id="hub-goal-due" label="Due" error={shown.due}>
            {(a) => <input {...a} type="date" value={f.due} onChange={(e) => set("due", e.target.value)} />}
          </HubField>
        </div>
        <fieldset className="hub-fieldset">
          <legend>Done when</legend>
          <div className="hub-field-row">
            <HubField id="hub-goal-runs" label="Passing runs in a row" error={shown.stableRuns}>
              {(a) => <input {...a} inputMode="numeric" value={f.stableRuns} onChange={(e) => set("stableRuns", e.target.value)} />}
            </HubField>
          </div>
          <label className="hub-check-label"><input type="checkbox" checked={f.signOff} onChange={(e) => set("signOff", e.target.checked)} /> A person signs it off</label>
        </fieldset>
        <HubLinkRows rows={f.links} onChange={(rows) => set("links", rows)} error={shown.links} />
        {error && <div className="banner bad small" role="alert">{error}</div>}
        <div className="hub-form-actions">
          <span className="spacer" />
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={saving}>{existing ? "Save" : f.kind === "milestone" ? "Create milestone" : "Create goal"}</button>
        </div>
      </form>
    </Dialog>
  );
}

/** Add checks: every check the goal does not list yet, filtered as typed, several at once. */
export function CheckPicker({ goalId, onClose }: { goalId: string; onClose: () => void }) {
  const hub = useHub();
  const g = hub.o.goals.find((x) => x.goal.id === goalId);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const options = useMemo(() => (g ? checksNotIn(g.goal, hub.o.checks) : []), [g, hub.o.checks]);
  const shown = q.trim() ? options.filter((c) => fuzzyScore(q, `${c.name} ${c.check.target} ${c.map ?? ""}`) !== null) : options;
  if (!g) return null;
  const toggle = (id: string) => setPicked((p) => {
    const n = new Set(p);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  const add = async () => {
    const checks = options.filter((c) => picked.has(c.id)).map((c) => ({ kind: c.check.kind, target: c.check.target }));
    if (!checks.length) return;
    setSaving(true);
    try {
      await api.hub.addChecks(goalId, checks);
      hub.notify(`Added ${checks.length} ${checks.length === 1 ? "playtest" : "playtests"} to ${g.goal.title}`);
      hub.data.reload();
      onClose();
    } catch (e) {
      hub.notify((e as Error).message, "bad");
      setSaving(false);
    }
  };
  return (
    <Dialog label={`${HUB_COPY.addPlaytests} to ${g.goal.title}`} onClose={onClose} className="hub-picker">
      <div className="overlay-head">{HUB_COPY.addPlaytests}<span className="dim small">to {g.goal.title}</span></div>
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter" aria-label="Filter playtests" onKeyDown={(e) => { if (e.key === "Enter" && shown.length === 1) toggle(shown[0].id); }} />
      <div className="hub-picker-list" role="group" aria-label={HUB_COPY.playtests}>
        {options.length === 0 && <p className="dim small">Every playtest in the project is in this goal already.</p>}
        {shown.map((c) => (
          <label key={c.id} className="hub-picker-row">
            <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} />
            <StatusMark look={CHECK_HEALTH_LOOK[c.health]} label={CHECK_HEALTH_LOOK[c.health].label} />
            <span className="hub-row-title">{c.name}</span>
            <span className="small dim">{c.last ? shortAgo(c.last.startedAt) : CHECK_HEALTH_LOOK[c.health].label}</span>
          </label>
        ))}
      </div>
      <div className="hub-form-actions">
        <span className="spacer" />
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={picked.size === 0 || saving} onClick={() => void add()}>{picked.size ? `Add ${picked.size}` : "Add"}</button>
      </div>
    </Dialog>
  );
}

/** Add to goal: pick the goal for checks chosen elsewhere; arrows and Enter work from the filter. */
export function GoalPicker({ checkIds, onClose }: { checkIds: string[]; onClose: () => void }) {
  const hub = useHub();
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const goals = useMemo(() => sortGoals(hub.o.goals.filter((g) => !g.goal.archived && g.goal.kind === "goal")), [hub.o.goals]);
  const shown = q.trim() ? goals.filter((g) => fuzzyScore(q, g.goal.title) !== null) : goals;
  const busy = useRef(false);
  const refs = hub.o.checks.filter((c) => checkIds.includes(c.id)).map((c) => ({ kind: c.check.kind, target: c.check.target }));
  const pick = async (goalId: string) => {
    if (busy.current) return;
    busy.current = true;
    const title = goals.find((g) => g.goal.id === goalId)?.goal.title ?? goalId;
    try {
      await api.hub.addChecks(goalId, refs);
      hub.notify(`Added ${refs.length} ${refs.length === 1 ? "playtest" : "playtests"} to ${title}`);
      hub.data.reload();
      onClose();
    } catch (e) {
      hub.notify((e as Error).message, "bad");
      busy.current = false;
    }
  };
  return (
    <Dialog label={HUB_COPY.addToGoal} onClose={onClose} className="hub-picker">
      <div className="overlay-head">{HUB_COPY.addToGoal}<span className="dim small">{refs.length} {refs.length === 1 ? "playtest" : "playtests"}</span></div>
      <input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setAt(0); }} placeholder="Filter goals" aria-label="Filter goals"
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setAt((i) => Math.min(shown.length - 1, i + 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setAt((i) => Math.max(0, i - 1)); }
          else if (e.key === "Enter" && shown[at]) { e.preventDefault(); void pick(shown[at].goal.id); }
        }} />
      <div className="hub-picker-list" role="listbox" aria-label={HUB_COPY.goals}>
        {goals.length === 0 && <p className="dim small">No goals yet. Create one first.</p>}
        {shown.map((g, i) => (
          <button key={g.goal.id} role="option" aria-selected={i === at} className={`hub-picker-row ghost ${i === at ? "on" : ""}`} onClick={() => void pick(g.goal.id)}>
            <StatusMark look={GOAL_STATUS_LOOK[g.status]} label={GOAL_STATUS_LOOK[g.status].label} />
            <span className="hub-row-title">{g.goal.title}</span>
          </button>
        ))}
      </div>
      <div className="hub-form-actions">
        <button className="ghost" onClick={() => { onClose(); hub.editGoal(null); }}>{HUB_COPY.newGoal}</button>
        <span className="spacer" />
        <button className="ghost" onClick={onClose}>Cancel</button>
      </div>
    </Dialog>
  );
}

/**
 * Add goal: an existing goal for this one to require, added at the end of
 * its list. Goals that would make a loop are not offered.
 */
export function RequirePicker({ goalId, onClose }: { goalId: string; onClose: () => void }) {
  const hub = useHub();
  const g = hub.o.goals.find((x) => x.goal.id === goalId);
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const options = useMemo(() => requireCandidates(goalId, hub.o.goals), [goalId, hub.o.goals]);
  const shown = q.trim() ? options.filter((x) => fuzzyScore(q, x.goal.title) !== null) : options;
  const busy = useRef(false);
  if (!g) return null;
  const pick = async (id: string) => {
    if (busy.current) return;
    busy.current = true;
    const title = options.find((x) => x.goal.id === id)?.goal.title ?? id;
    try {
      await api.hub.addRequire(goalId, id);
      hub.notify(`${g.goal.title} now requires ${title}`);
      hub.data.reload();
      onClose();
    } catch (e) {
      hub.notify((e as Error).message, "bad");
      busy.current = false;
    }
  };
  return (
    <Dialog label={`${HUB_COPY.addGoal} to ${g.goal.title}`} onClose={onClose} className="hub-picker">
      <div className="overlay-head">{HUB_COPY.addGoal}<span className="dim small">to {g.goal.title}</span></div>
      <input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setAt(0); }} placeholder="Filter goals" aria-label="Filter goals"
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setAt((i) => Math.min(shown.length - 1, i + 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setAt((i) => Math.max(0, i - 1)); }
          else if (e.key === "Enter" && shown[at]) { e.preventDefault(); void pick(shown[at].goal.id); }
        }} />
      <div className="hub-picker-list" role="listbox" aria-label={HUB_COPY.goals}>
        {options.length === 0 && <p className="dim small">No other goal can be added here.</p>}
        {shown.map((x, i) => (
          <button key={x.goal.id} role="option" aria-selected={i === at} className={`hub-picker-row ghost ${i === at ? "on" : ""}`} onClick={() => void pick(x.goal.id)}>
            {x.goal.kind === "milestone" ? <HubIcon name="milestone" size={12} /> : <StatusMark look={GOAL_STATUS_LOOK[x.status]} />}
            <span className="hub-row-title">{x.goal.title}</span>
            <span className="small dim">{GOAL_STATUS_LOOK[x.status].label}</span>
          </button>
        ))}
      </div>
      <div className="hub-form-actions">
        <button className="ghost" onClick={() => { onClose(); hub.editGoal(null, { parents: [goalId] }); }}>{HUB_COPY.newGoalHere}</button>
        <span className="spacer" />
        <button className="ghost" onClick={onClose}>Cancel</button>
      </div>
    </Dialog>
  );
}

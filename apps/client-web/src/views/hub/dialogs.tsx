/**
 * The hub's dialogs: New and Edit goal, Add playtests to a goal, Add to goal
 * for playtests picked in the library, Delete playtests, and Delete a goal or
 * milestone. Each closes
 * on Escape or the scrim.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { GOAL_PRIORITIES, type GoalPriority } from "@ue-mcp-studio/shared";
import {
  CHECK_HEALTH_LOOK,
  DRAFT_COPY,
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
  parentGoals,
  requireCandidates,
  shortAgo,
  sortGoals,
  type GoalForm,
} from "@ue-mcp-studio/client-core";
import { api } from "../../api";
import { useHub, type GoalPreset } from "./state";
import { HubField, HubIcon, StatusMark } from "./parts";
import { HubLinkRows } from "./links";

export function Dialog({ label, onClose, className = "", children }: { label: string; onClose: () => void; className?: string; children: ReactNode }) {
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

const KIND_CHOICES = [
  { value: "goal", title: "Goal", note: "Something the game must do, proven by its playtests." },
  { value: "milestone", title: "Milestone", note: "A set of goals that must all be met, such as a release." },
] as const;

const DONE_CHOICES = [
  { signOff: false, title: "When all its playtests pass" },
  { signOff: true, title: "When all its playtests pass and someone signs it off" },
] as const;

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
        <fieldset className="hub-fieldset">
          <legend>Kind</legend>
          {KIND_CHOICES.map((c) => (
            <label key={c.value} className="hub-radio-row">
              <input type="radio" name="hub-goal-kind" checked={f.kind === c.value} onChange={() => set("kind", c.value)} />
              <span><span className="hub-radio-title">{c.title}</span><span className="hub-radio-note">{c.note}</span></span>
            </label>
          ))}
        </fieldset>
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
          {DONE_CHOICES.map((c) => (
            <label key={String(c.signOff)} className="hub-radio-row">
              <input type="radio" name="hub-goal-done" checked={f.signOff === c.signOff} onChange={() => set("signOff", c.signOff)} />
              <span className="hub-radio-title">{c.title}</span>
            </label>
          ))}
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
 * Delete playtests: one confirmation naming every asset path, then the
 * scripts go one at a time through the same call the card editor uses.
 * Failures are listed by name; what was deleted stays deleted.
 */
export function DeleteDialog({ checkIds, onDone, onClose }: { checkIds: string[]; onDone?: (deleted: string[]) => void; onClose: () => void }) {
  const hub = useHub();
  const [items] = useState(() => hub.o.checks.filter((c) => checkIds.includes(c.id)).map((c) => ({ id: c.id, name: c.name, path: c.check.target })));
  const [done, setDone] = useState(0);
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState<Array<{ name: string; path: string; error: string }> | null>(null);
  const busy = useRef(false);
  const close = () => {
    if (!busy.current) onClose();
  };
  const run = async () => {
    if (busy.current) return;
    busy.current = true;
    setRunning(true);
    const gone: string[] = [];
    const bad: Array<{ name: string; path: string; error: string }> = [];
    for (const it of items) {
      try {
        await api.qaPlaytestDelete(it.path);
        gone.push(it.id);
      } catch (e) {
        bad.push({ name: it.name, path: it.path, error: (e as Error).message });
      }
      setDone((n) => n + 1);
    }
    hub.data.reload();
    if (gone.length) onDone?.(gone);
    busy.current = false;
    setRunning(false);
    if (bad.length === 0) {
      hub.notify(HUB_COPY.deleted(gone.length));
      onClose();
    } else {
      setFailed(bad);
    }
  };
  const title = failed ? HUB_COPY.deleteFailedTitle(failed.length, items.length) : HUB_COPY.deleteTitle(items.length);
  return (
    <Dialog label={title} onClose={close} className="hub-delete">
      <div className="overlay-head">{title}</div>
      {failed ? (
        <ul className="hub-delete-list" aria-label="Not deleted">
          {failed.map((f) => <li key={f.path}><span className="hub-row-title">{f.name}</span> <span className="mono small dim">{f.path}</span><div className="small hub-bad-text">{f.error}</div></li>)}
        </ul>
      ) : (
        <>
          <p className="small">{HUB_COPY.deleteLead(items.length)}</p>
          <ul className="hub-delete-list" aria-label="Assets to delete">
            {items.map((it) => <li key={it.id} className="mono small">{it.path}</li>)}
          </ul>
        </>
      )}
      {running && <div className="small dim" role="status">{HUB_COPY.deleting(Math.min(done, items.length - 1), items.length)}</div>}
      <div className="hub-form-actions">
        <span className="spacer" />
        {failed ? <button className="primary" autoFocus onClick={onClose}>Close</button> : (
          <>
            <button className="ghost" disabled={running} onClick={close}>Cancel</button>
            <button className="danger-button" disabled={running || items.length === 0} onClick={() => void run()}>{HUB_COPY.delete}</button>
          </>
        )}
      </div>
    </Dialog>
  );
}

/**
 * Delete a goal or milestone: one confirmation saying its playtests stay and
 * naming the goals that required it, which lose the link. A refusal (a plan
 * made for it is in the queue) is shown here, with the dialog left open.
 */
export function GoalDeleteDialog({ goalId, onDone, onClose }: { goalId: string; onDone?: () => void; onClose: () => void }) {
  const hub = useHub();
  const [g] = useState(() => hub.o.goals.find((x) => x.goal.id === goalId) ?? null);
  const [parents] = useState(() => (g ? parentGoals(g, hub.o.goals) : []));
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const close = () => {
    if (!busy.current) onClose();
  };
  if (!g) return null;
  const { kind, title } = g.goal;
  const run = async () => {
    if (busy.current) return;
    busy.current = true;
    setRunning(true);
    setError(null);
    try {
      await api.hub.deleteGoal(goalId);
      busy.current = false;
      hub.notify(HUB_COPY.goalDeleted(title));
      onClose();
      onDone?.();
      hub.data.reload();
    } catch (e) {
      busy.current = false;
      setRunning(false);
      setError((e as Error).message);
    }
  };
  const question = HUB_COPY.deleteGoalTitle(kind, title);
  return (
    <Dialog label={question} onClose={close} className="hub-delete">
      <div className="overlay-head">{question}</div>
      <p className="small">{HUB_COPY.deleteGoalKeeps(kind)}</p>
      {parents.length > 0 && (
        <div className="hub-goal-delete-parents">
          <p className="small" id="hub-goal-delete-parents">{HUB_COPY.deleteGoalUnlinks}</p>
          <ul className="hub-delete-list" aria-labelledby="hub-goal-delete-parents">
            {parents.map((p) => (
              <li key={p.goal.id} className="small">
                {p.goal.kind === "milestone" ? <HubIcon name="milestone" size={10} /> : <StatusMark look={GOAL_STATUS_LOOK[p.status]} size={10} />} {p.goal.title}
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && <div className="banner bad small" role="alert">{error}</div>}
      <div className="hub-form-actions">
        <span className="spacer" />
        <button className="ghost" autoFocus disabled={running} onClick={close}>Cancel</button>
        <button className="danger-button" disabled={running} onClick={() => void run()}>{HUB_COPY.deleteGoal(kind)}</button>
      </div>
    </Dialog>
  );
}

/** Draft with an agent: what the playtest should check, handed to the /playtest flow in a new chat session. */
export function DescribeDialog({ onClose }: { onClose: () => void }) {
  const hub = useHub();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const session = await api.newSession();
      await api.playtest(session.id, { text: text.trim() });
      onClose();
      hub.openChat(session.id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog label={DRAFT_COPY.draftWithAgentTitle} onClose={onClose} className="hub-describe">
      <form onSubmit={(e) => { e.preventDefault(); void go(); }}>
        <div className="overlay-head">{DRAFT_COPY.draftWithAgentTitle}</div>
        <p className="small muted hub-describe-lead">{DRAFT_COPY.draftWithAgentLead}</p>
        <textarea
          autoFocus
          rows={4}
          value={text}
          aria-label={DRAFT_COPY.draftWithAgentTitle}
          placeholder={DRAFT_COPY.draftWithAgentPlaceholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void go(); }
          }}
        />
        {error && <span className="hub-error" role="alert">{error}</span>}
        <div className="hub-form-actions">
          <span className="spacer" />
          <button type="button" className="ghost" onClick={onClose}>{DRAFT_COPY.cancel}</button>
          <button type="submit" className="primary" disabled={!text.trim() || busy}><HubIcon name="sparkle" size={12} /> {DRAFT_COPY.draftWithAgentGo}</button>
        </div>
      </form>
    </Dialog>
  );
}

/** Leaving the playtest editor with unsaved changes. */
export function LeaveDialog({ isNew, onStay, onDiscard }: { isNew: boolean; onStay: () => void; onDiscard: () => void }) {
  return (
    <Dialog label={DRAFT_COPY.discardTitle} onClose={onStay} className="hub-leave">
      <div className="overlay-head">{DRAFT_COPY.discardTitle}</div>
      <p className="small muted">{isNew ? DRAFT_COPY.discardNewLead : DRAFT_COPY.discardLead}</p>
      <div className="hub-form-actions">
        <span className="spacer" />
        <button className="ghost" autoFocus onClick={onStay}>{DRAFT_COPY.keepEditing}</button>
        <button className="danger-button" onClick={onDiscard}>{DRAFT_COPY.discard}</button>
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
